import { cachedInfo } from './bpm.js?v=mwxyzbwv';
// Beat maps without audio analysis.
// Spotify's /audio-features and /audio-analysis are closed to new apps (Nov 2024), and the
// page can't read Spotify's audio, so a map is: tempo (BPM + phase) + song sections -> seeded
// pattern pinned to playback position. Tempo: your taps, music databases (bpm.js) or a guess.
// Sections (verse/pre-chorus/chorus… with an energy level) come from structure.js.

const TEMPO = 'bb.tempo';
export const DEFAULT_BPM = 120;

const read = (k) => { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch { return {}; } };

export function getTempo(track) {
  if (track.bpm) return { bpm: track.bpm, offsetMs: track.offsetMs || 0, source: 'known' };
  const s = read(TEMPO)[track.id];
  if (s) return { ...s, source: 'tapped' };
  const info = cachedInfo(track.id); // real BPM from music databases; beat phase unknown (tap A/X to lock it)
  return info && info.bpm > 0 ? { bpm: info.bpm, offsetMs: 0, source: 'lookup', from: info.src } : { bpm: DEFAULT_BPM, offsetMs: 0, source: 'default' };
}
export function saveTempo(track, tempo) {
  const s = read(TEMPO);
  s[track.id] = { bpm: Math.round(tempo.bpm * 100) / 100, offsetMs: Math.round(tempo.offsetMs) };
  localStorage.setItem(TEMPO, JSON.stringify(s));
}

/** Tap along to the beat; after 4+ taps it returns a tempo (least-squares fit + circular phase). */
export class TapTempo {
  constructor() { this.taps = []; }
  reset() { this.taps = []; }
  tap(posMs) {
    const last = this.taps[this.taps.length - 1];
    if (last !== undefined && (posMs - last > 2000 || posMs < last)) this.taps = [];
    this.taps.push(posMs);
    if (this.taps.length > 16) this.taps.shift();
    if (this.taps.length < 4) return null;
    const n = this.taps.length, mi = (n - 1) / 2, mt = this.taps.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    this.taps.forEach((t, i) => { num += (i - mi) * (t - mt); den += (i - mi) ** 2; });
    let bpm = 60000 / (num / den);
    while (bpm < 70) bpm *= 2;
    while (bpm > 180) bpm /= 2;
    const spb = 60000 / bpm;
    let sx = 0, sy = 0;
    for (const t of this.taps) { const a = ((t % spb) / spb) * 2 * Math.PI; sx += Math.cos(a); sy += Math.sin(a); }
    let phase = (Math.atan2(sy, sx) / (2 * Math.PI)) * spb;
    if (phase < 0) phase += spb;
    return { bpm, offsetMs: phase, taps: n };
  }
}

function rng(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) { h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

/* ---------------- grid helpers ---------------- */
const START_MS = 3000;
export function grid(tempo) {
  const spb = 60000 / tempo.bpm;
  const t0 = tempo.offsetMs + Math.ceil((START_MS - tempo.offsetMs) / (spb * 4)) * spb * 4; // first bar line
  return { spb, bar: spb * 4, t0 };
}

/* ---------------- song structure ---------------- */
// sections: [{ t0, t1, kind: 'intro'|'verse'|'pre'|'chorus'|'break'|'bridge'|'outro', energy: 0..1 }]
export function sectionAt(sections, t) {
  if (!sections) return null;
  for (const s of sections) if (t >= s.t0 && t < s.t1) return s;
  return null;
}

/* ---------------- slicing maps ---------------- */
// A 4 x 3 grid in front of you: columns 0..3 (left to right), rows 0..2 (bottom to top).
// The left saber keeps to columns 0-1 and the right saber to 2-3, so the sabers never cross.
// dir = the way to swing through the cube: D, U, DL, DR, UL, UR, or A (any way).
export const DIFFICULTIES = ['easy', 'normal', 'hard', 'extreme', 'maniac'];
const DIFF_STEP = { easy: -1, normal: 0, hard: 1, extreme: 2, maniac: 3 };
/** Cube speed (metres per second) for each difficulty. */
export const SPEED = { easy: 8, normal: 10, hard: 12, extreme: 14, maniac: 16 };

// Density levels: how many slots of each bar (8 eighth-note slots) get a cube.
//  0 sparse: one per bar · 1 calm: every 2 beats · 2 steady: every beat · 3 busy: every beat plus
//  some off-beats · 4 hard: off-beats half the time · 5 extreme: every eighth · 6 maniac: every
//  eighth plus doubles and quick bursts.
const LEVELS = [
  ['x.......'],
  ['x...x...'],
  ['x.x.x.x.'],
  ['x.x.x.xx', 'x.xxx.x.', 'x.x.x.x.'],
  ['x.xxx.xx', 'xxx.x.xx', 'x.xxxxx.'],
  ['xxxxxxxx', 'xxxxxx.x', 'xxx.xxxx'],
  ['xxxxxxxx'],
];

function levelFor(e) { return e < 0.2 ? 0 : e < 0.4 ? 1 : e < 0.62 ? 2 : e < 0.8 ? 3 : 4; }

/**
 * Cubes, mines and walls for a song. Busier where the song has more energy, calmer in intros and
 * slow-downs, but never empty for long: even the quietest part keeps one cube per bar, and breather
 * bars get a wall to dodge instead. Placed on the song's real beats when a source has them, otherwise
 * on a steady grid. Same inputs = same map every time.
 * @returns {{ items: Array<{id,t,type:'note'|'mine'|'wall',hand?,col?,row?,dir?,dur?,kind?}>, notes:number }}
 */
// Tuned against 42 top-rated human Beat Saber maps (BeatSaver, Hard/Expert, Nov 2026): about 15% of hits
// are both sabers at once, a saber almost always moves to a new spot between its notes, the top row gets
// ~15% of notes, a few notes reach into the other saber's side, and mines are rare.
export function generate(track, tempo, difficulty = 'normal', { sections = [], beats = null, shiftMs = 0 } = {}) {
  const r = rng(`${track.id}:${difficulty}:${tempo.bpm.toFixed(2)}:saber`);
  const step = DIFF_STEP[difficulty] ?? 0;
  const endMs = (track.duration_ms || 180000) - 2500;
  let bt = beats && beats.length > 8 ? beats.filter((t) => t >= 2500 && t < endMs) : null;
  if (!bt) { const g = grid(tempo); bt = []; for (let t = g.t0; t < endMs; t += g.spb) bt.push(t); }
  // Energy relative to the song itself: a hyped song's "verses" are still hyped. Sources (lyrics gaps,
  // osu! mappers' breaks) often call a loud part quiet, so the song's own median counts as steady.
  const es = sections.filter((s) => s.kind !== 'silent').map((s) => s.energy).filter((x) => x >= 0);
  // real silence (found in the audio of your own songs): nothing to hit there at all
  const silent = sections.filter((s) => s.kind === 'silent');
  const isSilent = (t, t1 = t) => silent.some((s) => t1 >= s.t0 && t < s.t1);
  const med = es.length ? es.slice().sort((a, b) => a - b)[es.length >> 1] : 0.6;
  const lift = Math.max(0, 0.62 - med);
  const energyAt = (t) => { const s = sectionAt(sections, t); return Math.min(1, (s ? s.energy : 0.6) + lift); };

  const items = [];
  let id = 0, notes = 0;
  const hs = { L: { last: -1e9, up: false, col: 1 }, R: { last: -1e9, up: false, col: 2 } };
  let nextHand = 'L', phraseCol = { L: 1, R: 2 }, wallSide = r() < 0.5 ? 'L' : 'R', prevLevel = -1;

  const place = (t, hand, spb, forceDir, opt = {}) => {
    const h = hs[hand];
    if (isSilent(t)) return false;
    if (t - h.last > spb * 4) h.up = false;          // after a rest, start with a downswing
    const minGap = spb * (step >= 3 ? 0.24 : step >= 2 ? 0.49 : 0.74);
    if (t - h.last < minGap) return false;
    const out = hand === 'L' ? 'L' : 'R';            // outward diagonals only (no crossing)
    let dir = forceDir || (h.up ? 'U' : 'D');
    const roll = r();
    if (!forceDir && roll < 0.28 && !opt.noDiag) dir += out;        // e.g. DL for the left saber
    if (!forceDir && (step <= -1 ? r() < 0.3 : r() < 0.02)) dir = 'A';
    // a new spot for each note (humans move the saber 95% of the time): its phrase column or the one beside
    // it, now and then reaching into the middle on the other saber's side (Hard and up, straight swings only)
    const home = phraseCol[hand], side = hand === 'L' ? [0, 1] : [2, 3];
    let col, row, tries = 0;
    do {
      col = r() < 0.6 ? home : side[r() < 0.5 ? 0 : 1];
      if (step >= 1 && !opt.noCross && dir.length === 1 && dir !== 'A' && r() < 0.1) col = hand === 'L' ? 2 : 1;
      const k = r();
      row = dir[0] === 'D' ? (k < 0.45 ? 0 : k < 0.75 ? 1 : 2) : dir[0] === 'U' ? (k < 0.62 ? 0 : k < 0.9 ? 1 : 2) : (k < 0.5 ? 0 : 1);
      if (opt.maxRow !== undefined) row = Math.min(row, opt.maxRow);
    } while (col === h.col && row === h.row && ++tries < 6);
    if ((col === 2 && hand === 'L') || (col === 1 && hand === 'R')) { // crossing: not while the other saber is there
      const o = hs[hand === 'L' ? 'R' : 'L'];
      if (Math.abs(t - o.last) < spb * 1.5 || opt.both) col = home;
    }
    items.push({ id: id++, t: Math.round(t + shiftMs), type: 'note', hand, col, row, dir });
    notes++;
    h.up = dir === 'A' ? !h.up : dir[0] === 'D';     // the next swing comes back the other way
    h.last = t; h.col = col; h.row = row;
    return true;
  };

  for (let b = 0, bar = 0; b + 4 <= bt.length; b += 4, bar++) {
    const beat = (k) => bt[b + k];
    const nextDown = b + 4 < bt.length ? bt[b + 4] : beat(3) + (beat(3) - beat(2));
    const spb = (nextDown - beat(0)) / 4;
    const slot = (i) => (i % 2 === 0 ? beat(i / 2) : (beat((i - 1) / 2) + ((i - 1) / 2 + 1 < 4 ? beat((i - 1) / 2 + 1) : nextDown)) / 2);
    const e = energyAt((beat(0) + nextDown) / 2);
    let level = Math.max(0, Math.min(6, levelFor(e) + step));
    // very fast songs: eighth notes become too quick to swing; hold back one level above ~165 BPM
    if (60000 / spb > 165 && level >= 4) level--;
    if (bar % 2 === 0) { // new phrase: the sabers move to new columns now and then
      phraseCol = { L: r() < 0.6 ? 1 : 0, R: r() < 0.6 ? 2 : 3 };
    }

    const quietBar = isSilent(beat(0), nextDown);   // any silence in this bar: no walls or mines in it
    // breather bar (never in the busiest parts): a wall to dodge instead of cubes
    if (!quietBar && bar % 16 === 15 && e < 0.8 && bar > 4) {
      const kind = step >= 1 && r() < 0.5 ? 'top' : (wallSide = wallSide === 'L' ? 'R' : 'L');
      items.push({ id: id++, t: Math.round(beat(1) + shiftMs), type: 'wall', kind, dur: Math.round(spb * 2) });
      continue;
    }
    // quiet stretches: a side wall alongside the one cube per bar, on alternate bars
    if (!quietBar && level === 0 && bar % 4 === 2 && step >= 0) {
      wallSide = wallSide === 'L' ? 'R' : 'L';
      items.push({ id: id++, t: Math.round(beat(1) + shiftMs), type: 'wall', kind: wallSide, dur: Math.round(spb * 2) });
      const hand = wallSide === 'L' ? 'R' : 'L';     // the cube is on the open side
      place(beat(0), hand, spb);
      continue;
    }

    // every 8 bars: a wall that runs alongside the cubes. Side walls: lean away, and only the saber on
    // the open side has cubes. Low walls (Hard and up): duck, and the cubes stay on the bottom row.
    let feature = null;
    if (!quietBar && bar % 8 === 5 && bar > 4 && step >= 0 && level >= 1) {
      feature = step >= 1 && (bar >> 3) % 3 === 2 ? 'top' : (wallSide = wallSide === 'L' ? 'R' : 'L');
      items.push({ id: id++, t: Math.round(beat(0) + shiftMs), type: 'wall', kind: feature, dur: Math.round(spb * 4) });
      if (feature !== 'top') level = Math.min(level, 3);
    }
    const open = feature === 'L' ? 'R' : feature === 'R' ? 'L' : null;
    const opt = feature === 'top' ? { maxRow: 0 } : {};
    const barStart = items.length;

    const pats = LEVELS[level];
    const pat = pats[Math.floor(r() * pats.length)];
    const chorusHit = level >= 3 && prevLevel >= 0 && prevLevel < 3;
    prevLevel = level;
    // humans put ~15% of hits on both sabers, mostly on strong beats (1 and 3) of busy parts; the off-beat
    // just before a double inside the bar is left empty so both sabers are free for it
    const plan = [0, 2, 4, 6].map((i) => step >= 0 && pat[i] === 'x' && (i === 0 ? (chorusHit || (level >= 3 && r() < 0.6) || (level === 2 && r() < 0.45))
      : level >= 3 ? r() < (i === 4 ? 0.4 : 0.2) : level === 2 && i === 4 && r() < 0.25));
    for (let i = 0; i < 8; i++) {
      if (pat[i] !== 'x') continue;
      if (i % 2 === 1 && i < 7 && plan[(i + 1) / 2] && !open) continue;
      const t = slot(i);
      if (t > endMs) continue;
      // doubles: both sabers at once on the bar's first beat when the song steps up, and on maniac
      const dbl = i % 2 === 0 && plan[i / 2];
      if (open) { place(t, open, spb, null, opt); continue; }
      if (dbl && t - hs.L.last > spb * 0.74 && t - hs.R.last > spb * 0.74) {
        const rest = (h) => t - h.last > spb * 4;              // after a rest a saber starts with a downswing
        const upL = !rest(hs.L) && hs.L.up, upR = !rest(hs.R) && hs.R.up;
        if (upL === upR) {                                     // both due the same way: swing together
          const v = upL ? 'U' : 'D', diag = r() < 0.4;          // straight, or mirrored outward diagonals
          place(t, 'L', spb, diag ? `${v}L` : v, { ...opt, both: true }); place(t, 'R', spb, diag ? `${v}R` : v, { ...opt, both: true });
          continue;
        }
        if (level >= 3 && r() < 0.6) {                         // due opposite ways: a split (one down, one up)
          place(t, 'L', spb, upL ? 'U' : 'D', { ...opt, both: true }); place(t, 'R', spb, upR ? 'U' : 'D', { ...opt, both: true });
          continue;
        }
      }
      if (!place(t, nextHand, spb, null, opt)) { const o = nextHand === 'L' ? 'R' : 'L'; if (place(t, o, spb, null, opt)) nextHand = o; }
      if (!(step >= 0 && level >= 2 && r() < 0.12)) nextHand = nextHand === 'L' ? 'R' : 'L';
      // maniac bursts: a quick same-saber flick back on the sixteenth (only if the song isn't fast)
      if (level >= 6 && i % 4 === 3 && spb > 430 && r() < 0.35) place(t + spb / 4, nextHand === 'L' ? 'R' : 'L', spb, null, opt);
    }
    // mines: top row of the column a saber isn't using this phrase, between beats, and only where
    // that saber's nearby swings are straight up/down and low (so a clean swing never touches it)
    if (!quietBar && step >= 0 && !feature && r() < 0.06 + step * 0.03) { // rare: most top human maps use none
      const bars = items.slice(barStart).filter((x) => x.type === 'note');
      const sides = r() < 0.5 ? ['L', 'R'] : ['R', 'L'];
      for (const hand of sides) {
        const col = hand === 'L' ? (phraseCol.L === 1 ? 0 : 1) : (phraseCol.R === 2 ? 3 : 2);
        const t = slot(r() < 0.5 ? 3 : 7);
        const near = bars.filter((x) => x.hand === hand && Math.abs(x.t - shiftMs - t) < spb * 1.1);
        if (near.some((x) => x.dir.length > 1 || x.row >= 2 || x.col === col)) continue;
        if (items.some((x) => x.type === 'note' && Math.abs(x.t - shiftMs - t) < spb * 0.3)) continue;
        items.push({ id: id++, t: Math.round(t + shiftMs), type: 'mine', col, row: 2 });
        break;
      }
    }
  }
  items.sort((a, b) => a.t - b.t);
  return { items, notes };
}
