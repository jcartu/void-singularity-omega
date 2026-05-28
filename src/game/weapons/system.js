// WeaponSystem — interprets weapon defs, manages cooldowns, fires through ProjectilePool.
// The system is pure-logic; it owns no Three.js objects. It depends on a pool that
// satisfies the contract documented in ../projectiles/pool.js.

import { WEAPONS, WEAPON_ORDER } from './defs.js';

export class WeaponSystem {
  constructor({ pool, defs = WEAPONS, order = WEAPON_ORDER }) {
    this.pool = pool;
    this.defs = defs;
    this.order = order.slice();
    this.cooldowns = Object.create(null);
    for (const id of this.order) this.cooldowns[id] = 0;
    this.activeId = this.order[0];
  }

  setActive(id) {
    if (this.defs[id]) this.activeId = id;
  }

  cycle(dir = 1) {
    const idx = this.order.indexOf(this.activeId);
    const next = (idx + dir + this.order.length) % this.order.length;
    this.activeId = this.order[next];
  }

  /** Per-frame tick. dt in seconds. */
  update(dt) {
    for (const id of this.order) {
      if (this.cooldowns[id] > 0) {
        this.cooldowns[id] = Math.max(0, this.cooldowns[id] - dt);
      }
    }
  }

  /** Cooldown HUD snapshot. Returns array of {id,name,cooldown,remaining,ratio,active}. */
  getCooldownState() {
    const out = [];
    for (const id of this.order) {
      const def = this.defs[id];
      const remaining = this.cooldowns[id];
      out.push({
        id,
        name: def.name,
        cooldown: def.cooldown,
        remaining,
        ratio: def.cooldown > 0 ? 1 - remaining / def.cooldown : 1,
        active: id === this.activeId,
      });
    }
    return out;
  }

  /** True if the active weapon is ready to fire. */
  ready(id = this.activeId) {
    return this.cooldowns[id] <= 0;
  }

  /**
   * Fire the active (or specified) weapon.
   * @param {{position:[number,number,number], direction:[number,number,number]}} ctx
   * @returns {number} bullets spawned, or 0 if on cooldown
   */
  fire(ctx, id = this.activeId) {
    const def = this.defs[id];
    if (!def) return 0;
    if (this.cooldowns[id] > 0) return 0;

    const spawned = def.pattern === 'spread'
      ? this._fireSpread(def, ctx)
      : this._fireSingle(def, ctx);

    this.cooldowns[id] = def.cooldown;
    return spawned;
  }

  _fireSingle(def, { position, direction }) {
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
    // Rotate `direction` around world Y by evenly spaced angles in [-spread/2, +spread/2].
    const n = Math.max(1, def.bullets | 0);
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
}
