// Weapon definitions — pure data, no behavior. The WeaponSystem interprets these.
// Schema:
//   id           string  unique key, also HUD label
//   name         string  display name
//   cooldown     float   seconds between shots
//   pattern      'spread' | 'single'
//   bullets      int     (spread only) number of bullets in the cone
//   spread       float   (spread only) total cone angle in radians
//   speed        float   bullet velocity (units/sec)
//   damage       float   per-bullet damage
//   pierce       int     hits absorbed before bullet dies (0 = first-hit kills bullet)
//   ttl          float   max lifetime in seconds
//   color        hex     instance tint
//   size         float   visual scale multiplier
//
// To add a weapon: append an entry here. The system picks it up automatically.
// Keep this list to <=2 entries per WO-02-G4 scope.

export const WEAPONS = Object.freeze({
  plasma: Object.freeze({
    id: 'plasma',
    name: 'PLASMA SPREAD',
    cooldown: 0.18,
    pattern: 'spread',
    bullets: 5,
    spread: Math.PI / 7,    // ~25 degree cone
    speed: 48,
    damage: 6,
    pierce: 0,
    ttl: 1.4,
    color: 0x6ad8ff,
    size: 1.0,
  }),
  rail: Object.freeze({
    id: 'rail',
    name: 'RAIL / PIERCE',
    cooldown: 0.85,
    pattern: 'single',
    bullets: 1,
    spread: 0,
    speed: 120,
    damage: 65,
    pierce: 8,
    ttl: 1.8,
    color: 0xff5cf2,
    size: 1.6,
  }),
});

export const WEAPON_ORDER = Object.freeze(['plasma', 'rail']);
