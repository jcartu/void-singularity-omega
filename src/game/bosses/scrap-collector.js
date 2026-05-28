// SCRAP COLLECTOR — Debris biome boss.
// Silhouette: ramshackle hauler trailing a cloud of debris cover. Plays
// cover-and-peek in P1, breaks its own cover in P2, debris storm + movement P3.

import { ENEMY_TYPES } from '../enemies/types.js';

export const BOSS_DEF = Object.freeze({
  id: 'scrap-collector',
  name: 'SCRAP COLLECTOR',
  biome: 'debris',
  size: 2.8,
  maxHp: 1600,
  contactDamage: 14,
  phaseTelegraph: 2.5,

  phases: [
    // Phase 1: Cover + ricochet --------------------------------------------
    {
      id: 'scrap-p1',
      hpThreshold: 1.0,
      enrageTime: 50,
      attacks: [
        {
          type: 'arenaHazard',
          telegraphDuration: 1.5, executionDuration: 0.0, cooldown: 16,
          params: { radius: 7, duration: 14, damagePerSec: 0, hazardKind: 'debrisCover',
                    plates: 5, plateHp: 60 },
        },
        {
          type: 'aimedVolley',
          telegraphDuration: 1.8, executionDuration: 0.0, cooldown: 4.0,
          params: { count: 3, spread: 0.12, speed: 22, damage: 10, color: 0xffe06b,
                    size: 1.2, ttl: 3.2, ricochet: 2 },
        },
        {
          type: 'radialBurst',
          telegraphDuration: 1.6, executionDuration: 0.0, cooldown: 5.5,
          params: { count: 10, speed: 14, damage: 7, ttl: 3.0, color: 0xcfa050, size: 1.0 },
        },
      ],
    },

    // Phase 2: Breaks cover, aimed lances -----------------------------------
    {
      id: 'scrap-p2',
      hpThreshold: 0.66,
      enrageTime: 36,
      attacks: [
        {
          type: 'arenaHazard',
          telegraphDuration: 2.2, executionDuration: 0.0, cooldown: 18,
          params: { radius: 9, duration: 2.0, damagePerSec: 8, hazardKind: 'debrisShatter',
                    shrapnelCount: 14, shrapnelSpeed: 16, shrapnelDamage: 8 },
        },
        {
          type: 'aimedVolley',
          telegraphDuration: 1.8, executionDuration: 0.0, cooldown: 3.5,
          params: { count: 5, spread: 0.10, speed: 28, damage: 12, color: 0xffd060,
                    size: 1.2, ttl: 2.4 },
        },
        {
          type: 'radialBurst',
          telegraphDuration: 1.6, executionDuration: 0.0, cooldown: 4.4,
          params: { count: 18, speed: 17, damage: 8, ttl: 3.0, color: 0xcfa050, size: 1.0 },
        },
      ],
    },

    // Phase 3: Debris storm + summons ---------------------------------------
    {
      id: 'scrap-p3',
      hpThreshold: 0.33,
      enrageTime: 22,
      attacks: [
        {
          type: 'arenaHazard',
          telegraphDuration: 2.0, executionDuration: 0.0, cooldown: 14,
          params: { radius: 22, duration: 12, damagePerSec: 6, hazardKind: 'debrisStorm',
                    spawnRate: 8 },
        },
        {
          type: 'spiral',
          telegraphDuration: 1.8, executionDuration: 1.5, cooldown: 4.0,
          params: { count: 22, arms: 2, speed: 16, damage: 8, rotation: Math.PI * 2,
                    color: 0xcfa050, size: 1.0, ttl: 3.2 },
        },
        {
          type: 'summon',
          telegraphDuration: 1.5, executionDuration: 0.0, cooldown: 16,
          params: { count: 4, type: ENEMY_TYPES.CHASER,
                    params: { health: 24, maxSpeed: 20 } },
        },
      ],
    },
  ],
});

export default BOSS_DEF;
