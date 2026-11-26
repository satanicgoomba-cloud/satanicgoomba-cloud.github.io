// osu! beatmaps for TAP style. When a well-rated osu! map of the same song exists, TAP plays that map
// as it was made (circle positions, sliders, spinners, combos, circle size and approach speed) instead
// of the generated one. Maps come from the catboy.best mirror (osu!'s own API needs a login).
//
// Quality bar: ranked, approved, qualified or loved maps (reviewed by people), or popular graveyard
// maps (lots of favourites and plays). Maps with tempo changes are skipped, because they can't be lined
// up with the song's beat. The map is lined up with the beat we already detected for the song.

import { getJson, matches, timeout, norm, firstArtist } from './bpm.js?v=mwwz1k8r';

export const OSU_QUALITY = { favourites: 100, plays: 20000, durSec: 20, bpmTol: 0.02 };
const REVIEWED = new Set(['ranked', 'approved', 'qualified', 'loved']);
const STARS = { easy: 2, normal: 3, hard: 4.2, extreme: 5.3, maniac: 6.4 };
const API = 'https://catboy.best';

/** Does this beatmap set pass the bar? */
export function goodSet(s) {
  if (!s || s.nsfw) return false;
  if (REVIEWED.has(s.status)) return true;
  return (s.favourite_count || 0) >= OSU_QUALITY.favourites && (s.play_count || 0) >= OSU_QUALITY.plays;
}
const rankOf = (s) => (REVIEWED.has(s.status) ? 10 : 0) + Math.log10((s.favourite_count || 0) + 10) + Math.log10((s.play_count || 0) + 10) * 0.5;

/* ---------- reading a .osu file ---------- */
function sections(text) {
  const out = {}; let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim(); if (!l || l.startsWith('//')) continue;
    const m = /^\[(\w+)\]$/.exec(l); if (m) { cur = out[m[1]] = []; continue; }
    if (cur) cur.push(l);
  }
  return out;
}
const kv = (lines) => Object.fromEntries((lines || []).map((l) => { const i = l.indexOf(':'); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));

/** A slider's path in osu! pixels: control points -> evenly spaced points, cut to its pixel length. */
function sliderPath(kind, pts, length) {
  let raw = [];
  const bez = (cp) => { const n = Math.max(8, cp.length * 12), o = []; for (let s = 0; s <= n; s++) { let a = cp.map((p) => [...p]); const u = s / n; while (a.length > 1) a = a.slice(1).map((p, i) => [a[i][0] + (p[0] - a[i][0]) * u, a[i][1] + (p[1] - a[i][1]) * u]); o.push(a[0]); } return o; };
  if (kind === 'P' && pts.length === 3) {
    const [a, b, c] = pts, d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if (Math.abs(d) > 1e-3) {
      const sq = (p) => p[0] * p[0] + p[1] * p[1];
      const ux = (sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / d, uy = (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / d;
      const r = Math.hypot(a[0] - ux, a[1] - uy), t0 = Math.atan2(a[1] - uy, a[0] - ux);
      let t1 = Math.atan2(c[1] - uy, c[0] - ux);
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]), dir = cross > 0 ? 1 : -1; // which way round
      while (dir > 0 && t1 < t0) t1 += Math.PI * 2; while (dir < 0 && t1 > t0) t1 -= Math.PI * 2;
      const span = Math.max(Math.abs(t1 - t0), length / r) * dir;
      for (let s = 0; s <= 64; s++) { const t = t0 + (span * s) / 64; raw.push([ux + Math.cos(t) * r, uy + Math.sin(t) * r]); }
    } else kind = 'L';
  }
  if (!raw.length) {
    if (kind === 'L') raw = pts;
    else { // Bezier (and old Catmull curves, drawn as Bezier): a repeated point starts a new segment
      let seg = [pts[0]];
      for (let i = 1; i < pts.length; i++) {
        seg.push(pts[i]);
        if (i < pts.length - 1 && pts[i][0] === pts[i + 1][0] && pts[i][1] === pts[i + 1][1]) { raw.push(...bez(seg)); seg = []; }
      }
      if (seg.length > 1) raw.push(...bez(seg));
    }
  }
  // cut (or extend in a straight line) to the slider's length
  const out = [raw[0]]; let L = 0;
  for (let i = 1; i < raw.length && L < length; i++) {
    const p = out[out.length - 1], q = raw[i], d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < 1e-6) continue;
    if (L + d >= length) { const f = (length - L) / d; out.push([p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f]); L = length; break; }
    out.push(q); L += d;
  }
  if (L < length && out.length > 1) { const p = out[out.length - 1], q = out[out.length - 2], d = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1; out.push([p[0] + ((p[0] - q[0]) / d) * (length - L), p[1] + ((p[1] - q[1]) / d) * (length - L)]); }
  return out;
}

/** Parse a .osu (standard mode) file. Times stay in the map's own audio time. null if unusable. */
export function parseOsu(text) {
  const S = sections(text), gen = kv(S.General), dif = kv(S.Difficulty), meta = kv(S.Metadata);
  if (+(gen.Mode || 0) !== 0) return null;
  const tps = (S.TimingPoints || []).map((l) => l.split(',').map(Number)).filter((a) => a.length >= 2 && isFinite(a[0]));
  const red = tps.filter((a) => a[6] === undefined || isNaN(a[6]) || a[6] === 1).filter((a) => a[1] > 0);
  if (!red.length || red.some((a) => Math.abs(a[1] - red[0][1]) > 0.5)) return null; // tempo changes: skip
  const beat = red[0][1], tOff = red[0][0];
  const green = tps.filter((a) => a[6] === 0 && a[1] < 0).sort((a, b) => a[0] - b[0]);
  const svAt = (t) => { let sv = 1; for (const g of green) { if (g[0] > t + 1) break; sv = -100 / g[1]; } return Math.max(0.1, Math.min(10, sv)); };
  const sm = +(dif.SliderMultiplier || 1.4), tick = +(dif.SliderTickRate || 1);
  const objs = [];
  for (const l of S.HitObjects || []) {
    const a = l.split(','); const x = +a[0], y = +a[1], t = +a[2], type = +a[3];
    if (!isFinite(t)) continue;
    const nc = !!(type & 4), skip = (type >> 4) & 7;
    if (type & 1) objs.push({ type: 'circle', x, y, t, nc, skip });
    else if (type & 2) {
      const [kind, ...cp] = (a[5] || '').split('|'), slides = Math.max(1, +a[6] || 1), len = +a[7] || 0;
      const pts = [[x, y], ...cp.map((p) => p.split(':').map(Number))];
      if (len <= 0 || pts.length < 2) { objs.push({ type: 'circle', x, y, t, nc, skip }); continue; }
      const span = (len / (sm * 100 * svAt(t))) * beat;
      const path = sliderPath(kind, pts, len);
      const ticks = []; const tickMs = beat / tick;
      for (let b = tickMs; b < span - 10; b += tickMs) ticks.push(b); // tick times within one pass
      objs.push({ type: 'slider', x, y, t, nc, skip, span, slides, path, ticks });
    } else if (type & 8) objs.push({ type: 'spinner', t, end: +a[5], nc: true, skip });
  }
  if (objs.length < 30) return null;
  const cs = +(dif.CircleSize ?? 4), ar = +(dif.ApproachRate ?? dif.OverallDifficulty ?? 5);
  return { title: meta.Title, artist: meta.Artist, version: meta.Version, creator: meta.Creator, bpm: 60000 / beat, beat, tOff, cs, ar, objs };
}

/* ---------- finding a map ---------- */
const memo = new Map();
/** The best osu! map of this song for a difficulty that passes the bar, parsed. null if none. Cached per session. */
export async function fetchOsu(track, difficulty = 'normal') {
  const key = `${track.id}:${difficulty}`;
  if (memo.has(key)) return memo.get(key);
  const p = (async () => {
    const q = encodeURIComponent(`${firstArtist(track.artist)} ${norm(track.name)}`);
    // ranked, loved and anything (for popular unranked maps): the plain search is ordered by text match only
    const lists = await Promise.all(['&status=1', '&status=4', ''].map((f) => getJson(`${API}/api/v2/search?query=${q}&limit=30${f}`, 7000).catch(() => [])));
    const seen = new Set(), sets = lists.flat().filter((x) => x && !seen.has(x.id) && seen.add(x.id));
    const dur = (track.duration_ms || 0) / 1000;
    const cands = (Array.isArray(sets) ? sets : []).filter((s) => goodSet(s) && matches(track, s.title, s.artist))
      .map((s) => ({ s, maps: (s.beatmaps || []).filter((b) => b.mode_int === 0 && !b.convert && (!dur || (b.total_length <= dur + 5 && b.total_length >= dur - OSU_QUALITY.durSec - 60))) }))
      .filter((c) => c.maps.length).sort((a, b) => rankOf(b.s) - rankOf(a.s));
    for (const c of cands.slice(0, 2)) {
      const want = STARS[difficulty] || 3;
      const order = c.maps.slice().sort((a, b) => Math.abs(a.difficulty_rating - want) - Math.abs(b.difficulty_rating - want));
      for (const b of order.slice(0, 2)) {
        try {
          const r = await Promise.race([fetch(`${API}/osu/${b.id}`, { credentials: 'omit', referrerPolicy: 'no-referrer' }), timeout(8000)]);
          if (!r.ok) continue;
          const m = parseOsu(await r.text());
          if (!m) continue;
          return { ...m, id: b.id, setId: c.s.id, stars: b.difficulty_rating, status: c.s.status, name: `${c.s.artist} - ${c.s.title} [${b.version}]`, mapper: c.s.creator };
        } catch { /* next */ }
      }
    }
    return null;
  })().catch(() => null);
  memo.set(key, p);
  const res = await p; if (!res) setTimeout(() => memo.delete(key), 10 * 60000); // look again later if the mirror was down
  return res;
}

/**
 * Line the map up with our beat: same tempo (or double/half) within 2%, then shift it by less than half
 * a beat so its beats land on ours. null if the tempos don't agree.
 */
export function alignOsu(m, tempo) {
  const ours = 60000 / tempo.bpm;
  const ratio = [1, 2, 0.5].find((k) => Math.abs(m.beat * k - ours) / ours <= OSU_QUALITY.bpmTol);
  if (!ratio) return null;
  const grid = Math.min(m.beat, ours);
  let d = ((tempo.offsetMs || 0) - m.tOff) % grid; if (d > grid / 2) d -= grid; if (d < -grid / 2) d += grid;
  return d;
}
