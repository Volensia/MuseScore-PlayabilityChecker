//=============================================================================
//  Orchestration Checker — live string check, and the wind register graph (W1)
//  Keeps checking while you edit. Colours are written straight to the noteheads,
//  without startCmd/endCmd, so a live pass never pushes an undo step (verified:
//  see SPEC-strings.md, "Live mode"). Use "Apply to score" for a normal,
//  undoable edit you can save.
//
//  If the dock panel misbehaves in your MuseScore, change pluginType to "dialog"
//  and delete the dockArea line — everything else works the same.
//=============================================================================
import QtQuick 2.4
import QtQuick.Controls 1.1
import QtQuick.Layouts 1.1
import MuseScore 3.0
import FileIO 3.0
import "analyse.js" as A
import "strings.js" as S
import "fingerboard.js" as F
import "copyscan.js" as CS
import "registergraph.js" as RG

MuseScore {
    menuPath: "Plugins.Playability Checker"
    description: "Checks bowed-string staves while you edit (open strings, stops, bowing), and shows the registers of selected wind notes."
    version: "0.2"
    requiresScore: true
    pluginType: "dock"
    dockArea: "right"
    width: 300
    height: 520

    property var env: ({ CHORD: Element.CHORD, NOTE: Element.NOTE,
                         DIAMOND: NoteHeadGroup.HEAD_DIAMOND,
                         NORMAL: NoteHeadGroup.HEAD_NORMAL,
                         INSTRUMENT_CHANGE: Element.INSTRUMENT_CHANGE,
                         ARTICULATION: Element.ARTICULATION, SLUR: Element.SLUR, HAIRPIN: Element.HAIRPIN, TEMPO_TEXT: Element.TEMPO_TEXT, TREMOLO: Element.TREMOLO,
                         SYM: { black: SymId.noteheadBlack, half: SymId.noteheadHalf,
                                whole: SymId.noteheadWhole, breve: SymId.noteheadDoubleWhole,
                                diamondBlack: SymId.noteheadDiamondBlack,
                                diamondHalf: SymId.noteheadDiamondHalf,
                                diamondWhole: SymId.noteheadDiamondWhole,
                                diamondBreve: SymId.noteheadDiamondDoubleWhole } })

    // ---------------------------------------------------------------- copy reader
    // Slurs, staccato dots, hairpins, harmonic circles (Articulations palette) and the
    // instrument ranges are not reachable through the plugin API without a select-all,
    // which borrows the user's selection. So they are read from a copy of the score
    // written to the temp folder (writeScore: the score keeps its name, the undo stack is
    // untouched). See SPEC-strings.md, "Copy reader".
    //
    //   when   : at start and on a tab switch; on Re-check / Apply; and after edits, once the
    //            score has been quiet for copyIdleMs, which follows how long the last copy took
    //            to write: up to 50 ms (small scores) 400 ms — just after the live pass, so a
    //            slur change shows within about a second; up to 150 ms 1.5 s; up to 400 ms 5 s;
    //            slower copies turn the automatic read off and the status line says the slurs
    //            may be out of date.
    //   where  : writeScore must run on the main thread — the only unavoidable freeze. The
    //            scan runs in a WorkerScript; if the worker never answers, it runs on the main
    //            thread one staff per timer tick instead.
    //   result : only the staves whose slurs, dots, hairpins or circles changed are
    //            re-checked.
    property var ranges: null
    property var covers: []             // keys of notes drawn over, for selection changes
    property bool coverOn: true         // always draw our colour over MuseScore's range colours
    property var circles: null          // track -> tick -> true (from the copy)
    property var bowing: null           // { slurs, dots, hairpins } (from the copy)
    property var staffSigs: ({})        // staff -> signature of its maps at the last read
    property bool copyBusy: false
    property bool copyPending: false    // another read was asked for while one ran
    property bool copyDirty: false      // edited since the last read
    property bool copyAuto: true        // automatic reads after edits (off for slow copies)
    property int copyIdleMs: 400
    property int copyId: 0
    property var copyJob: null          // { id, score, full, command, writeMs, readMs, t0, starts }
    property int workerState: 0         // 0 untried, 1 answering, -1 not answering
    property string workerUrl: ""
    property string copyScanCode: ""    // bundle.py fills this in; the dev build reads copyscan.js
    FileIO { id: copyFile }

    function fileUrl(path) { return (path.charAt(0) === "/" ? "file://" : "file:///") + path; }

    // The worker runs copyscan.js itself, written to the temp folder without its
    // ".pragma library" line (a WorkerScript file cannot be a QML library).
    function prepareWorker() {
        if (workerUrl !== "") return;
        var code = copyScanCode;
        if (code === "") {
            copyFile.source = decodeURIComponent(String(Qt.resolvedUrl("copyscan.js")).replace(/^file:\/\//, ""));
            code = copyFile.read();
        }
        code = code.replace(/^\s*\.pragma\s+library\s*$/m, "");
        copyFile.source = copyFile.tempPath() + "/playability-checker-worker.js";
        if (copyFile.write(code)) workerUrl = fileUrl(copyFile.source);
        else workerState = -1;
    }

    // Staves worth scanning: a bowed string (for the checks) or a known wind (its slurs
    // join notes in the register graph) at any point.
    function stringStaves() {
        var list = [], staves = A.staffInstruments(curScore);
        var winds = RG.rgWindStaves(curScore, env);
        for (var st = 0; st < curScore.nstaves; st++) {
            if (!staves[st]) continue;
            if (winds.indexOf(st) >= 0) { list.push(st); continue; }
            var inst = A.instrumentsOf(curScore, env, st, staves[st].part, null);
            for (var i = 0; i < inst.length; i++) if (inst[i].instr) { list.push(st); break; }
        }
        return list;
    }

    // Ask for a read. opts: { full: re-check every staff afterwards, command: undoable }.
    function requestCopy(opts) {
        if (!curScore) return;
        if (copyBusy) { copyPending = true; if (opts && opts.full) copyJob.full = true; return; }
        copyBusy = true;
        copyDirty = false;
        copyJob = { id: ++copyId, score: curScore.scoreName, full: !!(opts && opts.full),
                    command: !!(opts && opts.command) };
        if (lastWriteMs > 100) statusHint = "updating…";   // a noticeable write is coming
        copyWrite.start();                  // next event-loop turn: lets "updating…" paint first
    }
    property int lastWriteMs: 0
    property string statusHint: ""

    Timer {
        id: copyWrite
        interval: 0
        onTriggered: {
            if (!curScore || curScore.scoreName !== copyJob.score) { copyBusy = false; return; }
            prepareWorker();
            var base = copyFile.tempPath() + "/playability-checker-copy";
            var t0 = Date.now();
            busy = true;
            var ok = writeScore(curScore, base, "mscx");
            busy = false;
            var t1 = Date.now();
            if (!ok) { copyBusy = false; statusHint = ""; console.log("PlayabilityChecker copy: write failed"); return; }
            copyFile.source = base + ".mscx";
            var xml = copyFile.read();
            var t2 = Date.now();
            ranges = coverOn ? A.parseRanges(xml) : null;
            var t3 = Date.now();
            copyJob.writeMs = t1 - t0; copyJob.readMs = t2 - t1; copyJob.rangeMs = t3 - t2;
            copyJob.starts = A.barMap(curScore);
            copyJob.staves = stringStaves();
            copyJob.t0 = Date.now();
            lastWriteMs = copyJob.writeMs;
            if (workerState >= 0 && workerUrl !== "") {
                copyWorker.sendMessage({ id: copyJob.id, xml: xml, starts: copyJob.starts, staves: copyJob.staves });
                if (workerState === 0) workerWait.start();
            } else {
                startChunkedScan(xml);
            }
        }
    }

    WorkerScript {
        id: copyWorker
        source: workerUrl
        onMessage: {
            if (!copyJob || messageObject.id !== copyJob.id) return;
            workerWait.stop();
            workerState = 1;
            applyCopy(messageObject.maps, "worker", messageObject.scanMs);
        }
    }

    // A worker that has never answered within 5 s is taken as unavailable; the pending
    // read is finished on the main thread, one staff per timer tick.
    Timer {
        id: workerWait
        interval: 5000
        onTriggered: {
            workerState = -1;
            console.log("PlayabilityChecker copy: background worker did not answer — scanning on the main thread");
            copyFile.source = copyFile.tempPath() + "/playability-checker-copy.mscx";
            startChunkedScan(copyFile.read());
        }
    }

    property var chunk: null            // { xml, slices, i, out, want, t0 }
    function startChunkedScan(xml) {
        var want = {};
        for (var i = 0; i < copyJob.staves.length; i++) want[copyJob.staves[i]] = true;
        chunk = { xml: xml, slices: CS.copyStaffSlices(xml), i: 0, out: CS.copyScanEmpty(), want: want, t0: Date.now() };
        chunkTimer.start();
    }
    Timer {
        id: chunkTimer
        interval: 1
        repeat: true
        onTriggered: {
            while (chunk.i < chunk.slices.length && !chunk.want[chunk.slices[chunk.i].staff]) chunk.i++;
            if (chunk.i < chunk.slices.length) {
                CS.copyScanStaff(chunk.xml, chunk.slices[chunk.i], copyJob.starts, chunk.out);
                chunk.i++;
                return;
            }
            stop();
            var maps = CS.copyScanFinish(chunk.out), ms = Date.now() - chunk.t0;
            chunk = null;
            applyCopy(maps, "main thread, per staff", ms);
        }
    }

    function applyCopy(maps, where, scanMs) {
        var job = copyJob;
        copyBusy = false;
        statusHint = "";
        if (!curScore || curScore.scoreName !== job.score) { if (copyPending) { copyPending = false; requestCopy({ full: true }); } return; }
        var sigs = {}, changed = [], first = circles === null;
        for (var st = 0; st < curScore.nstaves; st++) {
            sigs[st] = CS.copyStaffSignature(maps, st);
            if (sigs[st] !== staffSigs[st]) changed.push(st);
        }
        circles = maps.circles;
        bowing = maps.bowing;
        staffSigs = sigs;
        // pace the automatic reads by how long this copy took to write
        copyAuto = job.writeMs <= 400;
        copyIdleMs = job.writeMs <= 50 ? 400 : job.writeMs <= 150 ? 1500 : 5000;
        console.log("PlayabilityChecker copy: write " + job.writeMs + " ms, read " + job.readMs + " ms, ranges " +
                    job.rangeMs + " ms, scan " + scanMs + " ms (" + where + "), " + job.staves.length +
                    " staves, changed " + (first ? "all" : changed.length) +
                    (copyAuto ? "" : " — automatic reads off for this score (slow copy)"));
        if (job.full || first) check(null, job.command, false);
        else if (changed.length) check({ from: -1, to: -1, staves: changed }, false, false);
        else updateStatus();
        if (copyPending) { copyPending = false; requestCopy({}); }
    }

    // After an edit: read again once the score has been quiet.
    Timer {
        id: copyIdle
        interval: copyIdleMs
        onTriggered: if (copyDirty && copyAuto) requestCopy({})
    }

    function overlayOpts(command) {
        return { command: command, overlay: coverOn, env: env,
                 newSymbol: function () { return newElement(Element.SYMBOL); } };
    }
    property bool liveOn: true          // always on (the panel no longer has a switch)
    property bool busy: false           // re-entry guard: our own writes fire onScoreStateChanged
    property bool syncing: false        // the panel itself is moving a selection
    property bool rebuilding: false     // the results model is being refilled
    property string rowsScore: ""       // the score the rows belong to
    property string selectedInfo: ""    // the "Selected" line under the table
    property var geom: null             // fingerboard data while a playable chord is selected
    property bool showList: false       // the user asked for the list back
    property var rgm: null              // register graph model while wind notes are selected (W1)
    property int rgIndex: 0             // the instrument shown
    property real rgChipsX: 0           // chip strip scroll position, kept across refreshes

    // The register graph for the current selection. Keeps showing the same instrument
    // when the same graphs come back (after an edit, or when the slurs arrive).
    function refreshGraph() {
        var m = (geom === null && curScore) ? RG.rgModel(curScore, env, bowing, ranges) : null;
        if (!m) { rgm = null; return; }
        var keepId = (rgm && rgIndex < rgm.graphs.length) ? rgm.graphs[rgIndex].id : "";
        var idx = m.first;
        if (rgm && rgm.key === m.key)
            for (var i = 0; i < m.graphs.length; i++) if (m.graphs[i].id === keepId) idx = i;
        rgIndex = idx;
        rgm = m;
    }
    function showGraph(i) {
        if (!rgm) return;
        rgIndex = Math.max(0, Math.min(rgm.graphs.length - 1, i));
    }

    property int passes: 0
    property string statusLine: "not run yet"
    property string lastScore: ""

    ListModel { id: results }

    // range: null = whole score, or { from, to } ticks, optionally with staves: [staffIdx]
    function inRange(track, tick, range) {
        if (!range) return true;
        if (range.staves && range.staves.indexOf(track >> 2) < 0) return false;
        if (range.from >= 0 && (tick < range.from || tick > range.to)) return false;
        return true;
    }

    function check(range, command) {
        if (!curScore) return;
        busy = true;
        A.clearMarks(curScore, env, { command: command, from: range ? range.from : -1,
                                      to: range ? range.to : -1, staves: range ? range.staves : null });
        var out = A.analyse(curScore, env, range, circles, coverOn ? ranges : null, bowing);
        if (out.textsChanged) {             // a div./jeté text moved: later bars change too
            busy = false;
            check(null, command);
            return;
        }
        var applied = A.applyMarks(curScore, out.marks, overlayOpts(command));
        // Colours written outside a command are not repainted until MuseScore next redraws.
        // A pass started by an edit gets that redraw anyway; one started by the copy
        // reader's worker does not, so ask for it.
        if (!command) A.layoutNow(curScore);
        busy = false;
        passes++;

        // covered notes: a partial pass replaces only the keys inside its range
        var keepCovers = [];
        if (range)
            for (var ci = 0; ci < covers.length; ci++)
                if (!inRange(covers[ci].track, covers[ci].tick, range))
                    keepCovers.push(covers[ci]);
        covers = keepCovers.concat(out.covers);

        // a partial pass only replaces the rows in its own bar range; the table is then
        // sorted the way the score reads: by bar first, then by staff.
        rebuilding = true;
        var all = [];
        if (range)
            for (var i = 0; i < results.count; i++) {
                var r = results.get(i);
                if (!inRange(r.track, r.tick, range))
                    all.push({ bar: r.bar, tick: r.tick, staff: r.staff,
                               verdict: r.verdict, reason: r.reason, notes: r.notes,
                               track: r.track, grace: r.grace, tickEnd: r.tickEnd, kind: r.kind,
                               staffShort: r.staffShort });
            }
        for (var j = 0; j < out.rows.length; j++) all.push(out.rows[j]);
        all.sort(function (a, b) { return (a.tick - b.tick) || (a.track - b.track) || (a.grace - b.grace); });
        results.clear();
        for (var k = 0; k < all.length; k++) results.append(all[k]);
        rebuilding = false;
        fitColumns();
        rowsScore = curScore.scoreName;
        syncFromScore();                    // keep the highlight on what is selected

        var shown = [];
        for (var q = 0; q < results.count; q++) shown.push(results.get(q));
        lastCounts = A.countRows(shown);         // what the table holds, not just this pass
        updateStatus();
        console.log("PlayabilityChecker live: pass " + passes +
                    (range ? (range.staves ? " staves " + range.staves.join(",") : " bars " + range.from + "–" + range.to)
                           : " (whole score)") +
                    (command ? " [undoable]" : " [no undo step]") + " — " + statusLine);
        // a fast bass run reaches over the edited bars: judge those staves whole
        if (range && range.from >= 0 && out.redoStaves && out.redoStaves.length)
            check({ from: -1, to: -1, staves: out.redoStaves }, command);
    }

    property var lastCounts: null

    // Column widths from the text they hold (see the table below)
    FontMetrics { id: tableFont }
    property real barColWidth: 40
    property real staffColWidth: 50
    property real reasonColWidth: 200
    function fitColumns() {
        var bw = tableFont.advanceWidth("Bar"), sw = tableFont.advanceWidth("Staff"),
            rw = tableFont.advanceWidth("Reason");
        for (var i = 0; i < results.count; i++) {
            var r = results.get(i);
            bw = Math.max(bw, tableFont.advanceWidth(String(r.bar)));
            sw = Math.max(sw, tableFont.advanceWidth(String(r.staffShort)));
            rw = Math.max(rw, tableFont.advanceWidth(String(r.reason)));
        }
        barColWidth = Math.ceil(bw) + 18;       // cell padding and the header's sort gap
        staffColWidth = Math.ceil(sw) + 18;
        reasonColWidth = Math.ceil(rw) + 18;    // never clipped; the table scrolls sideways instead
    }
    // No problem summary: the table lists the problems, one row each (user, 2026-09-17).
    // The line only says when a read is running or when the slurs may be stale.
    function updateStatus() {
        statusLine = statusHint !== "" ? statusHint
                   : (copyDirty && !copyAuto) ? "slurs may be out of date — Re-check" : "";
    }
    onStatusHintChanged: updateStatus()

    // Re-check / Apply: read the copy, then check the whole score.
    function fullCheck(command) { requestCopy({ full: true, command: command }); }

    // Score -> panel: highlight the row for the selected chord, and describe it.
    // Rows and chords name each other by { track, tick, grace } — see analyse.js.
    function syncFromScore() {
        if (!curScore) return;
        var key = A.selectedChord(curScore, env);
        selectedInfo = key ? A.inspectChord(curScore, env, key, circles) : "";
        geom = key && !A.selectionSpansChords(curScore, env) ? A.chordGeometry(curScore, env, key, circles) : null;
        refreshGraph();
        showList = false;
        // a selected note shows MuseScore's selection colour, so uncover it
        if (coverOn && covers.length) {
            busy = true;
            A.refreshCovers(curScore, env, covers, overlayOpts(false));
            busy = false;
        }
        // The row for the selected chord: its own row first, else the row of a slur or
        // stroke the chord belongs to (any note of a flagged slur finds the slur's row).
        var row = -1, best = 0;
        if (key && curScore.scoreName === rowsScore) {
            for (var i = 0; i < results.count && best < 2; i++) {
                var m = A.rowMatch(results.get(i), key);
                if (m > best) { best = m; row = i; }
            }
        }
        syncing = true;
        table.selection.clear();
        if (row >= 0) {
            table.selection.select(row);
            table.currentRow = row;
            table.positionViewAtRow(row, ListView.Contain);
        } else {
            table.currentRow = -1;
        }
        syncing = false;
    }

    // Panel -> score: select the chord a row points at. Only ever called from a
    // click, never from a model change, so a live pass cannot move the selection.
    // Scroll the score to a chord. A plugin's selection.select() never pans; MuseScore
    // only scrolls inside view commands. "top-chord" (Ctrl+Alt+Up) runs cmdGotoElement
    // on the chord's own top note (Score::upAltCtrl = chord->upNote()), which selects it
    // and calls adjustCanvasPosition (scoreview.cpp:2050-2066, 2411). The caller then
    // re-selects the whole chord. Side effect: with "play notes when editing" on, the
    // note may sound.
    function panToChord(r) {
        var ch = A.findChord(curScore, env, r.track, r.tick, r.grace);
        if (!ch || !ch.notes || !ch.notes.length) return;
        curScore.selection.clear();
        curScore.selection.select(ch.notes[0]);
        cmd("top-chord");
    }

    function selectRow(row) {
        if (syncing || rebuilding || !curScore || row < 0 || row >= results.count) return;
        syncing = true;
        var r = results.get(row);
        panToChord({ track: r.track, tick: r.tick, grace: r.grace });
        var found = A.selectRow(curScore, env, r);      // every note the row is about
        if (found === "toEnd") cmd("select-end-score");  // a range to the end of the score
        syncing = false;
        if (!found) {
            selectedInfo = "that chord has changed since the check — press Re-check";
            return;
        }
        var key = A.selectedChord(curScore, env);
        selectedInfo = key ? A.inspectChord(curScore, env, key, circles) : "";
        geom = key && !A.selectionSpansChords(curScore, env)
               ? A.chordGeometry(curScore, env, key, circles) : null;
        refreshGraph();
    }

    onScoreStateChanged: {
        if (busy || !curScore) return;
        if (state.selectionChanged && !syncing) syncFromScore();
        if (!liveOn) return;
        if (curScore.scoreName !== lastScore) {     // switched tab: start over
            lastScore = curScore.scoreName;
            circles = null;             // the old score's maps do not apply here
            bowing = null;
            ranges = null;
            staffSigs = {};
            covers = [];
            copyAuto = true;
            check(null, false);         // notes and texts at once; slurs follow from the copy
            requestCopy({ full: true });
            return;
        }
        // a pure selection change doesn't alter any note
        if (state.selectionChanged && state.startLayoutTick < 0 && !state.instrumentsChanged) return;
        copyDirty = true;                            // slurs, dots, hairpins or ranges may have changed
        if (copyAuto) copyIdle.restart(); else updateStatus();
        // One edit can arrive as two notifications: one with the changed bars, then one with
        // no range. Ranges within the debounce window are merged, and a rangeless notification
        // does not cancel a pending range (it used to turn every keyboard edit into a
        // whole-score pass).
        var pending = debounce.running;
        if (state.startLayoutTick >= 0 && state.endLayoutTick >= state.startLayoutTick) {
            if (pending && debounce.range)
                debounce.range = { from: Math.min(debounce.range.from, state.startLayoutTick),
                                   to: Math.max(debounce.range.to, state.endLayoutTick) };
            else if (!pending)
                debounce.range = { from: state.startLayoutTick, to: state.endLayoutTick };
        } else if (!(pending && debounce.range)) {
            debounce.range = null;                  // unknown extent: re-do everything
        }
        debounce.restart();
    }

    Timer {
        id: debounce
        interval: 350
        property var range: null
        onTriggered: check(range, false)            // live: no undo step, current copy maps
    }

    onRun: {
        if (!curScore) return;
        lastScore = curScore.scoreName;
        check(null, false);             // notes and texts at once; slurs follow from the copy
        requestCopy({ full: true });
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 10
        spacing: 8

        Text {
            Layout.fillWidth: true
            visible: statusLine !== ""
            text: statusLine
            wrapMode: Text.WordWrap
            color: "#444444"
            font.pixelSize: 11
        }

        // The list and the fingerboard share one container and each fill it with anchors,
        // so the diagram always has the container's real size the moment it appears —
        // it does not wait for the column layout to hand space to a newly visible item.
        Item {
            id: listArea
            Layout.fillWidth: true
            Layout.fillHeight: true
            // no minimum height: the buttons below must stay reachable in a short panel

        // While a playable chord is selected, its fingerboard replaces the list.
        // Drawn with plain Rectangles and Text, NOT a Canvas: a QML Canvas paints
        // through an OpenGL framebuffer by default and stayed blank in the MuseScore
        // dock, while plain items (like the legend swatches) always render. Every line
        // in the diagram is horizontal or vertical, so a Rectangle draws it exactly.
        Item {
            id: board
            anchors.fill: parent
            visible: geom !== null && !showList
            clip: true
            property var items: (geom !== null && width > 0 && height > 0)
                                ? F.layoutFingerboard(geom, width, height) : []
            // true when the diagram labels its dots itself (see fingerboard.js "meta")
            property bool namesShown: {
                for (var i = 0; i < items.length; i++)
                    if (items[i].kind === "meta") return items[i].namesShown;
                return false;
            }
            Repeater {
                model: board.items
                delegate: Item {
                    property var it: modelData
                    property bool isLine: it.kind === "line"
                    property bool vertical: isLine && it.x1 === it.x2
                    property real lw: it.width || 1
                    Rectangle {
                        visible: it.kind === "line" || it.kind === "rect" || it.kind === "circle"
                        x: isLine ? (vertical ? it.x1 - lw / 2 : Math.min(it.x1, it.x2))
                                  : (it.kind === "circle" ? it.x - it.r : (it.x || 0))
                        y: isLine ? (vertical ? Math.min(it.y1, it.y2) : it.y1 - lw / 2)
                                  : (it.kind === "circle" ? it.y - it.r : (it.y || 0))
                        width:  isLine ? (vertical ? lw : Math.abs(it.x2 - it.x1))
                                       : (it.kind === "circle" ? it.r * 2 : (it.w || 0))
                        height: isLine ? (vertical ? Math.abs(it.y2 - it.y1) : lw)
                                       : (it.kind === "circle" ? it.r * 2 : (it.h || 0))
                        radius: it.kind === "circle" ? it.r : 0
                        color: it.kind === "line" ? it.color
                             : (it.fill ? it.fill : "transparent")
                        border.width: (it.kind === "circle" && !it.fill) ? lw : 0
                        border.color: it.stroke ? it.stroke : "transparent"
                        opacity: it.opacity !== undefined ? it.opacity : 1
                    }
                    Text {
                        visible: it.kind === "text"
                        text: it.text || ""
                        font.pixelSize: it.size || 10
                        font.bold: !!it.bold
                        color: it.color || "#333333"
                        // display-list text coordinates are baselines, as on a canvas
                        x: it.align === "center" ? it.x - implicitWidth / 2
                         : it.align === "right" ? it.x - implicitWidth : (it.x || 0)
                        y: (it.y || 0) - baselineOffset
                    }
                }
            }
        }

        // W1: while wind notes are selected, their bars as a register graph (one
        // instrument at a time; chips, arrows or the wheel switch). Same drawing approach
        // as the fingerboard: a display list of plain Rectangles and Text.
        Item {
            id: graphArea
            anchors.fill: parent
            visible: rgm !== null && geom === null && !showList
            clip: true

            Item {
                id: chipRow
                anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top
                height: 26
                ListView {
                    id: chips
                    anchors.left: parent.left; anchors.right: arrows.left; anchors.rightMargin: 6
                    anchors.top: parent.top; anchors.bottom: parent.bottom
                    orientation: ListView.Horizontal
                    spacing: 5
                    clip: true
                    boundsBehavior: Flickable.StopAtBounds
                    model: rgm ? rgm.graphs.length : 0
                    currentIndex: rgIndex
                    highlightFollowsCurrentItem: false
                    onCurrentIndexChanged: positionViewAtIndex(currentIndex, ListView.Contain)
                    onContentXChanged: rgChipsX = contentX
                    onModelChanged: { contentX = Math.max(0, Math.min(rgChipsX, contentWidth - width)); positionViewAtIndex(rgIndex, ListView.Contain) }
                    delegate: Rectangle {
                        property bool on: index === rgIndex
                        height: 22; y: 2
                        width: chipText.implicitWidth + 18
                        radius: 11
                        color: on ? "#222222" : "#ffffff"
                        border.color: on ? "#222222" : "#c4c4c4"
                        Text {
                            id: chipText
                            anchors.centerIn: parent
                            text: rgm && index < rgm.graphs.length ? rgm.graphs[index].chip : ""
                            font.pixelSize: 11
                            color: parent.on ? "#ffffff" : "#222222"
                        }
                        MouseArea { anchors.fill: parent; onClicked: showGraph(index) }
                    }
                    // wheel or trackpad over the chips slides them sideways
                    MouseArea {
                        anchors.fill: parent
                        acceptedButtons: Qt.NoButton
                        onWheel: {
                            var dlt = Math.abs(wheel.angleDelta.x) > Math.abs(wheel.angleDelta.y) ? wheel.angleDelta.x : wheel.angleDelta.y;
                            var max = Math.max(0, chips.contentWidth - chips.width);
                            chips.contentX = Math.max(0, Math.min(max, chips.contentX - dlt / 2));
                        }
                    }
                }
                // fades mark the side that has more chips: a few strips of the panel colour,
                // more opaque towards the edge (QML gradients only run vertically)
                SystemPalette { id: pal }
                Row {
                    visible: chips.contentX > 1
                    anchors.left: chips.left; anchors.top: chips.top; anchors.bottom: chips.bottom
                    Repeater {
                        model: 6
                        Rectangle { width: 3; height: parent.height; color: pal.window; opacity: 1 - index / 6 }
                    }
                }
                Row {
                    visible: chips.contentX < chips.contentWidth - chips.width - 1
                    anchors.right: chips.right; anchors.top: chips.top; anchors.bottom: chips.bottom
                    Repeater {
                        model: 6
                        Rectangle { width: 3; height: parent.height; color: pal.window; opacity: (index + 1) / 6 }
                    }
                }
                Row {
                    id: arrows
                    anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                    spacing: 4
                    Button { text: "‹"; implicitWidth: 28; enabled: rgIndex > 0; tooltip: "Previous instrument"; onClicked: showGraph(rgIndex - 1) }
                    Button { text: "›"; implicitWidth: 28; enabled: rgm !== null && rgIndex < rgm.graphs.length - 1; tooltip: "Next instrument"; onClicked: showGraph(rgIndex + 1) }
                }
            }
            Text {
                anchors.right: parent.right; anchors.top: chipRow.bottom; anchors.topMargin: 2
                text: rgm ? (rgIndex + 1) + " / " + rgm.graphs.length : ""
                font.pixelSize: 10; color: "#777777"
                visible: rgm !== null && rgm.graphs.length > 1
                z: 2
            }

            Item {
                id: graph
                anchors.left: parent.left; anchors.right: parent.right
                anchors.top: chipRow.bottom; anchors.bottom: parent.bottom
                anchors.topMargin: 4
                property var items: (rgm !== null && width > 0 && height > 0) ? RG.rgLayout(rgm, rgIndex, width, height) : []
                Repeater {
                    model: graph.items
                    delegate: Item {
                        property var it: modelData
                        property bool isLine: it.kind === "line"
                        property bool vertical: isLine && it.x1 === it.x2
                        property real lw: it.width || 1
                        Rectangle {
                            visible: it.kind === "line" || it.kind === "rect"
                            x: isLine ? (vertical ? it.x1 - lw / 2 : Math.min(it.x1, it.x2)) : (it.x || 0)
                            y: isLine ? (vertical ? Math.min(it.y1, it.y2) : it.y1 - lw / 2) : (it.y || 0)
                            width:  isLine ? (vertical ? lw : Math.abs(it.x2 - it.x1)) : (it.w || 0)
                            height: isLine ? (vertical ? Math.abs(it.y2 - it.y1) : lw) : (it.h || 0)
                            color: it.kind === "line" ? it.color : (it.fill ? it.fill : "transparent")
                            opacity: it.opacity !== undefined ? it.opacity : 1
                            // antialiased only where the display list asks for it (the dynamic
                            // strip's sloping edge); elsewhere off, so slices meet without seams
                            antialiasing: it.smooth === true
                        }
                        Text {
                            visible: it.kind === "text"
                            text: it.text || ""
                            font.pixelSize: it.size || 10
                            font.bold: !!it.bold
                            color: it.color || "#333333"
                            style: it.halo ? Text.Outline : Text.Normal
                            styleColor: it.halo || "transparent"
                            x: it.align === "center" ? it.x - implicitWidth / 2
                             : it.align === "right" ? it.x - implicitWidth : (it.x || 0)
                            y: (it.y || 0) - baselineOffset
                        }
                    }
                }
                // the wheel over the graph changes instrument
                MouseArea {
                    anchors.fill: parent
                    acceptedButtons: Qt.NoButton
                    property real acc: 0
                    onWheel: {
                        if (!rgm) { wheel.accepted = false; return; }
                        acc += wheel.angleDelta.y;
                        if (Math.abs(acc) < 120) return;
                        var to = rgIndex + (acc < 0 ? 1 : -1);
                        acc = 0;
                        if (to < 0 || to >= rgm.graphs.length) { wheel.accepted = false; return; }
                        showGraph(to);
                    }
                }
            }
        }

        TableView {
            id: table
            visible: (geom === null && rgm === null) || showList
            anchors.fill: parent
            model: results
            // Deliberately NOT onCurrentRowChanged: that also fires when a live pass
            // refills the model, and would move the selection behind your back.
            onClicked: selectRow(row)
            onActivated: selectRow(row)
            // Bar and Staff are as wide as their longest entry; Reason takes the rest.
            // The notes themselves are shown by the selection and the fingerboard.
            // what the row is: a red square for something unplayable, a dark yellow one for a
            // stretch or a limit that is over — the same two colours the noteheads get
            TableViewColumn {
                role: "verdict"; title: ""; width: 20; resizable: false; movable: false
                delegate: Item {
                    Rectangle {
                        anchors.centerIn: parent
                        width: 10; height: 10; radius: 2
                        color: styleData.value === "impossible" ? S.COLOR.impossible : S.COLOR.outOfReach
                    }
                }
            }
            TableViewColumn { role: "bar";        title: "Bar";    width: barColWidth }
            TableViewColumn { role: "staffShort"; title: "Staff";  width: staffColWidth }
            // as wide as the longest reason, or the rest of the panel when that is wider;
            // a horizontal scroll bar appears when the three columns do not fit
            TableViewColumn { role: "reason";     title: "Reason";
                              width: Math.max(reasonColWidth, table.viewport.width - barColWidth - staffColWidth - 20) }
        }
        }   // listArea

        Text {
            Layout.fillWidth: true
            // redundant under a fingerboard that names its notes; kept with the list, and
            // in a panel too narrow for the diagram's note names
            visible: selectedInfo !== "" && !graphArea.visible &&
                     (geom === null || showList || !board.namesShown || !board.visible)
            text: "Selected: " + selectedInfo
            wrapMode: Text.WordWrap
            font.pixelSize: 11
            color: "#222222"
        }

        // Only what the panel cannot do by itself. "Clear" and "Apply to score" were removed
        // (user, 2026-09-17): a live pass paints the colours back a moment later, so clearing
        // did nothing lasting, and the colours are already on the score without an undo step.
        // Re-check is the one thing still needed, and only on a score whose copy is too slow to
        // read automatically — the status line then asks for it.
        Flow {
            Layout.fillWidth: true
            spacing: 6
            Button {
                text: "Re-check"
                visible: !copyAuto
                tooltip: "This score is slow to read, so slurs and articulations are not picked up automatically. Read it again now."
                onClicked: fullCheck(false)
            }
            Button {
                text: showList ? (geom !== null ? "Fingerboard" : "Graph") : "List"
                visible: geom !== null || rgm !== null
                tooltip: "Switch between the diagram of the selection and the list"
                onClicked: showList = !showList
            }
        }
    }
}
