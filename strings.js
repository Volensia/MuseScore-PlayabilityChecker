// Bowed-string data and rules for the Orchestration Checker plugin.
// All pitches are SOUNDING MIDI numbers: note.pitch in the plugin API is always
// sounding, and the double bass is the only transposing string instrument, so
// working in sounding pitch avoids needing the transposition at all.
//
// Sources (Adler, The Study of Orchestration, 3rd ed.):
//   open strings and string numbering ............ p. 9 (Ex 2-1…2-5), p. 44
//   adjacent strings, one note per string ........ p. 11
//   double bass needs an open string ............. p. 11 (Ex 2-10), p. 86
//
// Hand stretch (Forsyth, Orchestration, Macmillan 1914) — quantified per
// instrument, and explicitly limited to the lower positions:
//   vn  p. 357 fn  same string 1st–4th = aug 4th; across strings = minor 9th
//                  "These restrictions ... apply only to the lower positions."
//   va  p. 391     "reduced respectively to a perfect fourth and an octave"
//   vc  p. 425     same string major 3rd; across strings minor 7th
//   cb  p. 441     "when the hand is closest to the nut the maximum stretch
//                  between the 1st and 4th fingers is only a whole-tone"
//   vn  p. 319     "double-stops above the 3rd position are practically unknown"
// Corroboration for the position effect: Galamian's hand "frame" gets smaller
// the higher up the fingerboard you play — Simon Fischer, "Basics: Changing
// position", The Strad, July 2011, p. 1.
.pragma library

// Deliberately the same two colours MuseScore itself paints on notes outside an
// instrument's range (note.cpp, Note::draw): Qt::red for out of professional
// range, Qt::darkYellow for out of amateur range. A flagged chord is coloured
// whole; open strings keep their own teal.
var COLOR = {
    open:       "#00a0b0",  // note available on an open string
    impossible: "#ff0000",  // stop that cannot be played
    outOfReach: "#808000",  // stop that fits no hand position (a stretch)
    black:      "#000000"
};

// colours from the earlier per-string scheme, still recognised so that scores
// marked by an older version can be cleared
var LEGACY = ["#7b3fa0", "#2e8b45", "#c77800", "#2d4cb5", "#5b6b7a", "#c0007a", "#e4572e"];

function palette() { return [COLOR.open, COLOR.impossible, COLOR.outOfReach]; }

function isOurColor(c) {
    var s = String(c).toLowerCase(), all = palette();
    for (var i = 0; i < all.length; i++) if (s === all[i]) return true;
    for (var j = 0; j < LEGACY.length; j++) if (s === LEGACY[j]) return true;
    return false;
}

// strings: sounding MIDI, string I (highest) first.
//
// span0    the 1st–4th finger stretch on ONE string, at the nut, in semitones.
//          Forsyth's headline figure. Not used by the multiple-stop rules (each
//          note of a stop is on its own string) but kept as the sourced anchor.
// crossMax how much further up the neck the higher string may be stopped than
//          its neighbour, at the nut, in semitones. Forsyth gives this as a
//          sounding interval with the 1st finger on the lower string and the 4th
//          on the next higher one, so the tuning gap comes off:
//              vn  minor 9th 13 − P5 7 = 6      va  octave 12 − 7 = 5
//              vc  minor 7th 10 − P5 7 = 3
//          The bass is the exception: Forsyth gives no interval for it, so it
//          reuses its same-string whole tone (derived, conservative).
var INSTRUMENTS = {
    "strings.violin":     { name: "Violin",      strings: [76, 69, 62, 55],
                            span0: 6, crossMax: 6 },
    "strings.viola":      { name: "Viola",       strings: [69, 62, 55, 48],
                            span0: 5, crossMax: 5 },
    "strings.cello":      { name: "Cello",       strings: [57, 50, 43, 36],
                            span0: 4, crossMax: 3 },
    "strings.contrabass": { name: "Double bass", strings: [43, 38, 33, 28],
                            span0: 2, crossMax: 2, requireOpenString: true }
};

// Fallback when instrumentId is missing or unusual: match the part's long name.
var NAME_HINTS = [
    [/violoncell|cello|\bvc\b/,               "strings.cello"],
    [/contrabass|double\s*bass|kontrabass|\bcb\b/, "strings.contrabass"],
    [/viola|bratsche|\bvla\b/,                "strings.viola"],
    [/violin|violine|geige|\bvln\b/,          "strings.violin"]
];

function lookup(instrumentId, longName) {
    if (instrumentId && INSTRUMENTS[instrumentId]) return INSTRUMENTS[instrumentId];
    if (instrumentId)
        for (var key in INSTRUMENTS)                    // e.g. "strings.violin-section"
            if (instrumentId.indexOf(key) === 0) return INSTRUMENTS[key];
    var n = (longName || "").toLowerCase();
    for (var i = 0; i < NAME_HINTS.length; i++)
        if (NAME_HINTS[i][0].test(n)) return INSTRUMENTS[NAME_HINTS[i][1]];
    return null;
}

// one decimal, no trailing ".0" — the Python cross-check model formats to match
function fmtReach(x) { return String(Math.round(x * 10) / 10); }

var NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
function noteName(pitch) { return NAMES[pitch % 12] + (Math.floor(pitch / 12) - 1); }
var ROMAN = ["I", "II", "III", "IV", "V"];

// S1 ----------------------------------------------------------------------
function openStringIndex(instr, pitch) {
    for (var i = 0; i < instr.strings.length; i++)
        if (instr.strings[i] === pitch) return i;
    return -1;
}

// S2 ----------------------------------------------------------------------
// One note per string, all on adjacent strings, highest note on the highest of
// them: so an assignment is a window of consecutive string indices.

// How far the hand can reach, in semitones of fingerboard offset, when its
// nearest stopped note sits `pos` semitones above the open string.
//
// Stopping points follow x(n) = L(1 − 2^(−n/12)), so one physical hand span
// covers MORE semitones the higher the hand sits. That is why Forsyth's limits
// "apply only to the lower positions" (p. 357) and why Galamian's frame "gets
// smaller the higher up the fingerboard you play" (Fischer, The Strad, 7/2011).
//
// The string length cancels: H/L = 1 − 2^(−crossMax/12), so no mensur estimate
// enters the rules. At pos = 0 this returns crossMax exactly.
function reachAt(instr, pos) {
    if (!(pos > 0)) return instr.crossMax;
    var r = Math.pow(2, -pos / 12) - 1 + Math.pow(2, -instr.crossMax / 12);
    if (r <= 0.03) return 24;                           // hand is far up: unrestricted
    return (-12 * Math.log(r) / Math.LN2) - pos;
}

function stretchOf(instr, pitches, assign) {
    var stopped = 0, worst = 0, lowest = -1;
    for (var i = 0; i < pitches.length; i++) {
        var off = pitches[i] - instr.strings[assign[i]];
        if (off > 0) {
            stopped++;
            if (lowest < 0 || off < lowest) lowest = off;   // where the hand sits
        }
    }
    for (var j = 0; j + 1 < pitches.length; j++) {
        var a = pitches[j] - instr.strings[assign[j]];
        var b = pitches[j + 1] - instr.strings[assign[j + 1]];
        if (a === 0 || b === 0) continue;               // open strings cost nothing
        var d = Math.abs(a - b);
        if (d > worst) worst = d;
    }
    return { stopped: stopped, worst: worst, position: lowest < 0 ? 0 : lowest };
}

// pitches must be descending. Returns:
//   verdict "playable" | "outOfReach" | "impossible"
//   assign  string index per note (partial and with -1 for the orphan when impossible)
//   reason  short text for the results list
//   worst   largest stretch in semitones
function analyseStop(instr, pitches) {
    var n = pitches.length, nStrings = instr.strings.length;

    if (n > nStrings)
        return { verdict: "impossible", assign: orphanAssign(instr, pitches),
                 reason: "more notes than strings", worst: 0 };

    var best = null, bestCost = null, reach = null, reachCost = null, reachAllow = 0;
    for (var top = 0; top + n <= nStrings; top++) {
        var assign = [], ok = true;
        for (var k = 0; k < n; k++) {
            if (pitches[k] < instr.strings[top + k]) { ok = false; break; }
            assign.push(top + k);
        }
        if (!ok) continue;
        var cost = stretchOf(instr, pitches, assign);
        var allow = reachAt(instr, cost.position);      // position-aware, see reachAt
        if (cost.worst <= allow) {
            if (!best || cost.stopped < bestCost.stopped) { best = assign; bestCost = cost; }
        } else if (!reach || cost.worst - allow < reachCost.worst - reachAllow) {
            reach = assign; reachCost = cost; reachAllow = allow;   // least over the limit
        }
    }

    if (best) {
        if (instr.requireOpenString && bestCost.stopped === n)
            return { verdict: "outOfReach", assign: best, worst: bestCost.worst,
                     reason: "no open string" };
        return { verdict: "playable", assign: best, worst: bestCost.worst, reason: "" };
    }
    if (reach)
        return { verdict: "outOfReach", assign: reach, worst: reachCost.worst,
                 reason: "stretch " + reachCost.worst + " st, max " +
                         fmtReach(reachAllow) + " here" };

    var partial = orphanAssign(instr, pitches);
    return { verdict: "impossible", assign: partial.assign, reason: partial.reason, worst: 0 };
}

// No window fits. Hand out strings greedily from the lowest note up so the
// notes that do have a home keep their colour, and name the clash.
function orphanAssign(instr, pitches) {
    var used = {}, assign = [], reason = "", nStrings = instr.strings.length;
    for (var i = pitches.length - 1; i >= 0; i--) {          // lowest first
        var got = -1;
        for (var s = nStrings - 1; s >= 0; s--)
            if (!used[s] && pitches[i] >= instr.strings[s]) { got = s; used[s] = true; break; }
        assign[i] = got;
        if (got < 0 && !reason)
            reason = pitches[i] < instr.strings[nStrings - 1]
                   ? "below the lowest string"
                   : "same string (" + sharedString(instr, pitches, i) + ")";
    }
    return { assign: assign, reason: reason || "strings not adjacent" };
}

// Which string do this note and a neighbour both need?
function sharedString(instr, pitches, i) {
    for (var s = instr.strings.length - 1; s >= 0; s--)
        if (pitches[i] >= instr.strings[s]) return stringName(instr.strings[s]);
    return "?";
}

// A string is called by its letter — "the G string" — never "the G3 string".
// Every standard open string is a natural, so the pitch class is the name.
function stringName(openPitch) { return NAMES[openPitch % 12]; }

// A chord is named from the bottom note up. pitches (and res.assign) arrive
// sorted high to low for analyseStop, so walk them backwards.
function describe(instr, pitches, res) {
    var parts = [];
    for (var i = pitches.length - 1; i >= 0; i--) {
        var s = res.assign ? res.assign[i] : -1;
        parts.push(noteName(pitches[i]) + (s >= 0 ? " (" + ROMAN[s] + ")" : " (—)"));
    }
    return parts.join(" + ");
}

// div. state (Adler p. 12). Returns true (div. on), false (off) or null (no keyword).
var DIV_ON  = /\bdiv(\.|isi|is[ée]s)?\b|geteilt|\bdiv\s*a\s*\d/i;
var DIV_OFF = /\bunis(\.|on[oi]?)?\b|\bnon\s*div/i;
function divState(text) {
    if (DIV_OFF.test(text)) return false;
    if (DIV_ON.test(text))  return true;
    return null;
}

// --- S10 jeté --------------------------------------------------------------
// A jeté (ricochet) stroke throws the bow so it bounces through a group of notes.
// Notation (Forsyth p. 342): a slur over the group with a dot over each note — so
// a dotted slur is one stroke. Without a word asking for jeté a dotted slur is just
// as likely portato or slurred staccato, so only a jeté text turns the check on, and
// Adler's cancel words (p. 33: ord., naturale, normale, in modo ordinario) or a
// change to another stroke turn it off.
//
// Limits, Adler p. 27: in the orchestra "no more than three bouncing notes at a time"
// — a suggestion, since solo players manage more — so more than 3 on violin and
// viola is a warning. Cello and bass bows are shorter: "three, or at most four ...
// are the limit of what can be played", so more than 4 there is flagged as
// unplayable. A 4-note stroke on cello or bass is within Adler's limit.
//
// Saltato / saltando is the Italian for sautillé (Forsyth p. 341 footnote), one note
// per bow, so it does not switch jeté on.
var JETE_ON  = /(^|[^a-z])(jet[ée]|gettato|ricochet)(?![a-z])/i;
var JETE_OFF = /(^|[^a-z])(ord(\.|in)|nat(\.|ural)|norm(\.|al)|modo\s+ordinario|d[ée]tach|legato|spicc|sautill|martel|pizz|col\s+legno|arco)/i;
function jeteState(text) {
    if (JETE_ON.test(text))  return true;
    if (JETE_OFF.test(text)) return false;
    return null;
}

// Bowing stops altogether under pizz. until arco, so no slur is a bow stroke there.
function pizzState(text) {
    if (/(^|[^a-z])pizz/i.test(text)) return true;
    if (/(^|[^a-z])arco(?![a-z])/i.test(text)) return false;
    return null;
}

// Dynamic level, as the MIDI-style velocity MuseScore stores on each Dynamic
// (verified on 3.6.2): pppp 10, ppp 16, pp 33, p 49, mp 64, mf 80, f 96, ff 112,
// fff 126. A dynamic that changes after its attack also carries veloChange, and the
// level it settles at is velocity + veloChange: fp 96-47 = 49, pf 49+47 = 96,
// sfp 112-47 = 65, sfpp 112-79 = 33. Reading the numbers rather than the letters
// means a dynamic with a custom velocity is judged by what it plays.
//
// Accents — sf, sfz, sff(z), fz, rf, rfz and the lone letters — are one-note stresses,
// not a new level, so they return null and the level in force carries on. (MuseScore's
// own playback keeps sf/sfz at 94 until the next dynamic; that is not how players read
// them.) Anything that ends in p (sfp, sfpp) is a level.
//
// `el` is the element when there is one; staff text such as a typed "f" has no
// velocity and falls back to the letters. Returns a velocity, or null.
var DYN_VELOCITY = { pppppp: 1, ppppp: 5, pppp: 10, ppp: 16, pp: 33, p: 49, mp: 64, mf: 80,
                     f: 96, ff: 112, fff: 126, ffff: 127, fffff: 127, ffffff: 127,
                     fp: 49, pf: 96, sfp: 65, sfpp: 33 };
function dynamicVelocity(text, el) {
    var t = String(text).replace(/\s+/g, "").toLowerCase();
    var letters = /^[pmfrszn]+$/.test(t);
    if (letters && !/p$/.test(t) && (/^(s|r)/.test(t) || t === "fz" || /^[mrsz]$/.test(t))) return null;
    var v, dv;
    try { v = el ? el.velocity : undefined; dv = el ? el.veloChange : undefined; } catch (e) {}
    if (typeof v === "number" && v > 0) return v + (typeof dv === "number" ? dv : 0);
    if (letters && DYN_VELOCITY[t] !== undefined) return DYN_VELOCITY[t];
    return null;
}

// true = f or louder (settled velocity 89 and up, between mf 80 and f 96), false =
// softer; mf counts as soft (Wagner p. 35 contrasts "the softer dynamics" with
// "forte-fortissimo").
var LOUD_VELOCITY = 89;
function isLoud(velocity) { return velocity >= LOUD_VELOCITY; }
function dynamicLevel(text, el) {
    var v = dynamicVelocity(text, el);
    return v === null ? null : isLoud(v);
}

// S11 tiers, split halfway between MuseScore's default velocities. mp goes with p
// (Forsyth p. 390 and 446 pair p with mp); ppp and softer with pp, fff with ff.
function dynamicTier(velocity) {
    if (velocity <= 40) return "pp";
    if (velocity <= 72) return "p";
    if (velocity <= 88) return "mf";
    if (velocity <= 104) return "f";
    return "ff";
}
var TIER_ORDER = { pp: 0, p: 1, mf: 2, f: 3, ff: 4 };

// --- S11 bow capacity -----------------------------------------------------
// Longest slur, in seconds, on one bow. Violin figures: Sevsay p. 10 gives the scale
// 12 / 6 / 3 / 1 / 0.5 s for pp / p / mf / f / ff; the warn and red values are ours,
// set inside the range the other sources give (sourcebook T7, S11):
//   pp  12 / 15  Widor p. 163, Forsyth p. 343 ≈ 10–13 s; Askenfelt 1986 p. 1011 and
//                Flesch p. 64: about 15 s is the slowest steady bow
//   p    6 / 12  Wagner p. 30: 6.7–8.9 s up to andante
//   mf   3 /  6  Russo: one bar at mp
//   f  2.5 / 4.5 Forsyth p. 390: 2–3 crotchets of moderato; Schoonderwaldt 2009 p. 2715:
//                a 4 s note at f only reaches mf loudness; Wagner p. 30: 3.3–4.4 s
//   ff 1.5 /  3  Sevsay 0.5 s; Russo two beats
// Viola as violin. Cello and bass × 0.6 — derived: Forsyth p. 445 has the bass bow
// changed every 3–4 s at p against Sevsay's 6 s for violin at p. No source gives a
// cello figure. Without any dynamic the passage is taken as mf.
var BOW_SECONDS = { pp: { warn: 12,  red: 15 }, p:  { warn: 6,   red: 12 },
                    mf: { warn: 3,   red: 6 },  f:  { warn: 2.5, red: 4.5 },
                    ff: { warn: 1.5, red: 3 } };
var BOW_FACTOR = { "Violin": 1, "Viola": 1, "Cello": 0.6, "Double bass": 0.6 };
var DEFAULT_VELOCITY = 80;
function bowLimit(instr, tier) {
    if (!instr || BOW_FACTOR[instr.name] === undefined || !BOW_SECONDS[tier]) return null;
    var f = BOW_FACTOR[instr.name];
    return { warn: BOW_SECONDS[tier].warn * f, red: BOW_SECONDS[tier].red * f };
}

// Group staccato — dots under a slur with no jeté asked for. Wagner p. 35: "four to
// six notes in one bow is a safe maximum for the softer dynamics in moderate tempos.
// Three notes in one bow should not be exceeded in the forte-fortissimo levels."
// Same for every bowed string (he gives no per-instrument figures). Before any
// dynamic the soft limit applies. Tempo is not read.
var GROUP_STACCATO_LIMIT = { soft: 6, loud: 3, verdict: "outOfReach" };

var JETE_LIMIT = {
    "Violin":      { max: 3, verdict: "outOfReach" },
    "Viola":       { max: 3, verdict: "outOfReach" },
    "Cello":       { max: 4, verdict: "impossible" },
    "Double bass": { max: 4, verdict: "impossible" }
};
function jeteLimit(instr) { return instr ? JETE_LIMIT[instr.name] || null : null; }

// Staccato-type articulations that make a slur a bounced stroke. Portato (tenuto +
// staccato) is an on-the-string stroke and does not count.
function isStaccatoSymbol(sym) {
    if (sym === undefined || sym === null) return false;
    var s = String(sym);
    return /^artic(Staccato|Staccatissimo|AccentStaccato|MarcatoStaccato)/.test(s);
}
