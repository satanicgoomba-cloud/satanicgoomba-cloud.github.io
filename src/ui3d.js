import * as THREE from 'three';

// Minimal in-world UI: canvas-textured panels with clickable rects, driven by
// controller laser pointers in VR (trigger = click, thumbstick = scroll)
// or by the mouse on a flat screen.

export const FONT = (w, s) => `${w} ${s}px system-ui, -apple-system, "Segoe UI", sans-serif`;
export const C = { bg: 'rgba(16,7,34,0.9)', line: 'rgba(255,255,255,0.14)', text: '#f4f0ff', muted: 'rgba(244,240,255,0.6)', pink: '#ff2d6f', cyan: '#00e5ff', gold: '#ffe14d' };

export function rr(g, x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, r); }
export function fitText(g, text, maxW) {
  text = String(text || '');
  if (g.measureText(text).width <= maxW) return text;
  while (text.length > 1 && g.measureText(text + '…').width > maxW) text = text.slice(0, -1);
  return text + '…';
}

export class Panel {
  constructor(name, w, h, ppm = 600) {
    this.name = name; this.w = w; this.h = h;
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(w * ppm); this.canvas.height = Math.round(h * ppm);
    this.W = this.canvas.width; this.H = this.canvas.height;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, fog: false, depthWrite: false, depthTest: false }));
    this.mesh.userData.panel = this;
    this.mesh.renderOrder = 8; // UI draws over the arena
    this.buttons = []; this.hover = null; this.draw = null; this.onClick = null; this.onScroll = null;
  }
  set visible(v) { this.mesh.visible = v; }
  get visible() { return this.mesh.visible; }

  redraw() {
    const g = this.canvas.getContext('2d');
    g.clearRect(0, 0, this.W, this.H);
    this.buttons = [];
    rr(g, 3, 3, this.W - 6, this.H - 6, 30); g.fillStyle = C.bg; g.fill();
    g.strokeStyle = C.line; g.lineWidth = 3; g.stroke();
    if (this.draw) this.draw(g, this);
    this.tex.needsUpdate = true;
  }

  /** Register + draw a button. style: 'primary' | 'ghost' | 'tab' | 'row'. Returns true if hovered. */
  button(id, x, y, w, h, label, { style = 'ghost', selected = false, size = 26, color } = {}) {
    const g = this.canvas.getContext('2d');
    const hov = this.hover === id;
    this.buttons.push({ id, x, y, w, h });
    if (style === 'row') return hov;
    const fill = style === 'primary' ? (color || C.pink) : selected ? 'rgba(0,229,255,0.25)' : hov ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.07)';
    rr(g, x, y, w, h, Math.min(18, h / 2)); g.fillStyle = fill; g.fill();
    if (selected || hov) { g.strokeStyle = selected ? C.cyan : 'rgba(255,255,255,0.5)'; g.lineWidth = 3; g.stroke(); }
    if (style === 'primary' && hov) { g.strokeStyle = '#fff'; g.lineWidth = 4; g.stroke(); }
    g.fillStyle = style === 'primary' ? '#14051f' : C.text; g.font = FONT(800, size);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(fitText(g, label, w - 16), x + w / 2, y + h / 2 + 1);
    return hov;
  }

  hitAt(uv) {
    const px = uv.x * this.W, py = (1 - uv.y) * this.H;
    for (let i = this.buttons.length - 1; i >= 0; i--) {
      const b = this.buttons[i];
      if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return b.id;
    }
    return null;
  }

  setHover(id) { if (id !== this.hover) { this.hover = id; this.redraw(); return true; } return false; }
}

/** Place a panel on an arc around the player. az: degrees, positive = to the left. */
export function placeOnArc(mesh, azDeg, dist, y) {
  const a = THREE.MathUtils.degToRad(azDeg);
  mesh.position.set(-Math.sin(a) * dist, y, -Math.cos(a) * dist);
  mesh.lookAt(0, y, 0);
}

export class Pointers {
  constructor(renderer, scene, camera, rig) {
    this.r = renderer; this.camera = camera;
    this.panels = [];
    this.enabled = true;
    this.ray = new THREE.Raycaster();
    this.mouse = null; // NDC on desktop
    this.ctrls = [];
    const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
    for (let i = 0; i < 2; i++) {
      const c = renderer.xr.getController(i);
      const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: i ? 0x00e5ff : 0xff2d6f, transparent: true, opacity: 0.85 }));
      line.scale.z = 3; c.add(line);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.012, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
      dot.renderOrder = 9; dot.visible = false; scene.add(dot);
      const st = { c, line, dot, src: null, hit: null };
      c.addEventListener('connected', (e) => { st.src = e.data; line.material.color.setHex(e.data.handedness === 'left' ? 0xff2d6f : 0x00e5ff); });
      c.addEventListener('disconnected', () => { st.src = null; });
      c.addEventListener('selectstart', () => { if (this.enabled) this._click(st.hit, st); });
      rig.add(c);
      this.ctrls.push(st);
    }
    this._tmp = new THREE.Matrix4();
  }

  _cast(origin, dir) {
    this.ray.set(origin, dir);
    const meshes = this.panels.filter((p) => p.visible).map((p) => p.mesh);
    const hit = this.ray.intersectObjects(meshes, false)[0];
    if (!hit) return null;
    const panel = hit.object.userData.panel;
    return { panel, id: panel.hitAt(hit.uv), point: hit.point, distance: hit.distance };
  }

  _click(hit, st) {
    if (!hit || !hit.id || !hit.panel.onClick) return;
    try { const h = st && st.src && st.src.gamepad && st.src.gamepad.hapticActuators && st.src.gamepad.hapticActuators[0]; if (h) h.pulse(0.5, 30); } catch { /* ignore */ }
    hit.panel.onClick(hit.id);
  }

  desktopMove(ndcX, ndcY) { this.mouse = new THREE.Vector2(ndcX, ndcY); }
  desktopClick() { if (this.enabled && this.desktopHit) { this._click(this.desktopHit); return !!this.desktopHit.id; } return false; }
  desktopWheel(dy) {
    if (!this.enabled || !this.desktopHit) return;
    const p = this.desktopHit.panel; if (p.onScroll) p.onScroll(dy);
  }

  update(dt) {
    const xr = this.r.xr.isPresenting;
    const hovers = new Map();
    for (const st of this.ctrls) {
      st.line.visible = xr && this.enabled;
      st.dot.visible = false; st.hit = null;
      if (!xr || !this.enabled || !st.src) continue;
      this._tmp.identity().extractRotation(st.c.matrixWorld);
      const o = new THREE.Vector3().setFromMatrixPosition(st.c.matrixWorld);
      const d = new THREE.Vector3(0, 0, -1).applyMatrix4(this._tmp);
      const hit = this._cast(o, d);
      st.hit = hit;
      st.line.scale.z = hit ? hit.distance : 3;
      if (hit) {
        st.dot.visible = true; st.dot.position.copy(hit.point);
        if (hit.id) hovers.set(hit.panel, hit.id);
        if (hit.id && hit.id !== st.lastId) { try { st.src.gamepad.hapticActuators[0].pulse(0.15, 10); } catch { /* ignore */ } }
        st.lastId = hit.id;
        // thumbstick scroll
        const ax = st.src.gamepad && st.src.gamepad.axes;
        if (ax && Math.abs(ax[3] || 0) > 0.35 && hit.panel.onScroll) hit.panel.onScroll((ax[3] > 0 ? 1 : -1) * dt * 8);
      }
    }
    this.desktopHit = null;
    if (!xr && this.enabled && this.mouse) {
      this.ray.setFromCamera(this.mouse, this.camera);
      const hit = this._cast(this.ray.ray.origin, this.ray.ray.direction);
      this.desktopHit = hit;
      if (hit && hit.id) hovers.set(hit.panel, hit.id);
    }
    for (const p of this.panels) if (p.visible) p.setHover(hovers.get(p) || null);
  }
}
