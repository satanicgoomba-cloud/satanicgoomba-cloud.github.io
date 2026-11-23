import { cachedInfo } from './bpm.js?v=mwtn35k1';
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

/* ---------------- patterns ---------------- */
// 8 eighth-note slots per bar. L/R = hand, B = both hands, . = rest.
const PATTERNS = {
  easy: ['L...R...', 'L.......', 'L...L...', 'R...R...', 'B.......', 'R...L...'],
  normal: ['L.R.L.R.', 'L...R.R.', 'L.L.R...', 'B...L.R.', 'L.R...B.', 'R.L.R.L.', 'L...R...', 'L.R.B...'],
  hard: ['LRL.R.L.', 'L.RLR...', 'LRLRB...', 'L.R.LRL.', 'B.LR.RL.', 'LR.RL.B.', 'L.R.L.R.', 'RL.LR.B.'],
};
const HARDER = { easy: 'normal', normal: 'hard', hard: 'hard' };
// Calm parts (intro, pre-chorus slow-downs, outro): half-time hits on beats 1 and 3, or just one per bar.
const CALM = ['L...R...', 'R...L...', 'L...L...', 'B.......'];
const SPARSE = ['L.......', 'R.......'];

// Formations decide which direction each missile flies in from (degrees; az 0 = straight ahead,
// negative = left; el = up). Scaled down by `spread` for flat screens.
// Every missile comes from in front of you (within about ±22° left/right, -15..25° up/down), so
// nothing arrives from where you can't see it. Variety comes from height, sweeps and cross-body punches.
const FORMATIONS = ['front', 'high', 'sweep', 'cross', 'front', 'low', 'sweep', 'high'];
function direction(form, hand, i, r) {
  const s = hand === 'L' ? -1 : 1;
  const j = (a, b) => a + r() * (b - a);
  switch (form) {
    case 'high': return { az: s * j(6, 18), el: j(16, 25) };   // uppercut height
    case 'low': return { az: s * j(6, 18), el: j(-15, -6) };   // body shots
    case 'sweep': { const k = i / 7; return { az: s * (4 + 18 * (hand === 'L' ? 1 - k : k)), el: j(0, 12) }; }
    case 'cross': return { az: -s * j(3, 10), el: j(0, 15) };  // crosses the midline: cross-body punches
    default: return { az: s * j(8, 22), el: j(-5, 12) };
  }
}
export const MAX_AZ = 22;

/**
 * Missiles for a song. Busier where the song has more energy (choruses), calmer in intros,
 * pre-chorus slow-downs and outros. Same song + tempo + difficulty = same fight every time.
 * @returns {{ notes: Array<{id,t,hand,az,el,strong}> }}
 */
export function generate(track, tempo, difficulty = 'normal', { spread = 1, sections = [] } = {}) {
  const r = rng(`${track.id}:${difficulty}:${tempo.bpm.toFixed(2)}`);
  const g = grid(tempo);
  const eighth = g.spb / 2;
  const endMs = (track.duration_ms || 180000) - 2500;
  const energyAt = (t) => { const s = sectionAt(sections, t); return s ? s.energy : 0.6; };

  const notes = [];
  let bar = 0, phrase = [], form = 'front', id = 0, prevE = 0.6;
  const lastByHand = { L: -1e9, R: -1e9 };
  for (let barStart = g.t0; barStart < endMs; barStart += g.bar, bar++) {
    const e = energyAt(barStart + g.bar / 2);
    if (bar % 4 === 0) {
      const pool = PATTERNS[difficulty] || PATTERNS.normal;
      phrase = [pool[Math.floor(r() * pool.length)], pool[Math.floor(r() * pool.length)]];
      form = bar < 4 ? 'front' : FORMATIONS[Math.floor(r() * FORMATIONS.length)];
    }
    if (bar % 16 === 15 && e < 0.8) continue; // breather bar (never in a chorus)
    let pat;
    if (e < 0.25) pat = SPARSE[bar % 2];
    else if (e < 0.45) pat = CALM[(bar >> 1) % CALM.length];
    else if (e < 0.8) pat = phrase[bar % 2];
    else { const hard = PATTERNS[HARDER[difficulty]]; pat = hard[(bar * 3 + Math.floor(r() * 2)) % hard.length]; }
    if (e >= 0.8 && prevE < 0.8) pat = 'B' + pat.slice(1); // hit the chorus with both fists
    prevE = e;
    const hot = e >= 0.8;
    const minGap = (hot || difficulty === 'hard') ? eighth * 0.99 : g.spb * 0.49;
    for (let i = 0; i < 8; i++) {
      const c = pat[i];
      if (c === '.' || !c) continue;
      const t = barStart + i * eighth;
      if (t > endMs) continue;
      const hands = c === 'B' ? ['L', 'R'] : [c];
      for (const hand of hands) {
        if (t - lastByHand[hand] < minGap) continue;
        lastByHand[hand] = t;
        const d = direction(hot && form === 'front' ? 'sweep' : form, hand, i, r);
        notes.push({ id: id++, t, hand, az: d.az * spread, el: d.el * Math.min(1, spread * 1.4), strong: i === 0 });
      }
    }
  }
  return { notes };
}
