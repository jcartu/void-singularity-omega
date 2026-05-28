// MAGMA TITAN — Accretion biome boss.
// Silhouette: hulking molten sphere with revolving rock plates. Theme:
// gravity wells and ground hazards. Punishes camping.

import { ENEMY_TYPES } from '../enemies/types.js';

export const BOSS_DEF = Object.freeze({
  id: 'magma-titan',
  name: 'MAGMA TITAN',
  biome: 'accretion',
  size: 3.2,
  maxHp: 1700,
  contactDamage: 16,
  phaseTelegraph: 2.5,

  phases: [
    // Phase 1: Tectonic -----------------------------------------------------
    {
      id: 'titan-p1',
      hpThreshold: 1.0,
      enrageTime: 50,
      attacks: [
        {
          type: 'arenaHazard',
          telegraphDuration: 2.0, executionDuration: 0.0, cooldown: 8.5,
          params: { radius: 5.5, duration: 5.0, damagePerSec: 6, hazardKind: 'gravityWell' },
        },
        {
          type: 'radialBurst',
          telegraphDuration: 1.8, executionDuration: 0.0, cooldown: 5.0,
          params: { count: 16, speed: 13, damage: 10, ttl: 3.4, color: 0xff7a2a, size: 1.1 },
        },
      ],
    },

    // Phase 2: Mini wells + bullet storm ------------------------------------
    {
      id: 'titan-p2',
      hpThreshold: 0.66,
      enrageTime: 40,
      attacks: [
        {
          type: 'arenaHazard',
          telegraphDuration: 1.6, executionDuration: 0.0, cooldown: 5.5,
          params: { radius: 4.0, duration: 4.5, damagePerSec: 8, hazardKind: 'gravityWell' },
        },
        {
          type: 'radialBurst',
          telegraphDuration: 1.6, executionDuration: 0.0, cooldown: 3.8,
          params: { count: 22, speed: 16, damage: 9, ttl: 3.0, color: 0xff5a18, size: 1.0 },
        },
        {
          type: 'aimedVolley',
          telegraphDuration: 2.0, executionDuration: 0.0, cooldown: 5.0,
          params: { count: 4, spread: 0.45, speed: 18, damage: 12, color: 0xffb144, size: 1.6, ttl: 3.0 },
        },
      ],
    },

    // Phase 3: Lava zones + enrage ------------------------------------------
    {
      id: 'titan-p3',
      hpThreshold: 0.33,
      enrageTime: 20,
      attacks: [
        {
          type: 'arenaHazard',
          telegraphDuration: 1.8, executionDuration: 0.0, cooldown: 6.0,
          params: { radius: 5.0, duration: 7.0, damagePerSec: 14, hazardKind: 'lavaZone' },
        },
        {
          type: 'spiral',
          telegraphDuration: 2.0, executionDuration: 1.8, cooldown: 4.0,
          params: { count: 28, arms: 3, speed: 17, damage: 9, rotation: Math.PI * 2,
                    color: 0xff8a3c, size: 1.0, ttl: 3.4 },
        },
        {
          type: 'summon',
          telegraphDuration: 1.5, executionDuration: 0.0, cooldown: 15,
          params: { count: 2, type: ENEMY_TYPES.ORBITER, params: { health: 30 } },
        },
      ],
    },
  ],
});

export default BOSS_DEF;
