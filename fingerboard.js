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

// Size policy: the diagram is only as wide as it needs to be — strings at most
// FB_MAX_GAP apart, centred — and only as tall as reads well, so it never stretches
// to fill a big panel and never forces the panel to grow. Below the minimum size it
// draws nothing rather than overflow.
var FB_MAX_GAP = 40;
var FB_MAX_HEIGHT = 420;

function layoutFingerboard(geom, w, h) {
    var items = [];
    if (!geom || !geom.strings || w < 70 || h < 80) return items;
    if (geom.kind === "harmonic") return layoutHarmonic(geom, w, h);

    var n = geom.strings.length;
    // in a short panel the string names above the nut would eat the board: drop them
    var tiny = h < 170;
    var left = 26, right = 34, top = tiny ? 14 : 44, bottom = 10;
    var avail = w - left - right;
    var gap = n > 1 ? Math.min(FB_MAX_GAP, avail / (n - 1)) : 0;
    var x0 = left + Math.max(0, (avail - gap * (n - 1)) / 2);      // centred
    var bh = Math.min(h, FB_MAX_HEIGHT) - top - bottom;
    var span = fingerboardSpan(geom);
    var norm = 1 - Math.pow(2, -span / 12);

    function yAt(semi) { return top + bh * (1 - Math.pow(2, -semi / 12)) / norm; }
    function xAt(stringIdx) { return x0 + gap * (n - 1 - stringIdx); }   // string I rightmost
    var xLow = xAt(n - 1), xHigh = xAt(0);
    // In a narrow panel the dots shrink with the string gap, and a note's name is only
    // drawn when it fits before the next string. The panel shows its Selected line only
    // when the names are not drawn, so a "meta" item (never painted) reports which.
    var dotR = Math.max(3.5, Math.min(7, gap * 0.28));
    var showNames = n === 1 || gap >= 2 * dotR + 24;
    items.push({ kind: "meta", namesShown: showNames });

    // semitone lines, with landmarks labelled — skipping a label that would crowd the one
    // above it, as happens when the panel is short
    var lastLabelY = -99;
    for (var s = 1; s <= span; s++) {
        var mark = !!FB_MARKS[s];
        items.push({ kind: "line", x1: xLow - 8, y1: yAt(s), x2: xHigh + 8, y2: yAt(s),
                     color: mark ? FB_COLOR.mark : FB_COLOR.tick, width: mark ? 1.2 : 0.8 });
        if (mark && yAt(s) - lastLabelY >= 12) {
            items.push({ kind: "text", x: xLow - 14, y: yAt(s) + 3, text: String(s),
                         size: 9, color: FB_COLOR.faint, align: "right" });
            lastLabelY = yAt(s);
        }
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
        if (!tiny) {
            items.push({ kind: "text", x: xAt(i), y: top - 31, text: geom.stringNames[i],
                         size: 11, color: FB_COLOR.text, bold: true, align: "center" });
            items.push({ kind: "text", x: xAt(i), y: top - 19, text: FB_ROMAN[i] || "",
                         size: 9, color: FB_COLOR.faint, align: "center" });
        } else {
            items.push({ kind: "text", x: xAt(i), y: top - 3, text: geom.stringNames[i],
                         size: 9, color: FB_COLOR.text, bold: true, align: "center" });
        }
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
            items.push({ kind: "circle", x: x, y: y, r: dotR, fill: FB_COLOR.stopped });
            if (showNames)
                items.push({ kind: "text", x: x + dotR + 4, y: y + 4, text: nt.name,
                             size: 10, color: FB_COLOR.text, bold: true, align: "left" });
        }
    }
    return items;
}


// Natural harmonic: every string it can be played on, each drawn at its FULL length from
// the nut (top) to the bridge (bottom) on a linear scale, so a node's place shows how the
// string divides — a node at 1/3 leaves a third above it and two thirds below. Strings
// that cannot give the note are drawn faint. Each node is a hollow ring labelled with the
// touched note; its fraction is written on the left; the sounding note sits under the
// bridge. A 2/5 node (solo and chamber only) is drawn grey. Several notes of a chord are
// drawn together; a string used by more than one note lists every sounding note.
var FB_HARM = { ring: "#1f1f1f", solo: "#9a9a9a", faintString: "#d0d0d0", bridge: "#2b2b2b" };

function layoutHarmonic(geom, w, h) {
    var items = [];
    var n = geom.strings.length;
    var anySolo = false;
    for (var a0 = 0; a0 < geom.notes.length; a0++)
        for (var b0 = 0; b0 < geom.notes[a0].options.length; b0++)
            for (var c0 = 0; c0 < geom.notes[a0].options[b0].nodes.length; c0++)
                if (geom.notes[a0].options[b0].nodes[c0].solo) anySolo = true;
    // same frame and string spacing as the chord fingerboard above, so the two diagrams
    // look alike; "nut" / "bridge" sit at the left edge instead of beside the strings.
    var tiny = h < 170;
    var left = 26, right = 34, top = tiny ? 14 : 44, bottom = tiny ? 18 : (anySolo ? 46 : 32);
    var avail = w - left - right;
    var gap = n > 1 ? Math.min(FB_MAX_GAP, avail / (n - 1)) : 0;
    var x0 = left + Math.max(0, (avail - gap * (n - 1)) / 2);
    var bh = Math.min(h, FB_MAX_HEIGHT) - top - bottom;
    function xAt(i) { return x0 + gap * (n - 1 - i); }
    function yAt(frac) { return top + bh * frac; }
    var xLow = xAt(n - 1), xHigh = xAt(0);
    var r = Math.max(3.5, Math.min(6, gap * 0.28));
    var showNames = gap >= 2 * r + 20;
    items.push({ kind: "meta", namesShown: showNames });

    // what each string carries
    var used = {}, fracs = {};
    for (var a = 0; a < geom.notes.length; a++)
        for (var b = 0; b < geom.notes[a].options.length; b++) {
            var o = geom.notes[a].options[b];
            (used[o.string] || (used[o.string] = [])).push(o);
            for (var c = 0; c < o.nodes.length; c++)
                fracs[o.nodes[c].num + "/" + o.nodes[c].den] = o.nodes[c].num / o.nodes[c].den;
        }

    // the used fractions: a faint line across and the fraction on the left
    var keys = Object.keys(fracs).sort(function (p, q) { return fracs[p] - fracs[q]; });
    var fracSize = bh < 140 ? 8 : 9, fracGap = bh < 140 ? 8 : 12;   // a short board still names its nodes
    var lastY = -99;
    for (var k = 0; k < keys.length; k++) {
        var y = yAt(fracs[keys[k]]);
        items.push({ kind: "line", x1: xLow - 8, y1: y, x2: xHigh + 8, y2: y, color: FB_COLOR.tick, width: 1 });
        if (y - lastY >= fracGap) {
            items.push({ kind: "text", x: xLow - 14, y: y + 3, text: keys[k], size: fracSize,
                         color: FB_COLOR.faint, align: "right" });
            lastY = y;
        }
    }

    // strings, names, nut and bridge
    for (var i = 0; i < n; i++) {
        var on = !!used[i];
        items.push({ kind: "line", x1: xAt(i), y1: top, x2: xAt(i), y2: top + bh,
                     color: on ? FB_COLOR.string : FB_HARM.faintString, width: 1 + 0.45 * i });
        if (!tiny) {
            items.push({ kind: "text", x: xAt(i), y: top - 31, text: geom.stringNames[i],
                         size: 11, color: on ? FB_COLOR.text : FB_COLOR.faint, bold: on, align: "center" });
            items.push({ kind: "text", x: xAt(i), y: top - 19, text: FB_ROMAN[i] || "",
                         size: 9, color: FB_COLOR.faint, align: "center" });
        } else {
            items.push({ kind: "text", x: xAt(i), y: top - 3, text: geom.stringNames[i],
                         size: 9, color: on ? FB_COLOR.text : FB_COLOR.faint, bold: on, align: "center" });
        }
    }
    items.push({ kind: "line", x1: xLow - 8, y1: top, x2: xHigh + 8, y2: top, color: FB_COLOR.nut, width: 3 });
    items.push({ kind: "line", x1: xLow - 8, y1: top + bh, x2: xHigh + 8, y2: top + bh,
                 color: FB_HARM.bridge, width: 2 });
    items.push({ kind: "text", x: 2, y: top - 4, text: "nut", size: 9, color: FB_COLOR.faint, align: "left" });
    items.push({ kind: "text", x: 2, y: top + bh + 11, text: "bridge", size: 9, color: FB_COLOR.faint, align: "left" });

    // nodes and sounding notes
    for (var s in used) {
        var si = parseInt(s, 10), x = xAt(si), sounds = [];
        for (var u0 = 0; u0 < used[s].length; u0++)
            if (sounds.indexOf(used[s][u0].soundsName) < 0) sounds.push(used[s][u0].soundsName);
        var several = sounds.length > 1;            // name each node's sound when a string gives two
        sounds = [];
        for (var u = 0; u < used[s].length; u++) {
            var opt = used[s][u];
            if (sounds.indexOf(opt.soundsName) < 0) sounds.push(opt.soundsName);
            for (var v = 0; v < opt.nodes.length; v++) {
                var nd = opt.nodes[v], ny = yAt(nd.num / nd.den);
                var col = nd.solo ? FB_HARM.solo : FB_HARM.ring;
                items.push({ kind: "circle", x: x, y: ny, r: r + 1.5, fill: "#ffffff" });
                items.push({ kind: "circle", x: x, y: ny, r: r, stroke: col, width: 2 });
                if (showNames) {
                    var label = nd.name + (nd.solo ? "*" : "");
                    var longer = label + " → " + opt.soundsName;
                    // ~6.2 px per bold 10 px character; the label must end before the next string's ring
                    if (several && longer.length * 6.2 <= gap - 2 * r - 10) label = longer;
                    var room = w - (x + r + 4);
                    if (label.length * 6.2 <= room)
                        items.push({ kind: "text", x: x + r + 4, y: ny + 4, text: label,
                                     size: 10, color: col, bold: true, align: "left" });
                    else
                        items.push({ kind: "text", x: x - r - 4, y: ny + 4, text: label,
                                     size: 10, color: col, bold: true, align: "right" });
                }
            }
        }
        for (var t = 0; t < sounds.length; t++)
            items.push({ kind: "text", x: x, y: top + bh + (tiny ? 13 : 24) + 12 * t, text: sounds[t],
                         size: 10, color: FB_COLOR.text, bold: true, align: "center" });
    }
    if (anySolo)
        items.push({ kind: "text", x: 2, y: top + bh + 42, text: "* solo and chamber only",
                     size: 9, color: FB_HARM.solo, align: "left" });
    return items;
}
