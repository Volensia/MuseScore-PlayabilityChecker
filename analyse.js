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

function invalidateDivCache() { _divCache = {}; _jeteCache = {}; _pizzCache = {}; _dynCache = {}; _tempoCache = {}; }

function scanDiv(score, staffIdx) { return scanTextStates(score, staffIdx, S.divState); }

// Staff texts that switch a state on or off, as [{tick, on}]. `classify` maps a
// text to true, false or null (not about this state).
// Text as a player reads it: a dynamic's SMuFL symbols become their letters
// ("<sym>dynamicMezzo</sym><sym>dynamicForte</sym>" -> "mf"), other tags are dropped.
var DYN_LETTER = { Piano: "p", Mezzo: "m", Forte: "f", Rinforzando: "r", Sforzando: "s", Z: "z", Niente: "n" };
function plainText(txt) {
    return String(txt).replace(/<sym>dynamic(\w+)<\/sym>/g, function (m, name) {
        return DYN_LETTER[name] !== undefined ? DYN_LETTER[name] : "";
    }).replace(/<[^>]*>/g, "");
}

function scanTextStates(score, staffIdx, classify) {
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
                var st = classify(plainText(txt), el);
                if (st !== null) changes.push({ tick: cur.tick, on: st });
            }
        cur.next();
    }
    return changes;
}

// The same, for the ticks from..to only.
function scanTextStatesIn(score, staffIdx, classify, from, to) {
    var cur = score.newCursor(), changes = [];
    cur.staffIdx = staffIdx; cur.voice = 0;
    seek(cur, from);
    while (cur.segment && cur.tick <= to) {
        if (cur.tick >= from) {
            var ann = cur.segment.annotations;
            if (ann)
                for (var a = 0; a < ann.length; a++) {
                    var el = ann[a], tr = -1, txt = "";
                    try { tr = el.track } catch (e) {}
                    if ((tr >> 2) !== staffIdx) continue;
                    try { txt = el.text || "" } catch (e2) {}
                    if (!txt) continue;
                    var st = classify(plainText(txt), el);
                    if (st !== null) changes.push({ tick: cur.tick, on: st });
                }
        }
        cur.next();
    }
    return changes;
}

// Is there a div./unis. text inside this tick range? (cheap, ranged)
function divTextInRange(score, staffIdx, from, to) {
    return textStateInRange(score, staffIdx, from, to, S.divState);
}

function textStateInRange(score, staffIdx, from, to, classify) {
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
                if (txt && classify(plainText(txt), el) !== null) return true;
            }
        cur.next();
    }
    return false;
}

function divChanges(score, staffIdx, range) {
    return cachedTextStates(_divCache, score, staffIdx, range, S.divState);
}

// Whole-score passes read all four text states of a staff (div., jeté, pizz., dynamics)
// in ONE walk: four separate walks made a whole-score check on a 16-staff, 300-bar score
// about a second slower. The fresh lists go into the same caches the ranged passes use.
var _freshPass = {};                // "score|staff" -> true while a whole-score pass runs
function refreshStaffTexts(score, staffIdx) {
    var kinds = [[_divCache, S.divState], [_jeteCache, S.jeteState], [_pizzCache, S.pizzState],
                 [_dynCache, S.dynamicVelocity]];
    var lists = [[], [], [], []], cur = score.newCursor();
    cur.staffIdx = staffIdx; cur.voice = 0; cur.rewind(0);
    while (cur.segment) {
        var ann = cur.segment.annotations;
        if (ann)
            for (var a = 0; a < ann.length; a++) {
                var el = ann[a], tr = -1, txt = "";
                try { tr = el.track } catch (e) {}
                if ((tr >> 2) !== staffIdx) continue;
                try { txt = el.text || "" } catch (e2) {}
                if (!txt) continue;
                var plain = plainText(txt);
                for (var k = 0; k < 4; k++) {
                    var st = kinds[k][1](plain, el);
                    if (st !== null) lists[k].push({ tick: cur.tick, on: st });
                }
            }
        cur.next();
    }
    var key = score.scoreName + "|" + staffIdx;
    for (var q = 0; q < 4; q++) {
        var cached = kinds[q][0][key];
        if (cached && JSON.stringify(cached) !== JSON.stringify(lists[q])) _textsChanged = true;
        kinds[q][0][key] = lists[q];
    }
    _freshPass[key] = true;
}

// A ranged pass reuses the cached map unless the edited bars hold such a text now
// or held one before — the second case is a text that was just deleted.
function cachedTextStates(cache, score, staffIdx, range, classify) {
    var key = score.scoreName + "|" + staffIdx;
    var cached = cache[key];
    if (cached && _freshPass[key] && !(range && range.from >= 0)) return cached;   // read this pass
    if (cached && range && range.from >= 0) {
        // Re-read only the edited bars and splice them into the cached list: a full re-read
        // of every staff made a two-bar edit on a 300-bar, 16-staff score cost 0.7 s.
        var before = [], inside = 0, after = [];
        for (var i = 0; i < cached.length; i++) {
            if (cached[i].tick < range.from) before.push(cached[i]);
            else if (cached[i].tick > range.to) after.push(cached[i]);
            else inside++;
        }
        var now = scanTextStatesIn(score, staffIdx, classify, range.from, range.to);
        if (!inside && !now.length) return cached;
        var merged = before.concat(now, after);
        if (JSON.stringify(merged) !== JSON.stringify(cached)) _textsChanged = true;
        cache[key] = merged;
        return merged;
    }
    var fresh = scanTextStates(score, staffIdx, classify);
    if (cached && JSON.stringify(cached) !== JSON.stringify(fresh)) _textsChanged = true;
    cache[key] = fresh;
    return fresh;
}
// Set when a ranged pass finds a div./jeté text added, moved or deleted: that text
// changes how every later chord on the staff is judged, so the caller should redo
// the whole score rather than just the edited bars.
var _textsChanged = false;

// jeté on/off texts, cached the same way as div.
var _jeteCache = {};
function jeteChanges(score, staffIdx, range) {
    return cachedTextStates(_jeteCache, score, staffIdx, range, S.jeteState);
}
var _pizzCache = {}, _dynCache = {};
function pizzChanges(score, staffIdx, range) {
    return cachedTextStates(_pizzCache, score, staffIdx, range, S.pizzState);
}
// [{tick, on: settled velocity}] — see strings.js dynamicVelocity
function dynamicChanges(score, staffIdx, range) {
    return cachedTextStates(_dynCache, score, staffIdx, range, S.dynamicVelocity);
}

// Value of an on/off or numeric state map at a tick, or `dflt` before the first change.
function valueAt(changes, tick, dflt) {
    var i = stateIndex(changes, tick);
    return i < 0 ? dflt : changes[i].on;
}

// Index of the last change at or before `tick` in a tick-sorted list, or -1 (binary
// search: these lookups run for every chord and every slur).
function stateIndex(changes, tick) {
    var lo = 0, hi = changes.length;
    while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (changes[mid].tick <= tick) lo = mid + 1; else hi = mid;
    }
    return lo - 1;
}

// --- tempo ---------------------------------------------------------------
// Tempo marks are Element.TEMPO_TEXT annotations whose `tempo` is quarter notes per
// second (verified on 3.6.2: "♩ = 60" reads 1). They can sit on any staff and on a
// segment where the first staff has no note, so every segment of the score is walked.
// The map is cached per score; a ranged pass that finds it changed asks for a
// whole-score redo, as a changed text does. Without a tempo mark MuseScore plays
// ♩ = 120.
var _tempoCache = {};
function tempoMap(score, env, range) {
    var key = score.scoreName, map = [], seg = null;
    try { seg = score.firstMeasure.firstSegment } catch (e) {}
    while (seg) {
        var ann = null;
        try { ann = seg.annotations } catch (e2) {}
        if (ann)
            for (var a = 0; a < ann.length; a++) {
                var q = undefined;
                if (ann[a].type !== env.TEMPO_TEXT) continue;
                try { q = ann[a].tempo } catch (e3) {}
                if (typeof q === "number" && q > 0 &&
                    (!map.length || map[map.length - 1].tick !== seg.tick))
                    map.push({ tick: seg.tick, qps: q });
            }
        try { seg = seg.next } catch (e4) { seg = null; }
    }
    var old = _tempoCache[key];
    if (old && range && range.from >= 0 && JSON.stringify(old) !== JSON.stringify(map)) _textsChanged = true;
    _tempoCache[key] = map;
    return map;
}

// Seconds from tick t0 to t1 (480 ticks to a quarter note).
function fmtSeconds(x) { return (Math.round(x * 10 + 1e-6) / 10) + " s"; }   // 3.7499999 (tempo in beats/s) still shows 3.8

function secondsBetween(map, t0, t1) {
    var secs = 0, t = t0, qps = 2;
    for (var i = 0; i < map.length; i++) if (map[i].tick <= t0) qps = map[i].qps;
    for (var j = 0; j < map.length && t < t1; j++) {
        if (map[j].tick <= t) continue;
        var edge = Math.min(map[j].tick, t1);
        secs += (edge - t) / 480 / qps;
        t = edge;
        qps = map[j].qps;
    }
    if (t < t1) secs += (t1 - t) / 480 / qps;
    return secs;
}

function divAt(changes, tick) {
    var i = stateIndex(changes, tick);
    return i < 0 ? false : changes[i].on;
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

// The sound an instrument plays when bowed: its "arco" channel, else its first channel
// (Instrument.channels[].midiProgram, verified on 3.6.2).
function arcoProgram(ins) {
    var chs = null;
    try { chs = ins.channels } catch (e) { return null; }
    if (!chs || !chs.length) return null;
    for (var c = 0; c < chs.length; c++)
        if (String(chs[c].name) === "arco") return chs[c].midiProgram;
    return chs[0].midiProgram;
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
        var id = "", ln = "", prog = null;
        try {
            var ins = part.instrumentAtTick(ticks[i]);
            try { id = ins.instrumentId || "" } catch (e2) {}
            try { ln = ins.longName || "" } catch (e3) {}
            prog = arcoProgram(ins);
        } catch (e) {}
        if (!id && !ln) {                       // fall back to the part's own instrument
            try { id = part.instrumentId || "" } catch (e4) {}
            try { ln = part.longName || part.partName || "" } catch (e5) {}
        }
        if (prog === null) try { prog = part.midiProgram } catch (e6) {}
        out.push({ tick: ticks[i], instr: S.lookup(id, ln, prog) });
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

// --- per-track tick sets ---------------------------------------------------
// Circles, staccato dots and marks are kept as map[track][tick]. A single flat map with
// a "track|tick" key per note grew slower with every key in MuseScore's JavaScript
// engine: on a 16-staff, 300-bar score, 4,800 flat keys made a scan take 1.2-1.7 s,
// against 0.47 s with the keys split by track (see SPEC-strings.md, "Copy reader").
function mapHas(map, track, tick) {
    var t = map ? map[track] : undefined;
    return !!(t && t[tick]);
}
function mapSet(map, track, tick, value) {
    (map[track] || (map[track] = {}))[tick] = value === undefined ? true : value;
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
        if (tick >= 0 && tr >= 0) mapSet(map, tr, tick);
    }
    return map;
}

// --- slurs and staccato dots (S10) ----------------------------------------
// Neither a Chord nor the Score hands over its slurs or articulations, but the
// select-all that finds harmonic circles returns both (verified on 3.6.2): a Slur
// with spannerTick / spannerTicks (FractionWrappers, read .ticks) and track, and
// each staccato as an Articulation whose parent is the Chord. A slur's length runs
// from its first chord's tick to its last chord's tick, so the stroke is every
// chord in [from, to] on that track.
// Hairpins come from the same list (Element.HAIRPIN; hairpinType 0/2 = crescendo,
// 1/3 = diminuendo), with their veloChange (0 unless the user set one).
// Returns { slurs: { track: [{from, to}] }, dots: { track: { tick: true } },
//           hairpins: { staffIdx: [{from, to, cresc, change}] } }.
function buildBowMap(elements, env) {
    var map = { slurs: {}, dots: {}, hairpins: {}, tremolos: {} };
    if (!elements) return map;
    for (var i = 0; i < elements.length; i++) {
        var el = elements[i];
        if (el.type === env.SLUR) {
            var from = -1, len = -1, tr = -1;
            try { from = el.spannerTick.ticks } catch (e) {}
            try { len = el.spannerTicks.ticks } catch (e2) {}
            try { tr = el.track } catch (e3) {}
            if (from < 0 || len < 0 || tr < 0) continue;
            if (!map.slurs[tr]) map.slurs[tr] = [];
            map.slurs[tr].push({ from: from, to: from + len });
        } else if (env.HAIRPIN !== undefined && el.type === env.HAIRPIN) {
            var hf = -1, hl = -1, htr = -1, ht = -1, hc = 0;
            try { hf = el.spannerTick.ticks } catch (e8) {}
            try { hl = el.spannerTicks.ticks } catch (e9) {}
            try { htr = el.track } catch (e10) {}
            try { ht = el.hairpinType } catch (e11) {}
            try { hc = Number(el.veloChange) || 0 } catch (e12) {}
            if (hf < 0 || hl <= 0 || htr < 0 || ht < 0 || ht > 3) continue;
            var hst = htr >> 2;
            if (!map.hairpins[hst]) map.hairpins[hst] = [];
            map.hairpins[hst].push({ from: hf, to: hf + hl, cresc: ht === 0 || ht === 2, change: hc });
        } else if (env.TREMOLO !== undefined && el.type === env.TREMOLO) {
            // two-chord tremolos are listed once per chord; the first chord is the parent
            // of the "between notes" kind
            var tn = "", tch = null;
            try { tn = el.subtypeName() } catch (e13) {}
            if (!/between/.test(tn)) continue;
            try { tch = el.parent } catch (e14) {}
            if (tch) try { mapSet(map.tremolos, tch.track, tch.parent.tick); } catch (e15) {}
        } else if (el.type === env.ARTICULATION) {
            var sym = null;
            try { sym = el.symbol } catch (e4) {}
            if (!S.isStaccatoSymbol(sym)) continue;
            var chord = null, tick = -1, ctr = -1;
            try { chord = el.parent } catch (e5) {}
            if (!chord) continue;
            try { tick = chord.parent.tick } catch (e6) {}
            try { ctr = chord.track } catch (e7) {}
            if (tick >= 0 && ctr >= 0) mapSet(map.dots, ctr, tick);
        }
    }
    for (var t in map.slurs) map.slurs[t].sort(function (a, b) { return a.from - b.from; });
    return map;
}

// --- analysis ------------------------------------------------------------
// env  : { CHORD: Element.CHORD, DIAMOND: NoteHeadGroup.HEAD_DIAMOND }
// range: optional { from, to } in ticks — live mode passes the layout range of
//        the edit so only the affected bars are re-examined.
// Returns { rows, marks, counts }. Nothing is written to the score here.
function analyse(score, env, range, circles, ranges, bowing) {
    var starts = barMap(score), staves = staffInstruments(score);
    var rows = [], marks = [], covers = [];
    var counts = { open: 0, playable: 0, outOfReach: 0, impossible: 0, div: 0,
                   harmonics: 0, harmRisky: 0, harmBad: 0, covered: 0,
                   jete: 0, jeteFlagged: 0, groups: 0, groupsFlagged: 0, fast: 0, fastFlagged: 0,
                   slurs: 0, slursFlagged: 0, tremolos: 0, tremImpossible: 0, tremAcross: 0 };
    var marked = {};            // track -> "tick|grace|pitch" -> colour given this pass
    var redoStaves = [];        // staves a live pass could not judge alone (a fast run crosses its edge)
    _textsChanged = false;
    var from = range && range.from >= 0 ? range.from : -1;
    var to   = range && range.to   >= 0 ? range.to   : -1;

    var onlyStaves = range && range.staves ? range.staves : null;     // [staffIdx, ...] or null
    _freshPass = {};
    for (var st = 0; st < score.nstaves; st++) {
        if (onlyStaves && onlyStaves.indexOf(st) < 0) continue;
        var info = staves[st];
        if (!info) continue;
        var instrList = instrumentsOf(score, env, st, info.part, range);
        var anyString = false;
        for (var ai = 0; ai < instrList.length; ai++) if (instrList[ai].instr) anyString = true;
        if (!anyString) continue;               // never a bowed string staff
        if (!(range && range.from >= 0)) refreshStaffTexts(score, st);    // whole staff: one walk for all texts
        var changes = divChanges(score, st, range);

        // A note MuseScore paints in its own range colour never shows ours
        // (note.cpp:1265-1271). Flag it so applyMarks can draw a notehead over it.
        var markNote = function (noteEl, pitch, color, rng, trk, tick, graceIdx) {
            var ms = museScoreRangeColor(rng, pitch);
            var cover = !!(ms && ms !== color);
            marks.push({ note: noteEl, color: color, cover: cover });
            var mt = marked[trk] || (marked[trk] = {});
            mt[tick + "|" + graceIdx + "|" + pitch] = color;
            if (cover) {
                counts.covered++;
                covers.push({ track: trk, tick: tick, grace: graceIdx, pitch: pitch, color: color });
            }
        };

        // one chord (ordinary or grace): mark it and, if it is a stop, judge it
        // graceIdx: -1 for the main chord, else its index in graceNotes. Rows carry
        // { track, tick, grace } so the panel can turn a row back into notes.
        var handle = function (chordEl, tick, graceIdx) {
            var instr = instrAt(instrList, tick);
            if (!instr) return;                 // staff is a non-string instrument here
            var trk = -1;
            try { trk = chordEl.track } catch (e0) {}
            var rng = ranges ? rangeAt(ranges, instrList, st, tick) : null;
            var mark = function (noteEl, pitch, color) {
                markNote(noteEl, pitch, color, rng, trk, tick, graceIdx);
            };
            // a circle from the Articulations palette belongs to the whole chord
            var chordCircle = false;
            if (circles) {
                var ctr = -1;
                try { ctr = chordEl.track } catch (e) {}
                if (ctr >= 0 && mapHas(circles, ctr, tick)) chordCircle = true;
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
                                    kind: "harmonic", verdict: h.verdict, reason: h.reason, notes: h.detail,
                                    track: trk, grace: graceIdx, tickEnd: tick });
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
                            kind: "stop", verdict: res.verdict, reason: res.reason,
                            notes: S.describe(instr, pitches, res),
                            track: trk, grace: graceIdx, tickEnd: tick });
            }
        };

        var walked = [];                // voice -> { ticks, els }: chords this walk visited
        for (var v = 0; v < 4; v++) {
            var cur = score.newCursor(), seen = walked[v] = { ticks: [], els: [] };
            cur.staffIdx = st; cur.voice = v;
            seek(cur, from);
            while (cur.segment) {
                var tick = cur.tick;
                if (to >= 0 && tick > to) break;
                var el = cur.element;
                if (el && el.type === env.CHORD) {
                    seen.ticks.push(tick);
                    seen.els.push(el);
                    var grace = null;
                    try { grace = el.graceNotes } catch (e) {}
                    if (grace)
                        for (var g = 0; g < grace.length; g++) handle(grace[g], tick, g);
                    handle(el, tick, -1);
                }
                cur.next();
            }
        }

        if (bowing) checkJete(st, info, instrList, markNote, walked);
        if (bowing && bowing.tremolos) checkTremolos(st, info, instrList, markNote, walked);
        checkFastRuns(st, info, instrList, markNote);
    }
    return { rows: rows, marks: marks, counts: counts, covers: covers,
             textsChanged: from >= 0 && _textsChanged, redoStaves: redoStaves };

    // S12: fast passages in a double bass SECTION (strings.js FAST_RUN). A run is a chain
    // of bowed notes in one voice, each shorter than 0.1 s and each starting where the
    // last one ended (a rest, a longer note or pizz. ends it; a tied-on note counts as
    // part of the note it continues). A run lasting longer than 1.5 s is flagged, dark
    // yellow, one row. A live pass looks one bar either side of its range: when a run
    // reaches over the range's edge, the rows of the whole staff are redone (redoStaves).
    function checkFastRuns(st, info, instrList, markNote) {
        var anyBass = false;
        for (var i = 0; i < instrList.length; i++) {
            var ins = instrList[i].instr;
            if (ins && ins.section && ins.name === "Double bass") anyBass = true;
        }
        if (!anyBass) return;
        var tempo = tempoMap(score, env, range), pizz = pizzChanges(score, st, range);
        var lo = -1, hi = -1;
        if (from >= 0) {
            var b0 = barOf(starts, from) - 1, b1 = barOf(starts, to) - 1;
            lo = starts[Math.max(0, b0 - 1)];
            hi = b1 + 2 < starts.length ? starts[b1 + 2] - 1 : -1;
        }
        var redo = false;
        for (var v = 0; v < 4 && !redo; v++) {
            var trk = st * 4 + v, run = [], prevEnd = -1;
            var close = function () {
                var r = run;
                run = [];
                if (r.length < 2) return;
                var t0 = r[0].tick, t1 = r[r.length - 1].end, last = r[r.length - 1].tick;
                if (from >= 0) {
                    if (last < from || t0 > to) return;             // outside the edited bars
                    if (t0 < from || last > to) { redo = true; return; }
                }
                var secs = secondsBetween(tempo, t0, t1);
                counts.fast++;
                if (secs <= S.FAST_RUN.maxRunSeconds + 1e-9) return;
                counts.fastFlagged++;
                var color = S.COLOR[S.FAST_RUN.verdict], top0 = -1, topN = -1;
                var rng = ranges ? rangeAt(ranges, instrList, st, t0) : null;
                for (var c = 0; c < r.length; c++) {
                    var ns = r[c].chord.notes;
                    for (var n = 0; n < ns.length; n++) {
                        var p = ns[n].pitch;
                        if (c === 0 && p > top0) top0 = p;
                        if (c === r.length - 1 && p > topN) topN = p;
                        var prev = marked[trk] ? marked[trk][r[c].tick + "|-1|" + p] : undefined;
                        if (prev === S.COLOR.impossible) continue;
                        markNote(ns[n], p, color, rng, trk, r[c].tick, -1);
                    }
                }
                var rate = Math.round(r.length / secs * 10) / 10;
                rows.push({ bar: barOf(starts, t0), tick: t0, staff: info.name, kind: "fast",
                            verdict: S.FAST_RUN.verdict,
                            reason: "fast passage: " + rate + " notes/s for " + fmtSeconds(secs) +
                                    " (section max 10/s for 1.5 s)",
                            notes: S.noteName(top0) + " … " + S.noteName(topN) + " (" + r.length + " notes)",
                            track: trk, grace: -1, tickEnd: last });
            };
            var cur = score.newCursor();
            cur.staffIdx = st; cur.voice = v;
            seek(cur, lo);
            while (cur.segment) {
                var tick = cur.tick;
                if (hi >= 0 && tick > hi) break;
                var el = cur.element;
                if (el && el.type === env.CHORD) {
                    var ns0 = el.notes, back = false, end = tick;
                    try { back = !!ns0[0].tieBack } catch (e1) {}
                    try { end = tick + el.actualDuration.ticks } catch (e2) {}
                    if (back && tick === prevEnd) {                 // a tied-on note: lengthen the last one
                        if (run.length) {
                            run[run.length - 1].end = end;
                            if (secondsBetween(tempo, run[run.length - 1].tick, end) >= S.FAST_RUN.maxNoteSeconds - 1e-9) {
                                run.pop(); close();
                            }
                        }
                        prevEnd = end;
                    } else {
                        var instr = instrAt(instrList, tick);
                        var ok = instr && instr.section && instr.name === "Double bass" && !divAt(pizz, tick) &&
                                 secondsBetween(tempo, tick, end) < S.FAST_RUN.maxNoteSeconds - 1e-9;
                        if (!ok || tick !== prevEnd) close();
                        if (ok) run.push({ chord: el, tick: tick, end: end });
                        prevEnd = end;
                    }
                } else if (el) {                                    // a rest
                    close();
                    prevEnd = -1;
                }
                cur.next();
            }
            close();
        }
        if (redo) redoStaves.push(st);
    }

    // Every slur on a bowed string is one bow stroke. Chords are counted (a double stop
    // is one note, grace notes are not counted). Under pizz. there is no bow, so slurs
    // are ignored.
    //   S10 — a slur with a staccato dot: inside a jeté passage it is judged as jeté
    //         (Adler p. 27 notation; limit Sevsay p. 18 / Wagner p. 40); without a jeté
    //         text it is slurred staccato and is timed like any other slur (S11).
    //   S11 — any other slur (legato, louré, slurred staccato): its length in seconds, from its first
    //         chord to the end of its last (through any tie), against the bow limit
    //         for its loudest dynamic (strings.js BOW_SECONDS).
    // A live pass re-marks a whole stroke that overlaps the edited bars, but adds a
    // row only for strokes that START there — rows outside the range are kept by the
    // panel. A note already red, from this pass or an earlier one, stays red.
    function checkJete(st, info, instrList, markNote, walked) {
        var on = jeteChanges(score, st, range);
        var pizz = pizzChanges(score, st, range), dyn = dynamicChanges(score, st, range);
        var tempo = null;
        for (var v = 0; v < 4; v++) {
            var trk = st * 4 + v, slurs = bowing.slurs[trk];
            if (!slurs) continue;
            for (var i = 0; i < slurs.length; i++) {
                var sl = slurs[i];
                if (from >= 0 && (sl.to < from || sl.from > to)) continue;
                if (divAt(pizz, sl.from)) continue;         // divAt reads any on/off map
                var instr = instrAt(instrList, sl.from);
                if (!S.jeteLimit(instr)) continue;          // not a bowed string here
                var chords = [], dotted = false;
                if ((from < 0 || sl.from >= from) && (to < 0 || sl.to <= to)) {
                    // inside the span the main walk covered: take its chords (binary search)
                    var wt = walked[v].ticks, lo = 0, hi = wt.length;
                    while (lo < hi) { var mid = (lo + hi) >> 1; if (wt[mid] < sl.from) lo = mid + 1; else hi = mid; }
                    for (var w = lo; w < wt.length && wt[w] <= sl.to; w++) {
                        chords.push({ chord: walked[v].els[w], tick: wt[w] });
                        if (mapHas(bowing.dots, trk, wt[w])) dotted = true;
                    }
                } else {
                    var cur = score.newCursor();
                    cur.staffIdx = st; cur.voice = v;
                    seek(cur, sl.from);
                    while (cur.segment && cur.tick <= sl.to) {
                        var el = cur.element;
                        if (el && el.type === env.CHORD && cur.tick >= sl.from) {
                            chords.push({ chord: el, tick: cur.tick });
                            if (mapHas(bowing.dots, trk, cur.tick)) dotted = true;
                        }
                        cur.next();
                    }
                }
                if (chords.length < 2) continue;
                var verdict, reason, kind;
                // A section's jeté stroke is judged by its note count only. Everything else
                // — legato, louré, slurred staccato, and a single player's jeté — is one bow
                // and is timed (S11); a section's slurred staccato also has a note limit.
                var section = !!instr.section, jeteText = divAt(on, sl.from);
                var jeteStroke = dotted && section && jeteText;
                if (jeteStroke) {
                    var limit = S.jeteLimit(instr);
                    counts.jete++;
                    if (chords.length <= limit.max) continue;
                    counts.jeteFlagged++;
                    verdict = limit.verdict;
                    kind = "jete";
                    reason = "jeté: " + chords.length + " notes on one bow (section max " + limit.max + ")";
                } else {
                    var group = null, timed = null;
                    if (dotted && section && !jeteText) {
                        var loud = S.isLoud(valueAt(dyn, sl.from, 0));
                        var gmax = loud ? S.GROUP_STACCATO_LIMIT.loud : S.GROUP_STACCATO_LIMIT.soft;
                        counts.groups++;
                        if (chords.length > gmax) {
                            counts.groupsFlagged++;
                            group = { verdict: S.GROUP_STACCATO_LIMIT.verdict,
                                      reason: "slurred staccato" + (loud ? " at f" : "") + ": " + chords.length +
                                              " notes on one bow (section max " + gmax + ")" };
                        }
                    }
                    if (!tempo) tempo = tempoMap(score, env, range);
                    var endTick = strokeEnd(chords[chords.length - 1]);
                    var cuts = [];
                    for (var q = 0; q < chords.length; q++) cuts.push(chords[q].tick);
                    var use = bowUse(instr, dyn, bowing.hairpins[st] || [], tempo, sl.from, endTick, cuts);
                    if (use) {
                        counts.slurs++;
                        if (use.warn > 1 + 1e-9) {
                            counts.slursFlagged++;
                            var red = use.red > 1 + 1e-9, tr;
                            if (use.tiers.length === 1) {
                                var bl = S.bowLimit(instr, use.tiers[0]);
                                tr = "slur " + fmtSeconds(use.secs) + " at " + use.tiers[0] + " (" +
                                     (red ? "longest one bow can last " + fmtSeconds(bl.red)
                                          : "max " + fmtSeconds(bl.warn)) + ")";
                            } else {
                                tr = "slur " + fmtSeconds(use.secs) + ", " + use.tiers[0] + "–" +
                                     use.tiers[use.tiers.length - 1] + " (needs " +
                                     Math.round((red ? use.red : use.warn) * 100) + "% of " +
                                     (red ? "the longest bow" : "a comfortable bow") + ")";
                            }
                            timed = { verdict: red ? "impossible" : "outOfReach", reason: tr };
                        }
                    }
                    if (!group && !timed) continue;
                    if (group && timed) {           // one row for the stroke, the worse colour
                        verdict = timed.verdict === "impossible" ? "impossible" : group.verdict;
                        reason = group.reason + "; " + timed.reason;
                        kind = "group";
                    } else if (group) {
                        verdict = group.verdict; reason = group.reason; kind = "group";
                    } else {
                        verdict = timed.verdict; reason = timed.reason; kind = "slur";
                    }
                }
                var color = S.COLOR[verdict], names = [];
                var rng = ranges ? rangeAt(ranges, instrList, st, sl.from) : null;
                // colour the notes tied on from the stroke's last chord too: they sound on
                // the same bow (they are not counted or named)
                var lastTick = strokeLastTick(chords[chords.length - 1]), named = chords.length;
                if (lastTick > sl.to) {
                    var tc = score.newCursor();
                    tc.staffIdx = st; tc.voice = v;
                    seek(tc, sl.to + 1);
                    while (tc.segment && tc.tick <= lastTick) {
                        if (tc.tick > sl.to && tc.element && tc.element.type === env.CHORD)
                            chords.push({ chord: tc.element, tick: tc.tick });
                        tc.next();
                    }
                }
                for (var c = 0; c < chords.length; c++) {
                    var ns = chords[c].chord.notes, top = -1;
                    for (var n = 0; n < ns.length; n++) {
                        var p = ns[n].pitch;
                        if (p > top) top = p;
                        var prev = marked[trk] ? marked[trk][chords[c].tick + "|-1|" + p] : undefined;
                        if (prev === S.COLOR.impossible) continue;
                        if (prev === undefined && String(ns[n].color).toLowerCase() === S.COLOR.impossible &&
                            from >= 0 && (chords[c].tick < from || chords[c].tick > to)) continue;
                        markNote(ns[n], p, color, rng, trk, chords[c].tick, -1);
                    }
                    if (c < named) names.push(S.noteName(top));
                }
                var noteText = kind === "jete" || kind === "group" ? names.join(" ")
                             : names[0] + " … " + names[names.length - 1] + " (" + names.length + " notes)";
                if (from < 0 || sl.from >= from)
                    rows.push({ bar: barOf(starts, sl.from), tick: sl.from, staff: info.name,
                                kind: kind, verdict: verdict, reason: reason,
                                notes: noteText, track: trk, grace: -1,
                                tickEnd: lastTick });
            }
        }
    }

    // S13: every "between notes" tremolo from the copy — the chord it sits on and the next
    // chord in the same voice. Single notes only (a tremolo between double stops is not
    // judged), no harmonics.
    function checkTremolos(st, info, instrList, markNote, walked) {
        for (var v = 0; v < 4; v++) {
            var trk = st * 4 + v, set = bowing.tremolos[trk];
            if (!set) continue;
            for (var key in set) {
                var t0 = parseInt(key);
                if (from >= 0 && (t0 < from || t0 > to)) continue;
                var instr = instrAt(instrList, t0);
                if (!instr || !S.jeteLimit(instr)) continue;
                var pair = tremoloPair(st, v, t0, walked[v]);
                if (!pair) continue;
                var na = pair[0].chord.notes, nb = pair[1].chord.notes;
                if (na.length !== 1 || nb.length !== 1) continue;
                if (na[0].headGroup === env.DIAMOND || nb[0].headGroup === env.DIAMOND) continue;
                var res = S.fingeredTremolo(instr, na[0].pitch, nb[0].pitch);
                counts.tremolos++;
                if (res.verdict === "fine") continue;
                var red = res.verdict === "impossible";
                counts[red ? "tremImpossible" : "tremAcross"]++;
                var color = S.COLOR[res.verdict];
                var rng = ranges ? rangeAt(ranges, instrList, st, t0) : null;
                var both = [pair[0], pair[1]];
                for (var k = 0; k < 2; k++) {
                    var nn = both[k].chord.notes[0], prev = marked[trk] ? marked[trk][both[k].tick + "|-1|" + nn.pitch] : undefined;
                    if (prev === S.COLOR.impossible) continue;
                    markNote(nn, nn.pitch, color, rng, trk, both[k].tick, -1);
                }
                var reason = red
                    ? "fingered tremolo too wide (" + S.intervalName(res.interval) + ")"
                    : "fingered tremolo across strings " + S.stringName(instr.strings[res.strings[0]]) + "–" +
                      S.stringName(instr.strings[res.strings[1]]) + " (" + S.intervalName(res.interval) + ")";
                if (from < 0 || t0 >= from)
                    rows.push({ bar: barOf(starts, t0), tick: t0, staff: info.name, kind: "tremolo",
                                verdict: res.verdict, reason: reason,
                                notes: S.noteName(na[0].pitch) + " ↔ " + S.noteName(nb[0].pitch),
                                track: trk, grace: -1, tickEnd: pair[1].tick });
            }
        }
    }

    // The tremolo's chord at t0 and the next chord in the same voice.
    function tremoloPair(st, v, t0, seen) {
        var wt = seen ? seen.ticks : [], lo = 0, hi = wt.length;
        while (lo < hi) { var mid = (lo + hi) >> 1; if (wt[mid] < t0) lo = mid + 1; else hi = mid; }
        if (lo < wt.length && wt[lo] === t0 && lo + 1 < wt.length)
            return [{ chord: seen.els[lo], tick: t0 }, { chord: seen.els[lo + 1], tick: wt[lo + 1] }];
        var cur = score.newCursor(), out = [];                // outside the walked bars
        cur.staffIdx = st; cur.voice = v;
        seek(cur, t0);
        while (cur.segment && out.length < 2) {
            if (cur.tick >= t0 && cur.element && cur.element.type === env.CHORD)
                out.push({ chord: cur.element, tick: cur.tick });
            cur.next();
        }
        return out.length === 2 && out[0].tick === t0 ? out : null;
    }

    // Tick of the last chord a stroke sounds on: its last chord, or the last chord
    // tied on from it. Rows carry it as tickEnd so every note of the stroke finds its row.
    function strokeLastTick(last) {
        var t = last.tick, ns = last.chord.notes;
        for (var k = 0; k < ns.length; k++) {
            try {
                var lt = ns[k].lastTiedNote;
                if (lt && lt.parent && lt.parent.parent.tick > t) t = lt.parent.parent.tick;
            } catch (e) {}
        }
        return t;
    }

    // End tick of a stroke: the end of its last chord, or of the last note tied on
    // from it — a tie continues the same bow.
    function strokeEnd(last) {
        var end = last.tick, ns = last.chord.notes;
        try { end = last.tick + last.chord.actualDuration.ticks } catch (e) {}
        for (var k = 0; k < ns.length; k++) {
            try {
                var lt = ns[k].lastTiedNote;
                if (lt && lt.parent) {
                    var e2 = lt.parent.parent.tick + lt.parent.actualDuration.ticks;
                    if (e2 > end) end = e2;
                }
            } catch (e3) {}
        }
        return end;
    }

    // How much bow a stroke uses. The bow is used up at a rate set by the dynamic:
    // a stretch of t seconds at a tier with limit L uses t / L of a bow (Sevsay p. 10
    // works his own example this way — three quarters at ♩ = 60 take half the bow in
    // p and the whole bow in mf). Summed over the stroke, once against the warn limits
    // and once against the red limits; above 1 = more than one bow.
    //
    // The level at a moment is the dynamic in force, except inside a hairpin, where it
    // moves in a straight line from the level at the hairpin's start to its target:
    // the first dynamic at or after its end if that lies the right way, else the start
    // level plus the hairpin's own veloChange (0 by default). A dynamic written inside
    // the hairpin takes over from there. Stretches are cut at every chord, dynamic and
    // hairpin end, and a stretch inside a hairpin is sampled in 8 equal parts.
    // Returns { secs, warn, red, tiers: [tiers used, soft to loud] } or null.
    function bowUse(instr, dyn, allHairpins, tempo, t0, t1, cuts) {
        if (!S.bowLimit(instr, "mf")) return null;
        var pts = [t0, t1], hairpins = [];
        function addCut(t) { if (t > t0 && t < t1) pts.push(t); }
        for (var a = 0; a < cuts.length; a++) addCut(cuts[a]);
        for (var b = stateIndex(dyn, t0) + 1; b < dyn.length && dyn[b].tick < t1; b++) addCut(dyn[b].tick);
        for (var h0 = 0; h0 < allHairpins.length; h0++)       // only hairpins touching the stroke
            if (allHairpins[h0].from < t1 && allHairpins[h0].to > t0) hairpins.push(allHairpins[h0]);
        for (var c = 0; c < hairpins.length; c++) { addCut(hairpins[c].from); addCut(hairpins[c].to); }
        pts.sort(function (x, y) { return x - y; });
        var res = { secs: 0, warn: 0, red: 0, tiers: [] }, seen = {};
        for (var k = 0; k + 1 < pts.length; k++) {
            var a0 = pts[k], a1 = pts[k + 1];
            if (a1 <= a0) continue;
            var inHairpin = false;
            for (var h = 0; h < hairpins.length; h++)
                if (hairpins[h].from < a1 && hairpins[h].to > a0) inHairpin = true;
            var parts = inHairpin ? 8 : 1;
            for (var m = 0; m < parts; m++) {
                var s0 = a0 + (a1 - a0) * m / parts, s1 = a0 + (a1 - a0) * (m + 1) / parts;
                var tier = S.dynamicTier(levelAt(dyn, hairpins, (s0 + s1) / 2));
                var bl = S.bowLimit(instr, tier), secs = secondsBetween(tempo, s0, s1);
                res.secs += secs;
                res.warn += secs / bl.warn;
                res.red += secs / bl.red;
                seen[tier] = true;
            }
        }
        for (var t in S.TIER_ORDER) if (seen[t]) res.tiers.push(t);
        res.tiers.sort(function (x, y) { return S.TIER_ORDER[x] - S.TIER_ORDER[y]; });
        return res;
    }

    function levelAt(dyn, hairpins, t) {
        var base = valueAt(dyn, t, S.DEFAULT_VELOCITY);
        for (var h = 0; h < hairpins.length; h++) {
            var hp = hairpins[h];
            if (!(hp.from <= t && t < hp.to)) continue;
            if (stateIndex(dyn, t) > stateIndex(dyn, hp.from)) continue;   // a dynamic inside the hairpin wins
            var v0 = valueAt(dyn, hp.from, S.DEFAULT_VELOCITY), v1 = v0 + hp.change;
            var e = stateIndex(dyn, hp.to - 1) + 1;                        // first dynamic at or after the end
            if (e < dyn.length && (hp.cresc ? dyn[e].on > v0 : dyn[e].on < v0)) v1 = dyn[e].on;
            return v0 + (v1 - v0) * (t - hp.from) / (hp.to - hp.from);
        }
        return base;
    }

}

// --- status line ---------------------------------------------------------
// Only problems, and only the kinds that occur: a count of 0 is left out, and the
// informational tallies (open strings, playable chords, div. skips) are not shown.
// Counts for problemSummary from the rows themselves — the rows the panel shows, whatever
// mix of whole-score and partial passes produced them.
function countRows(rows) {
    var c = { impossible: 0, outOfReach: 0, harmBad: 0, harmRisky: 0, jeteFlagged: 0, groupsFlagged: 0,
              slursFlagged: 0, fastFlagged: 0, tremImpossible: 0, tremAcross: 0 };
    for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (r.kind === "stop") c[r.verdict === "impossible" ? "impossible" : "outOfReach"]++;
        else if (r.kind === "harmonic") c[r.verdict === "impossible" ? "harmBad" : "harmRisky"]++;
        else if (r.kind === "jete") c.jeteFlagged++;
        else if (r.kind === "group") c.groupsFlagged++;
        else if (r.kind === "slur") c.slursFlagged++;
        else if (r.kind === "fast") c.fastFlagged++;
        else if (r.kind === "tremolo") c[r.verdict === "impossible" ? "tremImpossible" : "tremAcross"]++;
    }
    return c;
}

function problemSummary(c) {
    var parts = [];
    function add(n, one, many) { if (n > 0) parts.push(n + " " + (n === 1 ? one : many)); }
    add(c.impossible,    "unplayable chord",         "unplayable chords");
    add(c.outOfReach,    "chord needs a stretch",    "chords need a stretch");
    add(c.harmBad,       "impossible harmonic",      "impossible harmonics");
    add(c.harmRisky,     "risky harmonic",           "risky harmonics");
    add(c.jeteFlagged,   "jeté stroke too long",     "jeté strokes too long");
    add(c.groupsFlagged, "staccato group too long",   "staccato groups too long");
    add(c.slursFlagged,  "slur too long",             "slurs too long");
    add(c.fastFlagged,   "fast bass passage",         "fast bass passages");
    add(c.tremImpossible, "fingered tremolo too wide", "fingered tremolos too wide");
    add(c.tremAcross,    "fingered tremolo across strings", "fingered tremolos across strings");
    return parts.length ? parts.join(" · ") : "no problems found";
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

// Select everything a results row is about: every note of its chord, or — for a
// stroke row (a slur or jeté stroke) — every note of every chord from its
// first chord to tickEnd, grace notes included. Returns false if the first chord has
// gone.
function selectRow(score, env, row) {
    var end = row.tickEnd === undefined ? row.tick : row.tickEnd;
    if (row.grace >= 0 || end <= row.tick) return selectChord(score, env, row);
    if (!findChord(score, env, row.track, row.tick, -1)) return false;
    var cur = score.newCursor(), s = score.selection, first = true;
    cur.staffIdx = row.track >> 2;
    cur.voice = row.track % 4;
    seek(cur, row.tick);
    s.clear();
    while (cur.segment && cur.tick <= end) {
        var el = cur.element;
        if (el && el.type === env.CHORD && cur.tick >= row.tick) {
            var parts = [], gs = null;
            try { gs = el.graceNotes } catch (e) {}
            if (gs) for (var g = 0; g < gs.length; g++) parts.push(gs[g]);
            parts.push(el);
            for (var p = 0; p < parts.length; p++)
                for (var n = 0; n < parts[p].notes.length; n++) {
                    s.select(parts[p].notes[n], !first);
                    first = false;
                }
        }
        cur.next();
    }
    return !first;
}

// How well a results row matches a selected chord key: 2 = the row's own chord,
// 1 = a chord inside the row's stroke (between tick and tickEnd), 0 = no match.
function rowMatch(row, key) {
    if (!key || row.track !== key.track) return 0;
    if (row.tick === key.tick && row.grace === key.grace) return 2;
    var end = row.tickEnd === undefined ? row.tick : row.tickEnd;
    if (end > row.tick && key.tick >= row.tick && key.tick <= end) return 1;
    return 0;
}

// Does the selection hold notes of more than one chord? (Then no fingerboard.)
function selectionSpansChords(score, env) {
    var els = null, first = null;
    try { els = score.selection.elements } catch (e) { return false; }
    if (!els) return false;
    for (var i = 0; i < els.length; i++) {
        var k = keyOfElements([els[i]], env);
        if (!k) continue;
        if (!first) first = k;
        else if (k.tick !== first.tick || k.track !== first.track || k.grace !== first.grace) return true;
    }
    return false;
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

    var chordCircle = mapHas(circles, key.track, key.tick);
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
        if (h && h.verdict !== "impossible") {
            var all = H.inspectNatural(instr, list);        // every string, node and sounding pitch
            if (all) return (h.verdict === "ok" ? "natural harmonic" : h.reason) + "\n" + all;
        }
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
    var chordCircle = mapHas(circles, key.track, key.tick);
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
    var onlyStaves = opts && opts.staves ? opts.staves : null;
    var cleared = 0, uncovered = 0;
    if (useCmd) score.startCmd();
    for (var st = 0; st < score.nstaves; st++)
        for (var v = 0; v < 4; v++) {
            if (onlyStaves && onlyStaves.indexOf(st) < 0) break;
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
