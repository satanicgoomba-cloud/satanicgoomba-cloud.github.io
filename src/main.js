import * as THREE from 'three';
import * as auth from './spotify-auth.js?v=mwtm6sdh';
import * as sp from './spotify-api.js?v=mwtm6sdh';
import { lookupBpm, prefetchBpm } from './bpm.js?v=mwtm6sdh';
import { SdkPlayer, ConnectPlayer, PracticePlayer, PRACTICE_TRACKS } from './players.js?v=mwtm6sdh';
import { getTempo, saveTempo, TapTempo, getDrops, markDrop } from './beatmap.js?v=mwtm6sdh';
import { Game } from './game.js?v=mwtm6sdh';
import { Pointers } from './ui3d.js?v=mwtm6sdh';
import { Menu } from './menu3d.js?v=mwtm6sdh';
import * as prof from './profile.js?v=mwtm6sdh';

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

const game = new Game(renderer, { onTap: () => tapTempo(), onPause: () => pause(), onMarkDrop: () => markDropHere() });
const pointers = new Pointers(renderer, game.scene, game.camera, game.rig);
const tapper = new TapTempo();
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  game.camera.aspect = innerWidth / innerHeight; game.camera.updateProjectionMatrix();
});

/* ---------------- state ---------------- */
// state: 'lobby' (2D page) | 'select' | 'play' | 'pause' | 'results'
const S = {
  state: 'lobby', profile: prof.loadProfile(), liked: [], devices: [],
  practice: new PracticePlayer(), spotify: null, spotifyError: '', player: null,
  queue: [], idx: 0, ending: false, maxPos: 0, result: null, nextAt: 0,
};
window.__bb = { game, S, menu: null };

const isPractice = (t) => t && t.id.startsWith('practice');
const inVR = () => renderer.xr.isPresenting;

const menu = new Menu(game.scene, pointers, {
  lists: () => ({ liked: S.liked, practice: PRACTICE_TRACKS }),
  loggedIn: () => auth.isLoggedIn(),
  best: (id) => { const t = prof.loadStats().tracks[id]; return t ? t.best : 0; },
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
    const tempo = getTempo(t), drops = getDrops(t, tempo);
    const st = prof.loadStats().tracks[t.id];
    return {
      tempo: `${Math.round(tempo.bpm)} BPM ${{ known: '', tapped: '(tapped)', lookup: `(${tempo.from})`, default: bpmPending.has(t.id) ? '(looking up…)' : '(guess: tap A/X in game)' }[tempo.source]}`,
      drop: { known: 'yes', marked: 'yes (you marked it)', estimated: 'estimated', none: 'none yet (click the stick at the drop to mark it)' }[drops.source],
      best: st ? `Best ${st.best.toLocaleString()} · played ${st.plays}×` : 'Not played yet',
    };
  },
  onPlay: (tab, index) => playFromList(tab === 'practice' ? PRACTICE_TRACKS : S.liked, index),
  onShareCard: () => prof.shareCard(prof.summary(S.profile)).then(() => game.flash('Profile card saved', 2000)).catch(() => {}),
  onExit: () => exitToLobby(),
  onLogin: () => startLogin(),
  onPasteCode: () => pasteLoginCode(),
  onSelectTrack: (list, index) => { // look the tempo up while the player reads the fight card
    const t = list[index]; if (!t || isPractice(t)) return;
    if (getTempo(t).source === 'default') { bpmPending.add(t.id); lookupBpm(t).finally(() => { bpmPending.delete(t.id); menu.refresh(); }); }
    prefetchBpm(list.slice(index + 1, index + 6));
  },
  audioError: () => S.spotifyError,
  onAudio: () => cycleOutput(),
  inApp: () => auth.inApp(),
  current: () => game.track,
  onPauseAction: (id) => ({ resume, restart: () => startTrack(S.queue[S.idx]), skip: () => finishTrack(false, true), select: () => toSelect() }[id] || (() => {}))(),
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

/* ---------------- Spotify audio ---------------- */
// Output: 'sdk' = play in this headset/browser (Web Playback SDK, needs DRM support);
// a device id = Spotify Connect (Spotify app on your phone/computer/speaker plays, the game follows it).
function wantedOutput() { return settings.output || ($('output') && $('output').value) || 'sdk'; }
async function connectPlayer(preferId) {
  S.devices = (await sp.getDevices()).filter((d) => !d.is_restricted && d.name !== 'BeatBrawler VR');
  // Prefer Spotify running on this Quest (the official Quest app plays in the background during VR),
  // then whatever device is active, then anything.
  const onQuest = (x) => /quest|oculus|meta/i.test(x.name || '');
  const d = S.devices.find((x) => x.id === preferId) || S.devices.find(onQuest) || S.devices.find((x) => x.is_active) || S.devices[0];
  if (!d) throw new Error('No Spotify device found: open the Spotify app on this Quest (free in the Horizon Store) or your phone, play any song for a second, then press FIGHT again');
  const p = new ConnectPlayer(d); await p.init(); return p;
}
let spotifyStarting = null;
const bpmPending = new Set();
const onQuestDevice = (d) => !!d && /quest|oculus|meta/i.test(d.name || '');
function ensureSpotify() {
  if (S.spotify) return Promise.resolve(S.spotify);
  spotifyStarting = spotifyStarting || (async () => {
    const want = wantedOutput();
    try {
      if (want === 'sdk') { const p = new SdkPlayer(); await p.init(); p.activate(); S.spotify = p; }
      else S.spotify = await connectPlayer(want);
      S.spotifyError = '';
    } catch (e) {
      console.warn(e);
      // In-headset playback failed (e.g. no DRM in this browser): fall back to Spotify Connect.
      try { S.spotify = await connectPlayer(''); S.headsetError = e.message;
        S.spotifyError = onQuestDevice(S.spotify.device) ? '' : `Playing on ${S.spotify.device.name}. To hear it in the headset, open the Spotify app on this Quest, then AUDIO ▸ on the right panel`; }
      catch (e2) { S.spotifyError = want === 'sdk' ? `${e2.message}. (Spotify can't play inside the headset here: ${e.message})` : e2.message; throw new Error(S.spotifyError); }
    } finally { spotifyStarting = null; menu.refresh(); }
    return S.spotify;
  })();
  return spotifyStarting;
}
async function cycleOutput() { // in-headset -> each Connect device -> in-headset …
  try { S.devices = (await sp.getDevices()).filter((d) => !d.is_restricted && d.name !== 'BeatBrawler VR'); } catch { /* keep old list */ }
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
  if (auth.isLoggedIn() && !S.spotify) ensureSpotify().catch(() => {}); // also retried on FIGHT
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
  if (S.player && S.player.playing) S.player.pause().catch(() => {});
  if (S.state === 'play') S.state = 'pause';
  menu.show('hidden');
  if (S.state !== 'pause') { game.stop(); S.state = 'lobby'; }
  $('menu').hidden = false; $('hudHint').hidden = true;
  $('playScreen').textContent = S.state === 'pause' ? 'Resume on screen' : 'Play on screen';
}

/* ---------------- songs ---------------- */
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function playFromList(list, index) {
  if (!list.length) return;
  const rest = list.slice(index + 1).concat(list.slice(0, index));
  S.queue = [list[index], ...(settings.shuffle ? shuffle(rest) : rest)];
  S.idx = 0;
  startTrack(S.queue[0]);
}

async function startTrack(track) {
  if (!track) return;
  let player = isPractice(track) ? S.practice : S.spotify;
  if (!player) {
    if (!auth.isLoggedIn()) { game.flash('Log in to Spotify to play your Liked Songs', 4000); return; }
    game.flash('Connecting to Spotify…', 10000); menu.refresh();
    try { player = await ensureSpotify(); }
    catch (e) { game.flash(e.message, 8000); menu.show('select'); S.state = 'select'; menu.refresh(); return; }
  }
  // Playing on another device (e.g. a laptop)? If Spotify has since been opened on this Quest, move to it.
  if (!isPractice(track) && player.device && !onQuestDevice(player.device)) {
    try {
      const q = (await sp.getDevices()).find((x) => onQuestDevice(x) && !x.is_restricted);
      if (q) { player.dispose(); player = S.spotify = new ConnectPlayer(q); await player.init(); S.spotifyError = ''; game.flash(`Audio: ${q.name}`, 2500); }
    } catch { /* keep the current device */ }
  }
  player.activate && player.activate();
  for (const p of [S.practice, S.spotify]) if (p && p !== player && p.playing) p.pause().catch(() => {});
  S.player = player; game.setPlayer(player);
  // Hit sounds default: on for practice, off over Spotify songs (Spotify forbids mixing other audio in).
  game.hitSounds = settings.hitSounds ?? isPractice(track);
  S.maxPos = 0; S.ending = false; S.nextAt = 0; tapper.reset();
  S.state = 'play'; menu.show('hidden');
  if (!isPractice(track) && getTempo(track).source === 'default') { game.flash('Looking up tempo…', 6000); await Promise.race([lookupBpm(track), new Promise((r) => setTimeout(r, 6000))]); }
  game.loadTrack(track, getTempo(track), settings.difficulty || 'normal');
  try { await player.play(track); }
  catch (e) {
    let msg = e.message;
    if (e.status === 404) msg = 'Spotify device not found: open Spotify on it (or switch AUDIO on the corner panel)';
    if (e.status === 403) msg = 'Spotify refused playback (Premium required)';
    game.stop(); S.state = 'select'; menu.show('select'); game.flash(msg, 5000); S.spotifyError = msg; menu.refresh();
  }
}

function rankFor(acc) { return acc >= 95 ? 'S' : acc >= 85 ? 'A' : acc >= 70 ? 'B' : acc >= 50 ? 'C' : 'D'; }

function finishTrack(ended, skipToNext = false) {
  if (S.ending || !game.track) return;
  S.ending = true;
  const r = game.run, track = game.track;
  const played = (S.player ? S.player.positionMs() : 0) > 30000;
  let isBest = false;
  if (ended || played) isBest = prof.recordRun(track, r).isBest;
  const accuracy = r.hits + r.misses ? Math.round((100 * r.hits) / (r.hits + r.misses)) : 0;
  if (skipToNext) { startNext(); return; }
  if (S.player && S.player.playing) S.player.pause().catch(() => {});
  S.result = { track, score: r.score, accuracy, rank: rankFor(accuracy), maxCombo: r.maxCombo, perfects: r.perfects, breakers: r.breakers, isBest };
  game.stop(); S.state = 'results';
  S.nextAt = settings.autoplay !== false && S.queue.length > 1 ? performance.now() + 6000 : 0;
  menu.show('results');
}

function startNext() {
  if (!S.queue.length) return toSelect();
  S.idx = (S.idx + 1) % S.queue.length;
  startTrack(S.queue[S.idx]);
}

function toSelect() {
  if (S.player && S.player.playing) S.player.pause().catch(() => {});
  game.stop(); S.state = 'select'; S.nextAt = 0;
  menu.show('select');
}

function pause() {
  if (S.state !== 'play') return;
  if (S.player) S.player.pause().catch(() => {});
  S.state = 'pause'; game.paused = true; menu.show('pause');
}
async function resume() {
  if (S.state !== 'pause') return;
  menu.show('hidden'); S.state = 'play'; game.paused = false;
  if (S.player) { S.player.activate(); await S.player.resume().catch(() => {}); }
}

/* ---------------- tempo + drop marking ---------------- */
function tapTempo() {
  if (S.state !== 'play' || !S.player || !S.player.playing) return;
  const res = tapper.tap(game.songPos());
  if (!res) { game.flash(`Tap… ${tapper.taps.length}/4`, 800); return; }
  const tempo = { bpm: res.bpm, offsetMs: res.offsetMs, source: 'tapped' };
  if (!game.track.bpm) saveTempo(game.track, tempo);
  game.retime(tempo);
  game.flash(`Tempo locked: ${Math.round(res.bpm)} BPM`, 1500);
}
function nudge(ms) {
  if (S.state !== 'play') return;
  const tempo = { ...game.tempo, offsetMs: game.tempo.offsetMs + ms, source: game.tempo.source === 'default' ? 'tapped' : game.tempo.source };
  if (!game.track.bpm) saveTempo(game.track, tempo);
  game.retime(tempo);
  game.flash(`Beat offset ${Math.round(tempo.offsetMs)} ms`, 1000);
}
function markDropHere() {
  if (S.state !== 'play' || !game.track) return;
  if (isPractice(game.track)) { game.flash('Practice tracks already know their drop', 1500); return; }
  const t = markDrop(game.track, game.tempo, game.songPos());
  const mm = `${Math.floor(t / 60000)}:${String(Math.floor(t / 1000) % 60).padStart(2, '0')}`;
  game.flash(`Drop marked at ${mm}: the Drop Breaker fires there next time`, 2500);
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
    xrSession.addEventListener('visibilitychange', () => { if (xrSession && xrSession.visibilityState !== 'visible' && S.state === 'play') pause(); });
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
  if (S.state === 'play') game.desktopPunch(e.button === 2 ? 'R' : 'L');
  else pointers.desktopClick();
});
canvas.addEventListener('wheel', (e) => { pointers.desktopWheel(Math.sign(e.deltaY) * 1.5); }, { passive: true });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (S.state === 'lobby') return;
  if (e.key === 'Escape') { if (S.state === 'play') pause(); else if (S.state === 'pause') resume(); else exitToLobby(); return; }
  if (S.state !== 'play' || e.repeat) return;
  const k = e.key.toLowerCase();
  if (k === 'd') game.desktopPunch('L');
  else if (k === 'k') game.desktopPunch('R');
  else if (k === ' ') { e.preventDefault(); game.desktopCharge(true); }
  else if (k === 'f') game.tryFocus();
  else if (k === 't') tapTempo();
  else if (k === 'm') markDropHere();
  else if (k === 'n') finishTrack(false, true);
  else if (k === '[') nudge(-10);
  else if (k === ']') nudge(10);
});
addEventListener('keyup', (e) => { if (e.key === ' ') game.desktopCharge(false); });

/* ---------------- lobby options ---------------- */
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
document.addEventListener('visibilitychange', () => { if (!document.hidden) recheckLogin(); });
$('logout').onclick = () => {
  auth.logout(); localStorage.removeItem('bb.profile'); S.profile = null; S.liked = [];
  if (S.spotify) { S.spotify.dispose(); S.spotify = null; }
  status('Disconnected from Spotify. Your game stats are kept; reset them under Profile.'); renderAuth();
};
$('refreshDevices').onclick = refreshDevices;
$('output').onchange = () => switchOutput($('output').value);
$('output').onchange = () => { if (S.spotify) { S.spotify.dispose(); S.spotify = null; } };

async function refreshDevices() {
  try {
    S.devices = (await sp.getDevices()).filter((d) => !d.is_restricted && d.name !== 'BeatBrawler VR');
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
  $('appLogin').hidden = !app || inn;
  $('loggedIn').hidden = !inn;
  $('sendToApp').hidden = !inn || app;
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
  try {
    S.profile = await sp.getProfile(); prof.saveProfile(S.profile); renderAuth();
    $('libInfo').textContent = 'Loading Liked Songs…';
    S.liked = await sp.getLikedSongs({
      onPage: (t) => { S.liked = t.filter((x) => x.playable); $('libInfo').textContent = `Loading Liked Songs… ${t.length}`; menu.refresh(); },
    });
    $('libInfo').textContent = S.liked.length ? `${S.liked.length} Liked Songs ready as levels.` : 'No Liked Songs found. Like some songs in Spotify, or use Practice.';
    menu.refresh();
    prefetchBpm(S.liked.slice(0, 6)); // the top of the song wall gets real tempos first
  } catch (e) {
    console.error(e);
    if (e.status === 403) status('Spotify said 403: add your Spotify account under User Management in the app dashboard (Development Mode).', true);
    else status(e.message, true);
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
    <p class="small muted">${sum.games} rounds · ${sum.supers} super punches</p></div>`;
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
  const app = h.pkg === auth.IMMERSIVE_PKG ? 'BeatBrawler' : 'BB Setup';
  const msg = h.error ? `Spotify login was cancelled (${escapeHtml(h.error)}).`
    : h.finished ? 'You\'re logged in to Spotify.' : 'Almost done: the app finishes the login.';
  $('menu').hidden = false;
  $('menu').querySelector('.panel').innerHTML = `<header class="brand"><h1>BEAT<span>BRAWLER</span> VR</h1></header>
    <p>${msg}</p><p class="actions"><a class="big" id="backToApp" href="${escapeHtml(h.url)}">Back to ${app}</a></p>
    <p class="small muted">If nothing happens, close this tab and open ${app} from your library${h.finished ? '' : ', then press Log in again'}.</p>`;
  setTimeout(() => { location.href = h.url; }, 600);
}

/* ---------------- boot ---------------- */
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
