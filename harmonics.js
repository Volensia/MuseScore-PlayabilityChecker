// Harmonics for the Playability Checker — S7 natural, S8 artificial.
//
// Sources (Adler, The Study of Orchestration, 3rd ed.):
//   partials and the node chart .............. p. 42 (Ex 2-68…2-72), p. 44
//   notation: a circle over the sounding note, OR a diamond at the node;
//     always name the string ................. p. 44
//   artificial: stop a note and touch a P4 above; sounds two octaves above
//     the stopped note ....................... p. 46 (Ex 2-73)
//   highest practical artificial ............. p. 47 (Ex 2-76)
//   double bass: natural harmonics only ...... p. 46, p. 50, p. 86
//   touch 5th / M3 / m3 seldom used, risky ... p. 57 (Ex 3-15…3-17)
//   cello touch-4th works throughout ......... p. 80
//
// MuseScore exposes the two notations quite differently (all verified on 3.6.2):
//   diamond at the node   -> note.headGroup === NoteHeadGroup.HEAD_DIAMOND
//   circle, Articulations palette (the default) -> an Articulation on the CHORD,
//     which the Chord will NOT hand over: it is reachable only through
//     score.selection.elements after a select-all. Its parent is the Chord and
//     the Chord's parent is the Segment, which is where the tick comes from.
//   circle, Symbols palette -> a Symbol inside note.elements
//   Both circles carry symbol id 2538. Match on the id, never on userName
//   ("Harmonic"), which is translated in a localised MuseScore.
.pragma library
.import "strings.js" as S

var HARMONIC_SYMBOL = 2538;

// touch interval above the open string (semitones) -> partial (p. 42–44)
var NODES = { 3: 6, 4: 5, 5: 4, 7: 3, 9: 5, 12: 2, 16: 5, 19: 3, 24: 4, 28: 5 };

// what each partial sounds, in semitones above the open string
var SOUNDS = { 2: 12, 3: 19, 4: 24, 5: 28, 6: 31 };

// Adler lists 1/5, 3/5 and 4/5 as orchestral; the 2/5 node (touch M6) is
// solo/chamber only.
var SOLO_ONLY = 9;

// touch intervals a hand can actually take for an artificial harmonic
var TOUCH_NAME = { 3: "m3", 4: "M3", 5: "P4", 7: "5th" };
var RISKY_TOUCH = { 3: true, 4: true, 7: true };        // p. 57

// highest practical STOPPED note for an artificial harmonic (p. 47, Ex 2-76)
var HIGHEST_STOP = { "Violin": 84, "Viola": 74, "Cello": 65 };

var ROMAN = ["I", "II", "III", "IV", "V"];


// element.symbol is NOT a Number in 3.6.2 — it is a wrapper object, measured as:
//     typeof       "object"          s === 2538      false   <- the trap
//     "" + s       "2538"            s == 2538       true
//     String(s)    "stringsHarmonic" Number(s)       2538
//     s.valueOf()  2538 (number)     s.toString()    "stringsHarmonic"
// So a strict === against the id silently matches nothing, and String() gives
// the SMuFL name rather than the number. Take either: the name is stable and
// not localised (unlike userName, "Harmonic"), the id is the fallback.
var HARMONIC_NAME = "stringsHarmonic";

function isHarmonicSymbol(sym) {
    if (sym === undefined || sym === null) return false;
    return String(sym) === HARMONIC_NAME || Number(sym) === HARMONIC_SYMBOL;
}

// Is there a harmonic circle attached to this note? (Symbols-palette route.)
function hasCircle(note) {
    var els = null;
    try { els = note.elements } catch (e) { return false; }
    if (!els) return false;
    for (var i = 0; i < els.length; i++) {
        var sym = null;
        try { sym = els[i].symbol } catch (e2) {}
        if (isHarmonicSymbol(sym)) return true;
    }
    return false;
}


// A diamond written at the node: which string and partial does it name?
function naturalAtNode(instr, touched) {
    var found = null, solo = null;
    for (var i = 0; i < instr.strings.length; i++) {
        var off = touched - instr.strings[i];
        var partial = NODES[off];
        if (!partial) continue;
        var cand = { string: i, partial: partial,
                     sounds: instr.strings[i] + SOUNDS[partial] };
        if (off === SOLO_ONLY) { if (!solo) solo = cand; }
        else if (!found) found = cand;
    }
    if (found) return { verdict: "ok", info: found, reason: "" };
    if (solo) return { verdict: "risky", info: solo,
                       reason: "2/5 node — solo and chamber only" };
    return { verdict: "impossible", info: null, reason: "no node on any string" };
}


// A circle written over the SOUNDING note: can any string produce that pitch?
function naturalAtSounding(instr, sounding) {
    for (var i = 0; i < instr.strings.length; i++)
        for (var p in SOUNDS)
            if (instr.strings[i] + SOUNDS[p] === sounding)
                return { verdict: "ok", reason: "",
                         info: { string: i, partial: parseInt(p, 10), sounds: sounding } };
    return { verdict: "impossible", info: null,
             reason: "no natural harmonic sounds this pitch" };
}


// Stop a note, touch an interval above it on the same string.
function artificial(instr, stopped, touched) {
    var iv = touched - stopped;
    var partial = NODES[iv];
    if (!TOUCH_NAME[iv] || !partial)
        return { verdict: "impossible", info: null,
                 reason: "touch " + iv + " st is not a harmonic" };

    var info = { stopped: stopped, touched: touched, partial: partial,
                 sounds: stopped + SOUNDS[partial] };

    if (instr.name === "Double bass")
        return { verdict: "risky", info: info,
                 reason: "artificial harmonic on the bass — use natural only" };
    if (RISKY_TOUCH[iv])
        return { verdict: "risky", info: info,
                 reason: "touch " + TOUCH_NAME[iv] + " — seldom used, risky" };

    var top = HIGHEST_STOP[instr.name];
    if (top !== undefined && stopped > top)
        return { verdict: "risky", info: info,
                 reason: "stopped above " + S.noteName(top) + " — insecure, may not speak" };
    return { verdict: "ok", info: info, reason: "" };
}


// Every way to play one natural harmonic. atNode: the written pitch is the node
// (diamond); otherwise it is the sounding pitch (circle). Returns
// [{ string, partial, nodes: [touched pitches], sounds, solo }], highest string first.
function naturalOptions(instr, pitch, atNode) {
    var out = [];
    for (var i = 0; i < instr.strings.length; i++) {
        var open = instr.strings[i];
        if (atNode) {
            var p = NODES[pitch - open];
            if (p) out.push({ string: i, partial: p, nodes: [pitch], sounds: open + SOUNDS[p],
                              solo: pitch - open === SOLO_ONLY });
            continue;
        }
        for (var q in SOUNDS) {
            if (open + SOUNDS[q] !== pitch) continue;
            var nodes = [], solo = true;
            for (var off in NODES)
                if (NODES[off] === parseInt(q, 10)) {
                    nodes.push(open + parseInt(off, 10));
                    if (parseInt(off, 10) !== SOLO_ONLY) solo = false;
                }
            nodes.sort(function (a, b) { return a - b; });
            out.push({ string: i, partial: parseInt(q, 10), nodes: nodes, sounds: pitch, solo: solo });
        }
    }
    return out;
}

// one line per string: "A string (II): node A5, sounds A6"
function describeOptions(instr, opts) {
    var parts = [];
    for (var i = 0; i < opts.length; i++) {
        var o = opts[i], names = [];
        for (var k = 0; k < o.nodes.length; k++)
            names.push(S.noteName(o.nodes[k]) + (o.nodes[k] - instr.strings[o.string] === SOLO_ONLY &&
                                                 o.nodes.length > 1 ? " (solo only)" : ""));
        parts.push(S.stringName(instr.strings[o.string]) + " string (" + ROMAN[o.string] + "): node " +
                   names.join(" or ") + ", sounds " + S.noteName(o.sounds) + (o.solo ? " (solo only)" : ""));
    }
    return parts.join("\n");
}

// The Selected line for a natural harmonic chord: every string, node and sounding
// pitch for each note. null when the chord is not a readable natural harmonic.
function inspectNatural(instr, list) {
    var diamonds = 0, circles = 0, i;
    for (i = 0; i < list.length; i++) {
        if (list[i].diamond) diamonds++;
        if (list[i].circle) circles++;
    }
    var atNode;
    if (diamonds && diamonds === list.length) atNode = true;        // node notation
    else if (!diamonds && circles) atNode = false;                  // sounding notation
    else return null;
    var parts = [];
    for (i = 0; i < list.length; i++) {
        var opts = naturalOptions(instr, list[i].pitch, atNode);
        if (!opts.length) return null;
        parts.push((list.length > 1 ? S.noteName(list[i].pitch) + ":\n" : "") + describeOptions(instr, opts));
    }
    return parts.join("\n");
}


function describeNatural(res, pitch) {
    if (!res.info) return S.noteName(pitch) + " (—)";
    return S.noteName(pitch) + " (" + ROMAN[res.info.string] + ") partial " +
           res.info.partial + " → sounds " + S.noteName(res.info.sounds);
}


function describeArtificial(res, stopped, touched) {
    var s = "stop " + S.noteName(stopped) + " + touch " + S.noteName(touched);
    if (res.info) s += " → sounds " + S.noteName(res.info.sounds);
    return s;
}


// list: [{ note, pitch, diamond, circle }], any order.
// Returns null when the chord is not a harmonic at all, otherwise
// { verdict: "ok"|"risky"|"impossible", reason, detail }.
function classify(instr, list) {
    var diamonds = [], plain = [], circles = 0, i;
    for (i = 0; i < list.length; i++) {
        if (list[i].diamond) diamonds.push(list[i]); else plain.push(list[i]);
        if (list[i].circle) circles++;
    }
    if (!diamonds.length && !circles) return null;      // an ordinary chord

    // stopped note + diamond a touch-interval above: an artificial harmonic
    if (diamonds.length === 1 && plain.length === 1) {
        var st = plain[0].pitch, to = diamonds[0].pitch;
        if (to > st) {
            var a = artificial(instr, st, to);
            return { verdict: a.verdict, reason: a.reason,
                     detail: describeArtificial(a, st, to) };
        }
    }

    // diamonds only: one natural harmonic per note, written at its node. Several
    // together is a legitimate chord of harmonics, so judge each and report the
    // worst. NOTE: we do not check that they need different strings — naturalAtNode
    // takes the first string that fits rather than searching assignments the way
    // analyseStop does, so a naive clash test would invent false positives.
    if (diamonds.length && !plain.length) {
        var dWorst = "ok", dReason = "", dParts = [];
        for (i = 0; i < diamonds.length; i++) {
            var d = naturalAtNode(instr, diamonds[i].pitch);
            dParts.push(describeNatural(d, diamonds[i].pitch));
            if (d.verdict === "impossible" || (d.verdict === "risky" && dWorst === "ok")) {
                dWorst = d.verdict;
                dReason = d.reason;
            }
        }
        return { verdict: dWorst, reason: dReason, detail: dParts.join(" + ") };
    }

    // circles only: each note is written at its sounding pitch
    if (!diamonds.length) {
        var worst = "ok", reason = "", parts = [];
        for (i = 0; i < list.length; i++) {
            var r = naturalAtSounding(instr, list[i].pitch);
            parts.push(describeNatural(r, list[i].pitch));
            if (r.verdict === "impossible" ||
                (r.verdict === "risky" && worst === "ok")) {
                worst = r.verdict;
                reason = r.reason;
            }
        }
        return { verdict: worst, reason: reason, detail: parts.join(" + ") };
    }

    // anything else (several diamonds, diamonds mixed with circles): we do not
    // pretend to read it, but we do not call it impossible either.
    return { verdict: "risky", reason: "unrecognised harmonic notation",
             detail: list.length + " notes" };
}
