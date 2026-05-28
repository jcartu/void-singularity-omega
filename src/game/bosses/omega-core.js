// SINGULARITY CORE — OMEGA final boss.
// Silhouette: fractured spherical core inside three counter-rotating shells.
// Four phases that recombine prior boss mechanics before collapsing into a
// final enrage. Threshold gating uses the BossCore convention (fraction
// remaining ≤ threshold triggers the phase).

import { ENEMY_TYPES } from '../enemies/types.js';

export const BOSS_DEF = Object.freeze({
  id: 'omega-core',
  name: 'SINGULARITY CORE',
  biome: 'omega',
  size: 3.6,
  maxHp: 3200,
  contactDamage: 20,
  phaseTelegraph: 3.0,

  phases: [
    // Phase 1: Echoes of Reaver + Warden -----------------------------------
    {
      id: 'omega-p1',
      hpThreshold: 1.0,
      enrageTime: 55,
      attacks: [
        {
          type: 'spiral',
          telegraphDuration: 2.2, executionDuration: 1.8, cooldown: 5.5,
          params: { count: 22, arms: 3, speed: 14, damage: 9, rotation: Math.PI * 2,
                    color: 0xb37bff, size: 1.0, ttl: 3.8 },
        },
        {
          type: 'sweep',
          telegraphDuration: 1.8, executionDuration: 0.9, cooldown: 4.5,
          params: { length: 20, width: 2.6, speed: 24, damage: 9, segments: 11,
                    color: 0x66e0ff, size: 0.9, ttl: 2.4 },
        },
        {
          type: 'radialBurst',
          telegraphDuration: 1.8, executionDuration: 0.0, cooldown: 6.0,
          params: { count: 18, speed: 17, damage: 9, ttl: 3.0, color: 0xff44e6, size: 1.0 },
        },
      ],
    },

    // Phase 2: Titan + Collector + Eater fusion ----------------------------
    {
      id: 'omega-p2',
      hpThreshold: 0.70,
      enrageTime: 45,
      attacks: [
        {
          type: 'arenaHazard',
          telegraphDuration: 1.8, executionDuration: 0.0, cooldown: 7.5,
          params: { radius: 5.5, duration: 5.0, damagePerSec: 6, hazardKind: 'gravityWell' },
        },
        {
          type: 'arenaHazard',
          telegraphDuration: 1.6, executionDuration: 0.0, cooldown: 6.5,
          params: { radius: 4.5, duration: 6.0, damagePerSec: 12, hazardKind: 'lavaZone' },
        },
        {
          type: 'aimedVolley',
          telegraphDuration: 1.8, executionDuration: 0.0, cooldown: 4.0,
          params: { count: 5, spread: 0.14, speed: 26, damage: 11, color: 0xffd060,
                    size: 1.2, ttl: 2.6 },
        },
        {
          type: 'arenaHazard',
          telegraphDuration: 2.2, executionDuration: 0.0, cooldown: 9.0,
          params: { radius: 18, duration: 4.5, damagePerSec: 4, hazardKind: 'gravityPulse',
                    pullToward: 'boss', strength: 24 },
        },
        {
          type: 'spiral',
          telegraphDuration: 1.8, executionDuration: 1.6, cooldown: 5.5,
          params: { count: 20, arms: 2, speed: 14, damage: 8, rotation: Math.PI * 2,
                    color: 0x9a4cff, size: 1.0, ttl: 3.4 },
        },
      ],
    },

    // Phase 3: Singularity collapse — arena shrink + omni-attack -----------
    {
      id: 'omega-p3',
      hpThreshold: 0.40,
      enrageTime: 35,
      attacks: [
        {
          type: 'arenaHazard',
          telegraphDuration: 3.0, executionDuration: 0.0, cooldown: 999,
          params: { radius: 14, duration: 999, damagePerSec: 0, hazardKind: 'arenaShrink',
                    shrinkSpeed: 0.35 },
        },
        {
          type: 'radialBurst',
          telegraphDuration: 1.6, executionDuration: 0.0, cooldown: 4.0,
          params: { count: 26, speed: 18, damage: 9, ttl: 3.0, color: 0xff44e6, size: 1.0 },
        },
        {
          type: 'spiral',
          telegraphDuration: 2.0, executionDuration: 1.8, cooldown: 5.0,
          params: { count: 30, arms: 4, speed: 16, damage: 9, rotation: Math.PI * 2,
                    color: 0xff66f2, size: 1.0, ttl: 3.6 },
        },
        {
          type: 'sweep',
          telegraphDuration: 1.6, executionDuration: 0.8, cooldown: 3.8,
          params: { length: 22, width: 3.0, speed: 26, damage: 9, segments: 13,
                    color: 0x88f0ff, size: 0.9, ttl: 2.4 },
        },
        {
          type: 'aimedVolley',
          telegraphDuration: 1.8, executionDuration: 0.0, cooldown: 5.0,
          params: { count: 7, spread: 0.30, speed: 28, damage: 11, color: 0xffd060,
                    size: 1.2, ttl: 2.4 },
        },
        {
          type: 'summon',
          telegraphDuration: 1.5, executionDuration: 0.0, cooldown: 18,
          params: { count: 4, type: ENEMY_TYPES.CHASER, params: { health: 26, maxSpeed: 20 } },
        },
      ],
    },

    // Phase 4: Final enrage — rapid everything -----------------------------
    {
      id: 'omega-p4',
      hpThreshold: 0.15,
      enrageTime: 999,
      attacks: [
        {
          type: 'radialBurst',
          telegraphDuration: 1.5, executionDuration: 0.0, cooldown: 2.4,
          params: { count: 32, speed: 22, damage: 10, ttl: 3.0, color: 0xff66f2, size: 1.0 },
        },
        {
          type: 'spiral',
          telegraphDuration: 1.5, executionDuration: 1.4, cooldown: 3.0,
          params: { count: 36, arms: 5, speed: 18, damage: 9, rotation: Math.PI * 2,
                    color: 0xff44e6, size: 1.0, ttl: 3.4 },
        },
        {
          type: 'sweep',
          telegraphDuration: 1.5, executionDuration: 0.6, cooldown: 2.6,
          params: { length: 24, width: 3.4, speed: 28, damage: 9, segments: 15,
                    color: 0x88f0ff, size: 0.9, ttl: 2.2 },
        },
        {
          type: 'aimedVolley',
          telegraphDuration: 1.5, executionDuration: 0.0, cooldown: 3.2,
          params: { count: 9, spread: 0.35, speed: 32, damage: 12, color: 0xffd060,
                    size: 1.2, ttl: 2.4 },
        },
      ],
    },
  ],
});

export default BOSS_DEF;
