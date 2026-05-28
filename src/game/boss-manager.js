// Boss manager — runtime adapter that owns a single live boss for the current
// biome. Bridges the boss-core BossCore (data-driven AI) to the world's
// projectile pool, enemy manager and event bus.
//
// Lifecycle (driven by world.js):
//   1. WaveDirector emits 'boss:encounter' → world.spawnBoss(def, pos)
//   2. BossManager.update(dt, playerPos) every frame, plus bullet/boss hit-test
//   3. On 'boss:death' → world calls director.completeBoss()
//   4. BossManager.dispose() before next encounter
//
// Public API (per WO-06-G1 spec):
//   new BossManager({ def, rng, bus, projectilePool, enemyManager, bossFX, player, gravity })
//   spawn(pos)                 -> BossCore
//   update(dt, playerPos)
//   damageBoss(amount, source) -> boolean
//   isBossAlive()              -> boolean
//   getBossState()             -> { id, name, hp, maxHp, phase, alive }
//   dispose()
//
// MUST NOT: add VFX/audio beyond what bossFX / event bus already cover.

import { BossCore } from './bosses/boss-core.js';

const BULLET_HIT_PADDING = 0.6; // extra hit radius so fast bullets register

export class BossManager {
  /**
   * @param {object} opts
   * @param {object} opts.def              BOSS_DEF
   * @param {object} opts.projectilePool   ProjectilePool (boss attacks fire here)
   * @param {object} [opts.enemyManager]   EnemyManager (for boss summons)
   * @param {object} [opts.bus]            EventBus
   * @param {object} [opts.rng]            seeded RNG
   * @param {object} [opts.bossFX]         optional VFX adapter
   * @param {object} [opts.player]         player ref (used by BossCore for aim)
   * @param {object} [opts.gravity]        optional gravity well reference
   */
  constructor({
    def, rng = null, bus = null,
    projectilePool, enemyManager = null,
    bossFX = null, player = null, gravity = null,
  } = {}) {
    if (!def) throw new Error('BossManager: def required');
    if (!projectilePool) throw new Error('BossManager: projectilePool required');
    this.def = def;
    this.rng = rng;
    this.bus = bus;
    this.projectilePool = projectilePool;
    this.enemyManager = enemyManager;
    this.bossFX = bossFX;
    this.player = player;
    this.gravity = gravity;

    /** @type {BossCore|null} */
    this.boss = null;
    this._disposed = false;
  }

  /**
   * Spawn the boss at the given world position. Returns the BossCore.
   * @param {[number,number,number]} pos
   */
  spawn(pos = [0, 0, 0]) {
    if (this._disposed) return null;
    if (this.boss) return this.boss; // idempotent
    this.boss = new BossCore({
      def: this.def,
      rng: this.rng,
      bus: this.bus,
      projectilePool: this.projectilePool,
      enemyManager: this.enemyManager,
    });
    this.boss.spawn(pos);
    // BossCore emits its own 'boss:spawn' via the bus.
    return this.boss;
  }

  /**
   * Advance boss AI and run bullet-vs-boss hit tests against the player pool.
   * @param {number} dt
   * @param {{x:number,z:number}|null} playerPos
   */
  update(dt, playerPos = null) {
    if (this._disposed || !this.boss || !this.boss.alive) return;
    this.boss.update(dt, playerPos ?? null, this.enemyManager ?? null);
    if (!this.boss.alive) return;
    this._runBulletHitTests();
  }

  /**
   * Deal damage directly (e.g. from a beam weapon or explosion).
   * @param {number} amount
   * @param {string|number|null} _source identifier for telemetry
   * @returns {boolean} true if damage was applied
   */
  damageBoss(amount, _source = null) {
    if (this._disposed || !this.boss || !this.boss.alive) return false;
    return this.boss.damage(amount);
  }

  /** @returns {boolean} */
  isBossAlive() { return !!(this.boss && this.boss.alive); }

  /** Snapshot for HUD/UI. */
  getBossState() {
    if (!this.boss) {
      return {
        id: this.def.id, name: this.def.name,
        hp: 0, maxHp: this.def.maxHp,
        phase: 0, phases: this.def.phases.length, alive: false,
        x: 0, z: 0,
      };
    }
    return {
      id: this.def.id,
      name: this.def.name,
      hp: this.boss.hp,
      maxHp: this.boss.maxHp,
      phase: (this.boss.phaseIndex ?? 0) + 1,
      phases: this.def.phases.length,
      alive: this.boss.alive,
      x: this.boss.position?.x ?? 0,
      z: this.boss.position?.z ?? 0,
    };
  }

  /** Tear down. */
  dispose() {
    this._disposed = true;
    this.boss = null;
  }

  // ---- internals ---------------------------------------------------------

  _runBulletHitTests() {
    const b = this.boss;
    if (!b) return;
    const pool = this.projectilePool;
    if (!pool || typeof pool.forEach !== 'function') return;
    const bx = b.position?.x ?? 0;
    const bz = b.position?.z ?? 0;
    const r = (b.size || this.def.size || 1) + BULLET_HIT_PADDING;
    const r2 = r * r;
    // Boss bullets are spawned mid-update and accelerate outward fast enough
    // that they leave the boss radius before the next tick — no self-hit
    // bookkeeping needed in practice.
    pool.forEach((i, p) => {
      const dx = p.px[i] - bx;
      const dz = p.pz[i] - bz;
      if (dx * dx + dz * dz <= r2) {
        const dmg = p.damage[i] || 0;
        if (dmg > 0 && b.alive) b.damage(dmg);
        if (typeof p.kill === 'function') p.kill(i);
      }
    });
  }
}

export default BossManager;
