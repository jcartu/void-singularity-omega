// Enemy type registry — shared constants. Three behaviors only (S05 scope):
//   - 'chaser'  : closes distance and rams the player.
//   - 'shooter' : maintains stand-off range and lobs lead-aimed projectiles.
//   - 'orbiter' : orbits the gravity well in a fixed-radius ring.
//
// Boss behaviors are deferred to SPRINT-06.

export const ENEMY_TYPES = Object.freeze({
  CHASER: 'chaser',
  SHOOTER: 'shooter',
  ORBITER: 'orbiter',
});

export const ENEMY_DEFAULTS = Object.freeze({
  chaser: Object.freeze({
    maxSpeed: 16,
    accel: 38,
    health: 30,
    contactDamage: 18,
    contactRadius: 1.1,
    color: 0xff5066,
    radius: 0.85,
  }),
  shooter: Object.freeze({
    maxSpeed: 9,
    accel: 22,
    health: 22,
    color: 0xff9a3a,
    radius: 0.8,
    // Stand-off envelope: try to keep player within [preferredMin, preferredMax].
    preferredMin: 14,
    preferredMax: 22,
    fireInterval: 1.05,
    fireSpread: 0.04,        // radians
    bulletSpeed: 30,
    bulletDamage: 8,
    bulletTtl: 2.4,
    bulletColor: 0xffd56b,
  }),
  orbiter: Object.freeze({
    maxSpeed: 24,
    health: 38,
    color: 0x9d6bff,
    radius: 0.9,
    contactDamage: 14,
    contactRadius: 1.0,
    // Geometry of the orbit. The director chooses radius/dir on spawn.
    defaultOrbitRadius: 11,
    angularSpeed: 0.85,      // rad/sec at default radius
  }),
});
