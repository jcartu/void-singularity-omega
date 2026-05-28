// VOID REAVER — Nebula biome boss.
// Silhouette: bladed crescent wading through fog. Phases escalate from clean
// radial geometry to fog-soaked chaos with summoned chasers.
// Schema: matches BossCore (boss-core.js) — { type, telegraphDuration,
// executionDuration, cooldown, params }.

import { ENEMY_TYPES } from '../enemies/types.js';

export const BOSS_DEF = Object.freeze({
  id: 'void-reaver',
  name: 'VOID REAVER',
  biome: 'nebula',
  size: 2.6,
  maxHp: 1200,
  contactDamage: 12,
  phaseTelegraph: 2.5,

  phases: [
    // Phase 1: Geometric ----------------------------------------------------
    {
      id: 'reaver-p1',
      hpThreshold: 1.0,
      enrageTime: 45,
      attacks: [
        {
          type: 'radialBurst',
          telegraphDuration: 1.8, executionDuration: 0.0, cooldown: 4.2,
          params: { count: 14, speed: 14, damage: 9, ttl: 3.2, color: 0xb37bff, size: 1.0 },
        },
        {
          type: 'spiral',
          telegraphDuration: 2.4, executionDuration: 1.4, cooldown: 5.6,
          params: { count: 18, arms: 2, speed: 11, damage: 7, rotation: Math.PI * 2,
                    color: 0x9d6bff, size: 1.0, ttl: 4.0 },
        },
      ],
    },

    // Phase 2: Aimed pressure + chaser adds ---------------------------------
    {
      id: 'reaver-p2',
      hpThreshold: 0.66,
      enrageTime: 35,
      attacks: [
        {
          type: 'radialBurst',
          telegraphDuration: 1.6, executionDuration: 0.0, cooldown: 3.6,
          params: { count: 18, speed: 16, damage: 9, ttl: 3.0, color: 0xb37bff, size: 1.0 },
        },
        {
          type: 'aimedVolley',
          telegraphDuration: 1.8, executionDuration: 0.0, cooldown: 4.5,
          params: { count: 5, spread: 0.22, speed: 24, damage: 11, color: 0xc9a4ff, size: 1.2, ttl: 2.6 },
        },
        {
          type: 'summon',
          telegraphDuration: 1.5, executionDuration: 0.0, cooldown: 14,
          params: { count: 3, type: ENEMY_TYPES.CHASER, params: { health: 24, maxSpeed: 18 } },
        },
      ],
    },

    // Phase 3: Fog + rapid fire ---------------------------------------------
    {
      id: 'reaver-p3',
      hpThreshold: 0.33,
      enrageTime: 25,
      attacks: [
        {
          type: 'arenaHazard',
          telegraphDuration: 1.5, executionDuration: 0.0, cooldown: 11,
          params: { radius: 6, duration: 8.0, damagePerSec: 4, hazardKind: 'fog' },
        },
        {
          type: 'spiral',
          telegraphDuration: 1.8, executionDuration: 1.6, cooldown: 3.2,
          params: { count: 26, arms: 3, speed: 15, damage: 8, rotation: Math.PI * 2,
                    color: 0xb37bff, size: 1.0, ttl: 3.5 },
        },
        {
          type: 'aimedVolley',
          telegraphDuration: 1.6, executionDuration: 0.0, cooldown: 3.0,
          params: { count: 7, spread: 0.30, speed: 28, damage: 10, color: 0xd9b3ff, size: 1.2, ttl: 2.4 },
        },
      ],
    },
  ],
});

export default BOSS_DEF;
