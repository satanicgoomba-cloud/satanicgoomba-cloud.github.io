import * as THREE from 'three';
import { generate, getDrops } from './beatmap.js?v=mwtlucqd';
import { Shatter } from './shatter.js?v=mwtlucqd';

const LEAD_S = 1.7;          // seconds a missile is visible before its beat
const FAR_SPEED = 10;        // m/s while flying in
const NEAR_SPEED = 2.2;      // m/s in the last 0.25 s (gives a punchable window)
const NEAR_S = 0.25;
const REACH = 0.55;          // metres from the chest where a missile should be punched
const WINDOW_S = 0.2;        // timing window either side of the beat
const FOCUS_WINDOW_S = 0.26;
const MIN_PUNCH = 1.1;       // m/s toward the missile to count as a punch
const COLORS = { L: 0xff2d6f, R: 0x00e5ff };
const PALETTES = {
  normal: { fog: 0x07030f, rings: [0x00e5ff, 0xff2d6f] },
  build: { fog: 0x1a0308, rings: [0xff5a1f, 0xff2d6f] },
  drop: { fog: 0x0d0f2e, rings: [0xffe14d, 0xffffff] },
  focus: { fog: 0x120840, rings: [0x8a5cff, 0x00e5ff] },
};

const v3 = () => new THREE.Vector3();
function dirFrom(az, el) {
  const a = THREE.MathUtils.degToRad(az), e = THREE.MathUtils.degToRad(el);
  return new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
}

export class Game {
  constructor(renderer, hooks = {}) {
    this.r = renderer;
    this.hooks = hooks;              // onTap, onPause, onMarkDrop
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x07030f);
    this.scene.fog = new THREE.Fog(0x07030f, 7, 32);
    this.camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 100);
    this.camera.position.set(0, 1.6, 0);
    this.camera.rotation.x = -0.1; // desktop: look slightly down (XR overrides)
    this.rig = new THREE.Group();
    this.rig.add(this.camera);
    this.scene.add(this.rig);
    this.mode = 'menu';              // 'menu' | 'play'
    this.player = null; this.track = null;
    this.tempo = { bpm: 120, offsetMs: 0 }; this.difficulty = 'normal';
    this.notes = []; this.nextNote = 0; this.active = []; this.drops = [];
    this.headY = 1.6;
    this.hitSounds = true;
    this.latencyMs = 0;
    this.spread = 1;                 // 1 in VR, smaller on a flat screen
    this.desktop = { aim: new THREE.Vector3(0, 1.3, -REACH), punch: { L: -1, R: -1 }, target: { L: null, R: null }, charge: false };
    this.palette = 'normal';
    this._buildWorld();
    this._buildGloves();
    this._buildPools();
    this._buildSwarm();
    this._buildHud();
    this.shatter = new Shatter(renderer, this.scene, this.camera);
    this.resetRun();
  }

  /* ================= world ================= */
  _buildWorld() {
    const s = this.scene;
    s.add(new THREE.HemisphereLight(0x8866ff, 0x110022, 1.3));
    const dl = new THREE.DirectionalLight(0xffffff, 1.4); dl.position.set(1, 3, 2); s.add(dl);
    const grid = new THREE.GridHelper(80, 80, 0xff2d6f, 0x2a1050);
    grid.position.z = -20; s.add(grid);
    // boxing-ring ropes around the player
    this.ropes = [];
    for (let i = 0; i < 3; i++) {
      const rope = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.012, 6, 64), new THREE.MeshBasicMaterial({ color: 0xff2d6f, transparent: true, opacity: 0.5 }));
      rope.rotation.x = Math.PI / 2; rope.position.y = 0.55 + i * 0.35; s.add(rope); this.ropes.push(rope);
    }
    // ring tunnel that pulses on the beat
    this.rings = [];
    const ringGeo = new THREE.TorusGeometry(4.2, 0.035, 8, 72);
    for (let i = 0; i < 24; i++) {
      const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }));
      ring.position.y = 1.6; this.rings.push(ring); s.add(ring);
    }
    this.vignette = new THREE.Mesh(new THREE.SphereGeometry(0.4, 24, 16), new THREE.MeshBasicMaterial({ color: 0x3a00ff, side: THREE.BackSide, transparent: true, opacity: 0, depthWrite: false, depthTest: false, fog: false }));
    this.vignette.renderOrder = 10; this.camera.add(this.vignette);
    this.shock = new THREE.Mesh(new THREE.TorusGeometry(1, 0.08, 12, 64), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 }));
    s.add(this.shock); this.shockT = -1;
    this._applyPalette('normal', true);
  }

  _applyPalette(name, force) {
    if (this.palette === name && !force) return;
    this.palette = name;
    const p = PALETTES[name];
    this.rings.forEach((r, i) => r.material.color.setHex(p.rings[i % 2]));
    this.targetFog = new THREE.Color(p.fog);
  }

  _gloveMesh(hand) {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: COLORS[hand], emissive: COLORS[hand], emissiveIntensity: 0.35, roughness: 0.4 });
    const fist = new THREE.Mesh(new THREE.SphereGeometry(0.07, 24, 16), mat);
    fist.scale.set(1, 0.9, 1.2);
    const thumb = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 8), mat);
    thumb.position.set(hand === 'L' ? 0.05 : -0.05, -0.01, -0.02);
    const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.08, 16), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }));
    cuff.rotation.x = Math.PI / 2; cuff.position.z = 0.09;
    g.add(fist, thumb, cuff);
    g.userData.mat = mat;
    return g;
  }

  _buildGloves() {
    // Gloves follow whatever the Quest is tracking: Touch controllers (grip pose) or bare hands
    // (hand-tracking joints). Poses are read straight from the XRFrame every frame (see _trackXr),
    // because three.js only moves controller "grip" objects for controllers, not for hands.
    this.gloves = {};
    for (const hand of ['L', 'R']) {
      const mesh = this._gloveMesh(hand);
      this.gloves[hand] = { hand, mesh, pos: v3(), prev: v3(), vel: v3(), src: null, tracked: false, kind: null };
      this.scene.add(mesh);
    }
    // Wrist pause button on the back of the left glove: turn it toward you and tap it with the right glove.
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(16,7,34,0.85)'; g.beginPath(); g.arc(64, 64, 60, 0, Math.PI * 2); g.fill();
    g.lineWidth = 6; g.strokeStyle = '#ffe14d'; g.stroke();
    g.fillStyle = '#ffe14d'; g.fillRect(40, 36, 16, 56); g.fillRect(72, 36, 16, 56);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    this.wristBtn = new THREE.Mesh(new THREE.CircleGeometry(0.035, 32), new THREE.MeshBasicMaterial({ map: tex, transparent: true, fog: false, depthTest: false }));
    this.wristBtn.renderOrder = 9;
    this.wristBtn.position.set(0, 0.075, 0.1); // back of the left wrist, above the cuff
    this.wristBtn.rotation.x = -Math.PI / 2;  // faces up out of the back of the glove
    this.wristBtn.visible = false;
    this.gloves.L.mesh.add(this.wristBtn);
    this._wristHold = 0;
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3();
  }

  /** Pose of one input source in world space (controllers: grip; hands: knuckles, aimed along the hand). */
  _trackXr(g, src, frame, ref) {
    let pose = null;
    if (src.hand) {
      const j = (n) => src.hand.get(n);
      const knuckle = frame.getJointPose && frame.getJointPose(j('middle-finger-phalanx-proximal'), ref);
      const meta = frame.getJointPose && frame.getJointPose(j('middle-finger-metacarpal'), ref);
      if (knuckle && meta) {
        // position: the knuckles (what you punch with); orientation: along the back of the hand
        const p = knuckle.transform.position, o = meta.transform.orientation;
        this._m.compose(this._s.set(p.x, p.y, p.z), this._q.set(o.x, o.y, o.z, o.w), new THREE.Vector3(1, 1, 1));
        g.kind = 'hand'; pose = true;
      }
    } else if (src.gripSpace) {
      const gp = frame.getPose(src.gripSpace, ref);
      if (gp) { this._m.fromArray(gp.transform.matrix); g.kind = 'controller'; pose = true; }
    }
    if (!pose) return false;
    this.rig.updateMatrixWorld();
    this._m.premultiply(this.rig.matrixWorld);
    this._m.decompose(g.mesh.position, g.mesh.quaternion, this._s);
    g.mesh.scale.setScalar(g.kind === 'hand' ? 0.85 : 1);
    // the punching surface is the front of the fist
    g.pos.set(0, 0, g.kind === 'hand' ? 0.01 : -0.03).applyMatrix4(g.mesh.matrix.compose(g.mesh.position, g.mesh.quaternion, g.mesh.scale));
    return true;
  }

  _missileMesh() {
    // Nose points along local +z (Object3D.lookAt aims +z at the target).
    const g = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x3a3f4d, metalness: 0.6, roughness: 0.35, transparent: true });
    const bandMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.2, transparent: true });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.26, 16), bodyMat); body.rotation.x = Math.PI / 2;
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.13, 16), bandMat); nose.rotation.x = Math.PI / 2; nose.position.z = 0.195;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.058, 0.04, 16), bandMat); band.rotation.x = Math.PI / 2; band.position.z = 0.04;
    g.add(body, nose, band);
    const finGeo = new THREE.BoxGeometry(0.006, 0.08, 0.07);
    for (let k = 0; k < 4; k++) {
      const fin = new THREE.Mesh(finGeo, bandMat);
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      fin.position.set(Math.cos(a) * 0.07, Math.sin(a) * 0.07, -0.1); fin.rotation.z = a + Math.PI / 2;
      g.add(fin);
    }
    const flameMat = new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.24, 12, 1, true), flameMat); flame.rotation.x = -Math.PI / 2; flame.position.z = -0.25;
    g.add(flame);
    g.userData = { bodyMat, bandMat, flameMat, flame };
    return g;
  }

  _buildPools() {
    this.pool = [];
    const ringGeo = new THREE.RingGeometry(0.15, 0.17, 40);
    for (let i = 0; i < 48; i++) {
      const m = this._missileMesh(); m.visible = false; this.scene.add(m);
      const cue = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
      cue.visible = false; this.scene.add(cue);
      m.userData.cue = cue; this.pool.push(m);
    }
    this.PN = 1200;
    const geo = new THREE.BufferGeometry();
    this.pPos = new Float32Array(this.PN * 3); this.pCol = new Float32Array(this.PN * 3);
    this.pVel = new Float32Array(this.PN * 3); this.pLife = new Float32Array(this.PN);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    const dot = document.createElement('canvas'); dot.width = dot.height = 32;
    const dg = dot.getContext('2d'), grd = dg.createRadialGradient(16, 16, 0, 16, 16, 16);
    grd.addColorStop(0, '#fff'); grd.addColorStop(0.4, 'rgba(255,255,255,0.6)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    dg.fillStyle = grd; dg.fillRect(0, 0, 32, 32);
    this.particles = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.03, map: new THREE.CanvasTexture(dot), vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.particles.frustumCulled = false;
    this.scene.add(this.particles); this.pNext = 0;
    for (let i = 0; i < this.PN; i++) this.pPos[i * 3 + 1] = -100;
    const mk = (text, color, w = 256) => {
      const c = document.createElement('canvas'); c.width = w; c.height = 64;
      const g = c.getContext('2d'); g.font = '800 44px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.shadowColor = color; g.shadowBlur = 12; g.fillStyle = color; g.fillText(text, w / 2, 34);
      return new THREE.CanvasTexture(c);
    };
    this.popTex = { perfect: mk('PERFECT', '#ffe14d'), great: mk('GREAT', '#7dff8a'), good: mk('GOOD', '#9ad8ff'), miss: mk('MISS', '#ff4d4d'), super: mk('SUPER!', '#ffffff'), breaker: mk('DROP BREAKER!', '#ffe14d', 512) };
    this.pops = [];
    for (let i = 0; i < 16; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false }));
      s.scale.set(0.4, 0.1, 1); s.visible = false; s.renderOrder = 5; s.userData.life = 0;
      this.scene.add(s); this.pops.push(s);
    }
    this.popNext = 0;
    this.hurt = new THREE.Mesh(new THREE.SphereGeometry(0.35, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff0033, side: THREE.BackSide, transparent: true, opacity: 0, depthTest: false, depthWrite: false, fog: false }));
    this.hurt.renderOrder = 11; this.camera.add(this.hurt);
  }

  /* ---- swarm drones for the Drop Breaker ---- */
  _buildSwarm() {
    this.SW = 48;
    this.swarmMesh = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.11, 0), new THREE.MeshStandardMaterial({ color: 0xff5a1f, emissive: 0xff3300, emissiveIntensity: 1.1, roughness: 0.3 }), this.SW);
    this.swarmMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.swarmMesh.frustumCulled = false; this.swarmMesh.visible = false;
    this.scene.add(this.swarmMesh);
    this.groups = [];
    const c = document.createElement('canvas'); c.width = 1024; c.height = 160;
    this.promptCanvas = c; this.promptTex = new THREE.CanvasTexture(c);
    this.prompt = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.25), new THREE.MeshBasicMaterial({ map: this.promptTex, transparent: true, depthTest: false, depthWrite: false, fog: false }));
    this.prompt.renderOrder = 6; this.prompt.visible = false; this.scene.add(this.prompt);
  }

  _setPrompt(text, color) {
    if (this._promptText === text) return;
    this._promptText = text;
    const g = this.promptCanvas.getContext('2d');
    g.clearRect(0, 0, 1024, 160);
    g.font = '900 84px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = color; g.shadowBlur = 24; g.fillStyle = color; g.fillText(text, 512, 84);
    this.promptTex.needsUpdate = true;
  }

  _buildHud() {
    // Low and in front, like a scoreboard on the ring apron, so it never covers incoming missiles.
    this.hudCanvas = document.createElement('canvas'); this.hudCanvas.width = 1024; this.hudCanvas.height = 300;
    this.hudTex = new THREE.CanvasTexture(this.hudCanvas);
    this.hudTex.colorSpace = THREE.SRGBColorSpace;
    this.hud = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.44), new THREE.MeshBasicMaterial({ map: this.hudTex, transparent: true, depthWrite: false, fog: false }));
    this.hud.rotation.x = -0.55;
    this.scene.add(this.hud);
    this.hudDirty = true; this.hudLast = 0; this.message = ''; this.messageUntil = 0;
  }

  /* ================= run state ================= */
  resetRun() {
    this.run = { score: 0, combo: 0, maxCombo: 0, hits: 0, misses: 0, perfects: 0, supers: 0, breakers: 0, total: 0 };
    this.meter = 0; this.charge = 0; this.charged = false; this.focusUntil = 0;
    for (const n of this.active) this._release(n);
    this.active = []; this.hudDirty = true;
    this.groups = []; this.swarmMesh.visible = false; this.prompt.visible = false;
    this.dropIdx = 0; this.dropState = null; this.dropModeUntil = -1;
    if (this.shatter) this.shatter.clear();
  }

  setPlayer(p) { this.player = p; }

  loadTrack(track, tempo, difficulty) {
    this.track = track; this.tempo = tempo; this.difficulty = difficulty;
    this.resetRun();
    this._regen();
    this.calibrateHeight();
    this.mode = 'play';
    this.flash(tempo.source === 'default' ? 'Tempo is a guess: tap A/X (or T) on the beat to lock it' : tempo.source === 'deezer' ? `${Math.round(tempo.bpm)} BPM (Deezer): tap A/X on the beat to line missiles up exactly` : `${Math.round(tempo.bpm)} BPM${this.drops.length ? ' · drop ahead' : ''}`, 4000);
  }

  _regen(fromMs = -1) {
    this.dropInfo = getDrops(this.track, this.tempo);
    const { notes, drops } = generate(this.track, this.tempo, this.difficulty, { spread: this.spread, dropTimes: this.dropInfo.times });
    this.notes = fromMs < 0 ? notes : notes.filter((n) => n.t > fromMs + 100);
    this.nextNote = 0;
    this.drops = drops;
    this.run.total = notes.length;
  }

  /** Re-generate upcoming targets after the tempo or drop changes. */
  retime(tempo) {
    this.tempo = tempo;
    const pos = this.songPos();
    this._regen(pos + LEAD_S * 1000);
    this.dropIdx = this.drops.findIndex((d) => d.buildStart > pos);
    if (this.dropIdx < 0) this.dropIdx = this.drops.length;
    this.hudDirty = true;
  }

  calibrateHeight() {
    const p = v3();
    this.camera.getWorldPosition(p);
    this.headY = this.r.xr.isPresenting ? p.y : 1.6;
    this.hud.position.set(0, this.headY - 1.05, -1.6);
    this.ropes.forEach((r, i) => (r.position.y = Math.max(0.4, this.headY - 1.05) + i * 0.35));
    for (const ring of this.rings) ring.position.y = this.headY - 0.1;
  }

  chest() { return new THREE.Vector3(0, this.headY - 0.3, 0); }
  /** Punch distance: arm's length in VR; further out on a flat screen so missiles stay in view. */
  reach() { return this.r.xr.isPresenting ? REACH : 0.85; }
  songPos() { return this.player ? this.player.positionMs() - this.latencyMs : 0; }
  flash(text, ms = 2000) { this.message = text; this.messageUntil = performance.now() + ms; this.hudDirty = true; }
  stop() { this.mode = 'menu'; this.resetRun(); this.track = null; this.dropInfo = null; this.drops = []; }

  /* ================= per frame ================= */
  update(dt) {
    const now = performance.now();
    const playing = this.mode === 'play' && this.track && this.player && this.player.playing;
    const pos = this.songPos();
    const focus = now < this.focusUntil;
    this._updateGloves(dt);
    this._updateWrist(dt);
    if (this.mode === 'play') this._updateInputs(dt, pos);

    if (playing) {
      while (this.nextNote < this.notes.length && this.notes[this.nextNote].t - pos < LEAD_S * 1000) {
        const n = this.notes[this.nextNote++];
        if (n.t - pos < -WINDOW_S * 1000) continue;
        this._spawn(n);
      }
      this._updateDrop(dt, pos);
    }

    const win = focus ? FOCUS_WINDOW_S : WINDOW_S;
    const radius = focus ? 0.26 : 0.2;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const n = this.active[i];
      const m = n.mesh, cue = m.userData.cue;
      const tt = (n.t - pos) / 1000;
      if (n.dead) {
        n.deadT += dt;
        cue.visible = false;
        if (!n.hit) { // missed: the missile fizzles and drops away instead of flying into your face
          m.position.addScaledVector(n.dir, dt * 1.5); m.position.y -= dt * (1 + n.deadT * 8);
          m.scale.setScalar(Math.max(0.01, 1 - n.deadT * 3));
          m.userData.bodyMat.opacity = m.userData.bandMat.opacity = Math.max(0, 1 - n.deadT * 4);
        }
        if (n.deadT > 0.3 || n.hit) { this._release(n); this.active.splice(i, 1); }
        continue;
      }
      const d = tt > NEAR_S ? NEAR_SPEED * NEAR_S + (tt - NEAR_S) * FAR_SPEED : NEAR_SPEED * tt;
      m.position.copy(n.hitPos).addScaledVector(n.dir, d);
      if (tt > NEAR_S) { // a little corkscrew in flight so it reads as a missile, not a bead on a wire
        const w = Math.min(1, tt - NEAR_S) * 0.05;
        m.position.x += Math.sin(now / 90 + n.id) * w; m.position.y += Math.cos(now / 90 + n.id) * w;
      }
      m.lookAt(m.position.x - n.dir.x, m.position.y - n.dir.y, m.position.z - n.dir.z);
      m.userData.flame.scale.set(1, 0.7 + Math.random() * 0.6, 1);
      const appear = Math.min(1, (LEAD_S - tt) / 0.3);
      m.userData.bodyMat.opacity = m.userData.bandMat.opacity = appear;
      // approach cue: a ring at the punch spot that closes in on the beat
      const c = Math.max(0, Math.min(1, tt / 0.9));
      cue.visible = tt < 0.9;
      cue.scale.setScalar(1 + c * 1.4);
      cue.material.opacity = 0.7 * (1 - c * 0.6);
      if (Math.abs(tt) <= win) {
        const g = this.gloves[n.hand];
        const toward = g.vel.dot(n.dir); // speed of the fist out toward the missile
        if (g.pos.distanceTo(m.position) < radius && toward > MIN_PUNCH) this._hit(n, tt, toward, focus);
      }
      if (!n.dead && tt < -win) this._miss(n);
    }

    this._updateWorld(dt, pos, focus);
    this._updateFx(dt);
    this.shatter.update(dt);
    if (now - this.hudLast > 500) this.hudDirty = true;
    if (this.hudDirty && now - this.hudLast > 80) this._drawHud(pos, focus);
  }

  _updateGloves(dt) {
    const xr = this.r.xr.isPresenting;
    for (const g of Object.values(this.gloves)) {
      g.prev.copy(g.pos);
      if (xr) {
        const frame = this.r.xr.getFrame(), ref = this.r.xr.getReferenceSpace(), session = this.r.xr.getSession();
        g.src = null; g.tracked = false;
        if (frame && ref && session) {
          for (const src of session.inputSources) {
            if ((src.handedness === 'left' ? 'L' : src.handedness === 'right' ? 'R' : null) !== g.hand) continue;
            if (this._trackXr(g, src, frame, ref)) { g.src = src; g.tracked = true; break; }
          }
        }
        g.mesh.visible = g.tracked;
        if (!g.tracked) { g.pos.copy(g.prev); g.vel.multiplyScalar(0.5); }
      } else {
        const side = g.hand === 'L' ? -1 : 1;
        const guard = new THREE.Vector3(side * 0.2, 1.38, -0.42);
        const aim = (this.desktop.target[g.hand] || this.desktop.aim).clone();
        const t = this.desktop.punch[g.hand];
        let k = 0;
        if (t >= 0) {
          const age = (performance.now() - t) / 1000;
          k = age < 0.07 ? age / 0.07 : age < 0.22 ? 1 - (age - 0.07) / 0.15 : 0;
          if (age >= 0.22) { this.desktop.punch[g.hand] = -1; this.desktop.target[g.hand] = null; }
        }
        g.pos.lerpVectors(guard, aim, k);
        g.mesh.position.copy(g.pos);
        g.mesh.scale.setScalar(0.65);
        const dir = aim.clone().sub(guard).normalize();
        g.mesh.lookAt(g.pos.x - dir.x, g.pos.y - dir.y, g.pos.z - dir.z);
        g.mesh.visible = this.mode === 'play';
      }
      if (dt > 0) {
        const v = g.pos.clone().sub(g.prev).divideScalar(dt);
        if (v.length() < 25) g.vel.lerp(v, 0.6);
      }
      const win = this.dropState === 'window';
      const glow = this.charged ? 2.5 : this.charge > 0 ? 0.35 + this.charge * 2 : win ? 1.2 + Math.sin(performance.now() / 60) * 0.8 : 0.35;
      g.mesh.userData.mat.emissiveIntensity = glow;
      g.mesh.userData.mat.emissive.setHex(this.charged ? 0xffffff : win ? 0xffe14d : COLORS[g.hand]);
    }
  }

  _btn(g, i) { return !!(g.src && g.src.gamepad && g.src.gamepad.buttons[i] && g.src.gamepad.buttons[i].pressed); }

  /** Wrist pause: the button shows when the back of your left wrist faces you; tap it with the right glove. */
  _updateWrist(dt) {
    const L = this.gloves.L, R = this.gloves.R, b = this.wristBtn;
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

  _updateInputs(dt, pos) {
    const L = this.gloves.L, R = this.gloves.R;
    const xr = this.r.xr.isPresenting;
    const edge = (key, down) => { const was = this['_' + key]; this['_' + key] = down; return down && !was; };
    if (xr) {
      if (edge('tapBtn', this._btn(L, 4) || this._btn(R, 4))) this.hooks.onTap && this.hooks.onTap();
      if (edge('pauseBtn', this._btn(L, 5) || this._btn(R, 5))) this.hooks.onPause && this.hooks.onPause();
      if (edge('stickBtn', this._btn(L, 3) || this._btn(R, 3))) this.hooks.onMarkDrop && this.hooks.onMarkDrop();
      if (edge('focusBtn', this._btn(L, 0) && this._btn(R, 0))) this.tryFocus();
      // Double punch (both fists forward within 0.25 s) fires the Drop Breaker
      for (const g of [L, R]) if (-g.vel.z > 1.4) g.lastPunch = performance.now();
    }
    if (this.dropState === 'window' && L.lastPunch && R.lastPunch && Math.abs(L.lastPunch - R.lastPunch) < 250 && performance.now() - Math.min(L.lastPunch, R.lastPunch) < 300) {
      this._dropBreak(pos);
    }
    if (this.dropState === 'window') return; // Space / grips belong to the Drop Breaker now
    // Super punch: hold both grips (VR) / Space (desktop) to charge, then punch
    const holding = xr ? this._btn(L, 1) && this._btn(R, 1) : this.desktop.charge;
    if (this.meter >= 1 && holding) {
      this.charge = Math.min(1, this.charge + dt / 0.5);
      if (this.charge >= 1 && !this.charged) { this.charged = true; this.flash('CHARGED: punch!', 1500); this._haptic(L, 0.4, 80); this._haptic(R, 0.4, 80); }
    } else if (!this.charged) this.charge = Math.max(0, this.charge - dt * 2);
    if (this.charged) {
      const fast = Math.max(-L.vel.z, -R.vel.z);
      if (fast > 1.8 || (!xr && this._superRelease)) this._superPunch();
    }
    this._superRelease = false;
  }

  /* ================= Drop Breaker ================= */
  _updateDrop(dt, pos) {
    const d = this.drops[this.dropIdx];
    if (!d) { this.dropState = null; return; }
    const spb = 60000 / this.tempo.bpm;
    if (pos >= d.buildStart && !this.dropState) this._startSwarm(d);
    if (this.dropState === 'build' && pos >= d.windowStart) this.dropState = 'window';
    if (this.dropState) this._updateSwarm(dt, pos, d);
    if (this.dropState === 'build') {
      this.prompt.visible = true;
      this._setPrompt(`DROP INCOMING · ${Math.ceil((d.windowStart - pos) / spb)}`, '#ff8a3d');
      this.prompt.scale.setScalar(1);
    } else if (this.dropState === 'window') {
      this.prompt.visible = true;
      this._setPrompt(this.r.xr.isPresenting ? 'DOUBLE PUNCH!' : 'DOUBLE PUNCH! (Space)', '#ffe14d');
      this.prompt.scale.setScalar(1 + Math.max(0, Math.sin((pos / spb) * Math.PI)) * 0.12);
    } else if (this.dropState === 'breaking') {
      this.prompt.visible = false;
      for (const g of this.groups) if (!g.dead && pos >= g.boomAt) this._boomGroup(g);
    }
    if (pos >= d.t && this.dropState) this._drop(d);
  }

  _startSwarm(d) {
    this.dropState = 'build';
    this._applyPalette('build');
    const r = (a, b) => a + Math.random() * (b - a);
    const sp = Math.max(0.6, this.spread);
    let idx = 0;
    this.groups = [-48, -16, 18, 50].map((az) => {
      const n = 7 + Math.floor(Math.random() * 3);
      const g = { dir: dirFrom(az * sp, r(8, 26)), members: [], dead: false, boomAt: Infinity, center: v3() };
      for (let k = 0; k < n && idx < this.SW; k++) g.members.push({ i: idx++, phase: (k / n) * Math.PI * 2, rad: r(0.35, 0.6), bob: Math.random() * 6 });
      return g;
    });
    this.swarmMesh.count = idx; this.swarmMesh.visible = true;
    this.flash('Drop incoming: get ready to DOUBLE PUNCH', 2500);
  }

  _updateSwarm(dt, pos, d) {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = v3(), p = v3(), e = new THREE.Euler();
    const k = Math.min(1, Math.max(0, (pos - d.buildStart) / (d.t - d.buildStart)));
    const dist = 9 - k * 5;
    const chest = this.chest();
    const spin = pos / 400;
    for (const g of this.groups) {
      g.center.copy(chest).addScaledVector(g.dir, dist);
      for (const mem of g.members) {
        const scale = g.dead ? 0 : 1 + 0.25 * Math.sin(pos / 80 + mem.bob);
        p.set(Math.cos(mem.phase + spin) * mem.rad, Math.sin(mem.phase + spin) * mem.rad * 0.7 + Math.sin(pos / 300 + mem.bob) * 0.08, Math.sin(mem.phase + spin) * 0.2).add(g.center);
        q.setFromEuler(e.set(spin * 2 + mem.bob, spin * 3, 0));
        m.compose(p, q, s.setScalar(scale));
        this.swarmMesh.setMatrixAt(mem.i, m);
      }
    }
    this.swarmMesh.instanceMatrix.needsUpdate = true;
  }

  _dropBreak(pos) {
    const d = this.drops[this.dropIdx];
    if (!d || this.dropState !== 'window') return;
    this.dropState = 'breaking';
    this.run.breakers++;
    // detonate the groups one after another on eighth notes, all before the drop lands
    const eighth = 30000 / this.tempo.bpm;
    const live = this.groups.filter((g) => !g.dead);
    const span = Math.max(eighth, d.t - pos - 40);
    const step = Math.min(eighth, span / (live.length + 0.5));
    live.forEach((g, i) => { g.boomAt = pos + step * (i + 0.5); });
    for (const g of Object.values(this.gloves)) this._haptic(g, 1, 120);
    this._pop('breaker', new THREE.Vector3(0, this.headY + 0.05, -1.4));
    if (this.hitSounds) this._thump(1.4);
  }

  _boomGroup(g) {
    g.dead = true;
    [0xffe14d, 0xff5a1f, 0xffffff].forEach((c) => this._burst(g.center, c, 60, 3.5));
    this.run.score += g.members.length * 50 * this.multiplier(false);
    this.run.combo += g.members.length; this.run.hits += g.members.length;
    this.run.maxCombo = Math.max(this.run.maxCombo, this.run.combo);
    for (const gl of Object.values(this.gloves)) this._haptic(gl, 0.8, 60);
    if (this.hitSounds) this._thump(1.2);
    this.hudDirty = true;
  }

  _drop(d) {
    const broke = this.dropState === 'breaking';
    if (broke) for (const g of this.groups) if (!g.dead) this._boomGroup(g);
    this.shatter.trigger();
    this.groups = []; this.swarmMesh.visible = false; this.prompt.visible = false;
    this.dropState = null; this.dropIdx++;
    this.dropModeUntil = d.t + (60000 / this.tempo.bpm) * 32; // 8 bars of drop palette
    this._applyPalette('drop');
    this.scene.fog.color.copy(this.targetFog); // reveal the new colours instantly behind the shards
    if (broke) { this.flash('DROP!', 1500); this.meter = Math.min(1, this.meter + 0.35); }
    else { this.flash('Breaker missed: the swarm got through', 2000); this.run.combo = 0; this.hurtT = 0.4; }
    for (const g of Object.values(this.gloves)) this._haptic(g, 1, 200);
    this.hudDirty = true;
  }

  /* ================= scoring ================= */
  _spawn(n) {
    const mesh = this.pool.find((m) => !m.visible);
    if (!mesh) return;
    mesh.visible = true; mesh.scale.setScalar(1);
    mesh.userData.bandMat.color.setHex(COLORS[n.hand]); mesh.userData.bandMat.emissive.setHex(COLORS[n.hand]);
    mesh.userData.cue.material.color.setHex(COLORS[n.hand]);
    const dir = dirFrom(n.az, n.el);
    const hitPos = this.chest().addScaledVector(dir, this.reach());
    mesh.userData.cue.position.copy(hitPos);
    mesh.userData.cue.lookAt(hitPos.clone().add(dir));
    this.active.push({ ...n, dir, hitPos, mesh, dead: false, deadT: 0, hit: false });
  }
  _release(n) { if (n.mesh) { n.mesh.visible = false; n.mesh.userData.cue.visible = false; } }

  multiplier(focus) { return Math.min(4, 1 + Math.floor(this.run.combo / 8)) * (focus ? 2 : 1); }

  _hit(n, tt, speed, focus) {
    n.dead = true; n.hit = true;
    const a = Math.abs(tt);
    const rating = a < 0.06 ? 'perfect' : a < 0.12 ? 'great' : 'good';
    const base = { perfect: 100, great: 70, good: 40 }[rating];
    this.run.combo++; this.run.hits++;
    if (rating === 'perfect') this.run.perfects++;
    this.run.maxCombo = Math.max(this.run.maxCombo, this.run.combo);
    this.run.score += Math.round((base + Math.min(30, speed * 5)) * this.multiplier(focus));
    if (this.meter < 1) {
      this.meter = Math.min(1, this.meter + (rating === 'perfect' ? 0.05 : 0.035));
      if (this.meter >= 1) this.flash('SUPER READY: hold both grips / Space', 3000);
    }
    this._burst(n.mesh.position, COLORS[n.hand], rating === 'perfect' ? 40 : 24, 2.2);
    this._burst(n.mesh.position, 0xffb347, 18, 1.3);
    this._pop(rating, n.mesh.position);
    this._haptic(this.gloves[n.hand], rating === 'perfect' ? 1 : 0.6, 40);
    if (this.hitSounds) this._thump(rating === 'perfect' ? 1 : 0.7);
    this.hudDirty = true;
  }

  _miss(n) {
    n.dead = true;
    this.run.combo = 0; this.run.misses++;
    this.meter = Math.max(0, this.meter - (this.meter >= 1 ? 0 : 0.04));
    this._pop('miss', n.hitPos);
    this.hurtT = 0.25;
    this._haptic(this.gloves[n.hand], 0.3, 120);
    this.hudDirty = true;
  }

  _superPunch() {
    this.charged = false; this.charge = 0; this.meter = 0; this.run.supers++;
    const pos = this.songPos();
    let n = 0;
    for (const note of this.active) {
      if (note.dead) continue;
      note.dead = true; note.hit = true; n++;
      this._burst(note.mesh.position, 0xffffff, 30, 4);
    }
    while (this.nextNote < this.notes.length && this.notes[this.nextNote].t - pos < (LEAD_S + 1.5) * 1000) { this.nextNote++; n++; }
    this.run.hits += n; this.run.combo += n;
    this.run.maxCombo = Math.max(this.run.maxCombo, this.run.combo);
    this.run.score += n * 200 * this.multiplier(performance.now() < this.focusUntil);
    this.shockT = 0;
    this.shock.position.set(0, this.headY - 0.3, -0.8);
    this._pop('super', new THREE.Vector3(0, this.headY - 0.1, -1.2));
    this.flash(`SUPER PUNCH x${n}`, 2000);
    for (const g of Object.values(this.gloves)) this._haptic(g, 1, 250);
    if (this.hitSounds) this._thump(1.6);
    this.hudDirty = true;
  }

  tryFocus() {
    if (this.meter < 1 || performance.now() < this.focusUntil) return false;
    this.meter = 0; this.focusUntil = performance.now() + 8000;
    this.flash('FOCUS: double points, bigger targets', 2500);
    return true;
  }

  /* ================= desktop controls ================= */
  desktopAim(ndcX, ndcY) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const p = v3();
    if (ray.ray.intersectSphere(new THREE.Sphere(this.chest(), this.reach() + 0.05), p)) this.desktop.aim.copy(p);
  }
  /** Desktop punch with aim assist: snap to this hand's nearest live missile near the cursor. */
  desktopPunch(hand) {
    const pos = this.songPos();
    let best = null, bestD = 0.45;
    for (const n of this.active) {
      if (n.dead || n.hand !== hand || Math.abs(n.t - pos) > 350) continue;
      const d = n.hitPos.distanceTo(this.desktop.aim);
      if (d < bestD) { bestD = d; best = n.hitPos.clone().addScaledVector(n.dir, 0.05); }
    }
    this.desktop.target[hand] = best;
    this.desktop.punch[hand] = performance.now();
    this.gloves[hand].lastPunch = performance.now();
  }
  desktopCharge(down) {
    if (down && this.dropState === 'window') { this._dropBreak(this.songPos()); return; }
    if (!down && this.charged) this._superRelease = true;
    this.desktop.charge = down;
  }

  /* ================= fx ================= */
  _haptic(g, intensity, ms) {
    try { const h = g.src && g.src.gamepad && g.src.gamepad.hapticActuators && g.src.gamepad.hapticActuators[0]; if (h) h.pulse(intensity, ms); } catch { /* ignore */ }
  }
  _thump(v) {
    try {
      this.ac = this.ac || new AudioContext();
      const t = this.ac.currentTime, o = this.ac.createOscillator(), g = this.ac.createGain();
      o.frequency.setValueAtTime(180 * v, t); o.frequency.exponentialRampToValueAtTime(60, t + 0.08);
      g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      o.connect(g).connect(this.ac.destination); o.start(t); o.stop(t + 0.15);
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
      this.pLife[i] = 0.7;
    }
  }
  _pop(kind, p) {
    const s = this.pops[this.popNext = (this.popNext + 1) % this.pops.length];
    s.material.map = this.popTex[kind]; s.material.needsUpdate = true;
    s.position.set(p.x, p.y + 0.18, p.z); s.visible = true; s.userData.life = kind === 'breaker' ? 1.2 : 0.7;
    const sz = kind === 'super' ? [0.9, 0.225] : kind === 'breaker' ? [1.4, 0.175] : [0.4, 0.1];
    s.scale.set(sz[0], sz[1], 1);
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
    for (const s of this.pops) {
      if (!s.visible) continue;
      s.userData.life -= dt; s.position.y += dt * 0.3;
      s.material.opacity = Math.min(1, s.userData.life * 3);
      if (s.userData.life <= 0) s.visible = false;
    }
    if (this.shockT >= 0) {
      this.shockT += dt;
      const k = this.shockT / 0.6;
      this.shock.scale.setScalar(0.3 + k * 6); this.shock.position.z = -0.8 - k * 8;
      this.shock.material.opacity = Math.max(0, 1 - k);
      if (k >= 1) { this.shockT = -1; this.shock.material.opacity = 0; }
    }
    this.hurtT = Math.max(0, (this.hurtT || 0) - dt);
    this.hurt.material.opacity = this.hurtT * 1.2;
  }

  _updateWorld(dt, pos, focus) {
    const spb = 60000 / this.tempo.bpm;
    const phase = ((((pos - this.tempo.offsetMs) % spb) + spb) % spb) / spb;
    const live = this.mode === 'play' && this.player && this.player.playing;
    const beat = live ? Math.exp(-phase * 5) : 0.15 + 0.1 * Math.sin(performance.now() / 600);
    const dropMode = live && pos < this.dropModeUntil;
    if (!this.dropState) this._applyPalette(focus ? 'focus' : dropMode ? 'drop' : 'normal');
    const speed = focus ? 1.2 : this.dropState ? 9 : dropMode ? 12 : live ? 5 : 1.5;
    this.scroll = (this.scroll || 0) + dt * speed;
    this.rings.forEach((ring, i) => {
      ring.position.z = -(((i * 2.2 - this.scroll) % 52.8) + 52.8) % 52.8 - 1;
      ring.scale.setScalar(1 + beat * (dropMode ? 0.15 : 0.08));
      ring.material.opacity = 0.25 + beat * 0.5;
    });
    this.ropes.forEach((r) => (r.material.opacity = 0.3 + beat * 0.4));
    this.vignette.material.opacity += ((focus ? 0.35 : 0) - this.vignette.material.opacity) * Math.min(1, dt * 4);
    this.scene.fog.color.lerp(this.targetFog, Math.min(1, dt * 6));
    this.scene.background.copy(this.scene.fog.color);
    if (this.prompt.visible) {
      const cp = v3(); this.camera.getWorldPosition(cp);
      this.prompt.position.set(0, this.headY + 0.25, -1.8); this.prompt.lookAt(cp);
    }
    this.hud.visible = this.mode === 'play';
  }

  _drawHud(pos, focus) {
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
    g.fillStyle = 'rgba(255,255,255,0.6)'; g.font = f(600, 22); g.fillText(`COMBO  ×${this.multiplier(focus)}`, W - 36, 92);
    const mx = 32, my = 132, mw = W - 64, mh = 30;
    g.fillStyle = 'rgba(255,255,255,0.12)'; g.beginPath(); g.roundRect(mx, my, mw, mh, 15); g.fill();
    const grad = g.createLinearGradient(mx, 0, mx + mw, 0); grad.addColorStop(0, '#ff2d6f'); grad.addColorStop(1, '#00e5ff');
    g.fillStyle = this.meter >= 1 ? '#ffffff' : grad; g.beginPath(); g.roundRect(mx, my, Math.max(mh, mw * this.meter), mh, 15); g.fill();
    g.textAlign = 'center'; g.fillStyle = this.meter >= 1 ? '#2a0a3d' : '#fff'; g.font = f(700, 20);
    g.fillText(focus ? 'FOCUS ACTIVE' : this.meter >= 1 ? 'SUPER READY: grips + punch  |  triggers = FOCUS' : 'SUPER METER', W / 2, my + 5);
    g.textAlign = 'left'; g.fillStyle = '#fff'; g.font = f(700, 26);
    const name = this.track ? `${this.track.name} · ${this.track.artist}` : '';
    g.fillText(name.length > 58 ? name.slice(0, 57) + '…' : name, 32, 180);
    g.fillStyle = 'rgba(255,255,255,0.6)'; g.font = f(500, 22);
    const dur = this.track ? this.track.duration_ms : 0;
    const mmss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
    const dropTxt = this.drops.length ? `   drop: ${this.dropInfo.source}` : '';
    g.fillText(`${mmss(Math.max(0, pos))} / ${mmss(dur)}   ${Math.round(this.tempo.bpm)} BPM${this.tempo.source === 'default' ? ' (guess)' : this.tempo.source === 'deezer' ? ' (Deezer)' : ''}${dropTxt}`, 32, 214);
    if (this.player && this.player.syncInfo) { g.save(); g.font = f(500, 18); g.fillStyle = 'rgba(255,255,255,0.55)'; g.fillText(this.player.syncInfo(), 32, 240); g.restore(); }
    g.fillStyle = 'rgba(255,255,255,0.15)'; g.fillRect(32, 250, W - 64, 6);
    g.fillStyle = '#00e5ff'; g.fillRect(32, 250, (W - 64) * Math.min(1, Math.max(0, pos / (dur || 1))), 6);
    for (const d of this.drops) { g.fillStyle = '#ffe14d'; g.fillRect(32 + (W - 64) * (d.t / (dur || 1)) - 3, 244, 6, 18); }
    if (performance.now() < this.messageUntil) {
      g.textAlign = 'center'; g.fillStyle = '#00e5ff'; g.font = f(800, 26); g.fillText(this.message, W / 2, 264);
      this.hudDirty = true;
    }
    this.hudTex.needsUpdate = true;
  }

  onXrEnd() {
    for (const g of Object.values(this.gloves)) { g.src = null; g.tracked = false; g.kind = null; g.mesh.rotation.set(0, 0, 0); }
    this.wristBtn.visible = false;
    this.calibrateHeight();
  }

  render() { this.r.render(this.scene, this.camera); }
}
