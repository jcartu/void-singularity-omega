// Weapon definitions — pure data, frozen. The WeaponSystem interprets these.
//
// Two classes of weapons coexist:
//   - PRIMARIES: held-fire, no energy cost, gated by `fireRate` (== `cooldown`).
//   - SECONDARIES: one-shot specials, gated by `cooldown` AND `energyCost`.
//
// The `behavior` string is the dispatch tag the system reads:
//   'straight' | 'spread' | 'homing' | 'beam' | 'ricochet'
//   'arc'      | 'aoe'    | 'slow'   | 'gravity' | 'drone'
//
// Schema (all weapons):
//   id           string  unique key
//   name         string  display name
//   type         'primary' | 'secondary'
//   fireRate     float   primaries: seconds between shots
//   cooldown     float   seconds the weapon is locked after firing
//   bulletCount  int     bullets emitted per trigger
//   spread       float   total cone angle (rad); 0 = no spread
//   speed        float   bullet velocity (units/sec)
//   damage       float   per-bullet (or per-tick) damage
//   pierce       int     hits absorbed before bullet dies
//   ttl          float   bullet lifetime (s)
//   color        hex     instance tint
//   size         float   visual radius multiplier
//   energyCost   float   0 for primaries
//   behavior     string  dispatch tag (see above)
//   hudIcon      string  single-glyph HUD label
//
// Behavior-specific fields (read by WeaponSystem when behavior matches):
//   homing:    homingFovDeg, homingTurnRate (rad/s)
//   ricochet:  bounces (int, total redirects)
//   arc:       arcGravity (units/s^2, +Y downward pull), arcUpKick (initial vy)
//   aoe:       aoeRadius (units), aoeDamage (override)
//   slow:      slowFactor (0..1 velocity multiplier), slowDuration, slowRadius, slowConeDeg
//   gravity:   wellDuration, wellMass, wellRadius
//   drone:     droneCount, droneDuration, droneFireRate, droneOrbitRadius, droneDamage
//
// To add a weapon: append to WEAPONS, then list its id in WEAPON_ORDER (primary)
// or SECONDARY_ORDER. Cycle/HUD pick it up automatically.

export const WEAPONS = Object.freeze({
  // ---------- PRIMARIES ----------
  plasma: Object.freeze({
    id: 'plasma',
    name: 'PLASMA SPREAD',
    type: 'primary',
    fireRate: 0.18,
    cooldown: 0.18,
    bulletCount: 5,
    spread: Math.PI / 7,         // ~25° cone
    speed: 48,
    damage: 6,
    pierce: 0,
    ttl: 1.4,
    color: 0x6ad8ff,
    size: 1.0,
    energyCost: 0,
    behavior: 'spread',
    hudIcon: 'P',
  }),

  rail: Object.freeze({
    id: 'rail',
    name: 'RAIL / PIERCE',
    type: 'primary',
    fireRate: 0.85,
    cooldown: 0.85,
    bulletCount: 1,
    spread: 0,
    speed: 120,
    damage: 65,
    pierce: 8,
    ttl: 1.8,
    color: 0xff5cf2,
    size: 1.6,
    energyCost: 0,
    behavior: 'straight',
    hudIcon: 'R',
  }),

  homing: Object.freeze({
    id: 'homing',
    name: 'HOMING SWARM',
    type: 'primary',
    fireRate: 0.6,
    cooldown: 0.6,
    bulletCount: 3,
    spread: Math.PI / 5,         // initial fan ~36°
    speed: 42,
    damage: 14,
    pierce: 0,
    ttl: 3.2,
    color: 0xffd16a,
    size: 1.1,
    energyCost: 0,
    behavior: 'homing',
    hudIcon: 'H',
    homingFovDeg: 120,
    homingTurnRate: 4.5,         // rad/s steering
  }),

  beam: Object.freeze({
    id: 'beam',
    name: 'PHOTON BEAM',
    type: 'primary',
    fireRate: 0.05,
    cooldown: 0.05,
    bulletCount: 1,
    spread: 0,
    speed: 180,
    damage: 4,
    pierce: 1,
    ttl: 0.5,
    color: 0xa6ffea,
    size: 0.6,
    energyCost: 0,
    behavior: 'beam',
    hudIcon: 'B',
  }),

  ricochet: Object.freeze({
    id: 'ricochet',
    name: 'RICOCHET',
    type: 'primary',
    fireRate: 0.4,
    cooldown: 0.4,
    bulletCount: 1,
    spread: 0,
    speed: 70,
    damage: 22,
    pierce: 0,
    ttl: 4.0,
    color: 0xa0ff60,
    size: 1.2,
    energyCost: 0,
    behavior: 'ricochet',
    hudIcon: 'C',                // chevron-ish
    bounces: 4,
  }),

  voidlob: Object.freeze({
    id: 'voidlob',
    name: 'VOID LOB',
    type: 'primary',
    fireRate: 1.2,
    cooldown: 1.2,
    bulletCount: 1,
    spread: 0,
    speed: 32,
    damage: 40,
    pierce: 0,
    ttl: 2.4,
    color: 0xc06bff,
    size: 1.5,
    energyCost: 0,
    behavior: 'arc',
    hudIcon: 'V',
    arcGravity: 18,
    arcUpKick: 14,
    aoeRadius: 4.5,
    aoeDamage: 60,
  }),

  // ---------- SECONDARIES / SPECIALS ----------
  dash_nuke: Object.freeze({
    id: 'dash_nuke',
    name: 'DASH NUKE',
    type: 'secondary',
    fireRate: 4.0,
    cooldown: 4.0,
    bulletCount: 1,
    spread: 0,
    speed: 22,
    damage: 80,
    pierce: 0,
    ttl: 1.2,
    color: 0xff3060,
    size: 2.4,
    energyCost: 50,
    behavior: 'aoe',
    hudIcon: 'N',
    aoeRadius: 8.0,
    aoeDamage: 140,
  }),

  time_dilation: Object.freeze({
    id: 'time_dilation',
    name: 'TIME DILATION',
    type: 'secondary',
    fireRate: 8.0,
    cooldown: 8.0,
    bulletCount: 0,
    spread: Math.PI / 2,         // 90° cone
    speed: 0,
    damage: 0,
    pierce: 0,
    ttl: 3.0,
    color: 0x70d8ff,
    size: 1.0,
    energyCost: 40,
    behavior: 'slow',
    hudIcon: 'T',
    slowFactor: 0.25,
    slowDuration: 3.0,
    slowRadius: 22,
    slowConeDeg: 90,
  }),

  singularity_grenade: Object.freeze({
    id: 'singularity_grenade',
    name: 'SINGULARITY',
    type: 'secondary',
    fireRate: 10.0,
    cooldown: 10.0,
    bulletCount: 1,
    spread: 0,
    speed: 28,
    damage: 0,
    pierce: 0,
    ttl: 0.7,                    // travel time before deployment
    color: 0x9b6bff,
    size: 1.8,
    energyCost: 60,
    behavior: 'gravity',
    hudIcon: 'G',
    wellDuration: 4.0,
    wellMass: 1.6,
    wellRadius: 12,
  }),

  drone_swarm: Object.freeze({
    id: 'drone_swarm',
    name: 'DRONE SWARM',
    type: 'secondary',
    fireRate: 15.0,
    cooldown: 15.0,
    bulletCount: 0,
    spread: 0,
    speed: 60,                   // drone bullet speed
    damage: 8,                   // per drone bullet
    pierce: 0,
    ttl: 1.0,
    color: 0xffaa66,
    size: 0.8,
    energyCost: 45,
    behavior: 'drone',
    hudIcon: 'D',
    droneCount: 3,
    droneDuration: 15.0,
    droneFireRate: 0.55,
    droneOrbitRadius: 2.6,
    droneDamage: 8,
  }),
});

// Primaries — used by cycle() and keys 1..6.
export const WEAPON_ORDER = Object.freeze([
  'plasma', 'rail', 'homing', 'beam', 'ricochet', 'voidlob',
]);

// Secondaries — fired explicitly by id (no cycle for now).
export const SECONDARY_ORDER = Object.freeze([
  'dash_nuke', 'time_dilation', 'singularity_grenade', 'drone_swarm',
]);

// Convenience: every weapon, in HUD display order.
export const ALL_WEAPONS_ORDER = Object.freeze([
  ...WEAPON_ORDER,
  ...SECONDARY_ORDER,
]);
