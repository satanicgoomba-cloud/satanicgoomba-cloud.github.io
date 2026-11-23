// Player profile: Spotify name + avatar, plus game stats kept in this browser.
// Shareable two ways: a PNG card, and a link whose data lives in the URL hash
// (no server, nothing uploaded; whoever opens the link sees what's encoded in it).

const STATS = 'bb.stats', PROFILE = 'bb.profile';

export function loadProfile() { try { return JSON.parse(localStorage.getItem(PROFILE)); } catch { return null; } }
export function saveProfile(p) { localStorage.setItem(PROFILE, JSON.stringify(p)); }

export function loadStats() {
  try { return JSON.parse(localStorage.getItem(STATS)) || blank(); } catch { return blank(); }
}
function blank() { return { tracks: {}, games: 0, totalScore: 0, bestCombo: 0, hits: 0, misses: 0, supers: 0 }; }

/** Record a finished (or skipped after 30s) song. */
export function recordRun(track, run) {
  const s = loadStats();
  const t = s.tracks[track.id] || { name: track.name, artist: track.artist, art: track.art, plays: 0, best: 0, bestCombo: 0, bestAcc: 0 };
  t.name = track.name; t.artist = track.artist; t.art = track.art;
  t.plays++;
  t.best = Math.max(t.best, run.score);
  t.bestCombo = Math.max(t.bestCombo, run.maxCombo);
  const acc = run.hits + run.misses ? run.hits / (run.hits + run.misses) : 0;
  t.bestAcc = Math.max(t.bestAcc, acc);
  t.last = Date.now();
  s.tracks[track.id] = t;
  s.games++; s.totalScore += run.score; s.hits += run.hits; s.misses += run.misses; s.supers += run.supers;
  s.bestCombo = Math.max(s.bestCombo, run.maxCombo);
  localStorage.setItem(STATS, JSON.stringify(s));
  return { isBest: run.score >= t.best && run.score > 0, track: t };
}

export function clearStats() { localStorage.removeItem(STATS); }

export function summary(profile, stats = loadStats()) {
  const list = Object.values(stats.tracks);
  return {
    name: (profile && profile.name) || 'Guest Brawler',
    avatar: (profile && profile.avatar) || '',
    games: stats.games,
    totalScore: stats.totalScore,
    bestCombo: stats.bestCombo,
    accuracy: stats.hits + stats.misses ? Math.round((100 * stats.hits) / (stats.hits + stats.misses)) : 0,
    supers: stats.supers,
    highScores: [...list].sort((a, b) => b.best - a.best).slice(0, 5).map((t) => ({ name: t.name, artist: t.artist, score: t.best })),
    topPlayed: [...list].sort((a, b) => b.plays - a.plays || b.last - a.last).slice(0, 5).map((t) => ({ name: t.name, artist: t.artist, plays: t.plays })),
  };
}

/* ---------- share link ---------- */
const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

export function encodeShare(sum) {
  const payload = {
    v: 1, n: clip(sum.name, 40), a: sum.avatar, g: sum.games, s: sum.totalScore, c: sum.bestCombo, x: sum.accuracy,
    h: sum.highScores.map((t) => [clip(t.name, 48), clip(t.artist, 40), t.score]),
    p: sum.topPlayed.map((t) => [clip(t.name, 48), clip(t.artist, 40), t.plays]),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let bin = ''; bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeShare(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
  const p = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  const okAvatar = typeof p.a === 'string' && /^https:\/\/([a-z0-9-]+\.)*(scdn\.co|spotifycdn\.com|fbcdn\.net)\//i.test(p.a);
  return {
    name: String(p.n || 'Brawler'), avatar: okAvatar ? p.a : '', games: +p.g || 0, totalScore: +p.s || 0,
    bestCombo: +p.c || 0, accuracy: +p.x || 0,
    highScores: (p.h || []).map(([name, artist, score]) => ({ name: String(name), artist: String(artist), score: +score || 0 })),
    topPlayed: (p.p || []).map(([name, artist, plays]) => ({ name: String(name), artist: String(artist), plays: +plays || 0 })),
  };
}

export function shareUrl(sum) {
  const base = location.origin + location.pathname.replace(/[^/]*$/, '');
  return `${base}profile.html#${encodeShare(sum)}`;
}

/* ---------- share card (PNG) ---------- */
function loadImg(src) {
  return new Promise((res) => {
    if (!src) return res(null);
    const i = new Image(); i.crossOrigin = 'anonymous';
    i.onload = () => res(i); i.onerror = () => res(null); i.src = src;
  });
}

export async function drawCard(sum, canvas = document.createElement('canvas')) {
  const W = 1080, H = 1350; canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#16052b'); bg.addColorStop(0.55, '#2a0a3d'); bg.addColorStop(1, '#03263a');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  // ring glow
  for (let i = 0; i < 6; i++) {
    g.strokeStyle = `rgba(${i % 2 ? '0,229,255' : '255,45,111'},${0.08 + i * 0.02})`;
    g.lineWidth = 3; g.beginPath(); g.arc(W / 2, 330, 190 + i * 22, 0, Math.PI * 2); g.stroke();
  }
  const font = (w, s) => `${w} ${s}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const av = await loadImg(sum.avatar);
  g.save(); g.beginPath(); g.arc(W / 2, 330, 170, 0, Math.PI * 2); g.clip();
  if (av) { try { g.drawImage(av, W / 2 - 170, 160, 340, 340); g.getImageData(0, 0, 1, 1); } catch { /* tainted */ } }
  else {
    g.fillStyle = '#ff2d6f'; g.fillRect(W / 2 - 170, 160, 340, 340);
    g.fillStyle = '#fff'; g.font = font(800, 150); g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText((sum.name || '?').trim().charAt(0).toUpperCase(), W / 2, 335);
  }
  g.restore();
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  g.fillStyle = '#00e5ff'; g.font = font(700, 34); g.fillText('BEATBRAWLER VR', W / 2, 90);
  g.fillStyle = '#fff'; g.font = font(800, 72); g.fillText(clip(sum.name, 22), W / 2, 590);
  const stat = (x, label, value) => {
    g.fillStyle = '#ff2d6f'; g.font = font(800, 58); g.fillText(value, x, 700);
    g.fillStyle = 'rgba(255,255,255,0.7)'; g.font = font(600, 26); g.fillText(label, x, 740);
  };
  stat(W * 0.2, 'TOTAL SCORE', sum.totalScore.toLocaleString());
  stat(W * 0.5, 'BEST COMBO', String(sum.bestCombo));
  stat(W * 0.8, 'ACCURACY', `${sum.accuracy}%`);
  const list = (y, title, rows, right) => {
    g.textAlign = 'left'; g.fillStyle = '#00e5ff'; g.font = font(700, 30); g.fillText(title, 90, y);
    rows.slice(0, 4).forEach((t, i) => {
      const yy = y + 52 + i * 50;
      g.fillStyle = '#fff'; g.font = font(600, 30); g.fillText(clip(`${t.name} · ${t.artist}`, 44), 90, yy);
      g.textAlign = 'right'; g.fillStyle = 'rgba(255,255,255,0.8)'; g.fillText(right(t), W - 90, yy); g.textAlign = 'left';
    });
    if (!rows.length) { g.fillStyle = 'rgba(255,255,255,0.5)'; g.font = font(500, 28); g.fillText('No songs played yet', 90, y + 52); }
  };
  list(830, 'HIGH SCORES', sum.highScores, (t) => t.score.toLocaleString());
  list(1080, 'MOST PLAYED', sum.topPlayed, (t) => `${t.plays}×`);
  g.textAlign = 'center'; g.fillStyle = 'rgba(255,255,255,0.45)'; g.font = font(500, 22);
  g.fillText(`${sum.games} rounds · ${sum.supers} super punches`, W / 2, H - 40);
  return canvas;
}

export async function shareCard(sum) {
  const c = await drawCard(sum);
  let blob;
  try { blob = await new Promise((r) => c.toBlob(r, 'image/png')); } catch { blob = null; }
  if (!blob) throw new Error('Could not render the card (avatar image blocked).');
  const file = new File([blob], 'beatbrawler-profile.png', { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    await navigator.share({ files: [file], title: 'My BeatBrawler VR profile', url: shareUrl(sum) });
    return 'shared';
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return 'downloaded';
}
