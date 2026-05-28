// Enemy manager — single owner of all live enemies.
//
// Rendering: enemies are NOT given individual meshes. Instead each spawned
// enemy registers an ECS entity with ('transform', 'enemyType') components,
// which EnemyInstancedRenderers (one InstancedMesh per type) reads each frame.
// That keeps draw calls flat regardless of population size.
//
// Public API (intended for the spawn director and the rest of the game):
//   const mgr = new EnemyManager({ ecs, bus, projectiles, gravity });
//   mgr.setPlayer(playerShip);
//   const id = mgr.spawn({ type: 'chaser', position: [x, 0, z], ... });
//   mgr.update(dt, time);
//   mgr.damage(id, amount, sourceId?);
//   mgr.forEach((enemy) => { ... });
//   mgr.kill(id);
//
// Event bus contract (payloads are reused scratch objects — read fields,
// don't retain references):
//   'enemy:spawn'  { id, type, x, z }
//   'enemy:fire'   { id, type, x, z, dirX, dirZ }      (shooter only)
//   'enemy:hit'    { id, type, x, z, damage, hpLeft }  (per damage event)
//   'enemy:death'  { id, type, x, z, cause }
//
// Death cause values: 'damage' | 'horizon' | 'cleanup'. The director can grow
// this list later (e.g. 'despawn-offscreen').

import { Vector3 } from 'three';
import { ENEMY_DEFAULTS, ENEMY_TYPES } from './types.js';
import { createChaserState, tickChaser } from './chaser.js';
import { createShooterState, tickShooter } from './shooter.js';
import { createOrbiterState, tickOrbiter } from './orbiter.js';

const SCRATCH_HIT  = { id: 0, type: '', x: 0, z: 0, damage: 0, hpLeft: 0 };
const SCRATCH_DEAD = { id: 0, type: '', x: 0, z: 0, cause: '' };
const SCRATCH_SPAWN = { id: 0, type: '', x: 0, z: 0 };

function defaultsFor(type) {
  const d = ENEMY_DEFAULTS[type];
  if (!d) throw new Error(`EnemyManager: unknown enemy type '${type}'`);
  return d;
}

export class EnemyManager {
  /**
   * @param {object} deps
   * @param {import('../../engine/ecs.js').ECS} deps.ecs
   * @param {import('../events.js').EventBus} [deps.bus]
   * @param {import('../projectiles/pool.js').ProjectilePool} [deps.projectiles]
   * @param {{ position: { x:number, z:number } }} [deps.gravity]
   */
  constructor({ ecs, bus = null, projectiles = null, gravity = null } = {}) {
    if (!ecs) throw new Error('EnemyManager: ecs required');
    this.ecs = ecs;
    this.bus = bus;
    this.projectiles = projectiles;
    this.gravity = gravity;
    this.player = null;
    this.enemies = new Map(); // id -> enemy record
    this._time = 0;
  }

  setPlayer(p) { this.player = p; }

  /**
   * Spawn a new enemy.
   * @param {object} opts
   * @param {'chaser'|'shooter'|'orbiter'} opts.type
   * @param {[number,number,number]} [opts.position]
   * @param {object} [opts.params] type-specific overrides
   * @returns {number} enemy id (== ECS entity id)
   */
  spawn({ type, position = [0, 0, 0], params = {} } = {}) {
    const d = defaultsFor(type);

    let state;
    if (type === ENEMY_TYPES.CHASER) {
      state = createChaserState(params);
    } else if (type === ENEMY_TYPES.SHOOTER) {
      state = createShooterState(params);
    } else if (type === ENEMY_TYPES.ORBITER) {
      const cx = this.gravity?.position?.x ?? 0;
      const cz = this.gravity?.position?.z ?? 0;
      const dx = position[0] - cx;
      const dz = position[2] - cz;
      const r = Math.hypot(dx, dz);
      const initialAngle = params.angle ?? (r > 0.01 ? Math.atan2(dz, dx) : Math.random() * Math.PI * 2);
      state = createOrbiterState({
        ...params,
        angle: initialAngle,
        orbitRadius: params.orbitRadius ?? (r > 0.5 ? r : d.defaultOrbitRadius),
      });
    } else {
      throw new Error(`EnemyManager: unknown enemy type '${type}'`);
    }

    const id = this.ecs.create();
    const enemy = {
      id,
      type,
      alive: true,
      health: params.health ?? d.health,
      maxHealth: params.health ?? d.health,
      position: new Vector3(position[0], 0, position[2]),
      velocity: new Vector3(),
      radius: d.radius,
      state,
    };
    this.enemies.set(id, enemy);

    // ECS components consumed by EnemyInstancedRenderers.
    this.ecs.add(id, 'transform', {
      position: enemy.position,           // shared reference; updated in place
      rotationY: 0,
      scale: 1,
    });
    this.ecs.add(id, 'enemyType', {
      type,
      color: params.color ?? d.color,
    });

    if (this.bus) {
      SCRATCH_SPAWN.id = id;
      SCRATCH_SPAWN.type = type;
      SCRATCH_SPAWN.x = enemy.position.x;
      SCRATCH_SPAWN.z = enemy.position.z;
      this.bus.emit('enemy:spawn', SCRATCH_SPAWN);
    }
    return id;
  }

  /** Apply damage; emits 'enemy:hit' and 'enemy:death' as appropriate. */
  damage(id, amount, sourceId = null) {
    const e = this.enemies.get(id);
    if (!e || !e.alive) return false;
    e.health = Math.max(0, e.health - amount);
    if (this.bus) {
      SCRATCH_HIT.id = id;
      SCRATCH_HIT.type = e.type;
      SCRATCH_HIT.x = e.position.x;
      SCRATCH_HIT.z = e.position.z;
      SCRATCH_HIT.damage = amount;
      SCRATCH_HIT.hpLeft = e.health;
      this.bus.emit('enemy:hit', SCRATCH_HIT);
    }
    if (e.health <= 0) this._kill(e, 'damage', sourceId);
    return true;
  }

  /** Explicit kill (e.g. consumed by event horizon). */
  kill(id, cause = 'cleanup') {
    const e = this.enemies.get(id);
    if (!e || !e.alive) return;
    this._kill(e, cause, null);
  }

  _kill(enemy, cause /*, sourceId */) {
    enemy.alive = false;
    this.enemies.delete(enemy.id);
    this.ecs.destroy(enemy.id);
    if (this.bus) {
      SCRATCH_DEAD.id = enemy.id;
      SCRATCH_DEAD.type = enemy.type;
      SCRATCH_DEAD.x = enemy.position.x;
      SCRATCH_DEAD.z = enemy.position.z;
      SCRATCH_DEAD.cause = cause;
      this.bus.emit('enemy:death', SCRATCH_DEAD);
    }
  }

  forEach(cb) { for (const e of this.enemies.values()) cb(e); }
  get count() { return this.enemies.size; }

  /**
   * Per-frame update.
   * @param {number} dt seconds
   * @param {number} [time] world clock (used by some behaviors)
   */
  update(dt, time = this._time + dt) {
    this._time = time;
    const ctx = {
      player: this.player,
      projectiles: this.projectiles,
      gravity: this.gravity,
      bus: this.bus,
      time,
    };

    // Behavior tick + integration.
    for (const e of this.enemies.values()) {
      if (e.type === ENEMY_TYPES.CHASER) tickChaser(e, dt, ctx);
      else if (e.type === ENEMY_TYPES.SHOOTER) tickShooter(e, dt, ctx);
      else if (e.type === ENEMY_TYPES.ORBITER) tickOrbiter(e, dt, ctx);

      // Orbiter writes position directly. Others integrate from velocity.
      if (e.type !== ENEMY_TYPES.ORBITER) {
        e.position.x += e.velocity.x * dt;
        e.position.z += e.velocity.z * dt;
      }
      // Refresh ECS transform rotation (position is shared by reference).
      const tr = this.ecs.get(e.id, 'transform');
      if (tr) {
        if (e.velocity.x * e.velocity.x + e.velocity.z * e.velocity.z > 0.04) {
          tr.rotationY = Math.atan2(e.velocity.x, e.velocity.z);
        }
      }
    }

    // Cull anything that crosses the event horizon, if we have a gravity ref.
    if (this.gravity?.position) {
      const cx = this.gravity.position.x ?? 0;
      const cz = this.gravity.position.z ?? 0;
      const horizon = (this.gravity.horizonRadius ?? 2.4);
      const h2 = horizon * horizon;
      const ids = [];
      for (const e of this.enemies.values()) {
        const dx = e.position.x - cx;
        const dz = e.position.z - cz;
        if (dx * dx + dz * dz <= h2) ids.push(e.id);
      }
      for (const id of ids) {
        const e = this.enemies.get(id);
        if (e) this._kill(e, 'horizon', null);
      }
    }

    // Contact damage on player. Chaser and orbiter both contact-damage.
    const p = this.player;
    if (p && p.alive) {
      for (const e of this.enemies.values()) {
        const cd = e.state.contactDamage;
        if (!cd) continue;
        const dx = p.position.x - e.position.x;
        const dz = p.position.z - e.position.z;
        const r = (e.state.contactRadius ?? e.radius) + 0.6; // ship hull approx
        if (dx * dx + dz * dz <= r * r) {
          if (typeof p.damage === 'function') p.damage(cd * dt * 4); // dps-style
        }
      }
    }
  }

  /** Tear down all enemies (e.g. on level reset). */
  clear() {
    const ids = [...this.enemies.keys()];
    for (const id of ids) {
      const e = this.enemies.get(id);
      if (e) this._kill(e, 'cleanup', null);
    }
  }
}

export { ENEMY_TYPES, ENEMY_DEFAULTS };
