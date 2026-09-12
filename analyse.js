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

// staffIdx -> { instr, name }
function staffInstruments(score) {
    var map = [];
    for (var p = 0; p < score.parts.length; p++) {
        var part = score.parts[p];
        var id = "", ln = "";
        try { id = part.instrumentId } catch (e) {}
        try { ln = part.longName || part.partName || "" } catch (e) {}
        var instr = S.lookup(id, ln);
        var first = part.startTrack >> 2, last = part.endTrack >> 2;
        for (var s = first; s < last; s++)
            map[s] = { instr: instr, name: ln || ("staff " + (s + 1)) };
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

// --- analysis ------------------------------------------------------------
// env  : { CHORD: Element.CHORD, DIAMOND: NoteHeadGroup.HEAD_DIAMOND }
// range: optional { from, to } in ticks — live mode passes the layout range of
//        the edit so only the affected bars are re-examined.
// Returns { rows, marks, counts }. Nothing is written to the score here.
function analyse(score, env, range) {
    var starts = barMap(score), staves = staffInstruments(score);
    var rows = [], marks = [];
    var counts = { open: 0, playable: 0, outOfReach: 0, impossible: 0, div: 0, harmonics: 0 };
    var from = range && range.from >= 0 ? range.from : -1;
    var to   = range && range.to   >= 0 ? range.to   : -1;

    for (var st = 0; st < score.nstaves; st++) {
        var info = staves[st];
        if (!info || !info.instr) continue;
        var instr = info.instr;
        var changes = divChanges(score, st, range);

        // one chord (ordinary or grace): mark it and, if it is a stop, judge it
        var handle = function (chordEl, tick) {
            var ns = chordEl.notes, list = [], harmonic = false;
            for (var i = 0; i < ns.length; i++) {
                if (ns[i].headGroup === env.DIAMOND) { harmonic = true; break; }
                list.push({ note: ns[i], pitch: ns[i].pitch });
            }
            if (harmonic) { counts.harmonics++; return; }
            if (!list.length) return;

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
