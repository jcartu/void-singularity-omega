// Gravity well field — single source of truth for the central singularity's pull.
// All projectiles, debris, and free bodies route through GravityWell for force,
// trajectory curvature, and event-horizon checks. Deterministic given identical
// inputs; uses an internal seeded PRNG for surge scheduling so two runs with the
// same seed produce identical gravity behavior.
//
// Math: Newtonian point-mass with softening to avoid singularities outside the
// horizon: a = -G*M * r / (|r|^2 + eps^2)^(3/2). The softening epsilon also
// prevents tunneling for fast projectiles near the core. Inside horizonRadius
// any body is considered consumed (instakill).
//
// VFX intentionally omitted — SPRINT-04 attaches visuals to the surge events
// exposed via GravityWell.activeSurges().

import { Vector3 } from 'three';

const _tmpForce = new Vector3();
const _tmpDir = new Vector3();
const _tmpAcc = new Vector3();
const _tmpVel = new Vector3();
const _tmpPos = new Vector3();

// Deterministic PRNG (mulberry32). Same seed -> same stream.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class GravityWell {
  /**
   * @param {object} [opts]
   * @param {Vector3|{x,y,z}} [opts.center] world-space center of the singularity
   * @param {number} [opts.mass=1200] gravitational parameter (G*M baked in)
   * @param {number} [opts.horizonRadius=2.4] event-horizon radius (instakill)
   * @param {number} [opts.softening=0.6] Plummer softening epsilon
   * @param {number} [opts.maxAccel=400] clamp for stability of fast/close bodies
   * @param {number} [opts.cutoffRadius=400] no pull beyond this (perf)
   * @param {number} [opts.seed=0xC0FFEE] PRNG seed for surge scheduling
   * @param {number} [opts.surgeIntervalMin=6] seconds between surge attempts
   * @param {number} [opts.surgeIntervalMax=14]
   * @param {number} [opts.surgeStrengthMin=1.8] multiplier on mass
   * @param {number} [opts.surgeStrengthMax=3.2]
   * @param {number} [opts.surgeDurationMin=0.6]
   * @param {number} [opts.surgeDurationMax=1.4]
   */
  constructor(opts = {}) {
    const c = opts.center ?? { x: 0, y: 0, z: 0 };
    this.center = new Vector3(c.x ?? 0, c.y ?? 0, c.z ?? 0);
    this.mass = opts.mass ?? 1200;
    this.horizonRadius = opts.horizonRadius ?? 2.4;
    this.softening = opts.softening ?? 0.6;
    this.maxAccel = opts.maxAccel ?? 400;
    this.cutoffRadius = opts.cutoffRadius ?? 400;

    this._surgeIntervalMin = opts.surgeIntervalMin ?? 6;
    this._surgeIntervalMax = opts.surgeIntervalMax ?? 14;
    this._surgeStrengthMin = opts.surgeStrengthMin ?? 1.8;
    this._surgeStrengthMax = opts.surgeStrengthMax ?? 3.2;
    this._surgeDurationMin = opts.surgeDurationMin ?? 0.6;
    this._surgeDurationMax = opts.surgeDurationMax ?? 1.4;

    this._rand = mulberry32(opts.seed ?? 0xC0FFEE);
    this._time = 0;
    this._surges = []; // active surges {start, end, strength}
    this._nextSurgeAt = this._scheduleNextSurge(0);
  }

  _rng() { return this._rand(); }
  _rangeR(min, max) { return min + (max - min) * this._rng(); }
  _scheduleNextSurge(now) {
    return now + this._rangeR(this._surgeIntervalMin, this._surgeIntervalMax);
  }

  /** Advance internal clock and prune/spawn surges. Call once per frame. */
  tick(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    this._time += dt;
    // Spawn surges that should have started.
    while (this._time >= this._nextSurgeAt) {
      const start = this._nextSurgeAt;
      const dur = this._rangeR(this._surgeDurationMin, this._surgeDurationMax);
      const strength = this._rangeR(this._surgeStrengthMin, this._surgeStrengthMax);
      this._surges.push({ start, end: start + dur, strength });
      this._nextSurgeAt = this._scheduleNextSurge(start);
    }
    // Prune expired.
    for (let i = this._surges.length - 1; i >= 0; i--) {
      if (this._surges[i].end <= this._time) this._surges.splice(i, 1);
    }
  }

  /** Force gestation of a surge right now (debug / scripted events). */
  triggerSurge(strength = 2.5, duration = 1.0) {
    this._surges.push({
      start: this._time,
      end: this._time + duration,
      strength,
    });
  }

  /** Snapshot of currently-active surges. Read-only; VFX hook. */
  activeSurges() {
    return this._surges.map((s) => ({ ...s, t: this._time }));
  }

  /** Multiplier on mass from any active surges (sum of strengths). */
  _surgeMultiplier() {
    let m = 1;
    for (let i = 0; i < this._surges.length; i++) {
      const s = this._surges[i];
      if (this._time >= s.start && this._time < s.end) m += (s.strength - 1);
    }
    return m;
  }

  /** True if `pos` is inside the event horizon. */
  isInsideHorizon(pos) {
    const dx = pos.x - this.center.x;
    const dy = pos.y - this.center.y;
    const dz = pos.z - this.center.z;
    const r2 = dx * dx + dy * dy + dz * dz;
    return r2 <= this.horizonRadius * this.horizonRadius;
  }

  /**
   * Gravitational acceleration vector at world position `pos`.
   * Returns a fresh Vector3 unless `out` is provided.
   */
  forceAt(pos, out) {
    const o = out ?? new Vector3();
    _tmpDir.set(
      this.center.x - pos.x,
      this.center.y - pos.y,
      this.center.z - pos.z,
    );
    const r2 = _tmpDir.lengthSq();
    if (r2 > this.cutoffRadius * this.cutoffRadius) {
      return o.set(0, 0, 0);
    }
    const eps = this.softening;
    const denom = Math.pow(r2 + eps * eps, 1.5);
    const mu = this.mass * this._surgeMultiplier();
    let a = mu / denom; // scalar magnitude per unit of direction
    // _tmpDir points from pos -> center, i.e. the pull direction. Good.
    o.copy(_tmpDir).multiplyScalar(a);
    // Clamp for numerical sanity.
    const mag = o.length();
    if (mag > this.maxAccel) o.multiplyScalar(this.maxAccel / mag);
    return o;
  }

  /**
   * Curve a projectile under gravity for one timestep. Semi-implicit Euler.
   * Mutates `proj.position` and `proj.velocity` in place.
   * Sets `proj.consumed = true` if it crosses the event horizon.
   *
   * @param {{position: Vector3, velocity: Vector3, consumed?: boolean}} proj
   * @param {number} dt
   * @returns {{position: Vector3, velocity: Vector3, consumed: boolean}}
   */
  curve(proj, dt) {
    if (!proj || proj.consumed) return proj;
    if (!Number.isFinite(dt) || dt <= 0) return proj;

    // Sub-step for fast projectiles close to the well to avoid tunneling.
    const r = _tmpPos.copy(proj.position).sub(this.center).length();
    const speed = proj.velocity.length();
    // step length budget: 1/4 of distance-to-horizon margin per step
    const margin = Math.max(0.25, r - this.horizonRadius);
    const stepBudget = margin * 0.5;
    const dist = speed * dt;
    let substeps = 1;
    if (dist > stepBudget && stepBudget > 0) {
      substeps = Math.min(8, Math.ceil(dist / stepBudget));
    }
    const h = dt / substeps;

    for (let i = 0; i < substeps; i++) {
      this.forceAt(proj.position, _tmpAcc);
      // semi-implicit Euler: v += a*h; x += v*h
      _tmpVel.copy(_tmpAcc).multiplyScalar(h);
      proj.velocity.add(_tmpVel);
      _tmpVel.copy(proj.velocity).multiplyScalar(h);
      proj.position.add(_tmpVel);
      if (this.isInsideHorizon(proj.position)) {
        proj.consumed = true;
        break;
      }
    }
    return proj;
  }
}

export default GravityWell;
