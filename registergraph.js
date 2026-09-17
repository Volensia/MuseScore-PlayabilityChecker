// W1 — register graph for wind instruments.
//
// When the selection holds wind notes, the panel shows the WHOLE bars of the selection,
// every voice, as a pitch-over-time graph, one instrument at a time:
//   - y axis: the instrument's whole sounding range (sourcebook T1, else MuseScore's);
//   - tinted stripes: its registers with the source's words (T2);
//   - a thin strip beside the axis: Blatter's dynamic curve (T19), wide = strong and
//     hard to play softly, narrow = weak and easily covered;
//   - each note a flat step as long as the note; a vertical line joins two notes only
//     when a slur holds both; the selected notes are red over a faint column.
// Staves of the same instrument share one graph. All pitches are SOUNDING: a note's
// pitch in the plugin API is already concert pitch, and winds.js is generated in
// sounding pitch (data/export_winds.py).
//
// rgModel() reads the score; rgLayout() turns one graph into a DISPLAY LIST of
// horizontal/vertical lines, boxes and text (the panel draws it with plain Rectangles —
// see fingerboard.js for why not a Canvas; proto/render_displaylist.py draws the same
// list to a PNG for tests). Names are prefixed: the bundler pastes every module into one
// function scope.
.pragma library
.import "winds.js" as W
.import "analyse.js" as A

var RG_MAX_BARS = 16;

// The key a part's name gives, as "Bb", "Eb", "F#", "C" …, or "" ("Clarinet 2" has none).
function rgNameKey(name) {
    var m = /(?:^|\s)([A-G])(♭|b|♯|#)?(?=\s|$)/.exec(String(name || ""));
    if (!m) return "";
    return m[1] + (m[2] === "♭" || m[2] === "b" ? "b" : m[2] ? "#" : "");
}

// instrumentId (MusicXML id) + the part's name -> our instrument id, or "".
function rgResolve(mxId, name) {
    var e = mxId && W.WIND_IDS.hasOwnProperty(mxId) ? W.WIND_IDS[mxId] : null;
    if (!e) return "";
    var key = e.anyKey ? "" : rgNameKey(name);
    if (!key) return e.variants[0][1];
    for (var i = 0; i < e.variants.length; i++) if (e.variants[i][0] === key) return e.variants[i][1];
    return "";
}

function rgWind(id) {
    return (id && W.WIND_DATA.hasOwnProperty(id)) ? W.WIND_DATA[id] : null;
}

// Is this staff a wind we can draw at `tick`? Returns the instrument entry
// ({ tick, instr, id, name }) or null.
function rgWindAt(score, env, st, part, tick) {
    var list = A.instrumentsOf(score, env, st, part, null);
    var at = null;
    for (var i = 0; i < list.length; i++) {
        if (list[i].tick <= tick) at = list[i]; else break;
    }
    if (!at) return null;
    var id = rgResolve(at.id, at.name);
    return id ? { tick: at.tick, id: id, name: at.name } : null;
}

// Staves that are a known wind anywhere (the copy reader scans their slurs too).
function rgWindStaves(score, env) {
    var out = [], staves = A.staffInstruments(score);
    for (var st = 0; st < score.nstaves; st++) {
        if (!staves[st]) continue;
        var list = A.instrumentsOf(score, env, st, staves[st].part, null);
        for (var i = 0; i < list.length; i++) if (rgResolve(list[i].id, list[i].name)) { out.push(st); break; }
    }
    return out;
}

// The notes behind the selection: [{ track, tick, end, pitch }] (grace notes skipped).
function rgSelectedNotes(score, env) {
    var els = null, out = [];
    try { els = score.selection.elements } catch (e) { return out; }
    if (!els) return out;
    for (var i = 0; i < els.length; i++) {
        var n = els[i];
        if (n.type !== env.NOTE) continue;
        var ch = null, seg = null, tick = -1, len = 0, trk = -1;
        try { ch = n.parent } catch (e1) {}
        if (!ch || ch.type !== env.CHORD) continue;
        try { seg = ch.parent } catch (e2) {}
        if (!seg || seg.type === env.CHORD) continue;       // a grace note
        try { tick = seg.tick } catch (e3) {}
        try { len = ch.actualDuration.ticks } catch (e4) {}
        try { trk = n.track } catch (e5) {}
        if (tick < 0 || trk < 0) continue;
        out.push({ track: trk, tick: tick, end: tick + len, pitch: n.pitch });
    }
    return out;
}

function rgStripNumber(name) {
    return String(name || "").replace(/\s*(\d+|[IVX]+)\.?\s*$/, "").replace(/\s+$/, "");
}

function rgInSlur(slurs, tick) {
    if (!slurs) return -1;
    for (var i = 0; i < slurs.length; i++)
        if (slurs[i].from <= tick && tick <= slurs[i].to) return i;
    return -1;
}

// Build the model for the current selection, or null when it holds no wind notes.
//   bowing : the copy reader's maps (slurs per track), may be null
//   ranges : A.parseRanges output (MuseScore's own ranges), may be null
function rgModel(score, env, bowing, ranges) {
    var sel = rgSelectedNotes(score, env);
    if (!sel.length) return null;
    var staves = A.staffInstruments(score);
    var windSel = [], from = -1, to = -1, selStaves = {};
    for (var i = 0; i < sel.length; i++) {
        var st = sel[i].track >> 2;
        if (!staves[st] || !rgWindAt(score, env, st, staves[st].part, sel[i].tick)) continue;
        windSel.push(sel[i]);
        selStaves[st] = true;
        if (from < 0 || sel[i].tick < from) from = sel[i].tick;
        if (sel[i].end > to) to = sel[i].end;
    }
    // a range selection also names wind staves that have no note selected in them
    try {
        if (score.selection.isRange) {
            var s0 = score.selection.startStaff, s1 = score.selection.endStaff;
            for (var sx = s0; sx < s1; sx++)
                if (staves[sx] && from >= 0 && rgWindAt(score, env, sx, staves[sx].part, from)) selStaves[sx] = true;
        }
    } catch (e) {}
    if (!windSel.length) return null;

    // whole bars
    var starts = A.barMap(score), endTick = -1;
    try { endTick = score.lastSegment.tick } catch (e2) {}
    var b0 = 0, b1 = 0;
    for (var b = 0; b < starts.length; b++) {
        if (starts[b] <= from) b0 = b;
        if (starts[b] < to) b1 = b;
    }
    var clipped = false;
    if (b1 - b0 + 1 > RG_MAX_BARS) { b1 = b0 + RG_MAX_BARS - 1; clipped = true; }
    var tFrom = starts[b0];
    var tTo = b1 + 1 < starts.length ? starts[b1 + 1] : Math.max(endTick, to);
    var bars = [];
    for (var bb = b0; bb <= b1; bb++) bars.push({ number: bb + 1, tick: starts[bb] });

    var selKey = {};
    for (var k = 0; k < windSel.length; k++)
        selKey[windSel[k].track + "|" + windSel[k].tick + "|" + windSel[k].pitch] = true;

    // one graph per instrument id, in score order
    var graphs = [], byId = {};
    for (var sti = 0; sti < score.nstaves; sti++) {
        if (!selStaves[sti]) continue;
        var ins = rgWindAt(score, env, sti, staves[sti].part, from);
        if (!ins) continue;
        var g = byId[ins.id];
        if (!g) {
            g = { id: ins.id, data: rgWind(ins.id), staves: [], names: [], shorts: [], notes: [], hasSel: false, lo: 999, hi: -1, msRange: null };
            byId[ins.id] = g;
            graphs.push(g);
        }
        g.staves.push(sti);
        g.names.push(staves[sti].name);
        g.shorts.push(staves[sti].short);
        if (!g.msRange && ranges) {
            var r = A.rangeAt(ranges, A.instrumentsOf(score, env, sti, staves[sti].part, null), sti, from);
            if (r) g.msRange = [r.minP, r.maxP];
        }
        for (var v = 0; v < 4; v++) {
            var trk = sti * 4 + v, slurs = bowing && bowing.slurs ? bowing.slurs[trk] : null;
            var cur = score.newCursor();
            cur.staffIdx = sti; cur.voice = v;
            A.seek(cur, tFrom);
            while (cur.segment && cur.tick < tTo) {
                var el = cur.element;
                if (el && el.type === env.CHORD && cur.tick >= tFrom) {
                    var len = 0;
                    try { len = el.actualDuration.ticks } catch (e3) {}
                    var slur = rgInSlur(slurs, cur.tick);
                    for (var n = 0; n < el.notes.length; n++) {
                        var p = el.notes[n].pitch;
                        var isSel = !!selKey[trk + "|" + cur.tick + "|" + p];
                        g.notes.push({ p: p, s: cur.tick, l: len, v: trk, slur: slur, sel: isSel });
                        if (isSel) g.hasSel = true;
                        if (p < g.lo) g.lo = p;
                        if (p > g.hi) g.hi = p;
                    }
                }
                cur.next();
            }
        }
    }
    if (!graphs.length) return null;

    var first = 0;
    for (var gi = 0; gi < graphs.length; gi++) {
        var G = graphs[gi];
        G.chip = rgChipLabel(G.shorts);
        G.title = rgTitle(G.names);
        rgResolveAxis(G);
        if (G.hasSel && !graphs[first].hasSel) first = gi;
    }
    return { from: tFrom, to: tTo, bars: bars, clipped: clipped, selFrom: from, selTo: to,
             graphs: graphs, first: first, key: rgModelKey(graphs, tFrom, tTo, from, to) };
}

// A cheap identity, so the panel keeps the instrument you were looking at when the
// same graphs come back after an edit.
function rgModelKey(graphs, a, b, c, d) {
    var ids = [];
    for (var i = 0; i < graphs.length; i++) ids.push(graphs[i].id);
    return ids.join(",") + "|" + a + "|" + b;
}

function rgChipLabel(shorts) {
    var base = rgStripNumber(shorts[0]) || shorts[0] || "?";
    return shorts.length > 1 ? base + " ×" + shorts.length : shorts[0];
}

function rgTitle(names) {
    if (names.length === 1) return names[0];
    var base = rgStripNumber(names[0]), same = true;
    for (var i = 1; i < names.length; i++) if (rgStripNumber(names[i]) !== base) same = false;
    if (!same) return names.join(", ");
    var nums = [];
    for (var j = 0; j < names.length; j++) {
        var m = /(\d+|[IVX]+)\.?\s*$/.exec(names[j]);
        nums.push(m ? m[1] : String(j + 1));
    }
    return base + " " + nums.join(", ");
}

// The axis: the instrument's range (T1, else MuseScore's), stretched to hold every note
// drawn and the whole dynamic curve's reach inside that range. Stripes' "(bottom)" and
// "(top)" become the axis ends.
function rgResolveAxis(G) {
    var d = G.data, lo, hi, src;
    if (d.range) { lo = d.range[0]; hi = d.range[1]; src = "sourcebook"; }
    else if (G.msRange) { lo = G.msRange[0]; hi = G.msRange[1]; src = "MuseScore"; }
    else { lo = G.lo - 2; hi = G.hi + 2; src = "notes"; }
    if (G.hi >= 0) { lo = Math.min(lo, G.lo); hi = Math.max(hi, G.hi); }
    G.axis = { lo: lo, hi: hi, src: src };
    G.bands = [];
    if (d.bands)
        for (var i = 0; i < d.bands.length; i++) {
            var a = d.bands[i][0], b = d.bands[i][1];
            if (a === "(bottom)") a = lo;
            if (b === "(top)") b = hi;
            G.bands.push([Math.max(a, lo), Math.min(b, hi), d.bands[i][2]]);
        }
}

// Width of a curve at pitch p (piecewise linear), or -1 outside it.
function rgCurveAt(curve, p) {
    if (!curve || !curve.length || p < curve[0][0] || p > curve[curve.length - 1][0]) return -1;
    for (var i = 1; i < curve.length; i++) {
        var a = curve[i - 1], b = curve[i];
        if (p <= b[0]) return b[0] === a[0] ? b[1] : a[1] + (b[1] - a[1]) * (p - a[0]) / (b[0] - a[0]);
    }
    return curve[curve.length - 1][1];
}

var RG_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
function rgName(p) { return RG_NAMES[((p % 12) + 12) % 12] + (Math.floor(p / 12) - 1); }

var RG_COLOR = {
    band: ["#e2e5f7", "#cfd5f3", "#bcc4ee", "#a9b3e9"],
    label: "#222222", faint: "#777777", frame: "#c4c4c4", note: "#222222",
    sel: "#d0432b", selCol: "#d0432b", curve: "#a3a3a3", bar: "#9a9a9a"
};

// Rough text width (the panel's sans-serif is about 0.56 em per character on average).
function rgTextWidth(text, size) { return String(text).length * size * 0.56; }
function rgFit(text, size, room) {
    text = String(text);
    if (rgTextWidth(text, size) <= room) return text;
    var n = Math.max(1, Math.floor(room / (size * 0.56)) - 1);
    return n >= text.length ? text : text.substring(0, n).replace(/[\s,;.]+$/, "") + "…";
}

// One graph -> display list. w, h: the area the panel gives it (below the chip strip).
function rgLayout(model, gi, w, h) {
    var items = [];
    if (!model || gi < 0 || gi >= model.graphs.length || w < 90 || h < 44) return items;
    var G = model.graphs[gi], d = G.data;
    // a narrow panel gets a narrower axis gutter and smaller note names
    var tight = w < 230;
    var maxHalf = tight ? 6 : 9;                       // half the widest point of the dynamic strip
    var DX = tight ? 28 : 46, X0 = DX + maxHalf + 7, X1 = w - 6;
    var nameRight = DX - maxHalf - 4;                  // note names end clear of the strip
    var nameSize = tight ? 8 : 9;
    var squat = h < 150;                      // a short panel: no room for a title line
    var top = squat ? 4 : 20, bottom = h - (squat ? 12 : 18);
    var lo = G.axis.lo, hi = G.axis.hi, step = (bottom - top) / (hi - lo + 1);
    function y(p) { return bottom - (p - lo + 0.5) * step; }
    function yTop(p) { return bottom - (p - lo + 1) * step; }
    function yBot(p) { return bottom - (p - lo) * step; }
    var span = Math.max(1, model.to - model.from);
    function xt(t) { return X0 + (X1 - X0) * (t - model.from) / span; }

    // title and what is not yet confirmed
    if (!squat)
        items.push({ kind: "text", x: X0, y: 12, text: rgFit(G.title, 11, X1 - X0), size: 11, bold: true, color: RG_COLOR.label, align: "left" });

    // stripes, their first notes on the left, their words on the right
    var lastLabel = 1e9;
    for (var i = 0; i < G.bands.length; i++) {
        var bd = G.bands[i], y1 = yTop(bd[1]), y2 = yBot(bd[0]);
        if (bd[1] < bd[0]) continue;
        items.push({ kind: "rect", x: X0, y: y1, w: X1 - X0, h: y2 - y1, fill: RG_COLOR.band[i % 4] });
        if (X1 - X0 - 8 >= 40)      // no room for words in a very narrow panel
            items.push({ kind: "text", x: X1 - 4, y: y1 + 11, text: rgFit(bd[2], 9, X1 - X0 - 8), size: 9, color: RG_COLOR.label, align: "right", halo: RG_COLOR.band[i % 4] });
        if (lastLabel - y2 >= 10) {
            items.push({ kind: "text", x: nameRight, y: y2 - 1, text: rgName(bd[0]), size: nameSize, color: RG_COLOR.faint, align: "right" });
            lastLabel = y2;
        }
    }
    if (!G.bands.length)
        items.push({ kind: "text", x: (X0 + X1) / 2, y: top + 16, text: "No register descriptions in any source", size: 9, color: RG_COLOR.faint, align: "center" });
    if (!G.bands.length || G.bands[0][0] > lo)
        items.push({ kind: "text", x: nameRight, y: bottom - 1, text: rgName(lo), size: nameSize, color: RG_COLOR.faint, align: "right" });
    items.push({ kind: "text", x: nameRight, y: top + 8, text: rgName(hi), size: nameSize, color: RG_COLOR.faint, align: "right" });

    // dynamic curve, centred on DX: thin horizontal slices, so the shape reads as a smooth
    // ribbon rather than one step per semitone (only rectangles can be drawn, see the header).
    // The widths are stretched over this instrument's own narrowest and widest point, so the
    // shape is visible; Blatter draws one curve per family and the widths mean nothing between
    // instruments anyway.
    var SLICE = 2, MIN_HALF = 1.5;
    function pitchAtY(yy) { return lo - 0.5 + (bottom - yy) / step; }
    function curveSpan(curve) {
        var mn = 9, mx = 0;
        for (var i = 0; i < curve.length; i++) {
            if (curve[i][1] < mn) mn = curve[i][1];
            if (curve[i][1] > mx) mx = curve[i][1];
        }
        return [mn, mx];
    }
    function strip(curve, span) {
        for (var yy = top; yy < bottom; yy += SLICE) {
            var wv = rgCurveAt(curve, pitchAtY(yy + SLICE / 2));
            if (wv < 0) continue;
            var t = span[1] > span[0] ? (wv - span[0]) / (span[1] - span[0]) : 1;
            var half = MIN_HALF + t * (maxHalf - MIN_HALF);
            // y on whole pixels with a 1 px overlap (a fractional gap between slices paints a
            // dark seam); the width stays fractional and is drawn antialiased, so the edge of the
            // ribbon is smooth instead of a staircase.
            items.push({ kind: "rect", x: DX - half, y: Math.round(yy), w: 2 * half, h: SLICE + 1,
                         fill: RG_COLOR.curve, smooth: true });
        }
    }
    if (d.curve) {
        var cspan = curveSpan(d.pedal ? d.curve.concat(d.pedal) : d.curve);
        strip(d.curve, cspan);
        if (d.pedal) strip(d.pedal, cspan);
    }
    items.push({ kind: "text", x: DX, y: bottom + 13, text: d.curve ? "dyn." : "", size: 8, color: RG_COLOR.faint, align: "center" });

    // selection column
    if (G.hasSel || model.selFrom >= 0)
        items.push({ kind: "rect", x: xt(model.selFrom), y: top, w: Math.max(2, xt(model.selTo) - xt(model.selFrom)), h: bottom - top,
                     fill: RG_COLOR.selCol, opacity: 0.1 });

    // bar lines and numbers
    for (var b = 0; b < model.bars.length; b++) {
        var bx = xt(model.bars[b].tick);
        if (b > 0) items.push({ kind: "line", x1: bx, y1: top, x2: bx, y2: bottom, color: RG_COLOR.bar, width: 1, opacity: 0.6 });
        items.push({ kind: "text", x: bx + 2, y: bottom + 13, text: String(model.bars[b].number), size: 9, color: RG_COLOR.faint, align: "left" });
    }
    if (model.clipped)
        items.push({ kind: "text", x: X1, y: bottom + 13, text: "first " + model.bars.length + " bars", size: 9, color: RG_COLOR.faint, align: "right" });

    // frame
    items.push({ kind: "line", x1: X0, y1: top, x2: X1, y2: top, color: RG_COLOR.frame, width: 1 });
    items.push({ kind: "line", x1: X0, y1: bottom, x2: X1, y2: bottom, color: RG_COLOR.frame, width: 1 });
    items.push({ kind: "line", x1: X0, y1: top, x2: X0, y2: bottom, color: RG_COLOR.frame, width: 1 });
    items.push({ kind: "line", x1: X1, y1: top, x2: X1, y2: bottom, color: RG_COLOR.frame, width: 1 });

    // slur joins: within one voice and one slur, chord to next chord, notes joined by rank
    var groups = {};
    for (var k = 0; k < G.notes.length; k++) {
        var nt = G.notes[k];
        if (nt.slur < 0) continue;
        var key = nt.v + "/" + nt.slur;
        var gs = groups[key] || (groups[key] = {});
        (gs[nt.s] || (gs[nt.s] = [])).push(nt);
    }
    for (var gk in groups) {
        var gg = groups[gk], ts = Object.keys(gg).map(Number).sort(function (a, b2) { return a - b2; });
        for (var t = 1; t < ts.length; t++) {
            var A1 = gg[ts[t - 1]].slice().sort(function (a, b2) { return b2.p - a.p; });
            var B1 = gg[ts[t]].slice().sort(function (a, b2) { return b2.p - a.p; });
            var n = Math.max(A1.length, B1.length);
            for (var r = 0; r < n; r++) {
                var a1 = A1[Math.min(r, A1.length - 1)], c1 = B1[Math.min(r, B1.length - 1)];
                if (a1.p === c1.p) continue;
                var jx = xt(c1.s), bothSel = a1.sel && c1.sel;
                items.push({ kind: "line", x1: jx, y1: y(a1.p), x2: jx, y2: y(c1.p),
                             color: bothSel ? RG_COLOR.sel : RG_COLOR.note, width: bothSel ? 3 : 1.5 });
            }
        }
    }
    // notes
    for (var q = 0; q < G.notes.length; q++) {
        var no = G.notes[q], loose = no.slur < 0;
        var xa = xt(no.s) + (loose ? 1 : 0), xb = xt(no.s + no.l) - (loose ? 2 : 0);
        if (xb <= xa) xb = xa + 1;
        items.push({ kind: "line", x1: xa, y1: y(no.p), x2: xb, y2: y(no.p),
                     color: no.sel ? RG_COLOR.sel : RG_COLOR.note, width: no.sel ? 3 : 2 });
    }
    return items;
}
