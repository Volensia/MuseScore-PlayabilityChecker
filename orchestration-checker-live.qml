//=============================================================================
//  Orchestration Checker — live string check
//  Keeps checking while you edit. Colours are written straight to the noteheads,
//  without startCmd/endCmd, so a live pass never pushes an undo step (verified:
//  see SPEC-strings.md, "Live mode"). Use "Apply to score" for a normal,
//  undoable edit you can save.
//
//  If the dock panel misbehaves in your MuseScore, change pluginType to "dialog"
//  and delete the dockArea line — everything else works the same.
//=============================================================================
import QtQuick 2.2
import QtQuick.Controls 1.1
import QtQuick.Layouts 1.1
import MuseScore 3.0
import FileIO 3.0
import "analyse.js" as A
import "strings.js" as S
import "fingerboard.js" as F

MuseScore {
    menuPath: "Plugins.Playability Checker.Live check (strings)"
    description: "Checks bowed-string staves while you edit: open strings, and multiple stops that can't be played."
    version: "0.2"
    requiresScore: true
    pluginType: "dock"
    dockArea: "right"
    width: 340
    height: 520

    property var env: ({ CHORD: Element.CHORD, NOTE: Element.NOTE,
                         DIAMOND: NoteHeadGroup.HEAD_DIAMOND,
                         NORMAL: NoteHeadGroup.HEAD_NORMAL,
                         INSTRUMENT_CHANGE: Element.INSTRUMENT_CHANGE,
                         ARTICULATION: Element.ARTICULATION,
                         SYM: { black: SymId.noteheadBlack, half: SymId.noteheadHalf,
                                whole: SymId.noteheadWhole, breve: SymId.noteheadDoubleWhole,
                                diamondBlack: SymId.noteheadDiamondBlack,
                                diamondHalf: SymId.noteheadDiamondHalf,
                                diamondWhole: SymId.noteheadDiamondWhole,
                                diamondBreve: SymId.noteheadDiamondDoubleWhole } })

    // Instrument ranges, read from a temp copy of the score (the plugin API has no
    // range properties). Needed to know which notes MuseScore paints over.
    property var ranges: null
    property var covers: []             // keys of notes drawn over, for selection changes
    property bool coverOn: true         // draw our colour over MuseScore's range colours
    FileIO { id: rangeFile }

    function readRanges() {
        if (!curScore || !coverOn) { ranges = null; return; }
        var base = rangeFile.tempPath() + "/playability-checker-ranges";
        busy = true;
        var ok = writeScore(curScore, base, "mscx");   // a copy: the score keeps its name
        busy = false;
        if (!ok) { ranges = null; return; }
        rangeFile.source = base + ".mscx";
        ranges = A.parseRanges(rangeFile.read());
    }

    function overlayOpts(command) {
        return { command: command, overlay: coverOn, env: env,
                 newSymbol: function () { return newElement(Element.SYMBOL); } };
    }
    property var circles: null          // "track|tick" -> true, rebuilt on full checks
    property bool liveOn: true
    property bool busy: false           // re-entry guard: our own writes fire onScoreStateChanged
    property bool syncing: false        // the panel itself is moving a selection
    property bool rebuilding: false     // the results model is being refilled
    property string rowsScore: ""       // the score the rows belong to
    property string selectedInfo: ""    // the "Selected" line under the table
    property var geom: null             // fingerboard data while a playable chord is selected
    property bool showList: false       // the user asked for the list back

    // TEMPORARY: says where the fingerboard fails, if it does. Remove once it is seen working.
    property string debugInfo: selectedInfo === "" ? "" :
        ("fingerboard " + (geom !== null ? "recognised" : "not recognised") +
         " · " + (board.items ? board.items.length : 0) + " shapes" +
         " · area " + Math.round(listArea.width) + "×" + Math.round(listArea.height) +
         " · diagram " + Math.round(board.width) + "×" + Math.round(board.height) +
         " · shown " + board.visible + (showList ? " (list chosen)" : ""))

    property int passes: 0
    property string statusLine: "not run yet"
    property string lastScore: ""

    ListModel { id: results }

    // Circles from the Articulations palette can only be found with a select-all,
    // which means borrowing the selection. A range selection cannot be restored
    // faithfully (startSegment/endSegment read back as null), so doing this
    // automatically made editing unusable: every typed note lost its selection.
    // It now runs ONLY on an explicit action — plugin start, Re-check, Apply.
    // Circles from the Symbols palette need none of this and stay fully live.
    function rebuildCircles() {
        if (!curScore) return;
        var keep = A.saveSelection(curScore);
        cmd("select-all");
        circles = A.buildCircleMap(curScore.selection.elements, env);
        A.restoreSelection(curScore, keep);
    }

    function check(range, command, scanCircles) {
        if (!curScore) return;
        busy = true;
        if (scanCircles) rebuildCircles();       // never on an automatic pass
        busy = false;
        if (coverOn && (scanCircles || ranges === null)) readRanges();
        busy = true;
        A.clearMarks(curScore, env, { command: command, from: range ? range.from : -1,
                                                        to:   range ? range.to   : -1 });
        var out = A.analyse(curScore, env, range, circles, coverOn ? ranges : null);
        var applied = A.applyMarks(curScore, out.marks, overlayOpts(command));
        busy = false;
        passes++;

        // covered notes: a partial pass replaces only the keys inside its range
        var keepCovers = [];
        if (range && range.from >= 0)
            for (var ci = 0; ci < covers.length; ci++)
                if (covers[ci].tick < range.from || covers[ci].tick > range.to)
                    keepCovers.push(covers[ci]);
        covers = keepCovers.concat(out.covers);

        // a partial pass only replaces the rows in its own bar range
        rebuilding = true;
        if (range && range.from >= 0) {
            var kept = [];
            for (var i = 0; i < results.count; i++) {
                var r = results.get(i);
                if (r.tick < range.from || r.tick > range.to)
                    kept.push({ bar: r.bar, tick: r.tick, staff: r.staff,
                                verdict: r.verdict, reason: r.reason, notes: r.notes,
                                track: r.track, grace: r.grace });
            }
            results.clear();
            for (var k = 0; k < kept.length; k++) results.append(kept[k]);
        } else {
            results.clear();
        }
        for (var j = 0; j < out.rows.length; j++) results.append(out.rows[j]);
        rebuilding = false;
        rowsScore = curScore.scoreName;
        syncFromScore();                    // keep the highlight on what is selected

        var c = out.counts;
        statusLine = c.impossible + " unplayable · " + c.outOfReach + " stretch · " +
                     c.open + " open · " + c.playable + " playable" +
                     (c.div ? " · " + c.div + " skipped (div.)" : "") +
                     (c.harmonics ? " · " + c.harmonics + " harmonics (" +
                                    (c.harmBad + c.harmRisky) + " flagged)" : "") +
                     (applied.skipped ? " · " + applied.skipped + " own colour kept" : "") +
                     (c.covered ? " · " + c.covered + " drawn over MuseScore's range colour" : "");
        console.log("PlayabilityChecker live: pass " + passes +
                    (range ? " bars " + range.from + "–" + range.to : " (whole score)") +
                    (command ? " [undoable]" : " [no undo step]") + " — " + statusLine);
    }

    function fullCheck(command) { check(null, command, true); }

    // Score -> panel: highlight the row for the selected chord, and describe it.
    // Rows and chords name each other by { track, tick, grace } — see analyse.js.
    function syncFromScore() {
        if (!curScore) return;
        var key = A.selectedChord(curScore, env);
        selectedInfo = key ? A.inspectChord(curScore, env, key, circles) : "";
        geom = key ? A.chordGeometry(curScore, env, key, circles) : null;
        showList = false;
        // a selected note shows MuseScore's selection colour, so uncover it
        if (coverOn && covers.length) {
            busy = true;
            A.refreshCovers(curScore, env, covers, overlayOpts(false));
            busy = false;
        }
        var row = -1;
        if (key && curScore.scoreName === rowsScore) {
            for (var i = 0; i < results.count; i++) {
                var r = results.get(i);
                if (r.track === key.track && r.tick === key.tick && r.grace === key.grace) {
                    row = i;
                    break;
                }
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
        var found = A.selectChord(curScore, env, r);
        syncing = false;
        if (!found) {
            selectedInfo = "that chord has changed since the check — press Re-check";
            return;
        }
        var key = A.selectedChord(curScore, env);
        selectedInfo = key ? A.inspectChord(curScore, env, key, circles) : "";
        geom = key ? A.chordGeometry(curScore, env, key, circles) : null;   // rows are never playable
    }

    onScoreStateChanged: {
        if (busy || !curScore) return;
        if (state.selectionChanged && !syncing) syncFromScore();
        if (!liveOn) return;
        if (curScore.scoreName !== lastScore) {     // switched tab: start over
            lastScore = curScore.scoreName;
            circles = null;             // the old score's map does not apply here
            ranges = null;
            covers = [];
            debounce.range = null;
            debounce.restart();
            return;
        }
        if (state.instrumentsChanged) ranges = null;    // re-read on the next pass
        // a pure selection change doesn't alter any note
        if (state.selectionChanged && state.startLayoutTick < 0 && !state.instrumentsChanged) return;
        if (state.startLayoutTick >= 0 && state.endLayoutTick >= state.startLayoutTick)
            debounce.range = { from: state.startLayoutTick, to: state.endLayoutTick };
        else
            debounce.range = null;                  // unknown extent: re-do everything
        debounce.restart();
    }

    Timer {
        id: debounce
        interval: 350
        property var range: null
        onTriggered: check(range, false)            // live: no undo step
    }

    // There is deliberately no timer that scans for harmonic circles. It needs a
    // select-all, and the selection cannot be handed back intact, so running it
    // on any automatic schedule fights the person typing.

    onRun: {
        if (curScore) lastScore = curScore.scoreName;
        fullCheck(false);
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 10
        spacing: 8

        RowLayout {
            Layout.fillWidth: true
            Text { text: "Playability Checker — live"; font.pixelSize: 14; font.bold: true }
            Item { Layout.fillWidth: true }
            CheckBox {
                text: "cover"
                checked: true
                tooltip: "Draw the plugin's colour over notes MuseScore marks as out of range"
                onCheckedChanged: {
                    coverOn = checked;
                    if (!checked) { covers = []; ranges = null; }
                    fullCheck(false);
                }
            }
            CheckBox {
                id: liveBox
                text: "live"
                checked: true
                onCheckedChanged: { liveOn = checked; if (checked) fullCheck(false); }
            }
        }

        Text {
            Layout.fillWidth: true
            text: statusLine
            wrapMode: Text.WordWrap
            color: "#444444"
            font.pixelSize: 11
        }

        RowLayout {
            spacing: 12
            Repeater {
                model: [ { c: S.COLOR.impossible, t: "unplayable" },
                         { c: S.COLOR.outOfReach, t: "stretch" },
                         { c: S.COLOR.open,       t: "open string" } ]
                RowLayout {
                    spacing: 4
                    Rectangle { width: 11; height: 11; radius: 2; color: modelData.c }
                    Text { text: modelData.t; font.pixelSize: 11; color: "#444444" }
                }
            }
        }

        // The list and the fingerboard share one container and each fill it with anchors,
        // so the diagram always has the container's real size the moment it appears —
        // it does not wait for the column layout to hand space to a newly visible item.
        Item {
            id: listArea
            Layout.fillWidth: true
            Layout.fillHeight: true
            Layout.minimumHeight: 220

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
            Repeater {
                model: board.items
                delegate: Item {
                    property var it: modelData
                    property bool isLine: it.kind === "line"
                    property bool vertical: isLine && it.x1 === it.x2
                    property real lw: it.width || 1
                    Rectangle {
                        visible: it.kind !== "text"
                        x: isLine ? (vertical ? it.x1 - lw / 2 : Math.min(it.x1, it.x2))
                                  : (it.kind === "circle" ? it.x - it.r : it.x)
                        y: isLine ? (vertical ? Math.min(it.y1, it.y2) : it.y1 - lw / 2)
                                  : (it.kind === "circle" ? it.y - it.r : it.y)
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

        TableView {
            id: table
            visible: geom === null || showList
            anchors.fill: parent
            model: results
            // Deliberately NOT onCurrentRowChanged: that also fires when a live pass
            // refills the model, and would move the selection behind your back.
            onClicked: selectRow(row)
            onActivated: selectRow(row)
            TableViewColumn { role: "bar";     title: "Bar";    width: 40 }
            TableViewColumn { role: "staff";   title: "Staff";  width: 80 }
            TableViewColumn { role: "reason";  title: "Reason"; width: 105 }
            TableViewColumn { role: "notes";   title: "Notes";  width: 95 }
        }
        }   // listArea

        Text {
            Layout.fillWidth: true
            visible: debugInfo !== ""
            text: "debug — " + debugInfo
            wrapMode: Text.WordWrap
            font.pixelSize: 10
            color: "#8a8a8a"
        }

        Text {
            Layout.fillWidth: true
            visible: selectedInfo !== ""
            text: "Selected: " + selectedInfo
            wrapMode: Text.WordWrap
            font.pixelSize: 11
            color: "#222222"
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: 6
            Button {
                text: "Re-check"
                tooltip: "Also scans for harmonic circles added from the Articulations palette"
                onClicked: fullCheck(false)
            }
            Button {
                text: "Apply to score"
                tooltip: "Write the same colours as a normal, undoable edit"
                onClicked: fullCheck(true)
            }
            Item { Layout.fillWidth: true }
            Button {
                text: showList ? "Fingerboard" : "List"
                visible: geom !== null
                tooltip: "Switch between the fingerboard of the selected chord and the list"
                onClicked: showList = !showList
            }
            Button {
                text: "Clear"
                onClicked: {
                    busy = true;
                    var n = A.clearMarks(curScore, env, { command: true });
                    busy = false;
                    results.clear();
                    statusLine = "cleared " + n + " notehead" + (n === 1 ? "" : "s");
                }
            }
        }
    }
}
