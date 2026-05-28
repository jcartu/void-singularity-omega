// Biome system — data-driven biome definitions + BiomeDirector.
//
// SPRINT-06 / WO-06-B*: 5 distinct biomes with palettes, fog, hazards, spawn
// tables, and music intensity floors. This module is the single source of
// truth for biome data; downstream consumers (boss framework, art skins,
// director integration, audio mix) read from `BIOMES` and the BiomeDirector.
//
// Design contract:
//   - Pure data: BIOMES is a frozen table. BiomeDirector holds runtime state
//     (current biome, hazard timers, gravity escalation clock).
//   - Deterministic: getSpawnTable(waveIndex, rng) consumes an RNG instance
//     (engine/rng.js) so identical seed + wave -> identical spawn list.
//   - No VFX side-effects: hazards expose `indicator` descriptors (position,
//     radius, color, kind) for the renderer to draw. This module does NOT
//     touch THREE.js, audio, or DOM.
//   - Does not mutate the existing WaveDirector (director.js). The downstream
//     WO-06-G1 hook will bridge them by calling setBiome() on biome
//     transitions and reading getSpawnTable() / applyGravityMod() from here.
//
// Public surface:
//   BIOMES                              // frozen array of 5 biome defs
//   BIOME_IDS                           // {NEBULA_DRIFT, ACCRETION_VERGE, ...}
//   HAZARD_KINDS                        // {FOG_CLOUD, MINI_WELL, ...}
//   getBiomeById(id)                    // lookup
//   class BiomeDirector
//
// MUST NOT (per request):
//   - Add VFX beyond hazard indicator descriptors (renderer consumes these).
//   - Touch audio modules.
//   - Mutate director.js progression.
//   - Hardcode enemy positions (spawn position is the WaveDirector's job).

import { ENEMY_TYPES } from './enemies/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Canonical biome IDs. */
export const BIOME_IDS = Object.freeze({
  NEBULA_DRIFT:    'nebula_drift',
  ACCRETION_VERGE: 'accretion_verge',
  PULSAR_FIELD:    'pulsar_field',
  DEBRIS_BELT:     'debris_belt',
  EVENT_HORIZON:   'event_horizon',
});

/** Hazard kinds. The renderer / collision system keys off these. */
export const HAZARD_KINDS = Object.freeze({
  FOG_CLOUD:    'fog_cloud',    // vision-occluding, no damage
  MINI_WELL:    'mini_well',    // secondary gravity pull
  PULSAR_SWEEP: 'pulsar_sweep', // telegraphed radial sweep beam, damaging
  DEBRIS_CHUNK: 'debris_chunk', // destructible cover, blocks bullets
  CORE_PULL:    'core_pull',    // global escalating central gravity
});

/** Singularity behavior modes. */
export const SINGULARITY_BEHAVIOR = Object.freeze({
  NORMAL:     'normal',
  ESCALATING: 'escalating',
  PULSING:    'pulsing',
});

// ─────────────────────────────────────────────────────────────────────────────
// Biome definitions
// ─────────────────────────────────────────────────────────────────────────────
// Spawn tables are weight maps: { [enemyType]: weight }. The director draws
// from this distribution per spawn slot. Weights need not sum to 1 — they're
// normalized at sample time. waveCurve scales certain weights with wave index
// to ramp difficulty within a biome's 5-wave arc.

export const BIOMES = Object.freeze([
  Object.freeze({
    id: BIOME_IDS.NEBULA_DRIFT,
    name: 'Nebula Drift',
    titleCardText: 'NEBULA DRIFT // visibility compromised',
    palette: Object.freeze({
      bg:     0x1a0a36, // deep purple
      fog:    0x2c1a7a, // mid blue
      accent: 0x3ad6ff, // cyan
      hazard: 0x7a5cff, // violet
    }),
    fogDensity: 0.55,
    gravityMod: 1.00,
    musicIntensityFloor: 0.20,
    singularityBehavior: SINGULARITY_BEHAVIOR.NORMAL,
    hazards: Object.freeze([
      Object.freeze({
        kind: HAZARD_KINDS.FOG_CLOUD,
        spawnRatePerSec: 0.35,   // expected new clouds per second
        maxConcurrent: 6,
        lifetime: 12.0,          // seconds each cloud persists
        radiusMin: 4.0,
        radiusMax: 7.5,
        damage: 0,
      }),
    ]),
    spawnTable: Object.freeze({
      base: Object.freeze({
        [ENEMY_TYPES.CHASER]:  3.0,
        [ENEMY_TYPES.SHOOTER]: 1.5,
        [ENEMY_TYPES.ORBITER]: 0.5,
      }),
      // Per-wave additive weight overrides (linear-ish ramp).
      waveCurve: Object.freeze({
        [ENEMY_TYPES.SHOOTER]: 0.4, // +0.4 weight per wave index
        [ENEMY_TYPES.ORBITER]: 0.2,
      }),
    }),
  }),

  Object.freeze({
    id: BIOME_IDS.ACCRETION_VERGE,
    name: 'Accretion Verge',
    titleCardText: 'ACCRETION VERGE // mind the wells',
    palette: Object.freeze({
      bg:     0x2a0a00,
      fog:    0x8a2a00,
      accent: 0xffb046,
      hazard: 0xff5020,
    }),
    fogDensity: 0.20,
    gravityMod: 1.35,
    musicIntensityFloor: 0.40,
    singularityBehavior: SINGULARITY_BEHAVIOR.NORMAL,
    hazards: Object.freeze([
      Object.freeze({
        kind: HAZARD_KINDS.MINI_WELL,
        spawnRatePerSec: 0.12,
        maxConcurrent: 3,
        lifetime: 18.0,
        radiusMin: 1.5,
        radiusMax: 2.5,
        strength: 320,           // GravityWell-style mass parameter
        damage: 0,
      }),
    ]),
    spawnTable: Object.freeze({
      base: Object.freeze({
        [ENEMY_TYPES.CHASER]:  2.0,
        [ENEMY_TYPES.SHOOTER]: 2.0,
        [ENEMY_TYPES.ORBITER]: 1.5,
      }),
      waveCurve: Object.freeze({
        [ENEMY_TYPES.ORBITER]: 0.5,
      }),
    }),
  }),

  Object.freeze({
    id: BIOME_IDS.PULSAR_FIELD,
    name: 'Pulsar Field',
    titleCardText: 'PULSAR FIELD // time the beams',
    palette: Object.freeze({
      bg:     0x0a0014,
      fog:    0x5a3aa0,
      accent: 0xf2eaff,
      hazard: 0xffffff,
    }),
    fogDensity: 0.10,
    gravityMod: 1.00,
    musicIntensityFloor: 0.60,
    singularityBehavior: SINGULARITY_BEHAVIOR.PULSING,
    hazards: Object.freeze([
      Object.freeze({
        kind: HAZARD_KINDS.PULSAR_SWEEP,
        period: 4.5,             // seconds between sweeps
        telegraph: 1.2,          // warn-up before active
        activeDuration: 0.6,
        beamHalfWidth: 0.35,     // radians; angular thickness of the beam
        damage: 22,
        rotationSpeed: 0.65,     // rad/sec angular sweep rate
      }),
    ]),
    spawnTable: Object.freeze({
      base: Object.freeze({
        [ENEMY_TYPES.CHASER]:  1.5,
        [ENEMY_TYPES.SHOOTER]: 2.5,
        [ENEMY_TYPES.ORBITER]: 2.0,
      }),
      waveCurve: Object.freeze({
        [ENEMY_TYPES.SHOOTER]: 0.5,
      }),
    }),
  }),

  Object.freeze({
    id: BIOME_IDS.DEBRIS_BELT,
    name: 'Debris Belt',
    titleCardText: 'DEBRIS BELT // use the cover',
    palette: Object.freeze({
      bg:     0x1a1410,
      fog:    0x5a4838,
      accent: 0xd89260,
      hazard: 0x8a6038,
    }),
    fogDensity: 0.15,
    gravityMod: 0.70,
    musicIntensityFloor: 0.50,
    singularityBehavior: SINGULARITY_BEHAVIOR.NORMAL,
    hazards: Object.freeze([
      Object.freeze({
        kind: HAZARD_KINDS.DEBRIS_CHUNK,
        spawnRatePerSec: 0.5,
        maxConcurrent: 14,
        lifetime: 30.0,
        radiusMin: 1.0,
        radiusMax: 2.2,
        health: 25,              // destructible
        blocksBullets: true,
        ricochet: true,
        damage: 0,
      }),
    ]),
    spawnTable: Object.freeze({
      base: Object.freeze({
        [ENEMY_TYPES.CHASER]:  2.5,
        [ENEMY_TYPES.SHOOTER]: 2.5,
        [ENEMY_TYPES.ORBITER]: 0.5,
      }),
      waveCurve: Object.freeze({
        [ENEMY_TYPES.CHASER]: 0.3,
      }),
    }),
  }),

  Object.freeze({
    id: BIOME_IDS.EVENT_HORIZON,
    name: 'Event Horizon',
    titleCardText: 'EVENT HORIZON // it pulls harder now',
    palette: Object.freeze({
      bg:     0x180008,
      fog:    0x5a0028,
      accent: 0xff2a8a,
      hazard: 0xff0040,
    }),
    fogDensity: 0.30,
    gravityMod: 1.50,           // starting multiplier; escalates over time
    musicIntensityFloor: 0.80,
    singularityBehavior: SINGULARITY_BEHAVIOR.ESCALATING,
    hazards: Object.freeze([
      Object.freeze({
        kind: HAZARD_KINDS.CORE_PULL,
        // Gravity escalates from gravityMod -> gravityMod * escalateTo over
        // escalateOver seconds of wave time, then clamps.
        escalateTo: 2.5,
        escalateOver: 45.0,
        damage: 0,
      }),
    ]),
    spawnTable: Object.freeze({
      base: Object.freeze({
        [ENEMY_TYPES.CHASER]:  2.0,
        [ENEMY_TYPES.SHOOTER]: 2.0,
        [ENEMY_TYPES.ORBITER]: 2.0,
      }),
      waveCurve: Object.freeze({
        [ENEMY_TYPES.CHASER]:  0.4,
        [ENEMY_TYPES.SHOOTER]: 0.3,
        [ENEMY_TYPES.ORBITER]: 0.3,
      }),
    }),
  }),
]);

/** Lookup by ID. Returns undefined if unknown. */
export function getBiomeById(id) {
  return BIOMES.find((b) => b.id === id);
}

// ─────────────────────────────────────────────────────────────────────────────
// BiomeDirector
// ─────────────────────────────────────────────────────────────────────────────
// Owns runtime biome state: which biome is active, hazard instance timers,
// and the central-gravity escalation clock for Event Horizon.
//
// Lifecycle:
//   const bd = new BiomeDirector();
//   bd.setBiome(BIOME_IDS.NEBULA_DRIFT);
//   bd.update(dt);                  // every frame; advances hazard timers
//   bd.getSpawnTable(waveIdx, rng); // deterministic list of enemy types
//   bd.applyGravityMod(gravityWell);// adjust well.mass for biome
//   bd.getPalette();                // current palette object
//   bd.getActiveHazards();          // [{kind, ...indicator fields}]
//
// The director keeps hazards as plain data; rendering and collision are the
// caller's responsibility.

export class BiomeDirector {
  /**
   * @param {object} [opts]
   * @param {string} [opts.initialBiomeId] biome to start in (default: nebula_drift)
   * @param {{float:Function,range:Function}} [opts.rng] optional RNG for hazard
   *   placement; if absent, Math.random is used (hazard positions are not
   *   replay-critical — spawn positions for enemies remain owned by the
   *   WaveDirector with its own RNG).
   */
  constructor(opts = {}) {
    this._rng = opts.rng ?? null;
    this._biome = null;
    this._biomeId = null;
    this._waveClock = 0;          // seconds since last setBiome / wave start
    this._hazards = [];           // [{ kind, t, ... }]
    this._spawnAccum = new Map(); // per-hazard-kind spawn-rate accumulator
    this._nextHazardId = 1;

    this.setBiome(opts.initialBiomeId ?? BIOME_IDS.NEBULA_DRIFT);
  }

  // ---- biome selection ---------------------------------------------------

  /**
   * Switch to the given biome. Clears existing hazards and resets timers.
   * No-op if `id` is already the active biome.
   *
   * @param {string} id
   * @returns {boolean} true on success, false if id unknown
   */
  setBiome(id) {
    const b = getBiomeById(id);
    if (!b) return false;
    if (this._biomeId === id) return true;
    this._biomeId = id;
    this._biome = b;
    this._waveClock = 0;
    this._hazards.length = 0;
    this._spawnAccum.clear();
    return true;
  }

  /** Returns the active biome definition (frozen). */
  getBiome() { return this._biome; }

  /** Returns the active biome's palette. */
  getPalette() { return this._biome ? this._biome.palette : null; }

  /** Returns the music intensity floor for the active biome. */
  getMusicIntensityFloor() {
    return this._biome ? this._biome.musicIntensityFloor : 0;
  }

  /** Reset hazard state and wave clock — call when a new wave begins. */
  resetWaveClock() {
    this._waveClock = 0;
  }

  // ---- spawn table -------------------------------------------------------

  /**
   * Deterministic spawn list for a wave index. Given identical `rng` state
   * and `waveIndex`, returns an identical array.
   *
   * @param {number} waveIndex 0-based wave within the biome (0..4)
   * @param {RNG|{float:Function}} rng required for determinism
   * @param {number} [count=8] how many enemy slots to draw
   * @returns {string[]} array of enemy type strings (ENEMY_TYPES values)
   */
  getSpawnTable(waveIndex, rng, count = 8) {
    if (!this._biome) return [];
    if (!rng || typeof rng.float !== 'function') {
      throw new Error('BiomeDirector.getSpawnTable: rng with .float() required for determinism');
    }
    const wi = Math.max(0, Math.min(4, Math.floor(waveIndex)));
    const weights = this._effectiveWeights(wi);
    const types = Object.keys(weights);
    const total = types.reduce((s, k) => s + Math.max(0, weights[k]), 0);
    if (total <= 0 || types.length === 0) return [];

    const out = new Array(Math.max(0, Math.floor(count)));
    for (let i = 0; i < out.length; i++) {
      let r = rng.float() * total;
      let chosen = types[types.length - 1];
      for (let j = 0; j < types.length; j++) {
        r -= Math.max(0, weights[types[j]]);
        if (r <= 0) { chosen = types[j]; break; }
      }
      out[i] = chosen;
    }
    return out;
  }

  /** Combined base + wave-curve weights for inspection / debug. */
  _effectiveWeights(waveIndex) {
    const st = this._biome.spawnTable;
    const base = st.base ?? {};
    const curve = st.waveCurve ?? {};
    const out = {};
    for (const k of Object.keys(base)) out[k] = base[k];
    for (const k of Object.keys(curve)) {
      out[k] = (out[k] ?? 0) + curve[k] * waveIndex;
    }
    return out;
  }

  // ---- hazards -----------------------------------------------------------

  /**
   * Advance per-frame state: hazard timers, spawn rolls, escalation.
   * @param {number} dt seconds
   */
  updateHazards(dt) {
    if (!Number.isFinite(dt) || dt <= 0 || !this._biome) return;
    this._waveClock += dt;

    // Age active hazards; cull expired.
    for (let i = this._hazards.length - 1; i >= 0; i--) {
      const h = this._hazards[i];
      h.t += dt;
      if (h.lifetime != null && h.t >= h.lifetime) {
        this._hazards.splice(i, 1);
        continue;
      }
      // Periodic hazards (pulsar sweep) advance their cycle internally.
      if (h.kind === HAZARD_KINDS.PULSAR_SWEEP) {
        this._tickPulsar(h, dt);
      }
    }

    // Roll new hazards from biome definitions.
    for (const def of this._biome.hazards) {
      // CORE_PULL and PULSAR_SWEEP are singletons; ensure one exists.
      if (def.kind === HAZARD_KINDS.CORE_PULL) {
        if (!this._hazards.some((h) => h.kind === HAZARD_KINDS.CORE_PULL)) {
          this._hazards.push(this._makeCorePull(def));
        }
        continue;
      }
      if (def.kind === HAZARD_KINDS.PULSAR_SWEEP) {
        if (!this._hazards.some((h) => h.kind === HAZARD_KINDS.PULSAR_SWEEP)) {
          this._hazards.push(this._makePulsar(def));
        }
        continue;
      }
      // Stochastic spawners: accumulate expected count.
      if (def.spawnRatePerSec > 0) {
        const acc = (this._spawnAccum.get(def.kind) ?? 0) + def.spawnRatePerSec * dt;
        let toSpawn = Math.floor(acc);
        this._spawnAccum.set(def.kind, acc - toSpawn);
        const live = this._hazards.filter((h) => h.kind === def.kind).length;
        const room = Math.max(0, (def.maxConcurrent ?? Infinity) - live);
        toSpawn = Math.min(toSpawn, room);
        for (let k = 0; k < toSpawn; k++) {
          this._hazards.push(this._makeStochasticHazard(def));
        }
      }
    }
  }

  /** Backwards-compatible alias. */
  update(dt) { this.updateHazards(dt); }

  /**
   * Snapshot of active hazards for renderer/collision. Each entry includes
   * { id, kind, t } plus kind-specific fields. Read-only — do not mutate.
   */
  getActiveHazards() { return this._hazards.slice(); }

  // ---- gravity -----------------------------------------------------------

  /**
   * Apply the biome's gravity modifier to a GravityWell. Multiplies the
   * well's base mass by gravityMod. For ESCALATING biomes, the multiplier
   * scales from gravityMod toward gravityMod * escalateTo over escalateOver
   * seconds of wave clock.
   *
   * The function caches the well's original mass on first call (per well)
   * so repeat calls remain idempotent and correct.
   *
   * @param {object} well GravityWell-like object with a numeric `mass` field
   */
  applyGravityMod(well) {
    if (!well || !this._biome) return;
    if (typeof well.mass !== 'number') return;
    // Cache the well's pre-biome base mass.
    if (well.__biomeBaseMass == null) well.__biomeBaseMass = well.mass;
    const base = well.__biomeBaseMass;
    let mul = this._biome.gravityMod;
    if (this._biome.singularityBehavior === SINGULARITY_BEHAVIOR.ESCALATING) {
      const def = this._biome.hazards.find((h) => h.kind === HAZARD_KINDS.CORE_PULL);
      if (def && def.escalateOver > 0) {
        const f = Math.max(0, Math.min(1, this._waveClock / def.escalateOver));
        mul = mul + (mul * def.escalateTo - mul) * f;
      }
    } else if (this._biome.singularityBehavior === SINGULARITY_BEHAVIOR.PULSING) {
      // Gentle sinusoidal breathing around the base mod.
      const w = 2 * Math.PI / 4.0; // 4-second period
      mul = mul * (1 + 0.10 * Math.sin(this._waveClock * w));
    }
    well.mass = base * mul;
  }

  /** Restore a well to its pre-biome base mass (call before disposing). */
  releaseGravityMod(well) {
    if (!well) return;
    if (well.__biomeBaseMass != null) {
      well.mass = well.__biomeBaseMass;
      delete well.__biomeBaseMass;
    }
  }

  // ---- hazard factories --------------------------------------------------

  _rand() { return this._rng ? this._rng.float() : Math.random(); }
  _rangeR(a, b) { return a + (b - a) * this._rand(); }

  _makeStochasticHazard(def) {
    // Place on a ring around origin; renderer/collision treat coords as world.
    const ang = this._rand() * Math.PI * 2;
    const ringMin = 10;
    const ringMax = 24;
    const r = this._rangeR(ringMin, ringMax);
    return {
      id: this._nextHazardId++,
      kind: def.kind,
      t: 0,
      lifetime: def.lifetime,
      x: Math.cos(ang) * r,
      z: Math.sin(ang) * r,
      radius: this._rangeR(def.radiusMin ?? 1, def.radiusMax ?? 2),
      damage: def.damage ?? 0,
      // Kind-specific extras
      strength: def.strength,           // mini_well
      health: def.health,               // debris_chunk
      blocksBullets: def.blocksBullets, // debris_chunk
      ricochet: def.ricochet,           // debris_chunk
    };
  }

  _makePulsar(def) {
    return {
      id: this._nextHazardId++,
      kind: HAZARD_KINDS.PULSAR_SWEEP,
      t: 0,
      lifetime: null,
      angle: this._rand() * Math.PI * 2,
      phase: 'idle',          // 'idle' -> 'telegraph' -> 'active'
      phaseT: 0,
      period: def.period,
      telegraph: def.telegraph,
      activeDuration: def.activeDuration,
      beamHalfWidth: def.beamHalfWidth,
      rotationSpeed: def.rotationSpeed,
      damage: def.damage,
    };
  }

  _tickPulsar(h, dt) {
    h.phaseT += dt;
    h.angle += h.rotationSpeed * dt;
    if (h.phase === 'idle' && h.phaseT >= h.period - h.telegraph) {
      h.phase = 'telegraph'; h.phaseT = 0;
    } else if (h.phase === 'telegraph' && h.phaseT >= h.telegraph) {
      h.phase = 'active'; h.phaseT = 0;
    } else if (h.phase === 'active' && h.phaseT >= h.activeDuration) {
      h.phase = 'idle'; h.phaseT = 0;
    }
  }

  _makeCorePull(def) {
    return {
      id: this._nextHazardId++,
      kind: HAZARD_KINDS.CORE_PULL,
      t: 0,
      lifetime: null,
      escalateTo: def.escalateTo,
      escalateOver: def.escalateOver,
      damage: def.damage ?? 0,
    };
  }
}

export default BiomeDirector;
