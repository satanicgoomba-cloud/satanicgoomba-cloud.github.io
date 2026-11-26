// Constants shared by the game and its play styles.
export const COLORS = { L: 0xff2d6f, R: 0x00e5ff };
export const SPAWN_DIST = 16;       // notes appear this far down the track

// Energy (the fail bar): starts half full; hits fill it, mistakes drain it, empty = song failed.
export const ENERGY = {
  saber: { start: 0.5, hit: 0.01, miss: -0.14, bad: -0.1, mine: -0.15, wall: -0.12, wallPerSec: -0.5 },
  ride: { start: 0.5, hit: 0.012, miss: -0.12, bad: -0.08, rail: 0.04, railMiss: -0.12, wall: -0.12, wallPerSec: -0.5 },
  shoot: { start: 1, hit: 0.03, whip: 0.25, bullet: -0.4, wall: -0.15, wallPerSec: -0.5, miss: 0 },
};
ENERGY.still = ENERGY.shoot;
ENERGY.tap = { start: 1, hit: 0.03, tick: 0.008, miss: -0.1, drain: -0.012, wall: 0, wallPerSec: 0 };
