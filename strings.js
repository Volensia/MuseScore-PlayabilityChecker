// Bowed-string data and rules for the Orchestration Checker plugin.
// All pitches are SOUNDING MIDI numbers: note.pitch in the plugin API is always
// sounding, and the double bass is the only transposing string instrument, so
// working in sounding pitch avoids needing the transposition at all.
//
// Sources (Adler, The Study of Orchestration, 3rd ed.):
//   open strings and string numbering ............ p. 9 (Ex 2-1…2-5), p. 44
//   adjacent strings, one note per string ........ p. 11
//   hand frame: vn/va a 4th, vc a 3rd, cb a 2nd .. p. 10, p. 76, p. 85
//   double bass needs an open string ............. p. 11 (Ex 2-10), p. 86
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
var INSTRUMENTS = {
    "strings.violin":     { name: "Violin",      strings: [76, 69, 62, 55], frame: 5 },
    "strings.viola":      { name: "Viola",       strings: [69, 62, 55, 48], frame: 5 },
    "strings.cello":      { name: "Cello",       strings: [57, 50, 43, 36], frame: 4 },
    "strings.contrabass": { name: "Double bass", strings: [43, 38, 33, 28], frame: 2,
                            requireOpenString: true }
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

function stretchOf(instr, pitches, assign) {
    var stopped = 0, worst = 0;
    for (var i = 0; i < pitches.length; i++)
        if (pitches[i] - instr.strings[assign[i]] > 0) stopped++;
    for (var j = 0; j + 1 < pitches.length; j++) {
        var a = pitches[j] - instr.strings[assign[j]];
        var b = pitches[j + 1] - instr.strings[assign[j + 1]];
        if (a === 0 || b === 0) continue;               // open strings cost nothing
        var d = Math.abs(a - b);
        if (d > worst) worst = d;
    }
    return { stopped: stopped, worst: worst };
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

    var best = null, bestCost = null, reach = null, reachCost = null;
    for (var top = 0; top + n <= nStrings; top++) {
        var assign = [], ok = true;
        for (var k = 0; k < n; k++) {
            if (pitches[k] < instr.strings[top + k]) { ok = false; break; }
            assign.push(top + k);
        }
        if (!ok) continue;
        var cost = stretchOf(instr, pitches, assign);
        if (cost.worst <= instr.frame) {
            if (!best || cost.stopped < bestCost.stopped) { best = assign; bestCost = cost; }
        } else if (!reach || cost.worst < reachCost.worst) { reach = assign; reachCost = cost; }
    }

    if (best) {
        if (instr.requireOpenString && bestCost.stopped === n)
            return { verdict: "outOfReach", assign: best, worst: bestCost.worst,
                     reason: "no open string" };
        return { verdict: "playable", assign: best, worst: bestCost.worst, reason: "" };
    }
    if (reach)
        return { verdict: "outOfReach", assign: reach, worst: reachCost.worst,
                 reason: "stretch " + reachCost.worst + " st" };

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
        if (pitches[i] >= instr.strings[s]) return noteName(instr.strings[s]);
    return "?";
}

function describe(instr, pitches, res) {
    var parts = [];
    for (var i = 0; i < pitches.length; i++) {
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
