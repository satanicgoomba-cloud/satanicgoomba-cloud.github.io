// Three interchangeable music sources with the same interface:
//   init(), play(track), pause(), resume(), positionMs(), playing, name, dispose()
// The game only ever reads positionMs(): the beat map is pinned to playback position,
// never to decoded audio (Spotify audio cannot be read by the page).

import * as sp from './spotify-api.js?v=mwuth3z3';
import { getAccessToken } from './spotify-auth.js?v=mwuth3z3';

/** Interpolating clock: snaps on big jumps, eases small drift to avoid jitter. */
class Clock {
  constructor() { this.base = 0; this.at = performance.now(); this.playing = false; }
  now() { return this.playing ? this.base + (performance.now() - this.at) : this.base; }
  sync(posMs, playing, at = performance.now(), tolerance = 90) {
    const target = posMs + (playing ? performance.now() - at : 0);
    const cur = this.now();
    const drift = target - cur;
    const smooth = playing && this.playing && Math.abs(drift) < tolerance;
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
      name: 'Slicewave',
      getOAuthToken: (cb) => getAccessToken().then(cb).catch(() => cb('')),
      volume: 0.8,
    });
    const ready = new Promise((resolve, reject) => {
      this.player.addListener('ready', ({ device_id }) => { this.deviceId = device_id; resolve(); });
      const fail = (kind) => ({ message }) => reject(new Error(`${kind}: ${message}`));
      this.player.addListener('initialization_error', fail('This browser cannot run Spotify playback (DRM/EME missing?)'));
      this.player.addListener('authentication_error', fail('Spotify authentication failed'));
      this.player.addListener('account_error', fail('Spotify Premium is required for in-browser playback'));
      setTimeout(() => reject(new Error('Spotify player did not become ready')), 10000);
    });
    ready.catch(() => {}); // handled below; avoids an 'unhandled rejection' if connect() fails first
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
    if (this.track && cur && !sameTrack(cur, this.track)) return;
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
    try { await sp.playTrack(track.uri, this.deviceId, 0); }
    catch (e) {
      if (e.status !== 404) throw e;
      // A brand-new in-browser device is often "not found" until it's made active: transfer, then retry.
      await sp.transferPlayback(this.deviceId).catch(() => {});
      await new Promise((r) => setTimeout(r, 1200));
      await sp.playTrack(track.uri, this.deviceId, 0);
    }
    // wait (up to 6 s) for the player to report that this song is playing
    const t0 = performance.now();
    while (!this.clock.playing && performance.now() - t0 < 6000) await new Promise((r) => setTimeout(r, 150));
  }
  async pause() { await this.player.pause(); this.clock.sync(this.clock.now(), false); }
  async resume() { await this.player.resume(); }
  positionMs() { return this.clock.now(); }
  dispose() { clearInterval(this._poll); if (this.player) this.player.disconnect(); }
}

function forgetSoft() { try { localStorage.removeItem('bb.softVol'); } catch { /* ignore */ } }

/** Can this browser play protected audio (what the in-headset Spotify player needs)? */
export async function drmCheck() {
  if (!navigator.requestMediaKeySystemAccess) return 'no EME in this browser';
  try {
    await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{ initDataTypes: ['cenc'], audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }] }]);
    return 'Widevine available';
  } catch (e) { return `no Widevine (${e.name || e.message})`; }
}

/** Spotify may play a relinked copy of a song (different id, same song), so match generously. */
export function sameTrack(item, track) {
  if (!item || !track) return false;
  return item.id === track.id || item.uri === track.uri
    || (item.linked_from && (item.linked_from.id === track.id || item.linked_from.uri === track.uri))
    || (item.name === track.name && Math.abs((item.duration_ms || 0) - (track.duration_ms || 0)) < 3000);
}

/* ---------------- Spotify Connect (audio plays on your phone / speaker / desktop app) ---------------- */
export class ConnectPlayer {
  constructor(device) { this.device = device; this.name = `Spotify Connect: ${device.name}`; this.clock = new Clock(); this.track = null; }
  get playing() { return this.clock.playing; }
  async init() {
    this._poll = setInterval(() => this._refresh(), 2000);
  }
  async _refresh() {
    if (this.soft) return; // silently paused: Spotify keeps running at volume 0, the game stays still
    // Only ask Spotify while a song is running in the game: polling in the menus used up the app's
    // Spotify request limit (then Liked Songs and search stopped working).
    if (!this.track || this.userPaused || document.hidden || sp.coolingDown()) return;
    const sent = performance.now();
    let s;
    try { s = await sp.getPlaybackState(); } catch { return; }
    const recv = performance.now();
    this.report = s ? { playing: !!s.is_playing, progress: s.progress_ms, item: s.item && s.item.name, at: recv } : { none: true, at: recv };
    if (!s || !s.item) return;
    if (this.track && !sameTrack(s.item, this.track)) { this.report.other = true; return; }
    const prev = this.prevReport; this.prevReport = { progress: s.progress_ms, at: recv };
    let playing = !!s.is_playing;
    if (!playing && !this.userPaused) {
      // Spotify's status for some devices lags or says "paused" while the song is clearly running.
      // Only believe "paused" if the position really stopped moving (and not right after we pressed play).
      const advanced = prev && s.progress_ms > prev.progress + 400;
      const stuck = prev && Math.abs(s.progress_ms - prev.progress) < 150 && recv - prev.at > 1500;
      if (advanced || !stuck || recv - this.playAt < 8000) {
        if (advanced) this.clock.sync(s.progress_ms, true, (sent + recv) / 2, 400);
        return;
      }
    }
    // "Playing" but the position isn't moving: a stale report. Keep our own clock running.
    if (playing && prev && Math.abs(s.progress_ms - prev.progress) < 150 && recv - prev.at > 1500) { this.report.stale = true; return; }
    // A big correction (>0.35 s) is only trusted when two reports agree the song advances in real time.
    if (playing && Math.abs(s.progress_ms + (performance.now() - (sent + recv) / 2) - this.clock.now()) > 350) {
      const rateOk = prev && Math.abs((s.progress_ms - prev.progress) - (recv - prev.at)) < 600;
      if (!rateOk) { this.report.unconfirmed = true; return; }
    }
    // Assume the server sampled the position half-way through the round trip.
    this.clock.sync(s.progress_ms, playing, (sent + recv) / 2, 400);
    this.lastSync = performance.now();
  }
  async play(track, fromMs = 0) {
    this.track = track;
    this.clock.sync(fromMs, false);
    this.userPaused = false; this.prevReport = null;
    await sp.playTrack(track.uri, this.device.id, Math.round(fromMs));
    // Wait until Spotify shows the song actually running (position moving): devices like the Quest app
    // can take a few seconds to start. Starting the fight before that made the missiles jump back.
    const t0 = performance.now(); let prev = null, last = null, heard = false;
    while (performance.now() - t0 < 9000) {
      await new Promise((r) => setTimeout(r, 450));
      const sent = performance.now(); let st;
      try { st = await sp.getPlaybackState(); } catch { heard = true; continue; } // network trouble: don't blame the device
      const recv = performance.now();
      if (st && st.item && sameTrack(st.item, track)) heard = true;
      if (!st || !st.item || !sameTrack(st.item, track) || !st.is_playing) continue;
      last = { progress: st.progress_ms, at: (sent + recv) / 2 };
      if (prev && st.progress_ms > prev.progress + 100) break; // confirmed running
      prev = last;
    }
    // Spotify never even showed the song on that device: it's asleep (e.g. the Quest's Spotify app after
    // the headset slept). Say so instead of starting a silent song.
    if (!last && !heard) { const e = new Error(`Spotify on ${this.device.name} didn't start the song`); e.asleep = true; throw e; }
    // Start from Spotify's own position if we have one; otherwise from here now (polls correct it later).
    if (last) this.clock.sync(last.progress, true, last.at); else this.clock.sync(fromMs, true);
    this.playAt = performance.now(); this.prevReport = last ? { progress: last.progress, at: last.at } : null;
  }
  async pause() {
    this.userPaused = true;
    const soft = this.soft; this.soft = null;
    await sp.pause(this.device.id);
    if (soft) { await sp.setVolume(soft.vol, this.device.id).catch(() => {}); this.device.volume_percent = soft.vol; forgetSoft(); }
    else this.clock.sync(this.clock.now(), false);
  }
  /** Pause the game but keep Spotify playing at volume 0: on Quest, a paused Spotify app gets put to
   *  sleep (and vanishes from Spotify Connect) much sooner than a playing one. */
  async softPause(vol) {
    const at = this.clock.now();
    this.soft = { at, vol }; this.userPaused = true;
    this.clock.sync(at, false);
    try { localStorage.setItem('bb.softVol', JSON.stringify({ id: this.device.id, vol })); } catch { /* ignore */ }
    await sp.setVolume(0, this.device.id);
  }
  async resume() {
    this.userPaused = false; this.playAt = performance.now();
    if (this.soft) { // jump back to where the game paused, then turn the volume back up
      const { at, vol } = this.soft; this.soft = null;
      await sp.playTrack(this.track.uri, this.device.id, Math.round(at)).catch(() => {});
      await sp.setVolume(vol, this.device.id).catch(() => {}); this.device.volume_percent = vol; forgetSoft();
      this.clock.sync(at, true); this.prevReport = null;
      setTimeout(() => this._refresh(), 600);
      return;
    }
    await sp.resume(this.device.id); this.clock.sync(this.clock.now(), true); setTimeout(() => this._refresh(), 400);
  }
  positionMs() { return this.clock.now(); }
  /** One-line sync status for the HUD. */
  syncInfo() {
    const r = this.report;
    if (!r) return 'waiting for Spotify status';
    const age = ((performance.now() - r.at) / 1000).toFixed(1);
    if (r.none) return `no status from Spotify (${age}s ago), using game clock`;
    if (r.other) return `Spotify reports another song: ${r.item}`;
    const t = Math.floor(r.progress / 1000);
    return `Spotify ${r.playing ? 'playing' : 'paused'} ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}${r.stale ? ' (stale, using game clock)' : ''} · ${age}s ago`;
  }
  activate() {}
  dispose() { clearInterval(this._poll); }
}

/* ---------------- Practice: synthesized tracks with real build-ups and drops (no Spotify) ---------------- */
// 32 bars: intro 0-3, groove 4-11, build-up 12-15, DROP at bar 16 (16-27), outro 28-31.
const practice = (id, name, bpm, art) => {
  const bar = (60000 / bpm) * 4;
  const sec = (b0, b1, kind, energy) => ({ t0: b0 * bar, t1: b1 * bar, kind, energy });
  return { id, uri: '', name, artist: 'Slicewave practice', bpm, offsetMs: 0, duration_ms: Math.round(bar * 32 + 1500), art,
    sections: [sec(0, 4, 'intro', 0.3), sec(4, 12, 'verse', 0.6), sec(12, 16, 'pre', 0.35), sec(16, 28, 'chorus', 1), sec(28, 33, 'outro', 0.3)] };
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
    this.out = this.ctx.createGain(); this.out.gain.value = 0.55;
    this.lp = this.ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 20000; // muffles the music when time slows
    this.out.connect(this.lp).connect(this.ctx.destination);
    this.rate = 1; this.ancCtx = 0; this.ancSong = 0;
  }
  activate() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  /** Song time (s) at an audio-clock time: runs at this.rate since the last rate change. */
  _songAt(t) { return this.ancSong + (t - this.ancCtx) * this.rate; }
  _ctxAt(s) { return this.ancCtx + (s - this.ancSong) / this.rate; }
  /** Play faster or slower (STILL style: time moves when you move). 1 = normal. */
  setRate(r) {
    if (!this.ctx || Math.abs(r - this.rate) < 0.01) return;
    const now = this.ctx.currentTime; this.ancSong = this._songAt(now); this.ancCtx = now; this.rate = r;
    this.lp.frequency.setTargetAtTime(500 + r * r * 19500, now, 0.03);
  }
  async play(track) {
    this.activate();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.track = track;
    this.step = 0;
    this.startAt = this.ctx.currentTime + 0.15;
    this.rate = 1; this.ancCtx = this.startAt; this.ancSong = 0; this.lp.frequency.value = 20000;
    this._playing = true;
    clearInterval(this._sched);
    this._sched = setInterval(() => this._schedule(), 25);
  }
  _schedule() {
    if (!this._playing) return;
    const spb = 60 / this.track.bpm, s16 = spb / 4;
    const horizon = this.ctx.currentTime + 0.2;
    const totalSteps = 32 * 16;
    while (this.step < totalSteps && this._ctxAt(this.step * s16) < horizon) {
      const t = Math.max(this.ctx.currentTime, this._ctxAt(this.step * s16));
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
    return Math.max(0, this._songAt(this.ctx.currentTime) * 1000 - lat * this.rate);
  }
  stop() { this._playing = false; clearInterval(this._sched); this.track = null; this.setRate(1); }
  dispose() { clearInterval(this._sched); if (this.ctx) this.ctx.close(); }
}
