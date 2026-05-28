// Projectile pool — fixed-capacity, instanced bullet pool.
// Contract:
//   const pool = new ProjectilePool({ scene, capacity });
//   const id = pool.spawn({ position:[x,y,z], direction:[x,y,z], speed, damage, pierce, ttl, color, size });
//   pool.update(dt);            // advance all live bullets
//   pool.forEach(cb);           // iterate live bullets for hit-tests
//   pool.kill(id);              // recycle slot
// Returns -1 from spawn() when the pool is saturated. Callers MUST treat -1 as a soft drop.
//
// Rendering is delegated to render/instancing.js so all bullets resolve to a
// single draw call per pool. The pool owns the geometry/material here so the
// public API stays stable across the engine.
//
// SPRINT-08 scaling notes:
//   * `update()` iterates [0, _max) — a high-water mark — instead of the full
//     capacity. Cost scales with live population, not pool size.
//   * `setFrustum(frustum, opts?)` enables optional camera-frustum culling so
//     off-screen bullets skip transform writes (still simulated; only the
//     instance matrix upload is skipped — and the slot is parked offscreen).
//   * `ProjectilePool.capacityForTier(tier)` returns the SPRINT-08 cap targets
//     (ultra 15000, high 10000, medium 5000, low 2000).

import { SphereGeometry, MeshBasicMaterial, AdditiveBlending } from 'three';
import { InstancedRenderer } from '../../render/instancing.js';

// Per-tier capacity targets — kept in sync with TIER_BULLET_CAPS in
// ../projectiles.js. Duplicated here so callers using this pool don't need
// to import the SoA module just to size the render pool.
export const TIER_PROJECTILE_CAPS = Object.freeze({
  ultra:  15000,
  high:   10000,
  medium: 5000,
  low:    2000,
});

export class ProjectilePool {
  constructor({ scene, capacity = 1024 }) {
    this.capacity = capacity;
    this.scene = scene;

    this._geom = new SphereGeometry(0.18, 8, 6);
    this._mat = new MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });

    // Slot-mode renderer: stable ids = single draw call, parked offscreen when unused.
    this.renderer = new InstancedRenderer({
      scene,
      geometry: this._geom,
      material: this._mat,
      capacity,
      mode: 'slot',
    });
    this.mesh = this.renderer.mesh; // back-compat for any external mesh consumers

    // SoA per-slot state
    this.alive = new Uint8Array(capacity);
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.ttl = new Float32Array(capacity);
    this.damage = new Float32Array(capacity);
    this.pierce = new Int16Array(capacity);
    this.size = new Float32Array(capacity);

    this._free = [];
    for (let i = capacity - 1; i >= 0; i--) this._free.push(i);

    // High-water mark of "potentially-active" slots. update() iterates [0,_max)
    // instead of [0,capacity); this keeps cost proportional to live population.
    this._max = 0;
    this._liveCount = 0;

    // Optional frustum culling. When set, bullets whose position falls outside
    // the supplied frustum-equivalent AABB skip the instance-matrix write and
    // are parked offscreen for the current frame.
    //   _cullEnabled : 0/1
    //   _cullMin/_cullMax : Float32Array(3) world-space AABB
    this._cullEnabled = 0;
    this._cullMin = new Float32Array(3);
    this._cullMax = new Float32Array(3);
    this._cullPad = 0;
  }

  /** Resolve per-tier bullet capacity for SPRINT-08 scaling targets. */
  static capacityForTier(tier) {
    return TIER_PROJECTILE_CAPS[tier] ?? TIER_PROJECTILE_CAPS.medium;
  }

  /**
   * Enable an axis-aligned world-space bounding box used as a cheap frustum
   * proxy. Pass `null` to disable. `pad` widens the box (default 2 units) so
   * bullets near the edges don't pop visibly.
   *
   * Callers using a three.js Frustum can instead use {@link setFrustumFromCamera}
   * which extracts a conservative AABB from a camera's view-projection.
   */
  setCullAABB(aabb, pad = 2) {
    if (!aabb) { this._cullEnabled = 0; return; }
    const { min, max } = aabb;
    this._cullMin[0] = (min.x ?? min[0]) - pad;
    this._cullMin[1] = (min.y ?? min[1]) - pad;
    this._cullMin[2] = (min.z ?? min[2]) - pad;
    this._cullMax[0] = (max.x ?? max[0]) + pad;
    this._cullMax[1] = (max.y ?? max[1]) + pad;
    this._cullMax[2] = (max.z ?? max[2]) + pad;
    this._cullPad = pad;
    this._cullEnabled = 1;
  }

  spawn({ position, direction, speed = 40, damage = 10, pierce = 0, ttl = 2.0, color = 0xffffff, size = 1 }) {
    const i = this._free.pop();
    if (i === undefined) return -1;
    this.alive[i] = 1;
    this.px[i] = position[0]; this.py[i] = position[1]; this.pz[i] = position[2];
    const dx = direction[0], dy = direction[1], dz = direction[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    this.vx[i] = (dx / len) * speed;
    this.vy[i] = (dy / len) * speed;
    this.vz[i] = (dz / len) * speed;
    this.ttl[i] = ttl;
    this.damage[i] = damage;
    this.pierce[i] = pierce;
    this.size[i] = size;
    if (i + 1 > this._max) this._max = i + 1;
    this._liveCount++;
    // Seed transform + color into the renderer immediately so the slot
    // shows up before the next update tick writes the integrated position.
    this.renderer.setSlot(i, position[0], position[1], position[2], size, 0, color);
    return i;
  }

  kill(i) {
    if (!this.alive[i]) return;
    this.alive[i] = 0;
    this.ttl[i] = 0;
    this._liveCount--;
    this._free.push(i);
    this.renderer.clearSlot(i);
  }

  update(dt) {
    const n = this._max;
    const r = this.renderer;
    const alive = this.alive;
    const px = this.px, py = this.py, pz = this.pz;
    const vx = this.vx, vy = this.vy, vz = this.vz;
    const ttl = this.ttl, size = this.size;
    const cullEnabled = this._cullEnabled;
    const cmin = this._cullMin, cmax = this._cullMax;

    for (let i = 0; i < n; i++) {
      // Lifetime cull — early exit for dead bullets; identical to old loop
      // but explicit so the branch predictor stays happy.
      if (!alive[i]) continue;
      const newTtl = ttl[i] - dt;
      if (newTtl <= 0) { this.kill(i); continue; }
      ttl[i] = newTtl;
      const nx = px[i] + vx[i] * dt;
      const ny = py[i] + vy[i] * dt;
      const nz = pz[i] + vz[i] * dt;
      px[i] = nx; py[i] = ny; pz[i] = nz;

      // Frustum cull: if the bullet is outside the registered AABB, park its
      // slot offscreen for this frame. The sim state is unchanged so the
      // bullet pops back in next frame if it re-enters the view.
      if (cullEnabled) {
        if (nx < cmin[0] || nx > cmax[0] ||
            ny < cmin[1] || ny > cmax[1] ||
            nz < cmin[2] || nz > cmax[2]) {
          r.clearSlot(i);
          continue;
        }
      }
      r.setSlot(i, nx, ny, nz, size[i], 0, null);
    }

    // Trim high-water mark when tail slots are all dead.
    let m = this._max;
    while (m > 0 && !alive[m - 1]) m--;
    this._max = m;

    r.endFrame();
  }

  forEach(cb) {
    const n = this._max;
    for (let i = 0; i < n; i++) {
      if (this.alive[i]) cb(i, this);
    }
  }

  get liveCount() {
    return this._liveCount;
  }

  get highWater() {
    return this._max;
  }
}
