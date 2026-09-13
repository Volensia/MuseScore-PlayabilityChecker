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
                         ARTICULATION: Element.ARTICULATION, SLUR: Element.SLUR, HAIRPIN: Element.HAIRPIN, TEMPO_TEXT: Element.TEMPO_TEXT })

    // Harmonic circles from the Articulations palette, slurs and staccato dots (S10)
    // are only reachable through the selection, so this borrows the selection once
    // and puts it back. Returns { circles, bowing }.
    function selectionMaps() {
        if (!curScore) return { circles: null, bowing: null };
        var keep = A.saveSelection(curScore);
        cmd("select-all");
        var els = curScore.selection.elements;
        var maps = { circles: A.buildCircleMap(els, env), bowing: A.buildBowMap(els, env) };
        A.restoreSelection(curScore, keep);
        return maps;
    }
    property string statusLine: ""

    ListModel { id: results }

    // Select a row's chord and scroll to it: MuseScore only pans inside view commands,
    // so "top-chord" goes to the chord's own top note first (see the live panel).
    function selectRow(row) {
        var r = results.get(row);
        var ch = A.findChord(curScore, env, r.track, r.tick, r.grace);
        if (ch && ch.notes && ch.notes.length) {
            curScore.selection.clear();
            curScore.selection.select(ch.notes[0]);
            cmd("top-chord");
        }
        A.selectChord(curScore, env, r);
    }

    function runCheck() {
        var maps = selectionMaps();
        var out = A.analyse(curScore, env, null, maps.circles, null, maps.bowing);
        var applied = A.applyMarks(curScore, out.marks);
        results.clear();
        for (var i = 0; i < out.rows.length; i++) results.append(out.rows[i]);
        var c = out.counts;
        statusLine = c.open + " open · " + c.playable + " playable · " +
                     c.outOfReach + " out of reach · " + c.impossible + " impossible" +
                     (c.div ? " · " + c.div + " skipped (div.)" : "") +
                     (c.harmonics ? " · " + c.harmonics + " harmonics (" +
                                    (c.harmBad + c.harmRisky) + " flagged)" : "") +
                     (c.jete ? " · " + c.jete + " jeté strokes (" + c.jeteFlagged + " flagged)" : "") +
                     (c.groups ? " · " + c.groups + " staccato groups (" + c.groupsFlagged + " flagged)" : "") +
                     (c.slurs ? " · " + c.slurs + " slurs timed (" + c.slursFlagged + " too long)" : "") +
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
            onClicked: selectRow(row)
            onActivated: selectRow(row)
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
