import * as THREE from 'three';

// Voxel enemies for SHOOT and STILL: each figure is ~300 small cubes (one InstancedMesh per enemy).
// They assemble out of flying cubes when they step out, armour cubes chip off when hit, and a kill
// breaks the figure apart: cubes near the hit are blasted along the shot (or swing, or throw), the
// rest lose their footing and collapse. Debris runs on the game's time, so in STILL it hangs in the
// air while you stand still.

export const VOX = 0.075;                // cube size (m)
const MAXV = 360;
const LIFE = 2.6;                        // seconds of debris before it's gone (shrinks over the last 0.5 s)
const GEO = new THREE.BoxGeometry(VOX * 0.94, VOX * 0.94, VOX * 0.94);

// parts: 0 body, 1 visor, 2 vest (armour), 3 helmet (armour), 4 gun
function buildTemplate(hp) {
  const v = [];
  const add = (x0, x1, y0, y1, z0, z1, part) => {
    for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) v.push({ x: (x + 0.5) * VOX, y: (y + 0.5) * VOX, z: (z + 0.5) * VOX, part });
  };
  add(-3, -1, 0, 11, -1, 1, 0);           // left leg
  add(1, 3, 0, 11, -1, 1, 0);             // right leg
  add(-1, 1, 9, 11, -1, 1, 0);            // hips
  for (let x = -3; x < 3; x++) for (let y = 11; y < 18; y++) for (let z = -1; z < 2; z++) { // torso; its shell is the vest
    const shell = (z !== 0 || x === -3 || x === 2) && y >= 12;
    v.push({ x: (x + 0.5) * VOX, y: (y + 0.5) * VOX, z: (z + 0.5) * VOX, part: hp >= 2 && shell ? 2 : 0 });
  }
  add(-4, -3, 11, 17, 0, 1, 0);           // left arm
  add(3, 4, 12, 17, 0, 1, 0);             // right upper arm
  add(3, 4, 13, 14, 1, 5, 0);             // right forearm, pointing at you
  add(3, 4, 14, 15, 3, 6, 4);             // its gun
  for (let x = -2; x < 2; x++) for (let y = 18; y < 22; y++) for (let z = -1; z < 2; z++) { // head; visor across the front
    v.push({ x: (x + 0.5) * VOX, y: (y + 0.5) * VOX, z: (z + 0.5) * VOX, part: z === 1 && y === 20 ? 1 : 0 });
  }
  if (hp >= 4) { add(-2, 2, 22, 23, -1, 2, 3); add(-3, -2, 19, 23, -1, 2, 3); add(2, 3, 19, 23, -1, 2, 3); } // helmet
  return v;
}
const TEMPLATES = { 1: buildTemplate(1), 2: buildTemplate(2), 4: buildTemplate(4) };

const LOOKS = {
  shoot: { body: 0x5c4c8e, visor: { 1: 0xff2244, 2: 0xff8a1f, 4: 0xffe14d }, vest: 0xff8a1f, helmet: 0xffe14d, gun: 0x16141c, emissive: 0x1c0c30 },
  still: { body: 0xe8202e, visor: { 1: 0xffffff, 2: 0xffffff, 4: 0xffffff }, vest: 0xff7a3c, helmet: 0xffd24d, gun: 0x2a0508, emissive: 0x4a0010 },
};

const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _c = new THREE.Color();
const _dq = new THREE.Quaternion(), _ax = new THREE.Vector3(), _inv = new THREE.Matrix4();

export class VoxelBody {
  constructor(parent) {
    this.parent = parent;
    this.mat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x000000, transparent: true });
    this.mesh = new THREE.InstancedMesh(GEO, this.mat, MAXV);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false; this.mesh.count = 0;
    parent.add(this.mesh);
    this.base = new Float32Array(MAXV * 3); this.off = new Float32Array(MAXV * 3);
    this.pos = new Float32Array(MAXV * 3); this.vel = new Float32Array(MAXV * 3);
    this.rot = new Float32Array(MAXV * 4); this.spin = new Float32Array(MAXV * 3);
    this.part = new Uint8Array(MAXV); this.state = new Uint8Array(MAXV); // 0 attached, 1 flying, 2 gone
    this.life = new Float32Array(MAXV);
    this.n = 0; this.t = 0; this.k = 1; this.broken = false; this.loose = 0;
  }

  /** Fresh figure for an enemy with this many hit points, in the SHOOT or STILL look. */
  build(hp, still) {
    const tpl = TEMPLATES[hp] || TEMPLATES[1], look = still ? LOOKS.still : LOOKS.shoot;
    this.n = Math.min(MAXV, tpl.length); this.mesh.count = this.n;
    this.mat.emissive.setHex(look.emissive); this.mat.opacity = 1;
    for (let i = 0; i < this.n; i++) {
      const v = tpl[i];
      this.base[i * 3] = v.x; this.base[i * 3 + 1] = v.y; this.base[i * 3 + 2] = v.z;
      const a = Math.random() * Math.PI * 2, r = 0.6 + Math.random() * 1.2; // where it flies in from
      this.off[i * 3] = Math.cos(a) * r; this.off[i * 3 + 1] = (Math.random() - 0.3) * 1.2; this.off[i * 3 + 2] = Math.sin(a) * r;
      this.part[i] = v.part; this.state[i] = 0;
      const col = v.part === 1 ? look.visor[hp] || look.visor[1] : v.part === 2 ? look.vest : v.part === 3 ? look.helmet : v.part === 4 ? look.gun : look.body;
      _c.setHex(col).multiplyScalar(0.88 + Math.random() * 0.2); // a little variation per cube
      this.mesh.setColorAt(i, _c);
    }
    this.mesh.instanceColor.needsUpdate = true;
    this.t = 0; this.k = -1; this.broken = false; this.loose = 0;
    this.assemble(0);
  }

  /** Entrance: cubes fly in to their places (k from 0 to 1). */
  assemble(k) {
    if (k >= 1 && this.k >= 1) return; // in place: attached cubes don't move
    this.k = k;
    const e = 1 - (1 - Math.min(1, k)) ** 3, sc = Math.min(1, 0.2 + k * 1.2);
    for (let i = 0; i < this.n; i++) {
      if (this.state[i]) continue;
      const stag = Math.min(1, Math.max(0, e * 1.3 - (i % 7) * 0.04)); // a slight stagger so it builds up
      _p.set(this.base[i * 3] + this.off[i * 3] * (1 - stag), this.base[i * 3 + 1] + this.off[i * 3 + 1] * (1 - stag), this.base[i * 3 + 2] + this.off[i * 3 + 2] * (1 - stag));
      _s.setScalar(sc); _m.compose(_p, _q.identity(), _s); this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  _toLocal(point, dir) {
    this.parent.updateMatrixWorld();
    const lp = this.parent.worldToLocal(point.clone());
    _inv.copy(this.parent.matrixWorld).invert();
    const ld = dir.clone().transformDirection(_inv);
    return { lp, ld, power: dir.length() };
  }

  _launch(i, lp, ld, power, falloff) {
    const x = this.base[i * 3], y = this.base[i * 3 + 1], z = this.base[i * 3 + 2];
    const dx = x - lp.x, dy = y - lp.y, dz = z - lp.z, d = Math.hypot(dx, dy, dz) || 1e-3;
    const w = Math.exp(-d / falloff);
    const r = () => (Math.random() - 0.5);
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    // along the hit, out from the hit point, a little up, a little random; far cubes barely move and just fall
    this.vel[i * 3] = ld.x * power * w * (0.6 + Math.random() * 0.8) + dx / d * power * 0.35 * w + r() * 0.5 + x * 0.8;
    this.vel[i * 3 + 1] = ld.y * power * w * 0.8 + dy / d * power * 0.3 * w + w * 1.2 + r() * 0.4;
    this.vel[i * 3 + 2] = ld.z * power * w * (0.6 + Math.random() * 0.8) + dz / d * power * 0.35 * w + r() * 0.5 + z * 0.8;
    this.rot[i * 4] = 0; this.rot[i * 4 + 1] = 0; this.rot[i * 4 + 2] = 0; this.rot[i * 4 + 3] = 1;
    const sp = 4 + w * 18;
    this.spin[i * 3] = r() * sp; this.spin[i * 3 + 1] = r() * sp; this.spin[i * 3 + 2] = r() * sp;
    this.state[i] = 1; this.life[i] = LIFE; this.loose++;
  }

  /** Armour hit: knock off the armour cubes nearest the hit (a few, or more if none are close). */
  chip(point, dir) {
    const { lp, ld, power } = this._toLocal(point, dir);
    const armour = [];
    for (let i = 0; i < this.n; i++) if (!this.state[i] && (this.part[i] === 2 || this.part[i] === 3)) {
      const d = Math.hypot(this.base[i * 3] - lp.x, this.base[i * 3 + 1] - lp.y, this.base[i * 3 + 2] - lp.z);
      armour.push([d, i]);
    }
    armour.sort((a, b) => a[0] - b[0]);
    const take = armour.filter(([d], k) => d < 0.16 || k < 14).slice(0, 26);
    for (const [, i] of take) this._launch(i, lp, ld, Math.max(3, power * 0.7), 0.2);
    return take.length;
  }

  /** Kill: everything comes apart. power ~4 (light) to ~12 (axe). */
  shatter(point, dir) {
    const { lp, ld, power } = this._toLocal(point, dir);
    for (let i = 0; i < this.n; i++) if (!this.state[i]) this._launch(i, lp, ld, power, 0.24);
    this.broken = true;
  }

  /** Move the loose cubes. Returns true once a broken figure has fully gone. */
  update(dt) {
    if (!this.loose) return this.broken;
    const g = 9.8 * dt, half = VOX * 0.47;
    for (let i = 0; i < this.n; i++) {
      if (this.state[i] !== 1) continue;
      const j = i * 3;
      this.vel[j + 1] -= g;
      this.pos[j] += this.vel[j] * dt; this.pos[j + 1] += this.vel[j + 1] * dt; this.pos[j + 2] += this.vel[j + 2] * dt;
      if (this.pos[j + 1] < half) { // bounce, slide, settle
        this.pos[j + 1] = half;
        this.vel[j + 1] = Math.abs(this.vel[j + 1]) > 0.6 ? -this.vel[j + 1] * 0.3 : 0;
        this.vel[j] *= 0.6; this.vel[j + 2] *= 0.6;
        this.spin[j] *= 0.5; this.spin[j + 1] *= 0.5; this.spin[j + 2] *= 0.5;
      }
      _q.set(this.rot[i * 4], this.rot[i * 4 + 1], this.rot[i * 4 + 2], this.rot[i * 4 + 3]);
      _ax.set(this.spin[j], this.spin[j + 1], this.spin[j + 2]);
      const ang = _ax.length();
      if (ang > 1e-3) { _dq.setFromAxisAngle(_ax.divideScalar(ang), ang * dt); _q.premultiply(_dq); }
      this.rot[i * 4] = _q.x; this.rot[i * 4 + 1] = _q.y; this.rot[i * 4 + 2] = _q.z; this.rot[i * 4 + 3] = _q.w;
      _p.set(this.pos[j], this.pos[j + 1], this.pos[j + 2]);
      this.life[i] -= dt;
      _s.setScalar(Math.max(0, Math.min(1, this.life[i] / 0.5))); // shrink away at the end
      if (this.life[i] <= 0) { this.state[i] = 2; this.loose--; _s.setScalar(0); }
      _m.compose(_p, _q, _s); this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    return this.broken && this.loose <= 0;
  }

  /** Where a cube is now (local), for tests. */
  flying() { let k = 0; for (let i = 0; i < this.n; i++) k += this.state[i] === 1; return k; }
}
