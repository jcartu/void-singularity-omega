// HORIZON EATER — Event Horizon biome boss.
// Silhouette: collapsed ring with an inward-falling halo. Gravity-themed.
// Heavy single hits in P1, hard pulls + curtains P2, spiral collapse P3.

import { ENEMY_TYPES } from '../enemies/types.js';

export const BOSS_DEF = Object.freeze({
  id: 'horizon-eater',
  name: 'HORIZON EATER',
  biome: 'event-horizon',
  size: 3.0,
  maxHp: 1900,
  contactDamage: 18,
  phaseTelegraph: 2.8,

  phases: [
    // Phase 1: Slow gravity pulses -----------------------------------------
    {
      id: 'eater-p1',
      hpThreshold: 1.0,
      enrageTime: 45,
      attacks: [
        {
          type: 'arenaHazard',
          telegraphDuration: 2.4, executionDuration: 0.0, cooldown: 7.0,
          params: { radius: 12, duration: 3.5, damagePerSec: 4, hazardKind: 'gravityPulse',
                    pullToward: 'boss', strength: 18 },
        },
        {
          type: 'radialBurst',
          telegraphDuration: 2.0, executionDuration: 0.0, cooldown: 5.5,
          params: { count: 12, speed: 11, damage: 12, ttl: 4.2, color: 0x8a45ff, size: 1.5 },
        },
      ],
    },

    // Phase 2: Curtains + horizon pull -------------------------------------
    {
      id: 'eater-p2',
      hpThreshold: 0.66,
      enrageTime: 36,
      attacks: [
        {
          type: 'arenaHazard',
          telegraphDuration: 2.2, executionDuration: 0.0, cooldown: 8.0,
          params: { radius: 18, duration: 5.0, damagePerSec: 4, hazardKind: 'gravityPulse',
                    pullToward: 'horizon', strength: 26 },
        },
        {
          type: 'spiral',
          telegraphDuration: 2.0, executionDuration: 2.0, cooldown: 5.0,
          params: { count: 26, arms: 4, speed: 13, damage: 9, rotation: Math.PI * 2,
                    color: 0x9a4cff, size: 1.0, ttl: 4.5 },
        },
        {
          type: 'aimedVolley',
          telegraphDuration: 2.2, executionDuration: 0.0, cooldown: 6.0,
          params: { count: 3, spread: 0.05, speed: 30, damage: 14, color: 0xc9a4ff,
                    size: 1.4, ttl: 2.6 },
        },
      ],
    },

    // Phase 3: Escalating gravity + spiral death ---------------------------
    {
      id: 'eater-p3',
      hpThreshold: 0.33,
      enrageTime: 20,
      attacks: [
        {
          type: 'arenaHazard',
          telegraphDuration: 2.6, executionDuration: 0.0, cooldown: 11,
          params: { radius: 24, duration: 10.0, damagePerSec: 6, hazardKind: 'gravityPulse',
                    pullToward: 'horizon', strength: 36, escalates: true },
        },
        {
          type: 'spiral',
          telegraphDuration: 2.0, executionDuration: 2.2, cooldown: 4.0,
          params: { count: 32, arms: 4, speed: 15, damage: 9, rotation: Math.PI * 2,
                    color: 0x9a4cff, size: 1.0, ttl: 4.0 },
        },
        {
          type: 'radialBurst',
          telegraphDuration: 1.6, executionDuration: 0.0, cooldown: 3.8,
          params: { count: 24, speed: 19, damage: 9, ttl: 3.2, color: 0xc9a4ff, size: 1.0 },
        },
        {
          type: 'summon',
          telegraphDuration: 1.5, executionDuration: 0.0, cooldown: 14,
          params: { count: 3, type: ENEMY_TYPES.ORBITER, params: { health: 30 } },
        },
      ],
    },
  ],
});

export default BOSS_DEF;
