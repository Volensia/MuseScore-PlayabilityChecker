//=============================================================================
//  Orchestration Checker — strings
//  S1: marks notes available on an open string.
//  S2: checks every multiple stop for playability (skipped while a staff is div.).
//  Rules and sources: ../SPEC-strings.md and the sourcebook tables.
//=============================================================================
import QtQuick 2.2
import QtQuick.Controls 1.1
import QtQuick.Layouts 1.1
import MuseScore 3.0
import "analyse.js" as A
import "strings.js" as S

MuseScore {
    menuPath: "Plugins.Playability Checker.Check strings (once)"
    description: "Marks open strings and flags unplayable multiple stops on bowed string staves."
    version: "0.1"
    requiresScore: true
    pluginType: "dialog"
    width: 640
    height: 460

    property var env: ({ CHORD: Element.CHORD, DIAMOND: NoteHeadGroup.HEAD_DIAMOND,
                         INSTRUMENT_CHANGE: Element.INSTRUMENT_CHANGE,
                         ARTICULATION: Element.ARTICULATION })

    // Harmonic circles from the Articulations palette are only reachable through
    // the selection, so this borrows the selection and puts it back.
    function circleMap() {
        if (!curScore) return null;
        var keep = A.saveSelection(curScore);
        cmd("select-all");
        var map = A.buildCircleMap(curScore.selection.elements, env);
        A.restoreSelection(curScore, keep);
        return map;
    }
    property string statusLine: ""

    ListModel { id: results }

    function runCheck() {
        var out = A.analyse(curScore, env, null, circleMap());
        var applied = A.applyMarks(curScore, out.marks);
        results.clear();
        for (var i = 0; i < out.rows.length; i++) results.append(out.rows[i]);
        var c = out.counts;
        statusLine = c.open + " open · " + c.playable + " playable · " +
                     c.outOfReach + " out of reach · " + c.impossible + " impossible" +
                     (c.div ? " · " + c.div + " skipped (div.)" : "") +
                     (c.harmonics ? " · " + c.harmonics + " harmonics (" +
                                    (c.harmBad + c.harmRisky) + " flagged)" : "") +
                     (applied.skipped ? " · " + applied.skipped + " left alone (own colour)" : "");
        console.log("PlayabilityChecker: " + statusLine + " — " + out.rows.length + " flagged");
    }

    function runClear() {
        var n = A.clearMarks(curScore, env);
        results.clear();
        statusLine = "cleared " + n + " notehead" + (n === 1 ? "" : "s");
    }

    onRun: runCheck()

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 12
        spacing: 10

        Text {
            text: "Playability Checker — strings"
            font.pixelSize: 16; font.bold: true
        }
        Text {
            Layout.fillWidth: true
            text: statusLine
            wrapMode: Text.WordWrap
            color: "#444444"
        }

        // legend
        RowLayout {
            spacing: 14
            Repeater {
                model: [
                    { c: S.COLOR.impossible, t: "unplayable" },
                    { c: S.COLOR.outOfReach, t: "stretch" },
                    { c: S.COLOR.open,       t: "open string" }
                ]
                RowLayout {
                    spacing: 4
                    Rectangle { width: 11; height: 11; radius: 2; color: modelData.c }
                    Text { text: modelData.t; font.pixelSize: 11; color: "#444444" }
                }
            }
        }

        TableView {
            id: table
            Layout.fillWidth: true
            Layout.fillHeight: true
            model: results
            TableViewColumn { role: "bar";     title: "Bar";   width: 45 }
            TableViewColumn { role: "staff";   title: "Staff"; width: 110 }
            TableViewColumn { role: "verdict"; title: "Verdict"; width: 90 }
            TableViewColumn { role: "reason";  title: "Reason"; width: 150 }
            TableViewColumn { role: "notes";   title: "Notes (string)"; width: 200 }
        }

        RowLayout {
            Layout.alignment: Qt.AlignRight
            spacing: 8
            Button { text: "Check again"; onClicked: runCheck() }
            Button { text: "Clear markings"; onClicked: runClear() }
            Button { text: "Close"; onClicked: quit() }
        }
    }
}
