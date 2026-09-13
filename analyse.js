// Score walking for the Orchestration Checker plugin (S1 open strings, S2 stops).
// Kept free of QML types: the caller passes the enum values it needs in `env`.
//
// Marking policy: a playable chord is left black except for notes that sit on an
// open string (teal); a chord that cannot be played is coloured red throughout,
// one that only fits with a stretch dark yellow throughout.
//
// Writes come in two flavours. `command: true` wraps them in startCmd/endCmd, so
// they are one undo step and belong to the file. `command: false` writes straight
// to the elements: the change still renders but never touches the undo stack,
// which is what live mode needs (see SPEC-strings.md, "Live mode").
//
// Live mode also passes a tick range, so a pass costs the edited bars rather than
// the whole score: the cursor seeks with rewindToTick(), and each staff's
// div./unis. map is cached between passes and only rebuilt when a div-ish text
// turns up inside the edited range.
.pragma library
.import "strings.js" as S
.import "harmonics.js" as H

function barMap(score) {
    var starts = [], m = score.firstMeasure;
    while (m) { starts.push(m.firstSegment.tick); m = m.nextMeasure; }
    return starts;
}

function barOf(starts, tick) {
    var bar = 1;
    for (var i = 0; i < starts.length; i++) {
        if (starts[i] <= tick) bar = i + 1; else break;
    }
    return bar;
}

// staffIdx -> { part, name }. The instrument itself is resolved per tick, since a
// staff can change instrument part-way through (see "instrument changes" below).
function staffInstruments(score) {
    var map = [];
    for (var p = 0; p < score.parts.length; p++) {
        var part = score.parts[p];
        var ln = "";
        try { ln = part.longName || part.partName || "" } catch (e) {}
        var first = part.startTrack >> 2, last = part.endTrack >> 2;
        for (var s = first; s < last; s++)
            map[s] = { part: part, name: ln || ("staff " + (s + 1)) };
    }
    return map;
}

// --- cursor helpers ------------------------------------------------------
// rewindToTick lands on the segment at or after `tick`; fall back to a walk if
// the score has nothing there for this voice.
function seek(cur, tick) {
    if (tick <= 0) { cur.rewind(0); return; }
    try {
        cur.rewindToTick(tick);
        if (cur.segment) return;
    } catch (e) {}
    cur.rewind(0);
    while (cur.segment && cur.tick < tick) cur.next();
}

// --- div./unis. ----------------------------------------------------------
var _divCache = {};        // "scoreName|staffIdx" -> [{tick, on}]

function invalidateDivCache() { _divCache = {}; }

function scanDiv(score, staffIdx) {
    var cur = score.newCursor();
    cur.staffIdx = staffIdx; cur.voice = 0; cur.rewind(0);
    var changes = [];
    while (cur.segment) {
        var ann = cur.segment.annotations;
        if (ann)
            for (var a = 0; a < ann.length; a++) {
                var el = ann[a], tr = -1, txt = "";
                try { tr = el.track } catch (e) {}
                if ((tr >> 2) !== staffIdx) continue;      // annotations list covers every staff
                try { txt = el.text || "" } catch (e) {}
                if (!txt) continue;
                var st = S.divState(String(txt).replace(/<[^>]*>/g, ""));
                if (st !== null) changes.push({ tick: cur.tick, on: st });
            }
        cur.next();
    }
    return changes;
}

// Is there a div./unis. text inside this tick range? (cheap, ranged)
function divTextInRange(score, staffIdx, from, to) {
    var cur = score.newCursor();
    cur.staffIdx = staffIdx; cur.voice = 0;
    seek(cur, from);
    while (cur.segment && cur.tick <= to) {
        var ann = cur.segment.annotations;
        if (ann)
            for (var a = 0; a < ann.length; a++) {
                var el = ann[a], tr = -1, txt = "";
                try { tr = el.track } catch (e) {}
                if ((tr >> 2) !== staffIdx) continue;
                try { txt = el.text || "" } catch (e) {}
                if (txt && S.divState(String(txt).replace(/<[^>]*>/g, "")) !== null) return true;
            }
        cur.next();
    }
    return false;
}

function divChanges(score, staffIdx, range) {
    var key = score.scoreName + "|" + staffIdx;
    var cached = _divCache[key];
    var ranged = range && range.from >= 0;
    if (cached && ranged && !divTextInRange(score, staffIdx, range.from, range.to))
        return cached;
    var fresh = scanDiv(score, staffIdx);
    _divCache[key] = fresh;
    return fresh;
}

function divAt(changes, tick) {
    var on = false;
    for (var i = 0; i < changes.length; i++) {
        if (changes[i].tick <= tick) on = changes[i].on; else break;
    }
    return on;
}

// --- instrument changes --------------------------------------------------
// A player can double: one staff starts as a violin and becomes a flute, or the
// reverse. part.instrumentAtTick() resolves the instrument at a point in time,
// and the change itself sits in segment.annotations as Element.INSTRUMENT_CHANGE.
// Both were verified on 3.6.2 against a score with a "to Flute" change: the part
// reports the violin before the change tick and the flute at and after it.
//
// Cached per staff like the div. map, and rebuilt only when an instrument change
// turns up inside the edited range.
var _instrCache = {};

function invalidateInstrCache() { _instrCache = {}; }

function annotationTypeInRange(score, staffIdx, type, from, to) {
    if (type === undefined || type === null) return false;
    var cur = score.newCursor();
    cur.staffIdx = staffIdx; cur.voice = 0;
    seek(cur, from);
    while (cur.segment && (to < 0 || cur.tick <= to)) {
        var ann = cur.segment.annotations;
        if (ann)
            for (var a = 0; a < ann.length; a++) {
                var el = ann[a], tr = -1;
                try { tr = el.track } catch (e) {}
                if ((tr >> 2) !== staffIdx) continue;
                if (el.type === type) return true;
            }
        cur.next();
    }
    return false;
}

function scanInstruments(score, env, staffIdx, part) {
    var ticks = [0], cur = score.newCursor();
    cur.staffIdx = staffIdx; cur.voice = 0; cur.rewind(0);
    while (cur.segment) {
        var ann = cur.segment.annotations;
        if (ann)
            for (var a = 0; a < ann.length; a++) {
                var el = ann[a], tr = -1;
                try { tr = el.track } catch (e) {}
                if ((tr >> 2) !== staffIdx) continue;
                if (el.type === env.INSTRUMENT_CHANGE && ticks.indexOf(cur.tick) < 0)
                    ticks.push(cur.tick);
            }
        cur.next();
    }
    var out = [];
    for (var i = 0; i < ticks.length; i++) {
        var id = "", ln = "";
        try {
            var ins = part.instrumentAtTick(ticks[i]);
            try { id = ins.instrumentId || "" } catch (e2) {}
            try { ln = ins.longName || "" } catch (e3) {}
        } catch (e) {}
        if (!id && !ln) {                       // fall back to the part's own instrument
            try { id = part.instrumentId || "" } catch (e4) {}
            try { ln = part.longName || part.partName || "" } catch (e5) {}
        }
        out.push({ tick: ticks[i], instr: S.lookup(id, ln) });
    }
    return out;
}

function instrumentsOf(score, env, staffIdx, part, range) {
    var key = score.scoreName + "|" + staffIdx;
    var cached = _instrCache[key];
    var ranged = range && range.from >= 0;
    if (cached && ranged &&
        !annotationTypeInRange(score, staffIdx, env.INSTRUMENT_CHANGE, range.from, range.to))
        return cached;
    var fresh = scanInstruments(score, env, staffIdx, part);
    _instrCache[key] = fresh;
    return fresh;
}

function instrAt(list, tick) {
    var instr = null;
    for (var i = 0; i < list.length; i++) {
        if (list[i].tick <= tick) instr = list[i].instr; else break;
    }
    return instr;
}

// --- harmonic circles ----------------------------------------------------
// A harmonic written as a circle over the sounding note is an Articulation on
// the Chord, and the Chord will not hand it over — score.selection.elements
// after a select-all is the only way to reach it (verified on 3.6.2). So the
// caller does the select-all (cmd() lives on the MuseScore object, not here),
// hands us the element list, and we return a { "track|tick": true } map.
//
// Cost on 16 staves x 300 bars: select-all 26 ms, scanning 54,638 elements
// 177 ms. Fine once per check, too slow for every live keystroke — so the
// plugins build it on full checks and reuse it for ranged passes.
// Saving and restoring the selection, measured on 3.6.2:
//   a LIST selection (what you have after typing a note, or clicking notes) is
//     fully restorable — select(el) then select(el, true) for the rest rebuilds
//     it exactly, verified by round-tripping two notes through a select-all.
//   a RANGE selection is NOT reliably restorable: startSegment and endSegment
//     read back as null, so its tick bounds often cannot be captured at all.
//   endStaff is EXCLUSIVE — one staff reads startStaff=1, endStaff=2. An earlier
//     version added 1 to it and silently widened the user's selection by a staff.
function saveSelection(score) {
    try {
        var s = score.selection, keep = { isRange: s.isRange, elements: [] };
        if (s.isRange) {
            keep.startStaff = s.startStaff;
            keep.endStaff = s.endStaff;             // already exclusive
            keep.from = -1;
            keep.to = -1;
            try { if (s.startSegment) keep.from = s.startSegment.tick } catch (e) {}
            try { if (s.endSegment) keep.to = s.endSegment.tick } catch (e2) {}
        } else {
            var els = s.elements;
            if (els) for (var i = 0; i < els.length; i++) keep.elements.push(els[i]);
        }
        return keep;
    } catch (e3) { return null; }
}

function restoreSelection(score, keep) {
    if (!keep) return;
    try {
        var s = score.selection;
        s.clear();
        if (keep.isRange) {
            if (keep.from >= 0 && keep.to >= 0)     // verbatim: endStaff is exclusive
                s.selectRange(keep.from, keep.to, keep.startStaff, keep.endStaff);
            return;
        }
        for (var i = 0; i < keep.elements.length; i++)
            s.select(keep.elements[i], i > 0);      // i > 0 adds to the selection
    } catch (e) {}
}

function buildCircleMap(elements, env) {
    var map = {};
    if (!elements) return map;
    for (var i = 0; i < elements.length; i++) {
        var el = elements[i], sym = null;
        if (el.type !== env.ARTICULATION) continue;
        try { sym = el.symbol } catch (e) {}
        if (!H.isHarmonicSymbol(sym)) continue;     // symbol is an object, not a Number
        var chord = null, seg = null, tick = -1, tr = -1;
        try { chord = el.parent } catch (e2) {}
        if (!chord) continue;
        try { seg = chord.parent } catch (e3) {}
        try { tick = seg.tick } catch (e4) {}
        try { tr = chord.track } catch (e5) {}
        if (tick >= 0 && tr >= 0) map[tr + "|" + tick] = true;
    }
    return map;
}

// --- analysis ------------------------------------------------------------
// env  : { CHORD: Element.CHORD, DIAMOND: NoteHeadGroup.HEAD_DIAMOND }
// range: optional { from, to } in ticks — live mode passes the layout range of
//        the edit so only the affected bars are re-examined.
// Returns { rows, marks, counts }. Nothing is written to the score here.
function analyse(score, env, range, circles, ranges) {
    var starts = barMap(score), staves = staffInstruments(score);
    var rows = [], marks = [], covers = [];
    var counts = { open: 0, playable: 0, outOfReach: 0, impossible: 0, div: 0,
                   harmonics: 0, harmRisky: 0, harmBad: 0, covered: 0 };
    var from = range && range.from >= 0 ? range.from : -1;
    var to   = range && range.to   >= 0 ? range.to   : -1;

    for (var st = 0; st < score.nstaves; st++) {
        var info = staves[st];
        if (!info) continue;
        var instrList = instrumentsOf(score, env, st, info.part, range);
        var anyString = false;
        for (var ai = 0; ai < instrList.length; ai++) if (instrList[ai].instr) anyString = true;
        if (!anyString) continue;               // never a bowed string staff
        var changes = divChanges(score, st, range);

        // one chord (ordinary or grace): mark it and, if it is a stop, judge it
        // graceIdx: -1 for the main chord, else its index in graceNotes. Rows carry
        // { track, tick, grace } so the panel can turn a row back into notes.
        var handle = function (chordEl, tick, graceIdx) {
            var instr = instrAt(instrList, tick);
            if (!instr) return;                 // staff is a non-string instrument here
            var trk = -1;
            try { trk = chordEl.track } catch (e0) {}
            // A note MuseScore paints in its own range colour never shows ours
            // (note.cpp:1265-1271). Flag it so applyMarks can draw a notehead over it.
            var rng = ranges ? rangeAt(ranges, instrList, st, tick) : null;
            var mark = function (noteEl, pitch, color) {
                var ms = museScoreRangeColor(rng, pitch);
                var cover = !!(ms && ms !== color);
                marks.push({ note: noteEl, color: color, cover: cover });
                if (cover) {
                    counts.covered++;
                    covers.push({ track: trk, tick: tick, grace: graceIdx, pitch: pitch, color: color });
                }
            };
            // a circle from the Articulations palette belongs to the whole chord
            var chordCircle = false;
            if (circles) {
                var ctr = -1;
                try { ctr = chordEl.track } catch (e) {}
                if (ctr >= 0 && circles[ctr + "|" + tick]) chordCircle = true;
            }

            var ns = chordEl.notes, list = [], anyD = false, anyC = chordCircle;
            for (var i = 0; i < ns.length; i++) {
                var isD = ns[i].headGroup === env.DIAMOND;
                var isC = chordCircle || H.hasCircle(ns[i]);
                if (isD) anyD = true;
                if (isC) anyC = true;
                list.push({ note: ns[i], pitch: ns[i].pitch, diamond: isD, circle: isC });
            }
            if (!list.length) return;

            // S7/S8: harmonics get their own check, and are never run through the
            // multiple-stop test — an artificial harmonic is not a double stop.
            if (anyD || anyC) {
                var h = H.classify(instr, list);
                if (h) {
                    counts.harmonics++;
                    if (h.verdict !== "ok") {
                        var hc = h.verdict === "impossible" ? S.COLOR.impossible
                                                            : S.COLOR.outOfReach;
                        if (h.verdict === "impossible") counts.harmBad++;
                        else counts.harmRisky++;
                        for (var hi = 0; hi < list.length; hi++)
                            mark(list[hi].note, list[hi].pitch, hc);
                        rows.push({ bar: barOf(starts, tick), tick: tick, staff: info.name,
                                    verdict: h.verdict, reason: h.reason, notes: h.detail,
                                    track: trk, grace: graceIdx });
                    }
                    return;
                }
            }

            if (list.length === 1) {
                if (S.openStringIndex(instr, list[0].pitch) >= 0) {
                    mark(list[0].note, list[0].pitch, S.COLOR.open);
                    counts.open++;
                }
                return;
            }
            if (divAt(changes, tick)) { counts.div++; return; }

            list.sort(function (a, b) { return b.pitch - a.pitch; });
            var pitches = [];
            for (var k = 0; k < list.length; k++) pitches.push(list[k].pitch);
            var res = S.analyseStop(instr, pitches);
            counts[res.verdict]++;

            if (res.verdict === "playable") {
                for (var j = 0; j < list.length; j++)
                    if (S.openStringIndex(instr, list[j].pitch) >= 0) {
                        mark(list[j].note, list[j].pitch, S.COLOR.open);
                        counts.open++;
                    }
            } else {
                var col = res.verdict === "impossible" ? S.COLOR.impossible : S.COLOR.outOfReach;
                for (var q = 0; q < list.length; q++)
                    mark(list[q].note, list[q].pitch, col);
                rows.push({ bar: barOf(starts, tick), tick: tick, staff: info.name,
                            verdict: res.verdict, reason: res.reason,
                            notes: S.describe(instr, pitches, res),
                            track: trk, grace: graceIdx });
            }
        };

        for (var v = 0; v < 4; v++) {
            var cur = score.newCursor();
            cur.staffIdx = st; cur.voice = v;
            seek(cur, from);
            while (cur.segment) {
                var tick = cur.tick;
                if (to >= 0 && tick > to) break;
                var el = cur.element;
                if (el && el.type === env.CHORD) {
                    var grace = null;
                    try { grace = el.graceNotes } catch (e) {}
                    if (grace)
                        for (var g = 0; g < grace.length; g++) handle(grace[g], tick, g);
                    handle(el, tick, -1);
                }
                cur.next();
            }
        }
    }
    return { rows: rows, marks: marks, counts: counts, covers: covers };
}

// --- selection sync ------------------------------------------------------
// A results row and a chord in the score name each other by { track, tick,
// grace }. Verified on 3.6.2: a note's parent is its Chord, and the Chord's
// parent is the Segment (for the tick) — except a grace chord, whose parent is
// the main Chord (is() confirms it), so the Segment is one level further up.
// A cursor with voice = track % 4 and rewindToTick lands exactly on the chord,
// voice 2 included.

function findChord(score, env, track, tick, grace) {
    if (track < 0 || tick < 0) return null;
    var cur = score.newCursor();
    cur.staffIdx = track >> 2;
    cur.voice = track % 4;
    seek(cur, tick);
    if (!cur.segment || cur.tick !== tick) return null;
    var el = cur.element;
    if (!el || el.type !== env.CHORD) return null;
    if (grace === undefined || grace < 0) return el;
    var gs = null;
    try { gs = el.graceNotes } catch (e) {}
    return gs && grace < gs.length ? gs[grace] : null;
}

// Select every note of the chord a row points at. Returns false if the chord
// has gone (edited away since the row was made).
function selectChord(score, env, row) {
    var ch = findChord(score, env, row.track, row.tick, row.grace);
    if (!ch) return false;
    var s = score.selection;
    s.clear();
    for (var i = 0; i < ch.notes.length; i++) s.select(ch.notes[i], i > 0);
    return true;
}

// The chord behind the current selection: { track, tick, grace, chord } or null.
// Uses the first selected element that is a note or a chord.
function selectedChord(score, env) {
    var els = null;
    try { els = score.selection.elements } catch (e) { return null; }
    if (!els || !els.length) return null;
    return keyOfElements(els, env);
}

// The same, for any list of elements — split out so it can be tested with
// elements the plugin API refuses to select (selection.select() returns false for
// a stem or a symbol, although a click in the score selects them fine).
function keyOfElements(els, env) {
    if (!els || !els.length) return null;
    // Walk up from whatever is selected: a note, or any part of a chord — its
    // accidental (17>20>93), stem (19>93), dot (67>20>93), or one of our overlay
    // noteheads (5>20>93). Measured on 3.6.2. The first Chord found is the one.
    var chord = null;
    for (var i = 0; i < els.length && !chord; i++) {
        var e = els[i];
        for (var depth = 0; e && depth < 4; depth++) {
            if (e.type === env.CHORD) { chord = e; break; }
            try { e = e.parent } catch (e2) { e = null; }
        }
    }
    if (!chord || chord.type !== env.CHORD) return null;

    var main = chord, grace = -1, par = null;
    try { par = chord.parent } catch (e3) {}
    if (par && par.type === env.CHORD) {            // a grace chord
        main = par;
        var gs = null;
        try { gs = main.graceNotes } catch (e4) {}
        if (gs) for (var g = 0; g < gs.length; g++) if (gs[g].is(chord)) grace = g;
    }
    var seg = null, tick = -1, trk = -1;
    try { seg = main.parent } catch (e5) {}
    try { tick = seg.tick } catch (e6) {}
    try { trk = chord.track } catch (e7) {}
    if (tick < 0 || trk < 0) return null;
    return { track: trk, tick: tick, grace: grace, chord: chord };
}

// One chord, described for the panel. Runs exactly the rules analyse() runs,
// so the readout cannot disagree with the colours on the score.
function inspectChord(score, env, key, circles) {
    if (!key || !key.chord) return "";
    var st = key.track >> 2, info = staffInstruments(score)[st];
    if (!info) return "";
    var here = { from: key.tick, to: key.tick };    // lets the per-staff caches answer
    var instr = instrAt(instrumentsOf(score, env, st, info.part, here), key.tick);
    if (!instr) return info.name + " — not a bowed string instrument here";

    var chordCircle = !!(circles && circles[key.track + "|" + key.tick]);
    var ns = key.chord.notes, list = [], anyD = false, anyC = chordCircle;
    for (var i = 0; i < ns.length; i++) {
        var d = ns[i].headGroup === env.DIAMOND;
        var c = chordCircle || H.hasCircle(ns[i]);
        if (d) anyD = true;
        if (c) anyC = true;
        list.push({ note: ns[i], pitch: ns[i].pitch, diamond: d, circle: c });
    }
    if (!list.length) return "";

    if (anyD || anyC) {
        var h = H.classify(instr, list);
        if (h) return h.detail + " — " + (h.verdict === "ok" ? "valid harmonic" : h.reason);
    }
    if (list.length === 1) {
        var o = S.openStringIndex(instr, list[0].pitch);
        return S.noteName(list[0].pitch) +
               (o >= 0 ? " — open string " + S.ROMAN[o] : " — stopped note");
    }
    if (divAt(divChanges(score, st, here), key.tick))
        return list.length + " notes — div., not checked as a stop";

    var pitches = [];
    for (var k = 0; k < list.length; k++) pitches.push(list[k].pitch);
    pitches.sort(function (a, b) { return b - a; });
    var res = S.analyseStop(instr, pitches);
    return S.describe(instr, pitches, res) + " — " +
           (res.verdict === "playable" ? "playable" : res.reason);
}

// Fingerboard data for a selected chord — or null unless it is a playable
// multiple stop, in which case the panel shows the list instead. Harmonics and
// chords under div. are excluded, exactly as analyse() excludes them from the
// stop test. Offsets are semitones above each note's open string.
function chordGeometry(score, env, key, circles) {
    if (!key || !key.chord) return null;
    var st = key.track >> 2, info = staffInstruments(score)[st];
    if (!info) return null;
    var here = { from: key.tick, to: key.tick };
    var instr = instrAt(instrumentsOf(score, env, st, info.part, here), key.tick);
    if (!instr) return null;
    var ns = key.chord.notes;
    if (!ns || ns.length < 2) return null;
    var chordCircle = !!(circles && circles[key.track + "|" + key.tick]);
    var pitches = [];
    for (var i = 0; i < ns.length; i++) {
        if (ns[i].headGroup === env.DIAMOND || chordCircle || H.hasCircle(ns[i])) return null;
        pitches.push(ns[i].pitch);
    }
    if (divAt(divChanges(score, st, here), key.tick)) return null;
    pitches.sort(function (a, b) { return b - a; });
    var res = S.analyseStop(instr, pitches);
    if (res.verdict !== "playable") return null;

    var cost = S.stretchOf(instr, pitches, res.assign);
    var notes = [], names = [];
    for (var k = 0; k < pitches.length; k++) {
        var s = res.assign[k];
        notes.push({ pitch: pitches[k], name: S.noteName(pitches[k]), string: s,
                     offset: pitches[k] - instr.strings[s] });
    }
    for (var j = 0; j < instr.strings.length; j++) names.push(S.stringName(instr.strings[j]));
    return { instrument: instr.name, strings: instr.strings.slice(0), stringNames: names,
             notes: notes, stopped: cost.stopped, worst: cost.worst,
             position: cost.position, reach: S.reachAt(instr, cost.position) };
}

// --- instrument ranges ---------------------------------------------------
// The plugin API does not expose an instrument's range: Part and Instrument have no
// range properties (checked by enumeration). But writeScore() can save an
// uncompressed copy of the in-memory score, and that XML carries minPitchP /
// maxPitchP / minPitchA / maxPitchA for every part and every instrument change.
// The caller writes the copy (writeScore lives on the MuseScore object) and hands
// the text here.

function rangeOf(block) {
    function tag(name, dflt) {
        var m = new RegExp("<" + name + ">(-?\\d+)</" + name + ">").exec(block);
        return m ? parseInt(m[1], 10) : dflt;
    }
    return { minP: tag("minPitchP", 0), maxP: tag("maxPitchP", 127),
             minA: tag("minPitchA", 0), maxA: tag("maxPitchA", 127) };
}

// xml -> [ staffIdx -> [ range from the start, after the 1st change, ... ] ]
function parseRanges(xml) {
    if (!xml) return null;
    var start = xml.indexOf("<Score>");
    if (start < 0) return null;
    var nested = xml.indexOf("<Score>", start + 7);    // parts are nested <Score>s
    var main = nested > 0 ? xml.substring(start, nested) : xml.substring(start);
    var staves = [], idx = 0, lastPartEnd = 0, pm;
    var partRe = /<Part>[\s\S]*?<\/Part>/g;
    while ((pm = partRe.exec(main)) !== null) {
        var block = pm[0];
        var n = (block.match(/<Staff id="/g) || []).length;
        var ib = /<Instrument[\s\S]*?<\/Instrument>/.exec(block);
        var r = ib ? rangeOf(ib[0]) : rangeOf("");
        for (var k = 0; k < n; k++) staves[idx++] = [r];
        lastPartEnd = pm.index + block.length;
    }
    var body = main.substring(lastPartEnd), sm;
    var staffRe = /<Staff id="(\d+)">([\s\S]*?)<\/Staff>/g;
    while ((sm = staffRe.exec(body)) !== null) {
        var sid = parseInt(sm[1], 10) - 1;
        if (!staves[sid]) staves[sid] = [rangeOf("")];
        var chRe = /<InstrumentChange>[\s\S]*?<\/InstrumentChange>/g, cm;
        while ((cm = chRe.exec(sm[2])) !== null) staves[sid].push(rangeOf(cm[0]));
    }
    return staves;
}

// The range in force at a tick. instrList is instrumentsOf()'s list: tick 0, then
// each instrument change in order — the same order the changes appear in the XML.
function rangeAt(ranges, instrList, st, tick) {
    if (!ranges || !ranges[st]) return null;
    var rs = ranges[st], idx = 0;
    for (var i = 0; i < instrList.length && i < rs.length; i++)
        if (instrList[i].tick <= tick) idx = i;
    return rs[idx];
}

// What MuseScore paints over a note, or null (note.cpp:1265-1271: red outside the
// professional range, dark yellow outside the amateur range). MuseScore tests
// ppitch() = pitch + ottava offset + capo; the offsets are not visible to a plugin,
// so a note under an ottava line may be judged an octave off.
function museScoreRangeColor(r, pitch) {
    if (!r) return null;
    if (pitch < r.minP || pitch > r.maxP) return "#ff0000";
    if (pitch < r.minA || pitch > r.maxA) return "#808000";
    return null;
}

// --- covering noteheads ----------------------------------------------------
// MuseScore replaces the pen for such a note, so no colour on the note shows. Instead
// a notehead symbol of the plugin's colour is attached to the note, one z-step above
// it: drawn on top (paint order is by z) yet losing every click to the note, because
// ScoreView::elementNear picks the LOWEST z under the cursor (scoreview.cpp:5109-5199,
// events.cpp:753). A plugin cannot mark it unselectable: the NOT_SELECTABLE flag is
// not exposed, and `generated` is read-only in the API.
// Added and removed through undoAddElement/deleteItem: outside a command MuseScore
// runs and discards those ops (verified), so live passes stay off the undo stack.
//
// LAYOUT. Score::addElement only calls triggerLayout(), which records a pending
// range; the layout itself runs in Score::update(), reached from endCmd. Without it a
// new cover has no bbox and the view never paints it — which is exactly what the GUI
// showed, while headless export (which lays out) hid the problem. Score::endCmd with
// NO command active just calls update() and returns (cmd.cpp:247), so layoutNow()
// lays out and repaints without creating an undo step. Never call startCmd() first:
// it resets the pending layout range.
var OVERLAY_DZ = 50;

function layoutNow(score) {
    try { score.endCmd(); } catch (e) {}
}
var OVERLAY_GLYPHS = { noteheadBlack: 1, noteheadHalf: 1, noteheadWhole: 1, noteheadDoubleWhole: 1,
                       noteheadDiamondBlack: 1, noteheadDiamondHalf: 1, noteheadDiamondWhole: 1,
                       noteheadDiamondDoubleWhole: 1 };

// The note's own head shape, from the chord's duration (headType reads AUTO).
// Returns null for head groups other than normal and diamond — those are left.
function overlayGlyph(env, note) {
    var diamond = note.headGroup === env.DIAMOND;
    if (note.headGroup !== env.NORMAL && !diamond) return null;
    var v = 0.25, chord = null;
    try { chord = note.parent } catch (e) {}
    try { var d = chord.duration; v = d.numerator / d.denominator; } catch (e2) {}
    try {                                   // a tuplet's notes are drawn at their written value
        var t = chord.tuplet;
        if (t && t.actualNotes && t.normalNotes) v = v * t.actualNotes / t.normalNotes;
    } catch (e3) {}
    var g = env.SYM;
    if (v >= 2)   return diamond ? g.diamondBreve : g.breve;
    if (v >= 1)   return diamond ? g.diamondWhole : g.whole;
    if (v >= 0.5) return diamond ? g.diamondHalf  : g.half;
    return diamond ? g.diamondBlack : g.black;
}

function isOverlay(el, note) {
    if (!el || !OVERLAY_GLYPHS[String(el.symbol)]) return false;
    try { if (el.z !== note.z + OVERLAY_DZ) return false; } catch (e) { return false; }
    return S.isOurColor(el.color);
}

function hasOverlay(note) {
    var els = null;
    try { els = note.elements } catch (e) { return false; }
    if (els) for (var i = 0; i < els.length; i++) if (isOverlay(els[i], note)) return true;
    return false;
}

function removeOverlays(note) {
    var els = null, n = 0;
    try { els = note.elements } catch (e) { return 0; }
    if (!els) return 0;
    for (var i = els.length - 1; i >= 0; i--)
        if (isOverlay(els[i], note)) { note.remove(els[i]); n++; }
    return n;
}

// opts.env, opts.newSymbol: function () { return newElement(Element.SYMBOL) } —
// newElement lives on the MuseScore object, so the caller supplies it.
function addOverlay(note, color, opts) {
    var glyph = overlayGlyph(opts.env, note);
    if (glyph === null || glyph === undefined) return false;
    var sym = opts.newSymbol();
    sym.symbol = glyph;
    sym.color = color;
    note.add(sym);
    sym.z = note.z + OVERLAY_DZ;
    return true;
}

// A selected note keeps MuseScore's own selection colouring, so it is left
// uncovered; this puts covers back on everything else after a selection change.
// covers are keys, not element references: a wrapper held across edits could
// point at a deleted note.
function refreshCovers(score, env, covers, opts) {
    var changed = 0;
    for (var i = 0; i < covers.length; i++) {
        var c = covers[i], chord = findChord(score, env, c.track, c.tick, c.grace);
        if (!chord) continue;
        for (var j = 0; j < chord.notes.length; j++) {
            var n = chord.notes[j];
            if (n.pitch !== c.pitch) continue;
            if (n.selected) { changed += removeOverlays(n); }
            else if (!hasOverlay(n) && String(n.color).toLowerCase() === c.color) {
                if (addOverlay(n, c.color, opts)) changed++;
            }
        }
    }
    if (changed && !(opts && opts.command)) layoutNow(score);
    return changed;
}

// Colour the score. opts: { command: bool, overlay: bool, env, newSymbol } — see the
// note at the top of the file. Notes the user coloured themselves are left alone
// and reported back.
function applyMarks(score, marks, opts) {
    var useCmd = !opts || opts.command !== false;
    var overlay = !!(opts && opts.overlay && opts.newSymbol && opts.env);
    var applied = 0, skipped = 0, covered = 0;
    if (useCmd) score.startCmd();
    for (var i = 0; i < marks.length; i++) {
        var m = marks[i];
        var cur = String(m.note.color).toLowerCase();
        if (cur !== S.COLOR.black && !S.isOurColor(cur)) { skipped++; continue; }
        m.note.color = m.color;
        applied++;
        if (overlay && m.cover && !m.note.selected && !hasOverlay(m.note))
            if (addOverlay(m.note, m.color, opts)) covered++;
    }
    if (useCmd) score.endCmd();
    else if (covered) layoutNow(score);
    return { applied: applied, skipped: skipped, covered: covered };
}

// Reset our own colours and remove our covering noteheads.
// opts: { command: bool, from: tick, to: tick }
function clearMarks(score, env, opts) {
    var useCmd = !opts || opts.command !== false;
    var from = opts && opts.from >= 0 ? opts.from : -1;
    var to   = opts && opts.to   >= 0 ? opts.to   : -1;
    var cleared = 0, uncovered = 0;
    if (useCmd) score.startCmd();
    for (var st = 0; st < score.nstaves; st++)
        for (var v = 0; v < 4; v++) {
            var cur = score.newCursor();
            cur.staffIdx = st; cur.voice = v;
            seek(cur, from);
            while (cur.segment) {
                var tick = cur.tick;
                if (to >= 0 && tick > to) break;
                var el = cur.element;
                if (el && el.type === env.CHORD) {
                    var chords = [el], grace = null;
                    try { grace = el.graceNotes } catch (e) {}
                    if (grace) for (var g = 0; g < grace.length; g++) chords.push(grace[g]);
                    for (var c = 0; c < chords.length; c++)
                        for (var i = 0; i < chords[c].notes.length; i++) {
                            var n = chords[c].notes[i];
                            uncovered += removeOverlays(n);
                            if (S.isOurColor(n.color)) { n.color = S.COLOR.black; cleared++; }
                        }
                }
                cur.next();
            }
        }
    if (useCmd) score.endCmd();
    else if (uncovered) layoutNow(score);
    return cleared;
}
