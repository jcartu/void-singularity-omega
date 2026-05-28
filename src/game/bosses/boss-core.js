// Boss framework — data-driven phase state machine + telegraphed attack primitives.
//
// A boss is fully described by a definition object (see "Boss Definition Schema"
// below). The framework consumes that definition and runs the boss as a state
// machine without any boss-specific code paths.
//
// Lifecycle:
//   const boss = new BossCore({ def, rng, bus, projectilePool, enemyManager });
//   boss.spawn([x, 0, z]);
//   // each frame:
//   boss.update(dt, playerPos, enemies);
//   // on hit:
//   boss.damage(amount);
//   // queries:
//   boss.isAlive(); boss.getPhase(); boss.getHp(); boss.getMaxHp();
//   boss.dispose();
//
// Determinism:
//   All pattern generation (angles, jitter, summon offsets, hazard positions)
//   is driven by the supplied RNG. Same seed + same input sequence = identical
//   attack output. Telegraph/execution timing is purely time-based and ignores
//   wall-clock — only the dt stream matters.
//
// Telegraphs (player-fair design):
//   Every attack and every phase transition has a telegraph window during
//   which a visual indicator is exposed via getTelegraphs(). The actual
//   damaging payload is not spawned until the telegraph elapses, so every
//   attack is dodgeable.
//
// Boss Definition Schema:
//   {
//     id: string,
//     name: string,
//     size: number,                 // visual radius (also used for projectile origin offset)
//     maxHp: number,
//     contactDamage?: number,       // optional contact dps if player touches boss
//     phaseTelegraph?: number,      // default seconds before each phase begins (2.5)
//     phases: [
//       {
//         id: string,
//         hpThreshold: number,      // 0..1 fraction; phase becomes eligible when hp/maxHp <= this.
//                                   //   Phase 0's threshold is implicitly 1.0 (entered immediately).
//         enrageTime: number,       // seconds; if phase exceeds this, force-transition
//                                   //   (or enrage attack burst if last phase)
//         attacks: [
//           { type, telegraphDuration, executionDuration, cooldown, params }
//         ]
//       }, ...
//     ]
//   }
//
// Attack types (params shown in parens):
//   radialBurst  (count, speed, damage, spread=2*PI, startAngle?, color?, size?, ttl?)
//   spiral       (count, arms=1, speed, damage, rotation=PI*2, color?, size?, ttl?)
//   aimedVolley  (count=1, spread=0, speed, damage, color?, size?, ttl?)
//   sweep        (length, width, speed, damage, segments=8, color?, size?, ttl?)
//   summon       (count, type, params?)     // delegates to EnemyManager.spawn
//   arenaHazard  (radius, duration, damagePerSec, offset?=[dx,dz])
//
// Events emitted on bus (raw strings — bus may be dev-strict; we use the same
// 'boss:phase' name registered in engine/events.js EVENTS):
//   'boss:spawn'      { id, x, z, maxHp }
//   'boss:phase'      { id, phase, total, hpFrac, enrage }
//   'boss:telegraph'  { id, kind, x, z, ...shape, duration }
//   'boss:attack'     { id, kind }
//   'boss:hit'        { id, damage, hpLeft, hpFrac }
//   'boss:death'      { id, x, z }
//
// SCOPE GUARDS (per SPRINT-06 contract):
//   - Specific boss definitions live elsewhere (NOT here). This file is generic.
//   - No VFX beyond the telegraph descriptors emitted via getTelegraphs().
//   - No audio.
//   - No unavoidable attacks: every attack telegraphs first.

import { Vector3 } from 'three';

const DEFAULT_PHASE_TELEGRAPH = 2.5;
const MIN_ATTACK_TELEGRAPH = 0.25;     // counter-play floor for any attack
const TELEGRAPH_LIFETIME_PAD = 0.05;   // tail so renderers see the last frame

const SCRATCH_BOSS_SPAWN = { id: '', x: 0, z: 0, maxHp: 0 };
const SCRATCH_BOSS_PHASE = { id: '', phase: 0, total: 0, hpFrac: 1, enrage: false };
const SCRATCH_BOSS_HIT   = { id: '', damage: 0, hpLeft: 0, hpFrac: 1 };
const SCRATCH_BOSS_DEAD  = { id: '', x: 0, z: 0 };
const SCRATCH_BOSS_ATK   = { id: '', kind: '' };

/** Sub-states for the per-attack mini state machine. */
const A = Object.freeze({
  IDLE: 'idle',
  TELEGRAPH: 'telegraph',
  EXECUTE: 'execute',
  RECOVERY: 'recovery',
});

/** Top-level boss states. */
export const BOSS_STATE = Object.freeze({
  IDLE: 'idle',
  PHASE_TELEGRAPH: 'phase_telegraph',
  ACTIVE: 'active',
  DEAD: 'dead',
});

export class BossCore {
  /**
   * @param {object} deps
   * @param {object} deps.def                                  boss definition (see schema)
   * @param {import('../../engine/rng.js').RNG} [deps.rng]     seeded PRNG
   * @param {import('../../engine/events.js').EventBus} [deps.bus]
   * @param {import('../projectiles/pool.js').ProjectilePool} [deps.projectilePool]
   * @param {import('../enemies/index.js').EnemyManager} [deps.enemyManager]
   */
  constructor({ def, rng = null, bus = null, projectilePool = null, enemyManager = null } = {}) {
    if (!def) throw new Error('BossCore: def required');
    if (!Array.isArray(def.phases) || def.phases.length === 0) {
      throw new Error('BossCore: def.phases must be a non-empty array');
    }
    this.def = def;
    this.rng = rng;
    this.bus = bus;
    this.projectilePool = projectilePool;
    this.enemyManager = enemyManager;

    this.id = def.id || 'boss';
    this.position = new Vector3();
    this.size = def.size ?? 2.0;
    this.maxHp = def.maxHp ?? 1000;
    this.hp = this.maxHp;
    this.alive = false;
    this.state = BOSS_STATE.IDLE;

    this.phaseIndex = -1;                // not yet entered
    this._phaseClock = 0;                // seconds in current phase (post-telegraph)
    this._phaseTelegraphRemaining = 0;
    this._pendingPhase = -1;             // phase we're telegraphing toward
    this._enraged = false;

    // Per-attack runtime: parallel array to current phase's attacks[].
    this._attackRuntimes = [];

    // Active telegraph descriptors — exposed for the renderer.
    // Each entry: { kind, ttl, x, z, ...shape-specific fields }.
    this._telegraphs = [];

    // Active arena hazards — exposed for the player damage system.
    // Each entry: { x, z, radius, ttl, damagePerSec }.
    this._hazards = [];
  }

  // ---- public lifecycle ---------------------------------------------------

  /** Place the boss in the arena and enter its first phase (with telegraph). */
  spawn(pos = [0, 0, 0]) {
    this.position.set(pos[0] ?? 0, 0, pos[2] ?? pos[1] ?? 0);
    this.hp = this.maxHp;
    this.alive = true;
    this.state = BOSS_STATE.IDLE;
    this.phaseIndex = -1;
    this._enraged = false;
    this._telegraphs.length = 0;
    this._hazards.length = 0;
    this._attackRuntimes.length = 0;

    if (this.bus) {
      SCRATCH_BOSS_SPAWN.id = this.id;
      SCRATCH_BOSS_SPAWN.x = this.position.x;
      SCRATCH_BOSS_SPAWN.z = this.position.z;
      SCRATCH_BOSS_SPAWN.maxHp = this.maxHp;
      this.bus.emit('boss:spawn', SCRATCH_BOSS_SPAWN);
    }
    // Begin phase 0 with a telegraph.
    this._beginPhaseTransition(0);
  }

  /**
   * Per-frame tick.
   * @param {number} dt seconds
   * @param {{x:number,z:number}|null} playerPos used for aimed attacks
   * @param {Iterable<{position:{x:number,z:number}}>} [_enemies] reserved
   */
  update(dt, playerPos = null, _enemies = null) {
    if (!this.alive || !Number.isFinite(dt) || dt <= 0) return;

    // Tick telegraph TTLs (purely cosmetic lifetime).
    if (this._telegraphs.length) {
      for (let i = this._telegraphs.length - 1; i >= 0; i--) {
        this._telegraphs[i].ttl -= dt;
        if (this._telegraphs[i].ttl <= 0) this._telegraphs.splice(i, 1);
      }
    }
    // Tick hazards (their `damagePerSec` is consumed by the player damage system).
    if (this._hazards.length) {
      for (let i = this._hazards.length - 1; i >= 0; i--) {
        const h = this._hazards[i];
        h.ttl -= dt;
        if (h.ttl <= 0) this._hazards.splice(i, 1);
      }
    }

    switch (this.state) {
      case BOSS_STATE.PHASE_TELEGRAPH:
        this._phaseTelegraphRemaining -= dt;
        if (this._phaseTelegraphRemaining <= 0) this._enterPhase(this._pendingPhase);
        break;
      case BOSS_STATE.ACTIVE:
        this._phaseClock += dt;
        this._tickActive(dt, playerPos);
        break;
      default:
        break;
    }
  }

  /** Apply damage. Returns true if HP was actually reduced. */
  damage(amount) {
    if (!this.alive || !(amount > 0)) return false;
    this.hp = Math.max(0, this.hp - amount);
    const hpFrac = this.hp / this.maxHp;
    if (this.bus) {
      SCRATCH_BOSS_HIT.id = this.id;
      SCRATCH_BOSS_HIT.damage = amount;
      SCRATCH_BOSS_HIT.hpLeft = this.hp;
      SCRATCH_BOSS_HIT.hpFrac = hpFrac;
      this.bus.emit('boss:hit', SCRATCH_BOSS_HIT);
    }
    if (this.hp <= 0) {
      this._die();
      return true;
    }
    // HP-gated phase advance: jump to the latest phase whose threshold has been crossed.
    if (this.state === BOSS_STATE.ACTIVE) {
      let target = this.phaseIndex;
      for (let i = this.phaseIndex + 1; i < this.def.phases.length; i++) {
        if (hpFrac <= (this.def.phases[i].hpThreshold ?? 0)) target = i;
        else break;
      }
      if (target !== this.phaseIndex) this._beginPhaseTransition(target);
    }
    return true;
  }

  isAlive() { return this.alive; }
  getPhase() { return this.phaseIndex; }
  getHp() { return this.hp; }
  getMaxHp() { return this.maxHp; }
  getHpFraction() { return this.maxHp > 0 ? this.hp / this.maxHp : 0; }
  isEnraged() { return this._enraged; }
  /** Active telegraph descriptors (renderer consumes; read-only). */
  getTelegraphs() { return this._telegraphs; }
  /** Active arena hazards (player damage system consumes). */
  getHazards() { return this._hazards; }

  /** Tear down. Idempotent. */
  dispose() {
    this.alive = false;
    this.state = BOSS_STATE.DEAD;
    this._telegraphs.length = 0;
    this._hazards.length = 0;
    this._attackRuntimes.length = 0;
  }

  // ---- phase machinery ----------------------------------------------------

  _beginPhaseTransition(nextIndex) {
    // Telegraph the upcoming phase change. Same machinery used for the
    // initial entry into phase 0 so audio/VFX gets a consistent "stinger".
    const tele = this.def.phaseTelegraph ?? DEFAULT_PHASE_TELEGRAPH;
    this._pendingPhase = nextIndex;
    this._phaseTelegraphRemaining = Math.max(0.01, tele);
    this.state = BOSS_STATE.PHASE_TELEGRAPH;
    // Clear any in-flight attack telegraphs from the prior phase so the
    // overlay reads cleanly.
    this._attackRuntimes.length = 0;
    this._pushTelegraph({
      kind: 'phase',
      ttl: this._phaseTelegraphRemaining + TELEGRAPH_LIFETIME_PAD,
      x: this.position.x,
      z: this.position.z,
      radius: this.size * 1.5,
      phase: nextIndex,
    });
    if (this.bus) {
      this.bus.emit('boss:telegraph', {
        id: this.id,
        kind: 'phase',
        x: this.position.x,
        z: this.position.z,
        radius: this.size * 1.5,
        duration: this._phaseTelegraphRemaining,
        phase: nextIndex,
      });
    }
  }

  _enterPhase(index) {
    this.phaseIndex = index;
    this._phaseClock = 0;
    this._enraged = false;
    this.state = BOSS_STATE.ACTIVE;
    // Build attack runtimes for this phase.
    const phase = this.def.phases[index];
    const attacks = Array.isArray(phase.attacks) ? phase.attacks : [];
    this._attackRuntimes.length = 0;
    for (let i = 0; i < attacks.length; i++) {
      const a = attacks[i];
      // Stagger initial timers so multiple attacks don't fire on the same frame.
      const stagger = this.rng ? this.rng.float() * 0.4 : (i * 0.1);
      this._attackRuntimes.push({
        spec: a,
        sub: A.IDLE,
        timer: stagger,           // counts down to next telegraph start
        executionTimer: 0,        // seconds since execute() entry
        executionShots: 0,        // shots fired so far this execution
        executionPlanned: 0,      // shots planned this execution (spiral/sweep)
        ctx: null,                // per-execution context (start angle, etc.)
      });
    }
    if (this.bus) {
      SCRATCH_BOSS_PHASE.id = this.id;
      SCRATCH_BOSS_PHASE.phase = index;
      SCRATCH_BOSS_PHASE.total = this.def.phases.length;
      SCRATCH_BOSS_PHASE.hpFrac = this.getHpFraction();
      SCRATCH_BOSS_PHASE.enrage = false;
      this.bus.emit('boss:phase', SCRATCH_BOSS_PHASE);
    }
  }

  _tickActive(dt, playerPos) {
    const phase = this.def.phases[this.phaseIndex];
    if (!phase) return;

    // Enrage check.
    const enrageTime = phase.enrageTime ?? Infinity;
    if (!this._enraged && this._phaseClock >= enrageTime) {
      this._enraged = true;
      // If a later phase exists, force-transition. Otherwise emit an enrage
      // stinger and continue (cooldowns shrink in _tickAttack via enrageMul).
      if (this.phaseIndex + 1 < this.def.phases.length) {
        this._beginPhaseTransition(this.phaseIndex + 1);
        return;
      }
      if (this.bus) {
        SCRATCH_BOSS_PHASE.id = this.id;
        SCRATCH_BOSS_PHASE.phase = this.phaseIndex;
        SCRATCH_BOSS_PHASE.total = this.def.phases.length;
        SCRATCH_BOSS_PHASE.hpFrac = this.getHpFraction();
        SCRATCH_BOSS_PHASE.enrage = true;
        this.bus.emit('boss:phase', SCRATCH_BOSS_PHASE);
      }
    }

    const enrageMul = this._enraged ? 0.5 : 1.0; // shorter cooldown when enraged
    for (let i = 0; i < this._attackRuntimes.length; i++) {
      this._tickAttack(this._attackRuntimes[i], dt, playerPos, enrageMul);
    }
  }

  _tickAttack(rt, dt, playerPos, enrageMul) {
    const spec = rt.spec;
    rt.timer -= dt;
    if (rt.sub === A.IDLE) {
      if (rt.timer <= 0) {
        rt.sub = A.TELEGRAPH;
        rt.timer = Math.max(MIN_ATTACK_TELEGRAPH, spec.telegraphDuration ?? 0.8);
        this._beginTelegraph(rt, playerPos);
      }
      return;
    }
    if (rt.sub === A.TELEGRAPH) {
      if (rt.timer <= 0) {
        rt.sub = A.EXECUTE;
        rt.executionTimer = 0;
        rt.executionShots = 0;
        rt.timer = Math.max(0.0, spec.executionDuration ?? 0);
        this._beginExecute(rt, playerPos);
      }
      return;
    }
    if (rt.sub === A.EXECUTE) {
      rt.executionTimer += dt;
      this._tickExecute(rt);
      if (rt.timer <= 0) {
        rt.sub = A.RECOVERY;
        rt.timer = Math.max(0.05, (spec.cooldown ?? 1.0) * enrageMul);
      }
      return;
    }
    if (rt.sub === A.RECOVERY) {
      if (rt.timer <= 0) {
        rt.sub = A.IDLE;
        rt.timer = 0;
      }
    }
  }

  // ---- attack primitive dispatch -----------------------------------------

  _beginTelegraph(rt, playerPos) {
    const spec = rt.spec;
    const type = spec.type;
    const params = spec.params || {};
    const tele = Math.max(MIN_ATTACK_TELEGRAPH, spec.telegraphDuration ?? 0.8);
    const ttl = tele + TELEGRAPH_LIFETIME_PAD;
    const cx = this.position.x;
    const cz = this.position.z;

    if (type === 'radialBurst' || type === 'spiral') {
      this._pushTelegraph({
        kind: `attack:${type}`,
        ttl, x: cx, z: cz, radius: this.size * 1.2,
      });
      if (type === 'spiral') {
        rt.ctx = { startAngle: this.rng ? this.rng.float() * Math.PI * 2 : 0 };
      }
    } else if (type === 'aimedVolley') {
      const aim = this._aimAngle(playerPos);
      const length = Math.max(8, params.range ?? 18);
      this._pushTelegraph({
        kind: 'attack:aimedVolley',
        ttl, x: cx, z: cz,
        angle: aim,
        length,
        width: params.spread ? Math.max(0.4, length * Math.sin(params.spread / 2)) : 0.6,
      });
      rt.ctx = { angle: aim };
    } else if (type === 'sweep') {
      const aim = this._aimAngle(playerPos);
      const length = params.length ?? 18;
      const width = params.width ?? 1.5;
      this._pushTelegraph({
        kind: 'attack:sweep',
        ttl, x: cx, z: cz,
        angle: aim,
        length, width,
      });
      rt.ctx = { angle: aim, length, width };
    } else if (type === 'summon') {
      const count = Math.max(1, params.count ?? 3);
      const offsets = [];
      for (let i = 0; i < count; i++) {
        const ang = this.rng
          ? this.rng.float() * Math.PI * 2
          : (i / count) * Math.PI * 2;
        const r = this.size * (1.0 + (this.rng ? this.rng.float() * 0.6 : 0.3));
        const ox = Math.cos(ang) * r;
        const oz = Math.sin(ang) * r;
        offsets.push({ x: ox, z: oz });
        this._pushTelegraph({
          kind: 'attack:summon',
          ttl, x: cx + ox, z: cz + oz,
          radius: 0.6,
        });
      }
      rt.ctx = { offsets };
    } else if (type === 'arenaHazard') {
      const radius = params.radius ?? 3;
      let ox = 0, oz = 0;
      if (params.offset) { ox = params.offset[0] ?? 0; oz = params.offset[1] ?? 0; }
      else if (this.rng) {
        const ang = this.rng.float() * Math.PI * 2;
        const dist = this.rng.float() * Math.max(2, this.size * 2);
        ox = Math.cos(ang) * dist; oz = Math.sin(ang) * dist;
      }
      this._pushTelegraph({
        kind: 'attack:arenaHazard',
        ttl, x: cx + ox, z: cz + oz,
        radius,
      });
      rt.ctx = { x: cx + ox, z: cz + oz, radius };
    } else {
      // Unknown type — still telegraph so the cycle doesn't stall forever.
      this._pushTelegraph({
        kind: `attack:${type || 'unknown'}`,
        ttl, x: cx, z: cz, radius: this.size,
      });
    }

    if (this.bus) {
      this.bus.emit('boss:telegraph', {
        id: this.id,
        kind: `attack:${type}`,
        x: cx, z: cz,
        duration: tele,
      });
    }
  }

  _beginExecute(rt, playerPos) {
    const type = rt.spec.type;
    const params = rt.spec.params || {};
    if (type === 'radialBurst') {
      this._fireRadialBurst(params);
      this._emitAttack('radialBurst');
    } else if (type === 'aimedVolley') {
      this._fireAimedVolley(params, rt.ctx?.angle ?? this._aimAngle(playerPos));
      this._emitAttack('aimedVolley');
    } else if (type === 'summon') {
      this._fireSummon(params, rt.ctx?.offsets || []);
      this._emitAttack('summon');
    } else if (type === 'arenaHazard') {
      this._fireArenaHazard(params, rt.ctx);
      this._emitAttack('arenaHazard');
    } else if (type === 'spiral') {
      rt.executionPlanned = Math.max(1, params.count ?? 24);
      this._emitAttack('spiral');
    } else if (type === 'sweep') {
      rt.executionPlanned = Math.max(2, params.segments ?? 8);
      this._emitAttack('sweep');
    }
  }

  _tickExecute(rt) {
    const type = rt.spec.type;
    const params = rt.spec.params || {};
    const duration = Math.max(0.0001, rt.spec.executionDuration ?? 0.0001);
    if (type === 'spiral') {
      const planned = rt.executionPlanned;
      const interval = duration / planned;
      while (
        rt.executionShots < planned &&
        rt.executionTimer >= (rt.executionShots + 1) * interval
      ) {
        this._fireSpiralStep(params, rt.ctx?.startAngle ?? 0, rt.executionShots, planned);
        rt.executionShots += 1;
      }
    } else if (type === 'sweep') {
      const segments = rt.executionPlanned;
      const interval = duration / segments;
      while (
        rt.executionShots < segments &&
        rt.executionTimer >= (rt.executionShots + 1) * interval
      ) {
        this._fireSweepStep(params, rt.ctx, rt.executionShots, segments);
        rt.executionShots += 1;
      }
    }
    // radialBurst/aimedVolley/summon/arenaHazard fire once on _beginExecute.
  }

  // ---- attack primitive implementations ----------------------------------

  _fireRadialBurst(params) {
    const pool = this.projectilePool;
    if (!pool) return;
    const count = Math.max(1, params.count ?? 12);
    const speed = params.speed ?? 9;
    const damage = params.damage ?? 8;
    const spread = params.spread ?? (Math.PI * 2);
    const start = params.startAngle ?? (this.rng ? this.rng.float() * Math.PI * 2 : 0);
    const color = params.color ?? 0xff5577;
    const size = params.size ?? 1.0;
    const ttl = params.ttl ?? 3.0;
    const isFull = spread >= Math.PI * 2 - 1e-3;
    for (let i = 0; i < count; i++) {
      const ang = isFull
        ? start + (i / count) * Math.PI * 2
        : start + (count === 1 ? 0 : (-spread / 2 + (i * spread) / (count - 1)));
      pool.spawn({
        position: [this.position.x, 0, this.position.z],
        direction: [Math.cos(ang), 0, Math.sin(ang)],
        speed, damage, ttl, color, size,
      });
    }
  }

  _fireSpiralStep(params, startAngle, shotIdx, totalShots) {
    const pool = this.projectilePool;
    if (!pool) return;
    const arms = Math.max(1, params.arms ?? 1);
    const rotation = params.rotation ?? Math.PI * 2;
    const speed = params.speed ?? 8;
    const damage = params.damage ?? 8;
    const color = params.color ?? 0xff9955;
    const size = params.size ?? 1.0;
    const ttl = params.ttl ?? 3.5;
    const baseAng = startAngle + (shotIdx / totalShots) * rotation;
    for (let a = 0; a < arms; a++) {
      const ang = baseAng + (a / arms) * Math.PI * 2;
      pool.spawn({
        position: [this.position.x, 0, this.position.z],
        direction: [Math.cos(ang), 0, Math.sin(ang)],
        speed, damage, ttl, color, size,
      });
    }
  }

  _fireAimedVolley(params, angle) {
    const pool = this.projectilePool;
    if (!pool) return;
    const count = Math.max(1, params.count ?? 1);
    const spread = params.spread ?? 0;
    const speed = params.speed ?? 14;
    const damage = params.damage ?? 12;
    const color = params.color ?? 0xff3333;
    const size = params.size ?? 1.1;
    const ttl = params.ttl ?? 2.5;
    for (let i = 0; i < count; i++) {
      const offset = count === 1 ? 0 : (-spread / 2 + (i * spread) / (count - 1));
      const ang = angle + offset;
      pool.spawn({
        position: [this.position.x, 0, this.position.z],
        direction: [Math.cos(ang), 0, Math.sin(ang)],
        speed, damage, ttl, color, size,
      });
    }
  }

  _fireSweepStep(params, ctx, idx, total) {
    const pool = this.projectilePool;
    if (!pool || !ctx) return;
    const speed = params.speed ?? 10;
    const damage = params.damage ?? 10;
    const color = params.color ?? 0xffaa33;
    const size = params.size ?? 1.0;
    const ttl = params.ttl ?? 2.5;
    const width = ctx.width;
    const angle = ctx.angle;
    const perpX = -Math.sin(angle), perpZ = Math.cos(angle);
    const t = total === 1 ? 0 : (idx / (total - 1)) - 0.5;
    const ox = perpX * t * width;
    const oz = perpZ * t * width;
    pool.spawn({
      position: [this.position.x + ox, 0, this.position.z + oz],
      direction: [Math.cos(angle), 0, Math.sin(angle)],
      speed, damage, ttl, color, size,
    });
  }

  _fireSummon(params, offsets) {
    const mgr = this.enemyManager;
    if (!mgr || typeof mgr.spawn !== 'function') return;
    const type = params.type;
    if (!type) return;
    const subParams = params.params || {};
    const list = offsets.length > 0 ? offsets : [{ x: 0, z: 0 }];
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      try {
        mgr.spawn({
          type,
          position: [this.position.x + o.x, 0, this.position.z + o.z],
          params: subParams,
        });
      } catch (_e) {
        // Unknown type or capacity hit — silently drop; framework is best-effort.
      }
    }
  }

  _fireArenaHazard(params, ctx) {
    if (!ctx) return;
    this._hazards.push({
      x: ctx.x,
      z: ctx.z,
      radius: ctx.radius ?? params.radius ?? 3,
      ttl: params.duration ?? 3.0,
      damagePerSec: params.damagePerSec ?? 12,
    });
  }

  // ---- helpers ------------------------------------------------------------

  _aimAngle(playerPos) {
    if (!playerPos) return this.rng ? this.rng.float() * Math.PI * 2 : 0;
    const dx = (playerPos.x ?? 0) - this.position.x;
    const dz = (playerPos.z ?? 0) - this.position.z;
    if (dx === 0 && dz === 0) return 0;
    return Math.atan2(dz, dx);
  }

  _pushTelegraph(tg) {
    this._telegraphs.push(tg);
  }

  _emitAttack(kind) {
    if (!this.bus) return;
    SCRATCH_BOSS_ATK.id = this.id;
    SCRATCH_BOSS_ATK.kind = kind;
    this.bus.emit('boss:attack', SCRATCH_BOSS_ATK);
  }

  _die() {
    this.alive = false;
    this.state = BOSS_STATE.DEAD;
    this._telegraphs.length = 0;
    this._hazards.length = 0;
    if (this.bus) {
      SCRATCH_BOSS_DEAD.id = this.id;
      SCRATCH_BOSS_DEAD.x = this.position.x;
      SCRATCH_BOSS_DEAD.z = this.position.z;
      this.bus.emit('boss:death', SCRATCH_BOSS_DEAD);
    }
  }
}

export default BossCore;
