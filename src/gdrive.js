// Google Drive as a source for the LEAKS tab: your own private folder, read through your own Google
// login (read-only). Nothing is made public and nothing is uploaded. Songs download into this device's
// private storage the first time you play them (or all at once with "Download all").
//
// Login: Google's browser sign-in (OAuth 2.0 for client-side web apps). The access token lasts an hour;
// downloaded songs stay forever. On the Quest, log in from the Quest Browser and hand the access over
// to the app with the "Open Slicewave with Drive access" link (same idea as the Spotify login).

const KEY = 'bb.gdrive';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const API = 'https://www.googleapis.com/drive/v3';
const AUDIO = /\.(mp3|m4a|aac|wav|flac|ogg|opus|webm)$/i;
const FOLDER = 'application/vnd.google-apps.folder';

const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
const write = (c) => localStorage.setItem(KEY, JSON.stringify(c));
const patch = (p) => { const c = { ...read(), ...p }; write(c); return c; };

export const config = () => read();
export function setClientId(id) { patch({ clientId: String(id || '').trim() }); }
/** Accepts a folder link (…/folders/<id>…), an ?id= link, or the bare id. */
export function folderIdFrom(s) {
  s = String(s || '').trim();
  const m = /\/folders\/([\w-]{10,})/.exec(s) || /[?&]id=([\w-]{10,})/.exec(s) || /^([\w-]{10,})$/.exec(s);
  return m ? m[1] : '';
}
export function setFolder(link) {
  const id = folderIdFrom(link);
  if (!id) throw new Error('That doesn\'t look like a Google Drive folder link');
  patch({ folder: id, folderName: '' });
  return id;
}
export function connected() { return !!read().folder; }
export function tokenValid() { const c = read(); return !!c.token && c.exp - Date.now() > 60000; }
export function minutesLeft() { const c = read(); return c.token ? Math.max(0, Math.round((c.exp - Date.now()) / 60000)) : 0; }
export function forget() { const c = read(); write({ clientId: c.clientId }); }

function redirectUri() { return location.origin + location.pathname.replace(/index\.html$/, ''); }

/** Go to Google's sign-in. Comes back to this page with #access_token=…&state=gdrive… */
export function login() {
  const c = read();
  if (!c.clientId) throw new Error('Paste your Google Client ID first');
  const state = `gdrive${Math.random().toString(36).slice(2)}`;
  sessionStorage.setItem('bb.gdriveState', state);
  const p = new URLSearchParams({ client_id: c.clientId, redirect_uri: redirectUri(), response_type: 'token', scope: SCOPE, include_granted_scopes: 'true', state });
  location.href = `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

/** On page load: take the token Google sent back. Returns null, 'done', or an error message. */
export function handleRedirect() {
  const h = new URLSearchParams(location.hash.slice(1));
  const state = h.get('state') || '';
  if (!state.startsWith('gdrive')) return null;
  history.replaceState(null, '', location.pathname + location.search); // don't leave the token in the address
  const want = sessionStorage.getItem('bb.gdriveState'); sessionStorage.removeItem('bb.gdriveState');
  if (h.get('error')) return `Google sign-in was cancelled (${h.get('error')})`;
  if (want && want !== state) return 'Google sign-in didn\'t match this page: try again';
  const token = h.get('access_token');
  if (!token) return 'Google didn\'t send an access token';
  patch({ token, exp: Date.now() + (+h.get('expires_in') || 3600) * 1000 });
  return 'done';
}

/** Link that opens the Quest app with this Drive access (token + folder). Treat it like a password. */
export function handoffLink(pkg) {
  const c = read();
  const frag = `#bbdrive=${encodeURIComponent([c.token, c.exp, c.folder || ''].join('~'))}`;
  return `intent://${location.host}${location.pathname.replace(/index\.html$/, '')}${frag}#Intent;scheme=https;package=${pkg};end`;
}
/** In the app: take Drive access handed over from the Quest Browser. */
export function takeHandoff() {
  const m = /[#&]bbdrive=([^&]+)/.exec(location.hash);
  if (!m) return false;
  history.replaceState(null, '', location.pathname + location.search);
  const [token, exp, folder] = decodeURIComponent(m[1]).split('~');
  if (!token || !(+exp > Date.now())) return 'expired';
  patch({ token, exp: +exp, ...(folder ? { folder } : {}) });
  return true;
}

async function api(path, params = {}, raw = false) {
  const c = read();
  if (!c.token || c.exp < Date.now()) throw Object.assign(new Error('Google Drive login expired: tap Connect Google Drive on the start page'), { expired: true });
  const q = new URLSearchParams(params);
  const res = await fetch(`${API}${path}${q.toString() ? `?${q}` : ''}`, { headers: { Authorization: `Bearer ${c.token}` } });
  if (res.status === 401) { patch({ token: '', exp: 0 }); throw Object.assign(new Error('Google Drive login expired: tap Connect Google Drive on the start page'), { expired: true }); }
  if (res.status === 404) throw new Error('Drive folder not found: check the link (it must be your folder or shared with you)');
  if (!res.ok) throw new Error(`Google Drive error ${res.status}`);
  return raw ? res : res.json();
}

/** All audio files in the folder and its subfolders: [{ id, name, size }]. */
export async function listSongs(onProgress = () => {}) {
  const c = read();
  if (!c.folder) throw new Error('Paste your Drive folder link first');
  try { const f = await api(`/files/${c.folder}`, { fields: 'name', supportsAllDrives: 'true' }); patch({ folderName: f.name }); } catch (e) { if (e.expired) throw e; }
  const out = [], queue = [c.folder], seen = new Set();
  while (queue.length && seen.size < 200) {
    const dir = queue.shift();
    if (seen.has(dir)) continue; seen.add(dir);
    let pageToken = '';
    do {
      const r = await api('/files', {
        q: `'${dir}' in parents and trashed = false`, fields: 'nextPageToken, files(id, name, mimeType, size)',
        pageSize: '1000', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', ...(pageToken ? { pageToken } : {}),
      });
      for (const f of r.files || []) {
        if (f.mimeType === FOLDER) queue.push(f.id);
        else if (AUDIO.test(f.name) || /^audio\//.test(f.mimeType || '')) out.push({ id: f.id, name: f.name, size: +f.size || 0 });
      }
      pageToken = r.nextPageToken || '';
      onProgress(out.length);
    } while (pageToken);
  }
  return out;
}

/** The file's bytes, as a streaming Response. */
export function fetchFile(id) { return api(`/files/${id}`, { alt: 'media', supportsAllDrives: 'true' }, true); }
