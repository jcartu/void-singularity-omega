// Boss registry — single source of truth for biome -> boss def mapping.
//
// Public surface:
//   ALL_BOSSES                  - frozen array of BOSS_DEF objects
//   getBossDef(idOrBiome)       - lookup by boss id OR biome id
//   getBossForBiome(biomeId)    - explicit biome -> boss
//   BossCore, BOSS_STATE        - re-exports from boss-core
//
// Wiring contract: when the director emits 'boss:encounter' with a biome id,
// a game-level adapter (see director-bridge.js) looks up the def here and
// constructs a BossCore pointed at the projectile pool / enemy manager / bus.

import VOID_REAVER from './void-reaver.js';
import MAGMA_TITAN from './magma-titan.js';
import PULSE_WARDEN from './pulse-warden.js';
import SCRAP_COLLECTOR from './scrap-collector.js';
import HORIZON_EATER from './horizon-eater.js';
import OMEGA_CORE from './omega-core.js';
import { BossCore, BOSS_STATE } from './boss-core.js';

export const ALL_BOSSES = Object.freeze([
  VOID_REAVER,
  MAGMA_TITAN,
  PULSE_WARDEN,
  SCRAP_COLLECTOR,
  HORIZON_EATER,
  OMEGA_CORE,
]);

// Biome-id -> BOSS_DEF map. Covers both canonical spec ids ('nebula',
// 'pulsar', 'debris', 'event-horizon', 'omega') AND the director.js
// labels currently in use ('singularity-core', 'event-horizon', etc).
//
// The director's current 5-biome list labels the 4th biome 'singularity-core'
// — we route that slot to HORIZON_EATER (its themed boss) so OMEGA_CORE
// remains reserved for the final 'omega' biome.
const BY_BIOME = Object.freeze({
  // Canonical spec ids
  nebula: VOID_REAVER,
  accretion: MAGMA_TITAN,
  pulsar: PULSE_WARDEN,
  debris: SCRAP_COLLECTOR,
  'event-horizon': HORIZON_EATER,
  omega: OMEGA_CORE,

  // Alternative biome id spellings sometimes used elsewhere in the codebase.
  nebula_drift: VOID_REAVER,
  accretion_verge: MAGMA_TITAN,
  pulsar_field: PULSE_WARDEN,
  debris_belt: SCRAP_COLLECTOR,
  event_horizon: HORIZON_EATER,

  // Director's current biome id for the pre-OMEGA slot.
  'singularity-core': HORIZON_EATER,
});

const BY_ID = Object.freeze(
  ALL_BOSSES.reduce((acc, def) => { acc[def.id] = def; return acc; }, {}),
);

/**
 * Resolve a boss definition by boss id OR biome id.
 * @param {string} key
 * @returns {object|null}
 */
export function getBossDef(key) {
  if (!key) return null;
  return BY_ID[key] ?? BY_BIOME[key] ?? null;
}

/**
 * Resolve the boss assigned to a biome.
 * @param {string} biomeId
 */
export function getBossForBiome(biomeId) {
  return BY_BIOME[biomeId] ?? null;
}

export { BossCore, BOSS_STATE };
export default ALL_BOSSES;
