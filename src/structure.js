// Song structure without touching Spotify's audio: read the timing of a song's synced lyrics from
// LRCLIB (free, open lyrics database) and work out verse / pre-chorus / chorus from how lines repeat
// and how quickly they come. Only timestamps and "which lines repeat" are kept; the lyrics themselves
// are never stored or shown.
//
//   - lines that repeat and come quickly (about one per bar)  -> chorus   (busy)
//   - a repeated line just before a chorus, sung slowly       -> pre-chorus (calm: the slow-down)
//   - lines that don't repeat                                 -> verse    (normal)
//   - no vocals: before the first line / after the last / long gaps -> intro / outro / break

const CACHE = 'bb.struct';
const RETRY_MISS_MS = 3 * 24 * 3600e3;
export const ENERGY = { intro: 0.3, verse: 0.6, pre: 0.35, chorus: 1, break: 0.55, outro: 0.3 };

function read() { try { return JSON.parse(localStorage.getItem(CACHE)) || {}; } catch { return {}; } }
function write(db) { try { localStorage.setItem(CACHE, JSON.stringify(db)); } catch { /* storage full */ } }
export function cachedStructure(trackId) { return read()[trackId] || null; }

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/\(feat[^)]*\)|feat\.? .*$|ft\.? .*$/g, ' ')
  .replace(/\((?:[^)]*(remaster|version|edit|radio|explicit|clean|mono|stereo)[^)]*)\)| - .*(remaster|version|edit|mix|live).*$/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const firstArtist = (a) => String(a || '').split(/,|&| x /i)[0].trim();

/** Parse LRC text into [[ms, group], ...]; group = index of identical lines (-1 = empty/instrumental marker). */
export function parseLrc(lrc) {
  const groups = new Map(), out = [];
  for (const line of String(lrc || '').split('\n')) {
    const m = /^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/.exec(line.trim());
    if (!m) continue;
    const ms = Math.round((+m[1] * 60 + +m[2]) * 1000);
    const key = norm(m[3]);
    if (!key) { out.push([ms, -1]); continue; }
    if (!groups.has(key)) groups.set(key, groups.size);
    out.push([ms, groups.get(key)]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** Turn lyric timing into sections. lines: [[ms, group]], durMs: song length, bpm: for bar length. */
export function classify(lines, durMs, bpm) {
  const bar = 240000 / (bpm || 120);
  const L = lines.filter((l) => l[1] >= 0);
  if (L.length < 4) return [];
  const count = new Map();
  for (const [, g] of L) count.set(g, (count.get(g) || 0) + 1);
  const next = (i) => (i + 1 < lines.length ? lines[i + 1][0] : durMs);

  // 1) label each sung line
  const lab = lines.map(([t, g], i) => {
    if (g < 0) return 'gap';
    const rep = count.get(g) >= 2, dense = next(i) - t <= bar * 1.4;
    return rep && dense ? 'chorus' : rep ? 'rep' : 'verse';
  });
  if (!lab.includes('chorus')) { // songs whose chorus isn't faster: use the most repeated lines
    const max = Math.max(...count.values());
    lines.forEach(([, g], i) => { if (g >= 0 && max >= 3 && count.get(g) >= Math.max(3, max * 0.6)) lab[i] = 'chorus'; });
  }
  // 2) resolve repeated-but-slow lines: the tail of a chorus, a pre-chorus, or chorus-like refrains
  for (let i = 0; i < lab.length; i++) {
    if (lab[i] !== 'rep') continue;
    const prevSung = [...lab.slice(0, i)].reverse().find((x) => x !== 'gap');
    const closeToPrev = i > 0 && lines[i][0] - lines[i - 1][0] <= bar * 2.6;
    if (prevSung === 'chorus' && closeToPrev) { lab[i] = 'chorus'; continue; }
    const ahead = lab.slice(i + 1, i + 4);
    if (ahead.includes('chorus')) { lab[i] = 'pre'; continue; }
    lab[i] = count.get(lines[i][1]) >= 3 ? 'chorus' : 'verse';
  }
  // a line squeezed between chorus lines is part of the chorus
  for (let i = 1; i < lab.length - 1; i++) if (lab[i] === 'verse' && lab[i - 1] === 'chorus' && lab[i + 1] === 'chorus') lab[i] = 'chorus';

  // 3) spans: each line lasts until the next one, but long silences become instrumental breaks
  const spans = [];
  const push = (t0, t1, kind) => { if (t1 - t0 > 50) spans.push({ t0, t1, kind }); };
  push(0, lines[0][0], 'intro');
  let lastSung = lines.length - 1; while (lastSung > 0 && lines[lastSung][1] < 0) lastSung--;
  lines.forEach(([t], i) => {
    const end = next(i);
    const tail = i > lastSung || (i === lastSung && false); // gaps after the last sung line are the outro
    if (lab[i] === 'gap') { push(t, end, tail ? 'outro' : end - t >= bar * 4 ? 'break' : (lab[i - 1] || 'verse')); return; }
    // a pause shorter than ~4 bars belongs to the line before it (singers breathe); longer is a break
    const sungEnd = end - t < bar * 4 + bar * 2.5 ? end : t + bar * 2.5;
    push(t, sungEnd, lab[i]);
    if (end > sungEnd) push(sungEnd, end, i >= lastSung ? 'outro' : 'break');
  });
  // 4) merge neighbours of the same kind; absorb tiny bits into their neighbour
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && (last.kind === s.kind || s.t1 - s.t0 < bar)) last.t1 = s.t1;
    else merged.push({ ...s });
  }
  if (merged.length && merged[merged.length - 1].t1 < durMs) merged[merged.length - 1].t1 = durMs;
  return merged.map((s) => ({ t0: s.t0, t1: s.t1, kind: s.kind, energy: ENERGY[s.kind] }));
}

/** Sections for a song at a given tempo, from the cache (call lookupStructure first). */
export function sectionsFor(track, bpm) {
  if (track && track.sections) return track.sections;
  const c = track && cachedStructure(track.id);
  if (!c || !c.lines) return [];
  return classify(c.lines, track.duration_ms || c.dur || 180000, bpm);
}
export function structureSummary(track, bpm) {
  const c = track && cachedStructure(track.id);
  if (track && track.sections) return 'built in';
  if (!c) return '';
  if (!c.lines) return 'none found (no synced lyrics)';
  const secs = sectionsFor(track, bpm);
  const n = (k) => secs.filter((s) => s.kind === k).length;
  return `from lyrics: ${n('chorus')} chorus${n('chorus') === 1 ? '' : 'es'}${n('pre') ? `, ${n('pre')} slow-down${n('pre') === 1 ? '' : 's'}` : ''}`;
}

const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));
const inflight = new Map();
/** Find synced lyrics on LRCLIB and cache their timing. Resolves true if found. */
export function lookupStructure(track) {
  if (!track || !track.id || track.sections || String(track.id).startsWith('practice')) return Promise.resolve(false);
  const hit = read()[track.id];
  if (hit && (hit.lines || Date.now() - (hit.at || 0) < RETRY_MISS_MS)) return Promise.resolve(!!hit.lines);
  if (inflight.has(track.id)) return inflight.get(track.id);
  const job = (async () => {
    const q = new URLSearchParams({ track_name: track.name.replace(/\s*[([].*$/, '').replace(/ - .*$/, ''), artist_name: firstArtist(track.artist) });
    const r = await Promise.race([fetch(`https://lrclib.net/api/search?${q}`, { credentials: 'omit', referrerPolicy: 'no-referrer' }), timeout(6000)]);
    const list = r.ok ? await r.json() : [];
    const dur = (track.duration_ms || 0) / 1000;
    const best = list.filter((x) => x.syncedLyrics && (!dur || Math.abs((x.duration || 0) - dur) <= 4) && !x.instrumental)
      .sort((a, b) => Math.abs(a.duration - dur) - Math.abs(b.duration - dur))[0];
    const db = read();
    db[track.id] = best ? { src: 'lrclib', lines: parseLrc(best.syncedLyrics), dur: Math.round(best.duration * 1000), at: Date.now() } : { at: Date.now() };
    write(db);
    return !!best;
  })().catch(() => { const db = read(); db[track.id] = { at: 0 }; write(db); return false; })
    .finally(() => inflight.delete(track.id));
  inflight.set(track.id, job);
  return job;
}
