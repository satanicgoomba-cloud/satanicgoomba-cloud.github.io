// Spotify OAuth 2.0 Authorization Code + PKCE, fully in the browser.
// No client secret is ever used or stored. Tokens live in this browser's localStorage only.

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SCOPES = [
  'streaming',                   // Web Playback SDK
  'user-read-private',           // profile: name, avatar, Premium check
  'user-library-read',           // Liked Songs
  'user-read-playback-state',    // Connect fallback: read position
  'user-modify-playback-state',  // start tracks on the SDK / Connect device
].join(' ');

const K = { cid: 'bb.clientId', tok: 'bb.token', pkce: 'bb.pkce', app: 'bb.appPkg' };

/* ---- Quest app (Trusted Web Activity) detection ----
   The APKs open this site in the Quest Browser engine. At launch the page's referrer is
   android-app://<package>; remember it for this tab so a login can find its way back. */
export const IMMERSIVE_PKG = 'io.beatbrawler.quest';
const APPS = { i: IMMERSIVE_PKG, w: 'io.beatbrawler.quest.window' };
const APP_CODE = Object.fromEntries(Object.entries(APPS).map(([k, v]) => [v, k]));
try {
  // Most reliable: the APKs' start URLs carry ?app=i (immersive) / ?app=w (windowed setup).
  const qa = new URLSearchParams(location.search).get('app');
  const m = /^android-app:\/\/([\w.]+)/.exec(document.referrer || '');
  if (qa && APPS[qa]) sessionStorage.setItem(K.app, APPS[qa]);
  else if (m && APP_CODE[m[1]]) sessionStorage.setItem(K.app, m[1]);
} catch { /* ignore */ }
/** True inside the Quest app (TWA): logins can't leave the app there, so they go through the Quest Browser. */
export function inApp() {
  const mq = (q) => !!(window.matchMedia && matchMedia(q).matches);
  return !!appPackage() || mq('(display-mode: standalone)') || mq('(display-mode: fullscreen)') || mq('(display-mode: minimal-ui)');
}

/* ---- moving a login from the Quest Browser into the app (same headset, nothing leaves it) ----
   A "login code" is BB1.<base64url JSON {c: client id, r: refresh token}>. It's as sensitive as a
   password: it only ever travels inside a local link to the app or the headset's clipboard. */
export function loginCode() {
  const tok = readToken();
  if (!tok || !tok.refresh_token) return '';
  const json = JSON.stringify({ c: getClientId(), r: tok.refresh_token });
  return 'BB1.' + b64url(new TextEncoder().encode(json));
}
export function importLoginCode(code) {
  const m = /BB1\.([A-Za-z0-9_-]+)/.exec(String(code || ''));
  if (!m) throw new Error('That isn\'t a SpotiSaber login code.');
  let d;
  try { d = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0)))); }
  catch { throw new Error('That login code is damaged: copy it again.'); }
  if (!d.c || !d.r) throw new Error('That login code is incomplete: copy it again.');
  setClientId(d.c);
  localStorage.setItem(K.tok, JSON.stringify({ access_token: '', refresh_token: d.r, expires_at: 0 }));
}
/** Link that opens a Quest app and hands it this login (the code sits in the #fragment, never sent to a server). */
export function sendToAppLink(pkg) {
  return appLink(pkg, `#bblogin=${loginCode()}`);
}
export const APP_PKGS = APPS;

export function appPackage() { try { return sessionStorage.getItem(K.app) || ''; } catch { return ''; } }


export function redirectUri() {
  // Must match a Redirect URI in your Spotify app settings exactly, e.g. http://127.0.0.1:8443/
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

export function getClientId() {
  return localStorage.getItem(K.cid) || (window.BB_CONFIG && window.BB_CONFIG.spotifyClientId) || '';
}
export function setClientId(id) { localStorage.setItem(K.cid, id.trim()); }

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomString(n = 64) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const v = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(v, (x) => chars[x % chars.length]).join('');
}

export async function login() {
  const clientId = getClientId();
  if (!clientId) throw new Error('Enter your Spotify Client ID first.');
  const verifier = randomString(64);
  // The state carries which Quest app started the login ('i'/'w'), or 'b' for a normal browser tab.
  const state = `${randomString(16)}.${APP_CODE[appPackage()] || 'b'}`;
  // localStorage, not sessionStorage: in the Quest app, Spotify's page (and Google/Facebook sign-in)
  // runs in a real browser tab, and the redirect may land in that tab rather than the app.
  localStorage.setItem(K.pkce, JSON.stringify({ verifier, state, t: Date.now() }));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const p = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: redirectUri(), scope: SCOPES,
    code_challenge_method: 'S256', code_challenge: challenge, state,
  });
  location.assign(`${AUTH_URL}?${p}`);
}

/** Link that reopens the Quest app (optionally carrying the login code for it to finish). */
function appLink(pkg, query = '') {
  return `intent://${location.host}${location.pathname.replace(/index\.html$/, '')}${query}#Intent;scheme=https;package=${pkg};end`;
}

/**
 * Call on page load. Returns 'done' if it just completed a login, 'handoff' if this tab is a
 * browser tab that should send the user back to the Quest app (see handoff), or false.
 */
export let handoff = null; // { pkg, url, finished }
export async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return false;
  history.replaceState(null, '', redirectUri());
  const state = q.get('state') || '';
  const pkg = APPS[state.split('.').pop()];
  // TWAs report display-mode standalone; a browser tab (Custom Tab) reports browser.
  const standalone = !!(window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  const inOtherTab = pkg && appPackage() !== pkg && !standalone;
  if (q.get('error')) {
    if (inOtherTab) { handoff = { pkg, url: appLink(pkg), finished: false, error: q.get('error') }; return 'handoff'; }
    throw new Error(`Spotify login cancelled: ${q.get('error')}`);
  }
  let pending = null;
  try { pending = JSON.parse(localStorage.getItem(K.pkce)); } catch { /* ignore */ }
  const mine = pending && pending.state === state;
  if (inOtherTab && !mine) {
    // This browser tab can't see the app's storage: hand the code to the app to finish there.
    handoff = { pkg, url: appLink(pkg, `?code=${encodeURIComponent(q.get('code'))}&state=${encodeURIComponent(state)}`), finished: false };
    return 'handoff';
  }
  if (!mine) throw new Error('Login expired or started somewhere else, please press Log in again.');
  const body = new URLSearchParams({
    client_id: getClientId(), grant_type: 'authorization_code', code: q.get('code'),
    redirect_uri: redirectUri(), code_verifier: pending.verifier,
  });
  await tokenRequest(body);
  localStorage.removeItem(K.pkce);
  if (inOtherTab) { handoff = { pkg, url: appLink(pkg), finished: true }; return 'handoff'; }
  return 'done';
}

async function tokenRequest(body) {
  const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json();
  if (!r.ok) throw new Error(`Spotify token error: ${j.error_description || j.error || r.status}`);
  const old = readToken();
  const tok = {
    access_token: j.access_token,
    refresh_token: j.refresh_token || (old && old.refresh_token),
    expires_at: Date.now() + (j.expires_in - 60) * 1000,
  };
  localStorage.setItem(K.tok, JSON.stringify(tok));
  return tok;
}

function readToken() {
  try { return JSON.parse(localStorage.getItem(K.tok)); } catch { return null; }
}

export function isLoggedIn() { return !!readToken(); }

let refreshing = null;
export async function getAccessToken() {
  const tok = readToken();
  if (!tok) throw new Error('Not logged in');
  if (Date.now() < tok.expires_at) return tok.access_token;
  if (!tok.refresh_token) { logout(); throw new Error('Session expired, log in again.'); }
  refreshing = refreshing || tokenRequest(new URLSearchParams({
    client_id: getClientId(), grant_type: 'refresh_token', refresh_token: tok.refresh_token,
  })).finally(() => { refreshing = null; });
  try { return (await refreshing).access_token; } catch (e) { logout(); throw e; }
}

/** Disconnect: forget tokens (Spotify Developer Terms require a working disconnect). */
export function logout() { localStorage.removeItem(K.tok); }
