import * as THREE from 'three';
import * as auth from './spotify-auth.js?v=mwuy8pu8';
import * as sp from './spotify-api.js?v=mwuy8pu8';
import { lookupBpm, prefetchBpm, lookupDiag } from './bpm.js?v=mwuy8pu8';
export const BUILD = (/[?&]v=([\w]+)/.exec(import.meta.url) || [, 'dev'])[1];
import { SdkPlayer, ConnectPlayer, PracticePlayer, PRACTICE_TRACKS, drmCheck } from './players.js?v=mwuy8pu8';
import { getTempo, saveTempo, TapTempo } from './beatmap.js?v=mwuy8pu8';
import { lookupStructure, analyze, structureSummary } from './structure.js?v=mwuy8pu8';
import { Game } from './game.js?v=mwuy8pu8';
import { modLabels } from './mods.js?v=mwuy8pu8';
import * as leaks from './leaks.js?v=mwuy8pu8';
import * as gdrive from './gdrive.js?v=mwuy8pu8';
import { Pointers } from './ui3d.js?v=mwuy8pu8';
import { Menu } from './menu3d.js?v=mwuy8pu8';
import * as prof from './profile.js?v=mwuy8pu8';

const $ = (id) => document.getElementById(id);
const settings = (() => { try { return JSON.parse(localStorage.getItem('bb.settings')) || {}; } catch { return {}; } })();
const saveSettings = () => localStorage.setItem('bb.settings', JSON.stringify(settings));

/* ---------------- renderer, game, in-world UI ---------------- */
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
document.body.prepend(renderer.domElement);

const game = new Game(renderer, { onTap: () => tapTempo(), onPause: () => pause(), onFail: () => onFail() });
const pointers = new Pointers(renderer, game.scene, game.camera, game.rig);
const tapper = new TapTempo();
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  game.camera.aspect = innerWidth / innerHeight; game.camera.updateProjectionMatrix();
});

/* ---------------- state ---------------- */
// state: 'lobby' (2D page) | 'select' | 'play' | 'pause' | 'results'
const S = {
  search: { q: '', results: [], busy: false, error: '' },
  state: 'lobby', profile: prof.loadProfile(), liked: [], devices: [],
  practice: new PracticePlayer(), spotify: null, spotifyError: '', player: null,
  queue: [], idx: 0, ending: false, maxPos: 0, result: null, nextAt: 0,
};
window.__bb = { game, S, menu: null };

const isPractice = (t) => t && t.id.startsWith('practice');
const isLeak = (t) => t && String(t.id).startsWith('leak:');
const isLocal = (t) => isPractice(t) || isLeak(t);   // plays from this device, not Spotify
S.leaks = new leaks.LeakPlayer(); S.leakList = leaks.list(); S.leakQ = ''; S.leakDir = '';
// searching looks through every folder; otherwise you see one folder (subfolders at the top)
const leakView = () => S.leakQ ? leaks.filter(S.leakList, S.leakQ) : leaks.folderView(S.leakList, S.leakDir);
function bestLine(t) {
  const st = prof.loadStats().tracks[t.id], style = settings.style || 'saber';
  return st ? `Best ${prof.bestFor(st, style).toLocaleString()} (${{ saber: 'Slice', ride: 'Ride', shoot: 'Shoot', still: 'Still' }[style]}) · played ${st.plays}×` : 'Not played yet';
}
const inVR = () => renderer.xr.isPresenting;

const menu = new Menu(game.scene, pointers, {
  lists: () => ({ liked: S.liked, search: S.search.results, practice: PRACTICE_TRACKS, leaks: leakView() }),
  leakState: () => ({ q: S.leakQ, count: S.leakList.length, supported: leaks.supported(), drive: gdrive.tokenValid(), driveBusy: !!S.driveBusy, driveMsg: S.driveMsg || '' }),
  onDrive: () => { // LEAKS tab in VR: load the Drive list here, or leave VR to sign in to Google
    if (S.driveBusy) return;
    if (gdrive.tokenValid()) { driveRefresh(); return; }
    if (xrSession) xrSession.end();
    try { gdrive.login(); } catch (e) { S.driveMsg = e.message; menu.refresh(); }
  },
  onLeakSearch: (q) => { S.leakQ = q; },
  onLeakFolder: (dir) => { S.leakDir = dir; },
  leakFolder: () => S.leakDir,
  searchState: () => S.search,
  onSearch: (q, now) => runSearch(q, now),
  loggedIn: () => auth.isLoggedIn(),
  likedMsg: () => S.likedMsg || '',
  onLikedRetry: () => { S.likedMsg = ''; menu.refresh(); loadSpotify(); },
  best: (id) => prof.bestFor(prof.loadStats().tracks[id], settings.style || 'saber'),
  settings: () => settings,
  setSetting: (k, v) => {
    settings[k] = v; saveSettings();
    if (k === 'latency') game.latencyMs = v;
    if (k === 'hitSounds') game.hitSounds = v;
    menu.refresh();
  },
  hitSounds: () => settings.hitSounds,
  profile: () => prof.summary(S.profile),
  outputName: () => (S.spotify ? S.spotify.name : S.spotifyError || (auth.isLoggedIn() ? 'Spotify not started' : 'Practice only (not logged in)')),
  inVR,
  trackInfo: (t) => {
    if (isLeak(t) && !t.bpm) { const ci = leaks.cachedInfo(t); if (ci) Object.assign(t, { bpm: ci.bpm, offsetMs: ci.offsetMs, sections: ci.sections }); }
    if (isLeak(t) && !t.bpm && t.cloud) return { tempo: 'on Google Drive: downloads when you play it', structure: 'from the audio on first play', best: bestLine(t), lookup: '' };
    if (isLeak(t) && !t.bpm) return { tempo: 'tempo found from the audio on first play', structure: 'from the audio on first play', best: bestLine(t), lookup: '' };
    const tempo = getTempo(t);
    const st = prof.loadStats().tracks[t.id];
    return {
      tempo: `${Math.round(tempo.bpm)} BPM ${{ known: isLeak(t) ? '(from the audio)' : '', tapped: '(tapped)', lookup: `(${tempo.from})`, default: bpmPending.has(t.id) ? '(looking up…)' : '(guess: tap A/X in game)' }[tempo.source]}`,
      structure: isLeak(t) ? `from the audio (${(t.sections || []).length} parts)` : structPending.has(t.id) ? 'looking up…' : structureSummary(t, tempo.bpm) || 'not looked up yet',
      best: bestLine(t),
      lookup: tempo.source === 'default' && !bpmPending.has(t.id) ? lookupDiag(t.id) : '',
    };
  },
  onPlay: (tab, index) => playFromList(tab === 'practice' ? PRACTICE_TRACKS : tab === 'leaks' ? leakSongs(index) : tab === 'search' ? S.search.results : S.liked, index),
  onShareCard: () => prof.shareCard(prof.summary(S.profile)).then(() => game.flash('Profile card saved', 2000)).catch(() => {}),
  onExit: () => exitToLobby(),
  onLogin: () => startLogin(),
  onPasteCode: () => pasteLoginCode(),
  onSelectTrack: (list, index) => { // look the tempo up while the player reads the fight card
    const t = list[index]; if (!t || isLocal(t)) return;
    if (getTempo(t).source === 'default') { bpmPending.add(t.id); menu.refresh(); lookupBpm(t, { priority: true }).finally(() => { bpmPending.delete(t.id); menu.refresh(); }); }
    if (!structPending.has(t.id)) { structPending.add(t.id); menu.refresh(); lookupStructure(t).finally(() => { structPending.delete(t.id); menu.refresh(); }); }
    prefetchBpm(list.slice(index + 1, index + 6));
  },
  audioError: () => S.spotifyError,
  wakeNeeded: () => !!S.wakeNeeded && auth.isLoggedIn(),
  onWake: () => openSpotifyApp(),
  headsetAudio: () => S.headsetError || '',
  spotifyLog: () => S.spLog,
  needsRelogin: () => auth.isLoggedIn() && needsRelogin(),
  onSpotifyCheck: () => spotifyCheck(),
  onAudio: () => cycleOutput(),
  inApp: () => auth.inApp(),
  loading: () => S.loading,
  build: () => BUILD,
  current: () => game.track,
  onPauseAction: (id) => ({ resume, wake: () => openSpotifyApp(), restart: () => startTrack(S.queue[S.idx]), skip: () => finishTrack(false, true), select: () => toSelect() }[id] || (() => {}))(),
  lastResult: () => S.result,
  nextInfo: () => {
    if (S.state !== 'results' || !S.nextAt || settings.autoplay === false) return null;
    const n = S.queue[(S.idx + 1) % S.queue.length];
    return n ? { name: n.name, secs: Math.max(0, Math.ceil((S.nextAt - performance.now()) / 1000)) } : null;
  },
  onResultsAction: (id) => ({ next: () => startNext(), replay: () => startTrack(S.queue[S.idx]), select: () => toSelect() }[id] || (() => {}))(),
});
window.__bb.menu = menu;
Object.assign(window.__bb, { finishTrack, pause, resume, startNext }); // console debugging

function status(msg, err = false) { const el = $('status'); el.textContent = msg; el.classList.toggle('err', err); }

/* ---------------- main loop ---------------- */
const clock = new THREE.Clock();
const hint = $('hudHint');
let lastSecs = -1;
renderer.setAnimationLoop(() => {
  const dt = Math.min(0.05, clock.getDelta());
  game.update(dt);
  pointers.update(dt);
  if (S.state === 'play') checkTrackEnd();
  hint.hidden = S.state !== 'play' || inVR();
  if (S.state === 'results' && S.nextAt) {
    const secs = Math.ceil((S.nextAt - performance.now()) / 1000);
    if (secs !== lastSecs) { lastSecs = secs; menu.results.redraw(); }
    if (performance.now() >= S.nextAt) startNext();
  }
  game.render();
});

function checkTrackEnd() {
  if (!S.player || S.ending || !game.track) return;
  const pos = S.player.positionMs();
  S.maxPos = Math.max(S.maxPos, pos);
  const dur = game.track.duration_ms;
  if (pos >= dur - 300 || (S.maxPos > dur - 4000 && pos < 1500 && !S.player.playing)) finishTrack(true);
}

/* ---------------- Spotify search ---------------- */
let searchTimer = 0, searchSeq = 0;
function runSearch(q, now) {
  S.search.q = q; S.search.error = '';
  clearTimeout(searchTimer);
  if (!q.trim()) { S.search.results = []; S.search.busy = false; menu.refresh(); return; }
  S.search.busy = true; menu.refresh();
  searchTimer = setTimeout(async () => { // wait for a pause in typing
    const id = ++searchSeq;
    try {
      const res = await sp.searchTracks(q);
      if (id !== searchSeq) return; // a newer search is running
      S.search.results = res; S.search.busy = false;
      if (res.length) prefetchBpm(res.slice(0, 3));
    } catch (e) { if (id === searchSeq) { S.search.busy = false; S.search.error = `Search failed: ${e.message}`; } }
    menu.refresh();
  }, now ? 0 : 450);
}

/* ---------------- Spotify audio ---------------- */
// Output: 'sdk' = play in this headset/browser (Web Playback SDK, needs DRM support);
// a device id = Spotify Connect (Spotify app on your phone/computer/speaker plays, the game follows it).
/* ---------------- Spotify log (readable in VR: corner panel → LOG) ---------------- */
const SPLOG = 'bb.spLog';
S.spLog = (() => { try { return JSON.parse(localStorage.getItem(SPLOG)) || []; } catch { return []; } })();
function spLog(msg) {
  const d = new Date(), hh = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  S.spLog.push(`${hh}  ${msg}`); while (S.spLog.length > 30) S.spLog.shift();
  try { localStorage.setItem(SPLOG, JSON.stringify(S.spLog)); } catch { /* ignore */ }
  console.log('[spotify]', msg); menu && menu.refresh && menu.refresh();
}
const devNames = (list) => (list.length ? list.map((d) => `${d.name}${d.is_active ? ' (active)' : ''}`).join(', ') : 'none');
async function spotifyCheck() {
  spLog(`check: headset audio ${S.drm || '?'}${S.headsetError ? ` · in-game player: ${S.headsetError}` : ''}`);
  const ld = lastDevice(); spLog(`check: last device ${ld ? ld.name : 'none'} · now using ${S.spotify ? S.spotify.name : 'nothing'}`);
  try { const all = await sp.getDevices(); spLog(`check: Spotify lists ${devNames(all)}`); }
  catch (e) { spLog(`check: device list failed: ${e.status || ''} ${e.message}`); }
}
drmCheck().then((r) => { S.drm = r; });
// the game was closed while Spotify was silently paused: turn its volume back up
(() => {
  let sv = null; try { sv = JSON.parse(localStorage.getItem('bb.softVol')); } catch { /* ignore */ }
  if (sv && auth.isLoggedIn()) sp.setVolume(sv.vol, sv.id).then(() => spLog('restored Spotify volume after a silent pause')).catch(() => {}).finally(() => localStorage.removeItem('bb.softVol'));
})();

/** The login lacks a permission the in-game player needs (it said so, or the token says so). */
function needsRelogin() {
  const m = auth.missingScopes();
  return (m && m.length > 0) || /scope/i.test(S.headsetError || '');
}
// The first time a login has every permission, go back to trying music inside the game.
(() => {
  const m = auth.missingScopes();
  if (m && !m.length && !settings.scopesOk) { settings.scopesOk = 1; settings.output = 'sdk'; saveSettings(); }
})();

function wantedOutput() { return settings.output || ($('output') && $('output').value) || 'sdk'; }
async function connectPlayer(preferId) {
  S.devices = (await sp.getDevices()).filter((d) => !d.is_restricted && d.name !== 'Slicewave');
  // Prefer Spotify running on this Quest (the official Quest app plays in the background during VR),
  // then whatever device is active, then anything.
  const onQuest = (x) => /quest|oculus|meta/i.test(x.name || '');
  let d = S.devices.find((x) => x.id === preferId) || S.devices.find(onQuest) || S.devices.find((x) => x.is_active) || S.devices[0];
  spLog(`devices: ${devNames(S.devices)}`);
  if (!d && lastDevice()) d = await wakeSpotify(12000, true); // the Quest's Spotify may still be waking up
  if (!d) { S.wakeNeeded = true; throw new Error('No Spotify device found: tap OPEN SPOTIFY (or open the Spotify app on this Quest or your phone), play any song for a second, then come back'); }
  rememberDevice(d);
  const p = new ConnectPlayer(d); await p.init(); return p;
}

/* ---------------- keeping Spotify awake ---------------- */
// On Quest the music plays in the Spotify app over Spotify Connect. When the headset sleeps (taken
// off, passed around) that app is suspended and drops off Spotify's device list, and nothing can be
// played on it until it's back. The game remembers the device, watches for it to come back (on
// wake-up, before each song and on Resume), and moves the music back to it by itself. If it doesn't
// come back, the song card and pause menu offer OPEN SPOTIFY.
const LAST_DEV = 'bb.lastDevice';
function lastDevice() { try { return JSON.parse(localStorage.getItem(LAST_DEV)); } catch { return null; } }
function rememberDevice(d) { if (d && d.id) try { localStorage.setItem(LAST_DEV, JSON.stringify({ id: d.id, name: d.name })); } catch { /* ignore */ } }
const usableDevice = (d) => !d.is_restricted && d.name !== 'Slicewave';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let waking = null;
/** Wait (up to ms) for the last Spotify device, or one on this Quest, to be listed; make it active. */
function wakeSpotify(ms = 15000, quiet = false) {
  waking = waking || (async () => {
    const want = (S.spotify && S.spotify.device) || lastDevice();
    const t0 = performance.now();
    spLog(`waking Spotify (looking for ${want ? want.name : 'any Quest device'})`);
    let seen = '';
    if (!quiet) game.flash('Waking Spotify…', 3000);
    try {
      while (performance.now() - t0 < ms) {
        let list = null;
        try { list = (await sp.getDevices()).filter(usableDevice); S.devices = list; seen = devNames(list); } catch (e) { seen = `device list failed: ${e.status || ''} ${e.message}`; }
        if (list) {
          // same device, or the same Spotify app under a new id after it restarted, or any Spotify on this Quest
          const d = (want && (list.find((x) => x.id === want.id) || list.find((x) => x.name === want.name))) || list.find(onQuestDevice) || (!want && list.find((x) => x.is_active));
          if (d) {
            await sp.transferPlayback(d.id).catch(() => {});
            rememberDevice(d); S.wakeNeeded = false; S.spotifyError = '';
            spLog(`woke: ${d.name} after ${((performance.now() - t0) / 1000).toFixed(1)} s`);
            return d;
          }
        }
        await sleep(1500);
      }
      S.wakeNeeded = true;
      spLog(`gave up waking after ${Math.round(ms / 1000)} s; Spotify lists: ${seen || 'nothing'}`);
      S.spotifyError = 'Spotify on this Quest is asleep (the headset was off). Tap OPEN SPOTIFY, play any song for a second, then come back: the game reconnects by itself.';
      return null;
    } finally { waking = null; menu.refresh(); }
  })();
  return waking;
}
/** Switch the game's player to a (re)found device. */
function useDevice(d) {
  const cur = S.spotify;
  if (cur && cur.device && cur.device.id === d.id) { cur.device = d; return cur; }
  if (cur) cur.dispose && cur.dispose();
  const p = new ConnectPlayer(d); p.init(); S.spotify = p;
  return p;
}
async function deviceListed(id) {
  try { S.devices = (await sp.getDevices()).filter(usableDevice); return S.devices.some((x) => x.id === id); }
  catch { return true; } // can't tell: assume it's fine
}
/** Back from sleep / another app: quietly check Spotify is still reachable and bring it back if not. */
async function checkSpotifyAwake() {
  if (!auth.isLoggedIn() || !S.spotify || !S.spotify.device || waking) return;
  if (await deviceListed(S.spotify.device.id)) { S.wakeNeeded = false; return; }
  spLog(`back from sleep: ${S.spotify.device.name} is gone (Spotify lists: ${devNames(S.devices || [])})`);
  const d = await wakeSpotify(20000, true);
  if (d) { useDevice(d); game.flash(`Spotify reconnected: ${d.name}`, 2500); }
}
/** Open the Spotify app (or the web player) from the game. Android opens the app that owns
 *  open.spotify.com links, else the browser; the game reconnects when you come back. */
function openSpotifyApp() {
  spLog('OPEN SPOTIFY pressed');
  game.flash('Opening Spotify: play any song for a second, then come back', 8000);
  setTimeout(() => wakeSpotify(90000, true).then((d) => { if (d) { useDevice(d); game.flash(`Spotify reconnected: ${d.name}`, 3000); } }), 1500);
  const fallback = encodeURIComponent('https://open.spotify.com/');
  location.href = `intent://open.spotify.com/#Intent;scheme=https;S.browser_fallback_url=${fallback};end`;
}
let spotifyStarting = null;
const bpmPending = new Set(), structPending = new Set();
const onQuestDevice = (d) => !!d && /quest|oculus|meta/i.test(d.name || '');
function ensureSpotify() {
  if (S.spotify) return Promise.resolve(S.spotify);
  spotifyStarting = spotifyStarting || (async () => {
    const want = wantedOutput();
    try {
      if (want === 'sdk') { const p = new SdkPlayer(); await p.init(); p.activate(); S.spotify = p; }
      else S.spotify = await connectPlayer(want);
      S.spotifyError = ''; spLog(`audio: ${S.spotify.name}`);
    } catch (e) {
      console.warn(e);
      // In-headset playback failed (e.g. no DRM in this browser): fall back to Spotify Connect.
      spLog(`in-game player failed: ${e.message}`);
      drmCheck().then((r) => { S.headsetError = `${e.message} · ${r}`; menu.refresh(); renderAuth(); });
      try { S.spotify = await connectPlayer('');
        S.spotifyError = onQuestDevice(S.spotify.device) ? '' : `Playing on ${S.spotify.device.name}. To hear it in the headset, open the Spotify app on this Quest, then AUDIO ▸ on the right panel`; }
      catch (e2) { spLog(`no Spotify device: ${e2.message}`); S.spotifyError = want === 'sdk' ? `${e2.message}. (Spotify can't play inside the headset here: ${e.message})` : e2.message; throw new Error(S.spotifyError); }
    } finally { spotifyStarting = null; menu.refresh(); }
    return S.spotify;
  })();
  return spotifyStarting;
}
async function cycleOutput() { // in-headset -> each Connect device -> in-headset …
  try { S.devices = (await sp.getDevices()).filter((d) => !d.is_restricted && d.name !== 'Slicewave'); } catch { /* keep old list */ }
  const opts = ['sdk', ...S.devices.map((d) => d.id)];
  const cur = S.spotify && S.spotify.device ? S.spotify.device.id : wantedOutput();
  switchOutput(opts[(opts.indexOf(cur) + 1) % opts.length]);
  if (opts.length === 1) game.flash('Only headset audio: open Spotify on your phone to see it here', 4000);
}
function switchOutput(next) { // VR corner panel / start page: change where Spotify plays
  settings.output = next; saveSettings();
  if (S.spotify) { S.spotify.dispose && S.spotify.dispose(); S.spotify = null; }
  S.spotifyError = '';
  ensureSpotify().then(() => game.flash(`Audio: ${S.spotify.name}`, 2500)).catch((e) => game.flash(e.message, 5000));
}

/* ---------------- entering the game ---------------- */
async function enterGame() {
  // Called from a click, so audio can be unlocked here.
  await S.practice.init(); S.practice.activate();
  if (auth.isLoggedIn() && !S.spotify) ensureSpotify().catch(() => {}); // also retried on PLAY
  else if (S.spotify) S.spotify.activate();
  game.latencyMs = settings.latency || 0;
  $('menu').hidden = true; $('profile').hidden = true;
  layoutForMode();
  if (S.state === 'lobby') { S.state = 'select'; menu.tab = S.liked.length ? 'liked' : 'practice'; menu.show('select'); }
  else { if (S.state === 'play') S.state = 'pause'; menu.show(S.state); }
  $('hudHint').hidden = inVR();
}

function layoutForMode() {
  game.spread = inVR() ? 1 : 0.5;
  game.calibrateHeight();
  menu.layout(game.headY, !inVR());
}

function exitToLobby() {
  if (inVR() && xrSession) { xrSession.end(); return; }
  if (S.player && (S.player.playing || S.player.soft)) S.player.pause().catch(() => {});
  if (S.state === 'play') S.state = 'pause';
  menu.show('hidden');
  if (S.state !== 'pause') { game.stop(); S.state = 'lobby'; }
  $('menu').hidden = false; $('hudHint').hidden = true;
  $('playScreen').textContent = S.state === 'pause' ? 'Resume on screen' : 'Play on screen';
}

/* ---------------- songs ---------------- */
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/** The songs (not folder rows) of the LEAKS view, for playing: plays on through this folder. */
function leakSongs(index) {
  const v = leakView(), songs = v.filter((t) => !t.isDir);
  return songs.length ? Object.assign(songs, { at: Math.max(0, songs.indexOf(v[index])) }) : songs;
}
function playFromList(list, index) {
  if (list.at !== undefined) index = list.at;
  if (!list.length) return;
  const rest = list.slice(index + 1).concat(list.slice(0, index));
  S.queue = [list[index], ...(settings.shuffle ? shuffle(rest) : rest)];
  S.idx = 0;
  startTrack(S.queue[0]);
}

async function startTrack(track) {
  if (!track || S.loading) return;
  // Everything is prepared on the menu ("GETTING READY…" on the FIGHT button); the arena only
  // appears once Spotify has really started the song, so the missiles never have to reset.
  const status = (m) => { S.loading = m; menu.refresh(); };
  S.nextAt = 0;
  status('GETTING READY…');
  try {
    let player = isPractice(track) ? S.practice : isLeak(track) ? S.leaks : S.spotify;
    if (!player) {
      if (!auth.isLoggedIn()) throw new Error('Log in to Spotify to play your Liked Songs');
      status('CONNECTING TO SPOTIFY…');
      player = await ensureSpotify();
    }
    // Playing on another device (e.g. a laptop)? If Spotify has since been opened on this Quest, move to it.
    if (!isLocal(track) && player.device && !onQuestDevice(player.device)) {
      try {
        const q = (await sp.getDevices()).find((x) => onQuestDevice(x) && !x.is_restricted);
        if (q) { player.dispose(); player = S.spotify = new ConnectPlayer(q); await player.init(); S.spotifyError = ''; }
      } catch { /* keep the current device */ }
    }
    if (isLeak(track)) { status('READING THE SONG…'); await player.prepare(track, status); status('READING THE SONG…'); } // decode + find the beat (first time only)
    if (!isLocal(track)) {
      status('READING THE SONG…');
      const wait = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
      await Promise.all([getTempo(track).source === 'default' ? wait(lookupBpm(track, { priority: true }), 6000) : null, wait(lookupStructure(track), 8000)]);
    }
    const tempo0 = getTempo(track), an = analyze(track, tempo0.bpm);
    game.structure = isLeak(track) ? track.sections : an.sections;  // energy: quiet / calm / verse / chorus
    game.beats = tempo0.source === 'tapped' || isLeak(track) ? null : an.beats; // real beat times when a source has them
    game.shiftMs = syncFor(track);                                 // learned from your punches

    player.activate && player.activate();
    for (const p of [S.practice, S.spotify, S.leaks]) if (p && p !== player && p.playing) p.pause().catch(() => {});
    S.player = player; game.setPlayer(player);
    // Hit sounds default: on for practice, off over Spotify songs (Spotify forbids mixing other audio in).
    game.hitSounds = settings.hitSounds ?? isLocal(track);
    if (player.device && !(await deviceListed(player.device.id))) { // asleep since last time?
      status('WAKING SPOTIFY…');
      const d = await wakeSpotify(15000, true);
      if (!d) throw new Error(S.spotifyError);
      player = useDevice(d); S.player = player; game.setPlayer(player);
    }
    status('STARTING THE SONG…');
    try { await player.play(track); } // resolves once the song is audibly playing
    catch (e) {
      if (!player.device || !(e.status === 404 || e.asleep)) throw e;
      status('WAKING SPOTIFY…');
      const d = await wakeSpotify(15000, true);
      if (!d) throw new Error(S.spotifyError);
      player = useDevice(d); S.player = player; game.setPlayer(player);
      status('STARTING THE SONG…');
      await player.play(track);
    }
    S.maxPos = 0; S.ending = false; tapper.reset();
    game.loadTrack(track, tempo0, settings.difficulty || 'normal', { style: settings.style || 'saber', mods: settings.mods || {} });
    hint.textContent = { saber: 'Esc: pause · Move the mouse to slice · T: tap tempo', ride: 'Esc: pause · The mouse moves the hand · T: tap tempo', shoot: 'Esc: pause · Mouse aims, click fires · T: tap tempo', still: 'Esc: pause · Time moves when the mouse moves · click fires' }[game.style];
    S.state = 'play'; game.paused = false; menu.show('hidden');
  } catch (e) {
    let msg = e.message;
    spLog(`PLAY failed: ${e.status ? `${e.status} ` : ''}${e.asleep ? '(no sound started) ' : ''}${e.message}`);
    if (e.status === 404 || e.asleep) { msg = S.spotifyError || 'Spotify isn\'t reachable: tap OPEN SPOTIFY, play any song, then come back'; S.wakeNeeded = true; }
    if (e.status === 403) msg = 'Spotify refused playback (Premium required)';
    if (isLeak(track)) msg = `Couldn't play this file: ${e.message}`;
    else if (!isPractice(track)) S.spotifyError = msg;
    game.stop(); S.state = 'select'; menu.show('select'); game.flash(msg, 6000);
  } finally {
    S.loading = null; menu.refresh();
  }
}

function rankFor(acc) { return acc >= 95 ? 'S' : acc >= 85 ? 'A' : acc >= 70 ? 'B' : acc >= 50 ? 'C' : 'D'; }

/** Energy ran out: let the notes fall away for a moment, then show the results. */
function onFail() {
  if (S.state !== 'play') return;
  S.failedAt = S.player ? S.player.positionMs() : 0;
  setTimeout(() => { if (game.run.failed && game.track) finishTrack(false, false, true); }, 1600);
}

function finishTrack(ended, skipToNext = false, failed = false) {
  if (S.ending || !game.track) return;
  S.ending = true;
  const r = game.run, track = game.track, style = game.style;
  const played = (S.player ? S.player.positionMs() : 0) > 30000;
  let isBest = false;
  if (!failed && (ended || played)) isBest = prof.recordRun(track, r, style).isBest;
  const accuracy = r.hits + r.misses ? Math.round((100 * r.hits) / (r.hits + r.misses)) : 0;
  const synced = failed ? 0 : learnSync(track, r.errs);
  if (skipToNext) { startNext(); return; }
  if (S.player && (S.player.playing || S.player.soft)) S.player.pause().catch(() => {});
  S.result = {
    track, score: r.score, accuracy, rank: rankFor(accuracy), maxCombo: r.maxCombo, perfects: r.perfects, mines: r.mines, walls: r.walls, bullets: r.bullets, isBest, synced,
    failed, failedAt: S.failedAt, zeroed: r.zeroed, style, difficulty: game.difficulty, mods: modLabels(game.mods, style),
  };
  game.stop(); S.state = 'results';
  S.nextAt = !failed && settings.autoplay !== false && S.queue.length > 1 ? performance.now() + 6000 : 0; // after a fail you pick: replay or next
  menu.show('results');
}

function startNext() {
  if (!S.queue.length) return toSelect();
  S.idx = (S.idx + 1) % S.queue.length;
  startTrack(S.queue[S.idx]);
}

function toSelect() {
  if (S.player && (S.player.playing || S.player.soft)) S.player.pause().catch(() => {});
  game.stop(); S.state = 'select'; S.nextAt = 0;
  menu.show('select');
}

function pause() {
  if (S.state !== 'play' || game.run.failed) return;
  const p = S.player;
  if (p && p.softPause && p.device && p.device.supports_volume !== false && settings.softPause !== false) {
    // keep Spotify running at volume 0 so the Quest doesn't put the Spotify app to sleep
    const vol = typeof p.device.volume_percent === 'number' && p.device.volume_percent > 0 ? p.device.volume_percent : 70;
    p.softPause(vol).then(() => spLog(`paused silently (Spotify keeps playing at volume 0, was ${vol}%)`))
      .catch((e) => { spLog(`silent pause failed (${e.status || ''} ${e.message}): pausing Spotify`); p.soft = null; p.pause().catch(() => {}); });
    clearTimeout(S.softTimer); // after 5 minutes, really pause (and turn the volume back up)
    S.softTimer = setTimeout(() => { if (p.soft) { spLog('paused 5 min: stopped Spotify'); p.pause().catch(() => {}); } }, 5 * 60000);
  } else if (p) p.pause().catch(() => {});
  S.state = 'pause'; game.paused = true; menu.show('pause');
}
async function resume() {
  if (S.state !== 'pause') return;
  const p = S.player;
  // Connect device gone while paused (headset slept)? Bring it back and pick the song up where it was.
  clearTimeout(S.softTimer);
  if (p && p.device && !(await deviceListed(p.device.id))) {
    spLog(`resume: ${p.device.name} is gone`);
    game.flash('Waking Spotify…', 15000);
    const d = await wakeSpotify(15000, true);
    if (!d) { game.flash('Spotify is asleep: tap OPEN SPOTIFY, play any song, come back and Resume', 8000); menu.refresh(); return; }
    const np = useDevice(d); S.player = np; game.setPlayer(np);
    const at = Math.max(0, p.positionMs()), vol = p.soft && p.soft.vol; if (p !== np) p.soft = null; np.soft = null;
    menu.show('hidden'); S.state = 'play'; game.paused = false;
    try {
      await np.play(game.track, at);
      if (vol) { await sp.setVolume(vol, np.device.id).catch(() => {}); np.device.volume_percent = vol; localStorage.removeItem('bb.softVol'); }
      game.flash(`Spotify reconnected: ${d.name}`, 2500);
    }
    catch (e) { pause(); game.flash(e.message, 6000); }
    return;
  }
  menu.show('hidden'); S.state = 'play'; game.paused = false;
  if (S.player) { S.player.activate(); await S.player.resume().catch(() => {}); }
}

/* ---------------- per-song beat auto-sync ---------------- */
// If you punch a song's missiles consistently earlier or later than you usually do, its beat is
// probably a little off: shift that song's missiles for next time. Your general timing habit (the
// median over recent songs) is subtracted first, so only the song's own error is corrected.
const SYNC = 'bb.sync';
const readSync = () => { try { return JSON.parse(localStorage.getItem(SYNC)) || {}; } catch { return {}; } };
function syncFor(track) { return track && !isPractice(track) ? (readSync()[track.id] || 0) : 0; }
function learnSync(track, errs) {
  if (!track || !errs || errs.length < 16) return 0;
  const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; };
  const songMs = med(errs) * 1000;                    // + = you punched before the missile's beat
  const db = readSync();
  const habit = db._habit ?? songMs;
  db._habit = habit * 0.8 + songMs * 0.2;            // your general timing, slowly updated
  let change = 0;
  if (!isPractice(track)) {
    const off = songMs - habit;
    if (Math.abs(off) > 30) { change = -Math.round(off * 0.7); db[track.id] = Math.max(-400, Math.min(400, (db[track.id] || 0) + change)); }
  }
  try { localStorage.setItem(SYNC, JSON.stringify(db)); } catch { /* ignore */ }
  return change;
}

/* ---------------- tempo ---------------- */
function tapTempo() {
  if (S.state !== 'play' || !S.player || !S.player.playing) return;
  const res = tapper.tap(game.songPos());
  if (!res) { game.flash(`Tap… ${tapper.taps.length}/4`, 800); return; }
  const tempo = { bpm: res.bpm, offsetMs: res.offsetMs, source: 'tapped' };
  if (!game.track.bpm) saveTempo(game.track, tempo);
  else if (isLeak(game.track)) leaks.saveTempo(game.track, tempo);
  game.structure = analyze(game.track, tempo.bpm).sections; game.beats = null; // your taps win
  game.retime(tempo);
  game.flash(`Tempo locked: ${Math.round(res.bpm)} BPM`, 1500);
}
function nudge(ms) {
  if (S.state !== 'play') return;
  const tempo = { ...game.tempo, offsetMs: game.tempo.offsetMs + ms, source: game.tempo.source === 'default' ? 'tapped' : game.tempo.source };
  if (!game.track.bpm) saveTempo(game.track, tempo);
  else if (isLeak(game.track)) leaks.saveTempo(game.track, tempo);
  game.retime(tempo);
  game.flash(`Beat offset ${Math.round(tempo.offsetMs)} ms`, 1000);
}
/* ---------------- WebXR ---------------- */
let xrSession = null;
if (navigator.xr) navigator.xr.isSessionSupported('immersive-vr').then((ok) => { $('enterVR').hidden = !ok; }).catch(() => {});
$('enterVR').onclick = async () => {
  try {
    if (S.spotify) S.spotify.activate();
    S.practice.init().then(() => S.practice.activate());
    xrSession = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] });
    await renderer.xr.setSession(xrSession);
    // Pressing the Meta button (system menu) blurs the session: pause the fight.
    xrSession.addEventListener('visibilitychange', () => {
      if (xrSession && xrSession.visibilityState !== 'visible' && S.state === 'play') pause();
      if (xrSession) spLog(`headset view ${xrSession.visibilityState}`);
      if (xrSession && xrSession.visibilityState === 'visible') checkSpotifyAwake();
    });
    xrSession.addEventListener('end', () => {
      xrSession = null; game.onXrEnd();
      if (S.state === 'play') pause();
      menu.show('hidden'); $('menu').hidden = false;
      $('playScreen').textContent = S.state === 'lobby' ? 'Play on screen' : 'Resume on screen';
    });
    await enterGame();
    setTimeout(layoutForMode, 600); // once the headset reports a real head height
  } catch (e) { status(`VR failed: ${e.message}`, true); }
};
$('playScreen').onclick = () => enterGame();

// Installed as the immersive Quest app (start URL has ?vr=1): go straight into VR.
// The icon click counts as user activation, so requestSession is allowed on load.
function autoEnterVR() {
  if (!navigator.xr) return;
  navigator.xr.isSessionSupported('immersive-vr').then((ok) => { if (ok) $('enterVR').onclick(); }).catch(() => {});
}
$('practice').onclick = async () => { menu.tab = 'practice'; await enterGame(); menu.tab = 'practice'; menu.refresh(); };

/* ---------------- desktop input ---------------- */
const canvas = renderer.domElement;
canvas.addEventListener('pointermove', (e) => {
  const x = (e.clientX / innerWidth) * 2 - 1, y = -(e.clientY / innerHeight) * 2 + 1;
  game.desktopAim(x, y); pointers.desktopMove(x, y);
  canvas.style.cursor = pointers.desktopHit && pointers.desktopHit.id ? 'pointer' : S.state === 'play' ? 'crosshair' : 'default';
});
canvas.addEventListener('pointerdown', (e) => {
  if (S.state !== 'play') pointers.desktopClick();
  else game.desktopFire();
});
canvas.addEventListener('wheel', (e) => { pointers.desktopWheel(Math.sign(e.deltaY) * 1.5); }, { passive: true });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (S.state === 'lobby') return;
  if (S.state === 'select' && !e.metaKey && !e.ctrlKey && menu.typeKey(e.key)) { e.preventDefault(); return; } // typing a search
  if (e.key === 'Escape') { if (S.state === 'play') pause(); else if (S.state === 'pause') resume(); else exitToLobby(); return; }
  if (S.state !== 'play' || e.repeat) return;
  const k = e.key.toLowerCase();
  if (k === 't') tapTempo();
  else if (k === 'n') finishTrack(false, true);
  else if (k === '[') nudge(-10);
  else if (k === ']') nudge(10);
});

/* ---------------- lobby options ---------------- */
// Leaks: import your own audio files into this device's private storage (never uploaded).
async function leakStatus(msg) {
  const u = await leaks.usage();
  const n = leaks.count();
  $('leakStatus').textContent = msg || (n ? `${n} songs on this device${u ? ` · ${(u.used / 1e9).toFixed(1)} of ${(u.quota / 1e9).toFixed(0)} GB used` : ''}` : 'No leaks imported yet.');
  $('leakClear').hidden = !n;
}
async function importLeaks(files) {
  if (!files || !files.length) return;
  $('leakImport').disabled = $('leakFolder').disabled = true;
  try {
    const r = await leaks.importFiles(files, (i, n, name) => { $('leakStatus').textContent = `Importing ${i + 1 > n ? n : i + 1} of ${n}${name ? `: ${name}` : ''}`; });
    S.leakList = leaks.list(); menu.refresh();
    await leakStatus(`Imported ${r.added} new${r.skipped ? `, ${r.skipped} already there` : ''}${r.failed ? `, ${r.failed} failed (storage full?)` : ''}. ${r.total} songs on this device.`);
  } catch (e) { leakStatus(`Import failed: ${e.message}`); }
  finally { $('leakImport').disabled = $('leakFolder').disabled = false; $('leakFiles').value = ''; $('leakDir').value = ''; }
}
// Google Drive as a leak source
function driveStatus(msg) {
  const c = gdrive.config();
  $('driveClientId').value = $('driveClientId').value || c.clientId || '';
  if (c.folder && !$('driveFolder').value) $('driveFolder').value = `https://drive.google.com/drive/folders/${c.folder}`;
  const live = gdrive.tokenValid(), n = leaks.cloudCount();
  $('driveRefresh').hidden = !live || !c.folder;
  $('driveDownload').hidden = !live || !n;
  $('driveForget').hidden = !c.token && !c.folder;
  const quest = /OculusBrowser|Quest/i.test(navigator.userAgent);
  $('driveSend').hidden = !live || auth.inApp() || !quest;
  if (live) { $('driveSendImmersive').href = gdrive.handoffLink(auth.IMMERSIVE_PKG); $('driveSendWindow').href = gdrive.handoffLink(auth.APP_PKGS.w); }
  $('driveStatus').textContent = msg || (live ? `Connected${c.folderName ? ` to "${c.folderName}"` : ''} (${gdrive.minutesLeft()} min left on this login). ${n ? `${n} songs still on Drive.` : 'All songs downloaded.'}`
    : c.folder ? `Drive folder set${n ? `, ${n} songs not downloaded yet` : ''}. Connect to list or download songs.` : 'Not connected.');
}
async function driveRefresh() {
  S.driveBusy = true; S.driveMsg = ''; menu.refresh();
  try {
    driveStatus('Reading your Drive folder…');
    const files = await gdrive.listSongs((k) => driveStatus(`Reading your Drive folder… ${k} songs`));
    const r = leaks.mergeDrive(files);
    S.leakList = leaks.list(); menu.refresh(); leakStatus();
    driveStatus(`Found ${files.length} songs on Drive${r.added ? ` (${r.added} new)` : ''}. ${r.cloud} still to download: they download when played, or tap Download all.`);
    if (!files.length) S.driveMsg = 'Your Drive folder has no songs in it.';
  } catch (e) { driveStatus(e.message); S.driveMsg = e.message; }
  finally { S.driveBusy = false; menu.refresh(); }
}
const saveDriveFields = () => {
  gdrive.setClientId($('driveClientId').value);
  if ($('driveFolder').value.trim()) gdrive.setFolder($('driveFolder').value);
};
$('driveConnect').onclick = () => { try { saveDriveFields(); gdrive.login(); } catch (e) { driveStatus(e.message); } };
$('driveRefresh').onclick = () => { try { saveDriveFields(); driveRefresh(); } catch (e) { driveStatus(e.message); } };
$('driveFolder').onchange = () => { try { gdrive.setFolder($('driveFolder').value); if (gdrive.tokenValid()) driveRefresh(); else driveStatus(); } catch (e) { driveStatus(e.message); } };
$('driveClientId').onchange = () => gdrive.setClientId($('driveClientId').value);
$('driveDownload').onclick = async () => {
  $('driveDownload').disabled = true;
  try {
    const r = await leaks.downloadAll((i, n, name) => driveStatus(`Downloading ${Math.min(i + 1, n)} of ${n}${name ? `: ${name}` : ''}`));
    S.leakList = leaks.list(); menu.refresh(); leakStatus();
    driveStatus(`Downloaded ${r.done}${r.failed ? `, ${r.failed} failed` : ''}${r.left ? `, ${r.left} left` : ''}.`);
  } catch (e) { driveStatus(e.message); S.leakList = leaks.list(); menu.refresh(); }
  finally { $('driveDownload').disabled = false; }
};
$('driveForget').onclick = () => { gdrive.forget(); $('driveFolder').value = ''; driveStatus(); };
function checkDriveHash() { // Google's sign-in coming back, or Drive access handed over from the Quest Browser
  const r = gdrive.handleRedirect(), h = gdrive.takeHandoff();
  if (r && r !== 'done') driveStatus(r);
  if (h === 'expired') driveStatus('That Drive access has expired: connect again in the Quest Browser.');
  if (r === 'done' || h === true || (gdrive.tokenValid() && !S.leakList.length)) driveRefresh(); // signed in: list the songs straight away
  else driveStatus();
}
addEventListener('hashchange', checkDriveHash);
checkDriveHash();
if (!leaks.supported()) $('leakBox').hidden = true;
else {
  leakStatus();
  $('leakImport').onclick = () => $('leakFiles').click();
  $('leakFolder').onclick = () => $('leakDir').click();
  $('leakFiles').onchange = (e) => importLeaks(e.target.files);
  $('leakDir').onchange = (e) => importLeaks(e.target.files);
  $('leakClear').onclick = async () => {
    if (!confirm(`Remove all ${leaks.count()} leak songs from this device? (Your original files aren't touched.)`)) return;
    await leaks.removeAll(); S.leakList = []; menu.refresh(); leakStatus();
  };
}
$('difficulty').value = settings.difficulty || 'normal';
$('difficulty').onchange = (e) => { settings.difficulty = e.target.value; saveSettings(); };
$('latency').value = settings.latency || 0;
const latLabel = () => ($('latVal').textContent = `${$('latency').value} ms`);
latLabel();
$('latency').oninput = (e) => { settings.latency = +e.target.value; game.latencyMs = settings.latency; latLabel(); saveSettings(); };
$('shuffle').checked = !!settings.shuffle;
$('shuffle').onchange = (e) => { settings.shuffle = e.target.checked; saveSettings(); };
$('hitSounds').checked = !!settings.hitSounds;
$('hitSounds').onchange = (e) => { settings.hitSounds = e.target.checked; game.hitSounds = e.target.checked; saveSettings(); };

/* ---------------- Spotify setup / login ---------------- */
$('redir').textContent = auth.redirectUri();
$('copyRedir').onclick = () => navigator.clipboard.writeText(auth.redirectUri()).then(() => status('Redirect URI copied.'));
$('saveId').onclick = () => {
  const v = $('clientId').value.trim();
  if (!/^[0-9a-f]{32}$/i.test(v)) { status('That doesn\'t look like a Client ID (32 hex characters).', true); return; }
  auth.setClientId(v); status('Client ID saved.'); renderAuth();
};
$('editId').onclick = () => { $('setup').hidden = false; $('clientId').value = auth.getClientId(); };
$('login').onclick = () => startLogin();
$('reloginBtn').onclick = () => startLogin();
async function startLogin() {
  // Inside the Quest app, opening Spotify's page leaves (and closes) the app, so never navigate away:
  // show how to log in with the Quest Browser and bring the login back.
  // In VR, never leave the game for a login (on Quest that can close the app): explain the browser route.
  if (xrSession) { menu.loginHelp = true; menu.corner.redraw(); return; }
  if (auth.inApp()) { $('appLogin').hidden = false; $('appLogin').scrollIntoView({ behavior: 'smooth' }); return; }
  if (!auth.getClientId()) { if (xrSession) await xrSession.end().catch(() => {}); status('Enter your Spotify Client ID first.', true); $('setup').hidden = false; return; }
  auth.login().catch((e) => status(e.message, true));
}
// Inside the Quest app, Spotify's login page opens in a browser tab (so Google/Facebook sign-in work).
// If that tab finishes the login itself (shared storage), pick it up when the app comes back.
function recheckLogin() {
  if (!auth.isLoggedIn() || S.profile) return;
  status('Logged in.'); renderAuth(); loadSpotify();
}
addEventListener('storage', (e) => { if (e.key === 'bb.token') recheckLogin(); });
addEventListener('focus', recheckLogin);
document.addEventListener('visibilitychange', () => {
  if (auth.isLoggedIn()) spLog(document.hidden ? 'game hidden (headset asleep or another app)' : 'game visible again');
  if (!document.hidden) { recheckLogin(); checkSpotifyAwake(); }
});
$('logout').onclick = () => {
  auth.logout(); localStorage.removeItem('bb.profile'); localStorage.removeItem('bb.likedCache'); S.profile = null; S.liked = [];
  if (S.spotify) { S.spotify.dispose(); S.spotify = null; }
  status('Disconnected from Spotify. Your game stats are kept; reset them under Profile.'); renderAuth();
};
$('refreshDevices').onclick = refreshDevices;
$('output').onchange = () => switchOutput($('output').value);
$('output').onchange = () => { if (S.spotify) { S.spotify.dispose(); S.spotify = null; } };

async function refreshDevices() {
  try {
    S.devices = (await sp.getDevices()).filter((d) => !d.is_restricted && d.name !== 'Slicewave');
    const sel = $('output'), cur = sel.value;
    sel.innerHTML = '<option value="sdk">This headset/browser (Web Playback SDK)</option>' +
      S.devices.map((d) => `<option value="${escapeHtml(d.id)}">Spotify Connect: ${escapeHtml(d.name)} (${escapeHtml(d.type)})</option>`).join('');
    sel.value = [...sel.options].some((o) => o.value === cur) ? cur : 'sdk';
    status(S.devices.length ? `${S.devices.length} Connect device(s) found.` : 'No Connect devices. Open Spotify on your phone/computer to use one.');
  } catch (e) { status(`Devices: ${e.message}`, true); }
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function renderAuth() {
  const hasId = !!auth.getClientId(), inn = auth.isLoggedIn(), app = auth.inApp();
  $('setup').hidden = hasId || app;
  $('loggedOut').hidden = !hasId || inn || app;
  const re = inn && needsRelogin();
  $('appLogin').hidden = !app || (inn && !re);
  $('relogin').hidden = !re || app;
  $('loggedIn').hidden = !inn;
  $('sendToApp').hidden = !inn || app || re; // don't hand an old login to the app: it can't play in the headset
  if (inn && !app) {
    $('sendWindow').href = auth.sendToAppLink(auth.APP_PKGS.w);
    $('sendImmersive').href = auth.sendToAppLink(auth.IMMERSIVE_PKG);
  }
  if (inn && S.profile) {
    $('avatar').src = S.profile.avatar || 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E';
    $('meName').textContent = S.profile.name;
    $('meInfo').textContent = S.profile.product === 'premium' ? 'Spotify Premium' : `Spotify ${S.profile.product || 'account'}: Premium is needed to play songs`;
  }
}

async function loadSpotify() {
  const saved = sp.cachedLiked(); // show the list saved on this device right away (and if Spotify is busy)
  if (saved && !S.liked.length) { S.liked = saved.tracks.filter((t) => t.playable); menu.refresh(); }
  const say = (m) => { S.likedMsg = m; $('libInfo').textContent = m; menu.refresh(); };
  S.likedMsg = '';
  const miss = auth.missingScopes();
  if (miss && miss.includes('user-library-read')) { say('This Spotify login can\'t read your Liked Songs: log out and log in again on the start page.'); return; }
  try {
    S.profile = await sp.getProfile(); prof.saveProfile(S.profile); renderAuth();
    $('libInfo').textContent = 'Loading Liked Songs…';
    let seen = 0;
    S.liked = await sp.getLikedSongs({
      onPage: (t) => { seen = t.length; S.liked = t.filter((x) => x.playable); $('libInfo').textContent = `Loading Liked Songs… ${t.length}`; menu.refresh(); },
    });
    spLog(`liked songs: ${seen} saved, ${S.liked.length} playable`);
    if (S.liked.length) $('libInfo').textContent = `${S.liked.length} Liked Songs ready as levels.`;
    else say(seen ? `Spotify sent ${seen} Liked Songs but says none can play in your country.` : 'Spotify says you have no Liked Songs. Like some in Spotify, then try again.');
    menu.refresh();
    prefetchBpm(S.liked.slice(0, 6)); // the top of the song wall gets real tempos first
  } catch (e) {
    console.error(e); spLog(`liked songs failed: ${e.status || ''} ${e.message}`);
    const why = e.status === 429 ? e.message
      : e.status === 403 ? `Spotify refused (403: ${e.message}). Check your account is under User Management in the Spotify app dashboard, then log in again.`
      : e.status === 401 ? 'Your Spotify login ran out: log in again on the start page.'
      : `Couldn't load Liked Songs: ${e.status ? `${e.status} ` : ''}${e.message}`;
    if (S.liked.length) status(`${why} Showing your saved Liked Songs (${S.liked.length}).`, true);
    else { say(why); status(why, true); }
  }
}

/* ---------------- 2D profile panel ---------------- */
function renderProfile() {
  const sum = prof.summary(S.profile);
  const av = sum.avatar ? `<img class="av" src="${escapeHtml(sum.avatar)}" alt="">` : `<div class="av">${escapeHtml(sum.name.charAt(0).toUpperCase())}</div>`;
  const rows = (list, right) => list.length ? list.map((t) => `<li><span>${escapeHtml(t.name)} · <span class="muted">${escapeHtml(t.artist)}</span></span><span>${right(t)}</span></li>`).join('') : '<li class="muted">No songs played yet</li>';
  $('profileView').innerHTML = `<div class="pcard">${av}<div class="nm">${escapeHtml(sum.name)}</div>
    <div class="stats"><div><b>${sum.totalScore.toLocaleString()}</b><span>TOTAL SCORE</span></div><div><b>${sum.bestCombo}</b><span>BEST COMBO</span></div><div><b>${sum.accuracy}%</b><span>ACCURACY</span></div></div>
    <div class="plist"><h3>HIGH SCORES</h3><ol>${rows(sum.highScores, (t) => t.score.toLocaleString())}</ol>
    <h3>MOST PLAYED</h3><ol>${rows(sum.topPlayed, (t) => `${t.plays}×`)}</ol></div>
    <p class="small muted">${sum.games} rounds</p></div>`;
}
$('openProfile').onclick = () => { renderProfile(); $('profile').hidden = false; $('menu').hidden = true; $('shareStatus').textContent = ''; };
$('closeProfile').onclick = () => { $('profile').hidden = true; $('menu').hidden = false; };
$('shareCard').onclick = async () => {
  try { const r = await prof.shareCard(prof.summary(S.profile)); $('shareStatus').textContent = r === 'shared' ? 'Shared.' : 'Card saved as beatbrawler-profile.png'; }
  catch (e) { if (e.name !== 'AbortError') $('shareStatus').textContent = e.message; }
};
$('copyLink').onclick = async () => {
  const url = prof.shareUrl(prof.summary(S.profile));
  const local = /^http:\/\/(127\.0\.0\.1|localhost)/.test(url);
  try { await navigator.clipboard.writeText(url); $('shareStatus').textContent = local ? 'Link copied. It only opens on this machine until you host the game (README: Sharing).' : 'Link copied.'; }
  catch { prompt('Copy this link:', url); }
};
$('resetStats').onclick = () => { if (confirm('Reset all scores and play counts on this device?')) { prof.clearStats(); renderProfile(); } };

/* ---------------- login codes (Quest Browser -> Quest app) ---------------- */
function useLoginCode(code) {
  auth.importLoginCode(code);
  S.profile = null; menu.loginHelp = false;
  // a fresh login may allow music inside the game now: drop the old Spotify player so PLAY tries again
  if (S.spotify) { S.spotify.dispose && S.spotify.dispose(); S.spotify = null; }
  S.headsetError = ''; S.spotifyError = ''; S.wakeNeeded = false; settings.output = 'sdk'; saveSettings();
  spLog('new login imported: will try music inside the game first');
  status('Logged in from the Quest Browser.'); renderAuth(); loadSpotify(); menu.refresh();
}
$('useCode').onclick = () => { try { useLoginCode($('codeInput').value); $('codeInput').value = ''; } catch (e) { status(e.message, true); } };
$('copyCode').onclick = async () => {
  const code = auth.loginCode();
  try { await navigator.clipboard.writeText(code); status('Login code copied. Open the app and paste it (don\'t share it).'); }
  catch { prompt('Copy this login code (don\'t share it):', code); }
};
async function pasteLoginCode() { // VR corner panel: read the code from the headset's clipboard
  try { useLoginCode(await navigator.clipboard.readText()); game.flash('Logged in to Spotify', 2500); }
  catch (e) { game.flash(e.message || 'Couldn\'t read the clipboard', 4000); }
  menu.corner.redraw();
}

function checkHashLogin() {
  const hm = /[#&]bblogin=([^&]+)/.exec(location.hash);
  if (!hm) return;
  history.replaceState(null, '', location.pathname + location.search); // don't leave the code in the address
  try { useLoginCode(decodeURIComponent(hm[1])); } catch (e) { status(e.message, true); }
}
addEventListener('hashchange', checkHashLogin); // the app may already be open when the link arrives

/* ---------------- login hand-back (browser tab -> Quest app) ---------------- */
function showHandoff(h) {
  const app = h.pkg === auth.IMMERSIVE_PKG ? 'Slicewave' : 'Slicewave Setup';
  const msg = h.error ? `Spotify login was cancelled (${escapeHtml(h.error)}).`
    : h.finished ? 'You\'re logged in to Spotify.' : 'Almost done: the app finishes the login.';
  $('menu').hidden = false;
  $('menu').querySelector('.panel').innerHTML = `<header class="brand"><h1>BEAT<span>BRAWLER</span> VR</h1></header>
    <p>${msg}</p><p class="actions"><a class="big" id="backToApp" href="${escapeHtml(h.url)}">Back to ${app}</a></p>
    <p class="small muted">If nothing happens, close this tab and open ${app} from your library${h.finished ? '' : ', then press Log in again'}.</p>`;
  setTimeout(() => { location.href = h.url; }, 600);
}

/* ---------------- boot ---------------- */
$('build').textContent = `build ${BUILD}`;
(async () => {
  layoutForMode();
  // A login handed over from the Quest Browser arrives as #bblogin=<code>.
  checkHashLogin();
  let r = null;
  try { r = await auth.handleRedirect(); if (r === 'done') status('Logged in.'); } catch (e) { status(e.message, true); }
  if (r === 'handoff') { showHandoff(auth.handoff); return; } // this browser tab only hands the login back to the Quest app
  renderAuth();
  // The immersive Quest app starts at ?vr=1, and comes back to it after a Spotify login.
  if (new URLSearchParams(location.search).has('vr') || (auth.appPackage() === auth.IMMERSIVE_PKG && r !== 'error')) autoEnterVR();
  if (auth.isLoggedIn()) loadSpotify();
})();
