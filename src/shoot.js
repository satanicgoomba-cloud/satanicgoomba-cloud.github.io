import * as THREE from 'three';
import { COLORS, ENERGY } from './shared.js?v=mwu4cygh';

// SHOOT style: a pistol in each hand while the track carries you forward. Enemies step out ahead;
// shoot each one on its beat (points for timing and for aim), dodge the bullets of the ones you
// leave standing (only your head can be hit), and whip the close ones with the gun itself, which
// also reloads it and restores energy. Point a gun at the floor to reload.

const WALK = { easy: 2.4, normal: 2.8, hard: 3.2, extreme: 3.6, maniac: 4 }; // m/s along the track
const STEP = { easy: -1, normal: 0, hard: 1, extreme: 2, maniac: 3 };
const SLIDE_S = 0.45, SLIDE_M = 2.2; // entrance: slides this far in from its side over this long
const APPEAR_MS = 2600;      // enemies step out this long before their beat
const FIRE_MS = 650;         // an enemy still standing this long after its beat shoots at you
const MAG = 12;
const VISOR = { 1: 0xff2244, 2: 0xff8a1f, 4: 0xffe14d };

function rng(seedStr) {
  let h = 2166136261 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) { h = Math.imul(h ^ seedStr.charCodeAt(i), 16777619); }
  return () => { h += 0x6d2b79f5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function label(text, color, w = 256) {
  const c = document.createElement('canvas'); c.width = w; c.height = 64;
  const g = c.getContext('2d'); g.font = '800 44px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.shadowColor = color; g.shadowBlur = 12; g.fillStyle = color; g.fillText(text, w / 2, 34);
  return new THREE.CanvasTexture(c);
}

export class ShootStyle {
  constructor(game) {
    this.g = game;
    const s = game.scene;
    game.popTex.whip = label('WHIPPED!', '#ffe14d', 320);
    game.popTex.armor = label('ARMOUR', '#ff8a1f');
    game.popTex.shot = label('HIT!', '#ff3355');
    game.popTex.reload = label('RELOAD', '#9ad8ff');
    // pistols
    const metal = new THREE.MeshStandardMaterial({ color: 0x23202e, metalness: 0.85, roughness: 0.3 });
    for (const h of Object.values(game.sabers)) {
      const gun = new THREE.Group();
      const slide = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.042, 0.2), metal); slide.position.set(0, 0.012, -0.05);
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.1, 0.042), metal); grip.position.set(0, -0.04, 0.02); grip.rotation.x = 0.28;
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.008, 0.2), new THREE.MeshBasicMaterial({ color: COLORS[h.hand] })); stripe.position.set(0, 0.03, -0.05);
      const ammoMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const ammo = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.01, 0.12), ammoMat); ammo.position.set(0, -0.004, -0.03);
      const laser = new THREE.Mesh(new THREE.CylinderGeometry(0.0015, 0.0015, 1, 6, 1, true), new THREE.MeshBasicMaterial({ color: COLORS[h.hand], transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false }));
      laser.rotation.x = Math.PI / 2; laser.scale.y = 3; laser.position.set(0, 0.012, -0.15 - 1.5);
      const flash = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), new THREE.MeshBasicMaterial({ color: 0xfff1a8, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      flash.position.set(0, 0.012, -0.17);
      gun.add(slide, grip, stripe, ammo, laser, flash);
      gun.visible = false;
      h.mesh.add(gun);
      h.gun = { mesh: gun, ammo, flash, laser, rounds: MAG, downT: 0, muzzle: new THREE.Vector3(), dir: new THREE.Vector3() };
    }
    // enemies
    this.enemies = [];
    const dark = () => new THREE.MeshStandardMaterial({ color: 0x2a2238, emissive: 0x3a1a4a, emissiveIntensity: 0.7, metalness: 0.4, roughness: 0.6, transparent: true });
    const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
    for (let i = 0; i < 30; i++) {
      const m = new THREE.Group(), body = new THREE.Group();
      const mat = dark(), visorMat = new THREE.MeshBasicMaterial({ color: 0xff2244, transparent: true });
      const edge = new THREE.LineBasicMaterial({ color: 0xff2244, transparent: true, opacity: 1 });
      const part = (geo, x, y, z) => { const p = new THREE.Mesh(geo, mat); p.position.set(x, y, z); const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edge); e.position.copy(p.position); body.add(p, e); return p; };
      part(box(0.3, 0.82, 0.2), 0, 0.41, 0);          // legs
      part(box(0.44, 0.56, 0.25), 0, 1.1, 0);          // torso
      part(box(0.21, 0.24, 0.22), 0, 1.53, 0);         // head
      part(box(0.08, 0.08, 0.42), 0.2, 1.2, 0.18);     // arm + gun, pointing at you
      const visor = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 0.05), visorMat); visor.position.set(0, 1.56, 0.112); body.add(visor);
      const vest = new THREE.Mesh(box(0.5, 0.46, 0.31), new THREE.MeshStandardMaterial({ color: 0x5a3410, emissive: 0xff8a1f, emissiveIntensity: 0.25, transparent: true })); vest.position.y = 1.12; body.add(vest);
      const helmet = new THREE.Mesh(box(0.26, 0.13, 0.27), new THREE.MeshStandardMaterial({ color: 0x5a4a10, emissive: 0xffe14d, emissiveIntensity: 0.3, transparent: true })); helmet.position.y = 1.67; body.add(helmet);
      m.add(body); m.visible = false;
      m.userData = { body, mat, visorMat, edge, vest, helmet, mats: [mat, visorMat, edge, vest.material, helmet.material] };
      s.add(m); this.enemies.push(m);
    }
    // enemy bullets
    this.bullets = [];
    for (let i = 0; i < 24; i++) {
      const b = new THREE.Group();
      b.add(new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff })));
      b.add(new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff2244, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false })));
      const trail = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.03, 1, 8, 1, true), new THREE.MeshBasicMaterial({ color: 0xff2244, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }));
      trail.rotation.x = Math.PI / 2; trail.position.z = -0.4; trail.scale.y = 0.8; b.add(trail);
      b.visible = false; b.userData = { vel: new THREE.Vector3(), life: 0 };
      s.add(b); this.bullets.push(b);
    }
    // tracers from your shots
    this.tracers = [];
    for (let i = 0; i < 10; i++) {
      const t = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.006, 1), new THREE.MeshBasicMaterial({ color: 0xfff1a8, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      t.visible = false; s.add(t); this.tracers.push(t);
    }
    this.tracerNext = 0;
    // controller trigger / hand pinch fires
    game.r.xr.addEventListener('sessionstart', () => {
      const session = game.r.xr.getSession();
      session.addEventListener('selectstart', (e) => {
        const hand = e.inputSource.handedness === 'left' ? 'L' : e.inputSource.handedness === 'right' ? 'R' : null;
        if (hand && this.live()) this.fire(game.sabers[hand]);
      });
    });
    this._v = new THREE.Vector3(); this._v2 = new THREE.Vector3();
  }

  _fade(u, k) { for (const mt of u.mats) mt.opacity = k; }
  live() { const g = this.g; return g.style === 'shoot' && g.mode === 'play' && !g.paused && !g.run.failed && g.player && g.player.playing; }
  walkSpeed(d) { return WALK[d] || 2.8; }
  reset() {
    for (const m of this.enemies) { m.visible = false; m.userData.used = false; }
    for (const b of this.bullets) b.visible = false;
    for (const t of this.tracers) t.visible = false;
    for (const h of Object.values(this.g.sabers)) if (h.gun) h.gun.rounds = MAG;
  }
  assist() { const m = this.g.mods; return THREE.MathUtils.degToRad(m.strict ? 4 : m.bigTargets ? 9 : 6); }

  /* ---------- map: enemies on the slicing map's beats, thinned so each one is a shot you can make ---------- */
  convert(items, { tempo, difficulty, seed }) {
    const r = rng(`${seed}:shoot:${difficulty}`), spb = 60000 / tempo.bpm, step = STEP[difficulty] ?? 0;
    const minGap = spb * (step >= 3 ? 0.5 : step >= 1 ? 0.99 : step >= 0 ? 1.49 : 1.99);
    const out = items.filter((n) => n.type === 'wall');
    let last = -1e9, side = 1, sinceClose = 0;
    for (const n of items) {
      if (n.type !== 'note') continue;
      const dbl = Math.abs(n.t - last) < 5 && step >= 1;
      if (!dbl && n.t - last < minGap) continue;
      last = n.t; sinceClose++;
      side = n.hand === 'L' ? -1 : 1;
      let hp = 1;
      if (step >= 0 && r() < 0.08 + step * 0.04) hp = 2;
      if (step >= 2 && r() < 0.05) hp = 4;
      const close = !dbl && sinceClose > 10 && r() < 0.12;
      if (close) sinceClose = 0;
      out.push({
        id: n.id, t: n.t, type: 'enemy', hp: close ? 1 : hp, close,
        x: close ? side * 0.45 : side * (0.9 + r() * 2.6),
        zb: close ? -1.15 : -(5.5 + r() * 5.5),
      });
    }
    return out.sort((a, b) => a.t - b.t);
  }

  spawn(n) {
    const m = this.enemies.find((x) => !x.userData.used); if (!m) return null;
    m.userData.used = true;
    const u = m.userData, col = VISOR[n.hp] || VISOR[1];
    u.visorMat.color.setHex(col); u.edge.color.setHex(col);
    u.vest.visible = n.hp >= 2; u.helmet.visible = n.hp >= 4;
    m.rotation.set(0, 0, 0); u.body.rotation.set(0, 0, 0); u.body.position.set(0, 0, 0); this._fade(u, 0);
    m.visible = true;
    return { ...n, mesh: m, hpLeft: n.hp, dead: false, dying: 0, fired: false, risen: 0, home: new THREE.Vector3(n.x, 0, 0) };
  }

  place(n, tt, pos, dt) {
    const g = this.g, m = n.mesh, u = m.userData;
    const z = n.zb - tt * g.speed();
    const shown = tt * 1000 < APPEAR_MS;
    n.risen = shown ? Math.min(1, n.risen + dt / SLIDE_S) : 0;
    const ease = 1 - (1 - n.risen) ** 3;                 // slide in from its own side, fading up
    m.position.set(n.x + Math.sign(n.x || 1) * SLIDE_M * (1 - ease), 0, z);
    m.rotation.y = Math.atan2(-n.x, -z);                 // face you
    if (n.dead) {
      n.dying += dt;
      u.body.rotation.x = -Math.min(1.5, n.dying * 4);
      u.body.position.y = -Math.max(0, n.dying - 0.3) * 3;
      this._fade(u, Math.max(0, 1 - n.dying * 1.4));
      return n.dying > 0.8;
    }
    this._fade(u, ease); m.visible = true;
    if (!shown) { m.visible = false; return false; }
    // still standing after its beat: it shoots at you
    if (!n.fired && pos > n.t + FIRE_MS && n.risen >= 1 && this.live()) { n.fired = true; if (!g.mods.noBullets) this._enemyFire(n); }
    // walked past you without being dealt with
    if (z > (n.close ? -0.45 : -1.4)) { g._miss(n, new THREE.Vector3(n.x, 1.6, z)); return true; }
    return false;
  }

  _enemyFire(n) {
    const g = this.g, b = this.bullets.find((x) => !x.visible); if (!b) return;
    const from = new THREE.Vector3(0.2, 1.2, 0.4).applyMatrix4(n.mesh.matrixWorld);
    const head = g.camera.getWorldPosition(new THREE.Vector3());
    const speed = (g.mods.fast ? 1.25 : g.mods.slow ? 0.75 : 1) * (4.5 + (STEP[g.difficulty] ?? 0) * 0.5);
    b.position.copy(from);
    b.userData.vel.subVectors(head, from).normalize().multiplyScalar(speed);
    b.lookAt(head);
    b.userData.life = 8; b.visible = true;
    g._burst(from, 0xff2244, 10, 0.8);
  }

  /** Pull the trigger on one gun. */
  fire(h) {
    const g = this.g, gun = h.gun;
    if (!gun || !h.tracked) return;
    if (gun.rounds <= 0) { // empty: point at the floor (or whip someone) to reload
      g._pop('reload', gun.muzzle.clone().add(this._v.set(0, 0.1, -0.3)));
      g._haptic(h, 0.15, 20);
      return;
    }
    if (g.r.xr.isPresenting) gun.rounds--;
    gun.flash.material.opacity = 1;
    g._haptic(h, 0.7, 40);
    if (g.hitSounds) this._bang();
    const pos = g.songPos();
    // aim assist: the enemy (head or chest) or bullet closest to the line of fire
    let best = null, bestA = this.assist();
    const to = this._v;
    for (const n of g.active) {
      if (n.type !== 'enemy' || n.dead || n.risen < 0.6 || !n.mesh.visible) continue;
      for (const y of [1.55, 1.1]) {
        to.set(n.mesh.position.x, y, n.mesh.position.z).sub(gun.muzzle);
        const a = to.angleTo(gun.dir);
        if (a < bestA) { bestA = a; best = { n, y }; }
      }
    }
    let bulletHit = null;
    for (const b of this.bullets) {
      if (!b.visible) continue;
      const a = to.subVectors(b.position, gun.muzzle).angleTo(gun.dir);
      if (a < Math.min(bestA, THREE.MathUtils.degToRad(4))) { bestA = a; bulletHit = b; best = null; }
    }
    let end;
    if (bulletHit) {
      end = bulletHit.position.clone(); bulletHit.visible = false;
      g._burst(end, 0xff8899, 16, 1.2); g.addScore(10);
    } else if (best) {
      end = new THREE.Vector3(best.n.mesh.position.x, best.y, best.n.mesh.position.z);
      this._hitEnemy(best.n, bestA, pos, end, h, false);
    } else end = gun.muzzle.clone().addScaledVector(gun.dir, 30);
    this._tracer(gun.muzzle, end);
  }

  _hitEnemy(n, angle, pos, at, h, whip) {
    const g = this.g, r = g.run;
    n.hpLeft = whip ? 0 : n.hpLeft - 1;
    if (n.hpLeft > 0) { g._burst(at, 0xff8a1f, 14, 1.2); g._pop('armor', at); g.addScore(10); return; }
    n.dead = true; n.dying = 0;
    const dtMs = Math.abs(n.t - pos), win = g.mods.strict ? 180 : 260;
    const beatPts = whip ? 100 : Math.round(100 * Math.max(0, Math.min(1, 1 - (dtMs - 60) / win)));
    const aimPts = whip ? 100 : Math.round(100 * Math.max(0, 1 - angle / this.assist()));
    const pts = beatPts + aimPts;
    r.combo++; r.hits++; r.maxCombo = Math.max(r.maxCombo, r.combo);
    if (pts >= 180) r.perfects++;
    g.addScore(pts);
    g._burst(at, VISOR[n.hp] || 0xff2244, 40, 2.2);
    g._pop(whip ? 'whip' : pts >= 180 ? 'perfect' : pts >= 140 ? 'great' : 'good', at);
    if (whip) { r.whips++; h.gun.rounds = MAG; g.energy(ENERGY.shoot.whip); g._haptic(h, 1, 120); if (g.hitSounds) g._boom(); }
    else g.energy(ENERGY.shoot.hit);
    g.hudDirty = true;
  }

  _tracer(a, b) {
    const t = this.tracers[this.tracerNext = (this.tracerNext + 1) % this.tracers.length];
    const len = a.distanceTo(b);
    t.position.copy(a).lerp(b, 0.5); t.lookAt(b); t.scale.set(1, 1, len);
    t.material.opacity = 0.9; t.visible = true;
  }

  collide(pos, dt) {
    const g = this.g, head = g.camera.getWorldPosition(this._v2);
    // melee: swing a gun through a close enemy
    for (const h of Object.values(g.sabers)) {
      if (!h.tracked || !h.gun) continue;
      const fast = h.vel.length() > 1.0 || g.bot;
      for (const n of g.active) {
        if (n.type !== 'enemy' || n.dead || n.risen < 0.8) continue;
        const p = n.mesh.position;
        if (p.z < -2) continue;
        const d = Math.min(h.mesh.position.distanceTo(this._v.set(p.x, 1.15, p.z)), h.mesh.position.distanceTo(this._v.set(p.x, 1.55, p.z)));
        if (d < 0.38 && fast) this._hitEnemy(n, 0, pos, new THREE.Vector3(p.x, 1.3, p.z), h, true);
      }
    }
    // the bot: aim and fire on the beat
    if (g.bot && !g.r.xr.isPresenting) this._botFire(pos);
    // reload: a gun pointed at the floor
    for (const h of Object.values(g.sabers)) {
      const gun = h.gun; if (!gun || !h.tracked) continue;
      gun.downT = gun.dir.y < -0.8 ? gun.downT + dt : 0;
      if (gun.downT > 0.08 && gun.rounds < MAG) { gun.rounds = MAG; g._haptic(h, 0.4, 40); if (g.hitSounds) this._click(); }
    }
    // enemy bullets vs your head
    for (const b of this.bullets) {
      if (!b.visible) continue;
      const prev = this._v.copy(b.position).addScaledVector(b.userData.vel, -dt);
      const ab = b.position.clone().sub(prev), k = Math.max(0, Math.min(1, head.clone().sub(prev).dot(ab) / (ab.lengthSq() || 1)));
      if (prev.addScaledVector(ab, k).distanceTo(head) < 0.15) {
        b.visible = false;
        g.run.bullets++; g.run.combo = 0; g.hurtT = 0.5; g.hudDirty = true;
        g._pop('shot', head.clone().add(new THREE.Vector3(0, -0.15, -0.6)));
        for (const s of Object.values(g.sabers)) g._haptic(s, 1, 250);
        g.energy(ENERGY.shoot.bullet);
      }
    }
  }

  updateFx(dt) {
    for (const b of this.bullets) {
      if (!b.visible) continue;
      b.position.addScaledVector(b.userData.vel, dt);
      b.userData.life -= dt;
      if (b.userData.life <= 0 || b.position.z > 2) b.visible = false;
    }
    for (const t of this.tracers) { if (!t.visible) continue; t.material.opacity -= dt * 9; if (t.material.opacity <= 0) t.visible = false; }
    for (const h of Object.values(this.g.sabers)) if (h.gun) h.gun.flash.material.opacity = Math.max(0, h.gun.flash.material.opacity - dt * 14);
  }

  handFrame(h, dt, live) {
    const gun = h.gun;
    gun.mesh.visible = live && h.mesh.visible;
    gun.mesh.updateMatrixWorld();
    gun.muzzle.set(0, 0.012, -0.16).applyMatrix4(gun.mesh.matrixWorld);
    gun.dir.set(0, 0, -1).transformDirection(gun.mesh.matrixWorld);
    const k = gun.rounds / MAG;
    gun.ammo.scale.z = Math.max(0.01, k); gun.ammo.position.z = -0.03 + 0.06 * (1 - k);
    gun.ammo.material.color.setHex(k > 0.34 ? 0xffffff : k > 0 ? 0xffb347 : 0xff2244);
  }

  /** Screen controls: guns point where the mouse points (click to fire); the bot plays by itself. */
  desktopHand(h, pos) {
    const g = this.g, side = h.hand === 'L' ? -1 : 1;
    const base = new THREE.Vector3(side * 0.22, g.headY - 0.35, -0.2);
    let aim = null;
    if (g.bot) { const n = this._botTarget(h.hand, pos); if (n) aim = new THREE.Vector3(n.mesh.position.x, 1.3, n.mesh.position.z); }
    else if (g.desktop.ray && (g.desktop.ray.direction.x < 0) === (h.hand === 'L')) aim = g.desktop.ray.at(14, new THREE.Vector3());
    if (!aim) aim = new THREE.Vector3(side * 0.6, g.headY - 0.6, -6);
    h.mesh.position.copy(base);
    if (g.bot) { // whip close enemies: reach out to them
      const n = this._botTarget(h.hand, pos);
      if (n && n.close && n.mesh.position.z > -1.6 && Math.abs(n.t - pos) < 120) h.mesh.position.set(n.mesh.position.x, 1.3, n.mesh.position.z);
    }
    h.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), aim.sub(h.mesh.position).normalize());
    return true;
  }
  desktopFire() {
    const g = this.g, ray = g.desktop.ray;
    const h = g.sabers[ray && ray.direction.x < 0 ? 'L' : 'R'];
    h.gun.rounds = MAG; // unlimited on a screen
    this.fire(h);
  }
  _botTarget(hand, pos) {
    let best = null;
    for (const n of this.g.active) {
      if (n.type !== 'enemy' || n.dead || n.risen < 0.6) continue;
      if ((n.x < 0) !== (hand === 'L')) continue;
      if (!best || n.t < best.t) best = n;
    }
    return best && best.t - pos < 600 ? best : null;
  }
  _botFire(pos) {
    const g = this.g, now = pos; // song time (also right when the test harness steps time)
    for (const h of Object.values(g.sabers)) {
      if (h.lastShot > now) h.lastShot = -1e9;
      // shoot down incoming bullets first
      const b = this.bullets.find((x) => x.visible && x.position.z > -3 && (x.position.x < 0) === (h.hand === 'L'));
      const n = this._botTarget(h.hand, pos);
      if (b && now - (h.lastShot || 0) > 120) {
        h.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), b.position.clone().sub(h.mesh.position).normalize());
        h.mesh.updateMatrixWorld(); this.handFrame(h, 0, true);
        h.lastShot = now; h.gun.rounds = MAG; this.fire(h); continue;
      }
      if (!n || n.close || pos < n.t - 8 || now - (h.lastShot || 0) < 110) continue;
      h.lastShot = now; h.gun.rounds = MAG; this.fire(h);
    }
  }

  _bang() {
    const g = this.g;
    try {
      g.ac = g.ac || new AudioContext();
      const ac = g.ac, t = ac.currentTime, src = ac.createBufferSource(), f = ac.createBiquadFilter(), gn = ac.createGain();
      src.buffer = g._noise(); f.type = 'lowpass'; f.frequency.setValueAtTime(4000, t); f.frequency.exponentialRampToValueAtTime(300, t + 0.1);
      gn.gain.setValueAtTime(0.3, t); gn.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      src.connect(f).connect(gn).connect(ac.destination); src.start(t); src.stop(t + 0.14);
    } catch { /* ignore */ }
  }
  _click() {
    const g = this.g;
    try {
      g.ac = g.ac || new AudioContext();
      const t = g.ac.currentTime, o = g.ac.createOscillator(), gn = g.ac.createGain();
      o.type = 'square'; o.frequency.setValueAtTime(1800, t);
      gn.gain.setValueAtTime(0.08, t); gn.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
      o.connect(gn).connect(g.ac.destination); o.start(t); o.stop(t + 0.05);
    } catch { /* ignore */ }
  }
}
