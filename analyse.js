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
function analyse(score, env, range, circles) {
    var starts = barMap(score), staves = staffInstruments(score);
    var rows = [], marks = [];
    var counts = { open: 0, playable: 0, outOfReach: 0, impossible: 0, div: 0,
                   harmonics: 0, harmRisky: 0, harmBad: 0 };
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
        var handle = function (chordEl, tick) {
            var instr = instrAt(instrList, tick);
            if (!instr) return;                 // staff is a non-string instrument here
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
                            marks.push({ note: list[hi].note, color: hc });
                        rows.push({ bar: barOf(starts, tick), tick: tick, staff: info.name,
                                    verdict: h.verdict, reason: h.reason, notes: h.detail });
                    }
                    return;
                }
            }

            if (list.length === 1) {
                if (S.openStringIndex(instr, list[0].pitch) >= 0) {
                    marks.push({ note: list[0].note, color: S.COLOR.open });
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
                        marks.push({ note: list[j].note, color: S.COLOR.open });
                        counts.open++;
                    }
            } else {
                var col = res.verdict === "impossible" ? S.COLOR.impossible : S.COLOR.outOfReach;
                for (var q = 0; q < list.length; q++)
                    marks.push({ note: list[q].note, color: col });
                rows.push({ bar: barOf(starts, tick), tick: tick, staff: info.name,
                            verdict: res.verdict, reason: res.reason,
                            notes: S.describe(instr, pitches, res) });
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
                        for (var g = 0; g < grace.length; g++) handle(grace[g], tick);
                    handle(el, tick);
                }
                cur.next();
            }
        }
    }
    return { rows: rows, marks: marks, counts: counts };
}

// Colour the score. opts: { command: bool } — see the note at the top of the file.
// Notes the user coloured themselves are left alone and reported back.
function applyMarks(score, marks, opts) {
    var useCmd = !opts || opts.command !== false;
    var applied = 0, skipped = 0;
    if (useCmd) score.startCmd();
    for (var i = 0; i < marks.length; i++) {
        var cur = String(marks[i].note.color).toLowerCase();
        if (cur !== S.COLOR.black && !S.isOurColor(cur)) { skipped++; continue; }
        marks[i].note.color = marks[i].color;
        applied++;
    }
    if (useCmd) score.endCmd();
    return { applied: applied, skipped: skipped };
}

// Reset our own colours. opts: { command: bool, from: tick, to: tick }
function clearMarks(score, env, opts) {
    var useCmd = !opts || opts.command !== false;
    var from = opts && opts.from >= 0 ? opts.from : -1;
    var to   = opts && opts.to   >= 0 ? opts.to   : -1;
    var cleared = 0;
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
                            if (S.isOurColor(n.color)) { n.color = S.COLOR.black; cleared++; }
                        }
                }
                cur.next();
            }
        }
    if (useCmd) score.endCmd();
    return cleared;
}
