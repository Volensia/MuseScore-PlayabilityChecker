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
import "analyse.js" as A
import "strings.js" as S

MuseScore {
    menuPath: "Plugins.Orchestration Checker.Live check (strings)"
    description: "Checks bowed-string staves while you edit: open strings, and multiple stops that can't be played."
    version: "0.2"
    requiresScore: true
    pluginType: "dock"
    dockArea: "right"
    width: 340
    height: 520

    property var env: ({ CHORD: Element.CHORD, DIAMOND: NoteHeadGroup.HEAD_DIAMOND })
    property bool liveOn: true
    property bool busy: false           // re-entry guard: our own writes fire onScoreStateChanged
    property int passes: 0
    property string statusLine: "not run yet"
    property string lastScore: ""

    ListModel { id: results }

    function check(range, command) {
        if (!curScore) return;
        busy = true;
        A.clearMarks(curScore, env, { command: command, from: range ? range.from : -1,
                                                        to:   range ? range.to   : -1 });
        var out = A.analyse(curScore, env, range);
        var applied = A.applyMarks(curScore, out.marks, { command: command });
        busy = false;
        passes++;

        // a partial pass only replaces the rows in its own bar range
        if (range && range.from >= 0) {
            var kept = [];
            for (var i = 0; i < results.count; i++) {
                var r = results.get(i);
                if (r.tick < range.from || r.tick > range.to)
                    kept.push({ bar: r.bar, tick: r.tick, staff: r.staff,
                                verdict: r.verdict, reason: r.reason, notes: r.notes });
            }
            results.clear();
            for (var k = 0; k < kept.length; k++) results.append(kept[k]);
        } else {
            results.clear();
        }
        for (var j = 0; j < out.rows.length; j++) results.append(out.rows[j]);

        var c = out.counts;
        statusLine = c.impossible + " unplayable · " + c.outOfReach + " stretch · " +
                     c.open + " open · " + c.playable + " playable" +
                     (c.div ? " · " + c.div + " skipped (div.)" : "") +
                     (applied.skipped ? " · " + applied.skipped + " own colour kept" : "");
        console.log("OrchestrationChecker live: pass " + passes +
                    (range ? " bars " + range.from + "–" + range.to : " (whole score)") +
                    (command ? " [undoable]" : " [no undo step]") + " — " + statusLine);
    }

    function fullCheck(command) { check(null, command); }

    onScoreStateChanged: {
        if (busy || !liveOn) return;
        if (!curScore) return;
        if (curScore.scoreName !== lastScore) {     // switched tab: start over
            lastScore = curScore.scoreName;
            debounce.range = null;
            debounce.restart();
            return;
        }
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
            Text { text: "Live string check"; font.pixelSize: 14; font.bold: true }
            Item { Layout.fillWidth: true }
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

        TableView {
            Layout.fillWidth: true
            Layout.fillHeight: true
            model: results
            TableViewColumn { role: "bar";     title: "Bar";    width: 40 }
            TableViewColumn { role: "staff";   title: "Staff";  width: 80 }
            TableViewColumn { role: "reason";  title: "Reason"; width: 105 }
            TableViewColumn { role: "notes";   title: "Notes";  width: 95 }
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: 6
            Button { text: "Re-check"; onClicked: fullCheck(false) }
            Button {
                text: "Apply to score"
                tooltip: "Write the same colours as a normal, undoable edit"
                onClicked: fullCheck(true)
            }
            Item { Layout.fillWidth: true }
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
