// LEAKS: your own audio files, imported into this device's private browser storage (the Origin
// Private File System). Nothing is uploaded anywhere: the files stay on this headset or computer.
// Because the game has the real audio here, it finds the tempo, beat and loud/quiet parts itself.

import * as gdrive from './gdrive.js?v=mwu3tfce';

const INDEX = 'bb.leaks', INFO = 'bb.leakInfo', DIR = 'leaks';
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|flac|ogg|opus|webm)$/i;

const readJson = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch { return d; } };
const writeJson = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full */ } };

export function supported() { return !!(navigator.storage && navigator.storage.getDirectory); }
async function dir() { return (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create: true }); }

/** "Artist - Title.mp3" → { artist, name }; anything else → title only. */
function parseName(file) {
  const base = file.replace(/\.[^.]+$/, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const m = /^(.+?)\s+-\s+(.+)$/.exec(base);
  return m ? { artist: m[1].trim(), name: m[2].trim() } : { artist: 'Leak', name: base };
}
const toTrack = (e) => ({ id: `leak:${e.file}`, file: e.file, name: e.name, artist: e.artist, duration_ms: e.duration_ms || 0, art: null, leak: true, cloud: e.local === false });

export function list() { return readJson(INDEX, []).map(toTrack).sort((a, b) => a.name.localeCompare(b.name)); }
export function count() { return readJson(INDEX, []).length; }
export function cloudCount() { return readJson(INDEX, []).filter((e) => e.local === false).length; }

/** Add the songs in your Drive folder to the list (not downloaded yet: they download on first play). */
export function mergeDrive(files) {
  const idx = readJson(INDEX, []);
  const byDrive = new Map(idx.filter((e) => e.drive).map((e) => [e.drive, e]));
  const names = new Set(idx.map((e) => e.file));
  let added = 0;
  for (const f of files) {
    if (byDrive.has(f.id)) continue;
    const local = idx.find((e) => !e.drive && e.file === f.name && e.size === f.size);
    if (local) { local.drive = f.id; continue; }          // already imported by hand: same song
    let file = f.name;
    for (let k = 2; names.has(file); k++) file = f.name.replace(/(\.[^.]+)?$/, ` (${k})$1`);
    names.add(file);
    idx.push({ file, size: f.size, ...parseName(f.name), duration_ms: 0, drive: f.id, local: false });
    added++;
  }
  // songs gone from Drive and never downloaded: drop them
  const live = new Set(files.map((f) => f.id));
  const kept = idx.filter((e) => !(e.local === false && e.drive && !live.has(e.drive)));
  writeJson(INDEX, kept);
  return { added, removed: idx.length - kept.length, total: kept.length, cloud: kept.filter((e) => e.local === false).length };
}

/** Download one Drive song into private storage. */
async function download(e, onBytes = () => {}) {
  const res = await gdrive.fetchFile(e.drive);
  const fh = await (await dir()).getFileHandle(e.file, { create: true });
  const w = await fh.createWritable();
  const reader = res.body.getReader();
  let got = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; await w.write(value); got += value.length; onBytes(got); }
    await w.close();
  } catch (err) { try { await w.abort(); } catch { /* ignore */ } throw err; }
  const idx = readJson(INDEX, []), x = idx.find((y) => y.file === e.file);
  if (x) { x.local = true; x.size = got; writeJson(INDEX, idx); }
}
/** Download every Drive song that isn't on this device yet. */
export async function downloadAll(onProgress = () => {}) {
  const todo = readJson(INDEX, []).filter((e) => e.local === false);
  let done = 0, failed = 0;
  for (const e of todo) {
    onProgress(done, todo.length, e.name);
    try { await download(e); done++; } catch (err) { if (err.expired) throw err; failed++; if (err.name === 'QuotaExceededError') break; }
  }
  onProgress(done, todo.length, '');
  return { done, failed, left: todo.length - done };
}

/** Words in any order, matched against title, artist and file name. */
export function filter(tracks, q) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return tracks;
  return tracks.filter((t) => { const hay = `${t.name} ${t.artist} ${t.file}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
}

function durationOf(file) {
  return new Promise((res) => {
    const a = new Audio(), url = URL.createObjectURL(file);
    const done = (v) => { clearTimeout(to); URL.revokeObjectURL(url); a.src = ''; res(v); };
    const to = setTimeout(() => done(0), 4000);
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(isFinite(a.duration) ? Math.round(a.duration * 1000) : 0);
    a.onerror = () => done(0);
    a.src = url;
  });
}

/** Copy picked files into private storage. Skips non-audio files and ones already imported. */
export async function importFiles(files, onProgress = () => {}) {
  if (!supported()) throw new Error('This browser can\'t store files for the game');
  try { await navigator.storage.persist(); } catch { /* best effort */ }
  const d = await dir();
  const idx = readJson(INDEX, []), have = new Map(idx.map((e) => [e.file, e]));
  const todo = [...files].filter((f) => AUDIO_EXT.test(f.name) && !f.name.startsWith('._'));
  let added = 0, skipped = 0, failed = 0;
  for (let i = 0; i < todo.length; i++) {
    const f = todo[i];
    onProgress(i, todo.length, f.name);
    const old = have.get(f.name);
    if (old && old.size === f.size) { skipped++; continue; }
    try {
      const fh = await d.getFileHandle(f.name, { create: true });
      const w = await fh.createWritable();
      await w.write(f); await w.close();
      const e = { file: f.name, size: f.size, ...parseName(f.name), duration_ms: await durationOf(f) };
      if (old) idx.splice(idx.indexOf(old), 1, e); else idx.push(e);
      have.set(f.name, e); added++;
      if (added % 20 === 0) writeJson(INDEX, idx);
    } catch (err) { failed++; console.warn('leak import failed', f.name, err); if (err && err.name === 'QuotaExceededError') break; }
  }
  writeJson(INDEX, idx);
  onProgress(todo.length, todo.length, '');
  return { added, skipped, failed, total: idx.length };
}

export async function removeAll() {
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry(DIR, { recursive: true }); } catch { /* none */ }
  localStorage.removeItem(INDEX); localStorage.removeItem(INFO);
}
export async function usage() {
  try { const e = await navigator.storage.estimate(); return { used: e.usage || 0, quota: e.quota || 0 }; } catch { return null; }
}

async function readFile(track, onStatus = () => {}) {
  const e = readJson(INDEX, []).find((x) => x.file === track.file);
  if (e && e.local === false) { // on Drive only: fetch it now
    if (!gdrive.tokenValid()) throw new Error('This song is still on Google Drive and the Drive login has expired: exit VR and tap Connect Google Drive on the start page (or Download all first)');
    onStatus('DOWNLOADING FROM DRIVE…');
    await download(e, (b) => onStatus(`DOWNLOADING ${(b / 1e6).toFixed(1)} MB…`));
    track.cloud = false;
  }
  const fh = await (await dir()).getFileHandle(track.file); return fh.getFile();
}
function setDuration(track, ms) {
  track.duration_ms = ms;
  const idx = readJson(INDEX, []), e = idx.find((x) => x.file === track.file);
  if (e && Math.abs((e.duration_ms || 0) - ms) > 50) { e.duration_ms = ms; writeJson(INDEX, idx); }
}

/* ---------------- beat + energy analysis from the audio itself ---------------- */
/**
 * Tempo (70–180 BPM), beat phase and per-section energy from a decoded song.
 * Onsets: rise in loudness of a bass band (kicks) plus the whole signal, 100 frames/s.
 * Tempo: autocorrelation of the onsets; phase: the comb offset that lines up the most onsets.
 * Energy: loudness per bar against the song's own quiet and loud parts.
 */
export function analyzeBuffer(buf) {
  const sr = buf.sampleRate, n = buf.length, hop = Math.round(sr / 100), F = Math.floor(n / hop);
  const ch = [buf.getChannelData(0), buf.numberOfChannels > 1 ? buf.getChannelData(1) : null];
  const low = new Float32Array(F), all = new Float32Array(F);
  const a = Math.exp((-2 * Math.PI * 150) / sr); // one-pole low-pass at ~150 Hz
  let lp = 0;
  for (let f = 0; f < F; f++) {
    let sl = 0, sa = 0;
    for (let i = f * hop, e = i + hop; i < e; i++) {
      const x = ch[1] ? (ch[0][i] + ch[1][i]) * 0.5 : ch[0][i];
      lp = a * lp + (1 - a) * x;
      sl += lp * lp; sa += x * x;
    }
    low[f] = Math.log(1e-9 + sl / hop); all[f] = Math.log(1e-9 + sa / hop);
  }
  const env = new Float32Array(F);
  for (let f = 1; f < F; f++) env[f] = Math.max(0, low[f] - low[f - 1]) + 0.6 * Math.max(0, all[f] - all[f - 1]);
  // remove the slowly moving average so loud parts don't dominate
  const W = 50; let run = 0; const ac = new Float32Array(F);
  for (let f = 0; f < F; f++) { run += env[f] - (f >= W ? env[f - W] : 0); ac[f] = Math.max(0, env[f] - run / Math.min(W, f + 1)); }
  // tempo: a beat period must also line up at 2 and 4 beats (half bar, bar). That rules out the 2/3 and
  // 3/2 traps that rolling hi-hats and dotted rhythms set for a plain autocorrelation.
  const acf = new Float32Array(350);
  for (let L = 16; L < 350; L++) { let s = 0; for (let f = L; f < F; f++) s += ac[f] * ac[f - L]; acf[L] = s / (F - L); }
  const at = (x) => { const i = Math.floor(x), k = x - i; return i + 1 < 350 ? acf[i] * (1 - k) + acf[i + 1] * k : 0; };
  let best = -1, bestLag = 50;
  const score = new Float32Array(90);
  for (let L = 33; L <= 86; L++) {
    const s = at(L) + 0.8 * at(2 * L) + 0.6 * at(4 * L) + 0.25 * at(L / 2);
    const bpm = 6000 / L, w = Math.exp(-0.5 * (Math.log2(bpm / 125) / 1.1) ** 2); // gentle preference for ~125
    score[L] = s; if (s * w > best) { best = s * w; bestLag = L; }
  }
  let lag = bestLag;
  if (bestLag > 33 && bestLag < 86) { // parabolic refinement
    const y0 = score[bestLag - 1], y1 = score[bestLag], y2 = score[bestLag + 1], d = y0 - 2 * y1 + y2;
    if (d < 0) lag += Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / d));
  }
  // refine on the whole song: the period and phase whose comb lands on the most onsets (mean per beat)
  const comb = (p0) => {
    let P = p0, Ph = 0, C = -1;
    for (let p = p0 * 0.99; p <= p0 * 1.01; p += 0.03) {
      for (let ph = 0; ph < p; ph += 1) {
        let c = 0, k = 0;
        for (let x = ph; x < F - 2; x += p) { const i = Math.round(x); c += Math.max(env[i], env[i - 1] || 0, env[i + 1]); k++; }
        c /= k || 1;
        if (c > C) { C = c; P = p; Ph = ph; }
      }
    }
    return { P, Ph, C };
  };
  let win = comb(lag);
  // the 3:2 / 2:3 trap: if a tempo 1.5x faster or slower lines up clearly better, it's the real one
  for (const k of [2 / 3, 1.5]) {
    let p = lag * k;
    while (p < 33) p *= 2; while (p > 86) p /= 2;
    const alt = comb(p);
    if (alt.C > win.C * 1.08) win = alt;
  }
  const bestP = win.P, bestPh = win.Ph;
  const bpm = 6000 / bestP, spbF = bestP;
  // energy per bar
  const bars = [];
  for (let s = bestPh; s + spbF * 4 <= F; s += spbF * 4) {
    let e = 0, c = 0;
    for (let f = Math.round(s); f < Math.round(s + spbF * 4); f++) { e += Math.exp(all[f]); c++; }
    bars.push({ t0: s * 10, t1: (s + spbF * 4) * 10, rms: Math.sqrt(e / (c || 1)) });
  }
  const sorted = bars.map((b) => b.rms).sort((x, y) => x - y);
  const q = (k) => sorted[Math.floor(k * (sorted.length - 1))] || 0;
  const lo = q(0.1), hi = q(0.9);
  const sections = [];
  for (let i = 0; i < bars.length; i += 2) { // two-bar sections
    const grp = bars.slice(i, i + 2), r = grp.reduce((x, b) => x + b.rms, 0) / grp.length;
    const e = Math.max(0, Math.min(1, (r - lo) / (hi - lo || 1)));
    const energy = Math.round((0.15 + 0.85 * e) * 100) / 100;
    const kind = i === 0 && energy < 0.5 ? 'intro' : energy >= 0.8 ? 'chorus' : energy >= 0.55 ? 'verse' : energy >= 0.3 ? 'pre' : 'break';
    const prev = sections[sections.length - 1];
    if (prev && prev.kind === kind && Math.abs(prev.energy - energy) < 0.12) { prev.t1 = grp[grp.length - 1].t1; continue; }
    sections.push({ t0: Math.round(grp[0].t0), t1: Math.round(grp[grp.length - 1].t1), kind, energy });
  }
  if (sections.length) { sections[0].t0 = 0; sections[sections.length - 1].t1 = Math.round((n / sr) * 1000); }
  return { bpm: Math.round(bpm * 100) / 100, offsetMs: Math.round(bestPh * 10), sections };
}
export function cachedInfo(track) { return readJson(INFO, {})[track.id] || null; }

/* ---------------- player ---------------- */
export class LeakPlayer {
  constructor() { this.name = 'Leaks (from this device)'; this.ctx = null; this.track = null; this.buf = null; this.bufId = null; this._playing = false; this.startAt = 0; }
  get playing() { return this._playing; }
  async init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.out = this.ctx.createGain(); this.out.gain.value = 0.9; this.out.connect(this.ctx.destination);
  }
  activate() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  /** Decode the song (and analyse it the first time). Sets track.bpm/offsetMs/sections/duration_ms. */
  async prepare(track, onStatus) {
    await this.init();
    if (this.bufId !== track.id) {
      this.buf = null; this.bufId = null;
      const file = await readFile(track, onStatus);
      this.buf = await this.ctx.decodeAudioData(await file.arrayBuffer());
      this.bufId = track.id;
    }
    setDuration(track, Math.round(this.buf.duration * 1000));
    const all = readJson(INFO, {});
    let info = all[track.id];
    if (!info || info.v !== 4) { info = { v: 4, ...analyzeBuffer(this.buf) }; all[track.id] = info; writeJson(INFO, all); }
    Object.assign(track, { bpm: info.bpm, offsetMs: info.offsetMs, sections: info.sections });
    return info;
  }
  async play(track, fromMs = 0) {
    await this.prepare(track);
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this._stopSrc();
    this.track = track;
    const src = this.ctx.createBufferSource(); src.buffer = this.buf; src.connect(this.out);
    const when = this.ctx.currentTime + 0.15;
    src.start(when, fromMs / 1000);
    this.src = src; this.startAt = when - fromMs / 1000; this._playing = true;
  }
  _stopSrc() { if (this.src) { try { this.src.stop(); } catch { /* already */ } this.src.disconnect(); this.src = null; } }
  async pause() { this._playing = false; if (this.ctx) await this.ctx.suspend(); }
  async resume() { await this.ctx.resume(); this._playing = true; }
  positionMs() {
    if (!this.ctx || !this.track) return 0;
    const lat = (this.ctx.outputLatency || this.ctx.baseLatency || 0) * 1000;
    return Math.max(0, (this.ctx.currentTime - this.startAt) * 1000 - lat);
  }
  stop() { this._playing = false; this._stopSrc(); this.track = null; }
  dispose() { this.stop(); if (this.ctx) this.ctx.close(); }
}
