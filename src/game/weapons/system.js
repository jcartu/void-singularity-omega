// WeaponSystem — interprets weapon defs, manages cooldowns, fires through ProjectilePool.
//
// The system stays pure-logic: it owns no Three.js objects. It depends on a
// pool that satisfies the contract documented in ../projectiles/pool.js.
//
// New (SPRINT-03) responsibilities:
//   - Behavior dispatch via def.behavior (see ./defs.js).
//   - Per-bullet steering for 'homing' and 'ricochet' (mutates pool.vx/vy/vz).
//   - Per-bullet gravity for 'arc'.
//   - Secondary weapons gated by energy + cooldown; cycle() only walks primaries.
//   - Optional integration callbacks (enemyProvider/gravitySpawner/droneSpawner)
//     so subsystems can wire in incrementally without breaking the public API.
//
// All callbacks are OPTIONAL — every weapon must at least fire without error
// (visible projectile or accepted no-op) when integrations are absent.

import { WEAPONS, WEAPON_ORDER, SECONDARY_ORDER, ALL_WEAPONS_ORDER } from './defs.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

export class WeaponSystem {
  constructor({
    pool,
    defs = WEAPONS,
    order = WEAPON_ORDER,
    secondaryOrder = SECONDARY_ORDER,
    allOrder = ALL_WEAPONS_ORDER,
    ship = null,
    enemyProvider = null,    // () => Iterable<{ position:{x,y,z}, alive?:boolean, id?:any }>
    gravitySpawner = null,   // ({x,y,z,duration,mass,radius}) => void
    droneSpawner = null,     // ({position,direction,count,duration,fireRate,damage,color,orbitRadius}) => void
  } = {}) {
    this.pool = pool;
    this.defs = defs;
    this.order = order.slice();
    this.secondaryOrder = secondaryOrder.slice();
    this.allOrder = allOrder.slice();
    this.ship = ship;
    this.enemyProvider = enemyProvider;
    this.gravitySpawner = gravitySpawner;
    this.droneSpawner = droneSpawner;

    this.cooldowns = Object.create(null);
    for (const id of this.allOrder) this.cooldowns[id] = 0;

    this.activeId = this.order[0];

    // Per-bullet tracking. Each entry references a pool slot index. We sweep
    // entries every update() and drop ones whose slot has been recycled.
    // {slot, def, alive, ...behavior-specific}
    this._tracked = [];

    // Active slow / drone / well effects, ticked in update().
    this._slowZones = [];   // {x,z,radius,coneDeg,headingX,headingZ,factor,ttl}
    this._drones = [];      // {originRef, count, ttl, fireTimer, fireRate, damage, speed, color, orbitRadius, droneAngles[]}
  }

  // ---------------------------------------------------------------------
  //  INTEGRATION SETTERS (optional; safe defaults)
  // ---------------------------------------------------------------------

  setShip(ship) { this.ship = ship; }
  setEnemyProvider(fn) { this.enemyProvider = fn; }
  setGravitySpawner(fn) { this.gravitySpawner = fn; }
  setDroneSpawner(fn) { this.droneSpawner = fn; }

  // ---------------------------------------------------------------------
  //  PRIMARY SELECTION (1..6 / Q cycle)
  // ---------------------------------------------------------------------

  setActive(id) {
    if (this.defs[id]) this.activeId = id;
  }

  cycle(dir = 1) {
    // Cycle within PRIMARIES only — secondaries are fired explicitly.
    const primaries = this.order;
    let idx = primaries.indexOf(this.activeId);
    if (idx < 0) idx = 0;
    const next = (idx + dir + primaries.length) % primaries.length;
    this.activeId = primaries[next];
  }

  // ---------------------------------------------------------------------
  //  PER-FRAME TICK
  // ---------------------------------------------------------------------

  update(dt) {
    // 1. Cooldowns.
    for (const id of this.allOrder) {
      if (this.cooldowns[id] > 0) {
        this.cooldowns[id] = Math.max(0, this.cooldowns[id] - dt);
      }
    }

    // 2. Per-bullet steering + arc gravity.
    this._tickTrackedBullets(dt);

    // 3. Slow zones.
    if (this._slowZones.length) {
      for (let i = this._slowZones.length - 1; i >= 0; i--) {
        const z = this._slowZones[i];
        z.ttl -= dt;
        if (z.ttl <= 0) this._slowZones.splice(i, 1);
      }
    }

    // 4. Drone swarms (autonomous auto-fire while ttl > 0).
    if (this._drones.length) {
      this._tickDrones(dt);
    }
  }

  _tickTrackedBullets(dt) {
    const pool = this.pool;
    if (!pool) return;
    const tracked = this._tracked;
    if (tracked.length === 0) return;

    for (let i = tracked.length - 1; i >= 0; i--) {
      const t = tracked[i];
      const slot = t.slot;
      // Slot recycled or expired? drop tracker.
      if (!pool.alive || !pool.alive[slot]) {
        tracked.splice(i, 1);
        continue;
      }

      switch (t.behavior) {
        case 'homing':   this._steerHoming(t, dt); break;
        case 'ricochet': this._tickRicochet(t, dt); break;
        case 'arc':      this._tickArc(t, dt); break;
        default: break;
      }
    }
  }

  _steerHoming(t, dt) {
    const pool = this.pool;
    const slot = t.slot;
    const px = pool.px[slot], py = pool.py[slot], pz = pool.pz[slot];
    const vx = pool.vx[slot], vy = pool.vy[slot], vz = pool.vz[slot];
    const target = this._nearestEnemyInCone(px, pz, vx, vz, t.fovDeg, null);
    if (!target) return;

    const dx = target.position.x - px;
    const dz = target.position.z - pz;
    const dlen = Math.hypot(dx, dz) || 1;
    const tx = dx / dlen, tz = dz / dlen;

    // Current velocity normalized.
    const speed = Math.hypot(vx, vy, vz) || 1;
    const nx = vx / speed, nz = vz / speed;

    // Slerp-ish: blend toward target by turnRate*dt.
    const maxStep = t.turnRate * dt;
    // angle between (nx,nz) and (tx,tz)
    const dot = nx * tx + nz * tz;
    const ang = Math.acos(Math.max(-1, Math.min(1, dot)));
    const step = Math.min(maxStep, ang);
    if (step <= 1e-5) return;
    // Cross sign to pick rotation direction (Y-up).
    const cross = nx * tz - nz * tx;
    const sign = cross >= 0 ? 1 : -1;
    const ca = Math.cos(step * sign);
    const sa = Math.sin(step * sign);
    const rx = nx * ca + nz * sa;
    const rz = -nx * sa + nz * ca;
    pool.vx[slot] = rx * speed;
    pool.vz[slot] = rz * speed;
    // vy left untouched (homing stays on XZ plane).
  }

  _tickRicochet(t, dt) {
    // No engine-level collision plumbing yet — proxy "bounce" via proximity:
    // if the bullet enters proximity of an unhit enemy, redirect velocity
    // toward the next-nearest unhit enemy and consume one bounce.
    const pool = this.pool;
    const slot = t.slot;
    const px = pool.px[slot], pz = pool.pz[slot];
    const speed = Math.hypot(pool.vx[slot], pool.vy[slot], pool.vz[slot]) || 1;

    const PROX = 1.8;
    const PROX2 = PROX * PROX;

    const enemies = this._collectEnemies();
    if (!enemies || enemies.length === 0) return;

    // Find a candidate within proximity that we haven't bounced off yet.
    let hit = null;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e || e.alive === false) continue;
      if (t.hitIds.has(e.id)) continue;
      const dx = e.position.x - px;
      const dz = e.position.z - pz;
      if (dx * dx + dz * dz <= PROX2) { hit = e; break; }
    }
    if (!hit) return;

    t.hitIds.add(hit.id);
    if (t.bouncesLeft <= 0) {
      pool.kill(slot);
      return;
    }
    t.bouncesLeft--;

    // Pick next target (any enemy not yet bounced); fall back to current dir.
    let next = null;
    let best = Infinity;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e || e.alive === false) continue;
      if (t.hitIds.has(e.id)) continue;
      const dx = e.position.x - px;
      const dz = e.position.z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) { best = d2; next = e; }
    }
    if (next) {
      const dx = next.position.x - px;
      const dz = next.position.z - pz;
      const len = Math.hypot(dx, dz) || 1;
      pool.vx[slot] = (dx / len) * speed;
      pool.vz[slot] = (dz / len) * speed;
      pool.vy[slot] = 0;
    } else {
      // No more targets — let it ride or kill it.
      pool.kill(slot);
    }
  }

  _tickArc(t, dt) {
    // Apply downward gravity to vy; pool integrates positions.
    this.pool.vy[t.slot] -= t.gravity * dt;
  }

  _tickDrones(dt) {
    const pool = this.pool;
    for (let i = this._drones.length - 1; i >= 0; i--) {
      const d = this._drones[i];
      d.ttl -= dt;
      if (d.ttl <= 0) { this._drones.splice(i, 1); continue; }

      // Orbit angle accumulators (each drone offset evenly).
      d.angle = (d.angle + d.orbitSpeed * dt) % TAU;
      d.fireTimer -= dt;
      if (d.fireTimer <= 0 && pool) {
        d.fireTimer += d.fireRate;

        // Origin: ship position if known, else (0,0,0).
        const ox = this.ship?.position?.x ?? 0;
        const oz = this.ship?.position?.z ?? 0;
        const oy = (this.ship?.position?.y ?? 0) + 0.4;

        for (let k = 0; k < d.count; k++) {
          const a = d.angle + (k * TAU / d.count);
          const dx = Math.cos(a);
          const dz = Math.sin(a);
          const px = ox + dx * d.orbitRadius;
          const pz = oz + dz * d.orbitRadius;

          // Aim at nearest enemy; fallback to radial outward.
          const target = this._nearestEnemy(px, pz);
          let aimx = dx, aimz = dz;
          if (target) {
            const tx = target.position.x - px;
            const tz = target.position.z - pz;
            const len = Math.hypot(tx, tz) || 1;
            aimx = tx / len; aimz = tz / len;
          }
          pool.spawn({
            position: [px, oy, pz],
            direction: [aimx, 0, aimz],
            speed: d.speed,
            damage: d.damage,
            pierce: 0,
            ttl: 1.0,
            color: d.color,
            size: 0.7,
          });
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  //  HUD STATE
  // ---------------------------------------------------------------------

  /** Cooldown HUD snapshot. Includes primaries + secondaries. */
  getCooldownState() {
    const out = [];
    for (const id of this.allOrder) {
      const def = this.defs[id];
      if (!def) continue;
      const remaining = this.cooldowns[id];
      out.push({
        id,
        name: def.name,
        type: def.type,
        cooldown: def.cooldown,
        remaining,
        ratio: def.cooldown > 0 ? 1 - remaining / def.cooldown : 1,
        active: id === this.activeId,
        hudIcon: def.hudIcon,
        energyCost: def.energyCost || 0,
      });
    }
    return out;
  }

  ready(id = this.activeId) {
    return this.cooldowns[id] <= 0;
  }

  // ---------------------------------------------------------------------
  //  FIRE
  // ---------------------------------------------------------------------

  /**
   * Fire a weapon by id (defaults to the active primary).
   * @param {{position:[number,number,number], direction:[number,number,number]}} ctx
   * @returns {number} bullets / effects spawned, or 0 if blocked.
   */
  fire(ctx, id = this.activeId) {
    const def = this.defs[id];
    if (!def) return 0;
    if (this.cooldowns[id] > 0) return 0;

    // Secondary energy gate.
    if (def.type === 'secondary' && (def.energyCost || 0) > 0) {
      if (!this.ship || (this.ship.energy ?? 0) < def.energyCost) return 0;
    }

    const spawned = this._dispatch(def, ctx);

    if (spawned > 0 || def.type === 'secondary') {
      this.cooldowns[id] = def.cooldown;
      if (def.type === 'secondary' && def.energyCost > 0 && this.ship) {
        this.ship.energy = Math.max(0, this.ship.energy - def.energyCost);
      }
    }
    return spawned;
  }

  _dispatch(def, ctx) {
    switch (def.behavior) {
      case 'straight':  return this._fireStraight(def, ctx);
      case 'spread':    return this._fireSpread(def, ctx);
      case 'homing':    return this._fireHoming(def, ctx);
      case 'beam':      return this._fireStraight(def, ctx);   // rapid single-bullet
      case 'ricochet':  return this._fireRicochet(def, ctx);
      case 'arc':       return this._fireArc(def, ctx);
      case 'aoe':       return this._fireAoe(def, ctx);
      case 'slow':      return this._fireSlow(def, ctx);
      case 'gravity':   return this._fireGravity(def, ctx);
      case 'drone':     return this._fireDrone(def, ctx);
      default:          return this._fireStraight(def, ctx);
    }
  }

  // ---------- behavior implementations ----------

  _fireStraight(def, { position, direction }) {
    const id = this.pool.spawn({
      position,
      direction,
      speed: def.speed,
      damage: def.damage,
      pierce: def.pierce,
      ttl: def.ttl,
      color: def.color,
      size: def.size,
    });
    return id >= 0 ? 1 : 0;
  }

  _fireSpread(def, { position, direction }) {
    const n = Math.max(1, def.bulletCount | 0);
    const half = def.spread * 0.5;
    const step = n > 1 ? def.spread / (n - 1) : 0;
    const dx = direction[0], dy = direction[1], dz = direction[2];
    let spawned = 0;
    for (let i = 0; i < n; i++) {
      const a = -half + step * i;
      const ca = Math.cos(a), sa = Math.sin(a);
      const rx = dx * ca + dz * sa;
      const rz = -dx * sa + dz * ca;
      const slot = this.pool.spawn({
        position,
        direction: [rx, dy, rz],
        speed: def.speed,
        damage: def.damage,
        pierce: def.pierce,
        ttl: def.ttl,
        color: def.color,
        size: def.size,
      });
      if (slot >= 0) spawned++;
    }
    return spawned;
  }

  _fireHoming(def, { position, direction }) {
    const n = Math.max(1, def.bulletCount | 0);
    const half = def.spread * 0.5;
    const step = n > 1 ? def.spread / (n - 1) : 0;
    const dx = direction[0], dy = direction[1], dz = direction[2];
    let spawned = 0;
    for (let i = 0; i < n; i++) {
      const a = -half + step * i;
      const ca = Math.cos(a), sa = Math.sin(a);
      const rx = dx * ca + dz * sa;
      const rz = -dx * sa + dz * ca;
      const slot = this.pool.spawn({
        position,
        direction: [rx, dy, rz],
        speed: def.speed,
        damage: def.damage,
        pierce: def.pierce,
        ttl: def.ttl,
        color: def.color,
        size: def.size,
      });
      if (slot >= 0) {
        spawned++;
        this._tracked.push({
          behavior: 'homing',
          slot,
          fovDeg: def.homingFovDeg ?? 120,
          turnRate: def.homingTurnRate ?? 4,
        });
      }
    }
    return spawned;
  }

  _fireRicochet(def, { position, direction }) {
    const slot = this.pool.spawn({
      position,
      direction,
      speed: def.speed,
      damage: def.damage,
      pierce: def.pierce,
      ttl: def.ttl,
      color: def.color,
      size: def.size,
    });
    if (slot < 0) return 0;
    this._tracked.push({
      behavior: 'ricochet',
      slot,
      bouncesLeft: def.bounces ?? 4,
      hitIds: new Set(),
    });
    return 1;
  }

  _fireArc(def, { position, direction }) {
    // Initial velocity = forward (XZ) + upward kick (Y).
    const dx = direction[0], dz = direction[2];
    const len = Math.hypot(dx, dz) || 1;
    const nx = dx / len, nz = dz / len;
    // Compose direction so spawn normalizes vy into the velocity.
    // Magnitude target: |v| = def.speed. With v = (nx*s, kick, nz*s) and
    // spawn normalizing the direction, we feed a vector and rely on speed
    // scaling. Easier: spawn with horizontal direction, then patch vy.
    const slot = this.pool.spawn({
      position,
      direction: [nx, 0, nz],
      speed: def.speed,
      damage: def.damage,
      pierce: def.pierce,
      ttl: def.ttl,
      color: def.color,
      size: def.size,
    });
    if (slot < 0) return 0;
    this.pool.vy[slot] = def.arcUpKick ?? 12;
    this._tracked.push({
      behavior: 'arc',
      slot,
      gravity: def.arcGravity ?? 18,
    });
    return 1;
  }

  _fireAoe(def, { position, direction }) {
    // Big slow bullet; downstream collision will detonate. For now we just
    // visualize the projectile with its big size and let pool ttl carry it.
    const slot = this.pool.spawn({
      position,
      direction,
      speed: def.speed,
      damage: def.damage,
      pierce: def.pierce,
      ttl: def.ttl,
      color: def.color,
      size: def.size,
    });
    return slot >= 0 ? 1 : 0;
  }

  _fireSlow(def, { position, direction }) {
    // Record an active slow zone the rest of the engine can query via
    // getSpeedMultiplier(x, z).
    this._slowZones.push({
      x: position[0],
      z: position[2],
      headingX: direction[0],
      headingZ: direction[2],
      radius: def.slowRadius ?? 22,
      coneDeg: def.slowConeDeg ?? 90,
      factor: def.slowFactor ?? 0.25,
      ttl: def.slowDuration ?? 3.0,
    });
    return 1;
  }

  _fireGravity(def, { position, direction }) {
    // Lob a marker projectile to the impact point.
    const slot = this.pool.spawn({
      position,
      direction,
      speed: def.speed,
      damage: 0,
      pierce: 0,
      ttl: def.ttl,
      color: def.color,
      size: def.size,
    });
    // Estimate deployment point from straight-line travel for the ttl window.
    const len = Math.hypot(direction[0], direction[2]) || 1;
    const nx = direction[0] / len, nz = direction[2] / len;
    const reach = def.speed * def.ttl;
    const targetX = position[0] + nx * reach;
    const targetZ = position[2] + nz * reach;
    if (this.gravitySpawner) {
      this.gravitySpawner({
        x: targetX,
        y: 0,
        z: targetZ,
        duration: def.wellDuration ?? 4,
        mass: def.wellMass ?? 1.6,
        radius: def.wellRadius ?? 12,
      });
    }
    return slot >= 0 ? 1 : 0;
  }

  _fireDrone(def, { position, direction }) {
    if (this.droneSpawner) {
      this.droneSpawner({
        position,
        direction,
        count: def.droneCount ?? 3,
        duration: def.droneDuration ?? 15,
        fireRate: def.droneFireRate ?? 0.55,
        damage: def.droneDamage ?? def.damage,
        color: def.color,
        orbitRadius: def.droneOrbitRadius ?? 2.6,
        speed: def.speed,
      });
    }
    // Always register an internal drone group so the system itself ticks
    // them — keeps the weapon functional without an external integrator.
    this._drones.push({
      count: def.droneCount ?? 3,
      ttl: def.droneDuration ?? 15,
      fireTimer: 0,
      fireRate: def.droneFireRate ?? 0.55,
      damage: def.droneDamage ?? def.damage,
      speed: def.speed,
      color: def.color,
      orbitRadius: def.droneOrbitRadius ?? 2.6,
      angle: 0,
      orbitSpeed: 1.4,
    });
    return 1;
  }

  // ---------------------------------------------------------------------
  //  PUBLIC QUERIES (subsystems can read these to apply effects)
  // ---------------------------------------------------------------------

  /** Combined speed multiplier from all active slow zones at (x,z). 1.0 = normal. */
  getSpeedMultiplier(x, z) {
    let mul = 1;
    for (const zone of this._slowZones) {
      const dx = x - zone.x, dz = z - zone.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > zone.radius * zone.radius) continue;
      // Cone check.
      const len = Math.sqrt(d2) || 1;
      const dot = (dx / len) * zone.headingX + (dz / len) * zone.headingZ;
      const cosLimit = Math.cos((zone.coneDeg * DEG) * 0.5);
      if (dot < cosLimit) continue;
      mul = Math.min(mul, zone.factor);
    }
    return mul;
  }

  /** Read-only snapshot of active slow zones (engine VFX can render outlines). */
  get activeSlowZones() { return this._slowZones; }
  get activeDrones() { return this._drones; }

  // ---------------------------------------------------------------------
  //  ENEMY HELPERS (use enemyProvider if wired; otherwise safe empty)
  // ---------------------------------------------------------------------

  _collectEnemies() {
    if (!this.enemyProvider) return null;
    const it = this.enemyProvider();
    if (!it) return null;
    if (Array.isArray(it)) return it;
    // Convert iterable -> array.
    const out = [];
    for (const e of it) out.push(e);
    return out;
  }

  _nearestEnemy(px, pz) {
    const enemies = this._collectEnemies();
    if (!enemies) return null;
    let best = null, bestD2 = Infinity;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e || e.alive === false) continue;
      const dx = e.position.x - px;
      const dz = e.position.z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = e; }
    }
    return best;
  }

  _nearestEnemyInCone(px, pz, vx, vz, fovDeg, exclude) {
    const enemies = this._collectEnemies();
    if (!enemies) return null;
    const speed = Math.hypot(vx, vz) || 1;
    const nx = vx / speed, nz = vz / speed;
    const cosLimit = Math.cos((fovDeg * DEG) * 0.5);
    let best = null, bestD2 = Infinity;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e || e.alive === false) continue;
      if (exclude && exclude.has && exclude.has(e.id)) continue;
      const dx = e.position.x - px;
      const dz = e.position.z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 < 1e-6) continue;
      const len = Math.sqrt(d2);
      const dot = (dx / len) * nx + (dz / len) * nz;
      if (dot < cosLimit) continue;
      if (d2 < bestD2) { bestD2 = d2; best = e; }
    }
    return best;
  }
}
