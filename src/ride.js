import * as THREE from 'three';
import { COLORS, SPAWN_DIST, ENERGY } from './shared.js?v=mwv1noun';

// RIDE style: glowing orbs in your hands. Touch each note with the matching hand as it reaches you
// (scored on how centred your hand is: no swing needed), keep your hand on the light rails from
// start to end, and dodge walls. Green notes take either hand; gold notes need both hands together.

const HIT_Z = -0.5;          // notes are on their beat here (an easy arm's reach)
const ORB_R = 0.055;          // the orb in your hand
const NOTE_R = 0.1;
const RAIL_R = 0.15;          // how far your hand can drift off a rail and still be riding it
const RAIL_NEED = 0.8;        // fraction of a rail you must ride for it to count
const KIND_COL = { L: COLORS.L, R: COLORS.R, any: 0x39ff88, both: 0xffe14d };
const MAX_BEADS = 160;

function rng(seedStr) {
  let h = 2166136261 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) { h = Math.imul(h ^ seedStr.charCodeAt(i), 16777619); }
  return () => { h += 0x6d2b79f5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const STEP = { easy: -1, normal: 0, hard: 1, extreme: 2, maniac: 3 };

export class RideStyle {
  constructor(game) {
    this.g = game; this.HIT_Z = HIT_Z;
    const s = game.scene;
    // hand orbs
    for (const g of Object.values(game.sabers)) {
      const orb = new THREE.Group();
      orb.add(new THREE.Mesh(new THREE.SphereGeometry(ORB_R, 20, 14), new THREE.MeshBasicMaterial({ color: 0xffffff })));
      orb.add(new THREE.Mesh(new THREE.SphereGeometry(ORB_R * 1.9, 20, 14), new THREE.MeshBasicMaterial({ color: COLORS[g.hand], transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false })));
      orb.position.set(0, 0, -0.04);
      orb.visible = false;
      g.mesh.add(orb); g.orb = orb; g.orbPos = new THREE.Vector3();
    }
    // notes
    this.notes = [];
    const sph = new THREE.SphereGeometry(1, 24, 16), ring = new THREE.TorusGeometry(1.35, 0.08, 8, 40);
    for (let i = 0; i < 36; i++) {
      const m = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0x000000, emissiveIntensity: 0.7, metalness: 0.2, roughness: 0.3, transparent: true });
      const rmat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false });
      const halo = new THREE.Mesh(ring, rmat);
      m.add(new THREE.Mesh(sph, mat), halo);
      m.visible = false; m.userData = { mat, rmat, halo };
      s.add(m); this.notes.push(m);
    }
    // rails: a string of glowing beads that runs with the music
    this.rails = [];
    const bead = new THREE.SphereGeometry(0.026, 10, 8);
    for (let i = 0; i < 8; i++) {
      const grp = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
      const beads = new THREE.InstancedMesh(bead, mat, MAX_BEADS);
      beads.frustumCulled = false;
      const endMat = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xffffff, emissiveIntensity: 0.6, transparent: true });
      const end = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), endMat);
      const lit = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      grp.add(beads, end, lit);
      grp.visible = false; grp.userData = { mat, beads, end, endMat, lit };
      s.add(grp); this.rails.push(grp);
    }
    this._m = new THREE.Matrix4(); this._v = new THREE.Vector3();
  }

  reset() { for (const m of [...this.notes, ...this.rails]) { m.visible = false; m.userData.used = false; } }
  rowY(ry) { return this.g.headY - 0.8 + ry * 0.28; }
  noteR() { return this.g.mods.bigTargets ? NOTE_R * 1.3 : NOTE_R; }
  hitR() { return (this.noteR() + ORB_R + 0.035) * (this.g.mods.strict ? 0.8 : 1) * (this.g.mods.bigTargets ? 1.2 : 1); }

  /* ---------- map: turn the slicing map into orbs, gold doubles, green either-hand notes and rails ---------- */
  convert(items, { tempo, difficulty, seed }) {
    const r = rng(`${seed}:ride:${difficulty}`), spb = 60000 / tempo.bpm, step = STEP[difficulty] ?? 0;
    const out = items.filter((n) => n.type === 'wall');
    const notes = items.filter((n) => n.type === 'note');
    const pos = (n) => ({ px: (n.col - 1.5) * 0.3 + (r() - 0.5) * 0.1, ry: n.row + (r() - 0.5) * 0.3 });
    const used = new Set();
    let nextRail = notes.length ? notes[0].t + spb * 8 : 0;
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (used.has(i)) continue;
      const twin = notes[i + 1] && Math.abs(notes[i + 1].t - n.t) < 5 && notes[i + 1].hand !== n.hand ? i + 1 : -1;
      if (twin >= 0) { // both sabers at once -> one gold note for both hands
        used.add(twin);
        out.push({ id: n.id, t: n.t, type: 'orb', kind: 'both', px: (r() - 0.5) * 0.2, ry: Math.min(1.6, (n.row + notes[twin].row) / 2 + 0.3) });
        continue;
      }
      const p = pos(n);
      // a rail: start on this note, then follow this hand's next notes for 2-4 beats
      if (n.t >= nextRail) {
        const span = spb * (step <= -1 ? 4 : 2 + Math.floor(r() * 3));
        const keys = [{ t: n.t, ...p }];
        for (let j = i + 1; j < notes.length && notes[j].t <= n.t + span; j++) {
          if (notes[j].hand !== n.hand) continue;
          if (Math.abs(notes[j].t - (notes[j - 1] || {}).t) < 5) continue; // part of a double
          used.add(j); keys.push({ t: notes[j].t, ...pos(notes[j]) });
        }
        if (keys[keys.length - 1].t < n.t + span - spb * 0.5) {
          const last = keys[keys.length - 1];
          keys.push({ t: n.t + span, px: Math.max(-0.6, Math.min(0.6, last.px + (r() - 0.5) * 0.45)), ry: Math.max(0, Math.min(2, last.ry + (r() < 0.5 ? -1 : 1) * (0.6 + r() * 0.6))) });
        }
        out.push({ id: n.id, t: n.t, type: 'orb', kind: n.hand, hand: n.hand, ...p, railHead: true });
        out.push({ id: n.id + 100000, t: n.t, type: 'rail', hand: n.hand, dur: keys[keys.length - 1].t - n.t, keys, scored: true });
        nextRail = keys[keys.length - 1].t + spb * 4 * (step >= 1 ? 2 : 3) * (0.75 + r() * 0.5);
        continue;
      }
      // green: either hand, when the other hand is free
      const near = notes.some((x, k) => k !== i && Math.abs(x.t - n.t) < spb * 1.1);
      const kind = !near && r() < 0.14 ? 'any' : n.hand;
      out.push({ id: n.id, t: n.t, type: 'orb', kind, hand: kind === 'any' ? null : n.hand, ...p });
    }
    return out.sort((a, b) => a.t - b.t);
  }

  railAt(n, t) { // Catmull-Rom through the rail's key points
    const k = n.keys;
    if (t <= k[0].t) return k[0];
    if (t >= k[k.length - 1].t) return k[k.length - 1];
    let i = 0; while (i < k.length - 2 && t > k[i + 1].t) i++;
    const p0 = k[Math.max(0, i - 1)], p1 = k[i], p2 = k[i + 1], p3 = k[Math.min(k.length - 1, i + 2)];
    const u = (t - p1.t) / (p2.t - p1.t || 1), u2 = u * u, u3 = u2 * u;
    const cr = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3);
    return { px: cr(p0.px, p1.px, p2.px, p3.px), ry: cr(p0.ry, p1.ry, p2.ry, p3.ry) };
  }

  spawn(n) {
    if (n.type === 'orb') {
      const m = this.notes.find((x) => !x.userData.used); if (!m) return null;
      m.userData.used = true;
      const c = new THREE.Color(KIND_COL[n.kind]), u = m.userData;
      u.mat.color.copy(c).multiplyScalar(0.5); u.mat.emissive.copy(c);
      u.rmat.color.copy(c).lerp(new THREE.Color(0xffffff), 0.4);
      const R = this.noteR() * (n.kind === 'both' ? 1.35 : 1);
      m.scale.setScalar(R); m.visible = true;
      u.halo.visible = n.kind === 'both' || n.kind === 'any' || !!n.railHead;
      return { ...n, mesh: m, R, home: new THREE.Vector3(n.px, this.rowY(n.ry), 0), dead: false };
    }
    if (n.type === 'rail') {
      const m = this.rails.find((x) => !x.userData.used); if (!m) return null;
      m.userData.used = true;
      const u = m.userData, c = new THREE.Color(COLORS[n.hand]);
      u.mat.color.copy(c); u.endMat.color.copy(c).multiplyScalar(0.5); u.endMat.emissive.copy(c);
      u.lit.material.color.copy(c).lerp(new THREE.Color(0xffffff), 0.5);
      const stepMs = Math.max(30, n.dur / (MAX_BEADS - 1));
      m.visible = true;
      u.beads.count = Math.min(MAX_BEADS, Math.ceil(n.dur / stepMs) + 1);
      return { ...n, mesh: m, stepMs, count: Math.min(MAX_BEADS, Math.ceil(n.dur / stepMs) + 1), on: 0, tot: 0, done: false };
    }
    return null;
  }

  /** Move one item for this frame. Returns true when it's finished with. */
  place(n, tt, pos) {
    const g = this.g, spd = g.speed();
    if (n.type === 'orb') {
      if (n.dead) return true;
      const z = HIT_Z - tt * spd, m = n.mesh;
      const age = g.leadMs() / 1000 - tt, e = Math.min(1, age / 0.35);
      m.position.set(n.home.x, n.home.y - (1 - e) * 0.4, z);
      const f = Math.min(1, age / 0.25) * g.ghostFade(z);
      m.userData.mat.opacity = f; m.userData.rmat.opacity = f * 0.8;
      m.userData.halo.rotation.z += 0.03;
      if (z > HIT_Z + 0.5) { if (!n.dead) g._miss(n, m.position.clone()); return true; }
      return false;
    }
    // rail
    const u = n.mesh.userData, M = this._m;
    let shown = 0;
    for (let i = 0; i < n.count; i++) {
      const t = n.t + Math.min(n.dur, i * n.stepMs);
      const z = HIT_Z - ((t - pos) / 1000) * spd;
      if (t < pos || z < HIT_Z - SPAWN_DIST) { M.makeScale(0, 0, 0); u.beads.setMatrixAt(i, M); continue; }
      const p = this.railAt(n, t);
      M.makeTranslation(p.px, this.rowY(p.ry), z); u.beads.setMatrixAt(i, M); shown++;
    }
    u.beads.instanceMatrix.needsUpdate = true;
    u.mat.opacity = 0.85 * g.ghostFade(HIT_Z - tt * spd - 1);
    const endZ = HIT_Z - ((n.t + n.dur - pos) / 1000) * spd, ep = this.railAt(n, n.t + n.dur);
    u.end.position.set(ep.px, this.rowY(ep.ry), endZ); u.end.visible = endZ < HIT_Z + 0.05;
    const cur = this.railAt(n, Math.max(n.t, Math.min(n.t + n.dur, pos)));
    u.lit.position.set(cur.px, this.rowY(cur.ry), HIT_Z);
    u.lit.material.opacity = n.riding ? 0.8 : 0;
    if (!n.done && pos > n.t + n.dur) this._endRail(n);
    return !shown && pos > n.t + n.dur + 200;
  }

  _endRail(n) {
    const g = this.g, r = g.run;
    n.done = true;
    const ratio = n.tot > 0 ? n.on / n.tot : 0;
    const p = n.mesh.userData.lit.position.clone();
    if (ratio >= RAIL_NEED) {
      r.combo++; r.hits++; r.maxCombo = Math.max(r.maxCombo, r.combo);
      const pts = 60 + Math.round(40 * Math.min(1, (ratio - RAIL_NEED) / (1 - RAIL_NEED))) + Math.round(25 * (n.dur / 1000));
      g.addScore(pts);
      if (ratio > 0.95) r.perfects++;
      g._pop(ratio > 0.95 ? 'perfect' : 'great', p);
      g.energy(ENERGY.ride.rail);
      g._burst(p, COLORS[n.hand], 30, 1.5);
    } else {
      r.combo = 0; r.misses++;
      g._pop('miss', p); g.hurtT = 0.15;
      g.energy(ENERGY.ride.railMiss);
    }
    g.hudDirty = true;
  }

  collide(pos, dt) {
    const g = this.g, hands = g.sabers, hr = this.hitR();
    for (const n of g.active) {
      if (n.type === 'rail') {
        if (n.done || pos < n.t || pos > n.t + n.dur) { n.riding = false; continue; }
        const h = hands[n.hand], p = this.railAt(n, pos), y = this.rowY(p.ry);
        const on = h.tracked && Math.hypot(h.orbPos.x - p.px, h.orbPos.y - y) < RAIL_R * (g.mods.strict ? 0.8 : 1) && Math.abs(h.orbPos.z - HIT_Z) < 0.4;
        n.tot += dt; if (on) n.on += dt;
        if (on && !n.riding) g._haptic(h, 0.3, 30);
        n.riding = on;
        if (on && Math.random() < 0.5) g._burst(new THREE.Vector3(p.px, y, HIT_Z), COLORS[n.hand], 2, 0.6);
        continue;
      }
      if (n.type !== 'orb' || n.dead) continue;
      const m = n.mesh, z = m.position.z;
      if (z < HIT_Z - 0.8) continue;
      const reach = hr * (n.kind === 'both' ? 1.3 : 1);
      const test = (h) => {
        if (!h.tracked) return null;
        const o = h.orbPos, dz = z - o.z;
        if (dz < -0.14 || dz > 0.25) return null; // the note hasn't reached your hand yet / already went past
        const xy = Math.hypot(o.x - m.position.x, o.y - m.position.y);
        return xy < reach ? xy : null;
      };
      if (n.kind === 'both') {
        const a = test(hands.L), b = test(hands.R);
        if (a !== null && b !== null) this._hit(n, (a + b) / 2, reach, [hands.L, hands.R], pos);
        continue;
      }
      const cand = n.kind === 'any' ? [hands.L, hands.R] : [hands[n.kind]];
      for (const h of cand) { const d = test(h); if (d !== null) { this._hit(n, d, reach, [h], pos); break; } }
    }
  }

  _hit(n, xy, reach, hs, pos) {
    const g = this.g, r = g.run, m = n.mesh;
    n.dead = true; m.visible = false;
    const prec = Math.max(0, Math.min(1, 1 - (xy - 0.03) / (reach - 0.03)));
    const tt = (n.t - pos) / 1000;
    const pts = 50 + Math.round(40 * prec) + Math.round(10 * Math.max(0, 1 - Math.abs(tt) / 0.15));
    const rating = pts >= 88 ? 'perfect' : pts >= 72 ? 'great' : 'good';
    r.combo++; r.hits++; r.maxCombo = Math.max(r.maxCombo, r.combo);
    if (rating === 'perfect') r.perfects++;
    r.errs.push(tt);
    g.addScore(pts * (n.kind === 'both' ? 2 : 1));
    g.energy(ENERGY.ride.hit);
    g._pop(rating, m.position);
    g._burst(m.position, KIND_COL[n.kind], 30, 1.6);
    for (const h of hs) g._haptic(h, rating === 'perfect' ? 0.9 : 0.5, 30);
    if (g.hitSounds) g._slash(1.3);
    g.hudDirty = true;
  }

  updateFx() {}

  handFrame(h, dt, live) {
    h.orb.visible = live && h.mesh.visible;
    const pulse = 1 + 0.12 * Math.sin(performance.now() / 120);
    h.orb.children[1].scale.setScalar(pulse);
    h.orb.getWorldPosition(h.orbPos);
  }

  /** Screen controls: the hand for the next note follows the mouse (on the hit plane); the bot plays by itself. */
  desktopHand(h, pos) {
    const g = this.g, side = h.hand === 'L' ? -1 : 1;
    let target = null;
    if (g.bot) target = this._botTarget(h.hand, pos);
    else if (this._activeHand(pos) === h.hand) target = g.desktop.aim.clone().setZ(HIT_Z);
    if (!target) target = new THREE.Vector3(side * 0.62, g.headY - 1.25, -0.15);
    const want = target.add(this._v.set(0, 0, 0.04)); // the orb sits a little in front of the hand
    h.mesh.position.lerp(want, g.bot ? 0.45 : 0.6);
    h.mesh.quaternion.identity();
    return true;
  }
  _activeHand(pos) {
    let best = null;
    for (const n of this.g.active) {
      if (n.type === 'rail' && !n.done && pos >= n.t - 50 && pos <= n.t + n.dur) return n.hand;
      if (n.type === 'orb' && !n.dead && (!best || n.t < best.t)) best = n;
    }
    if (!best || best.t - pos > 900) return null;
    return best.kind === 'L' || best.kind === 'R' ? best.kind : best.home.x < 0 ? 'L' : 'R';
  }
  _botTarget(hand, pos) {
    let next = null;
    for (const n of this.g.active) {
      if (n.type === 'rail' && n.hand === hand && !n.done && pos >= n.t - 40 && pos <= n.t + n.dur) {
        const p = this.railAt(n, pos + 40); return new THREE.Vector3(p.px, this.rowY(p.ry), HIT_Z);
      }
      if (n.type !== 'orb' || n.dead) continue;
      const mine = n.kind === hand || n.kind === 'both' || (n.kind === 'any' && (n.home.x < 0) === (hand === 'L'));
      if (mine && (!next || n.t < next.t)) next = n;
    }
    if (!next || next.t - pos > 450) return null;
    const off = next.kind === 'both' ? (hand === 'L' ? -0.06 : 0.06) : 0;
    return new THREE.Vector3(next.home.x + off, next.home.y, HIT_Z);
  }
}
