import { getAccessToken } from './spotify-auth.js?v=mwxyztpx';

const API = 'https://api.spotify.com/v1';

// Spotify's request limit: a short Retry-After is waited out (once); a long one (the app's quota is
// used up) stops all calls until then with a clear message, instead of hanging or hammering Spotify, which
// only makes the wait longer.
// The browser can't read Spotify's Retry-After (it isn't shared with web pages), so the wait is unknown:
// each refusal in a row waits longer (1, 2, 5, 15, 30, 60 min), remembered across reloads, and a success resets it.
const COOL = 'bb.spCool', STEPS = [1, 2, 5, 15, 30, 60];
let { until: coolUntil = 0, level: coolLevel = 0 } = (() => { try { return JSON.parse(localStorage.getItem(COOL)) || {}; } catch { return {}; } })();
const saveCool = () => { try { localStorage.setItem(COOL, JSON.stringify({ until: coolUntil, level: coolLevel })); } catch { /* ignore */ } };
const at = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const coolErr = () => {
  const min = Math.max(1, Math.ceil((coolUntil - Date.now()) / 60000));
  const msg = coolLevel > 1
    ? `Spotify is still refusing this app (request limit, refused ${coolLevel} times in a row). Next try at ${at(coolUntil)}, in ${min} min. Practice and Leaks still work.`
    : `Spotify's request limit for this app is used up: trying again at ${at(coolUntil)} (in ${min} min). Practice and Leaks still work.`;
  return Object.assign(new Error(msg), { status: 429, cooldown: true });
};
export const coolingDown = () => Date.now() < coolUntil;
/** TRY AGAIN: allow one request now. If Spotify still refuses, the next wait is the longer one. */
export function retryNow() { coolUntil = 0; saveCool(); }

export async function api(path, opts = {}, tries = 0) {
  if (Date.now() < coolUntil) throw coolErr();
  const token = await getAccessToken();
  const r = await fetch(path.startsWith('http') ? path : API + path, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (r.status === 429) {
    const wait = Number(r.headers.get('Retry-After')) || 2;
    let quota = false; try { quota = /QUOTA/i.test(await r.text()); } catch { /* ignore */ }
    if (!quota && wait <= 10 && tries < 1) {
      await new Promise((res) => setTimeout(res, wait * 1000));
      return api(path, opts, tries + 1);
    }
    const step = STEPS[Math.min(coolLevel, STEPS.length - 1)] * 60;
    coolLevel++;
    coolUntil = Date.now() + Math.max(wait, step) * 1000; saveCool();
    console.warn(`Spotify 429 (${coolLevel} in a row${quota ? ', quota exceeded' : ''}): next try in ${Math.round((coolUntil - Date.now()) / 1000)}s`);
    throw coolErr();
  }
  if (coolLevel) { coolLevel = 0; coolUntil = 0; saveCool(); } // Spotify answered: the limit is over
  if (r.status === 204 || r.status === 202) return null;
  const text = await r.text();
  const j = text ? JSON.parse(text) : null;
  if (!r.ok) {
    const err = new Error((j && j.error && j.error.message) || `Spotify API ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return j;
}

export async function getProfile() {
  const me = await api('/me');
  return {
    id: me.id,
    name: me.display_name || me.id,
    avatar: (me.images && me.images.length && me.images[0].url) || '',
    product: me.product, // 'premium' needed for playback
    country: me.country,
  };
}

function slimTrack(t) {
  return {
    id: t.id, uri: t.uri, name: t.name,
    artist: t.artists.map((a) => a.name).join(', '),
    album: t.album && t.album.name,
    art: (t.album && t.album.images && t.album.images.length && t.album.images[t.album.images.length > 1 ? 1 : 0].url) || '',
    duration_ms: t.duration_ms,
    isrc: (t.external_ids && t.external_ids.isrc) || '',
    playable: t.is_playable !== false,
  };
}

/**
 * Liked Songs, newest first. Calls onPage(tracksSoFar) after every page so the
 * game can start on page one while the rest loads. Capped to keep within dev-mode quota.
 * The list is kept on this device: if the first page matches the saved list (same total, same newest
 * songs), the saved list is used and no more pages are fetched.
 */
const LIKED = 'bb.likedCache';
export function cachedLiked() { try { const c = JSON.parse(localStorage.getItem(LIKED)); return c && Array.isArray(c.tracks) ? c : null; } catch { return null; } }
export async function getLikedSongs({ max = 1000, onPage } = {}) {
  const out = [], cache = cachedLiked();
  let url = '/me/tracks?limit=50&market=from_token', total = 0, first = true;
  while (url && out.length < max) {
    const j = await api(url);
    for (const it of j.items) if (it.track && it.track.id && it.track.type !== 'episode') out.push(slimTrack(it.track));
    if (first) {
      first = false; total = j.total;
      if (cache && cache.total === total && out.length && out.slice(0, 20).every((t, i) => cache.tracks[i] && cache.tracks[i].id === t.id)) {
        if (onPage) onPage(cache.tracks);
        return cache.tracks.filter((t) => t.playable);
      }
    }
    if (onPage) onPage(out);
    url = j.next;
  }
  try { localStorage.setItem(LIKED, JSON.stringify({ total, at: Date.now(), tracks: out })); } catch { /* full: skip */ }
  return out.filter((t) => t.playable);
}

/** Search Spotify's catalogue for songs (playable in your country). */
// Apps in Spotify's Development Mode get small search pages (a limit of 30 is refused as
// "Invalid limit"), so ask for 10 per page, fetch a few pages, and drop `limit` if even that is refused.
export async function searchTracks(q, pages = 3) {
  if (!q || !q.trim()) return [];
  const base = `/search?type=track&market=from_token&q=${encodeURIComponent(q.trim())}`;
  const page = async (offset) => {
    try { return await api(`${base}&limit=10&offset=${offset}`); }
    catch (e) {
      if (offset === 0 && e.status === 400 && /limit/i.test(e.message)) return api(base); // no limit/offset at all
      if (offset === 0) throw e;
      return null; // later pages are a bonus
    }
  };
  const out = [], seen = new Set();
  for (let i = 0; i < pages; i++) {
    const j = await page(i * 10);
    const items = (j && j.tracks && j.tracks.items) || [];
    for (const t of items) if (t && t.id && !seen.has(t.id)) { seen.add(t.id); out.push(slimTrack(t)); }
    if (items.length < 10 || !(j.tracks && j.tracks.next)) break;
  }
  return out.filter((t) => t.playable);
}

export const getDevices = async () => (await api('/me/player/devices')).devices || [];
export const getPlaybackState = () => api('/me/player?market=from_token');
/** Make a device the active one (needed right after the in-browser player appears). */
export const transferPlayback = (deviceId) => api('/me/player', { method: 'PUT', body: JSON.stringify({ device_ids: [deviceId], play: false }) });

export function playTrack(uri, deviceId, positionMs = 0) {
  const q = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
  return api(`/me/player/play${q}`, { method: 'PUT', body: JSON.stringify({ uris: [uri], position_ms: positionMs }) });
}
/** Set a device's volume (0-100). Used for the silent pause that keeps the Quest's Spotify app awake. */
export function setVolume(pct, deviceId) {
  const q = `?volume_percent=${Math.max(0, Math.min(100, Math.round(pct)))}${deviceId ? `&device_id=${encodeURIComponent(deviceId)}` : ''}`;
  return api(`/me/player/volume${q}`, { method: 'PUT' });
}
export function pause(deviceId) {
  const q = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
  return api(`/me/player/pause${q}`, { method: 'PUT' }).catch(() => {});
}
export function resume(deviceId) {
  const q = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
  return api(`/me/player/play${q}`, { method: 'PUT' }).catch(() => {});
}
