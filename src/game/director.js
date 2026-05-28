// Wave/biome run director.
//
// Owns the macro structure of a run: 5 biomes × 5 waves = 25 waves, with a
// boss slot at the end of each biome. Each wave is given a "spawn budget"
// expressed in points; enemy types cost points and are drawn from a pool that
// expands with biome progression. Spawns are released over a 3–5s window so
// the player isn't dumped on at the start, and the wave clears when every
// debited enemy has died.
//
// The director does NOT implement boss AI — boss slots emit a single
// `boss:encounter` payload and immediately resolve via a callback contract
// (`completeBoss()`), to be hooked up properly in SPRINT-06.
//
// Public API:
//   const d = new WaveDirector({ enemies, bus, rng, gravity });
//   d.startRun(seed);            // resets to biome 1 / wave 1
//   d.startWave();               // begins next pending wave (or boss)
//   d.update(dt);                // releases queued spawns, checks completion
//   d.completeWave();            // forced-advance (debug); normally automatic
//   d.completeBoss();            // resolve a boss encounter
//   d.getWaveState();            // -> { biome, wave, globalWave, budget,
//                                //      enemiesAlive, enemiesPending,
//                                //      isBoss, isBreather, phase }
//   d.onEnemyKilled(type);       // (optional) bus-driven, also auto-wired
//
// Events emitted on the supplied bus (raw string names; not in EVENTS so
// they bypass the dev-mode whitelist):
//   'wave:start'    { biome, wave, globalWave, budget, isBreather }
//   'wave:complete' { biome, wave, globalWave, currencyBonus }
//   'boss:encounter'{ biome, globalWave, slot }
//   'boss:complete' { biome, globalWave }
//   'run:complete'  { totalWaves }

import { ENEMY_TYPES } from './enemies/types.js';
import { RNG } from '../engine/rng.js';
import { getBossForBiome } from './bosses/index.js';

// ---- Biome table ----------------------------------------------------------
// Each biome owns 5 waves + a boss slot at the end. Stat multipliers stack
// on top of EnemyManager defaults; the director writes them into spawn
// params (health/maxSpeed/contactDamage/bulletDamage) at spawn time.
export const BIOMES = Object.freeze([
  Object.freeze({
    id: 'nebula',
    name: 'Nebula',
    waves: 5,
    // Pool grows mid-biome: first 2 waves chaser-only, then +shooter.
    poolByWave: [
      [ENEMY_TYPES.CHASER],
      [ENEMY_TYPES.CHASER],
      [ENEMY_TYPES.CHASER, ENEMY_TYPES.SHOOTER],
      [ENEMY_TYPES.CHASER, ENEMY_TYPES.SHOOTER],
      [ENEMY_TYPES.CHASER, ENEMY_TYPES.SHOOTER],
    ],
    stats: { health: 1.00, speed: 1.00, damage: 1.00 },
    eliteChance: 0.0,
    spawnRadius: 26,
  }),
  Object.freeze({
    id: 'accretion',
    name: 'Accretion',
    waves: 5,
    poolByWave: [
      [ENEMY_TYPES.CHASER, ENEMY_TYPES.SHOOTER, ENEMY_TYPES.ORBITER],
    ],
    stats: { health: 1.15, speed: 1.05, damage: 1.10 },
    eliteChance: 0.0,
    spawnRadius: 28,
  }),
  Object.freeze({
    id: 'event-horizon',
    name: 'Event Horizon',
    waves: 5,
    poolByWave: [
      [ENEMY_TYPES.CHASER, ENEMY_TYPES.SHOOTER, ENEMY_TYPES.ORBITER],
    ],
    stats: { health: 1.35, speed: 1.12, damage: 1.20 },
    eliteChance: 0.10,
    spawnRadius: 30,
  }),
  Object.freeze({
    id: 'singularity-core',
    name: 'Singularity Core',
    waves: 5,
    poolByWave: [
      [ENEMY_TYPES.CHASER, ENEMY_TYPES.SHOOTER, ENEMY_TYPES.ORBITER],
    ],
    stats: { health: 1.60, speed: 1.20, damage: 1.35 },
    eliteChance: 0.25,
    spawnRadius: 32,
  }),
  Object.freeze({
    id: 'omega',
    name: 'OMEGA',
    waves: 5,
    poolByWave: [
      [ENEMY_TYPES.CHASER, ENEMY_TYPES.SHOOTER, ENEMY_TYPES.ORBITER],
    ],
    stats: { health: 1.90, speed: 1.30, damage: 1.55 },
    eliteChance: 0.40,
    spawnRadius: 34,
  }),
]);

// Enemy cost in budget points.
export const ENEMY_COST = Object.freeze({
  [ENEMY_TYPES.CHASER]: 1.0,
  [ENEMY_TYPES.SHOOTER]: 1.5,
  [ENEMY_TYPES.ORBITER]: 1.2,
  miniboss: 5.0,
});

// Director phases.
export const PHASE = Object.freeze({
  IDLE: 'idle',          // pre-run, or between waves
  SPAWNING: 'spawning',  // releasing queued spawns
  ACTIVE: 'active',      // all spawned, waiting on kills
  BREATHER: 'breather',  // post-wave currency window (short pause)
  BOSS_GAP: 'boss-gap',  // 3s breath before boss
  BOSS: 'boss',          // boss encounter in flight
  COMPLETE: 'complete',  // run finished
});

// Tuning constants.
const BUDGET_BASE = 10;       // wave 1
const BUDGET_PER_WAVE = 1.5;  // linear ramp
const BUDGET_PER_BIOME = 4.0; // per-biome step
const BREATHER_BUDGET_MULT = 0.7;
const BREATHER_CURRENCY_MULT = 1.5;
const SPAWN_WINDOW_MIN = 3.0;
const SPAWN_WINDOW_MAX = 5.0;
const BREATHER_GAP = 1.5;     // seconds between waves
const BOSS_GAP = 3.0;         // mandated breather before boss
const DESPERATION_TIMEOUT = 30; // seconds of stall before extra spawns
const DESPERATION_BUDGET = 0.25; // fraction of wave budget tacked on

export class WaveDirector {
  /**
   * @param {object} deps
   * @param {import('./enemies/index.js').EnemyManager} deps.enemies
   * @param {import('../engine/events.js').EventBus} [deps.bus]
   * @param {RNG|{float:Function,range:Function,int:Function,pick:Function}} [deps.rng]
   * @param {{ position: { x:number, z:number } }} [deps.gravity]
   */
  constructor({ enemies, bus = null, rng = null, gravity = null } = {}) {
    if (!enemies) throw new Error('WaveDirector: enemies (EnemyManager) required');
    this.enemies = enemies;
    this.bus = bus;
    this.rng = rng ?? new RNG(0xC0FFEE);
    this.gravity = gravity;

    // Per-run state.
    this.biomeIndex = 0;
    this.waveIndex = 0;       // 0-based within biome
    this.globalWave = 0;      // 0-based across run
    this.phase = PHASE.IDLE;
    this.budget = 0;
    this.enemiesAlive = 0;
    this.spawnQueue = [];     // [{ type, params, releaseAt }]
    this.spawnedIds = new Set();
    this._waveClock = 0;      // seconds since wave start
    this._phaseClock = 0;     // seconds in current phase
    this._desperationFired = false;
    this._unsubs = [];

    if (this.bus) {
      // Track kills (and any other deletions) without forcing callers to wire it.
      this._unsubs.push(this.bus.on('enemy:death', this._onEnemyDeath));
    }
  }

  // ---- lifecycle ----------------------------------------------------------

  /** Initialize a new run. Idempotent. */
  startRun(seed = null) {
    if (seed != null) this.rng = new RNG(seed >>> 0);
    this.biomeIndex = 0;
    this.waveIndex = 0;
    this.globalWave = 0;
    this.phase = PHASE.IDLE;
    this.budget = 0;
    this.enemiesAlive = 0;
    this.spawnQueue.length = 0;
    this.spawnedIds.clear();
    this._waveClock = 0;
    this._phaseClock = 0;
    this._desperationFired = false;
  }

  /** Begin the next wave (or boss slot, if we just finished a biome's waves). */
  startWave() {
    if (this.phase === PHASE.COMPLETE) return;

    // After the 5th wave of a biome we emit a boss slot; only after that do
    // we advance to the next biome.
    if (this.waveIndex >= BIOMES[this.biomeIndex].waves) {
      this._beginBossGap();
      return;
    }

    const biome = BIOMES[this.biomeIndex];
    const wave = this.waveIndex;
    const globalWave = this.globalWave;
    const isBreather = ((globalWave + 1) % 3) === 0; // every 3rd wave eases up

    this.budget = this._computeBudget(globalWave, isBreather);
    this.spawnQueue.length = 0;
    this.spawnedIds.clear();
    this._waveClock = 0;
    this._phaseClock = 0;
    this._desperationFired = false;
    this._isBreather = isBreather;

    this._buildSpawnPlan(biome, wave, this.budget);

    this.phase = PHASE.SPAWNING;
    this._emit('wave:start', {
      biome: biome.id,
      biomeIndex: this.biomeIndex,
      wave: wave + 1,
      globalWave: globalWave + 1,
      budget: this.budget,
      isBreather,
    });
  }

  /** Force-complete the current wave (debug / scripted skip). */
  completeWave() {
    if (this.phase === PHASE.BOSS) { this.completeBoss(); return; }
    if (this.phase === PHASE.IDLE || this.phase === PHASE.COMPLETE) return;
    this._finishWave();
  }

  /** Resolve a boss encounter — wired by S06 boss code. */
  completeBoss() {
    if (this.phase !== PHASE.BOSS) return;
    const biome = BIOMES[this.biomeIndex];
    this._emit('boss:complete', {
      biome: biome.id,
      biomeIndex: this.biomeIndex,
      globalWave: this.globalWave + 1,
    });
    // Advance to next biome.
    this.biomeIndex += 1;
    this.waveIndex = 0;
    if (this.biomeIndex >= BIOMES.length) {
      this.phase = PHASE.COMPLETE;
      this._emit('run:complete', { totalWaves: this.globalWave });
      return;
    }
    this._beginBreatherGap();
  }

  /** Per-frame tick. */
  update(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    this._phaseClock += dt;
    if (this.phase === PHASE.SPAWNING || this.phase === PHASE.ACTIVE) {
      this._waveClock += dt;
    }

    switch (this.phase) {
      case PHASE.SPAWNING:    this._tickSpawning(); break;
      case PHASE.ACTIVE:      this._tickActive(); break;
      case PHASE.BREATHER:    if (this._phaseClock >= BREATHER_GAP) this.startWave(); break;
      case PHASE.BOSS_GAP:    if (this._phaseClock >= BOSS_GAP) this._beginBoss(); break;
      default: /* idle/boss/complete: no-op */ break;
    }
  }

  /** Snapshot used by HUD / upgrade screens. */
  getWaveState() {
    const biome = BIOMES[this.biomeIndex] ?? BIOMES[BIOMES.length - 1];
    return {
      biome: biome.id,
      biomeName: biome.name,
      biomeIndex: this.biomeIndex,
      wave: this.waveIndex + 1,
      globalWave: this.globalWave + 1,
      totalWaves: BIOMES.reduce((s, b) => s + b.waves, 0),
      budget: this.budget,
      enemiesAlive: this.enemiesAlive,
      enemiesPending: this.spawnQueue.length,
      isBoss: this.phase === PHASE.BOSS || this.phase === PHASE.BOSS_GAP,
      isBreather: !!this._isBreather,
      phase: this.phase,
    };
  }

  /** Optional manual hook; bus subscription already credits kills automatically. */
  onEnemyKilled(/* type */) { /* no-op: handled via 'enemy:death' subscription */ }

  /** Current biome index (0-based). */
  getBiomeIndex() { return this.biomeIndex; }

  /** Total number of biomes in the run. */
  getBiomeCount() { return BIOMES.length; }

  /** BOSS_DEF for the current biome, via the boss registry. Null if unmapped. */
  getBossDef() {
    const biome = BIOMES[this.biomeIndex];
    return biome ? getBossForBiome(biome.id) : null;
  }

  /**
   * Debug / scripted jump to a biome by id. Resets wave index inside that
   * biome and emits no events — primarily for tests. Returns true on success.
   */
  setBiome(biomeId) {
    const idx = BIOMES.findIndex((b) => b.id === biomeId);
    if (idx < 0) return false;
    this.biomeIndex = idx;
    this.waveIndex = 0;
    return true;
  }

  /** Detach bus listeners. */
  dispose() {
    for (const off of this._unsubs) { try { off(); } catch { /* noop */ } }
    this._unsubs.length = 0;
  }

  // ---- internals ----------------------------------------------------------

  _computeBudget(globalWave, isBreather) {
    // Linear + biome step. wave 1 = 10, wave 5 ≈ 16, wave 10 ≈ 28, wave 25 ≈ 60.
    const base = BUDGET_BASE
      + BUDGET_PER_WAVE * globalWave
      + BUDGET_PER_BIOME * this.biomeIndex;
    return Math.round(base * (isBreather ? BREATHER_BUDGET_MULT : 1.0));
  }

  _poolForWave(biome, waveIdx) {
    // poolByWave may be sparse (single-entry => apply to all waves).
    const arr = biome.poolByWave;
    if (arr.length === 1) return arr[0];
    return arr[Math.min(waveIdx, arr.length - 1)];
  }

  _buildSpawnPlan(biome, waveIdx, budget) {
    const pool = this._poolForWave(biome, waveIdx);
    const window = this.rng.range
      ? this.rng.range(SPAWN_WINDOW_MIN, SPAWN_WINDOW_MAX)
      : (SPAWN_WINDOW_MIN + Math.random() * (SPAWN_WINDOW_MAX - SPAWN_WINDOW_MIN));

    let remaining = budget;
    const picks = [];
    // Greedy fill: random type from pool, stop when budget exhausted or no
    // type fits. With chaser=1pt this always converges.
    let safety = 256;
    while (remaining > 0 && safety-- > 0) {
      const affordable = pool.filter((t) => ENEMY_COST[t] <= remaining + 1e-3);
      if (affordable.length === 0) break;
      const t = this.rng.pick ? this.rng.pick(affordable) : affordable[Math.floor(Math.random() * affordable.length)];
      picks.push(t);
      remaining -= ENEMY_COST[t];
    }

    // Distribute release times uniformly across the spawn window.
    const n = picks.length;
    for (let i = 0; i < n; i++) {
      const releaseAt = n === 1 ? 0 : (window * i) / (n - 1);
      this.spawnQueue.push({
        type: picks[i],
        releaseAt,
        params: this._statParamsFor(picks[i], biome),
      });
    }
  }

  _statParamsFor(type, biome) {
    const s = biome.stats;
    // Elite roll multiplies stats further.
    const isElite = this.rng.float ? this.rng.float() < biome.eliteChance : Math.random() < biome.eliteChance;
    const eliteMul = isElite ? 1.35 : 1.0;
    const params = {};
    // Defaults at the EnemyManager layer are read from ENEMY_DEFAULTS when a
    // field is absent. We provide overrides only where stats apply.
    if (type === ENEMY_TYPES.CHASER) {
      params.health = Math.round(30 * s.health * eliteMul);
      params.maxSpeed = 16 * s.speed * eliteMul;
      params.contactDamage = 18 * s.damage * eliteMul;
    } else if (type === ENEMY_TYPES.SHOOTER) {
      params.health = Math.round(22 * s.health * eliteMul);
      params.maxSpeed = 9 * s.speed * eliteMul;
      params.bulletDamage = 8 * s.damage * eliteMul;
    } else if (type === ENEMY_TYPES.ORBITER) {
      params.health = Math.round(38 * s.health * eliteMul);
      params.contactDamage = 14 * s.damage * eliteMul;
    }
    if (isElite) params.color = 0xffffff;
    return params;
  }

  _spawnRing(spawnRadius) {
    // Random point on a ring around the gravity well. Spawning OFF the ring
    // means enemies feed in toward the well naturally.
    const cx = this.gravity?.position?.x ?? 0;
    const cz = this.gravity?.position?.z ?? 0;
    const ang = (this.rng.float ? this.rng.float() : Math.random()) * Math.PI * 2;
    return [
      cx + Math.cos(ang) * spawnRadius,
      0,
      cz + Math.sin(ang) * spawnRadius,
    ];
  }

  _tickSpawning() {
    const biome = BIOMES[this.biomeIndex];
    const t = this._waveClock;
    // Pop spawns whose release time has elapsed.
    for (let i = this.spawnQueue.length - 1; i >= 0; i--) {
      const s = this.spawnQueue[i];
      if (t >= s.releaseAt) {
        const position = this._spawnRing(biome.spawnRadius);
        const params = { ...s.params };
        // Orbiter wants a tangential direction relative to the ring.
        if (s.type === ENEMY_TYPES.ORBITER) {
          params.direction = (this.rng.float ? this.rng.float() : Math.random()) < 0.5 ? -1 : 1;
        }
        const id = this.enemies.spawn({ type: s.type, position, params });
        this.spawnedIds.add(id);
        this.enemiesAlive += 1;
        this.spawnQueue.splice(i, 1);
      }
    }
    if (this.spawnQueue.length === 0) {
      this.phase = PHASE.ACTIVE;
      this._phaseClock = 0;
    }
  }

  _tickActive() {
    if (this.enemiesAlive <= 0) { this._finishWave(); return; }
    // Desperation: if the wave drags on past DESPERATION_TIMEOUT, top up.
    if (!this._desperationFired && this._waveClock > DESPERATION_TIMEOUT) {
      this._desperationFired = true;
      const biome = BIOMES[this.biomeIndex];
      const topup = Math.max(1, Math.round(this.budget * DESPERATION_BUDGET));
      this._buildSpawnPlan(biome, this.waveIndex, topup);
      this.phase = PHASE.SPAWNING;
    }
  }

  _finishWave() {
    const biome = BIOMES[this.biomeIndex];
    const isBreather = !!this._isBreather;
    const currencyBonus = isBreather ? BREATHER_CURRENCY_MULT : 1.0;
    this._emit('wave:complete', {
      biome: biome.id,
      biomeIndex: this.biomeIndex,
      wave: this.waveIndex + 1,
      globalWave: this.globalWave + 1,
      currencyBonus,
    });
    this.waveIndex += 1;
    this.globalWave += 1;
    this._beginBreatherGap();
  }

  _beginBreatherGap() {
    this.phase = PHASE.BREATHER;
    this._phaseClock = 0;
  }

  _beginBossGap() {
    this.phase = PHASE.BOSS_GAP;
    this._phaseClock = 0;
  }

  _beginBoss() {
    const biome = BIOMES[this.biomeIndex];
    this.phase = PHASE.BOSS;
    this._phaseClock = 0;
    this._emit('boss:encounter', {
      biome: biome.id,
      biomeIndex: this.biomeIndex,
      globalWave: this.globalWave + 1,
      slot: `${biome.id}-boss`,
    });
    // Boss AI is S06; until then, treat the slot as immediately resolved on
    // the next update so runs can still progress in dev/test builds.
    // (Callers wiring real bosses should not rely on this — call completeBoss
    // explicitly from boss logic.)
  }

  _onEnemyDeath = (payload) => {
    if (!payload) return;
    if (!this.spawnedIds.has(payload.id)) return;
    this.spawnedIds.delete(payload.id);
    this.enemiesAlive = Math.max(0, this.enemiesAlive - 1);
  };

  _emit(name, payload) { if (this.bus) this.bus.emit(name, payload); }
}

export default WaveDirector;
