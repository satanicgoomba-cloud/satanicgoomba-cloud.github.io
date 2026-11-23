// Three interchangeable music sources with the same interface:
//   init(), play(track), pause(), resume(), positionMs(), playing, name, dispose()
// The game only ever reads positionMs(): the beat map is pinned to playback position,
// never to decoded audio (Spotify audio cannot be read by the page).

import * as sp from './spotify-api.js';
import { getAccessToken } from './spotify-auth.js';

/** Interpolating clock: snaps on big jumps, eases small drift to avoid jitter. */
class Clock {
  constructor() { this.base = 0; this.at = performance.now(); this.playing = false; }
  now() { return this.playing ? this.base + (performance.now() - this.at) : this.base; }
  sync(posMs, playing, at = performance.now()) {
    const target = posMs + (playing ? performance.now() - at : 0);
    const cur = this.now();
    const drift = target - cur;
    const smooth = playing && this.playing && Math.abs(drift) < 90;
    this.base = smooth ? cur + drift * 0.25 : target;
    this.at = performance.now();
    this.playing = playing;
  }
}

/* ---------------- Spotify Web Playback SDK (plays inside this browser tab) ---------------- */
let sdkLoading = null;
function loadSdk() {
  if (window.Spotify) return Promise.resolve();
  sdkLoading = sdkLoading || new Promise((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = resolve;
    const s = document.createElement('script');
    s.src = 'https://sdk.scdn.co/spotify-player.js';
    s.onerror = () => reject(new Error('Could not load the Spotify Web Playback SDK.'));
    document.head.appendChild(s);
    setTimeout(() => reject(new Error('Spotify Web Playback SDK timed out.')), 15000);
  });
  return sdkLoading;
}

export class SdkPlayer {
  constructor() { this.name = 'This headset (Web Playback SDK)'; this.clock = new Clock(); this.deviceId = null; this.track = null; this.lastState = null; }
  get playing() { return this.clock.playing; }

  async init() {
    await loadSdk();
    this.player = new window.Spotify.Player({
      name: 'BeatBrawler VR',
      getOAuthToken: (cb) => getAccessToken().then(cb).catch(() => cb('')),
      volume: 0.8,
    });
    const ready = new Promise((resolve, reject) => {
      this.player.addListener('ready', ({ device_id }) => { this.deviceId = device_id; resolve(); });
      const fail = (kind) => ({ message }) => reject(new Error(`${kind}: ${message}`));
      this.player.addListener('initialization_error', fail('This browser cannot run Spotify playback (DRM/EME missing?)'));
      this.player.addListener('authentication_error', fail('Spotify authentication failed'));
      this.player.addListener('account_error', fail('Spotify Premium is required for in-browser playback'));
      setTimeout(() => reject(new Error('Spotify player did not become ready (try the Connect option).')), 15000);
    });
    this.player.addListener('player_state_changed', (s) => this._onState(s));
    this.player.addListener('playback_error', ({ message }) => console.warn('playback_error', message));
    const ok = await this.player.connect();
    if (!ok) throw new Error('Spotify player failed to connect.');
    await ready;
    this._poll = setInterval(async () => {
      const s = await this.player.getCurrentState();
      if (s) this._onState(s);
    }, 1000);
  }

  _onState(s) {
    if (!s) return;
    this.lastState = s;
    const cur = s.track_window && s.track_window.current_track;
    if (this.track && cur && cur.id && cur.id !== this.track.id && !(cur.linked_from && cur.linked_from.id === this.track.id)) return;
    let at = performance.now();
    if (s.timestamp && !s.paused) {
      const age = Date.now() - s.timestamp;
      if (age > 0 && age < 2000) at -= age;
    }
    this.clock.sync(s.position, !s.paused, at);
  }

  /** Must be called from a click (Quest/iOS block audio until a user gesture). */
  activate() { if (this.player && this.player.activateElement) this.player.activateElement(); }

  async play(track) {
    this.track = track;
    this.clock.sync(0, false);
    await sp.playTrack(track.uri, this.deviceId, 0);
  }
  async pause() { await this.player.pause(); this.clock.sync(this.clock.now(), false); }
  async resume() { await this.player.resume(); }
  positionMs() { return this.clock.now(); }
  dispose() { clearInterval(this._poll); if (this.player) this.player.disconnect(); }
}

/* ---------------- Spotify Connect (audio plays on your phone / speaker / desktop app) ---------------- */
export class ConnectPlayer {
  constructor(device) { this.device = device; this.name = `Spotify Connect: ${device.name}`; this.clock = new Clock(); this.track = null; }
  get playing() { return this.clock.playing; }
  async init() {
    this._poll = setInterval(() => this._refresh(), 2000);
  }
  async _refresh() {
    const sent = performance.now();
    let s;
    try { s = await sp.getPlaybackState(); } catch { return; }
    const recv = performance.now();
    if (!s || !s.item) return;
    if (this.track && s.item.id !== this.track.id) return;
    // Assume the server sampled the position half-way through the round trip.
    this.clock.sync(s.progress_ms, s.is_playing, (sent + recv) / 2);
  }
  async play(track) {
    this.track = track;
    this.clock.sync(0, false);
    await sp.playTrack(track.uri, this.device.id, 0);
    setTimeout(() => this._refresh(), 400);
  }
  async pause() { await sp.pause(this.device.id); this.clock.sync(this.clock.now(), false); }
  async resume() { await sp.resume(this.device.id); setTimeout(() => this._refresh(), 400); }
  positionMs() { return this.clock.now(); }
  activate() {}
  dispose() { clearInterval(this._poll); }
}

/* ---------------- Practice: synthesized tracks with real build-ups and drops (no Spotify) ---------------- */
// 32 bars: intro 0-3, groove 4-11, build-up 12-15, DROP at bar 16 (16-27), outro 28-31.
const practice = (id, name, bpm, art) => {
  const bar = (60000 / bpm) * 4;
  return { id, uri: '', name, artist: 'BeatBrawler practice', bpm, offsetMs: 0, duration_ms: Math.round(bar * 32 + 1500), drops: [bar * 16], art };
};
export const PRACTICE_TRACKS = [
  practice('practice-120', 'Neon Jab', 120, ''),
  practice('practice-100', 'Heavy Bag', 100, ''),
  practice('practice-128', 'Ring Lights', 128, ''),
  practice('practice-140', 'Speed Bag', 140, ''),
];
const section = (bar) => (bar < 4 ? 'intro' : bar < 12 ? 'groove' : bar < 16 ? 'build' : bar < 28 ? 'drop' : 'outro');

export class PracticePlayer {
  constructor() { this.name = 'Practice beat (no Spotify)'; this.ctx = null; this.track = null; this.startAt = 0; this._playing = false; }
  get playing() { return this._playing; }
  async init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.out = this.ctx.createGain(); this.out.gain.value = 0.55; this.out.connect(this.ctx.destination);
  }
  activate() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  async play(track) {
    this.activate();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.track = track;
    this.step = 0;
    this.startAt = this.ctx.currentTime + 0.15;
    this._playing = true;
    clearInterval(this._sched);
    this._sched = setInterval(() => this._schedule(), 25);
  }
  _schedule() {
    if (!this._playing) return;
    const spb = 60 / this.track.bpm, s16 = spb / 4;
    const horizon = this.ctx.currentTime + 0.2;
    const totalSteps = 32 * 16;
    while (this.step < totalSteps && this.startAt + this.step * s16 < horizon) {
      const t = this.startAt + this.step * s16;
      const bar = Math.floor(this.step / 16), st = this.step % 16, sec = section(bar);
      const beatStep = st % 4 === 0, beat = st / 4;
      const root = [55, 55, 43.65, 49][Math.floor(bar / 2) % 4];
      if (sec === 'intro') {
        if (st % 2 === 0) this._hat(t, st % 4 ? 0.18 : 0.08);
        if (st === 0) this._pad(t, root * 4, spb * 4);
      } else if (sec === 'groove') {
        if (beatStep) this._kick(t, beat === 0 ? 1 : 0.8);
        if (st === 4 || st === 12) this._snare(t, 0.5);
        if (st % 2 === 0) this._hat(t, st % 4 ? 0.22 : 0.1);
        if (st % 4 === 2) this._bass(t, root, spb * 0.45);
      } else if (sec === 'build') {
        // snare roll that speeds up: quarters, eighths, sixteenths, then 16ths + rising pitch
        const k = bar - 12;
        const every = [4, 2, 1, 1][k];
        if (st % every === 0) this._snare(t, 0.25 + (k * 16 + st) / 64 * 0.5, 1 + (k * 16 + st) / 64);
        if (st === 0 && k === 0) this._riser(t, spb * 16);
        if (k === 3 && st >= 12) { /* a beat of near silence before the drop */ }
      } else if (sec === 'drop') {
        if (beatStep) this._kick(t, 1.15);
        if (st === 4 || st === 12) { this._snare(t, 0.7); this._clap(t); }
        if (st % 2 === 0) this._hat(t, 0.25);
        if (st % 2 === 1 || st % 4 === 2) this._bass(t, root * (st % 8 === 6 ? 2 : 1), spb * 0.22, 0.3);
        if (st === 0 && bar === 16) this._crash(t);
      } else {
        if (beatStep) this._kick(t, 0.9 - (bar - 28) * 0.15);
        if (st % 4 === 2) this._hat(t, 0.12);
      }
      this.step++;
    }
  }
  _env(t, g, peak, dur) { g.gain.setValueAtTime(Math.max(0.0001, peak), t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); }
  _kick(t, v) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.13);
    this._env(t, g, v, 0.3); o.connect(g).connect(this.out); o.start(t); o.stop(t + 0.32);
  }
  _noise(dur) {
    const b = this.ctx.createBuffer(1, Math.max(1, Math.floor(this.ctx.sampleRate * dur)), this.ctx.sampleRate);
    const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const s = this.ctx.createBufferSource(); s.buffer = b; return s;
  }
  _snare(t, v, pitch = 1) {
    const s = this._noise(0.2), f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
    f.type = 'bandpass'; f.frequency.value = 1700 * pitch; this._env(t, g, v, 0.16);
    s.connect(f).connect(g).connect(this.out); s.start(t);
  }
  _clap(t) {
    for (let i = 0; i < 3; i++) {
      const s = this._noise(0.05), f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
      f.type = 'highpass'; f.frequency.value = 1200; this._env(t + i * 0.012, g, 0.35, 0.05);
      s.connect(f).connect(g).connect(this.out); s.start(t + i * 0.012);
    }
  }
  _hat(t, v) {
    const s = this._noise(0.05), f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
    f.type = 'highpass'; f.frequency.value = 7000; this._env(t, g, v, 0.04);
    s.connect(f).connect(g).connect(this.out); s.start(t);
  }
  _crash(t) {
    const s = this._noise(1.6), f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
    f.type = 'highpass'; f.frequency.value = 3000; this._env(t, g, 0.35, 1.5);
    s.connect(f).connect(g).connect(this.out); s.start(t);
  }
  _bass(t, hz, dur, v = 0.22) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain(), f = this.ctx.createBiquadFilter();
    o.type = 'sawtooth'; o.frequency.value = hz; this._env(t, g, v, dur);
    f.type = 'lowpass'; f.frequency.setValueAtTime(900, t); f.frequency.exponentialRampToValueAtTime(180, t + dur);
    o.connect(f).connect(g).connect(this.out); o.start(t); o.stop(t + dur + 0.05);
  }
  _pad(t, hz, dur) {
    for (const m of [1, 1.5, 2]) {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = 'triangle'; o.frequency.value = hz * m;
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.05, t + dur * 0.3); g.gain.linearRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(this.out); o.start(t); o.stop(t + dur);
    }
  }
  _riser(t, dur) {
    const s = this._noise(dur), f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
    f.type = 'bandpass'; f.Q.value = 4; f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(9000, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.3, t + dur * 0.97); g.gain.linearRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(this.out); s.start(t); s.stop(t + dur);
  }
  async pause() { this._playing = false; await this.ctx.suspend(); }
  async resume() { await this.ctx.resume(); this._playing = true; }
  positionMs() {
    if (!this.ctx || !this.track) return 0;
    const lat = (this.ctx.outputLatency || this.ctx.baseLatency || 0) * 1000;
    return Math.max(0, (this.ctx.currentTime - this.startAt) * 1000 - lat);
  }
  stop() { this._playing = false; clearInterval(this._sched); this.track = null; }
  dispose() { clearInterval(this._sched); if (this.ctx) this.ctx.close(); }
}
