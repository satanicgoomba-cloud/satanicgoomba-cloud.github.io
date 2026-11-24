import * as THREE from 'three';

// Cosmetic saber effects for SLICE: blades clashing, and blades scraping through walls.
// This only READS the sabers and the wall meshes. It never touches cubes, mines, walls' head check,
// energy or score, so it can't change what gets cut or what counts as a hit.

const MARKS = 260, CHIPS = 240;
const MARK_LIFE = 1.6, CHIP_LIFE = 0.9;
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _up = new THREE.Vector3(0, 0, 1);
const _col = new THREE.Color();

/** Closest points between segments p1-q1 and p2-q2: returns distance, writes the midpoint to out. */
function segSeg(p1, q1, p2, q2, out) {
  const d1 = _a.subVectors(q1, p1), d2 = _b.subVectors(q2, p2), r = _c.subVectors(p1, p2);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
  let s, t;
  if (a < 1e-9 && e < 1e-9) { s = t = 0; }
  else if (a < 1e-9) { s = 0; t = Math.max(0, Math.min(1, f / e)); }
  else {
    const c = d1.dot(r);
    if (e < 1e-9) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
    else {
      const b = d1.dot(d2), den = a * e - b * b;
      s = den > 1e-9 ? Math.max(0, Math.min(1, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); } else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); }
    }
  }
  const c1 = _d.copy(p1).addScaledVector(d1, s), c2 = out.copy(p2).addScaledVector(d2, t);
  const dist = c1.distanceTo(c2);
  out.add(c1).multiplyScalar(0.5);
  return dist;
}

/** Where segment a-b first enters an axis-aligned box: { t, normal } or null. */
function segEnter(a, b, min, max) {
  let t0 = 0, t1 = 1, axis = -1, sign = 0;
  const ks = ['x', 'y', 'z'];
  for (let i = 0; i < 3; i++) {
    const k = ks[i], d = b[k] - a[k];
    if (Math.abs(d) < 1e-9) { if (a[k] < min[k] || a[k] > max[k]) return null; continue; }
    let u = (min[k] - a[k]) / d, v = (max[k] - a[k]) / d, sg = -1;
    if (u > v) { [u, v] = [v, u]; sg = 1; }
    if (u > t0) { t0 = u; axis = i; sign = sg; }
    t1 = Math.min(t1, v);
    if (t0 > t1) return null;
  }
  const normal = new THREE.Vector3(); if (axis >= 0) normal.setComponent(axis, sign); else normal.set(0, 0, 1);
  return { t: t0, normal };
}

export class SaberFx {
  constructor(game) {
    this.g = game;
    const s = game.scene;
    // glowing scorch marks left in a wall: short stretched bars along the cut, moving with the wall
    this.marks = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }), MARKS);
    this.marks.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.marks.frustumCulled = false; this.marks.count = MARKS;
    this.mk = Array.from({ length: MARKS }, () => ({ life: 0, wall: null, dz: 0, a: new THREE.Vector3(), b: new THREE.Vector3(), hex: 0xffffff }));
    this.markNext = 0;
    // voxel chips knocked out of the wall
    this.chips = new THREE.InstancedMesh(new THREE.BoxGeometry(0.026, 0.026, 0.026), new THREE.MeshBasicMaterial({ color: 0xffffff }), CHIPS);
    this.chips.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.chips.frustumCulled = false; this.chips.count = CHIPS;
    this.ch = Array.from({ length: CHIPS }, () => ({ life: 0, p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Euler(), spin: new THREE.Vector3() }));
    this.chipNext = 0;
    _s.setScalar(0); _m.compose(_a.set(0, -50, 0), _q.identity(), _s);
    for (let i = 0; i < MARKS; i++) this.marks.setMatrixAt(i, _m);
    for (let i = 0; i < CHIPS; i++) { this.chips.setMatrixAt(i, _m); this.chips.setColorAt(i, _col.setHex(0xffffff)); }
    s.add(this.marks, this.chips);
    this.clashT = 0; this.clashing = false;
    this.contact = {}; // per hand: last point in a wall, timers
  }

  reset() {
    for (const k of this.mk) k.life = 0;
    for (const c of this.ch) c.life = 0;
    this.contact = {}; this.clashing = false;
  }

  update(dt, live) {
    if (live) { this._clash(dt); this._walls(dt); } else { this.contact = {}; this.clashing = false; }
    this._animate(dt);
  }

  /* ---------- blades touching each other ---------- */
  _clash(dt) {
    const g = this.g, L = g.sabers.L, R = g.sabers.R;
    this.clashT -= dt;
    if (!L.tracked || !R.tracked || L.on < 0.9 || R.on < 0.9) { this.clashing = false; return; }
    const at = new THREE.Vector3();
    const d = segSeg(L.base, L.tip, R.base, R.tip, at);
    const touching = d < 0.045;
    if (touching && (this.clashT <= 0 || !this.clashing)) {
      const first = !this.clashing;
      g._burst(at, 0xfff1c0, first ? 22 : 7, first ? 3 : 1.8);
      g._burst(at, 0xffb347, first ? 10 : 3, 2.2);
      for (const h of [L, R]) g._haptic(h, first ? 0.9 : 0.35, first ? 60 : 30);
      if (first && g.hitSounds) this._clang();
      this.clashT = first ? 0.12 : 0.06;
    }
    this.clashing = touching;
  }

  /* ---------- blades scraping through walls ---------- */
  _walls(dt) {
    const g = this.g;
    for (const h of Object.values(g.sabers)) {
      const c = this.contact[h.hand] || (this.contact[h.hand] = { last: null, wall: null, sparkT: 0, buzzT: 0 });
      c.sparkT -= dt; c.buzzT -= dt;
      if (!h.tracked || h.on < 0.9) { c.last = null; continue; }
      let hit = null;
      for (const n of g.active) {
        if (n.type !== 'wall') continue;
        const m = n.mesh, b = n.box, len = m.scale.z, zFront = m.position.z + len / 2, zBack = m.position.z - len / 2;
        if (zFront < -6 || zBack > 1.5) continue;
        const e = segEnter(h.base, h.tip, _a.set(b.x0, b.y0, zBack), _b.set(b.x1, b.y1, zFront));
        if (e) { hit = { n, m, point: h.base.clone().lerp(h.tip, e.t), normal: e.normal }; break; }
      }
      if (!hit) { c.last = null; continue; }
      const p = hit.point;
      // scorch line: from where the blade entered last frame to where it enters now
      if (c.last && c.wall === hit.m && c.last.distanceTo(p) < 0.4) this._mark(hit.m, c.last, p);
      else this._mark(hit.m, p, p);
      c.last = p.clone(); c.wall = hit.m;
      const speed = h.vel.length();
      if (c.sparkT <= 0) {
        g._burst(p, 0xffe9b0, 4 + Math.min(8, Math.round(speed * 2)), 1.4 + Math.min(2, speed * 0.4));
        this._chips(p, hit.normal, h.vel, 1 + Math.min(4, Math.round(speed)));
        c.sparkT = 0.035;
      }
      if (c.buzzT <= 0) { g._haptic(h, Math.min(0.6, 0.2 + speed * 0.08), 40); c.buzzT = 0.05; }
    }
  }

  _mark(wall, a, b) {
    const k = this.mk[this.markNext = (this.markNext + 1) % MARKS];
    k.life = MARK_LIFE; k.wall = wall; k.dz = 0; k.z0 = wall.position.z;
    k.a.copy(a); k.b.copy(b);
  }

  _chips(p, normal, vel, count) {
    for (let i = 0; i < count; i++) {
      const c = this.ch[this.chipNext = (this.chipNext + 1) % CHIPS];
      c.life = CHIP_LIFE * (0.6 + Math.random() * 0.5);
      c.p.copy(p);
      c.v.copy(normal).multiplyScalar(1 + Math.random() * 1.5)
        .add(_a.set(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).multiplyScalar(1.6))
        .addScaledVector(vel, 0.25);
      c.r.set(Math.random() * 6, Math.random() * 6, 0);
      c.spin.set(Math.random() * 20 - 10, Math.random() * 20 - 10, Math.random() * 20 - 10);
      this.chips.setColorAt(this.chipNext, _col.setHex(Math.random() < 0.5 ? 0xff3d9a : 0xffc2e0));
    }
    this.chips.instanceColor.needsUpdate = true;
  }

  _animate(dt) {
    const g = this.g;
    // marks ride along with their wall and cool from white-hot to the wall's pink
    for (let i = 0; i < MARKS; i++) {
      const k = this.mk[i];
      if (k.life <= 0) { if (k.wall) { k.wall = null; _m.compose(_a.set(0, -50, 0), _q.identity(), _s.setScalar(0)); this.marks.setMatrixAt(i, _m); } continue; }
      k.life -= dt;
      const gone = k.life <= 0 || !k.wall.visible;
      if (gone) { k.life = 0; continue; }
      const dz = k.wall.position.z - k.z0;
      _a.copy(k.a).setZ(k.a.z + dz); _b.copy(k.b).setZ(k.b.z + dz);
      const len = Math.max(0.018, _a.distanceTo(_b));
      _c.addVectors(_a, _b).multiplyScalar(0.5);
      if (_a.distanceTo(_b) > 1e-4) _q.setFromUnitVectors(_up, _d.subVectors(_b, _a).normalize()); else _q.identity();
      const f = k.life / MARK_LIFE;
      _s.set(0.012 * (0.5 + f * 0.5), 0.012 * (0.5 + f * 0.5), len);
      _m.compose(_c, _q, _s); this.marks.setMatrixAt(i, _m);
    }
    this.marks.instanceMatrix.needsUpdate = true;
    // chips fly out, tumble, fall, shrink
    const e = new THREE.Euler();
    for (let i = 0; i < CHIPS; i++) {
      const c = this.ch[i];
      if (c.life <= 0) continue;
      c.life -= dt;
      c.v.y -= 9.8 * dt; c.p.addScaledVector(c.v, dt);
      if (c.p.y < 0.013) { c.p.y = 0.013; c.v.y = Math.abs(c.v.y) > 0.5 ? -c.v.y * 0.3 : 0; c.v.x *= 0.6; c.v.z *= 0.6; }
      c.p.z += (g.mode === 'play' && !g.paused ? g.speed() : 0) * dt; // the floor rolls by
      c.r.x += c.spin.x * dt; c.r.y += c.spin.y * dt; c.r.z += c.spin.z * dt;
      _q.setFromEuler(e.set(c.r.x, c.r.y, c.r.z));
      _s.setScalar(c.life > 0 ? Math.min(1, c.life / 0.3) : 0);
      _m.compose(c.p, _q, _s); this.chips.setMatrixAt(i, _m);
    }
    this.chips.instanceMatrix.needsUpdate = true;
    // mark colour: one colour for all, kept hot while any are fresh
    let hot = 0; for (const k of this.mk) if (k.life > 0) hot = Math.max(hot, k.life / MARK_LIFE);
    this.marks.material.color.setRGB(1, 0.55 + hot * 0.45, 0.75 + hot * 0.25);
  }

  _clang() {
    const g = this.g;
    try {
      g.ac = g.ac || new AudioContext();
      const ac = g.ac, t = ac.currentTime;
      for (const [f, v] of [[2200, 0.06], [3300, 0.04], [1250, 0.05]]) {
        const o = ac.createOscillator(), gn = ac.createGain();
        o.type = 'square'; o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 0.92, t + 0.18);
        gn.gain.setValueAtTime(v, t); gn.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
        o.connect(gn).connect(ac.destination); o.start(t); o.stop(t + 0.24);
      }
    } catch { /* ignore */ }
  }
}
