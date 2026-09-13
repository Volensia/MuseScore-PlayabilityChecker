// Fingerboard diagram for a playable multiple stop.
//
// This module only turns chord geometry (from analyse.js chordGeometry) into a
// DISPLAY LIST — plain lines, circles, boxes and text with coordinates. The QML
// Canvas replays the list; proto/render_displaylist.py replays the same list to a
// PNG so the layout can be checked without a GUI. Keeping the drawing decisions
// here, and not in onPaint, is what makes the diagram testable at all: MuseScore's
// headless -p mode quits before a Canvas ever paints.
//
// Layout, following the chord-chart convention: strings vertical, lowest string on
// the left, nut at the top. Distance down the string follows the same geometry as
// the stretch model (strings.js reachAt): a stop n semitones up sits at
// L(1 - 2^(-n/12)), so semitones crowd together higher up the fingerboard.
//
// Every name here is prefixed: the bundler pastes all modules into one function
// scope, so a generic name like `layout` could silently collide with another file.
.pragma library

var FB_COLOR = {
    text:    "#333333",
    faint:   "#8a8a8a",
    string:  "#7a7a7a",
    nut:     "#2b2b2b",
    tick:    "#e6e6e6",
    mark:    "#c8c8c8",
    stopped: "#1f1f1f",
    open:    "#00a0b0",       // the plugin's open-string teal
    reach:   "#00a0b0"
};

// landmark semitones, labelled down the left edge
var FB_MARKS = { 5: true, 7: true, 12: true, 19: true, 24: true, 31: true };

// strings are named by letter ("the G string") with their number underneath
var FB_ROMAN = ["I", "II", "III", "IV", "V"];

// How many semitones the diagram shows: at least an octave, enough for the
// highest stopped note and the hand's reach, never more than three octaves.
function fingerboardSpan(geom) {
    var top = 0;
    for (var i = 0; i < geom.notes.length; i++)
        if (geom.notes[i].offset > top) top = geom.notes[i].offset;
    if (geom.stopped) top = Math.max(top, geom.position + geom.reach);
    return Math.max(12, Math.min(36, Math.ceil(top) + 3));
}

function layoutFingerboard(geom, w, h) {
    var items = [];
    if (!geom || !geom.strings || w < 120 || h < 160) return items;

    var n = geom.strings.length;
    var left = 34, right = 46, top = 88, bottom = 14;
    var bw = w - left - right, bh = h - top - bottom;
    var span = fingerboardSpan(geom);
    var norm = 1 - Math.pow(2, -span / 12);

    function yAt(semi) { return top + bh * (1 - Math.pow(2, -semi / 12)) / norm; }
    function xAt(stringIdx) {                  // string I (index 0) is rightmost
        var col = n - 1 - stringIdx;
        return left + (n === 1 ? bw / 2 : bw * col / (n - 1));
    }
    var xLow = xAt(n - 1), xHigh = xAt(0);

    // header: what this is, and the hand position it was judged at
    items.push({ kind: "text", x: 2, y: 14, text: geom.instrument + " — fingerboard",
                 size: 12, color: FB_COLOR.text, bold: true, align: "left" });
    var sub = geom.stopped
        ? "lowest stop +" + geom.position + " st · hand reaches " +
          (Math.round(geom.reach * 10) / 10) + " st there"
        : "open strings only";
    items.push({ kind: "text", x: 2, y: 31, text: sub, size: 10, color: FB_COLOR.faint, align: "left" });

    // semitone lines, with landmarks labelled
    for (var s = 1; s <= span; s++) {
        var mark = !!FB_MARKS[s];
        items.push({ kind: "line", x1: xLow - 8, y1: yAt(s), x2: xHigh + 8, y2: yAt(s),
                     color: mark ? FB_COLOR.mark : FB_COLOR.tick, width: mark ? 1.2 : 0.8 });
        if (mark)
            items.push({ kind: "text", x: xLow - 14, y: yAt(s) + 3, text: String(s),
                         size: 9, color: FB_COLOR.faint, align: "right" });
    }

    // the hand's reach, as a band across the strings it stops
    if (geom.stopped) {
        var cols = [];
        for (var k = 0; k < geom.notes.length; k++)
            if (geom.notes[k].offset > 0) cols.push(xAt(geom.notes[k].string));
        var xa = Math.min.apply(null, cols) - 13, xb = Math.max.apply(null, cols) + 13;
        var ya = yAt(geom.position), yb = yAt(Math.min(span, geom.position + geom.reach));
        items.push({ kind: "rect", x: xa, y: ya - 5, w: xb - xa, h: (yb - ya) + 10,
                     fill: FB_COLOR.reach, opacity: 0.13 });
    }

    // strings (lower strings drawn heavier), their names, and the nut
    for (var i = 0; i < n; i++) {
        items.push({ kind: "line", x1: xAt(i), y1: top, x2: xAt(i), y2: top + bh,
                     color: FB_COLOR.string, width: 1 + 0.45 * i });
        items.push({ kind: "text", x: xAt(i), y: top - 38, text: geom.stringNames[i],
                     size: 11, color: FB_COLOR.text, bold: true, align: "center" });
        items.push({ kind: "text", x: xAt(i), y: top - 25, text: FB_ROMAN[i] || "",
                     size: 9, color: FB_COLOR.faint, align: "center" });
    }
    items.push({ kind: "line", x1: xLow - 8, y1: top, x2: xHigh + 8, y2: top,
                 color: FB_COLOR.nut, width: 3 });

    // the chord: open strings above the nut, stops on the board
    for (var j = 0; j < geom.notes.length; j++) {
        var nt = geom.notes[j], x = xAt(nt.string);
        if (nt.offset === 0) {
            items.push({ kind: "circle", x: x, y: top - 9, r: 5.5,
                         stroke: FB_COLOR.open, width: 2.2 });
        } else {
            var y = yAt(nt.offset);
            items.push({ kind: "circle", x: x, y: y, r: 7, fill: FB_COLOR.stopped });
            items.push({ kind: "text", x: x + 11, y: y + 4, text: nt.name,
                         size: 10, color: FB_COLOR.text, bold: true, align: "left" });
        }
    }
    return items;
}
