// PULSE WARDEN — Pulsar biome boss.
// Silhouette: stark vertical needle ringed by counter-rotating bands. Rhythmic
// attacks: predictable beat in P1, syncopation in P2, arrhythmia in P3.

import { ENEMY_TYPES } from '../enemies/types.js';

const BEAT = 2.0; // seconds — anchor tempo for the encounter

export const BOSS_DEF = Object.freeze({
  id: 'pulse-warden',
  name: 'PULSE WARDEN',
  biome: 'pulsar',
  size: 2.4,
  maxHp: 1500,
  contactDamage: 14,
  phaseTelegraph: 2.5,

  phases: [
    // Phase 1: Steady beat sweeps ------------------------------------------
    {
      id: 'warden-p1',
      hpThreshold: 1.0,
      enrageTime: 40,
      attacks: [
        {
          type: 'sweep',
          telegraphDuration: 1.8, executionDuration: 0.9, cooldown: BEAT * 2,
          params: { length: 18, width: 2.0, speed: 22, damage: 8, segments: 9,
                    color: 0x66e0ff, size: 0.9, ttl: 2.4 },
        },
        {
          type: 'radialBurst',
          telegraphDuration: 1.6, executionDuration: 0.0, cooldown: BEAT * 3,
          params: { count: 10, speed: 16, damage: 8, ttl: 3.0, color: 0x66e0ff, size: 0.9 },
        },
      ],
    },

    // Phase 2: Off-beat + orbiters -----------------------------------------
    {
      id: 'warden-p2',
      hpThreshold: 0.66,
      enrageTime: 32,
      attacks: [
        {
          type: 'sweep',
          telegraphDuration: 1.6, executionDuration: 0.8, cooldown: BEAT * 1.5,
          params: { length: 20, width: 2.6, speed: 24, damage: 8, segments: 11,
                    color: 0x88f0ff, size: 0.9, ttl: 2.4 },
        },
        {
          type: 'radialBurst',
          telegraphDuration: 1.6, executionDuration: 0.0, cooldown: BEAT * 1.7,
          params: { count: 12, speed: 17, damage: 9, ttl: 3.0, color: 0x66e0ff, size: 1.0 },
        },
        {
          type: 'summon',
          telegraphDuration: 1.5, executionDuration: 0.0, cooldown: 18,
          params: { count: 2, type: ENEMY_TYPES.ORBITER, params: { health: 28 } },
        },
      ],
    },

    // Phase 3: Chaos + arena shrink ---------------------------------------
    {
      id: 'warden-p3',
      hpThreshold: 0.33,
      enrageTime: 22,
      attacks: [
        {
          type: 'arenaHazard',
          telegraphDuration: 2.5, executionDuration: 0.0, cooldown: 999,
          params: { radius: 16, duration: 999, damagePerSec: 0, hazardKind: 'arenaShrink',
                    shrinkSpeed: 0.4 },
        },
        {
          type: 'sweep',
          telegraphDuration: 1.5, executionDuration: 0.6, cooldown: BEAT * 1.1,
          params: { length: 22, width: 3.0, speed: 26, damage: 9, segments: 13,
                    color: 0x66e0ff, size: 0.9, ttl: 2.2 },
        },
        {
          type: 'radialBurst',
          telegraphDuration: 1.5, executionDuration: 0.0, cooldown: BEAT * 1.0,
          params: { count: 20, speed: 18, damage: 8, ttl: 2.8, color: 0x88f0ff, size: 0.9 },
        },
        {
          type: 'spiral',
          telegraphDuration: 1.8, executionDuration: 1.5, cooldown: BEAT * 2.2,
          params: { count: 24, arms: 4, speed: 15, damage: 7, rotation: Math.PI * 2,
                    color: 0x66e0ff, size: 0.9, ttl: 3.2 },
        },
      ],
    },
  ],
});

export default BOSS_DEF;
