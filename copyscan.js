// Copy reader: slurs, staccato dots, hairpins and harmonic circles from a written
// copy of the score (MuseScore 3 .mscx), without touching the selection. Replaces the
// select-all that used to borrow the user's selection (see SPEC-strings.md, "Copy
// reader"). The same file runs inside a WorkerScript, so it has no imports and uses no
// QML types.
//
// copyScan(xml, measureStarts, wantStaff) -> { bowing: { slurs, dots, hairpins }, circles }
//   measureStarts : tick of every measure, from the live score (analyse.js barMap), so
//                   irregular measures and time signatures need no arithmetic here
//   wantStaff     : optional function(staffIdx) -> bool; other staves are skipped cheaply
// Maps are per track: dots[track][tick], circles[track][tick], slurs[track] = [{from,to}],
// hairpins[staffIdx] = [{from, to, cresc, change}] — the shapes analyse.js buildBowMap and
// buildCircleMap return. Checked equal to them on every test score (proto/xmlscan-check.qml).
//
// Positions inside a measure come from note values: durationType + dots, scaled by any
// enclosing <Tuplet>…<endTuplet/>; grace chords take no time; <location> in a voice jumps
// forward. A spanner's end is its <next><location> (measures + fractions) relative to
// where it starts.
.pragma library

var CS_DUR = { longa: 7680, breve: 3840, whole: 1920, half: 960, quarter: 480, eighth: 240,
            "16th": 120, "32nd": 60, "64th": 30, "128th": 15, "256th": 7.5, "512th": 3.75, "1024th": 1.875 };
var CS_GRACE = /^(acciaccatura|appoggiatura|grace4|grace8after|grace16|grace16after|grace32|grace32after)$/;

function csFrac(txt) {
    var m = /(-?\d+)\/(\d+)/.exec(txt);
    return m ? 1920 * parseInt(m[1]) / parseInt(m[2]) : 0;
}

// Scanning one 9 MB string with a single global regex slowed down more than linearly in
// MuseScore's JavaScript engine (full score 1.4 s warm vs 130 ms for half the staves),
// so the copy is cut into one slice per staff first and each slice is scanned alone.
function copyScan(xml, measureStarts, wantStaff) {
    var out = copyScanEmpty(), slices = copyStaffSlices(xml);
    for (var i = 0; i < slices.length; i++)
        if (!wantStaff || wantStaff(slices[i].staff)) copyScanStaff(xml, slices[i], measureStarts, out);
    return copyScanFinish(out);
}

function copyScanEmpty() { return { bowing: { slurs: {}, dots: {}, hairpins: {}, tremolos: {} }, circles: {} }; }

// Where each staff's measures sit in the copy: [{ staff, start, end }]. The main score's
// staves come after the last </Part> and stop at the first nested <Score> (a part).
function copyStaffSlices(xml) {
    var list = [], from = xml.lastIndexOf("</Part>");
    var stop = xml.indexOf("<Score>", from);
    if (stop < 0) stop = xml.length;
    var at = xml.indexOf("<Staff id=", from);
    while (at >= 0 && at < stop) {
        var idEnd = xml.indexOf(">", at);
        var end = xml.indexOf("</Staff>", idEnd);
        if (end < 0) break;
        list.push({ staff: parseInt(xml.substring(at + 11, idEnd)) - 1, start: at, end: end + 8 });
        at = xml.indexOf("<Staff id=", end);
    }
    return list;
}

// Scan one staff slice into `out`. Each slice is scanned as its own string: one global
// regex over the whole copy was slower than the sum of its parts.
function copyScanStaff(xml, slice, measureStarts, out) {
    copyScanSlice(xml.substring(slice.start, slice.end), measureStarts, out);
}

function copyScanFinish(out) {
    for (var k in out.bowing.slurs) out.bowing.slurs[k].sort(function (x, y) { return x.from - y.from; });
    return out;
}

// A string per staff that changes whenever that staff's slurs, dots, hairpins or circles
// do — compared between reads to re-check only the staves that changed.
function copyStaffSignature(maps, st) {
    var parts = [];
    for (var v = 0; v < 4; v++) {
        var t = st * 4 + v, sl = maps.bowing.slurs[t], d = maps.bowing.dots[t], c = maps.circles[t];
        parts.push(sl ? sl.map(function (x) { return x.from + "-" + x.to; }).join(",") : "");
        parts.push(d ? Object.keys(d).join(",") : "");
        parts.push(c ? Object.keys(c).join(",") : "");
        var tr = maps.bowing.tremolos ? maps.bowing.tremolos[t] : null;
        parts.push(tr ? Object.keys(tr).join(",") : "");
    }
    var h = maps.bowing.hairpins[st];
    parts.push(h ? h.map(function (x) { return x.from + "-" + x.to + (x.cresc ? "<" : ">") + x.change; }).join(",") : "");
    return parts.join("|");
}

function copyScanSlice(xml, measureStarts, out) {
    var from = 0, stop = xml.length, wantStaff = null;   // one staff per call
    var re = /<(\/?)(Staff|Measure|voice|Chord|Rest|Tuplet|endTuplet|normalNotes|actualNotes|durationType|dots|duration|location|measures|fractions|Spanner|next|prev|subtype|veloChange|Articulation|Tremolo|acciaccatura|appoggiatura|grace4|grace8after|grace16|grace16after|grace32|grace32after)\b([^>]*?)(\/?)>([^<]*)/g;
    re.lastIndex = from;
    var staff = -1, skip = false, mi = -1, track = 0, pos = 0, voice = -1;
    var tuplets = [], ratio = 1, pendingTuplet = null;
    var chord = null, rest = null, sp = null, where = null, loc = null, inArt = false, inTrem = false;
    var m;
    while ((m = re.exec(xml)) !== null && m.index < stop) {
        var close = m[1] === "/", tag = m[2], attrs = m[3], selfClose = m[4] === "/", text = m[5];
        if (tag === "Staff") {
            if (close) { staff = -1; continue; }
            var idm = /id="(\d+)"/.exec(attrs);
            staff = idm ? parseInt(idm[1]) - 1 : staff + 1;
            skip = wantStaff ? !wantStaff(staff) : false;
            mi = -1;
            if (skip) {                                   // jump over this staff's text entirely
                var end = xml.indexOf("</Staff>", re.lastIndex);
                if (end < 0) break;
                re.lastIndex = end;
            }
            continue;
        }
        if (staff < 0) continue;
        if (tag === "Measure") { if (!close) { mi++; voice = -1; } continue; }
        if (tag === "voice") {
            if (!close) { voice++; track = staff * 4 + voice; pos = 0; tuplets = []; ratio = 1; }
            continue;
        }
        var mStart = measureStarts[mi] || 0;
        // spanners: open, read next/prev location, close
        if (tag === "Spanner") {
            if (!close) {
                var tm = /type="([^"]+)"/.exec(attrs);
                sp = { type: tm ? tm[1] : "", start: chord ? chord.pos : pos, next: null, sub: -1, velo: 0, inChord: !!chord };
            } else if (sp) {
                if (sp.next) {
                    var sEnd = (measureStarts[mi + sp.next.m] || 0) + sp.start + sp.next.f;
                    var sFrom = mStart + sp.start;
                    if (sp.type === "Slur") {
                        if (!out.bowing.slurs[track]) out.bowing.slurs[track] = [];
                        out.bowing.slurs[track].push({ from: sFrom, to: sEnd });
                    } else if (sp.type === "HairPin" && sp.sub >= 0 && sp.sub <= 3) {
                        if (!out.bowing.hairpins[staff]) out.bowing.hairpins[staff] = [];
                        out.bowing.hairpins[staff].push({ from: sFrom, to: sEnd, cresc: sp.sub === 0 || sp.sub === 2, change: sp.velo });
                    }
                }
                sp = null;
            }
            continue;
        }
        if (sp) {
            if (tag === "next" && !close) where = "next";
            else if (tag === "prev" && !close) where = "prev";
            else if ((tag === "next" || tag === "prev") && close) where = null;
            else if (tag === "location" && !close && !selfClose && where === "next") { loc = { m: 0, f: 0 }; sp.next = loc; }
            else if (tag === "measures" && !close && where === "next" && loc) loc.m = parseInt(text);
            else if (tag === "fractions" && !close && where === "next" && loc) loc.f = csFrac(text);
            else if (tag === "subtype" && !close && where === null) sp.sub = parseInt(text);
            else if (tag === "veloChange" && !close) sp.velo = parseInt(text) || 0;
            continue;
        }
        if (tag === "Tuplet" && !close && !selfClose && !chord && !rest) { pendingTuplet = { n: 1, a: 1 }; continue; }
        if (tag === "Tuplet" && close && pendingTuplet) {
            tuplets.push(pendingTuplet.n / pendingTuplet.a);
            ratio = 1; for (var t = 0; t < tuplets.length; t++) ratio *= tuplets[t];
            pendingTuplet = null; continue;
        }
        if (pendingTuplet) {
            if (tag === "normalNotes" && !close) pendingTuplet.n = parseInt(text);
            else if (tag === "actualNotes" && !close) pendingTuplet.a = parseInt(text);
            continue;
        }
        if (tag === "endTuplet") { tuplets.pop(); ratio = 1; for (var u = 0; u < tuplets.length; u++) ratio *= tuplets[u]; continue; }
        if (tag === "Chord") {
            if (!close) { chord = { pos: pos, dur: "quarter", dots: 0, grace: false, arts: [], trem: "" }; continue; }
            if (chord) {
                if (!chord.grace) {
                    var tick = mStart + chord.pos;
                    for (var a = 0; a < chord.arts.length; a++) {
                        var sym = chord.arts[a];
                        if (/^artic(Staccato|Staccatissimo|AccentStaccato|MarcatoStaccato)/.test(sym)) (out.bowing.dots[track] || (out.bowing.dots[track] = {}))[tick] = true;
                        else if (sym === "stringsHarmonic") (out.circles[track] || (out.circles[track] = {}))[tick] = true;
                    }
                    // a tremolo "between notes" (c8, c16, c32, c64) is a fingered tremolo to the next chord
                    if (/^c\d/.test(chord.trem)) (out.bowing.tremolos[track] || (out.bowing.tremolos[track] = {}))[tick] = true;
                    var base = CS_DUR[chord.dur] || 0;
                    pos += base * (2 - Math.pow(0.5, chord.dots)) * ratio;
                }
                chord = null;
            }
            continue;
        }
        if (tag === "Rest") {
            if (!close) { rest = { dur: "quarter", dots: 0, measureDur: -1 }; continue; }
            if (rest) {
                if (rest.dur === "measure" && rest.measureDur >= 0) pos += rest.measureDur;
                else pos += (CS_DUR[rest.dur] || 0) * (2 - Math.pow(0.5, rest.dots)) * ratio;
                rest = null;
            }
            continue;
        }
        var cr = chord || rest;
        if (cr) {
            if (tag === "durationType" && !close) cr.dur = text.trim();
            else if (tag === "dots" && !close) cr.dots = parseInt(text) || 0;
            else if (tag === "duration" && !close && rest) rest.measureDur = csFrac(text);
            else if (chord && CS_GRACE.test(tag)) chord.grace = true;
            else if (chord && tag === "Articulation" && !close) inArt = true;
            else if (chord && tag === "Articulation" && close) inArt = false;
            else if (chord && inArt && tag === "subtype" && !close) chord.arts.push(text.trim());
            else if (chord && tag === "Tremolo" && !close && !selfClose) inTrem = true;
            else if (chord && tag === "Tremolo" && close) inTrem = false;
            else if (chord && inTrem && tag === "subtype" && !close) chord.trem = text.trim();
            continue;
        }
        if (tag === "location" && !close && !selfClose) { loc = { voiceJump: true }; continue; }
        if (tag === "fractions" && !close && loc && loc.voiceJump) { pos += csFrac(text); continue; }
        if (tag === "location" && close) { loc = null; continue; }
    }
}

// Inside a WorkerScript (the plugin writes this file, without its .pragma line, to the
// temp folder): message { xml, starts, staves: [staffIdx, …] } -> reply { maps, scanMs }.
if (typeof WorkerScript !== "undefined") {
    WorkerScript.onMessage = function (msg) {
        var t0 = Date.now(), want = {};
        for (var i = 0; i < msg.staves.length; i++) want[msg.staves[i]] = true;
        var maps = copyScan(msg.xml, msg.starts, function (st) { return !!want[st]; });
        WorkerScript.sendMessage({ id: msg.id, maps: maps, scanMs: Date.now() - t0 });
    };
}
