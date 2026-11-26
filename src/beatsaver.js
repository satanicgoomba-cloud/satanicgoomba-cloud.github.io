// BeatSaver (where BMBF gets Beat Saber custom maps): a hand-made map of the same song shows where a human
// mapper put the action: busy parts, calm parts and silences. Only maps that pass a quality bar are used.
//
// The map zip also holds the map's copy of the song, and BeatSaver's server only sends whole zips, so the
// download is a few MB. Only the small map files (.dat) are unpacked; the audio is never decoded or kept.
// What's kept per song: note counts per 2 s, gaps, and the map's name/score (a few hundred bytes).

import { getJson, matches, timeout, norm, firstArtist } from './bpm.js?v=mwwz1k8r';

/** The quality bar. Ranked/qualified/curated maps were reviewed by people, so they need a little less. */
export const QUALITY = { score: 0.75, upvotes: 30, reviewedScore: 0.6, maxParity: 0.05, durSec: 3 };

const reviewed = (d) => !!(d.ranked || d.qualified || d.blRanked || d.blQualified || d.curator || d.curatedAt);
/** Does this BeatSaver map pass the bar? No auto-generated or AI maps, well rated, enough votes. */
export function goodMap(d) {
  if (!d || !d.metadata || !d.stats) return false;
  if (d.automapper || (d.declaredAi && d.declaredAi !== 'None')) return false;
  const s = d.stats.score || 0, up = d.stats.upvotes || 0;
  return reviewed(d) ? s >= QUALITY.reviewedScore : s >= QUALITY.score && up >= QUALITY.upvotes;
}
const rankOf = (d) => (reviewed(d) ? 10 : 0) + (d.stats.score || 0) * Math.log10((d.stats.upvotes || 0) + 10);

/** The most detailed Standard difficulty with few parity (flow) errors. */
function pickDiff(v) {
  const order = ['Easy', 'Normal', 'Hard', 'Expert', 'ExpertPlus'];
  return (v.diffs || []).filter((x) => x.characteristic === 'Standard' && x.notes > 40 && x.nps >= 1
    && (!x.paritySummary || x.paritySummary.errors / x.notes <= QUALITY.maxParity) && !x.ne && !x.me)
    .sort((a, b) => order.indexOf(b.difficulty) - order.indexOf(a.difficulty))[0] || null;
}

/* ---------- minimal zip reader: only the files asked for ---------- */
async function inflate(bytes, method) {
  if (method === 0) return bytes;
  if (method !== 8) throw new Error('zip method');
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function unzip(buf, want) {
  const v = new DataView(buf), u8 = new Uint8Array(buf), dec = new TextDecoder();
  let e = buf.byteLength - 22;
  while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('not a zip');
  const n = v.getUint16(e + 10, true); let p = v.getUint32(e + 16, true);
  const out = {};
  for (let i = 0; i < n; i++) {
    const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true);
    const nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), off = v.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nl));
    if (want(name)) {
      const ln = v.getUint16(off + 26, true), lx = v.getUint16(off + 28, true), start = off + 30 + ln + lx;
      out[name.toLowerCase()] = dec.decode(await inflate(u8.subarray(start, start + size), method));
    }
    p += 46 + nl + xl + cl;
  }
  return out;
}

/** Note times (ms) from a map's info + difficulty files (v2, v3 and v4 formats). null if it can't be timed. */
export function parseMap(infoText, diffText) {
  const info = JSON.parse(infoText), d = JSON.parse(diffText);
  const bpm = info._beatsPerMinute || (info.audio && info.audio.bpm) || 0;
  if (!(bpm > 0) || (info._songTimeOffset || 0) !== 0) return null;
  const changes = d._BPMChanges || (d._customData && d._customData._BPMChanges) || d.bpmEvents || [];
  if (changes.some((c) => Math.abs((c._BPM || c._bpm || c.m || bpm) - bpm) > 0.01)) return null; // tempo changes: skip
  const notes = d._notes ? d._notes.filter((x) => x._type !== 3).map((x) => x._time) : (d.colorNotes || []).map((x) => x.b);
  const ms = notes.filter((b) => typeof b === 'number' && b >= 0).map((b) => Math.round((b * 60000) / bpm)).sort((a, b) => a - b);
  return ms.length > 40 ? { bpm, ms } : null;
}

/** note counts per 2 s, and gaps of 3 s or more inside the song */
export function shape(ms) {
  const dens = [];
  for (const t of ms) { const b = Math.floor(t / 2000); dens[b] = (dens[b] || 0) + 1; }
  for (let i = 0; i < dens.length; i++) dens[i] = dens[i] || 0;
  const gaps = [];
  for (let i = 1; i < ms.length; i++) if (ms[i] - ms[i - 1] >= 3000) gaps.push([ms[i - 1] + 400, ms[i] - 400]);
  return { dens, gaps, first: ms[0], last: ms[ms.length - 1] };
}

/** The best matching map that passes the bar, unpacked into a song shape. null if none. */
export async function fetchBeatSaver(track) {
  const q = encodeURIComponent(`${firstArtist(track.artist)} ${norm(track.name)}`);
  const d = await getJson(`https://api.beatsaver.com/search/text/0?q=${q}&sortOrder=Relevance`, 6000);
  const dur = (track.duration_ms || 0) / 1000;
  const cands = (d.docs || []).filter((x) => goodMap(x) && matches(track, x.metadata.songName, x.metadata.songAuthorName, x.metadata.duration)
    && (!dur || Math.abs(x.metadata.duration - dur) <= QUALITY.durSec)) // same edit of the song, or the timing won't line up
    .map((x) => ({ x, v: (x.versions || [])[0] })).map((c) => ({ ...c, diff: c.v && pickDiff(c.v) })).filter((c) => c.diff)
    .sort((a, b) => rankOf(b.x) - rankOf(a.x));
  for (const c of cands.slice(0, 2)) {
    try {
      const r = await Promise.race([fetch(c.v.downloadURL, { credentials: 'omit', referrerPolicy: 'no-referrer' }), timeout(20000)]);
      if (!r.ok) continue;
      const files = await unzip(await r.arrayBuffer(), (n) => /\.dat$/i.test(n));
      const infoText = files['info.dat']; if (!infoText) continue;
      const info = JSON.parse(infoText);
      const sets = info._difficultyBeatmapSets ? info._difficultyBeatmapSets.filter((s) => s._beatmapCharacteristicName === 'Standard').flatMap((s) => s._difficultyBeatmaps.map((b) => [b._difficulty, b._beatmapFilename]))
        : (info.difficultyBeatmaps || []).filter((b) => b.characteristic === 'Standard').map((b) => [b.difficulty, b.beatmapDataFilename]);
      const fn = (sets.find(([df]) => df === c.diff.difficulty) || [])[1];
      const m = fn && files[fn.toLowerCase()] && parseMap(infoText, files[fn.toLowerCase()]);
      if (!m) continue;
      return { ...shape(m.ms), bpm: m.bpm, id: c.x.id, name: c.x.name, mapper: c.x.metadata.levelAuthorName, diff: c.diff.difficulty,
        score: c.x.stats.score, upvotes: c.x.stats.upvotes, reviewed: reviewed(c.x) };
    } catch { /* try the next map */ }
  }
  return null;
}
