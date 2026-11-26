// Real tempo for Spotify songs without analysing Spotify's audio: ask several public music databases
// at once and keep the BPM most of them agree on. Results are saved per song, so replays load instantly.
//
//   Deezer (by ISRC, then by artist+title)      catalogue BPM, often blank
//   BeatSaver  (Beat Saber community maps)       BPM set by the mapper: exact (well-rated maps only)
//   osu! (osu.direct mirror)                     BPM set by the mapper: exact
//   AcousticBrainz (via MusicBrainz ISRC)        BPM from audio analysis (to ~2022)
//
// Only song identifiers (ISRC, or artist + title) are sent. Deezer only offers JSONP (it answers with
// a script), so Deezer runs inside a sandboxed iframe with an opaque origin: its script can't reach
// this page, its storage or the Spotify login. The other services allow normal browser requests.

import { goodMap } from './beatsaver.js?v=mwwugtl4';

const CACHE = 'bb.bpmdb';
const RETRY_MISS_MS = 3 * 24 * 3600e3; // try songs with no match again after 3 days

function read() { try { return JSON.parse(localStorage.getItem(CACHE)) || {}; } catch { return {}; } }
function write(db) { try { localStorage.setItem(CACHE, JSON.stringify(db)); } catch { /* full */ } }
export function cachedBpm(trackId) { const v = read()[trackId]; return v && v.bpm > 0 ? v.bpm : 0; }
export function cachedInfo(trackId) { return read()[trackId] || null; }

/* ---------------- helpers ---------------- */
export const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));
export async function getJson(url, ms = 5000) {
  const r = await Promise.race([fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' }), timeout(ms)]);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
export const norm = (s) => String(s || '').toLowerCase()
  .replace(/\(feat[^)]*\)|\[feat[^\]]*\]|feat\.? .*$|ft\.? .*$/g, ' ')
  .replace(/ - .*(remaster|version|edit|mix|live|mono|stereo).*$/g, ' ')
  .replace(/\((?:[^)]*(remaster|version|edit|radio|explicit|clean|mono|stereo)[^)]*)\)/g, ' ')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
export const firstArtist = (a) => norm(String(a || '').split(/,|&| x | and /i)[0]);
export function matches(track, title, artist, durationS) {
  const t1 = norm(track.name), t2 = norm(title);
  if (!t1 || !t2) return false;
  const titleOk = t1 === t2 || (t1.length > 3 && t2.includes(t1)) || (t2.length > 3 && t1.includes(t2));
  // other versions (remix, acoustic, sped up, nightcore…) have other tempos: reject unless the Spotify title says so too
  const variant = /remix|acoustic|sped|slowed|nightcore|cover|instrumental|live|8bit|piano/;
  if (variant.test(t2) && !variant.test(t1)) return false;
  const a1 = firstArtist(track.artist), a2 = norm(artist);
  const artistOk = !!a1 && (a2.includes(a1) || a1.includes(a2));
  const durOk = !durationS || !track.duration_ms || Math.abs(durationS - track.duration_ms / 1000) < 15;
  return titleOk && artistOk && durOk;
}

/* ---------------- Deezer via sandboxed JSONP ---------------- */
let frame = null, frameReady = null, seq = 0;
const waiting = new Map();
function ensureFrame() {
  if (frameReady) return frameReady;
  frameReady = new Promise((resolve) => {
    frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts'); // no allow-same-origin: opaque origin
    frame.style.display = 'none';
    frame.srcdoc = `<!doctype html><script>
      addEventListener('message', (e) => {
        const id = Number(e.data && e.data.id), path = String(e.data && e.data.path || '');
        if (!/^(track\\/(isrc:)?[A-Za-z0-9]+|search\\?q=[^&#]+)$/.test(path)) return parent.postMessage({ id, data: null }, '*');
        const cb = 'cb' + id, s = document.createElement('script');
        const done = (data) => { delete window[cb]; s.remove(); parent.postMessage({ id, data: JSON.parse(JSON.stringify(data || null)) }, '*'); };
        window[cb] = done;
        s.onerror = () => done(null);
        s.src = 'https://api.deezer.com/' + path + (path.includes('?') ? '&' : '?') + 'output=jsonp&callback=' + cb;
        document.head.appendChild(s);
      });
      parent.postMessage({ ready: true }, '*');
    <\/script>`;
    addEventListener('message', (e) => {
      if (!frame || e.source !== frame.contentWindow || !e.data) return;
      if (e.data.ready) return resolve();
      const w = waiting.get(e.data.id);
      if (w) { waiting.delete(e.data.id); w(e.data.data); }
    });
    document.body.appendChild(frame);
  });
  return frameReady;
}
async function deezer(path, ms = 5000) {
  await Promise.race([ensureFrame(), timeout(3000)]);
  const id = ++seq;
  const ask = new Promise((r) => { waiting.set(id, r); frame.contentWindow.postMessage({ id, path }, '*'); });
  return Promise.race([ask, timeout(ms)]);
}

/* ---------------- sources: each returns [{ bpm, src, w }] ---------------- */
async function srcDeezer(t) {
  const out = [];
  if (t.isrc && /^[A-Z0-9]{12}$/i.test(t.isrc)) {
    const d = await deezer(`track/isrc:${t.isrc}`).catch(() => null);
    if (d && d.bpm > 0) out.push({ bpm: d.bpm, src: 'Deezer', w: 3 });
  }
  if (!out.length) {
    const q = encodeURIComponent(`${firstArtist(t.artist)} ${norm(t.name)}`);
    const s = await deezer(`search?q=${q}`).catch(() => null);
    const hits = ((s && s.data) || []).filter((x) => matches(t, x.title, x.artist && x.artist.name, x.duration)).slice(0, 2);
    for (const h of hits) {
      const d = await deezer(`track/${h.id}`).catch(() => null);
      if (d && d.bpm > 0) { out.push({ bpm: d.bpm, src: 'Deezer', w: 2 }); break; }
    }
  }
  return out;
}
async function srcBeatSaver(t) {
  const q = encodeURIComponent(`${firstArtist(t.artist)} ${norm(t.name)}`);
  const d = await getJson(`https://api.beatsaver.com/search/text/0?q=${q}&sortOrder=Relevance`);
  return (d.docs || []).filter((x) => goodMap(x) && matches(t, x.metadata.songName, x.metadata.songAuthorName, x.metadata.duration))
    .slice(0, 3).map((x) => ({ bpm: x.metadata.bpm, src: 'BeatSaver', w: 2 }));
}
async function srcOsu(t) {
  const q = encodeURIComponent(`${firstArtist(t.artist)} ${norm(t.name)}`);
  const d = await getJson(`https://osu.direct/api/v2/search?q=${q}&amount=15`);
  const list = Array.isArray(d) ? d : (d.beatmapsets || []);
  return list.filter((x) => matches(t, x.title, x.artist, x.beatmaps && x.beatmaps[0] && x.beatmaps[0].total_length))
    .slice(0, 3).map((x) => ({ bpm: x.bpm, src: 'osu!', w: 2 }));
}
// MusicBrainz allows about one request per second, so its calls are spaced out, and each song's
// AcousticBrainz analysis is fetched once and shared by the tempo and structure lookups.
let mbChain = Promise.resolve();
function mbGet(url) {
  const run = mbChain.then(() => getJson(url, 6000));
  mbChain = run.catch(() => null).then(() => new Promise((r) => setTimeout(r, 1100)));
  return run;
}
const abMemo = new Map();
/** AcousticBrainz low-level analysis docs for a recording's ISRC: [{ mbid, doc }] (may be empty). */
export function abDocs(isrc) {
  if (!isrc || !/^[A-Z0-9]{12}$/i.test(isrc)) return Promise.resolve([]);
  if (!abMemo.has(isrc)) {
    abMemo.set(isrc, (async () => {
      const mb = await mbGet(`https://musicbrainz.org/ws/2/isrc/${isrc}?fmt=json`);
      const ids = (mb.recordings || []).map((r) => r.id).slice(0, 3);
      if (!ids.length) return [];
      const ab = await getJson(`https://acousticbrainz.org/api/v1/low-level?recording_ids=${ids.join(';')}`, 9000);
      return ids.filter((id) => ab[id] && ab[id][0]).map((id) => ({ mbid: id, doc: ab[id][0] }));
    })().catch((e) => { abMemo.delete(isrc); throw e; }));
  }
  return abMemo.get(isrc);
}
async function srcAcousticBrainz(t) {
  const docs = await abDocs(t.isrc);
  const d = docs.find((x) => x.doc.rhythm && x.doc.rhythm.bpm > 0);
  return d ? [{ bpm: d.doc.rhythm.bpm, src: 'AcousticBrainz', w: 2 }] : [];
}

/* ---------------- consensus ---------------- */
// Fold into one octave (doubles/halves are the same pulse), so 87 and 174 agree.
const fold = (b) => { while (b < 80) b *= 2; while (b >= 160) b /= 2; return b; };
export function consensus(cands) {
  const c = cands.filter((x) => x.bpm >= 40 && x.bpm <= 300).map((x) => ({ ...x, f: fold(x.bpm) }));
  if (!c.length) return null;
  let best = null;
  for (const a of c) {
    const group = c.filter((b) => Math.abs(b.f - a.f) <= 1.5);
    const weight = group.reduce((s, g) => s + g.w, 0) + new Set(group.map((g) => g.src)).size; // agreeing sources count extra
    if (!best || weight > best.weight) best = { group, weight };
  }
  // exact (mapper / catalogue) values first; analysis values only as a fallback
  const exact = best.group.filter((g) => g.src !== 'AcousticBrainz');
  const pool = (exact.length ? exact : best.group).map((g) => g.f).sort((x, y) => x - y);
  const bpm = pool[Math.floor(pool.length / 2)];
  return { bpm: Math.round(bpm * 100) / 100, sources: [...new Set(best.group.map((g) => g.src))], votes: best.group.length, total: c.length };
}

/* ---------------- lookup ---------------- */
// Background lookups run one at a time; the song you're pointing at (or fighting) skips the queue.
let queue = Promise.resolve();
const inflight = new Map();
const NAMES = ['Deezer', 'BeatSaver', 'osu!', 'AcousticBrainz'];
const SOURCES = [srcDeezer, srcBeatSaver, srcOsu, srcAcousticBrainz];
const CAP_MS = 5000; // use whatever has arrived by then

async function runLookup(track) {
  const diag = {};
  const cands = [];
  await new Promise((resolve) => {
    let left = SOURCES.length;
    const cap = setTimeout(() => { for (const n of NAMES) if (!(n in diag)) diag[n] = 'too slow'; resolve(); }, CAP_MS);
    SOURCES.forEach((f, i) => {
      f(track).then((r) => { cands.push(...r); diag[NAMES[i]] = r.length ? `${Math.round(r[0].bpm)}` : 'no match'; },
        (e) => { diag[NAMES[i]] = String(e && e.message || e).slice(0, 40); })
        .finally(() => { if (--left === 0) { clearTimeout(cap); resolve(); } });
    });
  });
  const res = consensus(cands);
  const db = read();
  // a miss caused by errors (not "no match") is retried on the next look instead of in 3 days
  const errored = Object.values(diag).some((d) => d !== 'no match' && !/^\d/.test(d));
  db[track.id] = res ? { bpm: res.bpm, src: res.sources.join('+'), votes: res.votes, at: Date.now(), diag }
    : { bpm: 0, at: errored ? 0 : Date.now(), diag };
  write(db);
  return db[track.id].bpm;
}

/** Look a song up in every source and save the agreed BPM. Resolves the BPM (0 if nothing matched). */
export function lookupBpm(track, { force = false, priority = false } = {}) {
  if (!track || !track.id || String(track.id).startsWith('practice')) return Promise.resolve(0);
  const hit = read()[track.id];
  if (!force && hit && (hit.bpm > 0 || Date.now() - (hit.at || 0) < RETRY_MISS_MS)) return Promise.resolve(hit.bpm || 0);
  if (inflight.has(track.id)) return inflight.get(track.id);
  let job;
  if (priority) job = runLookup(track);
  else { job = queue.then(() => runLookup(track)); queue = job.catch(() => 0); }
  job = job.catch(() => 0).finally(() => inflight.delete(track.id));
  inflight.set(track.id, job);
  return job;
}

/** Warm the cache for songs the player is looking at (background, one at a time). */
export function prefetchBpm(tracks) { for (const t of tracks) lookupBpm(t).catch(() => 0); }

/** Short text for the fight card when a lookup found nothing. */
export function lookupDiag(trackId) {
  const d = (read()[trackId] || {}).diag;
  return d ? NAMES.map((n) => `${n}: ${d[n] || '?'}`).join(' · ') : '';
}
