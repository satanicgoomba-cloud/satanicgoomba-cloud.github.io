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

const K = { cid: 'bb.clientId', tok: 'bb.token', ver: 'bb.pkceVerifier', state: 'bb.pkceState' };

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
  const state = randomString(16);
  sessionStorage.setItem(K.ver, verifier);
  sessionStorage.setItem(K.state, state);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const p = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: redirectUri(), scope: SCOPES,
    code_challenge_method: 'S256', code_challenge: challenge, state,
  });
  location.assign(`${AUTH_URL}?${p}`);
}

/** Call on page load. Returns true if it just completed a login redirect. */
export async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return false;
  history.replaceState(null, '', redirectUri());
  if (q.get('error')) throw new Error(`Spotify login cancelled: ${q.get('error')}`);
  if (q.get('state') !== sessionStorage.getItem(K.state)) throw new Error('Login state mismatch, please try again.');
  const body = new URLSearchParams({
    client_id: getClientId(), grant_type: 'authorization_code', code: q.get('code'),
    redirect_uri: redirectUri(), code_verifier: sessionStorage.getItem(K.ver) || '',
  });
  await tokenRequest(body);
  sessionStorage.removeItem(K.ver); sessionStorage.removeItem(K.state);
  return true;
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
