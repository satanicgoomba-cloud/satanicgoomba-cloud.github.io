import { getAccessToken } from './spotify-auth.js?v=mwu7v3hh';

const API = 'https://api.spotify.com/v1';

export async function api(path, opts = {}) {
  const token = await getAccessToken();
  const r = await fetch(path.startsWith('http') ? path : API + path, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (r.status === 429) {
    const wait = Number(r.headers.get('Retry-After') || 2);
    await new Promise((res) => setTimeout(res, wait * 1000));
    return api(path, opts);
  }
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
 */
export async function getLikedSongs({ max = 1000, onPage } = {}) {
  const out = [];
  let url = '/me/tracks?limit=50&market=from_token';
  while (url && out.length < max) {
    const j = await api(url);
    for (const it of j.items) if (it.track && it.track.id && it.track.type !== 'episode') out.push(slimTrack(it.track));
    if (onPage) onPage(out);
    url = j.next;
  }
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
