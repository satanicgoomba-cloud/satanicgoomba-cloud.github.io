import * as THREE from 'three';
import { COLORS, ENERGY } from './shared.js?v=mwu7v3hh';
import { VoxelBody } from './voxels.js?v=mwu7v3hh';
import { WEAPONS, ORDER, weaponModel, WeaponTable } from './armory.js?v=mwu7v3hh';

// SHOOT style: a pistol in each hand while the track carries you forward. Enemies step out ahead;
// shoot each one on its beat (points for timing and for aim), dodge the bullets of the ones you
// leave standing (only your head can be hit), and whip the close ones with the gun itself, which
// also reloads it and restores energy. Squeeze the grip (or point a gun at the floor) to reload: the old magazine drops out.
//
// STILL style (same pistols, crystal enemies): time runs only as fast as you move. Stand still and bullets hang
// in the air (and your own songs slow to a crawl); move and everything speeds back up. Kills shatter the enemy
// into cubes. No reloading: a weapon table at your waist holds pistol, SMG, rifle, kunai, shuriken and axe; throw a
// spent weapon (trigger again, or squeeze the grip) and grab another (grip or trigger near the table); each slot
// refills a few seconds after you take it. Block bullets with a weapon to deflect them back, swat them with an empty
// hand. Until you're hit, kills score 25% more. Enemies in both styles are voxel figures that break apart when hit.

const WALK = { easy: 2.4, normal: 2.8, hard: 3.2, extreme: 3.6, maniac: 4 }; // m/s along the track
const STEP = { easy: -1, normal: 0, hard: 1, extreme: 2, maniac: 3 };
const SLIDE_S = 0.45, SLIDE_M = 2.2; // entrance: slides this far in from its side over this long
const APPEAR_MS = 2600;      // enemies step out this long before their beat
const FIRE_MS = 650;         // an enemy still standing this long after its beat shoots at you
const MAG = 12;
// STILL: time moves when you move
const STILL_MIN = 0.06;      // time speed when you stand completely still
const CLEAN_BONUS = 1.25;    // kills are worth this much more until you get hit
const MAG_LIFE = 2.2;          // a dropped magazine lies on the floor this long, fading out over the last second
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
    game.popTex.thrown = label('THROWN!', '#ffffff');
    game.popTex.swat = label('SWAT', '#ffffff');
    game.popTex.deflect = label('DEFLECTED!', '#9ad8ff', 320);
    game.popTex.grab = label('GRAB A WEAPON', '#ffffff', 360);
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
      const magGeo = new THREE.BoxGeometry(0.024, 0.09, 0.036), plateGeo = new THREE.BoxGeometry(0.03, 0.012, 0.044);
      const magIn = new THREE.Group(); magIn.add(new THREE.Mesh(magGeo, metal));
      const plate = new THREE.Mesh(plateGeo, new THREE.MeshBasicMaterial({ color: COLORS[h.hand] })); plate.position.y = -0.048; magIn.add(plate);
      magIn.position.set(0, -0.012, 0); grip.add(magIn);
      const pistolG = new THREE.Group(); pistolG.add(slide, grip, stripe, ammo);
      const models = { pistol: pistolG };
      for (const t of ORDER) if (t !== 'pistol') { models[t] = weaponModel(t, COLORS[h.hand]); models[t].visible = false; }
      const palm = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 10), new THREE.MeshStandardMaterial({ color: COLORS[h.hand], emissive: COLORS[h.hand], emissiveIntensity: 0.4, transparent: true, opacity: 0.6 }));
      palm.scale.set(1, 0.6, 1.3); palm.visible = false;
      gun.add(...Object.values(models), palm, laser, flash);
      gun.visible = false;
      h.mesh.add(gun);
      h.gun = { mesh: gun, ammo, flash, laser, magIn, magT: 1, rounds: MAG, downT: 0, muzzle: new THREE.Vector3(), dir: new THREE.Vector3(), models, palm, weapon: 'pistol', cd: 0, trig: false };
    }
    // enemies: voxel figures (see voxels.js)
    this.enemies = [];
    for (let i = 0; i < 30; i++) {
      const m = new THREE.Group(); m.visible = false;
      m.userData = { vox: new VoxelBody(m) };
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
    // dropped magazines: fall out of the grip, bounce on the floor, fade away
    this.mags = [];
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Group();
      const body = new THREE.MeshStandardMaterial({ color: 0x23202e, metalness: 0.85, roughness: 0.3, transparent: true });
      const plateM = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true });
      m.add(new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.09, 0.036), body));
      const pl = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.012, 0.044), plateM); pl.position.y = -0.048; m.add(pl);
      m.visible = false; m.userData = { body, plateM, vel: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0 };
      s.add(m); this.mags.push(m);
    }
    this._q = new THREE.Quaternion();
    // STILL: thrown weapons (each carries every model and shows one)
    this.thrown = [];
    for (let i = 0; i < 10; i++) {
      const t = new THREE.Group(), models = {};
      for (const k of ORDER) { models[k] = weaponModel(k, 0xffffff); models[k].visible = false; t.add(models[k]); }
      t.visible = false; t.userData = { models, vel: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0, hit: false, h: null, type: 'pistol', grav: 1.5 };
      s.add(t); this.thrown.push(t);
    }
    this.table = new WeaponTable(s);
    this.ts = 1; this.burst = 0; this.beatT = 0;
    // controller trigger / hand pinch fires
    game.r.xr.addEventListener('sessionstart', () => {
      const session = game.r.xr.getSession();
      const handOf = (e) => (e.inputSource.handedness === 'left' ? 'L' : e.inputSource.handedness === 'right' ? 'R' : null);
      session.addEventListener('selectstart', (e) => { // trigger / pinch: fire, throw a spent weapon, or grab from the table
        const hand = handOf(e); if (!hand) return;
        const h = game.sabers[hand]; h.gun.trig = true;
        if (this.live()) this.press(h);
      });
      session.addEventListener('selectend', (e) => { const hand = handOf(e); if (hand) game.sabers[hand].gun.trig = false; });
      session.addEventListener('squeezestart', (e) => { // side grip: reload (SHOOT); throw or grab (STILL)
        const hand = handOf(e); if (!hand || !this.live()) return;
        const h = game.sabers[hand];
        if (!this.still) this.reload(h);
        else if (h.gun.weapon) this.throwWeapon(h);
        else this.grab(h);
      });
    });
    this._v = new THREE.Vector3(); this._v2 = new THREE.Vector3();
  }

  get still() { return this.g.style === 'still'; }
  mag(h) { return this.still ? WEAPONS[(h && h.gun.weapon) || 'pistol'].ammo : MAG; }
  wpn(h) { return WEAPONS[this.still ? h.gun.weapon || 'pistol' : 'pistol']; }
  live() { const g = this.g; return g.guns && g.mode === 'play' && !g.paused && !g.run.failed && g.player && g.player.playing; }
  walkSpeed(d) { return WALK[d] || 2.8; }
  reset() {
    for (const m of this.enemies) { m.visible = false; m.userData.used = false; m.userData.vox.mesh.count = 0; }
    for (const b of this.bullets) b.visible = false;
    for (const t of this.tracers) t.visible = false;
    for (const m of this.mags) m.visible = false;
    for (const t of this.thrown) t.visible = false;
    this.table.reset(); this.table.group.visible = false; // shown again by updateFx while a STILL song plays
    this.ts = 1; this.burst = 0; this._lastHead = null; this._lastRay = null;
    for (const h of Object.values(this.g.sabers)) if (h.gun) { h.gun.weapon = 'pistol'; h.gun.rounds = this.mag(h); h.gun.magT = 1; h.gun.cd = 0; h.gun.trig = false; }
  }
  assist(h) { const m = this.g.mods, base = h ? this.wpn(h).assist || 6 : 6; return THREE.MathUtils.degToRad(m.strict ? base - 2 : m.bigTargets ? base + 3 : base); }

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
    const u = m.userData;
    u.vox.build(n.hp, this.still);
    m.rotation.set(0, 0, 0); m.visible = true;
    return { ...n, mesh: m, hpLeft: n.hp, dead: false, dying: 0, fired: false, risen: 0, home: new THREE.Vector3(n.x, 0, 0) };
  }

  place(n, tt, pos, dt) {
    const g = this.g, m = n.mesh, u = m.userData;
    const z = n.zb - tt * g.speed();
    const shown = tt * 1000 < APPEAR_MS;
    n.risen = shown ? Math.min(1, n.risen + dt * g.tscale / SLIDE_S) : 0;
    const ease = 1 - (1 - n.risen) ** 3;                 // slide in from its own side, fading up
    m.position.set(n.x + Math.sign(n.x || 1) * SLIDE_M * (1 - ease), 0, z);
    m.rotation.y = Math.atan2(-n.x, -z);                 // face you
    if (n.dead) return u.vox.update(dt * g.tscale);      // breaking apart; gone once every cube has settled and shrunk
    u.vox.assemble(n.risen);                              // cubes fly in to build the figure
    if (u.vox.loose) u.vox.update(dt * g.tscale);         // chipped armour still falling
    m.visible = shown;
    if (!shown) return false;
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

  /** Trigger / pinch. SHOOT: fire. STILL: fire, or throw a spent or thrown weapon, or grab from the table. */
  press(h) {
    if (!this.still) { this.fire(h); return; }
    const gun = h.gun;
    if (!gun.weapon) { this.grab(h); return; }
    const W = WEAPONS[gun.weapon];
    if (W.kind !== 'gun' || gun.rounds <= 0) this.throwWeapon(h);
    else this.fire(h);
  }

  /** STILL: take the weapon from the table slot nearest an empty hand. */
  grab(h) {
    const g = this.g, gun = h.gun;
    if (gun.weapon) return false;
    const slot = this.table.near(h.mesh.position);
    if (!slot) { g._pop('grab', this.table.group.position.clone().add(this._v.set(0, 0.25, -0.45))); return false; }
    gun.weapon = this.table.take(slot); gun.rounds = WEAPONS[gun.weapon].ammo; gun.cd = 0;
    g._haptic(h, 0.6, 50); if (g.hitSounds) this._click();
    return true;
  }

  /** Pull the trigger on one gun. */
  fire(h) {
    const g = this.g, gun = h.gun;
    if (!gun || !h.tracked) return;
    if (this.still && (!gun.weapon || gun.cd > 0)) return;
    const W = this.wpn(h);
    if (this.still) this.burst = 0.22; // pulling the trigger moves time a little, even standing still
    if (gun.rounds <= 0 && this.still) { this.throwWeapon(h); return; }
    if (gun.rounds <= 0) { // empty: point at the floor (or whip someone) to reload
      g._pop('reload', gun.muzzle.clone().add(this._v.set(0, 0.1, -0.3)));
      g._haptic(h, 0.15, 20);
      return;
    }
    if (g.r.xr.isPresenting) gun.rounds--;
    if (this.still) gun.cd = W.cd;
    gun.flash.material.opacity = 1;
    g._haptic(h, W.auto ? 0.4 : 0.7, W.auto ? 25 : 40);
    if (g.hitSounds) this._bang();
    const pos = g.songPos();
    // aim assist: the enemy (head or chest) or bullet closest to the line of fire
    let best = null, bestA = this.assist(h);
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
      if (!b.visible || b.userData.deflected) continue;
      const a = to.subVectors(b.position, gun.muzzle).angleTo(gun.dir);
      if (a < Math.min(bestA, THREE.MathUtils.degToRad(4))) { bestA = a; bulletHit = b; best = null; }
    }
    let end;
    if (bulletHit) {
      end = bulletHit.position.clone(); bulletHit.visible = false;
      g._burst(end, 0xff8899, 16, 1.2); g.addScore(10);
    } else if (best) {
      end = new THREE.Vector3(best.n.mesh.position.x, best.y, best.n.mesh.position.z);
      this._hitEnemy(best.n, bestA, pos, end, h, false, { dir: gun.dir.clone(), power: W.power, dmg: W.dmg });
    } else end = gun.muzzle.clone().addScaledVector(gun.dir, 30);
    this._tracer(gun.muzzle, end);
  }

  /** how: false = shot, true = melee, 'throw', 'deflect'. hit: { dir, power, dmg } decides how the cubes fly. */
  _hitEnemy(n, angle, pos, at, h, how, hit = {}) {
    const g = this.g, r = g.run, vox = n.mesh.userData.vox;
    const dir = (hit.dir || this._v2.subVectors(at, g.camera.getWorldPosition(this._v2))).clone().normalize().multiplyScalar(hit.power || 6);
    n.hpLeft = how && how !== 'shuriken' ? 0 : n.hpLeft - (hit.dmg || 1);
    if (n.hpLeft > 0) { vox.chip(at, dir); g._burst(at, 0xff8a1f, 8, 1); g._pop('armor', at); g.addScore(10); return; }
    n.dead = true; n.dying = 0;
    vox.shatter(at, dir);
    const special = !!how && how !== 'shuriken';
    const dtMs = Math.abs(n.t - pos), win = g.mods.strict ? 180 : 260;
    const beatPts = special ? 100 : Math.round(100 * Math.max(0, Math.min(1, 1 - (dtMs - 60) / win)));
    const aimPts = special ? 100 : Math.round(100 * Math.max(0, 1 - angle / this.assist(h)));
    const pts = Math.round((beatPts + aimPts) * (this.still && !r.bullets ? CLEAN_BONUS : 1));
    r.combo++; r.hits++; r.maxCombo = Math.max(r.maxCombo, r.combo);
    if (pts >= 180) r.perfects++;
    g.addScore(pts);
    g._burst(at, 0xffffff, 10, 1.2);
    g._pop(how === 'throw' || how === 'shuriken' ? 'thrown' : how === 'deflect' ? 'deflect' : how ? 'whip' : pts >= 180 ? 'perfect' : pts >= 140 ? 'great' : 'good', at);
    if (g.hitSounds) this._crack();
    if (how === true) { // melee
      r.whips++; g.energy(ENERGY.shoot.whip); g._haptic(h, 1, 120); if (g.hitSounds) g._boom();
      if (!this.still) h.gun.rounds = this.mag(h);                       // SHOOT: a whip reloads; STILL never reloads
    } else if (how) { r.whips++; g.energy(ENERGY.shoot.whip * 0.5); if (h) g._haptic(h, 0.6, 60); }
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
      if (!fast) continue;
      const W = this.wpn(h), empty = this.still && !h.gun.weapon;
      const reach = empty ? 0.3 : W.reach;
      const tip = this._v2.copy(h.mesh.position).addScaledVector(h.gun.dir, empty ? 0 : reach * 0.5); // the middle of the weapon
      for (const n of g.active) {
        if (n.type !== 'enemy' || n.dead || n.risen < 0.8) continue;
        const p = n.mesh.position;
        if (p.z < -2) continue;
        const d = Math.min(tip.distanceTo(this._v.set(p.x, 1.15, p.z)), tip.distanceTo(this._v.set(p.x, 1.55, p.z)));
        if (d < Math.max(0.38, reach * 0.75)) {
          const power = Math.max(5, h.vel.length() * 1.4) * (this.still && h.gun.weapon === 'axe' ? 1.6 : 1);
          this._hitEnemy(n, 0, pos, new THREE.Vector3(p.x, 1.3, p.z), h, true, { dir: h.vel.clone(), power });
        }
      }
    }
    // the bot: aim and fire on the beat
    if (g.bot && !g.r.xr.isPresenting) this._botFire(pos);
    // reload: a gun pointed at the floor (SHOOT only)
    for (const h of Object.values(g.sabers)) {
      const gun = h.gun; if (!gun || !h.tracked) continue;
      gun.downT = gun.dir.y < -0.8 ? gun.downT + dt : 0;
      if (gun.downT > 0.08 && gun.rounds < this.mag() && !this.still) this.reload(h);
    }
    // enemy bullets vs your head
    for (const b of this.bullets) {
      if (!b.visible) continue;
      if (b.userData.deflected) continue;                       // on its way back to them
      let blocked = false;
      for (const h of Object.values(g.sabers)) {
        if (!h.tracked || !h.gun) continue;
        if (this.still && !h.gun.weapon) { // empty hand: swat it away
          if (h.mesh.position.distanceTo(b.position) < 0.2) { b.visible = false; g._burst(b.position, 0xffffff, 14, 1.4); g._pop('swat', b.position.clone()); g.addScore(20); g._haptic(h, 0.5, 40); blocked = true; break; }
          continue;
        }
        // a weapon in the way: the bullet glances back towards the enemies
        const len = this.wpn(h).reach * 0.8, a = h.mesh.position, ab = this._v.copy(h.gun.dir).multiplyScalar(len);
        const k = Math.max(0, Math.min(1, this._v2.subVectors(b.position, a).dot(ab) / (len * len)));
        if (this._v2.copy(a).addScaledVector(ab, k).distanceTo(b.position) < 0.11) { this._deflect(b, h); blocked = true; break; }
      }
      if (blocked) continue;
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

  /** Fresh magazine: the old one drops out of the grip and a new one slides in. */
  reload(h) {
    const g = this.g, gun = h.gun;
    if (!gun || this.still || gun.out || gun.rounds >= this.mag() || gun.magT < 1) return false;
    gun.rounds = this.mag(); gun.magT = 0;
    g._haptic(h, 0.4, 40); if (g.hitSounds) this._click();
    const m = this.mags.find((x) => !x.visible) || this.mags.reduce((a, b) => (a.userData.life < b.userData.life ? a : b));
    const u = m.userData;
    gun.mesh.updateMatrixWorld();
    gun.magIn.getWorldPosition(m.position); gun.magIn.getWorldQuaternion(m.quaternion);
    const down = new THREE.Vector3(0, -1, 0).applyQuaternion(m.quaternion);   // out of the bottom of the grip
    u.vel.copy(down).multiplyScalar(1.2).addScaledVector(h.vel || new THREE.Vector3(), 0.5);
    u.spin.set((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 8);
    u.life = MAG_LIFE; u.body.opacity = u.plateM.opacity = 1; u.plateM.color.setHex(COLORS[h.hand]);
    m.visible = true;
    return true;
  }

  updateFx(dt) {
    const g = this.g, rdt = dt; dt *= g.tscale;      // STILL: bullets, shards and magazines run on your time
    const slide = g.mode === 'play' && !g.paused ? g.speed() : 0; // the floor rolls by as you walk
    this._updateThrown(dt);
    this.table.update(dt, g.headY, this.still && g.mode === 'play');
    if (this.still && this.live() && g.tscale < 0.35 && g.hitSounds) { // a slow heartbeat while time is frozen
      this.beatT -= rdt; if (this.beatT <= 0) { this.beatT = 0.9; this._thump(); }
    } else this.beatT = 0;
    for (const m of this.mags) {
      if (!m.visible) continue;
      const u = m.userData;
      u.life -= dt; u.vel.y -= 9.8 * dt;
      m.position.addScaledVector(u.vel, dt); m.position.z += slide * dt;
      if (m.position.y < 0.02) { // bounce, then settle
        m.position.y = 0.02; u.vel.y = Math.abs(u.vel.y) > 0.6 ? -u.vel.y * 0.35 : 0;
        u.vel.x *= 0.6; u.vel.z *= 0.6; u.spin.multiplyScalar(0.5);
      }
      const ang = u.spin.length();
      if (ang > 1e-3) m.quaternion.premultiply(this._q.setFromAxisAngle(this._v2.copy(u.spin).divideScalar(ang), ang * dt));
      u.body.opacity = u.plateM.opacity = Math.min(1, u.life / 1);
      if (u.life <= 0) m.visible = false;
    }
    for (const b of this.bullets) {
      if (!b.visible) continue;
      b.position.addScaledVector(b.userData.vel, dt);
      b.userData.life -= dt;
      if (b.userData.life <= 0 || b.position.z > 2) { b.visible = false; b.userData.deflected = false; continue; }
      if (b.userData.deflected && this.live()) { // a deflected bullet takes out the first enemy it meets
        for (const n of g.active) {
          if (n.type !== 'enemy' || n.dead || n.risen < 0.6) continue;
          const p = n.mesh.position;
          if (Math.abs(b.position.x - p.x) < 0.3 && Math.abs(b.position.z - p.z) < 0.35 && b.position.y > 0.2 && b.position.y < 1.8) {
            this._hitEnemy(n, 0, g.songPos(), b.position.clone(), b.userData.h, 'deflect', { dir: b.userData.vel.clone(), power: 7 });
            b.visible = false; b.userData.deflected = false; break;
          }
        }
      }
    }
    for (const t of this.tracers) { if (!t.visible) continue; t.material.opacity -= rdt * 9; if (t.material.opacity <= 0) t.visible = false; }
    for (const h of Object.values(this.g.sabers)) if (h.gun) h.gun.flash.material.opacity = Math.max(0, h.gun.flash.material.opacity - rdt * 14);
  }

  handFrame(h, dt, live) {
    const gun = h.gun;
    const type = this.still ? gun.weapon : 'pistol', W = WEAPONS[type || 'pistol'];
    gun.mesh.visible = live && h.mesh.visible;
    for (const k of ORDER) gun.models[k].visible = k === type;
    gun.palm.visible = !type;                                   // empty hand
    gun.laser.visible = !!type && W.kind === 'gun';
    if (type === 'shuriken') gun.models.shuriken.userData.spinner.rotation.y += dt * 3;
    gun.cd = Math.max(0, gun.cd - dt * this.g.tscale);
    gun.mesh.updateMatrixWorld();
    gun.muzzle.set(0, 0.012, W.muzzle || -0.16).applyMatrix4(gun.mesh.matrixWorld);
    gun.dir.set(0, 0, -1).transformDirection(gun.mesh.matrixWorld);
    gun.magT = Math.min(1, gun.magT + dt / 0.3);          // empty grip for a moment, then the new magazine slides up
    gun.magIn.visible = gun.magT > 0.4;
    gun.magIn.position.y = -0.012 - 0.07 * (1 - Math.min(1, (gun.magT - 0.4) / 0.6)) ** 2;
    if (live && this.still && gun.trig && type && W.auto && gun.rounds > 0) this.fire(h); // hold the trigger: automatic fire
    const k = gun.rounds / this.mag(h);
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
    if (this.still && !h.gun.weapon) h.gun.weapon = 'pistol';
    h.gun.rounds = this.mag(h); // unlimited on a screen
    this.fire(h);
  }
  /** STILL: how fast time runs this frame, from how fast your head and hands move (screen: the mouse). */
  timeScale(dt) {
    const g = this.g;
    let m = 0;
    if (g.r.xr.isPresenting) {
      const head = g.camera.getWorldPosition(this._v);
      if (this._lastHead && dt > 0) m = Math.max(0, head.distanceTo(this._lastHead) / dt - 0.05) * 1.6;
      (this._lastHead = this._lastHead || new THREE.Vector3()).copy(head);
      for (const h of Object.values(g.sabers)) if (h.tracked) m = Math.max(m, h.vBase.length() - 0.08);
    } else if (g.bot) m = 2;
    else if (g.desktop.ray) { // screen: turning the aim moves time
      const d = g.desktop.ray.direction;
      if (this._lastRay && dt > 0) m = d.angleTo(this._lastRay) / dt * 0.6;
      (this._lastRay = this._lastRay || new THREE.Vector3()).copy(d);
    }
    if (this.burst > 0) { this.burst -= dt; m = Math.max(m, 1); }
    const target = Math.min(1, STILL_MIN + Math.max(0, m) / 0.9);
    this.ts += (target - this.ts) * Math.min(1, dt * (target > this.ts ? 10 : 3.5)); // speeds up fast, settles slower
    return this.ts;
  }

  _nextBeat(pos) {
    const spb = 60000 / (this.g.tempo.bpm || 120), off = this.g.tempo.offsetMs || 0;
    let t = off + (Math.floor((pos - off) / spb) + 1) * spb;
    if (t - pos < 250) t += spb;
    return t;
  }

  /** Send a bullet that hit a weapon back at the nearest enemy (or straight back if there is none). */
  _deflect(b, h) {
    const g = this.g, u = b.userData;
    let best = null, bd = 1e9;
    for (const n of g.active) {
      if (n.type !== 'enemy' || n.dead || n.risen < 0.6) continue;
      const d = n.mesh.position.distanceTo(b.position); if (d < bd) { bd = d; best = n; }
    }
    const speed = Math.max(8, u.vel.length() * 1.8);
    if (best) u.vel.set(best.mesh.position.x, 1.3, best.mesh.position.z).sub(b.position).normalize().multiplyScalar(speed);
    else u.vel.multiplyScalar(-1.8);
    u.deflected = true; u.h = h; u.life = 4;
    b.lookAt(this._v.copy(b.position).add(u.vel));
    g._burst(b.position, 0x9ad8ff, 16, 1.6); g._pop('deflect', b.position.clone()); g.addScore(30); g._haptic(h, 0.8, 60);
    if (g.hitSounds) this._click();
  }

  /** STILL: throw what's in the hand along its aim. Shuriken go one at a time; everything else leaves the hand empty. */
  throwWeapon(h) {
    const g = this.g, gun = h.gun, type = gun.weapon;
    if (!type || !h.tracked) return;
    const W = WEAPONS[type], t = this.thrown.find((x) => !x.visible) || this.thrown[0], u = t.userData;
    gun.mesh.updateMatrixWorld();
    t.position.copy(h.mesh.position).addScaledVector(gun.dir, 0.1); gun.mesh.getWorldQuaternion(t.quaternion);
    for (const k of ORDER) u.models[k].visible = k === type;
    u.vel.copy(gun.dir).multiplyScalar(W.throwSpeed).addScaledVector(h.vel, 0.5);
    u.type = type; u.h = h; u.hit = false; u.life = 3;
    // throw assist: the enemy closest to where you threw (within ~15°) pulls the throw in, since they keep walking at you
    u.target = null; let bestA = THREE.MathUtils.degToRad(this.g.mods.bigTargets ? 20 : 15);
    for (const n of g.active) {
      if (n.type !== 'enemy' || n.dead || n.risen < 0.6) continue;
      const a = this._v.set(n.mesh.position.x, 1.2, n.mesh.position.z).sub(t.position).angleTo(gun.dir);
      if (a < bestA) { bestA = a; u.target = n; }
    }
    u.grav = W.kind === 'blade' || W.kind === 'star' ? 0.4 : W.kind === 'heavy' ? 3 : 1.5;
    if (W.kind === 'star') u.spin.set(0, 30, 0); else if (W.kind === 'blade') u.spin.set(0, 0, 0); else u.spin.set(-15, 0, (Math.random() - 0.5) * 3);
    t.visible = true;
    if (W.kind === 'star' && gun.rounds > 1) gun.rounds--; else { gun.weapon = null; gun.rounds = 0; }
    this.burst = 0.22; g._haptic(h, 0.4, 30);
  }
  _updateThrown(dt) {
    const g = this.g;
    for (const t of this.thrown) {
      if (!t.visible) continue;
      const u = t.userData, W = WEAPONS[u.type];
      u.life -= dt;
      if (u.target && !u.hit && !u.target.dead) { // steer toward the target's chest, keeping the speed
        const sp = u.vel.length(), p = u.target.mesh.position;
        u.vel.lerp(this._v.set(p.x, 1.15, p.z).sub(t.position).normalize().multiplyScalar(sp), Math.min(1, dt * 7));
      } else u.vel.y -= (u.hit ? 9.8 : u.grav) * dt;
      t.position.addScaledVector(u.vel, dt);
      if (W.kind === 'blade' && !u.hit) t.lookAt(this._v.copy(t.position).sub(u.vel)); // point first
      else {
        const ang = u.spin.length();
        if (ang > 1e-3) t.quaternion.multiply(this._q.setFromAxisAngle(this._v2.copy(u.spin).divideScalar(ang), ang * dt));
      }
      if (!u.hit && this.live()) {
        for (const b of this.bullets) { // knocks bullets out of the air on the way
          if (b.visible && !b.userData.deflected && b.position.distanceTo(t.position) < 0.15) { b.visible = false; g._burst(b.position, 0xffffff, 10, 1); g.addScore(20); }
        }
        for (const n of g.active) {
          if (n.type !== 'enemy' || n.dead || n.risen < 0.6) continue;
          const p = n.mesh.position;
          if (Math.abs(t.position.x - p.x) < 0.3 && Math.abs(t.position.z - p.z) < 0.3 && t.position.y > 0.1 && t.position.y < 1.8) {
            u.hit = true;
            this._hitEnemy(n, 0, g.songPos(), t.position.clone(), u.h, W.kind === 'star' ? 'shuriken' : 'throw', { dir: u.vel.clone(), power: W.power, dmg: 1 });
            u.vel.multiplyScalar(-0.15); u.vel.y = 1.5;
            break;
          }
        }
      }
      if (t.position.y < 0.03) { t.position.y = 0.03; u.vel.set(u.vel.x * 0.4, Math.abs(u.vel.y) > 0.8 ? -u.vel.y * 0.3 : 0, u.vel.z * 0.4); u.spin.multiplyScalar(0.4); u.hit = true; }
      if (u.life <= 0 || t.position.z < -40) t.visible = false;
    }
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
        h.lastShot = now; h.gun.rounds = this.mag(h); this.fire(h); continue;
      }
      if (!n || n.close || pos < n.t - 8 || now - (h.lastShot || 0) < 110) continue;
      h.lastShot = now; h.gun.rounds = this.mag(h); this.fire(h);
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
  _thump() { // heartbeat while time is frozen
    const g = this.g;
    try {
      g.ac = g.ac || new AudioContext();
      const t = g.ac.currentTime;
      for (const [d, v] of [[0, 0.22], [0.16, 0.14]]) {
        const o = g.ac.createOscillator(), gn = g.ac.createGain();
        o.frequency.setValueAtTime(70, t + d); o.frequency.exponentialRampToValueAtTime(38, t + d + 0.12);
        gn.gain.setValueAtTime(v, t + d); gn.gain.exponentialRampToValueAtTime(0.001, t + d + 0.16);
        o.connect(gn).connect(g.ac.destination); o.start(t + d); o.stop(t + d + 0.18);
      }
    } catch { /* ignore */ }
  }
  _crack() { // glassy shatter
    const g = this.g;
    try {
      g.ac = g.ac || new AudioContext();
      const ac = g.ac, t = ac.currentTime, src = ac.createBufferSource(), f = ac.createBiquadFilter(), gn = ac.createGain();
      src.buffer = g._noise(); f.type = 'highpass'; f.frequency.setValueAtTime(2500, t);
      gn.gain.setValueAtTime(0.28, t); gn.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      src.connect(f).connect(gn).connect(ac.destination); src.start(t); src.stop(t + 0.27);
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
