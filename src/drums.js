import * as THREE from 'three';
import { ENERGY, COLORS } from './shared.js?v=mwxyztpx';
import { sectionAt } from './beatmap.js?v=mwxyztpx';
const E = ENERGY.drums;

// DRUMS style: a drum kit in front of you and a note highway behind it. Notes slide down four coloured
// lanes (red, yellow, blue, green) to the strike line; hit the matching pad with a stick as they arrive.
// The orange bar across all lanes is the kick: pull either trigger.
//   Bars on the highway are drum notes, round ones are cymbal notes. Yellow, blue and green each have a
//   drum (low) and a cymbal (high). Either one counts, unless PRO CYMBALS is on.
//   Drum fills (tom runs) end each phrase with a crash and a kick.
//   SURGE: white notes form a phrase; hit every note in it to fill the surge meter by a quarter. Once it's
//   half full, some fills become free-play zones: play anything, then hit the green crash at the end to
//   turn surge on (double points until the meter runs out).
// The chart is built from the song's beat (grooves per section energy, fills at phrase ends).

const LANE_COL = [0xff3b4f, 0xffd23f, 0x3f8cff, 0x3fe07a];
const KICK_COL = 0xff8a1f, SURGE_COL = 0xeef4ff, GOLD = 0xffc93c;
const LW = 0.26;                // lane width on the highway
const HL = 4.0;                 // highway length
const TILT = 0.45;              // the highway rises away from you (radians)
const S = new THREE.Vector3(0, -0.18, -1.3);           // strike line, relative to the head height
const D = new THREE.Vector3(0, Math.sin(TILT), -Math.cos(TILT)); // up the highway
const N = new THREE.Vector3(0, Math.cos(TILT), Math.sin(TILT));  // highway normal
const STICK = 0.4;
const P = {
  easy: { travel: 2000, win: [55, 95, 140] },
  normal: { travel: 1750, win: [50, 90, 130] },
  hard: { travel: 1500, win: [45, 85, 125] },
  extreme: { travel: 1300, win: [42, 80, 118] },
  maniac: { travel: 1150, win: [40, 75, 110] },
};
const LV = { easy: 0, normal: 1, hard: 2, extreme: 3, maniac: 4 };
// The kit (relative to your head height and position): lane, cymbal?, centre, radius, tilt toward you
const KIT = [
  { lane: 0, cym: false, x: -0.40, y: -0.66, z: -0.40, r: 0.125, tilt: 0.25, snd: 'snare' },
  { lane: 1, cym: false, x: -0.13, y: -0.60, z: -0.50, r: 0.12, tilt: 0.3, snd: 'tom1' },
  { lane: 2, cym: false, x: 0.14, y: -0.60, z: -0.50, r: 0.12, tilt: 0.3, snd: 'tom2' },
  { lane: 3, cym: false, x: 0.41, y: -0.68, z: -0.40, r: 0.13, tilt: 0.25, snd: 'tom3' },
  { lane: 1, cym: true, x: -0.47, y: -0.4, z: -0.68, r: 0.17, tilt: 0.35, snd: 'hat' },
  { lane: 2, cym: true, x: 0.24, y: -0.37, z: -0.76, r: 0.18, tilt: 0.4, snd: 'ride' },
  { lane: 3, cym: true, x: 0.62, y: -0.38, z: -0.56, r: 0.18, tilt: 0.35, snd: 'crash' },
];
const KEYS = { d: [0, false], f: [1, false], j: [2, false], k: [3, false], r: [1, true], u: [2, true], i: [3, true] };

function rng(seedStr) {
  let h = 2166136261 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) h = Math.imul(h ^ seedStr.charCodeAt(i), 16777619);
  return () => { h += 0x6d2b79f5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const basic = (opts = {}) => new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, fog: false, ...opts });
const laneX = (lane) => (lane - 1.5) * LW;

export class DrumStyle {
  constructor(game) {
    this.g = game; this.HIT_Z = S.z;
    const s = game.scene;
    this.root = new THREE.Group(); this.root.visible = false; s.add(this.root);
    // highway
    const hw = new THREE.Group();
    const W = LW * 4 + 0.06;
    const deck = new THREE.Mesh(new THREE.PlaneGeometry(W, HL), basic({ color: 0x0a0618, opacity: 0.82 }));
    deck.rotation.x = -Math.PI / 2 + TILT; deck.position.copy(S).addScaledVector(D, HL / 2 - 0.15); deck.renderOrder = -5;
    hw.add(deck);
    this.edges = [];
    for (let k = 0; k <= 4; k++) {
      const side = k === 0 || k === 4;
      const line = new THREE.Mesh(new THREE.PlaneGeometry(side ? 0.018 : 0.006, HL), basic({ color: side ? 0x8a6cff : 0xffffff, opacity: side ? 0.8 : 0.16 }));
      line.rotation.x = -Math.PI / 2 + TILT; line.position.copy(S).addScaledVector(D, HL / 2 - 0.15).addScaledVector(N, 0.002); line.position.x = laneX(k - 0.5);
      line.renderOrder = -4; hw.add(line); if (side) this.edges.push(line);
    }
    // beat lines (bar lines brighter)
    this.beatLines = Array.from({ length: 28 }, () => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(W, 0.012), basic({ color: 0xffffff, opacity: 0.2 }));
      m.rotation.x = -Math.PI / 2 + TILT; m.renderOrder = -3; m.visible = false; hw.add(m); return m;
    });
    // strike line with a target per lane and the kick line
    const sl = new THREE.Mesh(new THREE.PlaneGeometry(W, 0.012), basic({ color: 0xffffff, opacity: 0.7 }));
    sl.rotation.x = -Math.PI / 2 + TILT; sl.position.copy(S).addScaledVector(N, 0.004); hw.add(sl);
    this.kickLine = new THREE.Mesh(new THREE.PlaneGeometry(W, 0.03), basic({ color: KICK_COL, opacity: 0.5 }));
    this.kickLine.rotation.x = -Math.PI / 2 + TILT; this.kickLine.position.copy(S).addScaledVector(D, -0.05).addScaledVector(N, 0.003); hw.add(this.kickLine);
    this.targets = LANE_COL.map((c, lane) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(LW * 0.86, 0.07), basic({ color: c, opacity: 0.35 }));
      m.rotation.x = -Math.PI / 2 + TILT; m.position.copy(S).addScaledVector(N, 0.005); m.position.x = laneX(lane);
      m.userData.flash = 0; hw.add(m); return m;
    });
    // surge meter beside the highway
    const mg = new THREE.PlaneGeometry(0.035, 0.6);
    this.meterBack = new THREE.Mesh(mg, basic({ color: 0x221a3a, opacity: 0.8 }));
    this.meterFill = new THREE.Mesh(mg, basic({ color: GOLD, opacity: 0.95 }));
    for (const m of [this.meterBack, this.meterFill]) { m.position.set(W / 2 + 0.07, S.y + 0.3, S.z - 0.1); hw.add(m); }
    this.meterFill.renderOrder = 1;
    this.hw = hw; this.root.add(hw);

    // the kit
    this.surfaces = KIT.map((k) => this._makeSurface(k));
    const bass = new THREE.Group();
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.32, 32, 1, true), new THREE.MeshStandardMaterial({ color: 0x241a3d, roughness: 0.5, side: THREE.DoubleSide }));
    const head = new THREE.Mesh(new THREE.CircleGeometry(0.26, 32), new THREE.MeshBasicMaterial({ color: 0xd9d2e8 }));
    const rim = new THREE.Mesh(new THREE.RingGeometry(0.255, 0.28, 40), new THREE.MeshBasicMaterial({ color: KICK_COL }));
    shell.rotation.x = Math.PI / 2; head.position.z = 0.161; rim.position.z = 0.162;
    bass.add(shell, head, rim); this.bass = { g: bass, head, rim, flash: 0 }; this.root.add(bass);

    // gems
    const tomG = new THREE.BoxGeometry(LW * 0.8, 0.034, 0.08), cymG = new THREE.CylinderGeometry(LW * 0.26, LW * 0.36, 0.028, 24), kickG = new THREE.BoxGeometry(LW * 4, 0.014, 0.034);
    const make = (geo, kind) => { const mat = basic({ color: 0xffffff }); const m = new THREE.Mesh(geo, mat); m.rotation.x = TILT; m.visible = false; m.userData = { kind, mat }; this.root.add(m); return m; };
    this.pool = { tom: Array.from({ length: 48 }, () => make(tomG, 'tom')), cym: Array.from({ length: 40 }, () => make(cymG, 'cym')), kick: Array.from({ length: 32 }, () => make(kickG, 'kick')) };
    for (const m of this.pool.kick) m.renderOrder = -1;
    // act-crash halo, fill zones
    this.halo = new THREE.Mesh(new THREE.RingGeometry(0.09, 0.115, 32), basic({ color: GOLD, side: THREE.DoubleSide })); this.halo.visible = false; this.root.add(this.halo);
    this.pool.zone = Array.from({ length: 2 }, () => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(LW * 4, 1), basic({ color: 0x9b6cff, opacity: 0.28 }));
      m.rotation.x = -Math.PI / 2 + TILT; m.visible = false; m.userData = { kind: 'zone', mat: m.material }; m.renderOrder = -2; this.root.add(m); return m;
    });

    // sticks on both controllers
    for (const h of Object.values(game.sabers)) {
      const st = new THREE.Group();
      const wood = new THREE.Mesh(new THREE.CylinderGeometry(0.0055, 0.0085, STICK, 10), new THREE.MeshStandardMaterial({ color: 0xe8d2a8, roughness: 0.6 }));
      wood.rotation.x = Math.PI / 2; wood.position.z = -0.02 - STICK / 2;
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.011, 12, 8), new THREE.MeshBasicMaterial({ color: COLORS[h.hand] }));
      tip.position.z = -0.02 - STICK;
      st.add(wood, tip); st.visible = false; h.mesh.add(st); h.stick = st;
      h.stickTip = new THREE.Vector3(); h.stickPrev = new THREE.Vector3(); h.stickOk = false; h.lastHitAt = 0;
    }
    this.dh = { L: null, R: null }; // screen: the stick animation for each hand
    this.flashes = [];
    this._v = new THREE.Vector3(); this._w = new THREE.Vector3();
    this.surge = { meter: 0, active: false }; this.sp = {}; this.fillAct = {};

    // the kick: either trigger in VR; Space on a screen. Pads: D F J K (R U I for cymbals)
    game.r.xr.addEventListener('sessionstart', () => {
      const session = game.r.xr.getSession();
      session.addEventListener('selectstart', (e) => { if (this.live()) this.kick(e.inputSource.handedness === 'left' ? 'L' : 'R'); });
    });
    addEventListener('keydown', (e) => {
      if (e.repeat || !this.live() || e.target.tagName === 'INPUT' || e.metaKey || e.ctrlKey) return;
      const k = e.key.toLowerCase();
      if (k === ' ') { e.preventDefault(); this.kick(null); return; }
      const m = KEYS[k]; if (!m) return;
      const surf = this.surfaces.find((x) => x.lane === m[0] && x.cym === m[1]);
      this.strike(surf, 1, m[0] <= 1 ? 'L' : 'R');
    });
  }

  _makeSurface(k) {
    const grp = new THREE.Group();
    const col = new THREE.Color(LANE_COL[k.lane]);
    let skin;
    if (k.cym) {
      skin = new THREE.Mesh(new THREE.CylinderGeometry(k.r * 0.12, k.r, 0.025, 36), new THREE.MeshStandardMaterial({ color: 0xc9a24a, metalness: 0.6, roughness: 0.35, transparent: true, opacity: 0.55, depthWrite: false }));
      const ring = new THREE.Mesh(new THREE.RingGeometry(k.r * 0.9, k.r, 40), basic({ color: col, side: THREE.DoubleSide, opacity: 0.85 }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.006; grp.add(ring); grp.userData.ring = ring;
    } else {
      const shell = new THREE.Mesh(new THREE.CylinderGeometry(k.r, k.r, 0.09, 32, 1, true), new THREE.MeshStandardMaterial({ color: 0x241a3d, roughness: 0.5, side: THREE.DoubleSide }));
      shell.position.y = -0.045; grp.add(shell);
      skin = new THREE.Mesh(new THREE.CircleGeometry(k.r, 32), new THREE.MeshBasicMaterial({ color: 0x2a2440 }));
      skin.rotation.x = -Math.PI / 2;
      const ring = new THREE.Mesh(new THREE.RingGeometry(k.r * 0.86, k.r * 1.02, 40), basic({ color: col, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.002; grp.add(ring); grp.userData.ring = ring;
    }
    grp.add(skin);
    grp.rotation.x = k.tilt;
    const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 1, 6), new THREE.MeshStandardMaterial({ color: 0x777788, metalness: 0.7, roughness: 0.4 }));
    this.root.add(grp, stand);
    return { ...k, grp, skin, stand, ring: grp.userData.ring, col, flash: 0, c: new THREE.Vector3(), n: new THREE.Vector3() };
  }

  /* ---------- settings ---------- */
  get p() { return P[this.g.difficulty] || P.normal; }
  travel() { const m = this.g.mods.fast ? 1.25 : this.g.mods.slow ? 0.75 : 1; return this.p.travel / m; }
  leadMs() { return this.travel() + 200; }
  win() { const k = this.g.mods.strict ? 0.8 : 1; return this.p.win.map((w) => w * k); }
  live() { const g = this.g; return g.style === 'drums' && g.mode === 'play' && !g.paused && !g.run.failed && g.player && g.player.playing; }
  big() { return this.g.mods.bigTargets ? 1.2 : 1; }

  reset() {
    for (const list of Object.values(this.pool)) for (const m of list) { m.visible = false; m.userData.used = false; }
    this.halo.visible = false;
    this.surge = { meter: 0, active: false }; this.sp = {}; this.fillAct = {};
  }

  /** Place the kit and highway around the player's head height. */
  layout() {
    const g = this.g, hy = g.headY;
    this.root.position.set(0, hy, 0);
    const big = this.big();
    for (const s of this.surfaces) {
      s.grp.position.set(s.x, s.y, s.z); s.grp.scale.setScalar(big);
      s.n.set(0, Math.cos(s.tilt), Math.sin(s.tilt));
      s.c.set(s.x, s.y + hy, s.z);
      const h = s.y + hy - 0.02; // stand down to the floor
      s.stand.position.set(s.x, s.y - h / 2 - 0.02, s.z - 0.02); s.stand.scale.y = Math.max(0.05, h);
    }
    this.bass.g.position.set(0.0, 0.28 - hy, -0.78);
  }
  world(local) { return local.clone().add(this.root.position); }

  /* ---------- the chart ---------- */
  convert(items, { tempo, difficulty, seed }) {
    this.reset();
    const out = this._chart(items, { tempo, difficulty, seed });
    this._firstT = out.length ? out[0].t : undefined;
    for (const n of out) if (n.surge !== undefined) { const p = this.sp[n.surge] = this.sp[n.surge] || { left: 0, ok: true }; p.left++; }
    return out;
  }

  _chart(items, { tempo, difficulty, seed }) {
    const g = this.g, r = rng(`${seed}:drums:${difficulty}`), L = LV[difficulty] ?? 1;
    const notes = items.filter((n) => n.type === 'note').map((n) => n.t).sort((a, b) => a - b);
    if (notes.length < 8) return [];
    const spb = 60000 / tempo.bpm, last = notes[notes.length - 1], shift = g.shiftMs || 0;
    // beat times: the detected beats when we have them, else the tempo grid
    let beats = g.beats && g.beats.length > 8 ? g.beats.map((b) => b + shift).filter((b) => b >= notes[0] - spb * 0.5 && b <= last + spb * 4) : null;
    if (!beats || beats.length < 8) {
      const off = (tempo.offsetMs || 0) + shift, k0 = Math.round((notes[0] - off) / spb), k1 = Math.round((last - off) / spb) + 4;
      beats = []; for (let k = k0; k <= k1; k++) beats.push(off + k * spb);
    }
    const bt = (i) => i < beats.length ? beats[i] : beats[beats.length - 1] + (i - beats.length + 1) * spb;
    const at = (beat, frac) => bt(beat) + frac * (bt(beat + 1) - bt(beat)); // a point inside a beat
    const nb = Math.floor((beats.length - 1) / 4);
    const sections = g.sections || [];
    const silent = sections.filter((x) => x.kind === 'silent');
    const isSilent = (a, b) => silent.some((x) => a < x.t1 && b > x.t0 && (Math.min(b, x.t1) - Math.max(a, x.t0)) > (b - a) * 0.5);
    const endMs = (g.track && g.track.duration_ms ? g.track.duration_ms : last + 4000) - 1500;
    // per bar: notes in the generated map, section, energy
    const bars = [];
    for (let b = 0; b < nb; b++) {
      const t0 = bt(b * 4), t1 = bt(b * 4 + 4), q = (t1 - t0) / 16;
      const dens = notes.filter((t) => t >= t0 - q && t < t1 - q).length;
      const sec = sectionAt(sections, (t0 + t1) / 2);
      bars.push({ b, t0, t1, dens, sec, active: dens > 0 && !isSilent(t0, t1) && t1 < endMs + 1000 });
    }
    const ds = bars.filter((x) => x.active).map((x) => x.dens).sort((a, b) => a - b);
    const p75 = ds[Math.floor(ds.length * 0.75)] || 1;
    for (const x of bars) {
      const dr = Math.min(1, x.dens / p75), se = x.sec && x.sec.energy >= 0 ? x.sec.energy : null;
      x.energy = se === null ? dr : se * 0.5 + dr * 0.5;
    }
    // phrases: up to 8 bars; a new one after a rest, or at a section change (after 4 bars or more)
    let pc = 0, ph = -1;
    for (let i = 0; i < bars.length; i++) {
      const x = bars[i], prev = bars[i - 1];
      if (!x.active) { pc = 0; continue; }
      const start = !prev || !prev.active || pc >= 8 || (prev.sec !== x.sec && pc >= 4);
      if (start) { ph++; pc = 0; x.phraseStart = true; }
      x.ph = ph; x.pc = pc++;
    }
    for (let i = 0; i < bars.length; i++) {
      const x = bars[i], nx = bars[i + 1];
      if (x.active && x.pc >= 1 && (!nx || !nx.active || nx.phraseStart)) x.fill = true;
    }
    const phE = {};
    for (const x of bars) if (x.active) (phE[x.ph] = phE[x.ph] || []).push(x.energy);
    const bucketOf = (x) => { const a = phE[x.ph], e = a.reduce((s, v) => s + v, 0) / a.length; return e < 0.42 ? 0 : e < 0.72 ? 1 : 2; };

    // the song's groove
    const halfTime = tempo.bpm >= 155 && r() < 0.75;
    const fourFloor = !halfTime && tempo.bpm >= 112 && tempo.bpm <= 135 && r() < 0.4;
    const pick = (a) => a[Math.floor(r() * a.length)];
    const KP = [[[0, 8]], [[0, 8]], [[0, 8], [0, 6, 8], [0, 8, 10], [0, 2, 8], [0, 8, 14]], [[0, 6, 8, 14], [0, 2, 8, 10], [0, 6, 10], [0, 8, 10, 14]], [[0, 6, 8, 14], [0, 2, 8, 10], [0, 3, 6, 10], [0, 8, 10, 14]]];
    const kickV = halfTime ? (L >= 2 ? [0, 6, 10] : [0]) : fourFloor && L >= 1 ? [0, 4, 8, 12] : pick(KP[L]);
    const kickC = halfTime ? (L >= 2 ? [0, 3, 6, 10] : [0, 10]) : fourFloor && L >= 1 ? [0, 4, 8, 12] : pick(KP[L]);
    const snarePos = halfTime ? [8] : [4, 12];
    const sixteenthOk = (bt(1) - bt(0)) / 4 >= 105; // one note per 16th, alternating hands
    const phStyle = {}; // per phrase: cymbal lane and rate
    const styleFor = (x) => {
      if (phStyle[x.ph]) return phStyle[x.ph];
      const bk = bucketOf(x);
      let lane = 1, cym = true, rate = 4; // rate: 16ths between cymbal notes
      if (L === 0) rate = 8;
      else if (L === 1) rate = 4;
      else if (L === 2) rate = bk === 0 ? 4 : 2;
      else rate = bk === 0 ? 2 : bk === 2 && sixteenthOk && r() < (L === 4 ? 0.8 : 0.5) ? 1 : 2;
      if (bk === 2 && L >= 1) { const c = r(); if (c < 0.5) lane = 2; else if (c < 0.7 && L >= 2) { lane = 3; rate = Math.max(rate, 4); } }
      const offbeat = fourFloor && L >= 2 && lane === 1 && rate === 2 && r() < 0.6;
      return (phStyle[x.ph] = { lane, cym, rate, offbeat, bk });
    };

    const out = []; let id = 0, fid = 0, lastSurge = -1e9, sid = 0;
    const add = (t, type, lane, extra = {}) => { if (t < endMs) out.push({ id: id++, t: Math.round(t), type, lane, ...extra }); };
    for (let i = 0; i < bars.length; i++) {
      const x = bars[i]; if (!x.active) continue;
      const st = styleFor(x), b0 = x.b * 4, ts = (p) => at(b0 + Math.floor(p / 4), (p % 4) / 4);
      // fill: the last 1-4 beats
      const fillBeats = !x.fill ? 0 : L === 0 ? 2 : L <= 2 ? 2 : L === 3 ? (r() < 0.3 ? 4 : 2) : (r() < 0.5 ? 4 : 2);
      const fillFrom = 16 - fillBeats * 4;
      // surge phrase (a bar or two of plain groove, about every 16-20 s)
      let surge;
      if (!x.fill && x.t0 - lastSurge > 16000 + r() * 4000 && i > 1) { surge = sid++; lastSurge = x.t0; x.surge = surge; }
      else if (L >= 2 && bars[i - 1] && bars[i - 1].surge !== undefined && !x.fill && bars[i - 1].ph === x.ph) surge = bars[i - 1].surge;
      const tag = surge !== undefined ? { surge } : {};
      const crash = x.phraseStart;
      // groove
      const lv = Math.max(0, L - (st.bk === 0 && L >= 2 ? 1 : 0));
      const kicks = new Set(st.bk === 2 ? kickC : kickV);
      if (lv >= 4 && st.bk === 2) for (const k of [...kicks]) if (r() < 0.25 && k + 1 < 16 && !snarePos.includes(k + 1)) kicks.add(k + 1);
      if (lv >= 2 && x.pc % 4 === 3 && r() < 0.5) kicks.add(14);
      const snares = new Set(L === 0 ? [4, 12] : snarePos);
      if (lv >= 4 && st.bk === 2 && st.rate >= 2 && r() < 0.35) snares.add(r() < 0.5 ? 7 : 15);
      for (let p = 0; p < 16; p++) {
        if (p >= fillFrom) break;
        const t = ts(p);
        const isSn = snares.has(p);
        if (p === 0 && crash) { add(t, 'cym', 3, tag); add(t, 'kick', 4, tag); continue; }
        let cymHere = p % st.rate === 0;
        if (st.offbeat) cymHere = p % 4 === 2;
        if (L === 0) cymHere = p === 0 || p === 8;
        if (cymHere && !(isSn && st.rate === 1)) add(t, st.cym ? 'cym' : 'tom', st.lane, tag);
        if (isSn) add(t, 'tom', 0, tag);
        if (kicks.has(p) && L >= 1) add(t, 'kick', 4, tag);
      }
      // fill gems
      if (fillBeats) {
        const sub = L === 0 ? 4 : L <= 2 ? 2 : L === 3 ? (sixteenthOk && fillBeats === 2 ? 1 : 2) : (sixteenthOk ? 1 : 2);
        const count = (fillBeats * 4) / sub, kind = Math.floor(r() * 3), f = fid++;
        const nx = bars[i + 1], endT = nx ? bt(nx.b * 4) : bt(b0 + 16);
        for (let k = 0; k < count; k++) {
          const p = fillFrom + k * sub, t = ts(p);
          let lane;
          if (L === 0) lane = k === 0 ? 0 : 3;
          else if (kind === 0) lane = Math.min(3, Math.floor((k * 4) / count));
          else if (kind === 1) lane = k < count / 2 ? 0 : 1 + Math.min(2, Math.floor(((k - count / 2) * 3) / (count / 2)));
          else lane = k % 2 === 0 ? 0 : 1 + (Math.floor(k / 2) % 3);
          add(t, 'tom', lane, { fill: f, ...(k === 0 ? { first: true, zoneEnd: Math.round(endT) } : {}) });
          if (k === 0 && L >= 2) add(t, 'kick', 4, { fill: f });
        }
        // the crash after the fill (the next bar starts with it if the song goes on)
        if (!nx || !nx.active) { add(endT, 'cym', 3, { fillEnd: f }); if (L >= 1) add(endT, 'kick', 4); }
        else nx.fillEnd = f;
      }
      if (x.fillEnd !== undefined) {
        const c = out.find((n) => n.t === Math.round(ts(0)) && n.type === 'cym' && n.lane === 3);
        if (c) c.fillEnd = x.fillEnd;
      }
    }
    out.sort((a, b) => a.t - b.t || a.lane - b.lane);
    // two sticks: at most two pad notes at once, never the same lane twice
    const res = [];
    for (let i = 0; i < out.length;) {
      let j = i; while (j < out.length && out[j].t - out[i].t < 15) j++;
      const grp = out.slice(i, j), seen = new Set(), hands = [];
      for (const n of grp) {
        if (seen.has(n.lane)) continue; seen.add(n.lane);
        if (n.lane < 4) { if (hands.length >= 2) continue; hands.push(n); }
        res.push(n);
      }
      i = j;
    }
    return res;
  }

  /* ---------- sounds (made on the fly, no audio files) ---------- */
  _noise() {
    const ac = this.g.ac;
    if (this._nb && this._nb.sampleRate === ac.sampleRate) return this._nb;
    const b = ac.createBuffer(1, ac.sampleRate * 1.6, ac.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return (this._nb = b);
  }
  _snd(kind, vel = 1) {
    const g = this.g; if (!g.hitSounds) return;
    try {
      const ac = g.ac = g.ac || new AudioContext(); if (ac.state === 'suspended') ac.resume();
      const t = ac.currentTime, out = ac.createGain(); out.gain.value = 0.35 + 0.4 * vel; out.connect(ac.destination);
      const env = (node, peak, dec, t0 = t) => { const e = ac.createGain(); e.gain.setValueAtTime(peak, t0); e.gain.exponentialRampToValueAtTime(0.0008, t0 + dec); node.connect(e).connect(out); return e; };
      const noise = (type, f, q, peak, dec) => { const src = ac.createBufferSource(), fl = ac.createBiquadFilter(); src.buffer = this._noise(); fl.type = type; fl.frequency.value = f; fl.Q.value = q; src.connect(fl); env(fl, peak, dec); src.start(t); src.stop(t + dec + 0.05); };
      const tone = (type, f0, f1, peak, dec, glide = 0.1) => { const o = ac.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + glide); env(o, peak, dec); o.start(t); o.stop(t + dec + 0.05); };
      if (kind === 'kick') { tone('sine', 150, 42, 1.0, 0.38, 0.11); noise('lowpass', 900, 0.7, 0.25, 0.03); }
      else if (kind === 'snare') { noise('bandpass', 1900, 0.6, 0.75, 0.2); tone('triangle', 230, 170, 0.45, 0.1, 0.05); }
      else if (kind.startsWith('tom')) { const f = { tom1: 210, tom2: 160, tom3: 110 }[kind]; tone('sine', f * 1.5, f, 0.85, 0.42, 0.12); noise('bandpass', f * 6, 0.8, 0.12, 0.06); }
      else if (kind === 'hat') noise('highpass', 7500, 0.8, 0.5, 0.06);
      else if (kind === 'ride') { noise('bandpass', 8500, 1.2, 0.3, 0.6); tone('square', 520, 515, 0.05, 0.4); tone('square', 790, 785, 0.04, 0.35); }
      else if (kind === 'crash') { noise('highpass', 4200, 0.5, 0.55, 1.3); noise('bandpass', 6000, 0.8, 0.2, 0.5); }
    } catch { /* ignore */ }
  }

  /* ---------- spawning and drawing ---------- */
  spawn(n) {
    if (n.fill !== undefined) {
      let act = this.fillAct[n.fill];
      if (act === undefined) act = this.fillAct[n.fill] = this.surge.meter >= 0.5 && !this.surge.active;
      if (act) {
        this.g.run.total--;
        if (!n.first) return null;
        const m = this.pool.zone.find((x) => !x.userData.used); if (!m) return null;
        m.userData.used = true; m.visible = true;
        return { id: n.id, t: n.t, t1: n.zoneEnd, type: 'zone', scored: false, mesh: m, judged: true };
      }
    }
    const list = this.pool[n.type]; if (!list) return null;
    const m = list.find((x) => !x.userData.used); if (!m) return null;
    m.userData.used = true; m.visible = true;
    const act = n.fillEnd !== undefined && this.fillAct[n.fillEnd] === true;
    const col = act ? GOLD : n.surge !== undefined && !this.surge.active ? SURGE_COL : n.lane === 4 ? KICK_COL : LANE_COL[n.lane];
    m.userData.mat.color.setHex(col); m.userData.mat.opacity = 0;
    m.scale.setScalar(1);
    return { ...n, act, mesh: m, judged: false, hit: false };
  }

  _pos(n, pos, out) {
    const d = ((n.t - pos) / this.travel()) * HL;
    out.copy(S).addScaledVector(D, d).addScaledVector(N, n.type === 'kick' ? 0.008 : 0.02);
    out.x = n.lane === 4 ? 0 : laneX(n.lane);
    return d;
  }

  place(n, tt, pos) {
    const m = n.mesh, W = this.win();
    if (n.type === 'zone') {
      const d0 = Math.max(0, ((n.t - pos) / this.travel()) * HL), d1 = Math.min(HL, ((n.t1 - pos) / this.travel()) * HL);
      if (d1 <= 0) return true;
      m.scale.y = Math.max(0.001, d1 - d0); m.position.copy(S).addScaledVector(D, (d0 + d1) / 2).addScaledVector(N, 0.006);
      m.material.opacity = 0.34 + 0.14 * Math.sin(pos / 90);
      return false;
    }
    if (!n.judged && pos > n.t + W[2]) this._miss(n);
    if (n.hit) { if (n.act) this.halo.visible = false; return true; }
    const d = this._pos(n, pos, m.position);
    let a = clamp((HL - d) / 0.6, 0, 1);
    if (this.g.mods.ghost) a *= clamp((d - HL * 0.22) / (HL * 0.18), 0, 1);
    if (n.judged) a *= clamp(1 + d / 0.4, 0, 1); // missed: slides past and fades
    m.userData.mat.opacity = a;
    if (n.surge !== undefined && !n.judged) { const p = this.sp[n.surge]; if (p && !p.ok) m.userData.mat.color.setHex(n.lane === 4 ? KICK_COL : LANE_COL[n.lane]); }
    if (n.act) { this.halo.visible = !n.judged; this.halo.position.copy(m.position); this.halo.rotation.set(-Math.PI / 2 + TILT, 0, pos / 300); this.halo.material.opacity = a; }
    return d < -0.4;
  }

  /* ---------- hitting ---------- */
  /** A stick hit a pad or cymbal (vel 0..1). */
  strike(surf, vel, hand) {
    if (!surf) return;
    surf.flash = 1; this._snd(surf.snd, vel);
    if (hand && !this.g.r.xr.isPresenting) this.dh[hand] = { surf, at: performance.now() };
    const h = hand && this.g.sabers[hand]; if (h) this.g._haptic(h, 0.3 + vel * 0.6, 22);
    this._judgeLane(surf.lane, surf.cym);
  }
  kick(hand) {
    this.bass.flash = 1; this._snd('kick', 1);
    const h = hand && this.g.sabers[hand]; if (h) this.g._haptic(h, 0.5, 30);
    this._judgeLane(4, false);
  }
  _judgeLane(lane, cym) {
    const g = this.g; if (!this.live()) return;
    const pos = g.songPos(), W = this.win(), pro = g.mods.proDrums;
    let best = null, be = 1e9;
    for (const n of g.active) {
      if (n.judged || n.lane !== lane || n.type === 'zone') continue;
      if (pro && lane >= 1 && lane <= 3 && (n.type === 'cym') !== cym) continue;
      const e = Math.abs(pos - n.t); if (e <= W[2] && e < be) { best = n; be = e; }
    }
    if (best) this._hit(best, pos - best.t);
  }
  _hit(n, e) {
    const g = this.g, r = g.run, W = this.win();
    n.judged = true; n.hit = true;
    const rating = Math.abs(e) <= W[0] ? 'perfect' : Math.abs(e) <= W[1] ? 'great' : 'good';
    r.hits++; if (rating === 'perfect') r.perfects++; r.errs.push(e / 1000);
    r.combo++; r.maxCombo = Math.max(r.maxCombo, r.combo);
    g.addScore({ perfect: 50, great: 40, good: 25 }[rating] * (this.surge.active ? 2 : 1));
    g.energy(g.mods.strict && rating === 'good' ? 0.003 : E.hit); g.hudDirty = true;
    const p = this.world(this._v.copy(S).addScaledVector(N, 0.05)); p.x = n.lane === 4 ? 0 : laneX(n.lane);
    if (n.lane < 4) { this.targets[n.lane].userData.flash = 1; if (rating !== 'good' || r.combo % 4 === 0) g._pop(rating, p); }
    g._burst(p, n.lane === 4 ? KICK_COL : LANE_COL[n.lane], rating === 'perfect' ? 14 : 8, 1);
    if (n.surge !== undefined) this._surgeNote(n.surge, true);
    if (n.act) this._activate(p);
  }
  _miss(n) {
    n.judged = true;
    const p = this.world(this._v.copy(S).addScaledVector(N, 0.05)); p.x = n.lane === 4 ? 0 : laneX(n.lane);
    this.g._miss(n, p);
    if (n.surge !== undefined) this._surgeNote(n.surge, false);
  }
  _surgeNote(id, ok) {
    const s = this.sp[id]; if (!s) return;
    if (!ok) s.ok = false;
    if (--s.left > 0) return;
    if (s.ok && !this.surge.active) {
      const was = this.surge.meter; this.surge.meter = Math.min(1, this.surge.meter + 0.25);
      this.g.run.surgePhrases = (this.g.run.surgePhrases || 0) + 1;
      this.g.flash(was < 0.5 && this.surge.meter >= 0.5 ? 'SURGE READY: hit the gold crash after a free fill' : 'SURGE +25%', 1800);
    } else if (s.ok) this.surge.meter = Math.min(1, this.surge.meter + 0.25);
  }
  _activate(p) {
    if (this.surge.active || this.surge.meter < 0.5) return;
    this.surge.active = true; this.g.run.surges = (this.g.run.surges || 0) + 1;
    this.g.flash('SURGE! Double points', 2000);
    this.g._burst(p, GOLD, 60, 2.5);
    for (const h of Object.values(this.g.sabers)) this.g._haptic(h, 1, 120);
  }

  collide(pos, dt) {
    const g = this.g;
    if (this.surge.active) {
      const spb = 60000 / ((g.tempo && g.tempo.bpm) || 120);
      this.surge.meter -= (dt * 1000) / (spb * 32);
      if (this.surge.meter <= 0) { this.surge.meter = 0; this.surge.active = false; g.flash('Surge over', 1200); }
    }
    if (g.bot && !g.r.xr.isPresenting) this._bot(pos);
  }

  /** ?bot=1 on a screen: plays every note itself. */
  _bot(pos) {
    for (const n of this.g.active) {
      if (n.judged || n.type === 'zone' || pos < n.t - 4) continue;
      if (n.lane === 4) { this.kick(null); continue; }
      const surf = this.surfaces.find((s) => s.lane === n.lane && s.cym === (n.type === 'cym'));
      this.strike(surf, 0.8, n.lane <= 1 ? 'L' : 'R');
    }
  }

  updateFx(dt, pos) {
    const g = this.g, show = g.style === 'drums' && g.mode === 'play';
    this.root.visible = show;
    for (const h of Object.values(g.sabers)) if (h.stick) h.stick.visible = show && (h.tracked || !g.r.xr.isPresenting);
    if (!show) return;
    this.layout();
    // beat lines
    const tr = this.travel(), beats = this._beatTimes(pos, pos + tr);
    this.beatLines.forEach((m, i) => {
      const b = beats[i]; if (!b) { m.visible = false; return; }
      const d = ((b.t - pos) / tr) * HL; m.visible = true;
      m.position.copy(S).addScaledVector(D, d).addScaledVector(N, 0.003);
      m.material.opacity = (b.bar ? 0.45 : 0.16) * clamp((HL - d) / 0.6, 0, 1);
      m.scale.y = b.bar ? 2 : 1;
    });
    // flashes
    const k = Math.min(1, dt * 8);
    for (const s of this.surfaces) {
      s.flash = Math.max(0, s.flash - dt * 6);
      s.ring.material.color.copy(s.col).lerp(new THREE.Color(0xffffff), s.flash * 0.7);
      if (!s.cym) s.skin.material.color.setHex(0x2a2440).lerp(s.col, s.flash * 0.6);
      else s.skin.material.opacity = 0.55 + s.flash * 0.35;
    }
    this.targets.forEach((m, lane) => { m.userData.flash = Math.max(0, m.userData.flash - dt * 5); m.material.opacity = 0.3 + m.userData.flash * 0.6; m.scale.set(1 + m.userData.flash * 0.15, 1, 1); });
    this.bass.flash = Math.max(0, this.bass.flash - dt * 6);
    this.bass.rim.material.color.setHex(KICK_COL).lerp(new THREE.Color(0xffffff), this.bass.flash * 0.6);
    this.kickLine.material.opacity = 0.45 + this.bass.flash * 0.5;
    // surge
    const sm = this.surge.meter;
    this.meterFill.scale.y = Math.max(0.001, sm); this.meterFill.position.y = S.y + 0.3 - 0.3 * (1 - sm);
    this.meterFill.material.color.setHex(this.surge.active ? 0xffffff : sm >= 0.5 ? GOLD : 0x9b8a5a);
    const ec = this.surge.active ? GOLD : 0x8a6cff;
    for (const e of this.edges) { e.material.color.lerp(new THREE.Color(ec), k); e.material.opacity = this.surge.active ? 0.95 : 0.8; }
  }
  _beatTimes(a, b) {
    const g = this.g, spb = 60000 / ((g.tempo && g.tempo.bpm) || 120), shift = g.shiftMs || 0;
    const out = [];
    if (g.beats && g.beats.length > 8) {
      for (let i = 0; i < g.beats.length && out.length < 28; i++) { const t = g.beats[i] + shift; if (t >= a - 50 && t <= b) out.push({ t, bar: false }); }
    } else {
      const off = ((g.tempo && g.tempo.offsetMs) || 0) + shift;
      for (let k = Math.ceil((a - off) / spb); out.length < 28; k++) { const t = off + k * spb; if (t > b) break; out.push({ t, bar: false }); }
    }
    // bars from the chart's crashes and kicks would be nicer; every 4th beat from the first note will do
    const first = this._firstT;
    if (first !== undefined) for (const x of out) x.bar = Math.abs(((Math.round((x.t - first) / spb) % 4) + 4) % 4) === 0;
    return out;
  }

  /** Per hand per frame: the stick tip passing down through a pad or cymbal is a hit. */
  handFrame(h, dt, live) {
    const g = this.g;
    if (!h.stick || g.style !== 'drums') return;
    h.stickPrev.copy(h.stickTip);
    h.stickTip.set(0, 0, -0.02 - STICK + 0.015).applyMatrix4(h.mesh.matrixWorld);
    const was = h.stickOk; h.stickOk = g.r.xr.isPresenting ? !!h.tracked : false;
    if (!live || !was || !h.stickOk || dt <= 0) return;
    const now = performance.now(); if (now - h.lastHitAt < 45) return;
    const big = this.big();
    for (const s of this.surfaces) {
      const d0 = this._v.subVectors(h.stickPrev, s.c).dot(s.n), d1 = this._w.subVectors(h.stickTip, s.c).dot(s.n);
      if (!(d0 > 0 && d1 <= 0 && d1 > -0.15)) continue;
      const speed = (d0 - d1) / dt; if (speed < 0.45) continue;
      const f = d0 / (d0 - d1); // where it crossed
      const cx = h.stickPrev.x + (h.stickTip.x - h.stickPrev.x) * f - s.c.x, cy = h.stickPrev.y + (h.stickTip.y - h.stickPrev.y) * f - s.c.y, cz = h.stickPrev.z + (h.stickTip.z - h.stickPrev.z) * f - s.c.z;
      const along = cx * s.n.x + cy * s.n.y + cz * s.n.z;
      const lat = Math.sqrt(Math.max(0, cx * cx + cy * cy + cz * cz - along * along));
      if (lat > s.r * big * 1.12) continue;
      h.lastHitAt = now;
      this.strike(s, clamp(speed / 4, 0.25, 1), h.hand);
      break;
    }
  }

  /** Screen: the sticks rest by the kit and swing at whatever pad was just played. */
  desktopHand(h) {
    const g = this.g, side = h.hand === 'L' ? -1 : 1;
    const base = new THREE.Vector3(side * 0.22, g.headY - 0.42, -0.08);
    const rest = new THREE.Vector3(side * 0.28, g.headY - 0.55, -0.45);
    let tip = rest;
    const a = this.dh[h.hand];
    if (a) {
      const age = (performance.now() - a.at) / 1000;
      if (age < 0.25) { const s = a.surf, lift = Math.min(1, age / 0.12) * 0.12; tip = new THREE.Vector3(s.x, s.y + g.headY + lift, s.z); }
    }
    h.mesh.position.copy(base);
    h.mesh.lookAt(base.clone().multiplyScalar(2).sub(tip));
    return true;
  }
}
