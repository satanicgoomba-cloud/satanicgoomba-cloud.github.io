// Play styles and modifiers, shared by the game, the menus and the results screen.

export const STYLES = {
  saber: { label: 'SLICE', desc: 'Sabers: slash cubes the way the arrow points, avoid mines, dodge walls' },
  ride: { label: 'RIDE', desc: 'Orbs: touch notes with the matching hand, ride the light rails, dodge walls' },
  shoot: { label: 'SHOOT', desc: 'Pistols: shoot enemies on the beat, dodge their bullets, whip close ones' },
};

// mult: score multiplier while the modifier is on. only: styles it applies to (others ignore it).
// off: modifiers it can't be combined with (turning this on turns those off).
export const MODS = {
  noFail: { label: 'NO FAIL', mult: 1, desc: 'Keep playing at zero energy. Score from then on is halved.', off: ['oneLife'] },
  oneLife: { label: 'ONE LIFE', mult: 1.1, desc: 'Any miss or hit ends the song.', off: ['noFail'] },
  fast: { label: 'FASTER', mult: 1.08, desc: 'Everything comes at you 25% faster.', off: ['slow'] },
  slow: { label: 'SLOWER', mult: 0.8, desc: 'Everything comes at you 25% slower.', off: ['fast'] },
  ghost: { label: 'GHOST NOTES', mult: 1.1, desc: 'Notes fade out before they reach you.', only: ['saber', 'ride'] },
  noArrows: { label: 'NO ARROWS', mult: 0.7, desc: 'Slice cubes any way you like.', only: ['saber'] },
  strict: { label: 'STRICT', mult: 1.12, desc: 'Tighter angles and aim, and mistakes drain more energy.' },
  noMines: { label: 'NO MINES', mult: 0.95, desc: 'No mines.', only: ['saber'] },
  noWalls: { label: 'NO WALLS', mult: 0.9, desc: 'No walls to dodge.' },
  noBullets: { label: 'BULLETPROOF', mult: 0.85, desc: 'Enemies never shoot back.', only: ['shoot'] },
  bigTargets: { label: 'BIG TARGETS', mult: 0.85, desc: 'Bigger notes, wider aim assist.', only: ['ride', 'shoot'] },
};

export const MOD_ORDER = Object.keys(MODS);

/** The modifiers that are on and apply to this style. */
export function activeMods(mods, style) {
  const out = {};
  for (const k of MOD_ORDER) if (mods && mods[k] && (!MODS[k].only || MODS[k].only.includes(style))) out[k] = true;
  return out;
}
export function modMultiplier(mods, style) {
  let m = 1;
  for (const k of Object.keys(activeMods(mods, style))) m *= MODS[k].mult;
  return Math.round(m * 100) / 100;
}
export function modLabels(mods, style) { return Object.keys(activeMods(mods, style)).map((k) => MODS[k].label); }
/** Toggle a modifier, turning off the ones it conflicts with. Returns a new object. */
export function toggleMod(mods, key) {
  const m = { ...(mods || {}) };
  m[key] = !m[key];
  if (m[key]) for (const o of MODS[key].off || []) m[o] = false;
  return m;
}
