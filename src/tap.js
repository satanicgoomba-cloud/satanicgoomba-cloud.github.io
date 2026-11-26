import * as THREE from 'three';
import { ENERGY, COLORS } from './shared.js?v=mwxyztpx';
import { alignOsu } from './osu.js?v=mwxyztpx';
const ENERGY_TAP = ENERGY.tap;

// TAP style: a flat playfield floats in front of you. Point the right controller at it (the dot is your
// cursor) and pull either trigger on the beat.
//   Circles: tap when the shrinking ring meets the circle. Numbers count up within a combo; colours change
//            with each new combo. Dotted lines show where the next one is.
//   Sliders: tap the head, then keep a trigger held and follow the ball to the end. Ticks along the way
//            and arrows (go back the way you came) must be followed too.
//   Spinners: hold a trigger and circle the cursor around the middle until the meter fills.
// Only the earliest circle takes a tap. Tapping it far too early is a miss. Energy drains slowly while
// things are coming; hits refill it.

const PZ = -2.6;                 // the playfield's distance
const FW = 1.15, FH = 0.62;      // half size of the area object centres can use (metres)
const COMBO_COL = [0xff2d6f, 0x00e5ff, 0xffe14d, 0x39ff88];
const P = {
  easy: { cr: 0.17, ar: 1500, space: 0.42, stream: 0.22, slider: 0.35, absorb: 0, sv: 0.45, spin: 0.8, win: [60, 110, 160] },
  normal: { cr: 0.15, ar: 1200, space: 0.5, stream: 0.2, slider: 0.3, absorb: 0.08, sv: 0.55, spin: 1.0, win: [55, 100, 150] },
  hard: { cr: 0.13, ar: 950, space: 0.62, stream: 0.18, slider: 0.26, absorb: 0.1, sv: 0.65, spin: 1.2, win: [50, 95, 140] },
  extreme: { cr: 0.115, ar: 760, space: 0.75, stream: 0.17, slider: 0.22, absorb: 0.1, sv: 0.75, spin: 1.4, win: [45, 88, 130] },
  maniac: { cr: 0.105, ar: 620, space: 0.88, stream: 0.16, slider: 0.2, absorb: 0.1, sv: 0.85, spin: 1.6, win: [40, 80, 120] },
};
const STEP = { easy: -1, normal: 0, hard: 1, extreme: 2, maniac: 3 };
const EARLY_MISS = 350;          // tapping a circle this early (but past the hit window) is a miss
const MAX_BODY = 96, MAX_FP = 160;

function rng(seedStr) {
  let h = 2166136261 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) h = Math.imul(h ^ seedStr.charCodeAt(i), 16777619);
  return () => { h += 0x6d2b79f5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const inField = (x, y) => Math.abs(x) <= FW && Math.abs(y) <= FH;

function textTex(text, size = 128, w = 128, font = 900) {
  const c = document.createElement('canvas'); c.width = w; c.height = size;
  const g = c.getContext('2d');
  g.font = `${font} ${Math.round(size * 0.72)}px Montserrat, system-ui, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = size * 0.08; g.strokeStyle = 'rgba(0,0,0,0.6)'; g.strokeText(text, w / 2, size / 2 + size * 0.04);
  g.fillStyle = '#fff'; g.fillText(text, w / 2, size / 2 + size * 0.04);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const basic = (opts = {}) => new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, fog: false, ...opts });

export class TapStyle {
  constructor(game) {
    this.g = game; this.HIT_Z = PZ;
    const s = game.scene;
    this.geo = {
      disc: new THREE.CircleGeometry(1, 40), ring: new THREE.RingGeometry(0.86, 1, 48), inner: new THREE.RingGeometry(0.7, 0.8, 40),
      approach: new THREE.RingGeometry(0.93, 1, 48), num: new THREE.PlaneGeometry(1, 1),
      arrow: (() => { const sh = new THREE.Shape(); sh.moveTo(0.5, 0); sh.lineTo(-0.35, 0.42); sh.lineTo(-0.15, 0); sh.lineTo(-0.35, -0.42); sh.closePath(); return new THREE.ShapeGeometry(sh); })(),
    };
    this.nums = Array.from({ length: 10 }, (_, i) => textTex(String(i)));
    this.handTex = { L: textTex('L'), R: textTex('R') };
    // playfield backdrop
    const back = new THREE.Mesh(new THREE.PlaneGeometry((FW + 0.3) * 2, (FH + 0.3) * 2), basic({ color: 0x0d0720, opacity: 0.88 }));
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry((FW + 0.3) * 2, (FH + 0.3) * 2)), new THREE.LineBasicMaterial({ color: 0x8a6cff, transparent: true, opacity: 0.35, fog: false }));
    this.field = new THREE.Group(); this.field.add(back, edge); this.field.visible = false; this.field.renderOrder = -10;
    s.add(this.field);
    // pools
    this.circles = Array.from({ length: 28 }, () => this._makeCircle());
    this.sliders = Array.from({ length: 8 }, () => this._makeSlider());
    this.spinners = Array.from({ length: 2 }, () => this._makeSpinner());
    this.cards = Array.from({ length: 2 }, () => {
      const c = document.createElement('canvas'); c.width = 1024; c.height = 340;
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5 * 340 / 1024), basic({ map: tex }));
      m.renderOrder = 2.5e6; m.visible = false; m.userData = { kind: 'card', canvas: c, tex, key: '' }; s.add(m); return m;
    });
    this.swaps = []; this.swapState = {};
    for (const m of [...this.circles, ...this.sliders, ...this.spinners]) s.add(m); // (cards are added above)
    // follow points (dots leading to the next object)
    this.fp = new THREE.InstancedMesh(this.geo.disc, basic({ color: 0xffffff, opacity: 0.55 }), MAX_FP);
    this.fp.frustumCulled = false; this.fp.count = 0; this.fp.renderOrder = 2e6; s.add(this.fp);
    // cursor and aiming laser
    this.cur = new THREE.Group();
    const cdot = new THREE.Mesh(this.geo.disc, basic({ color: 0xffffff, depthTest: false })); cdot.scale.setScalar(0.018);
    const cring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 32), basic({ color: 0xffe14d, depthTest: false, opacity: 0.9 })); cring.scale.setScalar(0.045);
    this.cur.add(cring, cdot); this.cur.userData.ring = cring; this.cur.renderOrder = 3e6; this.cur.visible = false; s.add(this.cur);
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, -1], 3));
    this.laser = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0xffe14d, transparent: true, opacity: 0.35, fog: false }));
    this.laser.frustumCulled = false; this.laser.visible = false; s.add(this.laser);
    // the left hand's cursor and laser, for SWITCH HANDS bursts
    this.curL = new THREE.Group();
    const lring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 32), basic({ color: COLORS.L, depthTest: false, opacity: 0.9 })); lring.scale.setScalar(0.045);
    const ldot = new THREE.Mesh(this.geo.disc, basic({ color: 0xffffff, depthTest: false })); ldot.scale.setScalar(0.018);
    this.curL.add(lring, ldot); this.curL.renderOrder = 3e6; this.curL.visible = false; s.add(this.curL);
    const lg2 = new THREE.BufferGeometry(); lg2.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, -1], 3));
    this.laserL = new THREE.Line(lg2, new THREE.LineBasicMaterial({ color: COLORS.L, transparent: true, opacity: 0.4, fog: false }));
    this.laserL.frustumCulled = false; this.laserL.visible = false; s.add(this.laserL);
    this.aim = { L: { ok: false, x: 0, y: 0 }, R: { ok: false, x: 0, y: 0 } }; this.needLeft = false;
    this.cursor = new THREE.Vector2(0, 0); this.aimOk = false;
    this.held = new Set(); this.botHold = false;
    this._m = new THREE.Matrix4(); this._v = new THREE.Vector3(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3(1, 1, 1);
    this._ray = new THREE.Ray(); this._plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -PZ);

    // triggers / pinches from either hand; mouse and Z/X on a screen
    game.r.xr.addEventListener('sessionstart', () => {
      const session = game.r.xr.getSession();
      session.addEventListener('selectstart', (e) => { const k = `xr:${e.inputSource.handedness}`; if (this.live()) this.press(k, e.inputSource.handedness === 'left' ? 'L' : 'R'); });
      session.addEventListener('selectend', (e) => this.held.delete(`xr:${e.inputSource.handedness}`));
    });
    addEventListener('pointerup', () => this.held.delete('mouse'));
    addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      if ((k === 'z' || k === 'x') && !e.repeat && this.live() && e.target.tagName !== 'INPUT') this.press(`key:${k}`);
    });
    addEventListener('keyup', (e) => this.held.delete(`key:${e.key.toLowerCase()}`));
  }

  /* ---------- building the pieces ---------- */
  _circleParts(parent, base) {
    const fill = new THREE.Mesh(this.geo.disc, basic({ color: 0x222222 })); fill.renderOrder = base;
    const ring = new THREE.Mesh(this.geo.ring, basic({ color: 0xffffff })); ring.renderOrder = base + 1;
    const inner = new THREE.Mesh(this.geo.inner, basic({ color: 0xffffff })); inner.renderOrder = base + 1;
    const num = new THREE.Mesh(this.geo.num, basic({ map: this.nums[1] })); num.scale.setScalar(0.95); num.renderOrder = base + 2;
    parent.add(fill, ring, inner, num);
    return { fill, ring, inner, num };
  }
  _makeCircle() {
    const m = new THREE.Group();
    const parts = this._circleParts(m, 0);
    const approach = new THREE.Mesh(this.geo.approach, basic({ color: 0xffffff })); approach.renderOrder = 5;
    m.add(approach);
    m.visible = false; m.userData = { kind: 'circle', ...parts, approach };
    return m;
  }
  _makeSlider() {
    const m = new THREE.Group();
    const border = new THREE.InstancedMesh(this.geo.disc, basic({ color: 0xffffff }), MAX_BODY); border.renderOrder = 0;
    const body = new THREE.InstancedMesh(this.geo.disc, basic({ color: 0x222222 }), MAX_BODY); body.renderOrder = 1;
    const ticks = new THREE.InstancedMesh(this.geo.disc, basic({ color: 0xffffff }), 24); ticks.renderOrder = 2;
    for (const im of [border, body, ticks]) { im.frustumCulled = false; im.count = 0; }
    const tail = new THREE.Mesh(this.geo.ring, basic({ color: 0xffffff })); tail.renderOrder = 3;
    const head = new THREE.Object3D(); m.add(border, body, ticks, tail, head);
    const hp = this._circleParts(head, 4);
    const ball = new THREE.Mesh(this.geo.disc, basic({ color: 0xffffff })); ball.renderOrder = 8;
    const follow = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 48), basic({ color: 0xffffff })); follow.renderOrder = 9;
    const approach = new THREE.Mesh(this.geo.approach, basic({ color: 0xffffff })); approach.renderOrder = 10;
    const arrow = new THREE.Mesh(this.geo.arrow, basic({ color: 0xffffff })); arrow.renderOrder = 11;
    m.add(ball, follow, approach, arrow);
    m.visible = false; m.userData = { kind: 'slider', border, body, ticks, tail, head, hp, ball, follow, approach, arrow };
    return m;
  }
  _makeSpinner() {
    const m = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.58, 0.62, 64), basic({ color: 0xffffff })); ring.renderOrder = 0;
    const meter = new THREE.Mesh(this.geo.disc, basic({ color: 0x00e5ff, opacity: 0.35 })); meter.renderOrder = 1;
    const time = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 64), basic({ color: 0xffe14d })); time.renderOrder = 2;
    const blades = new THREE.Group();
    for (let i = 0; i < 3; i++) { const b = new THREE.Mesh(new THREE.PlaneGeometry(0.04, 0.5), basic({ color: 0xffffff, opacity: 0.7 })); b.position.y = 0.27; const p = new THREE.Object3D(); p.rotation.z = (i * Math.PI * 2) / 3; p.add(b); blades.add(p); b.renderOrder = 3; }
    const label = new THREE.Mesh(this.geo.num, basic({ map: textTex('SPIN', 128, 384) })); label.scale.set(0.42, 0.14, 1); label.position.y = -0.8; label.renderOrder = 4;
    m.add(ring, meter, time, blades, label);
    m.visible = false; m.userData = { kind: 'spinner', ring, meter, time, blades, label };
    return m;
  }

  /* ---------- settings ---------- */
  get p() { return P[this.g.difficulty] || P.normal; }
  cy() { return this.g.headY - 0.15; }
  cr() { return (this.mapCR || this.p.cr) * (this.g.mods.bigTargets ? 1.25 : 1); }
  ar() { const m = this.g.mods.fast ? 1.25 : this.g.mods.slow ? 0.75 : 1; return (this.mapAR || this.p.ar) / m; }
  win() { const k = this.g.mods.strict ? 0.8 : 1; return this.p.win.map((w) => w * k); }
  live() { const g = this.g; return g.style === 'tap' && g.mode === 'play' && !g.paused && !g.run.failed && g.player && g.player.playing; }
  holding() { return this.held.size > 0 || this.botHold; }

  reset() {
    for (const m of [...this.circles, ...this.sliders, ...this.spinners, ...this.cards]) { m.visible = false; m.userData.used = false; }
    this.swapState = {};
    this.held.clear(); this.botHold = false; this.fp.count = 0;
  }

  /* ---------- map ---------- */
  /** A real osu! map of the song when one was found (and lines up), else one made from the generated beat map. */
  convert(items, { tempo, difficulty, seed, mods = {} }) {
    this.mapCR = this.mapAR = null; this.source = null; this.swaps = []; this.swapState = {};
    const om = this.g.track && this.g.track.osu;
    let out = om ? this._fromOsu(om, tempo) : null;
    if (out) this.source = om;
    else out = this._generated(items, { tempo, difficulty, seed });
    if (mods.twoHands) out = this._handSwaps(out, tempo);
    // where each object's follow points start
    let prev = null;
    for (const o of out) {
      const play = (x) => x.type === 'circle' || x.type === 'slider';
      if (prev && play(prev) && play(o)) {
        const e = prev.type === 'slider' ? (prev.repeats % 2 ? prev.pts[0] : prev.pts[prev.pts.length - 1]) : prev;
        o.from = { x: e.x, y: e.y, t: prev.t + (prev.dur || 0) };
      }
      prev = o;
    }
    return out;
  }

  /** An osu! map, lined up with our beat, in field metres. null if it doesn't line up. */
  _fromOsu(m, tempo) {
    const shift = alignOsu(m, tempo); if (shift === null) return null;
    const S = 0.0032, X = (x) => (x - 256) * S, Y = (y) => -(y - 192) * S, sh = shift + (this.g.shiftMs || 0);
    this.mapCR = Math.max(0.085, (54.4 - 4.48 * m.cs) * S);
    this.mapAR = m.ar < 5 ? 1200 + (600 * (5 - m.ar)) / 5 : 1200 - (750 * (m.ar - 5)) / 5;
    this.mapAR = Math.max(450, this.mapAR);
    const out = []; let combo = 0, color = 0, id = 1;
    for (const o of m.objs) {
      if (o.nc || !out.length) { combo = 0; color = (color + 1 + o.skip) % COMBO_COL.length; }
      const t = Math.round(o.t + sh);
      if (o.type === 'spinner') {
        const dur = Math.max(500, o.end - o.t);
        out.push({ id: id++, t, type: 'spinner', dur, need: Math.max(1, (dur / 1000) * this.p.spin) });
        continue;
      }
      combo++;
      const base = { id: id++, t, x: X(o.x), y: Y(o.y), num: combo, color };
      if (o.type === 'circle') { out.push({ ...base, type: 'circle' }); continue; }
      // slider: evenly spaced points along the path
      const raw = o.path.map(([x, y]) => ({ x: X(x), y: Y(y) }));
      const cum = [0]; for (let k = 1; k < raw.length; k++) cum.push(cum[k - 1] + Math.hypot(raw[k].x - raw[k - 1].x, raw[k].y - raw[k - 1].y));
      const L = cum[cum.length - 1] || 0.001, pts = [];
      for (let k = 0, j = 0; k <= 48; k++) {
        const d = (k / 48) * L; while (j < cum.length - 2 && cum[j + 1] < d) j++;
        const a = raw[j], b = raw[Math.min(raw.length - 1, j + 1)], f = (d - cum[j]) / ((cum[j + 1] ?? cum[j]) - cum[j] || 1);
        pts.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
      }
      const repeats = o.slides - 1, span = o.span, dur = span * o.slides, checks = [];
      for (let leg = 0; leg <= repeats; leg++) {
        for (const b of o.ticks) checks.push({ t: t + leg * span + (leg % 2 ? span - b : b), kind: 'tick' });
        if (leg < repeats) checks.push({ t: t + (leg + 1) * span, kind: 'repeat' });
      }
      checks.sort((a, b) => a.t - b.t);
      checks.push({ t: t + dur - Math.min(36, dur * 0.1), kind: 'end' });
      out.push({ ...base, type: 'slider', dur, repeats, span, pts, checks });
    }
    return out;
  }

  /**
   * SWITCH HANDS: about every 30 s the aiming passes to your other arm, so one arm can rest. A count-in on
   * four beats: tap anywhere with the hand you're using now, twice, then with your other hand, twice.
   * From then on the other controller aims. It goes in a gap in the music when there's one nearby.
   */
  _handSwaps(out, tempo) {
    const spb = 60000 / tempo.bpm, off = (tempo.offsetMs || 0) + (this.g.shiftMs || 0);
    const onBeat = (t) => off + Math.ceil((t - off) / spb) * spb;
    const endOf = (o) => o.t + (o.dur || 0);
    const last = out.length ? endOf(out[out.length - 1]) : 0;
    let res = out.slice(), hand = 'R';
    for (let target = 30000; target < last - 10000; target += 30000) {
      let b0 = null, best = 0; // the widest gap near the target that fits a beat, the four taps and a beat and a half
      for (let i = 1; i < res.length; i++) {
        const a = endOf(res[i - 1]), b = res[i].t;
        if (b < target - 7000 || a > target + 7000) continue;
        if (b - a >= spb * 6.5 && b - a > best) { best = b - a; b0 = onBeat(a + spb); }
      }
      if (b0 === null) b0 = onBeat(target);
      const b3 = b0 + spb * 3, other = hand === 'R' ? 'L' : 'R', group = Math.round(b0);
      res = res.filter((o) => endOf(o) < b0 - spb || o.t > b3 + spb * 1.5);
      res.push({ id: 800000 + group * 8, t: Math.round(b0 - spb * 4), type: 'swapcard', scored: false, dur: Math.round(spb * 8.5), group, now: hand, next: other, spb });
      for (let k = 0; k < 4; k++) res.push({ id: 800001 + group * 8 + k, t: Math.round(b0 + k * spb), type: 'swaptap', hand: k < 2 ? hand : other, group, k });
      this.swaps.push({ t: Math.round(b3), to: other }); hand = other;
    }
    return res.sort((a, b) => a.t - b.t);
  }
  /** Which controller aims at song time pos (SWITCH HANDS passes it back and forth). */
  pointerAt(pos) { let h = 'R'; for (const w of this.swaps) if (w.t <= pos) h = w.to; return h; }

  /* ---------- a map made from the generated beat map ---------- */
  _generated(items, { tempo, difficulty, seed }) {
    const r = rng(`${seed}:tap:${difficulty}`), spb = 60000 / tempo.bpm, step = STEP[difficulty] ?? 0, pp = P[difficulty] || P.normal;
    const ts = [];
    for (const n of items.filter((x) => x.type === 'note').sort((a, b) => a.t - b.t)) if (!ts.length || n.t - ts[ts.length - 1].t >= 30) ts.push(n); // a double becomes one circle
    const silent = (this.g.sections || []).filter((x) => x.kind === 'silent');
    const isSilent = (a, b) => silent.some((x) => b >= x.t0 && a < x.t1);
    const out = [];
    let px = (r() - 0.5) * 0.6, py = (r() - 0.5) * 0.4, ang = r() * Math.PI * 2, lastEnd = -1e9, lastSpin = -1e9;
    let comboStart = -1e9, combo = 0, color = 0, afterSpin = true;
    // the next spot about `dist` from the last one, turning a little (streams) or sharply (jumps)
    const nextPos = (dist, stream) => {
      for (let k = 0; k < 14; k++) {
        const a = stream ? ang + (r() - 0.5) * (0.7 + k * 0.3) : ang + (r() < 0.5 ? -1 : 1) * (1.5 + r() * 1.3) + k * 0.45;
        const x = px + Math.cos(a) * dist, y = py + Math.sin(a) * dist;
        if (inField(x, y)) { ang = a; return [x, y]; }
      }
      ang = Math.atan2(-py, -px); return [px + Math.cos(ang) * Math.min(dist, Math.hypot(px, py)), py + Math.sin(ang) * Math.min(dist, Math.hypot(px, py))];
    };
    let i = 0;
    while (i < ts.length) {
      const n = ts[i], t = n.t, next = ts[i + 1], gap = next ? next.t - t : 1e9;
      if (afterSpin || t - comboStart >= spb * 4 - 5 || combo >= 8) { combo = 0; color = (color + 1) % COMBO_COL.length; comboStart = t; }
      // spinner: in a long rest (not a silence), at most one every 25 s
      const spinEnd = next ? next.t - spb : t + spb * 4;
      if (gap >= Math.max(spb * 4, 2600) && t - lastSpin > 25000 && spinEnd - t >= 1500 && !isSilent(t, spinEnd)) {
        out.push({ id: n.id, t, type: 'spinner', dur: spinEnd - t, need: Math.max(1, ((spinEnd - t) / 1000) * pp.spin) });
        lastSpin = t; px = 0; py = 0; lastEnd = spinEnd; afterSpin = true; i++; continue;
      }
      afterSpin = false;
      const since = t - lastEnd, stream = since <= spb * 0.55;
      const dist = lastEnd < -1e8 ? 0 : stream ? pp.stream : since > spb * 2.2 ? 0.3 + r() * 0.3 : Math.min(1.35, (since / spb) * pp.space);
      const [hx, hy] = lastEnd < -1e8 ? [px, py] : nextPos(dist, stream);
      px = hx; py = hy; combo++;
      const base = { id: n.id, t, x: hx, y: hy, num: combo, color };
      // slider? (in a gap, or swallowing a quick note or two)
      const room = gap >= spb * 0.9;
      if (r() < (room ? pp.slider : pp.absorb)) {
        // a slider may swallow the quick notes it runs over (the slider end lands on the beat instead)
        const opts = room ? [spb * 0.5, spb, spb, spb * 2] : [spb, spb, spb * 2];
        const dur = opts.length ? opts[Math.floor(r() * opts.length)] : 0;
        const repeats = dur >= spb && step >= 1 && r() < 0.3 ? (step >= 3 && r() < 0.3 ? 2 : 1) : 0;
        const span = dur / (repeats + 1), len = clamp((pp.sv * span) / spb, 0.2, 1.0);
        const path = dur && this._path(hx, hy, len, r);
        if (path) {
          let j = i + 1; while (j < ts.length && ts[j].t < t + dur + spb * 0.35) j++;
          if (j >= ts.length || ts[j].t - (t + dur) >= spb * 0.35) {
            const checks = [];
            for (let leg = 0; leg <= repeats; leg++) {
              for (let b = spb; b < span - 10; b += spb) checks.push({ t: t + leg * span + b, kind: 'tick' });
              if (leg < repeats) checks.push({ t: t + (leg + 1) * span, kind: 'repeat' });
            }
            checks.push({ t: t + dur - Math.min(36, dur * 0.1), kind: 'end' });
            out.push({ ...base, type: 'slider', dur, repeats, span, pts: path, checks });
            const e = repeats % 2 ? path[0] : path[path.length - 1];
            ang = Math.atan2(e.y - py, e.x - px) || ang; px = e.x; py = e.y; lastEnd = t + dur; i = j; continue;
          }
        }
      }
      out.push({ ...base, type: 'circle' });
      lastEnd = t; i++;
    }
    return out;
  }
  /** A gently curved path of length len from (x, y) that stays on the field, as evenly spaced points. */
  _path(x, y, len, r) {
    for (let k = 0; k < 12; k++) {
      const a = r() * Math.PI * 2, ex = x + Math.cos(a) * len, ey = y + Math.sin(a) * len;
      const bend = (r() - 0.5) * len * 0.9, cx = (x + ex) / 2 - Math.sin(a) * bend, cyy = (y + ey) / 2 + Math.cos(a) * bend;
      const raw = [];
      for (let s = 0; s <= 64; s++) { const u = s / 64, w = 1 - u; raw.push({ x: w * w * x + 2 * u * w * cx + u * u * ex, y: w * w * y + 2 * u * w * cyy + u * u * ey }); }
      if (!raw.every((q) => inField(q.x, q.y))) continue;
      const cum = [0]; for (let s = 1; s < raw.length; s++) cum.push(cum[s - 1] + Math.hypot(raw[s].x - raw[s - 1].x, raw[s].y - raw[s - 1].y));
      const L = cum[cum.length - 1], pts = [];
      for (let s = 0, j = 0; s <= 48; s++) { // even spacing by distance, so the ball moves at a steady speed
        const d = (s / 48) * L; while (j < cum.length - 2 && cum[j + 1] < d) j++;
        const f = (d - cum[j]) / (cum[j + 1] - cum[j] || 1);
        pts.push({ x: raw[j].x + (raw[j + 1].x - raw[j].x) * f, y: raw[j].y + (raw[j + 1].y - raw[j].y) * f });
      }
      pts.L = L; return pts;
    }
    return null;
  }
  at(pts, prog) {
    const f = clamp(prog, 0, 1) * (pts.length - 1), i = Math.min(pts.length - 2, Math.floor(f)), w = f - i;
    return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * w, y: pts[i].y + (pts[i + 1].y - pts[i].y) * w };
  }
  /** Slider ball progress (0..1 along the path) at song time pos. */
  prog(n, pos) {
    const k = clamp((pos - n.t) / n.span, 0, n.repeats + 1), leg = Math.min(n.repeats, Math.floor(k)), f = k - leg;
    return leg % 2 ? 1 - f : f;
  }

  /* ---------- spawning and drawing ---------- */
  spawn(n) {
    if (n.type === 'swaptap') return { ...n, mesh: new THREE.Object3D(), judged: false, dead: false };
    if (n.type === 'swapcard') {
      const m = this.cards.find((x) => !x.userData.used); if (!m) return null;
      m.userData.used = true; m.visible = true; m.userData.key = '';
      return { ...n, mesh: m };
    }
    const pool = n.type === 'circle' ? this.circles : n.type === 'slider' ? this.sliders : n.type === 'spinner' ? this.spinners : null;
    if (!pool) return null;
    const m = pool.find((x) => !x.userData.used); if (!m) return null;
    m.userData.used = true; m.visible = true; m.renderOrder = 1e6 - (this._seq = ((this._seq || 0) + 1) % 900000); // earlier objects draw on top
    const R = this.cr(), u = m.userData, cy = this.cy();
    const col = new THREE.Color(n.hand ? COLORS[n.hand] : COMBO_COL[n.color || 0]);
    const paint = (parts) => {
      parts.fill.material.color.copy(col).multiplyScalar(n.hand ? 0.5 : 0.3); parts.inner.material.color.copy(col);
      parts.ring.material.color.copy(col).lerp(new THREE.Color(0xffffff), n.hand ? 0.3 : 0.65);
      parts.num.material.map = n.hand ? this.handTex[n.hand] : this.nums[(n.num || 1) % 10]; parts.num.material.needsUpdate = true;
    };
    if (n.type === 'circle') {
      paint(u); u.approach.material.color.copy(col).lerp(new THREE.Color(0xffffff), 0.4);
      m.position.set(n.x, cy + n.y, PZ); m.scale.setScalar(R);
    } else if (n.type === 'slider') {
      m.position.set(0, cy, PZ); m.scale.setScalar(1);
      paint(u.hp); u.head.position.set(n.x, n.y, 0); u.head.scale.setScalar(R);
      const step = Math.max(1, Math.ceil(n.pts.length / MAX_BODY)), M = this._m;
      let c = 0;
      for (let s = 0; s < n.pts.length && c < MAX_BODY; s += step, c++) {
        const q = n.pts[s];
        M.makeScale(R, R, 1).setPosition(q.x, q.y, 0); u.border.setMatrixAt(c, M);
        M.makeScale(R * 0.86, R * 0.86, 1).setPosition(q.x, q.y, 0); u.body.setMatrixAt(c, M);
      }
      u.border.count = u.body.count = c; u.border.instanceMatrix.needsUpdate = u.body.instanceMatrix.needsUpdate = true;
      u.border.material.color.copy(col).lerp(new THREE.Color(0xffffff), 0.65); u.body.material.color.copy(col).multiplyScalar(0.22);
      const e = n.pts[n.pts.length - 1]; u.tail.position.set(e.x, e.y, 0); u.tail.scale.setScalar(R);
      u.ball.material.color.copy(col).lerp(new THREE.Color(0xffffff), 0.3); u.ball.scale.setScalar(R * 0.7);
      u.follow.material.color.copy(col).lerp(new THREE.Color(0xffffff), 0.5);
      u.approach.material.color.copy(col).lerp(new THREE.Color(0xffffff), 0.4);
      u.ticks.count = 0;
    } else {
      m.position.set(0, cy, PZ); m.scale.setScalar(1);
    }
    return { ...n, mesh: m, home: new THREE.Vector3(n.x || 0, cy + (n.y || 0), PZ), R, judged: false, dead: false, fade: 0, hit: 0, got: 0, ci: 0, spins: 0, followed: false };
  }

  _alpha(n, pos) {
    const A = this.ar(), tms = n.t - pos;
    let a = clamp((A - tms) / (A * 0.4), 0, 1);
    if (this.g.mods.ghost && !n.judged) a *= clamp((tms - A * 0.3) / (A * 0.3), 0, 1); // ghost: fades before you tap it
    return a;
  }
  _setOp(parts, a) { for (const k of ['fill', 'ring', 'inner', 'num']) parts[k].material.opacity = a * (k === 'fill' ? 0.85 : 1); }

  /** Move one item for this frame. Returns true when it's finished with. */
  place(n, tt, pos, dt) {
    const u = n.mesh.userData, A = this.ar(), tms = n.t - pos, W = this.win();
    if (n.type === 'swaptap') {
      if (!n.judged && pos > n.t + W[2] * 1.6) this._swapResult(n, null);
      return n.judged;
    }
    if (n.type === 'swapcard') return this._drawCard(n, pos);
    if (n.type === 'circle') {
      if (!n.judged && pos > n.t + W[2]) this._miss(n);
      if (n.judged) {
        n.fade += dt; const k = n.fade / (n.hit ? 0.2 : 0.12); if (k >= 1) return true;
        n.mesh.scale.setScalar(n.R * (n.hit ? 1 + 0.45 * k : 1)); this._setOp(u, (1 - k) * (n.hit ? 1 : 0.5)); u.approach.visible = false;
        return false;
      }
      const a = this._alpha(n, pos);
      this._setOp(u, a);
      u.approach.visible = !this.g.mods.ghost && tms > 0;
      u.approach.scale.setScalar(1 + 2.3 * clamp(tms / A, 0, 1)); u.approach.material.opacity = clamp((A - tms) / (A * 0.4), 0, 1) * 0.9;
      return false;
    }
    if (n.type === 'slider') {
      const end = n.t + n.dur;
      if (!n.judged && pos > n.t + W[2]) this._headMiss(n);
      if (n.dead) { n.fade += dt; const k = n.fade / 0.25; if (k >= 1) return true; this._sliderOp(n, (1 - k) * 0.8); u.ball.visible = u.follow.visible = u.arrow.visible = false; return false; }
      const a = this._alpha({ ...n, judged: n.judged || pos > n.t }, pos);
      this._sliderOp(n, Math.max(a, pos > n.t ? 1 : 0));
      // head: approach ring until its time, then it fades
      const headA = n.judged ? Math.max(0, 1 - (pos - (n.judgedAt || n.t)) / 150) : a;
      this._setOp(u.hp, headA);
      u.approach.visible = !this.g.mods.ghost && tms > 0 && !n.judged;
      u.approach.position.set(n.x, n.y, 0); u.approach.scale.setScalar(n.R * (1 + 2.3 * clamp(tms / A, 0, 1))); u.approach.material.opacity = clamp((A - tms) / (A * 0.4), 0, 1) * 0.9;
      // ball, follow circle and repeat arrow while it runs
      const running = pos >= n.t && pos <= end;
      u.ball.visible = running; u.follow.visible = running && n.followed;
      const b = this.at(n.pts, this.prog(n, pos));
      u.ball.position.set(b.x, b.y, 0); u.follow.position.set(b.x, b.y, 0); u.follow.scale.setScalar(n.R * 2.2); u.follow.material.opacity = 0.8;
      const legs = clamp(Math.floor((pos - n.t) / n.span), 0, n.repeats);
      const more = legs < n.repeats;
      u.arrow.visible = more && a > 0.2;
      if (more) {
        const atEnd = legs % 2 === 0, e = atEnd ? n.pts[n.pts.length - 1] : n.pts[0], q = atEnd ? n.pts[n.pts.length - 4] : n.pts[3];
        u.arrow.position.set(e.x, e.y, 0); u.arrow.rotation.z = Math.atan2(q.y - e.y, q.x - e.x); u.arrow.scale.setScalar(n.R * (0.7 + 0.1 * Math.sin(pos / 80)));
        u.arrow.material.opacity = a;
      }
      // ticks still to come on this leg
      let c = 0;
      for (let k = n.ci; k < n.checks.length && c < 24; k++) {
        const ch = n.checks[k]; if (ch.kind !== 'tick') { if (ch.t > pos) break; continue; }
        const q = this.at(n.pts, this.prog(n, ch.t)); this._m.makeScale(n.R * 0.16, n.R * 0.16, 1).setPosition(q.x, q.y, 0); u.ticks.setMatrixAt(c++, this._m);
      }
      u.ticks.count = c; u.ticks.instanceMatrix.needsUpdate = true; u.ticks.material.opacity = a;
      if (!n.dead && pos > end) this._endSlider(n);
      return false;
    }
    // spinner
    const end = n.t + n.dur;
    if (n.dead) { n.fade += dt; const k = n.fade / 0.3; if (k >= 1) return true; n.mesh.scale.setScalar(1 + k * 0.2); this._spinOp(u, 1 - k); return false; }
    const a = clamp((600 - tms) / 300, 0, 1);
    this._spinOp(u, a);
    const fill = clamp(n.spins / n.need, 0, 1);
    u.meter.scale.setScalar(Math.max(0.01, 0.58 * fill)); u.meter.material.color.setHex(fill >= 1 ? 0xffe14d : 0x00e5ff);
    u.time.scale.setScalar(pos < n.t ? 1 : Math.max(0.02, 1 - (pos - n.t) / n.dur) * 0.6 + 0.02); u.time.visible = pos >= n.t;
    u.blades.rotation.z = -n.angle || 0;
    if (pos > end) this._endSpinner(n);
    return false;
  }
  _sliderOp(n, a) {
    const u = n.mesh.userData;
    u.border.material.opacity = a; u.body.material.opacity = a * 0.9; u.tail.material.opacity = a * 0.9;
  }
  _spinOp(u, a) { u.ring.material.opacity = a * 0.8; u.meter.material.opacity = a * 0.45; u.time.material.opacity = a; u.label.material.opacity = a; for (const p of u.blades.children) p.children[0].material.opacity = a * 0.7; }

  /* ---------- input and judging ---------- */
  press(key, hand) {
    if (key) this.held.add(key);
    const g = this.g, pos = g.songPos(), W = this.win();
    let n = null; // only the earliest circle (or slider head, or count-in tap) takes a tap
    for (const x of g.active) if ((x.type === 'circle' || x.type === 'slider' || x.type === 'swaptap') && !x.judged && (!n || x.t < n.t)) n = x;
    if (!n) return;
    if (n.type === 'swaptap') { // count-in: anywhere, on the beat, with the hand it asks for (any key on a screen)
      const e = pos - n.t, w = W[2] * 1.6;
      if (e < -w || (hand && g.r.xr.isPresenting && hand !== n.hand)) return;
      this._swapResult(n, Math.abs(e) <= W[0] * 1.5 ? 'perfect' : Math.abs(e) <= W[1] * 1.5 ? 'great' : 'good', e / 1000);
      const h = hand && g.sabers[hand]; if (h) g._haptic(h, 0.7, 30);
      if (g.hitSounds) g._slash(1.4);
      return;
    }
    if (!this.aimOk) return;
    const c = this.cursor;
    if (Math.hypot(c.x - n.x, c.y - n.y) > n.R * 1.1) return; // not on it: taps elsewhere are free
    const e = pos - n.t;
    if (e < -W[2]) { if (-e <= EARLY_MISS) { if (n.type === 'circle') this._miss(n); else this._headMiss(n); } return; }
    const rating = Math.abs(e) <= W[0] ? 'perfect' : Math.abs(e) <= W[1] ? 'great' : 'good';
    const h = hand && g.sabers[hand];
    if (h) g._haptic(h, rating === 'perfect' ? 0.8 : 0.5, 25);
    if (g.hitSounds) g._slash(1.2);
    if (n.type === 'circle') { this._score(n, rating, e / 1000); n.judged = true; n.hit = 1; return; }
    n.judged = true; n.judgedAt = pos; n.headRating = rating; n.got++; n.headOk = true; n.errS = e / 1000;
    this._combo(30); g._burst(this._world(n.x, n.y), COMBO_COL[n.color], 12, 1);
  }
  _swapResult(n, rating, errS) {
    n.judged = true;
    (this.swapState[n.group] = this.swapState[n.group] || [])[n.k] = rating ? 'hit' : 'miss';
    const p = new THREE.Vector3(-0.42 + n.k * 0.28, this.cy() - 0.05, PZ + 0.15);
    if (rating) this._score({ x: p.x, y: p.y - this.cy(), color: n.hand === 'L' ? 0 : 1 }, rating, errS);
    else this.g._miss(n, p);
  }
  /** The count-in card: four boxes (this hand, this hand, other hand, other hand) that light up on their beats. */
  _drawCard(n, pos) {
    const m = n.mesh, u = m.userData, end = n.t + n.dur;
    if (pos > end) return true;
    const b0 = n.t + n.spb * 4, st = this.swapState[n.group] || [];
    const a = clamp((pos - n.t) / 300, 0, 1) * clamp((end - pos) / 400, 0, 1);
    m.material.opacity = a * (pos < b0 - n.spb ? 0.8 : 1);
    // small at the top edge while circles are still coming, then in the middle once the field is clear
    const k = clamp((pos - (b0 - n.spb * 1.3)) / (n.spb * 0.6), 0, 1), e = k * k * (3 - 2 * k);
    m.position.set(0, this.cy() + (FH + 0.14) * (1 - e) + 0.05 * e, PZ + 0.1); m.scale.setScalar(0.6 + 0.4 * e);
    const cur = st.length < 4 ? [0, 1, 2, 3].find((k) => !st[k]) : -1;
    const prog = cur >= 0 ? clamp(1 - (b0 + cur * n.spb - pos) / n.spb, 0, 1) : 1;
    const count = pos < b0 ? Math.ceil((b0 - pos) / n.spb) : 0;
    const key = `${st.join()}|${cur}|${Math.round(prog * 12)}|${count}`;
    if (key === u.key) return false;
    u.key = key;
    const g = u.canvas.getContext('2d'), W = 1024, H = 340, name = { L: 'LEFT', R: 'RIGHT' }, hex = { L: '#ff2d6f', R: '#00e5ff' };
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(13,7,32,0.92)'; g.beginPath(); g.roundRect(4, 4, W - 8, H - 8, 28); g.fill();
    g.strokeStyle = hex[n.next]; g.lineWidth = 5; g.stroke();
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#fff'; g.font = '900 54px Montserrat, system-ui, sans-serif';
    g.fillText(count ? `SWITCH HANDS IN ${count}` : 'SWITCH HANDS', W / 2, 52);
    g.fillStyle = 'rgba(244,240,255,0.75)'; g.font = '600 28px Montserrat, system-ui, sans-serif';
    g.fillText(`Tap anywhere on the beat · then your ${name[n.next]} hand aims`, W / 2, 104);
    for (let k = 0; k < 4; k++) {
      const hand = k < 2 ? n.now : n.next, x = 92 + k * 220, y = 140, w = 180, h = 170;
      g.fillStyle = 'rgba(255,255,255,0.06)'; g.beginPath(); g.roundRect(x, y, w, h, 20); g.fill();
      if (st[k] === 'hit') { g.fillStyle = hex[hand]; g.globalAlpha = 0.85; g.beginPath(); g.roundRect(x, y, w, h, 20); g.fill(); g.globalAlpha = 1; }
      else if (k === cur) { g.fillStyle = hex[hand]; g.globalAlpha = 0.25 + 0.35 * prog; g.beginPath(); g.roundRect(x, y + h * (1 - prog), w, h * prog, 20); g.fill(); g.globalAlpha = 1; }
      g.lineWidth = k === cur ? 6 : 3; g.strokeStyle = st[k] === 'miss' ? '#ff4d4d' : hex[hand]; g.beginPath(); g.roundRect(x, y, w, h, 20); g.stroke();
      g.fillStyle = st[k] === 'hit' ? '#120a24' : st[k] === 'miss' ? '#ff4d4d' : '#fff';
      g.font = '900 88px Montserrat, system-ui, sans-serif'; g.fillText(st[k] === 'miss' ? '✕' : hand, x + w / 2, y + 74);
      g.font = '700 24px Montserrat, system-ui, sans-serif'; g.fillText(name[hand], x + w / 2, y + 140);
    }
    u.tex.needsUpdate = true;
    return false;
  }
  desktopFire() { this.held.add('mouse'); this.press(null); }
  fire() { return true; } // the game sends screen clicks here (see Game.desktopFire)

  _world(x, y) { return new THREE.Vector3(x, this.cy() + y, PZ + 0.05); }
  _combo(pts) { const r = this.g.run; r.combo++; r.maxCombo = Math.max(r.maxCombo, r.combo); this.g.addScore(pts); this.g.hudDirty = true; }
  _score(n, rating, errS) {
    const g = this.g, r = g.run, p = this._world(n.x, n.y);
    r.hits++; if (rating === 'perfect') r.perfects++;
    if (typeof errS === 'number') r.errs.push(errS);
    this._combo({ perfect: 100, great: 70, good: 40 }[rating]);
    g.energy(g.mods.strict && rating === 'good' ? 0.005 : ENERGY_TAP.hit);
    g._pop(rating, p); g._burst(p, COMBO_COL[n.color || 0], rating === 'perfect' ? 26 : 14, 1.4);
  }
  _miss(n) { n.judged = true; n.hit = 0; this.g._miss(n, this._world(n.x, n.y)); }
  _headMiss(n) { n.judged = true; n.judgedAt = this.g.songPos(); n.headOk = false; this._break(n); }
  _break(n) { const r = this.g.run; if (r.combo) { r.combo = 0; this.g.hudDirty = true; } r.sliderBreaks = (r.sliderBreaks || 0) + 1; n.broke = true; }
  _endSlider(n) {
    const g = this.g; n.dead = true;
    if (!n.judged) n.judged = true;
    const total = n.checks.length + 1, ratio = n.got / total;
    const e = n.pts[n.repeats % 2 ? 0 : n.pts.length - 1];
    if (ratio <= 0) { g._miss(n, this._world(e.x, e.y)); return; }
    const rating = ratio >= 1 ? (n.headRating === 'good' ? 'great' : 'perfect') : ratio >= 0.5 ? 'great' : 'good';
    this._score({ ...n, x: e.x, y: e.y }, rating, n.headOk ? n.errS : undefined);
  }
  _endSpinner(n) {
    const g = this.g; n.dead = true;
    const f = n.spins / n.need;
    if (f < 0.25) { g._miss(n, this._world(0, 0)); return; }
    this._score({ ...n, x: 0, y: 0, color: 2 }, f >= 1 ? 'perfect' : f >= 0.6 ? 'great' : 'good');
  }

  /** Per frame while playing: sliders being followed, spinners being spun, slow energy drain. */
  collide(pos, dt) {
    const g = this.g;
    if (g.bot && !g.r.xr.isPresenting) this._bot(pos);
    let busy = false;
    for (const n of g.active) {
      if (n.dead) continue;
      if (n.t - pos < 1500) busy = true;
      if (n.type === 'slider' && pos >= n.t && pos <= n.t + n.dur + 50) {
        const b = this.at(n.pts, this.prog(n, pos));
        const d = Math.hypot(this.cursor.x - b.x, this.cursor.y - b.y);
        const was = n.followed;
        n.followed = this.aimOk && this.holding() && d < n.R * (was ? 2.4 : 1.2);
        while (n.ci < n.checks.length && n.checks[n.ci].t <= pos) {
          const ch = n.checks[n.ci++];
          if (n.followed) { n.got++; this._combo(ch.kind === 'end' ? 30 : 10); g.energy(ENERGY_TAP.tick); }
          else if (ch.kind !== 'end' || n.got === 0) this._break(n);
        }
      }
      if (n.type === 'spinner' && pos >= n.t && pos <= n.t + n.dur) {
        const a = Math.atan2(this.cursor.y, this.cursor.x), rad = Math.hypot(this.cursor.x, this.cursor.y);
        if (this.aimOk && this.holding() && rad > 0.05 && n.lastA !== undefined) {
          let d = a - n.lastA; if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2;
          d = clamp(d, -0.6, 0.6);
          n.angle = (n.angle || 0) + d;
          const before = Math.floor(n.spins); n.spins += Math.abs(d) / (Math.PI * 2);
          if (Math.floor(n.spins) > before) {
            if (n.spins > n.need) { g.addScore(50); g.hudDirty = true; } // bonus spins
            for (const h of Object.values(g.sabers)) if (h.tracked) g._haptic(h, 0.25, 15);
          }
        }
        n.lastA = rad > 0.05 ? a : undefined;
      }
    }
    if (busy) g.energy(ENERGY_TAP.drain * dt, false);
  }

  /** ?bot=1 on a screen: aims and taps by itself. */
  _bot(pos) {
    const g = this.g; let target = null; this.botHold = false; let head = null;
    for (const n of g.active) {
      if (n.dead) continue;
      if (n.type === 'slider' && n.judged && pos <= n.t + n.dur) { target = this.at(n.pts, this.prog(n, pos + 10)); this.botHold = true; }
      if (n.type === 'spinner' && pos >= n.t - 100 && pos <= n.t + n.dur) { const a = pos / 1000 * Math.PI * 2 * this.p.spin * 1.5; target = { x: Math.cos(a) * 0.3, y: Math.sin(a) * 0.3 }; this.botHold = true; }
      if ((n.type === 'circle' || n.type === 'slider' || n.type === 'swaptap') && !n.judged && (!head || n.t < head.t)) head = n;
    }
    if (head && head.type === 'swaptap') { if (pos >= head.t - 6) this.press(null); return; }
    if (!target && head) {
      const k = clamp(1 - (head.t - pos) / 350, 0.08, 1);
      target = { x: this.cursor.x + (head.x - this.cursor.x) * k, y: this.cursor.y + (head.y - this.cursor.y) * k };
    }
    if (target) { this.cursor.set(target.x, target.y); this.aimOk = true; }
    if (head && pos >= head.t - 6 && Math.hypot(this.cursor.x - head.x, this.cursor.y - head.y) < head.R) this.press(null);
  }

  updateFx(dt, pos) {
    const g = this.g, show = g.style === 'tap' && g.mode === 'play';
    this.field.visible = show; this.field.position.set(0, this.cy(), PZ - 0.01);
    if (!show) { this.cur.visible = this.laser.visible = false; this.fp.count = 0; return; }
    // follow points: dots from the last object to the next one, shown while it approaches
    const A = this.ar(); let c = 0;
    for (const n of g.active) {
      if (!n.from || n.judged || n.t - pos > A || c >= MAX_FP) continue;
      const dx = n.x - n.from.x, dy = n.y - n.from.y, L = Math.hypot(dx, dy), gapL = L - n.R * 2.2;
      if (gapL < 0.12) continue;
      const steps = Math.floor(gapL / 0.07), show = clamp((pos - (n.from.t - A * 0.3)) / Math.max(1, n.t - n.from.t), 0, 1);
      for (let s = 1; s < steps && c < MAX_FP; s++) {
        const f = (n.R * 1.1 + (s / steps) * gapL) / L; if (f > show) break;
        const q = (pos - n.from.t) / Math.max(1, n.t - n.from.t); if (f < q - 0.02) continue; // dots vanish as you pass them
        this._m.makeScale(0.011, 0.011, 1).setPosition(n.from.x + dx * f, this.cy() + n.from.y + dy * f, PZ); this.fp.setMatrixAt(c++, this._m);
      }
    }
    this.fp.count = c; this.fp.instanceMatrix.needsUpdate = true;
    // cursor
    this.cur.visible = this.aimOk; this.cur.position.set(this.cursor.x, this.cy() + this.cursor.y, PZ + 0.02);
    this.cur.userData.ring.scale.setScalar(this.holding() ? 0.038 : 0.045);
    this.cur.userData.ring.material.color.setHex(this.swaps.length ? COLORS[this.pointerAt(pos)] : 0xffe14d);
  }

  /** Aiming: each controller's pointing ray. The right one is the cursor (the left with SWITCH HANDS after a
   *  hand-over, or when the right isn't tracked). */
  handFrame(h, dt, live) {
    if (!live) { this.laser.visible = this.laserL.visible = false; return; }
    const g = this.g;
    if (!g.r.xr.isPresenting) return;
    const a = this.aim[h.hand]; a.ok = false;
    const frame = g.r.xr.getFrame(), ref = g.r.xr.getReferenceSpace();
    const sp = h.tracked && h.src && h.src.targetRaySpace, pose = frame && ref && sp && frame.getPose(sp, ref);
    let hit = null;
    if (pose) {
      this._m.fromArray(pose.transform.matrix); g.rig.updateMatrixWorld(); this._m.premultiply(g.rig.matrixWorld);
      this._m.decompose(this._v, this._q, this._s);
      this._ray.origin.copy(this._v); this._ray.direction.set(0, 0, -1).applyQuaternion(this._q);
      hit = this._ray.intersectPlane(this._plane, new THREE.Vector3());
    }
    if (hit) {
      a.ok = true; a.x = clamp(hit.x, -FW - 0.5, FW + 0.5); a.y = clamp(hit.y - this.cy(), -FH - 0.5, FH + 0.5);
      const line = h.hand === 'L' ? this.laserL : this.laser, at = line.geometry.attributes.position;
      at.setXYZ(0, this._v.x, this._v.y, this._v.z); at.setXYZ(1, hit.x, hit.y, hit.z); at.needsUpdate = true;
    }
    const want = this.pointerAt(g.songPos()), alt = want === 'R' ? 'L' : 'R';
    const use = this.aim[want].ok && g.sabers[want].tracked ? want : this.aim[alt].ok ? alt : want, main = this.aim[use];
    this.aimOk = main.ok; if (main.ok) this.cursor.set(main.x, main.y);
    this.laser.visible = use === 'R' && main.ok; this.laserL.visible = use === 'L' && main.ok;
  }

  /** Screen: the mouse is the cursor; the sabers rest low out of the way. */
  desktopHand(h) {
    const g = this.g, side = h.hand === 'L' ? -1 : 1;
    if (!g.bot) { const a = g.desktop.aim; this.cursor.set(a.x, a.y - this.cy()); this.aimOk = true; }
    h.mesh.position.set(side * 0.35, g.headY - 0.7, -0.3); h.mesh.quaternion.identity();
    return true;
  }
}

