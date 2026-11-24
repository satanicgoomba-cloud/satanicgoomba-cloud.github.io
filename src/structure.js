import { getJson, matches, timeout, abDocs } from './bpm.js?v=mwu4gh3p';
// Song structure without touching Spotify's audio. Three public sources, combined into one energy
// curve (how intense each moment is) plus, where possible, the real beat positions:
//
//   LRCLIB synced lyrics   timing only: repeated fast lines = chorus, slow repeats = pre-chorus,
//                          vocal pace, long silences. The lyrics themselves are never stored or shown.
//   osu! maps              how busy mappers made each part, "break" periods (silence), "kiai"
//                          (chorus) markers; beat timing only from ranked maps (reviewed timing).
//   AcousticBrainz         every beat's timestamp (songs analysed up to ~2022): exact beat
//                          positions and tempo changes.
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


/* ================= fetching ================= */

const inflight = new Map();
const pct = (arr, p) => { const a = arr.filter((x) => x > 0).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0; };

async function fetchLyrics(track) {
  const q = new URLSearchParams({ track_name: track.name.replace(/\s*[([].*$/, '').replace(/ - .*$/, ''), artist_name: firstArtist(track.artist) });
  const r = await Promise.race([fetch(`https://lrclib.net/api/search?${q}`, { credentials: 'omit', referrerPolicy: 'no-referrer' }), timeout(6000)]);
  const list = r.ok ? await r.json() : [];
  const dur = (track.duration_ms || 0) / 1000;
  const best = list.filter((x) => x.syncedLyrics && (!dur || Math.abs((x.duration || 0) - dur) <= 4) && !x.instrumental)
    .sort((a, b) => Math.abs(a.duration - dur) - Math.abs(b.duration - dur))[0];
  return best ? parseLrc(best.syncedLyrics) : null;
}

const TRUSTED = /ranked|approved|loved|qualified/;
/** Parse an .osu file: tempo points, breaks, kiai spans, object density per 2 s. */
export function parseOsu(text) {
  const sec = (n) => { const m = new RegExp(`\\[${n}\\]\\s*\\n([\\s\\S]*?)(?:\\n\\[|$)`).exec(text); return m ? m[1].split('\n').map((l) => l.trim()).filter(Boolean) : []; };
  const tempo = [], kiai = []; let on = null;
  for (const l of sec('TimingPoints')) {
    const p = l.split(','); const t = Math.round(+p[0]);
    if (p.length > 6 && p[6] === '1' && +p[1] > 0) tempo.push([t, +p[1]]);
    if (p.length > 7) { const k = (+p[7] & 1) === 1; if (k && on === null) on = t; if (!k && on !== null) { kiai.push([on, t]); on = null; } }
  }
  const breaks = sec('Events').filter((l) => /^(2|Break),/.test(l)).map((l) => { const p = l.split(','); return [+p[1], +p[2]]; });
  const objs = sec('HitObjects').map((l) => +l.split(',')[2]).filter((t) => t >= 0);
  const dens = [];
  for (const t of objs) { const b = Math.floor(t / 2000); dens[b] = (dens[b] || 0) + 1; }
  for (let i = 0; i < dens.length; i++) dens[i] = dens[i] || 0;
  if (on !== null && objs.length) kiai.push([on, objs[objs.length - 1]]);
  return { tempo, breaks, kiai, dens, last: objs.length ? objs[objs.length - 1] : 0 };
}
async function fetchOsu(track) {
  const q = encodeURIComponent(`${firstArtist(track.artist)} ${norm(track.name)}`);
  const d = await getJson(`https://osu.direct/api/v2/search?q=${q}&amount=15`, 6000);
  const sets = (Array.isArray(d) ? d : (d.beatmapsets || [])).filter((x) => matches(track, x.title, x.artist));
  // one map per set (the one with the most objects is the most detailed), trusted sets first, at most 2
  const picks = sets.map((x) => ({ trusted: TRUSTED.test(String(x.status)), b: (x.beatmaps || []).slice().sort((a, b) => (b.count_circles + b.count_sliders || 0) - (a.count_circles + a.count_sliders || 0))[0] }))
    .filter((x) => x.b).sort((a, b) => b.trusted - a.trusted).slice(0, 2);
  const out = [];
  for (const p of picks) {
    try {
      const r = await Promise.race([fetch(`https://osu.direct/api/osu/${p.b.id}`, { credentials: 'omit', referrerPolicy: 'no-referrer' }), timeout(6000)]);
      if (!r.ok) continue;
      const m = parseOsu(await r.text());
      if (m.dens.length) out.push({ ...m, trusted: p.trusted });
    } catch { /* skip this map */ }
  }
  return out.length ? out : null;
}
async function fetchAcousticBrainz(track) {
  const docs = await abDocs(track.isrc);
  const dur = (track.duration_ms || 0) / 1000;
  for (const { doc } of docs) {
    const r = doc.rhythm, len = doc.metadata && doc.metadata.audio_properties && doc.metadata.audio_properties.length;
    if (!r || !r.beats_position || r.beats_position.length < 16) continue;
    if (dur && len && Math.abs(len - dur) > 2) continue; // a different edit: its beats wouldn't line up
    // beats_position is every beat's time; beats_loudness is only summary statistics, so no loudness curve
    return { beats: r.beats_position.map((x) => Math.round(x * 1000)) };
  }
  return null;
}

/** Fetch everything we can learn about a song's shape and cache it. Resolves true if anything was found. */
export function lookupStructure(track) {
  if (!track || !track.id || track.sections || String(track.id).startsWith('practice')) return Promise.resolve(false);
  const hit = read()[track.id];
  const retryAb = hit && hit.abRetry && Date.now() - (hit.at || 0) > 60000; // AcousticBrainz/MusicBrainz was unreachable
  if (hit && hit.v === 2 && !retryAb && (hit.any || Date.now() - (hit.at || 0) < RETRY_MISS_MS)) return Promise.resolve(!!hit.any);
  if (inflight.has(track.id)) return inflight.get(track.id);
  const job = (async () => {
    const cap = (p) => Promise.race([p, timeout(10000)]).catch(() => null);
    let abFailed = false;
    const [lines, osu, ab] = await Promise.all([cap(fetchLyrics(track)), cap(fetchOsu(track)),
      Promise.race([fetchAcousticBrainz(track), timeout(12000)]).catch(() => { abFailed = true; return null; })]);
    const entry = { v: 2, at: Date.now(), any: !!(lines || osu || ab) };
    if (abFailed) entry.abRetry = true;
    if (lines) { entry.lines = lines; entry.src = 'lrclib'; }
    if (osu) entry.osu = osu;
    if (ab) entry.ab = ab;
    const db = read(); db[track.id] = entry;
    if (!writeSafe(db)) { const keys = Object.keys(db).sort((a, b) => (db[a].at || 0) - (db[b].at || 0)); keys.slice(0, keys.length >> 1).forEach((k) => delete db[k]); db[track.id] = entry; writeSafe(db); }
    return entry.any;
  })().catch(() => false).finally(() => inflight.delete(track.id));
  inflight.set(track.id, job);
  return job;
}
function writeSafe(db) { try { localStorage.setItem(CACHE, JSON.stringify(db)); return true; } catch { return false; } }

/* ================= combining ================= */
const BIN = 2000;
/**
 * Everything the beat map needs for one song: an energy curve (0..1 per 2 s), sections for the HUD and
 * arena colours, and the real beat times when a source has them.
 * @returns {{ sections, beats: number[]|null, beatSrc: string, energySrc: string[] }}
 */
export function analyze(track, bpm) {
  if (!track) return { sections: [], beats: null, beatSrc: '', energySrc: [] };
  if (track.sections) return { sections: track.sections, beats: null, beatSrc: '', energySrc: ['built in'] };
  const c = cachedStructure(track.id) || {};
  const dur = track.duration_ms || 180000;
  const B = Math.ceil(dur / BIN);
  const signals = [];

  if (c.lines) { // lyrics: section type + vocal pace
    const secs = classify(c.lines, dur, bpm);
    const starts = c.lines.filter((l) => l[1] >= 0).map((l) => l[0]);
    const pace = Array.from({ length: B }, (_, i) => { const t = i * BIN + BIN / 2; return starts.filter((x) => Math.abs(x - t) <= 4000).length; });
    const p90 = pct(pace, 0.9) || 1;
    signals.push({ w: 0.3, name: 'lyrics', v: Array.from({ length: B }, (_, i) => {
      const s = secs.find((x) => i * BIN + BIN / 2 >= x.t0 && i * BIN + BIN / 2 < x.t1);
      return 0.75 * (s ? s.energy : 0.5) + 0.25 * Math.min(1, pace[i] / p90);
    }) });
  }
  if (c.osu) { // osu!: mapper density, breaks = silence, kiai = chorus
    const maps = c.osu.map((m) => {
      const p90 = pct(m.dens, 0.9) || 1;
      return Array.from({ length: B }, (_, i) => {
        const t = i * BIN + BIN / 2;
        if (t > m.last + 4000) return 0;
        // a mapper's break is often a vocal gap over loud music, not real silence
        if (m.breaks.some(([a, b]) => t >= a && t < b)) return 0.3;
        let v = Math.min(1, (m.dens[i] || 0) / p90);
        if (m.kiai.some(([a, b]) => t >= a && t < b)) v = Math.max(v, 0.9);
        return v;
      });
    });
    signals.push({ w: 0.35, name: 'osu!', v: Array.from({ length: B }, (_, i) => maps.reduce((s, m) => s + m[i], 0) / maps.length) });
  }
  if (c.ab && Array.isArray(c.ab.loud)) { // per-beat loudness (only if a source ever provides it)
    const sum = new Array(B).fill(0), n = new Array(B).fill(0);
    c.ab.beats.forEach((t, k) => { const b = Math.floor(t / BIN); if (b < B) { sum[b] += c.ab.loud[k] || 0; n[b]++; } });
    const raw = sum.map((x, i) => (n[i] ? x / n[i] : 0));
    const lo = pct(raw, 0.1), hi = pct(raw, 0.9) || 1;
    signals.push({ w: 0.5, name: 'AcousticBrainz', v: raw.map((x, i) => (n[i] ? Math.max(0, Math.min(1, (x - lo) / ((hi - lo) || 1))) : 0)) });
  }

  let sections = [];
  if (signals.length) {
    const W = signals.reduce((s, x) => s + x.w, 0);
    let e = Array.from({ length: B }, (_, i) => signals.reduce((s, x) => s + x.w * x.v[i], 0) / W);
    e = e.map((_, i) => (e[Math.max(0, i - 1)] + 2 * e[i] + e[Math.min(B - 1, i + 1)]) / 4); // light smoothing
    const kind = (x) => (x < 0.15 ? 'quiet' : x < 0.42 ? 'calm' : x < 0.75 ? 'verse' : 'chorus');
    for (let i = 0; i < B; i++) {
      const k = kind(e[i]), last = sections[sections.length - 1];
      if (last && last.kind === k) { last.t1 = (i + 1) * BIN; last.sum += e[i]; last.n++; }
      else sections.push({ t0: i * BIN, t1: (i + 1) * BIN, kind: k, sum: e[i], n: 1 });
    }
    // fold 1-bin blips into the previous section
    sections = sections.reduce((acc, s) => { const last = acc[acc.length - 1]; if (last && s.n === 1 && s.kind !== 'quiet') { last.t1 = s.t1; last.sum += s.sum; last.n++; } else acc.push(s); return acc; }, []);
    sections = sections.map((s) => ({ t0: s.t0, t1: Math.min(s.t1, dur), kind: s.kind, energy: Math.round((s.sum / s.n) * 100) / 100 }));
  }

  // real beats: AcousticBrainz first, then a ranked osu! map's timing
  let beats = null, beatSrc = '';
  if (c.ab) { beats = c.ab.beats; beatSrc = 'AcousticBrainz'; }
  else {
    const m = (c.osu || []).find((x) => x.trusted && x.tempo.length);
    if (m) {
      beats = [];
      m.tempo.forEach(([t, len], i) => { const end = i + 1 < m.tempo.length ? m.tempo[i + 1][0] : dur; for (let x = t; x < end; x += len) if (x >= 0) beats.push(Math.round(x)); });
      beatSrc = 'osu! (ranked)';
    }
  }
  return { sections, beats, beatSrc, energySrc: signals.map((x) => x.name) };
}

export function structureSummary(track, bpm) {
  if (track && track.sections) return 'built in';
  const c = track && cachedStructure(track.id);
  if (!c) return '';
  if (!c.any) return 'none found';
  const a = analyze(track, bpm);
  const n = (k) => a.sections.filter((s) => s.kind === k).length;
  const parts = [`${n('chorus')} intense`, n('calm') ? `${n('calm')} calm` : '', n('quiet') ? `${n('quiet')} quiet` : ''].filter(Boolean).join(', ');
  return `${parts} (${a.energySrc.join('+')})${a.beats ? ` · beats: ${a.beatSrc}` : ''}`;
}
