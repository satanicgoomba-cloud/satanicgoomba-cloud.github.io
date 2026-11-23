import * as THREE from 'three';

// "Screen shatter" transition: snapshot what the player sees, put it on a pane of glass
// right in front of their eyes, crack it, then blow the shards outward to reveal the
// (re-coloured) world behind. Works on desktop and in WebXR (snapshot from the left eye).

const D = 0.32; // metres in front of the eye

export class Shatter {
  constructor(renderer, scene, camera) {
    this.r = renderer; this.scene = scene; this.camera = camera;
    this.rt = new THREE.WebGLRenderTarget(1024, 1024);
    this.rt.texture.colorSpace = THREE.SRGBColorSpace;
    this.group = new THREE.Group(); this.group.visible = false; this.group.renderOrder = 20;
    camera.add(this.group);
    this.mat = new THREE.MeshBasicMaterial({ map: this.rt.texture, transparent: true, side: THREE.DoubleSide, depthTest: false, depthWrite: false, fog: false });
    this.edgeMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, depthTest: false, blending: THREE.AdditiveBlending, fog: false });
    this.flash = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthTest: false, depthWrite: false, fog: false }));
    this.flash.position.z = -D + 0.01; this.flash.renderOrder = 21; camera.add(this.flash);
    this.t = -1; this.shards = [];
  }

  get active() { return this.t >= 0; }

  _snapshot() {
    const xr = this.r.xr;
    const cam = new THREE.PerspectiveCamera();
    cam.matrixAutoUpdate = false;
    let tanH, tanV;
    if (xr.isPresenting) {
      const eye = xr.getCamera().cameras[0];
      cam.matrixWorld.copy(eye.matrixWorld);
      cam.projectionMatrix.copy(eye.projectionMatrix);
      cam.projectionMatrixInverse.copy(eye.projectionMatrixInverse);
      const e = eye.projectionMatrix.elements;
      tanH = 1 / e[0]; tanV = 1 / e[5];
    } else {
      this.camera.updateMatrixWorld();
      cam.matrixWorld.copy(this.camera.matrixWorld);
      cam.projectionMatrix.copy(this.camera.projectionMatrix);
      cam.projectionMatrixInverse.copy(this.camera.projectionMatrixInverse);
      tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)); tanH = tanV * this.camera.aspect;
    }
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    const prevTarget = this.r.getRenderTarget(), prevXr = xr.enabled;
    xr.enabled = false;
    this.r.setRenderTarget(this.rt);
    this.r.clear();
    this.r.render(this.scene, cam);
    this.r.setRenderTarget(prevTarget);
    xr.enabled = prevXr;
    return { w: tanH * D, h: tanV * D }; // half-extents of the pane
  }

  trigger() {
    this.clear();
    const { w, h } = this._snapshot();
    const rings = [0.1, 0.26, 0.48, 0.74, 1.05, 1.5];
    const sectors = 11;
    const pts = rings.map((rad, k) => Array.from({ length: sectors }, (_, j) => {
      const a = ((j + (k % 2 ? 0.5 : 0) + (Math.random() - 0.5) * 0.5) / sectors) * Math.PI * 2;
      const rr = rad * (1 + (Math.random() - 0.5) * 0.25);
      return new THREE.Vector2(Math.cos(a) * rr * 1.2, Math.sin(a) * rr);
    }));
    const tris = [];
    const c = new THREE.Vector2(0.03, -0.02);
    for (let j = 0; j < sectors; j++) tris.push([c, pts[0][j], pts[0][(j + 1) % sectors]]);
    for (let k = 0; k < rings.length - 1; k++) {
      for (let j = 0; j < sectors; j++) {
        const a = pts[k][j], b = pts[k][(j + 1) % sectors], cc = pts[k + 1][j], d = pts[k + 1][(j + 1) % sectors];
        tris.push([a, cc, d], [a, d, b]);
      }
    }
    const edges = [];
    for (const tri of tris) {
      const cen = new THREE.Vector2().add(tri[0]).add(tri[1]).add(tri[2]).divideScalar(3);
      if (Math.abs(cen.x) > 1.6 || Math.abs(cen.y) > 1.4) continue;
      const pos = [], uv = [];
      for (const p of tri) {
        pos.push((p.x - cen.x) * w, (p.y - cen.y) * h, 0);
        uv.push((p.x + 1) / 2, (p.y + 1) / 2);
        edges.push(p.x * w, p.y * h, -D + 0.002);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      const m = new THREE.Mesh(g, this.mat);
      m.position.set(cen.x * w, cen.y * h, -D);
      m.renderOrder = 20;
      const out = cen.clone().normalize();
      const speed = (0.35 + Math.random() * 0.5) * (1.6 - Math.min(1.2, cen.length()) * 0.5);
      m.userData.v = new THREE.Vector3(out.x * speed, out.y * speed + 0.1, 0.15 + Math.random() * 0.35);
      m.userData.spin = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(14);
      this.group.add(m); this.shards.push(m);
    }
    // crack lines: triangle outlines
    const lp = [];
    for (let i = 0; i < edges.length; i += 9) {
      const p = edges.slice(i, i + 9);
      lp.push(p[0], p[1], p[2], p[3], p[4], p[5], p[3], p[4], p[5], p[6], p[7], p[8]);
    }
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    this.lines = new THREE.LineSegments(lg, this.edgeMat); this.lines.renderOrder = 22;
    this.group.add(this.lines);
    this.mat.opacity = 1; this.edgeMat.opacity = 1;
    this.group.visible = true; this.t = 0;
  }

  update(dt) {
    if (this.t < 0) return;
    this.t += dt;
    const HOLD = 0.14, FLY = 0.9;
    this.flash.material.opacity = this.t < 0.06 ? 0.7 : Math.max(0, 0.7 - (this.t - 0.06) * 6);
    if (this.t > HOLD) {
      const k = this.t - HOLD;
      for (const s of this.shards) {
        s.position.addScaledVector(s.userData.v, dt);
        s.userData.v.y -= 0.9 * dt;
        s.rotation.x += s.userData.spin.x * dt; s.rotation.y += s.userData.spin.y * dt; s.rotation.z += s.userData.spin.z * dt * 0.4;
      }
      this.mat.opacity = Math.max(0, 1 - k / FLY);
      this.edgeMat.opacity = Math.max(0, 1 - k * 5);
      if (k > FLY) this.clear();
    }
  }

  clear() {
    for (const s of this.shards) { s.geometry.dispose(); this.group.remove(s); }
    if (this.lines) { this.lines.geometry.dispose(); this.group.remove(this.lines); this.lines = null; }
    this.shards = []; this.group.visible = false; this.t = -1; this.flash.material.opacity = 0;
  }
}
