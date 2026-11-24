import * as THREE from 'three';
import { generate, sectionAt, SPEED } from './beatmap.js?v=mwu8geng';
import { activeMods, modMultiplier } from './mods.js?v=mwu8geng';
import { RideStyle } from './ride.js?v=mwu8geng';
import { COLORS, SPAWN_DIST, ENERGY } from './shared.js?v=mwu8geng';
import { ShootStyle } from './shoot.js?v=mwu8geng';
import { SaberFx } from './saberfx.js?v=mwu8geng';

// Layout (metres). You stand at z = 0 facing -z; cubes ride the track toward you.
const BEAT_Z = -0.9;         // where a cube is on its beat (the ideal place to slice it)
const LANE = 0.5;            // column spacing
const ROW = 0.42;            // row spacing
const CUBE = 0.38;           // cube size
const BLADE = 1.0;           // saber blade length
const MISS_Z = 0.5;          // a cube that gets this far behind you was missed
const TRAIL_MS = 110;        // saber trail length (time)
const MIN_SWING = 1.6;       // m/s: slower than this is a touch, not a slice
const DIR_TOL = 0.5;         // cos(60°): how close the swing must be to the arrow
const STILL_FOG = new THREE.Color(0xc9d1dc);
const PALETTES = {
  normal: { fog: 0x07030f, rings: [0x00e5ff, 0xff2d6f] },
  calm: { fog: 0x040716, rings: [0x3d5afe, 0x7c4dff] },
  chorus: { fog: 0x0d0f2e, rings: [0xffe14d, 0xffffff] },
};
// swing direction for each arrow (x, y), and the cube's roll so its chevron points that way
const DIRS = {
  D: [0, -1], U: [0, 1], L: [-1, 0], R: [1, 0],
  DL: [-Math.SQRT1_2, -Math.SQRT1_2], DR: [Math.SQRT1_2, -Math.SQRT1_2],
  UL: [-Math.SQRT1_2, Math.SQRT1_2], UR: [Math.SQRT1_2, Math.SQRT1_2], A: [0, -1],
};
const rollFor = (d) => Math.atan2(DIRS[d][0], -DIRS[d][1]); // (sinθ, -cosθ) = dir

const v3 = () => new THREE.Vector3();
const tmpM = new THREE.Matrix4(), tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3();


/* ---------- cutting a box in two (convex clip; returns two closed meshes with caps) ---------- */
function splitBox(h, n, d) {
  const C = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]].map((c) => new THREE.Vector3(c[0] * h, c[1] * h, c[2] * h));
  const faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [0, 4, 7, 3], [1, 2, 6, 5]];
  const sides = [[], []]; // polygons for the +n side and the -n side
  const cap = [];
  const dist = (p) => p.dot(n) - d;
  for (const f of faces) {
    const poly = f.map((i) => C[i]);
    const normal = tmpV.subVectors(poly[1], poly[0]).cross(tmpV2.subVectors(poly[2], poly[0])).normalize().clone();
    for (let s = 0; s < 2; s++) {
      const sign = s === 0 ? 1 : -1, out = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const da = dist(a) * sign, db = dist(b) * sign;
        if (da >= 0) out.push(a);
        if ((da >= 0) !== (db >= 0)) { const p = a.clone().lerp(b, da / (da - db)); out.push(p); if (s === 0) cap.push(p); }
      }
      if (out.length >= 3) sides[s].push({ pts: out, normal });
    }
  }
  // cap polygon: intersection points sorted around their centre
  const res = [];
  if (cap.length >= 3) {
    const c = cap.reduce((a, p) => a.add(p), v3()).divideScalar(cap.length);
    const u = (Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).cross(n).normalize();
    const w = n.clone().cross(u);
    const uniq = [];
    for (const p of cap) if (!uniq.some((q) => q.distanceToSquared(p) < 1e-8)) uniq.push(p);
    uniq.sort((a, b) => Math.atan2(tmpV.subVectors(a, c).dot(w), tmpV.dot(u)) - Math.atan2(tmpV2.subVectors(b, c).dot(w), tmpV2.dot(u)));
    sides[0].push({ pts: uniq, normal: n.clone().negate(), cap: true });
    sides[1].push({ pts: uniq, normal: n.clone(), cap: true });
  }
  for (const polys of sides) {
    const pos = [], nor = [], groups = [];
    let centroid = v3(), cn = 0;
    for (const pl of polys) for (const p of pl.pts) { centroid.add(p); cn++; }
    centroid.divideScalar(cn || 1);
    let idx = 0;
    for (const capPass of [false, true]) {
      const start = idx;
      for (const pl of polys) {
        if (!!pl.cap !== capPass) continue;
        for (let i = 1; i + 1 < pl.pts.length; i++) {
          let a = pl.pts[0], b = pl.pts[i], c = pl.pts[i + 1];
          if (tmpV.subVectors(b, a).cross(tmpV2.subVectors(c, a)).dot(pl.normal) < 0) [b, c] = [c, b];
          for (const p of [a, b, c]) { pos.push(p.x - centroid.x, p.y - centroid.y, p.z - centroid.z); nor.push(pl.normal.x, pl.normal.y, pl.normal.z); idx++; }
        }
      }
      groups.push([start, idx - start, capPass ? 1 : 0]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    for (const [s, c, m] of groups) if (c) g.addGroup(s, c, m);
    res.push({ geo: g, centroid });
  }
  return res;
}

/** Does segment a→b (local space) pass through the box of half-size h? (slab test) */
function segHitsBox(a, b, h) {
  let t0 = 0, t1 = 1;
  for (const k of ['x', 'y', 'z']) {
    const d = b[k] - a[k];
    if (Math.abs(d) < 1e-9) { if (a[k] < -h || a[k] > h) return false; continue; }
    let u = (-h - a[k]) / d, v = (h - a[k]) / d;
    if (u > v) [u, v] = [v, u];
    t0 = Math.max(t0, u); t1 = Math.min(t1, v);
    if (t0 > t1) return false;
  }
  return true;
}
// Saber vs cube: a box around the cube's centre, aligned with the world (so a rotated cube is no harder to
// reach), a little taller than the cube, and a little wider for cubes in the outer lanes.
const HIT_X = CUBE / 2 + 0.06, HIT_X_OUTER = CUBE / 2 + 0.11, HIT_Y = CUBE / 2 + 0.09, HIT_Z = CUBE / 2 + 0.06;
function segHitsAabb(a, b, hx, hy, hz) {
  let t0 = 0, t1 = 1;
  for (const [k, h] of [['x', hx], ['y', hy], ['z', hz]]) {
    const d = b[k] - a[k];
    if (Math.abs(d) < 1e-9) { if (a[k] < -h || a[k] > h) return false; continue; }
    let u = (-h - a[k]) / d, v = (h - a[k]) / d;
    if (u > v) [u, v] = [v, u];
    t0 = Math.max(t0, u); t1 = Math.min(t1, v);
    if (t0 > t1) return false;
  }
  return true;
}
function segPointDist(a, b, p) {
  const ab = tmpV.subVectors(b, a), t = Math.max(0, Math.min(1, tmpV2.subVectors(p, a).dot(ab) / (ab.lengthSq() || 1)));
  return tmpV2.copy(a).addScaledVector(ab, t).distanceTo(p);
}

export class Game {
  constructor(renderer, hooks = {}) {
    this.r = renderer;
    this.hooks = hooks;              // onTap, onPause
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x07030f);
    this.scene.fog = new THREE.Fog(0x07030f, 9, 34);
    this.camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 100);
    this.camera.position.set(0, 1.6, 0);
    this.camera.rotation.x = -0.1;
    this.rig = new THREE.Group();
    this.rig.add(this.camera);
    this.scene.add(this.rig);
    this.mode = 'menu';
    this.player = null; this.track = null;
    this.tempo = { bpm: 120, offsetMs: 0 }; this.difficulty = 'normal';
    this.items = []; this.nextItem = 0; this.active = []; this.sections = [];
    this.headY = 1.6;
    this.hitSounds = true;
    this.latencyMs = 0;
    this.spread = 1;
    this.bot = /[?&]bot=1/.test(location.search); // test player: slices everything by itself (screen only)
    this.desktop = { aim: new THREE.Vector3(0, 1.1, BEAT_Z) };
    this.palette = 'normal';
    this.style = 'saber'; this.mods = {}; this.modMult = 1;
    this._buildWorld();
    this._buildSabers();
    this._buildPools();
    this._buildHud();
    const shoot = new ShootStyle(this);
    this.styles = { ride: new RideStyle(this), shoot, still: shoot }; // STILL is SHOOT where time moves when you move
    this.tscale = 1; // STILL: how fast time runs (1 = normal); everything else is 1
    this.saberFx = new SaberFx(this); // cosmetic only: blade clashes and wall scrapes
    this.calibrateHeight();
    this.resetRun();
  }
  get sx() { return this.styles[this.style] || null; }
  get guns() { return this.style === 'shoot' || this.style === 'still'; }
  _styleList() { return [...new Set(Object.values(this.styles))]; }
  hitZ() { return this.style === 'ride' ? this.styles.ride.HIT_Z : BEAT_Z; }

  /* ================= world ================= */
  _buildWorld() {
    const s = this.scene;
    s.add(new THREE.HemisphereLight(0x8866ff, 0x110022, 1.3));
    const dl = new THREE.DirectionalLight(0xffffff, 1.4); dl.position.set(1, 3, 2); s.add(dl);
    const grid = new THREE.GridHelper(80, 80, 0x3a1466, 0x1a0833);
    grid.position.set(0, -0.01, -20); s.add(grid);

    // The track: a dark runway under the cubes with glowing rails, lane lines and moving light dashes.
    this.trackGroup = new THREE.Group(); s.add(this.trackGroup);
    const L = 44, W = LANE * 4 + 0.3;
    const deck = new THREE.Mesh(new THREE.PlaneGeometry(W, L), new THREE.MeshStandardMaterial({ color: 0x0c0718, metalness: 0.7, roughness: 0.25 }));
    deck.rotation.x = -Math.PI / 2; deck.position.z = -L / 2 + 1.2; this.trackGroup.add(deck);
    this.rails = [];
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, L), new THREE.MeshBasicMaterial({ color: side < 0 ? COLORS.L : COLORS.R, transparent: true, opacity: 0.8 }));
      rail.position.set(side * W / 2, 0.02, -L / 2 + 1.2); this.trackGroup.add(rail); this.rails.push(rail);
    }
    for (let c = 1; c < 4; c++) {
      const line = new THREE.Mesh(new THREE.PlaneGeometry(c === 2 ? 0.02 : 0.012, L), new THREE.MeshBasicMaterial({ color: 0x8a5cff, transparent: true, opacity: c === 2 ? 0.35 : 0.18 }));
      line.rotation.x = -Math.PI / 2; line.position.set((c - 2) * LANE, 0.003, -L / 2 + 1.2); this.trackGroup.add(line);
    }
    // the beat line: where cubes should be sliced
    this.beatLine = new THREE.Mesh(new THREE.PlaneGeometry(W, 0.05), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25 }));
    this.beatLine.rotation.x = -Math.PI / 2; this.beatLine.position.set(0, 0.004, BEAT_Z); this.trackGroup.add(this.beatLine);
    // light dashes that run along the track at the cubes' speed
    this.dashes = [];
    const dashGeo = new THREE.PlaneGeometry(0.06, 0.7);
    for (let i = 0; i < 40; i++) {
      const m = new THREE.Mesh(dashGeo, new THREE.MeshBasicMaterial({ color: i % 2 ? COLORS.R : COLORS.L, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
      m.rotation.x = -Math.PI / 2; m.position.set((i % 2 ? 1 : -1) * (W / 2 - 0.12), 0.006, -i * 1.1);
      this.trackGroup.add(m); this.dashes.push(m);
    }
    // a pad where you stand
    const pad = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.46, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }));
    pad.rotation.x = -Math.PI / 2; pad.position.y = 0.005; s.add(pad); this.pad = pad;

    // arches over the track that pulse on the beat
    this.rings = [];
    const ringGeo = new THREE.TorusGeometry(3.4, 0.035, 8, 72, Math.PI);
    for (let i = 0; i < 22; i++) {
      const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }));
      this.rings.push(ring); s.add(ring);
    }
    this.hurt = new THREE.Mesh(new THREE.SphereGeometry(0.35, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff0033, side: THREE.BackSide, transparent: true, opacity: 0, depthTest: false, depthWrite: false, fog: false }));
    this.hurt.renderOrder = 11; this.camera.add(this.hurt);
    this._applyPalette('normal', true);
  }

  _applyPalette(name, force) {
    if (this.palette === name && !force) return;
    this.palette = name;
    const p = PALETTES[name];
    this.rings.forEach((r, i) => r.material.color.setHex(p.rings[i % 2]));
    this.targetFog = new THREE.Color(p.fog);
  }

  /* ================= sabers ================= */
  _saberMesh(hand) {
    const g = new THREE.Group();
    const col = COLORS[hand];
    const hilt = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.022, 0.2, 16), new THREE.MeshStandardMaterial({ color: 0x2a2d38, metalness: 0.8, roughness: 0.3 }));
    hilt.rotation.x = Math.PI / 2; hilt.position.z = 0.02;
    const guard = new THREE.Mesh(new THREE.TorusGeometry(0.026, 0.007, 8, 20), new THREE.MeshBasicMaterial({ color: col }));
    guard.position.z = -0.08;
    const blade = new THREE.Group(); blade.position.z = -0.08;
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.011, BLADE, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    const glow = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.03, BLADE, 16, 1, true), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
    for (const m of [core, glow]) { m.rotation.x = Math.PI / 2; m.position.z = -BLADE / 2; blade.add(m); }
    g.add(hilt, guard, blade);
    g.userData = { blade, glow };
    return g;
  }

  _buildSabers() {
    // Sabers follow whatever the Quest tracks: Touch controllers (grip pose, blade out the front of
    // your fist) or bare hands (blade out along your fingers). Read from the XRFrame every frame.
    this.sabers = {};
    for (const hand of ['L', 'R']) {
      const mesh = this._saberMesh(hand);
      const trailN = 14;
      const tg = new THREE.BufferGeometry();
      const tp = new Float32Array(trailN * 2 * 3), tc = new Float32Array(trailN * 2 * 3);
      tg.setAttribute('position', new THREE.BufferAttribute(tp, 3));
      tg.setAttribute('color', new THREE.BufferAttribute(tc, 3));
      const idx = [];
      for (let i = 0; i < trailN - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      tg.setIndex(idx);
      const trail = new THREE.Mesh(tg, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      trail.frustumCulled = false;
      this.scene.add(mesh, trail);
      this.sabers[hand] = {
        hand, mesh, trail, trailN, hist: [], src: null, tracked: false, kind: null, on: 0,
        base: v3(), tip: v3(), pBase: v3(), pTip: v3(), vel: v3(), vBase: v3(), vTip: v3(), dirHist: [],
      };
    }
    // Wrist pause button on the back of the left hand: turn it toward you and tap it with your right hand.
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(16,7,34,0.85)'; g.beginPath(); g.arc(64, 64, 60, 0, Math.PI * 2); g.fill();
    g.lineWidth = 6; g.strokeStyle = '#ffe14d'; g.stroke();
    g.fillStyle = '#ffe14d'; g.fillRect(40, 36, 16, 56); g.fillRect(72, 36, 16, 56);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    this.wristBtn = new THREE.Mesh(new THREE.CircleGeometry(0.035, 32), new THREE.MeshBasicMaterial({ map: tex, transparent: true, fog: false, depthTest: false }));
    this.wristBtn.renderOrder = 9;
    this.wristBtn.position.set(0, 0.06, 0.1);
    this.wristBtn.rotation.x = -Math.PI / 2;
    this.wristBtn.visible = false;
    this.sabers.L.mesh.add(this.wristBtn);
    this._wristHold = 0;
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3();
  }

  _trackXr(g, src, frame, ref) {
    let pose = null;
    if (src.hand) {
      const j = (n) => src.hand.get(n);
      const knuckle = frame.getJointPose && frame.getJointPose(j('middle-finger-phalanx-proximal'), ref);
      const meta = frame.getJointPose && frame.getJointPose(j('middle-finger-metacarpal'), ref);
      if (knuckle && meta) {
        const p = knuckle.transform.position, o = meta.transform.orientation;
        this._m.compose(this._s.set(p.x, p.y, p.z), this._q.set(o.x, o.y, o.z, o.w), new THREE.Vector3(1, 1, 1));
        g.kind = 'hand'; pose = true;
      }
    } else if (src.gripSpace) {
      // pistols point along the controller's aiming ray (comfortable wrist angle); sabers and orbs use the grip
      const gp = frame.getPose(this.guns && src.targetRaySpace ? src.targetRaySpace : src.gripSpace, ref);
      if (gp) { this._m.fromArray(gp.transform.matrix); g.kind = 'controller'; pose = true; }
    }
    if (!pose) return false;
    this.rig.updateMatrixWorld();
    this._m.premultiply(this.rig.matrixWorld);
    this._m.decompose(g.mesh.position, g.mesh.quaternion, this._s);
    return true;
  }

  /* ================= pools ================= */
  _chevronGeo() {
    const s = new THREE.Shape();
    s.moveTo(-0.13, 0.05); s.lineTo(0.13, 0.05); s.lineTo(0, -0.08); s.closePath();
    return new THREE.ShapeGeometry(s);
  }

  _buildPools() {
    const box = new THREE.BoxGeometry(CUBE, CUBE, CUBE);
    const edges = new THREE.EdgesGeometry(box);
    const chev = this._chevronGeo(), dot = new THREE.CircleGeometry(0.05, 24);
    this.cubes = [];
    for (let i = 0; i < 40; i++) {
      const g = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0x000000, emissiveIntensity: 0.5, metalness: 0.3, roughness: 0.35, transparent: true });
      const body = new THREE.Mesh(box, mat);
      const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true });
      const frame = new THREE.LineSegments(edges, lineMat);
      const markMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true });
      const arrow = new THREE.Mesh(chev, markMat); arrow.position.z = CUBE / 2 + 0.002;
      const circle = new THREE.Mesh(dot, markMat); circle.position.z = CUBE / 2 + 0.002;
      g.add(body, frame, arrow, circle);
      g.visible = false; g.userData = { mat, lineMat, markMat, arrow, circle };
      this.scene.add(g); this.cubes.push(g);
    }
    // mines: a dark core with spikes and a red glow
    this.mines = [];
    const core = new THREE.IcosahedronGeometry(0.12, 1), spike = new THREE.ConeGeometry(0.025, 0.1, 6);
    for (let i = 0; i < 16; i++) {
      const g = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color: 0x1a1a22, emissive: 0xff1133, emissiveIntensity: 0.6, metalness: 0.8, roughness: 0.4 });
      g.add(new THREE.Mesh(core, mat));
      const dirs = new THREE.IcosahedronGeometry(1, 0).attributes.position;
      const seen = [];
      for (let k = 0; k < dirs.count; k++) {
        const d = new THREE.Vector3().fromBufferAttribute(dirs, k).normalize();
        if (seen.some((x) => x.distanceTo(d) < 0.01)) continue; seen.push(d);
        const sp = new THREE.Mesh(spike, mat); sp.position.copy(d).multiplyScalar(0.14);
        sp.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d); g.add(sp);
      }
      g.visible = false; g.userData = { mat };
      this.scene.add(g); this.mines.push(g);
    }
    // walls: see-through panels with glowing edges
    this.walls = [];
    const wbox = new THREE.BoxGeometry(1, 1, 1), wedges = new THREE.EdgesGeometry(wbox);
    for (let i = 0; i < 6; i++) {
      const g = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color: 0xff3d9a, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide });
      const lmat = new THREE.LineBasicMaterial({ color: 0xff8acb, transparent: true, opacity: 0.9 });
      g.add(new THREE.Mesh(wbox, mat), new THREE.LineSegments(wedges, lmat));
      g.visible = false; g.userData = { mat, lmat };
      this.scene.add(g); this.walls.push(g);
    }
    // debris: the two halves of sliced cubes
    this.debris = [];
    for (let i = 0; i < 48; i++) {
      const outer = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0x000000, emissiveIntensity: 0.6, metalness: 0.3, roughness: 0.35, transparent: true, side: THREE.DoubleSide });
      const capM = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, side: THREE.DoubleSide });
      const m = new THREE.Mesh(new THREE.BufferGeometry(), [outer, capM]);
      m.visible = false; m.userData = { outer, capM, vel: v3(), spin: v3(), life: 0 };
      this.scene.add(m); this.debris.push(m);
    }
    this.debrisNext = 0;

    this.PN = 1200;
    const geo = new THREE.BufferGeometry();
    this.pPos = new Float32Array(this.PN * 3); this.pCol = new Float32Array(this.PN * 3);
    this.pVel = new Float32Array(this.PN * 3); this.pLife = new Float32Array(this.PN);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    const dc = document.createElement('canvas'); dc.width = dc.height = 32;
    const dg = dc.getContext('2d'), grd = dg.createRadialGradient(16, 16, 0, 16, 16, 16);
    grd.addColorStop(0, '#fff'); grd.addColorStop(0.4, 'rgba(255,255,255,0.6)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    dg.fillStyle = grd; dg.fillRect(0, 0, 32, 32);
    this.particles = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.025, map: new THREE.CanvasTexture(dc), vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.particles.frustumCulled = false;
    this.scene.add(this.particles); this.pNext = 0;
    for (let i = 0; i < this.PN; i++) this.pPos[i * 3 + 1] = -100;
    const mk = (text, color, w = 256) => {
      const c = document.createElement('canvas'); c.width = w; c.height = 64;
      const g = c.getContext('2d'); g.font = '800 44px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.shadowColor = color; g.shadowBlur = 12; g.fillStyle = color; g.fillText(text, w / 2, 34);
      return new THREE.CanvasTexture(c);
    };
    this.popTex = { perfect: mk('PERFECT', '#ffe14d'), great: mk('GREAT', '#7dff8a'), good: mk('GOOD', '#9ad8ff'), miss: mk('MISS', '#ff4d4d'), bad: mk('WRONG WAY', '#ff8a4d', 320), color: mk('WRONG SABER', '#ff8a4d', 320), mine: mk('MINE!', '#ff3355'), wall: mk('WALL!', '#ff3d9a') };
    this.pops = [];
    for (let i = 0; i < 16; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false }));
      s.scale.set(0.4, 0.1, 1); s.visible = false; s.renderOrder = 5; s.userData.life = 0;
      this.scene.add(s); this.pops.push(s);
    }
    this.popNext = 0;
  }

  _buildHud() {
    // On the left of the track, angled toward you, so it never covers incoming cubes.
    this.hudCanvas = document.createElement('canvas'); this.hudCanvas.width = 1024; this.hudCanvas.height = 300;
    this.hudTex = new THREE.CanvasTexture(this.hudCanvas);
    this.hudTex.colorSpace = THREE.SRGBColorSpace;
    this.hud = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.44), new THREE.MeshBasicMaterial({ map: this.hudTex, transparent: true, depthWrite: false, fog: false }));
    this.hud.rotation.set(-0.35, 0.55, 0, 'YXZ');
    this.scene.add(this.hud);
    this.hudDirty = true; this.hudLast = 0; this.message = ''; this.messageUntil = 0;
    // energy bar: under the notes, in front of you
    this.energyBar = new THREE.Group();
    const bw = 1.5, bh = 0.045;
    const back = new THREE.Mesh(new THREE.PlaneGeometry(bw + 0.03, bh + 0.03), new THREE.MeshBasicMaterial({ color: 0x0a0418, transparent: true, opacity: 0.8, fog: false, depthWrite: false }));
    const fillGeo = new THREE.PlaneGeometry(bw, bh); fillGeo.translate(bw / 2, 0, 0);
    this.energyFill = new THREE.Mesh(fillGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false, depthWrite: false }));
    this.energyFill.position.set(-bw / 2, 0, 0.002);
    const mid = new THREE.Mesh(new THREE.PlaneGeometry(0.006, bh + 0.03), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, fog: false }));
    mid.position.z = 0.004;
    this.energyBar.add(back, this.energyFill, mid);
    this.energyBar.rotation.x = -0.35;
    this.scene.add(this.energyBar);
  }

  /* ================= run state ================= */
  resetRun() {
    const E = ENERGY[this.style] || ENERGY.saber;
    this.run = { score: 0, combo: 0, maxCombo: 0, hits: 0, misses: 0, perfects: 0, supers: 0, mines: 0, walls: 0, bullets: 0, whips: 0, total: 0, errs: [], energy: E.start, failed: false, zeroed: false };
    this.failT = 0;
    for (const n of this.active) this._release(n);
    if (this.styles) for (const s of this._styleList()) s.reset();
    this.tscale = 1; if (this.player && this.player.setRate) this.player.setRate(1);
    if (this.saberFx) this.saberFx.reset();
    this.active = []; this.hudDirty = true;
    this.inWall = false;
  }

  setPlayer(p) { this.player = p; }
  speed() {
    const m = this.mods.fast ? 1.25 : this.mods.slow ? 0.75 : 1;
    if (this.guns) return this.styles.shoot.walkSpeed(this.difficulty) * m;
    return (SPEED[this.difficulty] || 10) * (this.style === 'ride' ? 0.85 : 1) * m;
  }
  leadMs() { return (SPAWN_DIST / this.speed()) * 1000; }

  loadTrack(track, tempo, difficulty, { style = 'saber', mods = {} } = {}) {
    for (const n of this.active) this._release(n);
    this.active = [];
    this.style = this.styles[style] ? style : 'saber';
    this.mods = activeMods(mods, this.style); this.modMult = modMultiplier(mods, this.style);
    this.track = track; this.tempo = tempo; this.difficulty = difficulty; this._lastPos = undefined;
    this.paused = false; // a new song never starts paused (Restart / Next song from the pause menu)
    this.resetRun();
    this._regen();
    this.calibrateHeight();
    this.mode = 'play';
    this.flash(tempo.source === 'default' ? 'Tempo is a guess: tap A/X (or T) on the beat to lock it' : `${Math.round(tempo.bpm)} BPM${tempo.source === 'lookup' ? ` (${tempo.from})` : ''} · ${difficulty.toUpperCase()}${this.modMult !== 1 ? ` · mods ×${this.modMult}` : ''}`, 4000);
  }

  _regen(fromMs = -1) {
    this.sections = (this.track && (this.track.sections || this.structure)) || [];
    let { items } = generate(this.track, this.tempo, this.difficulty, { sections: this.sections, beats: this.beats, shiftMs: this.shiftMs || 0 });
    if (this.mods.noWalls) items = items.filter((n) => n.type !== 'wall');
    if (this.sx) items = this.sx.convert(items, { tempo: this.tempo, difficulty: this.difficulty, seed: this.track.id, mods: this.mods });
    else {
      if (this.mods.noMines) items = items.filter((n) => n.type !== 'mine');
      if (this.mods.noArrows) items = items.map((n) => (n.type === 'note' ? { ...n, dir: 'A' } : n));
    }
    this.items = fromMs < 0 ? items : items.filter((n) => n.t > fromMs + 100);
    this.nextItem = 0;
    this.run.total = items.filter((n) => n.scored !== false && n.type !== 'wall' && n.type !== 'mine').length;
  }

  retime(tempo) {
    this.tempo = tempo;
    this._regen(this.songPos() + this.leadMs());
    this.hudDirty = true;
  }

  calibrateHeight() {
    const p = v3();
    this.camera.getWorldPosition(p);
    this.headY = this.r.xr.isPresenting ? p.y : 1.6;
    this.rowY = [0, 1, 2].map((k) => Math.max(0.45, this.headY - 1.05) + k * ROW);
    this.hud.position.set(-1.75, this.headY - 0.55, -2.2);
    if (this.guns) this.energyBar.position.set(0, this.headY - 0.8, -2);
    else this.energyBar.position.set(0, Math.max(0.2, this.rowY[0] - 0.36), this.hitZ() - 1.9);
    for (const ring of this.rings) ring.position.y = 0;
  }

  cellPos(col, row) { return new THREE.Vector3((col - 1.5) * LANE, this.rowY[row], 0); }
  songPos() { return this.player ? this.player.positionMs() - this.latencyMs : 0; }
  flash(text, ms = 2000) { this.message = text; this.messageUntil = performance.now() + ms; this.hudDirty = true; }
  stop() { this.mode = 'menu'; this.paused = false; this.resetRun(); this.track = null; this.sections = []; }

  /* ================= per frame ================= */
  update(dt) {
    const now = performance.now();
    const playing = this.mode === 'play' && this.track && this.player && this.player.playing && !this.run.failed;
    // STILL: time runs as fast as you move. Your own songs really slow down; Spotify can't, so there only the danger slows.
    if (this.style === 'still' && playing && !this.paused) this.tscale = this.styles.shoot.timeScale(dt);
    else this.tscale += (1 - this.tscale) * Math.min(1, dt * 6);
    if (this.player && this.player.setRate) this.player.setRate(this.style === 'still' && playing && !this.paused ? this.tscale : 1);
    const pos = this.songPos();
    if (!this.r.xr.isPresenting) { // screen: step back during a song so the whole grid is in view
      const z = this.mode === 'play' ? 1.5 : 0;
      this.camera.position.z += (z - this.camera.position.z) * Math.min(1, dt * 4);
    }
    this._updateSabers(dt, pos);
    this.saberFx.update(dt, this.mode === 'play' && this.style === 'saber' && !this.paused && !this.run.failed);
    this._updateWrist(dt);
    if (this.mode === 'play') this._updateInputs();

    if (playing && this._lastPos !== undefined && (pos < this._lastPos - 400 || pos > this._lastPos + 1500)) {
      for (const n of this.active) this._release(n);
      this.active.length = 0;
      this.nextItem = this.items.findIndex((n) => n.t - pos > 300);
      if (this.nextItem < 0) this.nextItem = this.items.length;
    }
    this._lastPos = playing ? pos : undefined;
    const lead = this.leadMs(), spd = this.speed();
    if (playing) {
      while (this.nextItem < this.items.length && this.items[this.nextItem].t - pos < lead) {
        const n = this.items[this.nextItem++];
        if (n.t - pos < -200 && n.type !== 'wall' && !(n.dur && n.t + n.dur > pos + 200)) continue;
        this._spawn(n);
      }
    }

    const head = this.camera.getWorldPosition(v3());
    let headInWall = false;
    const sx = this.sx;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const n = this.active[i], m = n.mesh;
      const tt = (n.t - pos) / 1000;
      if (this.run.failed && n.type !== 'wall') { // failed: everything drops away
        m.position.y -= dt * (1 + (this.failT * 4)); m.rotation.x += dt * 2;
        if (m.position.y < -1.5) { this._release(n); this.active.splice(i, 1); }
        continue;
      }
      if (sx && n.type !== 'wall') {
        if (sx.place(n, tt, pos, dt)) { this._release(n); this.active.splice(i, 1); }
        continue;
      }
      if (n.type === 'wall') {
        const zf = -tt * spd, len = (n.dur / 1000) * spd;
        m.position.z = zf - len / 2; m.scale.z = len;
        const age = (lead / 1000 - tt);
        m.userData.mat.opacity = 0.18 * Math.min(1, age / 0.4); m.userData.lmat.opacity = 0.9 * Math.min(1, age / 0.4);
        if (zf > 0 && zf - len < 0 && this.r.xr.isPresenting) {
          const b = n.box;
          if (head.x > b.x0 - 0.06 && head.x < b.x1 + 0.06 && head.y > b.y0 - 0.06 && head.y < b.y1) headInWall = true;
        }
        if (zf - len > MISS_Z + 1) { this._release(n); this.active.splice(i, 1); }
        continue;
      }
      const z = BEAT_Z - tt * spd;
      const age = lead / 1000 - tt;
      const rise = Math.min(1, age / 0.35), ease = 1 - (1 - rise) ** 3;
      m.position.set(n.home.x, n.home.y - (1 - ease) * 0.5, z);
      if (n.type === 'note') {
        m.rotation.z = n.roll + (1 - ease) * Math.PI * 0.75;
        m.userData.mat.opacity = m.userData.lineMat.opacity = m.userData.markMat.opacity = Math.min(1, age / 0.25) * this.ghostFade(z);
      } else {
        m.rotation.set(now / 700 + n.id, now / 900, 0);
      }
      if (z > MISS_Z) {
        if (n.type === 'note') this._miss(n);
        this._release(n); this.active.splice(i, 1);
      }
    }
    this._wallCheck(headInWall, dt, playing && !this.paused);
    if (playing && !this.paused) { if (sx) sx.collide(pos, dt); else this._collide(pos); }
    if (sx) sx.updateFx(dt, pos, playing && !this.paused);
    if (this.run.failed) this.failT += dt;
    this._updateEnergyBar(dt);

    this._updateWorld(dt, pos);
    this._updateFx(dt * this.tscale);
    if (now - this.hudLast > 500) this.hudDirty = true;
    if (this.hudDirty && now - this.hudLast > 80) this._drawHud(pos);
  }

  _wallCheck(inside, dt, live) {
    const E = ENERGY[this.style];
    if (inside && !this.inWall) {
      this.run.walls++; this.run.combo = 0; this.hudDirty = true;
      this._pop('wall', this.camera.getWorldPosition(v3()).add(new THREE.Vector3(0, -0.1, -0.7)));
      for (const s of Object.values(this.sabers)) this._haptic(s, 0.8, 200);
      this.energy(E.wall, true);
    } else if (inside && live) this.energy(E.wallPerSec * dt, false);
    if (inside) this.hurtT = 0.3;
    this.inWall = inside;
  }

  /* ================= energy, score, fail ================= */
  /** Change the energy bar. mistake: a miss/hit that ends a One Life run and drains more on Strict. */
  energy(delta, mistake = delta < 0) {
    const r = this.run;
    if (r.failed || !this.track) return;
    if (delta < 0 && mistake && this.mods.strict) delta *= 1.5;
    if (delta < 0 && mistake && this.mods.oneLife) delta = -2;
    r.energy = Math.max(0, Math.min(1, r.energy + delta));
    this.hudDirty = true;
    if (r.energy <= 0) {
      if (this.mods.noFail) { if (!r.zeroed) { r.zeroed = true; this.flash('NO FAIL: score halved from here', 3000); } return; }
      r.failed = true; this.failT = 0;
      this.hurtT = 0.6;
      for (const s of Object.values(this.sabers)) this._haptic(s, 1, 400);
      this.flash('FAILED', 4000);
      this.hooks.onFail && this.hooks.onFail();
    }
  }
  /** Add points: × combo multiplier × modifiers, halved after hitting zero on No Fail. */
  addScore(pts) {
    this.run.score += Math.round(pts * this.multiplier() * this.modMult * (this.run.zeroed ? 0.5 : 1));
  }
  /** Ghost notes: full until 5 m out, gone 2.5 m before the hit point. */
  ghostFade(z) {
    if (!this.mods.ghost) return 1;
    const d = this.hitZ() - z;
    return Math.max(0, Math.min(1, (d - 2.5) / 2.5));
  }
  _updateEnergyBar(dt) {
    const show = this.mode === 'play' && !!this.track;
    this.energyBar.visible = show;
    if (!show) return;
    const e = this.run.energy;
    this._eShow = (this._eShow ?? e) + (e - (this._eShow ?? e)) * Math.min(1, dt * 10);
    this.energyFill.scale.x = Math.max(0.001, this._eShow);
    const c = this.energyFill.material.color;
    if (this.run.zeroed) c.setHex(0x8a8a99);
    else if (e < 0.25) c.setHex((performance.now() % 500) < 250 ? 0xff2244 : 0xff8899);
    else if (e < 0.5) c.setHex(0xffb347);
    else c.setHex(0xffffff);
  }

  _updateSabers(dt, pos) {
    const xr = this.r.xr.isPresenting;
    const live = this.mode === 'play' && !this.paused;
    for (const g of Object.values(this.sabers)) {
      g.pBase.copy(g.base); g.pTip.copy(g.tip);
      if (xr) {
        const frame = this.r.xr.getFrame(), ref = this.r.xr.getReferenceSpace(), session = this.r.xr.getSession();
        g.src = null; g.tracked = false;
        if (frame && ref && session) {
          for (const src of session.inputSources) {
            if ((src.handedness === 'left' ? 'L' : src.handedness === 'right' ? 'R' : null) !== g.hand) continue;
            if (this._trackXr(g, src, frame, ref)) { g.src = src; g.tracked = true; break; }
          }
        }
        // Tracking drops out for a moment now and then (fast swings, hands leaving the cameras' view):
        // keep the saber where it was for half a second instead of blinking it out. It can't cut meanwhile.
        if (g.tracked) g.seenAt = performance.now();
        g.mesh.visible = g.tracked || performance.now() - (g.seenAt || 0) < 500;
      } else {
        this._desktopSaber(g, pos);
        g.mesh.visible = this.mode === 'play';
        g.tracked = true;
      }
      // blade ignites for a song and goes out in menus (the laser pointers take over there)
      g.on += ((live && this.style === 'saber' ? 1 : 0) - g.on) * Math.min(1, dt * 8);
      g.mesh.userData.blade.scale.set(1, 1, Math.max(0.001, g.on));
      g.mesh.userData.blade.visible = g.on > 0.02;
      g.mesh.updateMatrixWorld();
      g.base.set(0, 0, -0.08).applyMatrix4(g.mesh.matrixWorld);
      g.tip.set(0, 0, -0.08 - BLADE * g.on).applyMatrix4(g.mesh.matrixWorld);
      if (dt > 0) { // velocity of both ends of the blade (a wrist flick moves the tip much faster than the hilt)
        const vb = tmpV.subVectors(g.base, g.pBase).divideScalar(dt), vt = tmpV2.subVectors(g.tip, g.pTip).divideScalar(dt);
        if (vb.length() < 40 && vt.length() < 60) { g.vBase.lerp(vb, 0.7); g.vTip.lerp(vt, 0.7); }
        g.vel.copy(g.vBase).add(g.vTip).multiplyScalar(0.5);
      }
      const now = this.mode === 'play' ? pos : performance.now(); // song time, so pauses don't count
      if (g.dirHist.length && now < g.dirHist[g.dirHist.length - 1].t) g.dirHist.length = 0;
      g.dirHist.push({ t: now, d: tmpV.subVectors(g.tip, g.base).normalize().clone() });
      while (g.dirHist.length && now - g.dirHist[0].t > 300) g.dirHist.shift();
      g.mesh.userData.glow.material.opacity = 0.45 + Math.min(0.4, g.vel.length() * 0.04);
      this._updateTrail(g, g.tracked && g.on > 0.5);
      for (const s of this._styleList()) s.handFrame(g, dt, live && this.sx === s);
      const hilt = this.style === 'saber' || this.mode !== 'play'; // orbs and pistols replace the hilt in a song
      g.mesh.children[0].visible = g.mesh.children[1].visible = hilt;
    }
  }

  /** A slight ribbon behind the blade: the last ~0.1 s of its upper half, brighter the faster it moves. */
  _updateTrail(g, show) {
    const now = performance.now();
    g.hist.unshift({ b: g.base.clone().lerp(g.tip, 0.45), t: g.tip.clone(), at: now });
    while (g.hist.length > 2 && (now - g.hist[g.hist.length - 1].at > TRAIL_MS || g.hist.length > 40)) g.hist.pop();
    const p = g.trail.geometry.attributes.position.array, c = g.trail.geometry.attributes.color.array;
    const col = new THREE.Color(COLORS[g.hand]);
    const bright = show ? Math.min(1, Math.max(0, (g.vTip.length() - 0.6) / 3)) : 0; // no trail while the blade is still
    const last = g.hist.length - 1;
    for (let i = 0; i < g.trailN; i++) {
      const f = i / (g.trailN - 1), x = f * last, i0 = Math.floor(x), i1 = Math.min(last, i0 + 1), w = x - i0; // spread evenly over the history
      const h0 = g.hist[i0], h1 = g.hist[i1];
      const bx = h0.b.x + (h1.b.x - h0.b.x) * w, by = h0.b.y + (h1.b.y - h0.b.y) * w, bz = h0.b.z + (h1.b.z - h0.b.z) * w;
      const tx = h0.t.x + (h1.t.x - h0.t.x) * w, ty = h0.t.y + (h1.t.y - h0.t.y) * w, tz = h0.t.z + (h1.t.z - h0.t.z) * w;
      p.set([bx, by, bz], i * 6); p.set([tx, ty, tz], i * 6 + 3);
      const k = bright * (1 - f) ** 1.6 * 0.55;
      c.set([col.r * k * 0.15, col.g * k * 0.15, col.b * k * 0.15], i * 6); c.set([col.r * k, col.g * k, col.b * k], i * 6 + 3);
    }
    g.trail.geometry.attributes.position.needsUpdate = true; g.trail.geometry.attributes.color.needsUpdate = true;
  }

  /** Screen controls: the saber matching the next cube follows the mouse; the bot slices by itself. */
  _desktopSaber(g, pos) {
    if (this.sx && this.mode === 'play' && this.sx.desktopHand(g, pos)) return;
    const side = g.hand === 'L' ? -1 : 1;
    const base = new THREE.Vector3(side * 0.28, this.headY - 0.55, -0.1);
    let aim = null;
    if (this.mode === 'play') {
      if (this.bot) aim = this._botAim(g.hand, pos);
      else if (this._activeHand(pos) === g.hand) aim = this.desktop.aim;
    }
    if (!aim) aim = this.mode === 'play' ? new THREE.Vector3(side * 0.7, this.headY - 1.2, -0.5) : new THREE.Vector3(side * 0.45, this.headY + 0.4, -0.3); // resting: low and out in a song
    g.mesh.position.copy(base);
    const dir = aim.clone().sub(base).normalize();
    g.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
  }
  _activeHand(pos) {
    let best = null;
    for (const n of this.active) if (n.type === 'note' && !n.dead && (!best || n.t < best.t)) best = n;
    return best && best.t - pos < 900 ? best.hand : null;
  }
  _botAim(hand, pos) {
    // swing through the cube along its arrow, timed so the blade crosses it on the beat
    let n = null;
    for (const x of this.active) if (x.type === 'note' && !x.dead && x.hand === hand && (!n || x.t < n.t)) n = x;
    if (!n || n.t - pos > 400) return null;
    // wind up well clear of the cube's path, then sweep through it as it reaches the blade
    const k = Math.max(-1, Math.min(1, (pos - n.t + 25) / 50));
    const d = DIRS[n.dir];
    return new THREE.Vector3(n.home.x + d[0] * k * 0.9, n.home.y + d[1] * k * 0.9, Math.max(BEAT_Z - 0.1, n.mesh.position.z));
  }

  _btn(g, i) { return !!(g.src && g.src.gamepad && g.src.gamepad.buttons[i] && g.src.gamepad.buttons[i].pressed); }

  _updateWrist(dt) {
    const L = this.sabers.L, R = this.sabers.R, b = this.wristBtn;
    const show = this.r.xr.isPresenting && this.mode === 'play' && !this.paused && L.tracked;
    let facing = false, touching = false;
    if (show) {
      const bp = b.getWorldPosition(new THREE.Vector3());
      const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(b.getWorldQuaternion(new THREE.Quaternion()));
      const head = this.camera.getWorldPosition(new THREE.Vector3());
      facing = normal.dot(head.clone().sub(bp).normalize()) > 0.35;
      touching = facing && R.tracked && R.mesh.position.distanceTo(bp) < 0.11;
    }
    b.visible = show && facing;
    b.scale.setScalar(touching ? 1.3 : 1);
    this._wristHold = touching ? this._wristHold + dt : 0;
    if (this._wristHold > 0.15) { this._wristHold = -10; this._haptic(R, 0.6, 60); this.hooks.onPause && this.hooks.onPause(); }
  }

  _updateInputs() {
    if (!this.r.xr.isPresenting) return;
    const L = this.sabers.L, R = this.sabers.R;
    const edge = (key, down) => { const was = this['_' + key]; this['_' + key] = down; return down && !was; };
    if (edge('tapBtn', this._btn(L, 4) || this._btn(R, 4))) this.hooks.onTap && this.hooks.onTap();
    if (edge('pauseBtn', this._btn(L, 5) || this._btn(R, 5))) this.hooks.onPause && this.hooks.onPause();
  }

  _spawn(n) {
    if (n.type === 'wall') {
      const mesh = this.walls.find((m) => !m.visible); if (!mesh) return;
      const box = n.kind === 'top'
        ? { x0: -LANE * 2, x1: LANE * 2, y0: this.headY - 0.22, y1: this.headY + 0.9 }
        : n.kind === 'L' ? { x0: -LANE * 2, x1: 0.1, y0: 0, y1: this.headY + 0.9 } : { x0: -0.1, x1: LANE * 2, y0: 0, y1: this.headY + 0.9 };
      mesh.visible = true;
      mesh.position.set((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, -SPAWN_DIST);
      mesh.scale.set(box.x1 - box.x0, box.y1 - box.y0, 1);
      this.active.push({ ...n, mesh, box });
      return;
    }
    if (this.sx) { const a = this.sx.spawn(n); if (a) this.active.push(a); return; }
    const pool = n.type === 'mine' ? this.mines : this.cubes;
    const mesh = pool.find((m) => !m.visible);
    if (!mesh) return;
    mesh.visible = true; mesh.scale.setScalar(1);
    const home = this.cellPos(n.col, n.row);
    if (n.type === 'note') {
      const u = mesh.userData, c = new THREE.Color(COLORS[n.hand]);
      u.mat.color.copy(c).multiplyScalar(0.55); u.mat.emissive.copy(c); u.mat.emissiveIntensity = 0.45;
      u.lineMat.color.copy(c).lerp(new THREE.Color(0xffffff), 0.5);
      u.arrow.visible = n.dir !== 'A'; u.circle.visible = n.dir === 'A';
    }
    this.active.push({ ...n, home, roll: n.type === 'note' ? rollFor(n.dir) : 0, mesh, dead: false });
  }
  _release(n) { if (n.mesh) { n.mesh.visible = false; n.mesh.userData.used = false; n.mesh.rotation.set(0, 0, 0); } } // undo the fail tumble before reuse

  multiplier() { return Math.min(8, 1 + Math.floor(this.run.combo / 8)); }

  /** Blade vs cubes and mines, swept between frames so fast swings don't skip through. */
  _collide(pos) {
    const inv = new THREE.Matrix4();
    const a = v3(), b = v3(), la = v3(), lb = v3();
    for (const g of Object.values(this.sabers)) {
      if (!g.tracked || g.on < 0.9) continue;
      for (let i = this.active.length - 1; i >= 0; i--) {
        const n = this.active[i];
        if (n.type === 'wall' || n.dead) continue;
        const m = n.mesh;
        if (m.position.z < -2.2 || m.position.z > 0.6) continue;
        let hit = false;
        if (n.type === 'mine') {
          for (let s = 0; s <= 4 && !hit; s++) {
            a.lerpVectors(g.pBase, g.base, s / 4); b.lerpVectors(g.pTip, g.tip, s / 4);
            if (segPointDist(a, b, m.position) < 0.17) hit = true;
          }
          if (hit) { this._mineHit(n, g); this._release(n); this.active.splice(i, 1); }
          continue;
        }
        const hx = n.col === 0 || n.col === 3 ? HIT_X_OUTER : HIT_X;
        for (let s = 0; s <= 4 && !hit; s++) {
          la.lerpVectors(g.pBase, g.base, s / 4).sub(m.position); lb.lerpVectors(g.pTip, g.tip, s / 4).sub(m.position);
          if (segHitsAabb(la, lb, hx, HIT_Y, HIT_Z)) hit = true;
        }
        if (hit) { this._cut(n, g, pos); this._release(n); this.active.splice(i, 1); }
      }
    }
  }

  _cut(n, g, pos) {
    n.dead = true;
    const tt = (n.t - pos) / 1000;
    // swing velocity where the blade met the cube
    const bl = tmpV.subVectors(g.tip, g.base), k = Math.max(0, Math.min(1, tmpV2.subVectors(n.mesh.position, g.base).dot(bl) / (bl.lengthSq() || 1)));
    const vHit = g.vBase.clone().lerp(g.vTip, k);
    const swing = new THREE.Vector2(vHit.x, vHit.y);
    const sp = swing.length();
    const want = new THREE.Vector2(...DIRS[n.dir]);
    const rightSaber = g.hand === n.hand;
    const tol = this.mods.strict ? 0.71 : DIR_TOL; // Strict: within 45° instead of 60°
    const rightWay = n.dir === 'A' ? sp > MIN_SWING * 0.6 : sp > MIN_SWING && swing.clone().normalize().dot(want) > tol;
    // cut plane: contains the blade and the swing direction
    const bladeDir = tmpV.subVectors(g.tip, g.base).normalize().clone();
    const vel3 = vHit.lengthSq() > 1e-6 ? vHit.clone().normalize() : new THREE.Vector3(want.x, want.y, 0);
    let normal = bladeDir.clone().cross(vel3);
    if (normal.lengthSq() < 1e-4) normal = new THREE.Vector3(-want.y, want.x, 0);
    normal.normalize();
    const centreOff = Math.abs(n.mesh.position.clone().sub(g.base).dot(normal));
    this._shatter(n, normal, g.base, vel3, rightSaber && rightWay ? COLORS[n.hand] : 0x777777);
    if (!rightSaber || !rightWay) {
      this.run.combo = 0; this.run.misses++;
      this._pop(!rightSaber ? 'color' : 'bad', n.mesh.position);
      this._haptic(g, 0.3, 80);
      this.energy(ENERGY.saber.bad);
      this.hudDirty = true;
      return;
    }
    // score: a clean cut, plus the size of the swing, how centred it was, and the timing
    const old = g.dirHist[0] ? g.dirHist[0].d : bladeDir;
    const arc = THREE.MathUtils.radToDeg(old.angleTo(bladeDir));
    const pts = 40 + Math.round(30 * Math.min(1, arc / 90)) + Math.round(20 * Math.max(0, 1 - centreOff / (CUBE / 2))) + Math.round(10 * Math.max(0, 1 - Math.abs(tt) / 0.15));
    const rating = pts >= 88 ? 'perfect' : pts >= 72 ? 'great' : 'good';
    this.run.errs.push(tt);
    this.run.combo++; this.run.hits++;
    if (rating === 'perfect') this.run.perfects++;
    this.run.maxCombo = Math.max(this.run.maxCombo, this.run.combo);
    this.addScore(pts);
    this.energy(ENERGY.saber.hit);
    this._pop(rating, n.mesh.position);
    this._haptic(g, rating === 'perfect' ? 1 : 0.6, 35);
    if (this.hitSounds) this._slash(rating === 'perfect' ? 1 : 0.75);
    this.hudDirty = true;
  }

  /** Split the cube along the cut and throw the halves apart, spinning the way the blade went. */
  _shatter(n, normalW, pointW, swingW, hex) {
    const m = n.mesh;
    m.updateMatrixWorld();
    const q = m.getWorldQuaternion(new THREE.Quaternion()), qi = q.clone().invert();
    const nl = normalW.clone().applyQuaternion(qi).normalize();
    const pl = pointW.clone().applyMatrix4(tmpM.copy(m.matrixWorld).invert());
    let d = pl.dot(nl);
    d = Math.max(-CUBE * 0.35, Math.min(CUBE * 0.35, d)); // always leave two real pieces
    const halves = splitBox(CUBE / 2, nl, d);
    const col = new THREE.Color(hex);
    halves.forEach((h, k) => {
      const piece = this.debris[this.debrisNext = (this.debrisNext + 1) % this.debris.length];
      piece.geometry.dispose(); piece.geometry = h.geo;
      piece.position.copy(h.centroid).applyQuaternion(q).add(m.position);
      piece.quaternion.copy(q);
      const u = piece.userData, side = k === 0 ? 1 : -1;
      u.outer.color.copy(col).multiplyScalar(0.55); u.outer.emissive.copy(col); u.outer.opacity = 1; u.capM.opacity = 1;
      u.capM.color.copy(col).lerp(new THREE.Color(0xffffff), 0.6);
      u.vel.set(0, 0.4, Math.min(1.5, this.speed() * 0.1)).addScaledVector(normalW, side * 1.6).addScaledVector(swingW, 1.6);
      u.spin.copy(normalW.clone().cross(swingW)).multiplyScalar(side * 7).add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5));
      u.life = 1.1; piece.visible = true;
    });
    this._burst(m.position, hex, 26, 1.8);
  }

  _miss(n, p) {
    this.run.combo = 0; this.run.misses++;
    this._pop('miss', p || new THREE.Vector3(n.home.x, n.home.y, BEAT_Z + 0.4));
    this.hurtT = 0.15;
    this.energy((ENERGY[this.style] || ENERGY.saber).miss);
    this.hudDirty = true;
  }

  _mineHit(n, g) {
    this.run.combo = 0; this.run.mines++;
    this._burst(n.mesh.position, 0xff2244, 50, 3);
    this._burst(n.mesh.position, 0xffb347, 30, 2);
    this._pop('mine', n.mesh.position);
    this._haptic(g, 1, 220);
    this.hurtT = 0.35;
    if (this.hitSounds) this._boom();
    this.energy(ENERGY.saber.mine);
    this.hudDirty = true;
  }

  /* ================= desktop controls ================= */
  desktopAim(ndcX, ndcY) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const p = v3();
    this.desktop.ray = ray.ray.clone();
    if (ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -this.hitZ()), p)) this.desktop.aim.copy(p);
  }
  /** Mouse click during a song (pistols fire). */
  desktopFire() { if (this.sx && this.sx.fire && this.mode === 'play' && !this.paused) this.sx.desktopFire(); }

  /* ================= fx ================= */
  _haptic(g, intensity, ms) {
    try { const h = g.src && g.src.gamepad && g.src.gamepad.hapticActuators && g.src.gamepad.hapticActuators[0]; if (h) h.pulse(intensity, ms); } catch { /* ignore */ }
  }
  _noise() {
    if (this._nb) return this._nb;
    const b = this.ac.createBuffer(1, this.ac.sampleRate * 0.3, this.ac.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return (this._nb = b);
  }
  _slash(v) {
    try {
      this.ac = this.ac || new AudioContext();
      const t = this.ac.currentTime, src = this.ac.createBufferSource(), f = this.ac.createBiquadFilter(), g = this.ac.createGain();
      src.buffer = this._noise(); f.type = 'bandpass'; f.Q.value = 2;
      f.frequency.setValueAtTime(3200 * v, t); f.frequency.exponentialRampToValueAtTime(700, t + 0.12);
      g.gain.setValueAtTime(0.22, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
      src.connect(f).connect(g).connect(this.ac.destination); src.start(t); src.stop(t + 0.16);
    } catch { /* ignore */ }
  }
  _boom() {
    try {
      this.ac = this.ac || new AudioContext();
      const t = this.ac.currentTime, o = this.ac.createOscillator(), g = this.ac.createGain();
      o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(35, t + 0.25);
      g.gain.setValueAtTime(0.35, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      o.connect(g).connect(this.ac.destination); o.start(t); o.stop(t + 0.32);
    } catch { /* ignore */ }
  }
  _burst(p, hex, count, speed) {
    const c = new THREE.Color(hex);
    for (let k = 0; k < count; k++) {
      const i = this.pNext = (this.pNext + 1) % this.PN;
      this.pPos.set([p.x, p.y, p.z], i * 3);
      const d = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.4 + Math.random()));
      this.pVel.set([d.x, d.y, d.z], i * 3);
      this.pCol.set([c.r, c.g, c.b], i * 3);
      this.pLife[i] = 0.6;
    }
  }
  _pop(kind, p) {
    const s = this.pops[this.popNext = (this.popNext + 1) % this.pops.length];
    s.material.map = this.popTex[kind]; s.material.needsUpdate = true;
    s.position.set(p.x, p.y + 0.25, p.z); s.visible = true; s.userData.life = 0.6;
    const wide = kind === 'bad' || kind === 'color';
    s.scale.set(wide ? 0.5 : 0.4, 0.1, 1);
  }
  _updateFx(dt) {
    for (let i = 0; i < this.PN; i++) {
      if (this.pLife[i] <= 0) continue;
      this.pLife[i] -= dt;
      for (let a = 0; a < 3; a++) this.pPos[i * 3 + a] += this.pVel[i * 3 + a] * dt;
      this.pVel[i * 3 + 1] -= 3 * dt;
      if (this.pLife[i] <= 0) this.pPos[i * 3 + 1] = -100;
      for (let a = 0; a < 3; a++) this.pCol[i * 3 + a] *= 0.975;
    }
    this.particles.geometry.attributes.position.needsUpdate = true;
    this.particles.geometry.attributes.color.needsUpdate = true;
    for (const piece of this.debris) {
      if (!piece.visible) continue;
      const u = piece.userData;
      u.life -= dt;
      u.vel.y -= 6 * dt;
      piece.position.addScaledVector(u.vel, dt);
      if (piece.position.y < 0.05) { piece.position.y = 0.05; u.vel.y *= -0.3; u.vel.x *= 0.7; u.vel.z *= 0.7; u.spin.multiplyScalar(0.6); }
      const ang = u.spin.length();
      if (ang > 1e-4) piece.quaternion.premultiply(this._q.setFromAxisAngle(tmpV.copy(u.spin).divideScalar(ang), ang * dt));
      const f = Math.min(1, u.life / 0.45);
      u.outer.opacity = f; u.capM.opacity = f;
      if (u.life <= 0) piece.visible = false;
    }
    for (const s of this.pops) {
      if (!s.visible) continue;
      s.userData.life -= dt; s.position.y += dt * 0.3;
      s.material.opacity = Math.min(1, s.userData.life * 3);
      if (s.userData.life <= 0) s.visible = false;
    }
    this.hurtT = Math.max(0, (this.hurtT || 0) - dt);
    this.hurt.material.opacity = this.hurtT * 1.2;
  }

  _updateWorld(dt, pos) {
    const spb = 60000 / this.tempo.bpm;
    const phase = ((((pos - this.tempo.offsetMs) % spb) + spb) % spb) / spb;
    const live = this.mode === 'play' && this.player && this.player.playing;
    const beat = live ? Math.exp(-phase * 5) : 0.15 + 0.1 * Math.sin(performance.now() / 600);
    const sec = live ? sectionAt(this.sections, pos) : null;
    const hot = !!sec && sec.energy >= 0.8, calm = !!sec && sec.energy < 0.4;
    this._applyPalette(hot ? 'chorus' : calm ? 'calm' : 'normal');
    const run = live ? this.speed() : 1.5;
    this.scroll = (this.scroll || 0) + dt * run * this.tscale;
    this.dashes.forEach((m, i) => { m.position.z = 1.2 - (((i * 1.1 - this.scroll) % 44) + 44) % 44; m.material.opacity = 0.25 + beat * 0.5; });
    this.rings.forEach((ring, i) => {
      ring.position.z = -(((i * 2.4 - this.scroll * 0.4) % 52.8) + 52.8) % 52.8 - 3;
      ring.scale.setScalar(1 + beat * (hot ? 0.12 : 0.06));
      ring.material.opacity = 0.2 + beat * 0.5;
    });
    this.rails.forEach((r) => (r.material.opacity = 0.45 + beat * 0.55));
    this.beatLine.material.opacity = 0.15 + beat * 0.3;
    this.trackGroup.visible = true;
    this.scene.fog.color.lerp(this.targetFog, Math.min(1, dt * 6));
    if (this.style === 'still' && this.mode === 'play') { // frozen time: the world drains to a pale, quiet grey
      const still = Math.max(0, Math.min(1, (1 - this.tscale) / 0.85));
      this.scene.fog.color.lerp(STILL_FOG, still * 0.8);
    }
    this.scene.background.copy(this.scene.fog.color);
    this.hud.visible = this.mode === 'play';
  }

  _drawHud(pos) {
    this.hudLast = performance.now(); this.hudDirty = false;
    const g = this.hudCanvas.getContext('2d'), W = 1024, H = 300;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(10,4,24,0.75)'; g.beginPath(); g.roundRect(4, 4, W - 8, H - 8, 28); g.fill();
    g.strokeStyle = 'rgba(0,229,255,0.5)'; g.lineWidth = 3; g.stroke();
    const f = (w, s) => `${w} ${s}px system-ui, -apple-system, sans-serif`;
    g.textBaseline = 'top'; g.textAlign = 'left';
    g.fillStyle = '#fff'; g.font = f(800, 64); g.fillText(this.run.score.toLocaleString(), 32, 22);
    g.fillStyle = 'rgba(255,255,255,0.6)'; g.font = f(600, 22); g.fillText('SCORE', 36, 92);
    g.textAlign = 'right';
    g.fillStyle = '#ffe14d'; g.font = f(800, 64); g.fillText(`${this.run.combo}`, W - 32, 22);
    g.fillStyle = 'rgba(255,255,255,0.6)'; g.font = f(600, 22); g.fillText(`COMBO  ×${this.multiplier()}`, W - 36, 92);
    // progress to the next multiplier
    const mx = 32, my = 132, mw = W - 64, mh = 30;
    const k = this.multiplier() >= 8 ? 1 : (this.run.combo % 8) / 8;
    g.fillStyle = 'rgba(255,255,255,0.12)'; g.beginPath(); g.roundRect(mx, my, mw, mh, 15); g.fill();
    const grad = g.createLinearGradient(mx, 0, mx + mw, 0); grad.addColorStop(0, '#ff2d6f'); grad.addColorStop(1, '#00e5ff');
    g.fillStyle = grad; g.beginPath(); g.roundRect(mx, my, Math.max(mh, mw * k), mh, 15); g.fill();
    const acc = this.run.hits + this.run.misses ? Math.round((100 * this.run.hits) / (this.run.hits + this.run.misses)) : 100;
    g.textAlign = 'center'; g.fillStyle = '#fff'; g.font = f(700, 20);
    const extra = this.guns ? `${this.run.bullets ? ` · shot ${this.run.bullets}×` : ''}${this.run.whips ? ` · whips ${this.run.whips}` : ''}` : `${this.run.mines ? ` · mines hit ${this.run.mines}` : ''}`;
    g.fillText(`${acc}% · ${{ saber: 'SLICE', ride: 'RIDE', shoot: 'SHOOT', still: 'STILL' }[this.style]} ${this.difficulty.toUpperCase()}${this.modMult !== 1 ? ` ×${this.modMult}` : ''}${extra}${this.run.walls ? ` · walls ${this.run.walls}` : ''}`, W / 2, my + 5);
    g.textAlign = 'left'; g.fillStyle = '#fff'; g.font = f(700, 26);
    const name = this.track ? `${this.track.name} · ${this.track.artist}` : '';
    g.fillText(name.length > 58 ? name.slice(0, 57) + '…' : name, 32, 180);
    g.fillStyle = 'rgba(255,255,255,0.6)'; g.font = f(500, 22);
    const dur = this.track ? this.track.duration_ms : 0;
    const mmss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
    const cur = sectionAt(this.sections, pos);
    g.fillText(`${mmss(Math.max(0, pos))} / ${mmss(dur)}   ${Math.round(this.tempo.bpm)} BPM${this.tempo.source === 'default' ? ' (guess)' : this.tempo.source === 'lookup' ? ` (${this.tempo.from})` : ''}${cur ? `   ${cur.kind.toUpperCase()}` : ''}`, 32, 214);
    if (this.player && this.player.syncInfo) { g.save(); g.font = f(500, 18); g.fillStyle = 'rgba(255,255,255,0.55)'; g.fillText(this.player.syncInfo(), 32, 240); g.restore(); }
    g.fillStyle = 'rgba(255,255,255,0.15)'; g.fillRect(32, 250, W - 64, 6);
    g.fillStyle = '#00e5ff'; g.fillRect(32, 250, (W - 64) * Math.min(1, Math.max(0, pos / (dur || 1))), 6);
    for (const sct of this.sections) if (sct.energy >= 0.8) { g.fillStyle = 'rgba(255,225,77,0.55)'; g.fillRect(32 + (W - 64) * (sct.t0 / (dur || 1)), 246, (W - 64) * ((sct.t1 - sct.t0) / (dur || 1)), 3); }
    if (performance.now() < this.messageUntil) {
      g.textAlign = 'center'; g.fillStyle = '#00e5ff'; g.font = f(800, 26); g.fillText(this.message, W / 2, 264);
      this.hudDirty = true;
    }
    this.hudTex.needsUpdate = true;
  }

  onXrEnd() {
    for (const g of Object.values(this.sabers)) { g.src = null; g.tracked = false; g.kind = null; g.mesh.rotation.set(0, 0, 0); }
    this.wristBtn.visible = false;
    this.camera.position.set(0, 1.6, 0);
    this.calibrateHeight();
  }

  render() { this.r.render(this.scene, this.camera); }
}
