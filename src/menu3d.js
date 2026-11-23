import { Panel, placeOnArc, rr, fitText, FONT, C } from './ui3d.js?v=mwtthjow';

// In-world menus: song select (song wall | fight card | corner), pause, results.
// Everything here is drawn on canvases; the app supplies data + callbacks via `api`.

const imgCache = new Map();
function art(url, onload) {
  if (!url) return null;
  let e = imgCache.get(url);
  if (!e) {
    const img = new Image(); img.crossOrigin = 'anonymous';
    e = { img, ok: false, waiters: [] };
    img.onload = () => { e.ok = true; e.waiters.splice(0).forEach((f) => f()); };
    img.onerror = () => { e.failed = true; };
    img.src = url; imgCache.set(url, e);
  }
  if (!e.ok && !e.failed && onload && !e.waiters.includes(onload)) e.waiters.push(onload);
  return e.ok ? e.img : null;
}

const mmss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

export class Menu {
  constructor(scene, pointers, api) {
    this.api = api; this.pointers = pointers;
    this.tab = 'liked'; this.scroll = 0; this.sel = 0; this.screen = 'hidden';
    this.songs = new Panel('songs', 1.05, 1.35);
    this.card = new Panel('card', 1.15, 1.35);
    this.corner = new Panel('corner', 0.9, 1.35);
    this.pause = new Panel('pause', 0.85, 0.95);
    this.results = new Panel('results', 1.1, 1.05);
    this.keys = new Panel('keys', 1.2, 0.56);           // on-screen keyboard for Spotify search
    this.keys.mesh.renderOrder = 10;                     // drawn over the other panels
    this.keysOpen = false;
    this.all = [this.songs, this.card, this.corner, this.pause, this.results, this.keys];
    for (const p of this.all) { scene.add(p.mesh); p.visible = false; }
    pointers.panels = this.all;
    this.songs.draw = (g, p) => this._drawSongs(g, p);
    this.card.draw = (g, p) => this._drawCard(g, p);
    this.corner.draw = (g, p) => this._drawCorner(g, p);
    this.pause.draw = (g, p) => this._drawPause(g, p);
    this.results.draw = (g, p) => this._drawResults(g, p);
    this.keys.draw = (g, p) => this._drawKeys(g, p);
    this.songs.onClick = (id) => this._clickSongs(id);
    this.songs.onScroll = (d) => this._scrollBy(d);
    this.card.onClick = (id) => this._clickCard(id);
    this.corner.onClick = (id) => this._clickCorner(id);
    this.pause.onClick = (id) => this.api.onPauseAction(id);
    this.results.onClick = (id) => this.api.onResultsAction(id);
    this.keys.onClick = (id) => this._clickKeys(id);
  }

  layout(headY, desktop) {
    const y = headY - 0.12;
    const az = desktop ? 25 : 33, d = desktop ? 3.0 : 2.3;
    placeOnArc(this.songs.mesh, az, d, y);
    placeOnArc(this.card.mesh, 0, d, y);
    placeOnArc(this.corner.mesh, -az, d, y);
    placeOnArc(this.pause.mesh, 0, desktop ? 1.7 : 1.9, headY - 0.1);
    placeOnArc(this.results.mesh, 0, desktop ? 1.8 : 2.0, headY - 0.1);
    // keyboard: closer than the fight card and a little low, tilted up toward your face
    placeOnArc(this.keys.mesh, 0, desktop ? 1.9 : 1.15, headY - (desktop ? 0.45 : 0.42));
    this.keys.mesh.lookAt(0, headY, 0);
  }

  show(screen) {
    this.screen = screen;
    const sel = screen === 'select';
    this.songs.visible = this.card.visible = this.corner.visible = sel;
    this.pause.visible = screen === 'pause';
    this.results.visible = screen === 'results';
    this.keys.visible = sel && this.tab === 'search' && this.keysOpen;
    this.pointers.enabled = screen !== 'hidden';
    this.refresh();
  }

  refresh() { for (const p of this.all) if (p.visible) p.redraw(); }

  list() { return this.api.lists()[this.tab] || []; }
  get ROWS() { return this.tab === 'search' ? 7 : 8; }
  set ROWS(v) { /* fixed per tab */ }
  selected() { return this.list()[this.sel]; }

  _scrollBy(d) {
    const max = Math.max(0, this.list().length - this.ROWS);
    const next = Math.min(max, Math.max(0, this.scroll + d));
    if (Math.floor(next) !== Math.floor(this.scroll)) { this.scroll = next; this.songs.redraw(); } else this.scroll = next;
  }

  /* ---------------- song wall ---------------- */
  _drawSongs(g, p) {
    const lists = this.api.lists();
    const W = p.W;
    p.button('tab:liked', 20, 22, 196, 60, `LIKED${lists.liked.length ? ` (${lists.liked.length})` : ''}`, { style: 'tab', selected: this.tab === 'liked', size: 20 });
    p.button('tab:search', 224, 22, 152, 60, 'SEARCH', { style: 'tab', selected: this.tab === 'search', size: 20 });
    p.button('tab:practice', 384, 22, 150, 60, 'PRACTICE', { style: 'tab', selected: this.tab === 'practice', size: 20 });
    p.button('up', W - 82, 22, 58, 60, '▲', { size: 26 });
    const list = this.list();
    const rowH = 78;
    let top = 100;
    if (this.tab === 'search') { // search box: tap it to open the keyboard
      const st = this.api.searchState();
      p.button('searchbox', 16, 96, W - 32, 64, '', { style: 'row' });
      rr(g, 16, 96, W - 32, 64, 16); g.fillStyle = this.keysOpen ? 'rgba(0,229,255,0.16)' : 'rgba(255,255,255,0.08)'; g.fill();
      g.strokeStyle = this.keysOpen ? C.cyan : C.line; g.lineWidth = 3; g.stroke();
      g.textAlign = 'left'; g.textBaseline = 'middle'; g.font = FONT(600, 24);
      g.fillStyle = st.q ? C.text : C.muted;
      g.fillText(fitText(g, st.q ? st.q + (this.keysOpen ? '▏' : '') : 'Search Spotify (song or artist)…', W - 80), 34, 129);
      top = 172;
    }
    const first = Math.floor(this.scroll);
    if (!list.length) {
      g.fillStyle = C.muted; g.font = FONT(600, 24); g.textAlign = 'left'; g.textBaseline = 'top';
      const st = this.api.searchState();
      const msg = this.tab === 'liked' ? (this.api.loggedIn() ? 'Loading your Liked Songs…' : 'Log in with Spotify on the start page to see your Liked Songs. Practice works without it.')
        : this.tab === 'search' ? (!this.api.loggedIn() ? 'Log in with Spotify to search.' : st.busy ? 'Searching…' : st.error ? st.error : st.q ? 'No songs found.' : 'Tap the box above and type a song or artist.') : '';
      wrap(g, msg, 34, top + 20, W - 68, 32);
    }
    for (let i = 0; i < this.ROWS; i++) {
      const idx = first + i, t = list[idx];
      if (!t) break;
      const y = top + i * rowH;
      const hov = p.button(`row:${idx}`, 16, y, W - 32, rowH - 6, '', { style: 'row' });
      rr(g, 16, y, W - 32, rowH - 6, 14);
      g.fillStyle = idx === this.sel ? 'rgba(0,229,255,0.22)' : hov ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.04)'; g.fill();
      if (idx === this.sel) { g.strokeStyle = C.cyan; g.lineWidth = 3; g.stroke(); }
      const im = art(t.art, () => p.redraw());
      if (im) g.drawImage(im, 26, y + 6, 60, 60);
      else { rr(g, 26, y + 6, 60, 60, 8); g.fillStyle = t.id.startsWith('practice') ? C.pink : 'rgba(255,255,255,0.1)'; g.fill(); }
      g.textAlign = 'left'; g.textBaseline = 'top';
      g.fillStyle = C.text; g.font = FONT(700, 24); g.fillText(fitText(g, t.name, W - 260), 100, y + 8);
      g.fillStyle = C.muted; g.font = FONT(500, 19); g.fillText(fitText(g, t.artist, W - 260), 100, y + 40);
      const best = this.api.best(t.id);
      g.textAlign = 'right';
      g.fillStyle = best ? C.gold : C.muted; g.font = FONT(700, 20);
      g.fillText(best ? best.toLocaleString() : mmss(t.duration_ms), W - 30, y + 26);
    }
    p.button('down', W - 82, p.H - 76, 58, 60, '▼', { size: 26 });
    if (list.length > this.ROWS) {
      g.fillStyle = C.muted; g.font = FONT(500, 18); g.textAlign = 'left'; g.textBaseline = 'middle';
      g.fillText(`${first + 1}–${Math.min(list.length, first + this.ROWS)} of ${list.length} · thumbstick to scroll`, 28, p.H - 46);
    }
  }

  _clickSongs(id) {
    if (id === 'searchbox') { this.keysOpen = !this.keysOpen; this.show(this.screen); return; }
    if (id.startsWith('tab:')) { this.tab = id.slice(4); this.sel = 0; this.scroll = 0; this.keysOpen = this.tab === 'search' && !this.api.searchState().q; this.show(this.screen); }
    else if (id === 'up') this._scrollBy(-this.ROWS + 1);
    else if (id === 'down') this._scrollBy(this.ROWS - 1);
    else if (id.startsWith('row:')) this.sel = +id.slice(4);
    if (id.startsWith('row:') && this.tab === 'search' && this.keysOpen) { this.keysOpen = false; this.show(this.screen); }
    if (this.api.onSelectTrack && this.tab !== 'practice') this.api.onSelectTrack(this.list(), this.sel);
    this.songs.redraw(); this.card.redraw();
  }

  /* ---------------- on-screen keyboard (search) ---------------- */
  _drawKeys(g, p) {
    const W = p.W, rows = ['1234567890', 'QWERTYUIOP', 'ASDFGHJKL\'', 'ZXCVBNM-&⌫'];
    const kw = 56, kh = 58, gap = 6, top = 22;
    rows.forEach((row, r) => {
      const n = row.length, x0 = (W - (n * kw + (n - 1) * gap)) / 2;
      [...row].forEach((ch, i) => p.button(ch === '⌫' ? 'k:back' : `k:${ch}`, x0 + i * (kw + gap), top + r * (kh + gap), kw, kh, ch, { size: 24 }));
    });
    const y = top + 4 * (kh + gap);
    p.button('k:clear', 30, y, 150, kh, 'CLEAR', { size: 20 });
    p.button('k: ', 190, y, W - 380, kh, 'SPACE', { size: 20 });
    p.button('k:done', W - 180, y, 150, kh, 'DONE', { style: 'primary', size: 22 });
  }
  _clickKeys(id) {
    const st = this.api.searchState();
    let q = st.q || '';
    if (id === 'k:back') q = q.slice(0, -1);
    else if (id === 'k:clear') q = '';
    else if (id === 'k:done') { this.keysOpen = false; this.show(this.screen); this.api.onSearch(q, true); return; }
    else if (id.startsWith('k:')) q = (q + id.slice(2).toLowerCase()).slice(0, 60);
    this.sel = 0; this.scroll = 0;
    this.api.onSearch(q, false);
    this.songs.redraw();
  }
  /** Typing on a real keyboard (screen mode). Returns true if the key was used. */
  typeKey(key) {
    if (this.screen !== 'select' || this.tab !== 'search') return false;
    if (key === 'Enter') { this._clickKeys('k:done'); return true; }
    if (key === 'Backspace') { this._clickKeys('k:back'); return true; }
    if (key === 'Escape' && this.keysOpen) { this.keysOpen = false; this.show(this.screen); return true; }
    if (key.length === 1) { if (!this.keysOpen) { this.keysOpen = true; this.show(this.screen); } this._clickKeys(`k:${key}`); return true; }
    return false;
  }

  /* ---------------- fight card (centre) ---------------- */
  _drawCard(g, p) {
    const W = p.W, t = this.selected();
    const s = this.api.settings();
    g.textAlign = 'center'; g.textBaseline = 'top';
    g.fillStyle = C.cyan; g.font = FONT(800, 22); g.fillText('SONG CARD', W / 2, 26);
    if (t) {
      const im = art(t.art, () => p.redraw());
      const A = 250, ax = (W - A) / 2, ay = 66;
      if (im) g.drawImage(im, ax, ay, A, A);
      else {
        const grd = g.createLinearGradient(ax, ay, ax + A, ay + A); grd.addColorStop(0, C.pink); grd.addColorStop(1, '#3a0a6b');
        rr(g, ax, ay, A, A, 20); g.fillStyle = grd; g.fill();
        g.fillStyle = '#fff'; g.font = FONT(900, 90); g.textBaseline = 'middle'; g.fillText('♪', W / 2, ay + A / 2); g.textBaseline = 'top';
      }
      g.fillStyle = C.text; g.font = FONT(800, 34); g.fillText(fitText(g, t.name, W - 60), W / 2, 334);
      g.fillStyle = C.muted; g.font = FONT(600, 24); g.fillText(fitText(g, t.artist, W - 60), W / 2, 378);
      const info = this.api.trackInfo(t);
      g.font = FONT(500, 20); g.fillStyle = C.text;
      g.fillText(`${mmss(t.duration_ms)} · ${info.tempo}`, W / 2, 418);
      g.fillStyle = /^from|built/.test(info.structure) ? C.gold : C.muted; g.fillText(fitText(g, `Sections: ${info.structure}`, W - 50), W / 2, 446);
      const err = !String(t.id).startsWith('practice') && (this.api.audioError() || (info.lookup ? `Tempo lookup: ${info.lookup}` : ''));
      if (!err) { g.fillStyle = C.muted; g.fillText(info.best, W / 2, 474); }
      else { // audio problem: say what to do, on two lines where the best score would be
        g.fillStyle = '#ff8a8a'; g.font = FONT(600, 17);
        const words = err.split(' '); const lines = ['']; 
        for (const w of words) { const tryL = (lines[lines.length - 1] + ' ' + w).trim(); if (g.measureText(tryL).width > W - 50 && lines[lines.length - 1]) lines.push(w); else lines[lines.length - 1] = tryL; }
        lines.slice(0, 2).forEach((l, i) => g.fillText(i === 1 && lines.length > 2 ? fitText(g, l + ' ' + lines.slice(2).join(' '), W - 50) : l, W / 2, 470 + i * 21));
      }
    }
    const diffs = ['easy', 'normal', 'hard', 'extreme', 'maniac'];
    const bw = (W - 60 - 4 * 8) / 5;
    diffs.forEach((d, i) => p.button(`diff:${d}`, 30 + i * (bw + 8), 516, bw, 64, d.toUpperCase(), { selected: s.difficulty === d, size: 17 }));
    p.button('autoplay', 30, 596, (W - 70) / 2, 56, `AUTOPLAY ${s.autoplay !== false ? 'ON' : 'OFF'}`, { selected: s.autoplay !== false, size: 20 });
    p.button('shuffle', 40 + (W - 70) / 2, 596, (W - 70) / 2, 56, `SHUFFLE ${s.shuffle ? 'ON' : 'OFF'}`, { selected: !!s.shuffle, size: 20 });
    const busy = this.api.loading && this.api.loading();
    p.button('fight', 30, 676, W - 60, 110, busy || (t ? 'PLAY!' : 'PICK A SONG'), { style: 'primary', size: busy ? 30 : 44, color: busy ? '#8a5cff' : undefined });
  }

  _clickCard(id) {
    const s = this.api.settings();
    if (id.startsWith('diff:')) this.api.setSetting('difficulty', id.slice(5));
    else if (id === 'autoplay') this.api.setSetting('autoplay', s.autoplay === false);
    else if (id === 'shuffle') this.api.setSetting('shuffle', !s.shuffle);
    else if (id === 'fight' && this.selected()) return this.api.onPlay(this.tab, this.sel);
    this.card.redraw();
  }

  /* ---------------- corner (right) ---------------- */
  _drawCorner(g, p) {
    if (this.loginHelp) return this._drawLoginHelp(g, p);
    const W = p.W, prof = this.api.profile(), s = this.api.settings();
    g.textAlign = 'center'; g.textBaseline = 'top';
    g.fillStyle = C.cyan; g.font = FONT(800, 22); g.fillText('YOUR CORNER', W / 2, 26);
    const im = art(prof.avatar, () => p.redraw());
    g.save(); g.beginPath(); g.arc(W / 2, 140, 70, 0, Math.PI * 2); g.clip();
    if (im) g.drawImage(im, W / 2 - 70, 70, 140, 140);
    else { g.fillStyle = C.pink; g.fillRect(W / 2 - 70, 70, 140, 140); g.fillStyle = '#fff'; g.font = FONT(900, 70); g.textBaseline = 'middle'; g.fillText(prof.name.charAt(0).toUpperCase(), W / 2, 142); g.textBaseline = 'top'; }
    g.restore();
    g.fillStyle = C.text; g.font = FONT(800, 30); g.fillText(fitText(g, prof.name, W - 40), W / 2, 222);
    g.fillStyle = C.muted; g.font = FONT(500, 20);
    g.fillText(`${prof.totalScore.toLocaleString()} pts · best combo ${prof.bestCombo} · ${prof.accuracy}%`, W / 2, 262);
    g.fillStyle = C.muted; g.font = FONT(600, 19); g.textAlign = 'left';
    if (this.api.loggedIn()) p.button('audio', 30, 296, W - 60, 44, fitText(g, `AUDIO: ${this.api.outputName()}  ▸`, W - 80), { size: 17 });
    else g.fillText('Audio: practice tracks only', 30, 312);
    g.fillText('Audio latency', 30, 352);
    p.button('lat:-', 30, 380, 80, 56, '−', { size: 30 });
    g.fillStyle = C.text; g.font = FONT(800, 26); g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(`${s.latency || 0} ms`, W / 2, 408); g.textBaseline = 'top';
    p.button('lat:+', W - 110, 380, 80, 56, '+', { size: 30 });
    const hs = this.api.hitSounds();
    p.button('sounds', 30, 456, W - 60, 56, `HIT SOUNDS ${hs === undefined ? 'AUTO' : hs ? 'ON' : 'OFF'}`, { selected: !!hs, size: 20 });
    if (this.api.loggedIn()) p.button('card', 30, 528, W - 60, 56, 'SAVE PROFILE CARD', { size: 20 });
    else p.button('login', 30, 528, W - 60, 56, 'LOG IN TO SPOTIFY', { style: 'primary', color: '#1ed760', size: 20 });
    p.button('exit', 30, 600, W - 60, 56, this.api.inVR() ? 'EXIT VR' : 'BACK TO LOBBY', { size: 20 });
    g.fillStyle = C.muted; g.font = FONT(500, 17); g.textAlign = 'left';
    const help = this.api.inVR()
      ? ['Trigger or pinch: select · Stick: scroll', 'Slice pink cubes with the left saber, blue with the right', 'Swing the way the arrow points · dots: any way', 'Keep sabers off mines · duck and lean past walls', 'Pause: B/Y, Meta button, or tap left wrist · A/X: tap the beat']
      : ['Click: select · Wheel: scroll', 'In game: move the mouse to swing the saber', 'T tap tempo · [ ] nudge the beat', 'Esc pause · N next song', 'Add ?bot=1 to the address to watch a bot play'];
    help.forEach((l, i) => g.fillText(l, 30, 680 + i * 24));
    g.textAlign = 'right'; g.fillStyle = 'rgba(244,240,255,0.35)'; g.font = FONT(500, 15); g.fillText(`build ${this.api.build()}`, W - 24, 26);
  }

  /** In the Quest app, Spotify's login can't open, so explain the Quest Browser route. */
  _drawLoginHelp(g, p) {
    const W = p.W;
    g.textAlign = 'center'; g.textBaseline = 'top';
    g.fillStyle = C.cyan; g.font = FONT(800, 24); g.fillText('LOG IN TO SPOTIFY', W / 2, 26);
    g.textAlign = 'left'; g.fillStyle = C.text; g.font = FONT(600, 21);
    const lines = [
      '1. Press the Meta button and open the',
      '   Quest Browser.',
      '2. Go to  satanicgoomba-cloud.github.io',
      '3. Enter your Client ID (first time) and',
      '   tap  Log in with Spotify  (Google and',
      '   Facebook work there).',
      '4. Tap  Open the game with this login',
      '   - or tap  Copy login code, come back',
      '   here and press PASTE LOGIN CODE.',
    ];
    lines.forEach((l, i) => g.fillText(l, 30, 80 + i * 34));
    p.button('paste', 30, 420, W - 60, 60, 'PASTE LOGIN CODE', { style: 'primary', color: '#1ed760', size: 22 });
    p.button('back', 30, 500, W - 60, 56, 'BACK', { size: 20 });
    g.fillStyle = C.muted; g.font = FONT(500, 17);
    g.fillText('The code stays on this headset. Don\'t share it.', 30, 580);
  }

  _clickCorner(id) {
    if (this.loginHelp) {
      if (id === 'paste') this.api.onPasteCode();
      else if (id === 'back') this.loginHelp = false;
      this.corner.redraw(); return;
    }
    const s = this.api.settings();
    if (id === 'lat:-') this.api.setSetting('latency', (s.latency || 0) - 10);
    else if (id === 'lat:+') this.api.setSetting('latency', (s.latency || 0) + 10);
    else if (id === 'sounds') { const hs = this.api.hitSounds(); this.api.setSetting('hitSounds', hs === undefined ? true : hs ? false : undefined); }
    else if (id === 'card') this.api.onShareCard();
    else if (id === 'login') this.api.onLogin();
    else if (id === 'audio') this.api.onAudio();
    else if (id === 'exit') this.api.onExit();
    this.corner.redraw();
  }

  /* ---------------- pause ---------------- */
  _drawPause(g, p) {
    const W = p.W, t = this.api.current();
    g.textAlign = 'center'; g.textBaseline = 'top';
    g.fillStyle = C.text; g.font = FONT(900, 48); g.fillText('PAUSED', W / 2, 30);
    if (t) { g.fillStyle = C.muted; g.font = FONT(600, 22); g.fillText(fitText(g, `${t.name} · ${t.artist}`, W - 60), W / 2, 92); }
    const items = [['resume', 'RESUME', 'primary'], ['restart', 'RESTART'], ['skip', 'NEXT SONG'], ['select', 'SONG SELECT']];
    items.forEach(([id, label, style], i) => p.button(id, 40, 140 + i * 88, W - 80, 72, label, { style: style || 'ghost', size: style ? 32 : 24 }));
  }

  /* ---------------- results ---------------- */
  _drawResults(g, p) {
    const W = p.W, r = this.api.lastResult();
    if (!r) return;
    g.textAlign = 'center'; g.textBaseline = 'top';
    g.fillStyle = C.muted; g.font = FONT(600, 22); g.fillText(fitText(g, `${r.track.name} · ${r.track.artist}`, W - 60), W / 2, 26);
    g.fillStyle = r.rank === 'S' ? C.gold : r.rank === 'A' ? C.cyan : C.pink; g.font = FONT(900, 140); g.fillText(r.rank, W / 2, 56);
    g.fillStyle = C.text; g.font = FONT(900, 52); g.fillText(r.score.toLocaleString(), W / 2, 206);
    if (r.isBest) { g.fillStyle = C.gold; g.font = FONT(800, 22); g.fillText('NEW PERSONAL BEST', W / 2, 266); }
    else if (r.synced) { g.fillStyle = C.muted; g.font = FONT(600, 18); g.fillText(`Beat sync for this song adjusted ${r.synced > 0 ? '+' : ''}${r.synced} ms for next time`, W / 2, 270); }
    const stats = [['ACCURACY', `${r.accuracy}%`], ['MAX COMBO', r.maxCombo], ['PERFECTS', r.perfects], ['MINES HIT', r.mines || 0]];
    const cw = (W - 60) / 4;
    stats.forEach(([k, v], i) => {
      const x = 30 + i * cw + cw / 2;
      g.fillStyle = C.text; g.font = FONT(800, 32); g.fillText(String(v), x, 306);
      g.fillStyle = C.muted; g.font = FONT(600, 16); g.fillText(k, x, 346);
    });
    const next = this.api.nextInfo();
    const busy = this.api.loading && this.api.loading();
    if (busy) { g.fillStyle = C.cyan; g.font = FONT(700, 22); g.fillText(busy, W / 2, 392); }
    else if (next) { g.fillStyle = C.cyan; g.font = FONT(700, 22); g.fillText(fitText(g, `Next: ${next.name} in ${next.secs}s`, W - 60), W / 2, 392); }
    const bw = (W - 80) / 3;
    p.button('next', 30, 440, bw, 72, next ? 'NEXT NOW' : 'NEXT', { style: 'primary', size: 26 });
    p.button('replay', 40 + bw, 440, bw, 72, 'REPLAY', { size: 24 });
    p.button('select', 50 + bw * 2, 440, bw, 72, 'SONG SELECT', { size: 22 });
  }
}

function wrap(g, text, x, y, maxW, lh) {
  const words = String(text).split(' ');
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (g.measureText(test).width > maxW && line) { g.fillText(line, x, y); y += lh; line = w; } else line = test;
  }
  if (line) g.fillText(line, x, y);
}
