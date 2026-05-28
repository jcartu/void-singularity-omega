// BulletPool — high-scale (10k+) projectile simulation backed by typed-array
// Structure-of-Arrays. Designed for the WO-02-G3 budget:
//
//   * Fixed-step simulation at 1/120 s (driven by the engine loop).
//   * Gravity-curving via the central GravityWell (see ./gravity.js).
//   * Uniform-grid broadphase for bullet-vs-target collision.
//   * Hit events emitted on an EventBus (see ./events.js) using a reused
//     scratch payload object — ZERO per-frame heap allocation in the hot
//     path (step + collide).
//
// VFX is intentionally NOT bound here — that hookup lives in SPRINT-04 by
// subscribing to the 'bullet:hit' / 'bullet:despawn' events emitted below.
//
// Targets are externally-owned typed arrays passed via setTargets({...}).
// This keeps the pool agnostic of player/enemy ECS shape while letting the
// broadphase remain pure index math.

import { GravityWell } from './gravity.js';
import { EventBus } from './events.js';

// Stable team ids — exported so callers don't sprinkle magic numbers.
export const TEAM_PLAYER = 0;
export const TEAM_ENEMY = 1;
export const TEAM_NEUTRAL = 2;

// Fixed sim step. Loop.step is also 1/120 — BulletPool.step(dt) accepts
// whatever dt the loop passes (it's used as a scalar in the integrator),
// but the sim is tuned and stable for FIXED_STEP.
export const FIXED_STEP = 1 / 120;

// Per-tier active-bullet capacity targets. SPRINT-08 scaling contract:
//   ultra: 15000, high: 10000, medium: 5000, low: 2000.
// Callers should pass `capacity: BulletPool.capacityForTier(tier)` so the pool
// is sized once at boot and never reallocates.
export const TIER_BULLET_CAPS = Object.freeze({
  ultra:  15000,
  high:   10000,
  medium: 5000,
  low:    2000,
});

export function bulletCapacityForTier(tier) {
  return TIER_BULLET_CAPS[tier] ?? TIER_BULLET_CAPS.medium;
}

const DEFAULT_CAPACITY = 16384;     // > 10k headroom
const DEFAULT_WORLD_EXTENT = 200;   // half-size of the simulated cube
const DEFAULT_CELL_SIZE = 4;        // grid cell edge length (world units)

export class BulletPool {
  /**
   * @param {object} [opts]
   * @param {number} [opts.capacity=16384] max concurrent bullets (rounded up)
   * @param {number} [opts.worldExtent=200] half-size of the AABB cube; bullets
   *                                        leaving the cube are despawned
   * @param {number} [opts.cellSize=4]      uniform-grid cell edge length
   * @param {GravityWell|null} [opts.gravity] gravity field; null disables curving
   * @param {EventBus} [opts.events] bus for 'bullet:hit' / 'bullet:despawn'
   */
  constructor(opts = {}) {
    const capacity = opts.capacity ?? DEFAULT_CAPACITY;
    this.capacity = capacity;
    this.worldExtent = opts.worldExtent ?? DEFAULT_WORLD_EXTENT;
    this.cellSize = opts.cellSize ?? DEFAULT_CELL_SIZE;
    this.gravity = opts.gravity ?? new GravityWell();
    this.events = opts.events ?? new EventBus();

    // SoA stores — every per-bullet field is a contiguous typed array so the
    // hot loops are pure index math with cache-friendly stride.
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.radius = new Float32Array(capacity);
    this.ttl = new Float32Array(capacity);
    this.health = new Float32Array(capacity);
    this.damage = new Float32Array(capacity);
    this.type = new Uint8Array(capacity);   // pattern / kind tag (callers define)
    this.team = new Uint8Array(capacity);   // TEAM_*
    this.pierce = new Int16Array(capacity); // hits remaining before despawn
    this.alive = new Uint8Array(capacity);

    // Free-list as a stack of indices. Newly-freed slots pop first.
    this._free = new Int32Array(capacity);
    for (let i = 0; i < capacity; i++) this._free[i] = capacity - 1 - i;
    this._freeTop = capacity;

    // High-water mark of "potentially-active" indices. We iterate [0, _max)
    // each step instead of full capacity — keeps work proportional to
    // population rather than pool size when pools are large but sparse.
    this._max = 0;
    this.count = 0;

    // Uniform spatial grid for broadphase. Stored as a singly-linked-list per
    // cell, all in two typed arrays:
    //   _cellHead[cell] -> first bullet index in cell (-1 if empty)
    //   _nextInCell[bullet] -> next bullet index in same cell (-1)
    const gridDim = Math.max(1, Math.ceil((this.worldExtent * 2) / this.cellSize));
    this.gridDim = gridDim;
    this._gridDim2 = gridDim * gridDim;
    this._cellHead = new Int32Array(gridDim * gridDim * gridDim);
    this._nextInCell = new Int32Array(capacity);

    // Externally-owned target struct. See setTargets().
    this._targets = null;

    // Reusable hit / despawn payloads — written in-place then handed to the
    // synchronous EventBus. Listeners MUST NOT retain these references.
    this._hitPayload = {
      bullet: 0, target: 0, team: 0, type: 0,
      damage: 0, x: 0, y: 0, z: 0,
    };
    this._despawnPayload = {
      bullet: 0, reason: 0, x: 0, y: 0, z: 0,
    };
  }

  // ---------------------------------------------------------------------
  //  TARGET REGISTRY
  // ---------------------------------------------------------------------

  /**
   * Register an externally-owned target struct (typed arrays). All fields
   * must be parallel arrays of the same length, with `count` indicating the
   * high-water mark of populated slots.
   *
   * Shape:
   *   {
   *     px, py, pz : Float32Array       // positions
   *     radius     : Float32Array       // collision radii
   *     team       : Uint8Array         // TEAM_*; bullets collide cross-team
   *     alive      : Uint8Array         // 0/1
   *     count      : number             // active high-water mark (exclusive)
   *     onHit?     : (targetIdx, bulletIdx, damage) => void   // optional
   *   }
   *
   * Pass `null` to clear.
   */
  setTargets(targets) { this._targets = targets; }

  // ---------------------------------------------------------------------
  //  SPAWN / DESPAWN
  // ---------------------------------------------------------------------

  /**
   * Spawn a bullet. Returns the slot index, or -1 if the pool is saturated.
   * Hot path callers should pass scalars (no option-object boxing) via the
   * positional API to avoid per-call object allocation.
   */
  spawn(
    x, y, z,
    vx, vy, vz,
    radius = 0.25,
    ttl = 6,
    damage = 10,
    type = 0,
    team = TEAM_PLAYER,
    pierce = 0,
    health = 1,
  ) {
    if (this._freeTop === 0) return -1;
    const i = this._free[--this._freeTop];
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.radius[i] = radius;
    this.ttl[i] = ttl;
    this.damage[i] = damage;
    this.type[i] = type;
    this.team[i] = team;
    this.pierce[i] = pierce;
    this.health[i] = health;
    this.alive[i] = 1;
    this.count++;
    if (i + 1 > this._max) this._max = i + 1;
    return i;
  }

  /** Despawn slot `i`. Emits 'bullet:despawn' with a reused payload. */
  despawn(i, reason = 0) {
    if (!this.alive[i]) return;
    this.alive[i] = 0;
    this._free[this._freeTop++] = i;
    this.count--;
    const p = this._despawnPayload;
    p.bullet = i; p.reason = reason;
    p.x = this.px[i]; p.y = this.py[i]; p.z = this.pz[i];
    this.events.emit('bullet:despawn', p);
  }

  /** Despawn every active bullet. */
  clear() {
    for (let i = 0; i < this._max; i++) if (this.alive[i]) this.despawn(i, 3);
    this._max = 0;
  }

  // ---------------------------------------------------------------------
  //  SIMULATION STEP
  // ---------------------------------------------------------------------

  /**
   * Advance simulation by `dt`. Should be called once per fixed step
   * (engine loop already does this at 1/120 s). Order:
   *
   *   1. apply gravity to velocities
   *   2. integrate positions, age TTL, despawn out-of-bounds / horizon /
   *      expired
   *   3. rebuild uniform grid
   *   4. collide against registered targets
   */
  step(dt) {
    this._integrate(dt);
    this._buildGrid();
    this._collide();
    this._compactHighWater();
  }

  // Gravity + position integration fused into one pass — same memory traffic
  // either way, but combining halves loop overhead.
  _integrate(dt) {
    const px = this.px, py = this.py, pz = this.pz;
    const vx = this.vx, vy = this.vy, vz = this.vz;
    const ttl = this.ttl, alive = this.alive;
    const n = this._max;
    const ext = this.worldExtent;

    const g = this.gravity;
    const haveGravity = !!g;
    const cx = haveGravity ? g.center.x : 0;
    const cy = haveGravity ? g.center.y : 0;
    const cz = haveGravity ? g.center.z : 0;
    const eps2 = haveGravity ? g.softening * g.softening : 0;
    const cutoff2 = haveGravity ? g.cutoffRadius * g.cutoffRadius : 0;
    const horizon2 = haveGravity ? g.horizonRadius * g.horizonRadius : 0;
    const maxAccel = haveGravity ? g.maxAccel : 0;
    const muBase = haveGravity ? g.mass * g._surgeMultiplier() : 0;

    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;

      // --- gravity ---
      if (haveGravity) {
        const dx = cx - px[i];
        const dy = cy - py[i];
        const dz = cz - pz[i];
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 < cutoff2) {
          const denom = (r2 + eps2);
          const invR = 1 / Math.sqrt(denom);
          let a = muBase * invR * invR * invR; // = mu / (r^2 + eps^2)^(3/2)
          // Clamp acceleration magnitude for numerical stability.
          // a is scalar; magnitude of (dx,dy,dz)*a is a*sqrt(r2). We want
          // that <= maxAccel, i.e. a <= maxAccel/sqrt(r2). Avoid the sqrt
          // when r2 is tiny — at very small r the softening already caps a.
          if (r2 > 1e-4) {
            const aMax = maxAccel * invR; // because invR ~= 1/sqrt(r2 + eps2)
            if (a > aMax) a = aMax;
          }
          vx[i] += dx * a * dt;
          vy[i] += dy * a * dt;
          vz[i] += dz * a * dt;
        }
      }

      // --- position ---
      const nx = px[i] + vx[i] * dt;
      const ny = py[i] + vy[i] * dt;
      const nz = pz[i] + vz[i] * dt;
      px[i] = nx; py[i] = ny; pz[i] = nz;

      // --- TTL ---
      const t = ttl[i] - dt;
      ttl[i] = t;

      // --- despawn checks ---
      // 0 = ttl, 1 = horizon, 2 = oob, 3 = cleared, 4 = collision
      if (t <= 0) { this.despawn(i, 0); continue; }

      if (haveGravity) {
        const dx2 = nx - cx, dy2 = ny - cy, dz2 = nz - cz;
        if (dx2 * dx2 + dy2 * dy2 + dz2 * dz2 < horizon2) {
          this.despawn(i, 1);
          continue;
        }
      }

      if (nx < -ext || nx > ext || ny < -ext || ny > ext || nz < -ext || nz > ext) {
        this.despawn(i, 2);
      }
    }
  }

  _cellIndex(x, y, z) {
    const ext = this.worldExtent, cs = this.cellSize, d = this.gridDim;
    let gx = ((x + ext) / cs) | 0;
    let gy = ((y + ext) / cs) | 0;
    let gz = ((z + ext) / cs) | 0;
    if (gx < 0) gx = 0; else if (gx >= d) gx = d - 1;
    if (gy < 0) gy = 0; else if (gy >= d) gy = d - 1;
    if (gz < 0) gz = 0; else if (gz >= d) gz = d - 1;
    return gx + gy * d + gz * this._gridDim2;
  }

  _buildGrid() {
    const head = this._cellHead;
    const next = this._nextInCell;
    head.fill(-1);
    const alive = this.alive;
    const px = this.px, py = this.py, pz = this.pz;
    const ext = this.worldExtent, cs = this.cellSize, d = this.gridDim;
    const d2 = this._gridDim2;
    const n = this._max;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      let gx = ((px[i] + ext) / cs) | 0;
      let gy = ((py[i] + ext) / cs) | 0;
      let gz = ((pz[i] + ext) / cs) | 0;
      if (gx < 0) gx = 0; else if (gx >= d) gx = d - 1;
      if (gy < 0) gy = 0; else if (gy >= d) gy = d - 1;
      if (gz < 0) gz = 0; else if (gz >= d) gz = d - 1;
      const ci = gx + gy * d + gz * d2;
      next[i] = head[ci];
      head[ci] = i;
    }
  }

  _collide() {
    const t = this._targets;
    if (!t) return;
    const tCount = t.count | 0;
    if (tCount === 0) return;

    const head = this._cellHead;
    const next = this._nextInCell;
    const alive = this.alive;
    const px = this.px, py = this.py, pz = this.pz;
    const br = this.radius;
    const bteam = this.team;
    const btype = this.type;
    const bdmg = this.damage;
    const bpierce = this.pierce;
    const ext = this.worldExtent, cs = this.cellSize, d = this.gridDim, d2 = this._gridDim2;

    const tpx = t.px, tpy = t.py, tpz = t.pz;
    const tr = t.radius, tteam = t.team, talive = t.alive;
    const onHit = t.onHit; // optional callback

    const hit = this._hitPayload;
    const events = this.events;

    for (let k = 0; k < tCount; k++) {
      if (!talive[k]) continue;
      const tx = tpx[k], ty = tpy[k], tz = tpz[k];
      const tR = tr[k];
      const tTeamK = tteam[k];

      // Cell-range from target AABB. +1 to cover the bullet radius slack
      // (we don't store per-target max-bullet-radius; cellSize is tuned to
      // be a couple of average bullet radii — adjust DEFAULT_CELL_SIZE for
      // your bullet scale).
      const range = ((tR / cs) | 0) + 1;
      let gx0 = (((tx + ext) / cs) | 0) - range;
      let gy0 = (((ty + ext) / cs) | 0) - range;
      let gz0 = (((tz + ext) / cs) | 0) - range;
      let gx1 = (((tx + ext) / cs) | 0) + range;
      let gy1 = (((ty + ext) / cs) | 0) + range;
      let gz1 = (((tz + ext) / cs) | 0) + range;
      if (gx0 < 0) gx0 = 0; if (gx1 >= d) gx1 = d - 1;
      if (gy0 < 0) gy0 = 0; if (gy1 >= d) gy1 = d - 1;
      if (gz0 < 0) gz0 = 0; if (gz1 >= d) gz1 = d - 1;
      if (gx0 > gx1 || gy0 > gy1 || gz0 > gz1) continue;

      for (let gz = gz0; gz <= gz1; gz++) {
        const zBase = gz * d2;
        for (let gy = gy0; gy <= gy1; gy++) {
          const yBase = gy * d;
          for (let gx = gx0; gx <= gx1; gx++) {
            let i = head[gx + yBase + zBase];
            while (i !== -1) {
              const nextIdx = next[i]; // capture before potential despawn
              if (alive[i] && bteam[i] !== tTeamK) {
                const dx = px[i] - tx;
                const dy = py[i] - ty;
                const dz = pz[i] - tz;
                const rr = br[i] + tR;
                if (dx * dx + dy * dy + dz * dz <= rr * rr) {
                  // hit — populate scratch payload
                  hit.bullet = i;
                  hit.target = k;
                  hit.team = bteam[i];
                  hit.type = btype[i];
                  hit.damage = bdmg[i];
                  hit.x = px[i]; hit.y = py[i]; hit.z = pz[i];
                  events.emit('bullet:hit', hit);
                  if (onHit) onHit(k, i, bdmg[i]);

                  if (bpierce[i] > 0) {
                    bpierce[i]--;
                  } else {
                    this.despawn(i, 4);
                  }
                }
              }
              i = nextIdx;
            }
          }
        }
      }
    }
  }

  // Shrink _max when the tail is all-dead. Keeps subsequent step cost in
  // line with actual population. Cheap — bounded scan from the top.
  _compactHighWater() {
    const alive = this.alive;
    let m = this._max;
    while (m > 0 && !alive[m - 1]) m--;
    this._max = m;
  }

  // ---------------------------------------------------------------------
  //  INTROSPECTION (read-only)
  // ---------------------------------------------------------------------

  get activeCount() { return this.count; }
  get highWater() { return this._max; }
  get freeSlots() { return this._freeTop; }

  /** Resolve per-tier bullet capacity. See TIER_BULLET_CAPS. */
  static capacityForTier(tier) { return bulletCapacityForTier(tier); }
}

export default BulletPool;
