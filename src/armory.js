import * as THREE from 'three';

// STILL style's weapons and the weapon table. No reloading: when a weapon is spent you throw it and grab
// another from the table, which sits around your waist and refills each slot a few seconds after you take it.
// Models point along -Z (the controller's aiming ray), grip at the origin.

export const WEAPONS = {
  pistol: { label: 'PISTOL', kind: 'gun', ammo: 6, auto: false, cd: 0.16, dmg: 1, assist: 6, power: 6, muzzle: -0.16, reach: 0.38, throwSpeed: 8 },
  smg: { label: 'SMG', kind: 'gun', ammo: 24, auto: true, cd: 0.085, dmg: 1, assist: 7, power: 4, muzzle: -0.24, reach: 0.4, throwSpeed: 8 },
  rifle: { label: 'RIFLE', kind: 'gun', ammo: 15, auto: true, cd: 0.15, dmg: 2, assist: 4, power: 9, muzzle: -0.5, reach: 0.5, throwSpeed: 7 },
  kunai: { label: 'KUNAI', kind: 'blade', ammo: 1, power: 7, reach: 0.45, throwSpeed: 15 },
  shuriken: { label: 'SHURIKEN', kind: 'star', ammo: 3, power: 5, reach: 0.32, throwSpeed: 17 },
  axe: { label: 'AXE', kind: 'heavy', ammo: 1, power: 12, reach: 0.62, throwSpeed: 10 },
};
export const ORDER = ['pistol', 'smg', 'rifle', 'kunai', 'shuriken', 'axe'];
const REGEN = 3;          // seconds (game time) for a slot to refill

const metal = new THREE.MeshStandardMaterial({ color: 0x23202e, metalness: 0.85, roughness: 0.3 });
const steel = new THREE.MeshStandardMaterial({ color: 0xc9d2dc, metalness: 0.9, roughness: 0.2 });
const wood = new THREE.MeshStandardMaterial({ color: 0x6b4426, roughness: 0.8 });
const wrap = new THREE.MeshStandardMaterial({ color: 0x1b1720, roughness: 0.9 });
const box = (w, h, d, mat, x = 0, y = 0, z = 0, rx = 0) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); m.rotation.x = rx; return m; };

/** A model of a weapon, with a stripe in the hand's colour. */
export function weaponModel(type, color = 0xffffff) {
  const g = new THREE.Group(), accent = new THREE.MeshBasicMaterial({ color });
  if (type === 'pistol') {
    g.add(box(0.032, 0.042, 0.2, metal, 0, 0.012, -0.05), box(0.028, 0.1, 0.042, metal, 0, -0.04, 0.02, 0.28), box(0.034, 0.008, 0.2, accent, 0, 0.03, -0.05));
  } else if (type === 'smg') {
    g.add(box(0.04, 0.06, 0.26, metal, 0, 0.015, -0.08), box(0.028, 0.1, 0.04, metal, 0, -0.045, 0.02, 0.25),
      box(0.026, 0.13, 0.03, metal, 0, -0.06, -0.12), box(0.016, 0.016, 0.08, metal, 0, 0.02, -0.25), box(0.042, 0.008, 0.2, accent, 0, 0.048, -0.08));
  } else if (type === 'rifle') {
    g.add(box(0.042, 0.06, 0.52, metal, 0, 0.015, -0.17), box(0.03, 0.05, 0.16, metal, 0, 0.0, 0.16), box(0.028, 0.1, 0.04, metal, 0, -0.045, 0.02, 0.25),
      box(0.028, 0.14, 0.04, metal, 0, -0.07, -0.13, -0.3), box(0.014, 0.014, 0.1, metal, 0, 0.022, -0.48), box(0.044, 0.008, 0.36, accent, 0, 0.048, -0.17));
  } else if (type === 'kunai') {
    const blade = new THREE.Mesh(new THREE.OctahedronGeometry(1, 0), steel); blade.scale.set(0.024, 0.006, 0.1); blade.position.z = -0.15;
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.11, 8), wrap); handle.rotation.x = Math.PI / 2; handle.position.z = -0.0;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.018, 0.004, 6, 14), accent); ring.position.z = 0.07; ring.rotation.y = Math.PI / 2;
    g.add(blade, handle, ring);
  } else if (type === 'shuriken') {
    const s = new THREE.Group();
    for (let i = 0; i < 4; i++) { const p = new THREE.Mesh(new THREE.OctahedronGeometry(1, 0), steel); p.scale.set(0.014, 0.003, 0.055); p.position.set(Math.sin(i * Math.PI / 2) * 0.045, 0, Math.cos(i * Math.PI / 2) * 0.045); p.rotation.y = i * Math.PI / 2; s.add(p); }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.006, 12), accent); s.add(hub);
    s.position.z = -0.07; g.add(s); g.userData.spinner = s;
  } else if (type === 'axe') {
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.017, 0.46, 8), wood); handle.rotation.x = Math.PI / 2; handle.position.z = -0.18;
    const head = box(0.016, 0.11, 0.09, steel, 0, 0.05, -0.38);
    const edge = box(0.006, 0.13, 0.02, accent, 0, 0.055, -0.33);
    g.add(handle, head, edge, box(0.03, 0.03, 0.04, metal, 0, 0, 0.06));
  }
  return g;
}

/** The weapon table: a curved shelf at your waist with one slot per weapon. */
export class WeaponTable {
  constructor(scene) {
    this.group = new THREE.Group(); this.group.visible = false; scene.add(this.group);
    const R = 0.52, span = THREE.MathUtils.degToRad(150);
    const shelf = new THREE.Mesh(new THREE.RingGeometry(R - 0.09, R + 0.09, 40, 1, Math.PI / 2 - span / 2 - 0.12, span + 0.24),
      new THREE.MeshStandardMaterial({ color: 0x1a1726, metalness: 0.4, roughness: 0.5, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
    shelf.rotation.x = -Math.PI / 2; this.group.add(shelf); // arc in front of you (-Z), left to right
    const edge = new THREE.Mesh(new THREE.TorusGeometry(R + 0.09, 0.004, 4, 60, span + 0.24), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }));
    edge.rotation.x = Math.PI / 2; edge.rotation.z = (3 * Math.PI) / 2 - span / 2 - 0.12; this.group.add(edge);
    this.slots = ORDER.map((type, i) => {
      const a = -span / 2 + (span * i) / (ORDER.length - 1);       // left to right around you
      const at = new THREE.Vector3(Math.sin(a) * R, 0, -Math.cos(a) * R);
      const pad = new THREE.Mesh(new THREE.RingGeometry(0.05, 0.065, 28), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
      pad.rotation.x = -Math.PI / 2; pad.position.copy(at).setY(0.004); this.group.add(pad);
      const fill = new THREE.Mesh(new THREE.CircleGeometry(0.05, 28), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, side: THREE.DoubleSide }));
      fill.rotation.x = -Math.PI / 2; fill.position.copy(at).setY(0.003); this.group.add(fill);
      const model = weaponModel(type, 0xffffff); model.position.copy(at).setY(0.09); this.group.add(model);
      return { type, at, pad, fill, model, ready: true, t: 0, spin: i };
    });
    this._v = new THREE.Vector3();
  }

  reset() { for (const s of this.slots) { s.ready = true; s.t = 0; } }

  /** Keep it at your waist (the play space doesn't move; the world scrolls past). */
  update(dt, headY, show) {
    this.group.visible = show; if (!show) return;
    this.group.position.set(0, Math.max(0.55, headY - 0.72), 0);
    for (const s of this.slots) {
      if (!s.ready) { s.t += dt; if (s.t >= REGEN) { s.ready = true; s.t = 0; } }
      s.spin += dt * 0.8;
      s.model.visible = s.ready;
      s.model.rotation.y = s.spin; s.model.position.y = 0.09 + Math.sin(s.spin * 2) * 0.01;
      const k = s.ready ? 1 : s.t / REGEN;
      s.fill.scale.setScalar(Math.max(0.01, k)); s.fill.material.opacity = s.ready ? 0.35 : 0.15;
      s.pad.material.opacity = s.ready ? 0.8 : 0.3;
    }
  }

  /** The ready slot closest to a hand (within reach), or null. */
  near(handPos, reach = 0.17) {
    let best = null, bd = reach;
    for (const s of this.slots) {
      if (!s.ready) continue;
      const d = this.group.localToWorld(this._v.copy(s.at).setY(0.09)).distanceTo(handPos);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }
  take(slot) { slot.ready = false; slot.t = 0; return slot.type; }
}
