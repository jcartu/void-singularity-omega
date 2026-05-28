// Particle systems — accretion inflow, spark bursts, thrust trails.
//
// Two backends with the same surface:
//   - GPUParticleSystem  (tier=high/ultra): Points geometry, one draw call per
//     system, simulation runs in typed arrays and is uploaded as a dynamic
//     BufferAttribute. Three.js WebGPURenderer rasterizes the Points cheaply,
//     so we can sustain thousands of particles per system without per-instance
//     matrix overhead. (True compute-shader integration is reserved for a
//     later pass; this path is GPU-rasterized, CPU-integrated, which is the
//     pragmatic high-throughput choice today.)
//   - InstancedParticleSystem (tier=medium/low): InstancedMesh of a small
//     billboard quad. Same physics, lower caps, friendlier to WebGL2.
//
// Both backends share `_ParticlePool` for storage and free-slot management
// (swap-remove on death; no per-frame allocation).
//
// ParticleManager owns N systems, enforces a global tier cap, and exposes a
// single update/emit/getActiveCount API to the world.

import {
  BufferGeometry, BufferAttribute, Float32BufferAttribute,
  Points, ShaderMaterial, AdditiveBlending, Color, Vector3,
  InstancedMesh, PlaneGeometry, MeshBasicMaterial, Object3D, DynamicDrawUsage,
  DoubleSide, NormalBlending,
} from 'three';

// ─────────────────────────────────────────────────────────────────────────────
// Tier configuration
// ─────────────────────────────────────────────────────────────────────────────

export const TIER_CAPS = Object.freeze({
  ultra:  { total: 8000, backend: 'gpu', accretion: 5000, sparks: 2000, thrust: 500 },
  high:   { total: 5000, backend: 'gpu', accretion: 3000, sparks: 1500, thrust: 400 },
  medium: { total: 1500, backend: 'instanced', accretion: 800, sparks: 500, thrust: 200 },
  low:    { total: 500,  backend: 'instanced', accretion: 250, sparks: 150, thrust: 100 },
});

export function tierCap(tier) {
  return TIER_CAPS[tier] ?? TIER_CAPS.medium;
}

// ─────────────────────────────────────────────────────────────────────────────
// Particle pool — Structure-of-Arrays storage; allocation-free in steady state.
// ─────────────────────────────────────────────────────────────────────────────

class _ParticlePool {
  constructor(capacity) {
    this.capacity = capacity;
    this.count = 0;
    // SoA layout, all Float32 for cache locality.
    this.pos  = new Float32Array(capacity * 3);
    this.vel  = new Float32Array(capacity * 3);
    this.col  = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.age  = new Float32Array(capacity);
    this.life = new Float32Array(capacity); // max lifetime
  }

  /** Allocate one slot at the tail. Returns -1 if full. */
  alloc() {
    if (this.count >= this.capacity) return -1;
    return this.count++;
  }

  /** Remove slot i via swap-with-last. */
  free(i) {
    const last = this.count - 1;
    if (i !== last) {
      const i3 = i * 3, l3 = last * 3;
      this.pos[i3]   = this.pos[l3];
      this.pos[i3+1] = this.pos[l3+1];
      this.pos[i3+2] = this.pos[l3+2];
      this.vel[i3]   = this.vel[l3];
      this.vel[i3+1] = this.vel[l3+1];
      this.vel[i3+2] = this.vel[l3+2];
      this.col[i3]   = this.col[l3];
      this.col[i3+1] = this.col[l3+1];
      this.col[i3+2] = this.col[l3+2];
      this.size[i] = this.size[last];
      this.age[i]  = this.age[last];
      this.life[i] = this.life[last];
    }
    this.count--;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Base system — physics for one particle category.
// ─────────────────────────────────────────────────────────────────────────────

const _tmpColor = new Color();
const _tmpVec = new Vector3();

class _BaseSystem {
  /**
   * @param {object} opts
   * @param {'accretion'|'sparks'|'thrust'} opts.type
   * @param {number} opts.capacity
   * @param {object} [opts.gravity] GravityWell-like ({ center, mass })
   * @param {object} [opts.ship] Ship-like ({ position, velocity, heading })
   */
  constructor({ type, capacity, gravity = null, ship = null }) {
    this.type = type;
    this.pool = new _ParticlePool(capacity);
    this.gravity = gravity;
    this.ship = ship;
    this._thrustAccumulator = 0;
    // LOD parameters — written by ParticleManager.update() each frame; the
    // subclass renderer pass consults these to zero-fade far particles.
    this._lodAx = 0; this._lodAy = 0; this._lodAz = 0;
    this._lodDistSq = Infinity;
  }

  setGravity(g) { this.gravity = g; }
  setShip(s)    { this.ship = s; }

  get count() { return this.pool.count; }

  /**
   * Spawn `n` particles around `origin` (Vector3-like).
   * `opts` carries per-type knobs (colorHex, velocity, spread, life).
   */
  emit(origin, n, opts = {}) {
    if (n <= 0) return 0;
    let spawned = 0;
    for (let k = 0; k < n; k++) {
      const i = this.pool.alloc();
      if (i < 0) break;
      this._initParticle(i, origin, opts);
      spawned++;
    }
    return spawned;
  }

  _initParticle(i, origin, opts) {
    const p = this.pool;
    const i3 = i * 3;
    const ox = origin?.x ?? 0, oy = origin?.y ?? 0, oz = origin?.z ?? 0;

    if (this.type === 'accretion') {
      // Spawn on a ring at outer radius around gravity center; tangential vel.
      const c = this.gravity?.center ?? { x: ox, y: oy, z: oz };
      const r = (opts.outerRadius ?? 14) * (0.85 + Math.random() * 0.3);
      const th = Math.random() * Math.PI * 2;
      const cx = c.x + Math.cos(th) * r;
      const cz = c.z + Math.sin(th) * r;
      const cy = c.y + (Math.random() - 0.5) * 0.6;
      p.pos[i3]   = cx;
      p.pos[i3+1] = cy;
      p.pos[i3+2] = cz;
      // Tangential + slight inward velocity (orbital motion).
      const tangSpeed = (opts.tangentialSpeed ?? 8) * (0.85 + Math.random() * 0.3);
      const inward = (opts.inwardSpeed ?? 0.6) * (0.5 + Math.random() * 0.5);
      // Tangent vector = perpendicular to radial in XZ plane.
      const tx = -Math.sin(th), tz = Math.cos(th);
      const rx = Math.cos(th),  rz = Math.sin(th);
      p.vel[i3]   = tx * tangSpeed - rx * inward;
      p.vel[i3+1] = 0;
      p.vel[i3+2] = tz * tangSpeed - rz * inward;
      // Color: orange/yellow/white gradient based on radial distance proxy.
      const t = Math.random();
      _tmpColor.setRGB(
        1.0,
        0.55 + 0.4 * t,
        0.15 + 0.55 * t,
      );
      p.col[i3]   = _tmpColor.r;
      p.col[i3+1] = _tmpColor.g;
      p.col[i3+2] = _tmpColor.b;
      p.size[i] = (opts.size ?? 0.12) * (0.6 + Math.random() * 0.8);
      p.age[i]  = 0;
      p.life[i] = (opts.life ?? 4.5) * (0.6 + Math.random() * 0.8);
      return;
    }

    if (this.type === 'sparks') {
      p.pos[i3]   = ox;
      p.pos[i3+1] = oy;
      p.pos[i3+2] = oz;
      // Random sphere-ish burst on XZ plane (game lives on y=0).
      const sp = (opts.speed ?? 14) * (0.4 + Math.random() * 0.8);
      const th = Math.random() * Math.PI * 2;
      const ph = (Math.random() - 0.5) * 0.6; // small y component
      p.vel[i3]   = Math.cos(th) * sp;
      p.vel[i3+1] = Math.sin(ph) * sp * 0.3;
      p.vel[i3+2] = Math.sin(th) * sp;
      const hex = opts.colorHex ?? 0xffaa44;
      _tmpColor.set(hex);
      p.col[i3]   = _tmpColor.r;
      p.col[i3+1] = _tmpColor.g;
      p.col[i3+2] = _tmpColor.b;
      p.size[i] = (opts.size ?? 0.18) * (0.6 + Math.random() * 0.6);
      p.age[i]  = 0;
      p.life[i] = (opts.life ?? 0.6) * (0.6 + Math.random() * 0.8);
      return;
    }

    if (this.type === 'thrust') {
      p.pos[i3]   = ox;
      p.pos[i3+1] = oy;
      p.pos[i3+2] = oz;
      // Emit backward from ship heading + spread.
      const dirX = opts.dirX ?? 0;
      const dirZ = opts.dirZ ?? -1;
      const spread = opts.spread ?? 0.35;
      const sp = (opts.speed ?? 9) * (0.7 + Math.random() * 0.6);
      const j = (Math.random() - 0.5) * spread;
      // Rotate dir by small angle j.
      const cs = Math.cos(j), sn = Math.sin(j);
      const vx = dirX * cs - dirZ * sn;
      const vz = dirX * sn + dirZ * cs;
      p.vel[i3]   = vx * sp;
      p.vel[i3+1] = (Math.random() - 0.5) * 0.4;
      p.vel[i3+2] = vz * sp;
      const t = Math.random();
      _tmpColor.setRGB(0.35 + 0.3 * t, 0.75 + 0.2 * t, 1.0);
      p.col[i3]   = _tmpColor.r;
      p.col[i3+1] = _tmpColor.g;
      p.col[i3+2] = _tmpColor.b;
      p.size[i] = (opts.size ?? 0.14) * (0.5 + Math.random() * 0.7);
      p.age[i]  = 0;
      p.life[i] = (opts.life ?? 0.55) * (0.6 + Math.random() * 0.6);
      return;
    }
  }

  /** Step physics. Removes expired particles in-place via swap-remove. */
  update(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    const p = this.pool;
    const type = this.type;

    // Gravity parameters (cached).
    let gx = 0, gy = 0, gz = 0, gMass = 0, gHorizonSq = 0;
    if ((type === 'accretion' || type === 'sparks') && this.gravity) {
      const c = this.gravity.center;
      gx = c.x; gy = c.y; gz = c.z;
      gMass = this.gravity.mass ?? 1200;
      const h = this.gravity.horizonRadius ?? 1.5;
      gHorizonSq = h * h;
    }

    // Drag coefficients per type.
    const drag = type === 'sparks' ? 1.6 : type === 'thrust' ? 3.0 : 0.0;
    const dragK = Math.max(0, 1 - drag * dt);

    for (let i = p.count - 1; i >= 0; i--) {
      const i3 = i * 3;
      // Age & life-expiry.
      p.age[i] += dt;
      if (p.age[i] >= p.life[i]) { p.free(i); continue; }

      // Gravity pull (accretion + sparks).
      if (gMass > 0) {
        const dx = gx - p.pos[i3];
        const dy = gy - p.pos[i3+1];
        const dz = gz - p.pos[i3+2];
        const r2 = dx*dx + dy*dy + dz*dz + 0.36; // softening eps^2
        if (r2 < gHorizonSq) { p.free(i); continue; }
        const denom = Math.pow(r2, 1.5);
        const a = (gMass * (type === 'accretion' ? 1.0 : 0.45)) / denom;
        // Clamp accel for stability.
        const ax = Math.max(-400, Math.min(400, dx * a));
        const ay = Math.max(-400, Math.min(400, dy * a));
        const az = Math.max(-400, Math.min(400, dz * a));
        p.vel[i3]   += ax * dt;
        p.vel[i3+1] += ay * dt;
        p.vel[i3+2] += az * dt;
      }

      // Drag.
      if (dragK < 1) {
        p.vel[i3]   *= dragK;
        p.vel[i3+1] *= dragK;
        p.vel[i3+2] *= dragK;
      }

      // Integrate.
      p.pos[i3]   += p.vel[i3]   * dt;
      p.pos[i3+1] += p.vel[i3+1] * dt;
      p.pos[i3+2] += p.vel[i3+2] * dt;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GPU-rasterized Points backend (high/ultra tiers).
// ─────────────────────────────────────────────────────────────────────────────

const _POINTS_VERT = /* glsl */`
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aAlpha;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // Perspective-correct size; falls back to constant if z is invalid.
    float dist = max(0.001, -mv.z);
    gl_PointSize = aSize * (300.0 / dist);
  }
`;

const _POINTS_FRAG = /* glsl */`
  precision mediump float;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    // Round soft sprite via gl_PointCoord distance.
    vec2 c = gl_PointCoord - vec2(0.5);
    float d = dot(c, c);
    if (d > 0.25) discard;
    float falloff = smoothstep(0.25, 0.0, d);
    gl_FragColor = vec4(vColor * (1.5 + falloff * 1.5), vAlpha * falloff);
  }
`;

export class GPUParticleSystem extends _BaseSystem {
  constructor(opts) {
    super(opts);
    const cap = this.pool.capacity;

    this.geometry = new BufferGeometry();
    // Bind pool buffers directly — zero-copy. setUsage(Dynamic) tells the
    // WebGPU/WebGL driver to expect frequent reupload.
    const posAttr = new BufferAttribute(this.pool.pos, 3);
    posAttr.setUsage(DynamicDrawUsage);
    const colAttr = new BufferAttribute(this.pool.col, 3);
    colAttr.setUsage(DynamicDrawUsage);
    const sizeAttr = new BufferAttribute(this.pool.size, 1);
    sizeAttr.setUsage(DynamicDrawUsage);
    this._alpha = new Float32Array(cap);
    const alphaAttr = new BufferAttribute(this._alpha, 1);
    alphaAttr.setUsage(DynamicDrawUsage);

    this.geometry.setAttribute('position', posAttr);
    this.geometry.setAttribute('aColor', colAttr);
    this.geometry.setAttribute('aSize', sizeAttr);
    this.geometry.setAttribute('aAlpha', alphaAttr);
    this.geometry.setDrawRange(0, 0);

    this.material = new ShaderMaterial({
      vertexShader: _POINTS_VERT,
      fragmentShader: _POINTS_FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    this.points = new Points(this.geometry, this.material);
    this.points.frustumCulled = false;
  }

  attachTo(scene) { scene.add(this.points); }

  update(dt) {
    super.update(dt);
    const p = this.pool;
    // Compute per-particle alpha = fade(age/life). Writes only the live tail.
    const n = p.count;
    const ax = this._lodAx, ay = this._lodAy, az = this._lodAz;
    const lodSq = this._lodDistSq;
    const lodOn = Number.isFinite(lodSq);
    for (let i = 0; i < n; i++) {
      const t = p.age[i] / Math.max(0.001, p.life[i]);
      // Fade-in 0..0.15, fade-out 0.7..1.0.
      let a;
      if (t < 0.15)      a = t / 0.15;
      else if (t > 0.7)  a = 1 - (t - 0.7) / 0.3;
      else               a = 1;
      if (lodOn) {
        const i3 = i * 3;
        const dx = p.pos[i3] - ax;
        const dy = p.pos[i3+1] - ay;
        const dz = p.pos[i3+2] - az;
        if (dx*dx + dy*dy + dz*dz > lodSq) a = 0;
      }
      this._alpha[i] = a < 0 ? 0 : (a > 1 ? 1 : a);
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aColor.needsUpdate = true;
    this.geometry.attributes.aSize.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
    this.geometry.setDrawRange(0, n);
  }

  dispose() {
    this.points.parent?.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Instanced-mesh fallback backend (medium/low tiers).
// ─────────────────────────────────────────────────────────────────────────────

const _PARK = -9999;
const _scratchObj = new Object3D();
const _scratchCol = new Color();

export class InstancedParticleSystem extends _BaseSystem {
  constructor(opts) {
    super(opts);
    const cap = this.pool.capacity;

    // Small camera-facing-ish quad; we keep it flat and rely on additive
    // blending for the spectacle look without a billboard shader.
    this.geometry = new PlaneGeometry(0.5, 0.5);
    this.material = new MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
    });

    this.mesh = new InstancedMesh(this.geometry, this.material, cap);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    // Park all instances offscreen initially.
    _scratchObj.position.set(0, _PARK, 0);
    _scratchObj.scale.setScalar(0);
    _scratchObj.updateMatrix();
    for (let i = 0; i < cap; i++) this.mesh.setMatrixAt(i, _scratchObj.matrix);
  }

  attachTo(scene) { scene.add(this.mesh); }

  update(dt) {
    super.update(dt);
    const p = this.pool;
    const n = p.count;
    const ax = this._lodAx, ay = this._lodAy, az = this._lodAz;
    const lodSq = this._lodDistSq;
    const lodOn = Number.isFinite(lodSq);
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const t = p.age[i] / Math.max(0.001, p.life[i]);
      let fade;
      if (t < 0.15)     fade = t / 0.15;
      else if (t > 0.7) fade = 1 - (t - 0.7) / 0.3;
      else              fade = 1;
      fade = fade < 0 ? 0 : (fade > 1 ? 1 : fade);
      let scale = p.size[i] * 2.0 * (0.4 + fade);
      if (lodOn) {
        const dx = p.pos[i3] - ax;
        const dy = p.pos[i3+1] - ay;
        const dz = p.pos[i3+2] - az;
        if (dx*dx + dy*dy + dz*dz > lodSq) { fade = 0; scale = 0; }
      }
      _scratchObj.position.set(p.pos[i3], p.pos[i3+1], p.pos[i3+2]);
      _scratchObj.rotation.set(-Math.PI / 2, 0, 0); // face up (world XZ plane is gameplay)
      _scratchObj.scale.setScalar(scale);
      _scratchObj.updateMatrix();
      this.mesh.setMatrixAt(i, _scratchObj.matrix);
      _scratchCol.setRGB(p.col[i3] * fade, p.col[i3+1] * fade, p.col[i3+2] * fade);
      this.mesh.setColorAt(i, _scratchCol);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose?.();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ParticleManager — orchestrates the per-type systems, wires events.
// ─────────────────────────────────────────────────────────────────────────────

export class ParticleManager {
  /**
   * @param {object} opts
   * @param {string} opts.tier  'ultra'|'high'|'medium'|'low'
   * @param {*}      opts.scene Three.js scene to attach to
   * @param {*}      [opts.bus] EventBus for enemy:death / bullet:hit
   * @param {*}      [opts.gravity] GravityWell-like ({ center, mass, horizonRadius })
   * @param {*}      [opts.ship] Ship-like ({ position, velocity, heading })
   * @param {boolean} [opts.forceFallback] Force instanced backend regardless of tier
   * @param {object} [opts.capacityOverrides] Optional { accretion, sparks, thrust }
   */
  constructor({
    tier = 'medium', scene, bus = null, gravity = null, ship = null,
    forceFallback = false, capacityOverrides = null,
    lodDistance = Infinity,
  } = {}) {
    if (!scene) throw new Error('ParticleManager: scene required');
    this.tier = tier;
    this.scene = scene;
    this.bus = bus;
    this.gravity = gravity;
    this.ship = ship;

    const cfg = tierCap(tier);
    this.backend = forceFallback ? 'instanced' : cfg.backend;
    this.totalCap = cfg.total;
    const caps = {
      accretion: capacityOverrides?.accretion ?? cfg.accretion,
      sparks:    capacityOverrides?.sparks    ?? cfg.sparks,
      thrust:    capacityOverrides?.thrust    ?? cfg.thrust,
    };

    this.systems = new Map();
    this._thrustTimer = 0;
    this._unsubs = [];
    this._caps = caps;
    this._disposed = false;

    // Distance-based LOD. Particles farther than `lodDistance` from the LOD
    // anchor (ship/camera focus) skip their per-frame render write. Default
    // Infinity = no culling (preserves existing visuals).
    this.lodDistance = lodDistance;
    this._lodAnchor = null; // {x,y,z} or Vector3-like
  }

  /** Set the world-space anchor used for distance LOD (e.g. ship.position). */
  setLODAnchor(anchor) { this._lodAnchor = anchor; }
  /** Update the distance threshold; Infinity disables culling. */
  setLODDistance(d) { this.lodDistance = Number.isFinite(d) ? d : Infinity; }

  /** Build all three default systems. */
  init() {
    this.addSystem('accretion', this._caps.accretion);
    this.addSystem('sparks',    this._caps.sparks);
    this.addSystem('thrust',    this._caps.thrust);

    // Pre-seed the accretion disk so it's visible from frame 1.
    if (this.gravity) {
      const acc = this.systems.get('accretion');
      const target = Math.min(acc.pool.capacity, Math.floor(acc.pool.capacity * 0.6));
      acc.emit(this.gravity.center, target, {
        outerRadius: 14,
        tangentialSpeed: 9,
        inwardSpeed: 0.5,
      });
    }

    // Wire bus events.
    if (this.bus) {
      this._unsubs.push(this.bus.on('enemy:death', (e) => {
        const o = _tmpVec.set(e.x ?? 0, 0.2, e.z ?? 0);
        this.emit('sparks', o, 40, { colorHex: 0xff7733, speed: 16, life: 0.7 });
      }));
      this._unsubs.push(this.bus.on('bullet:hit', (e) => {
        const o = _tmpVec.set(e.x ?? 0, e.y ?? 0.2, e.z ?? 0);
        const hex = e.team === 'player' ? 0x9fe6ff : 0xff5566;
        this.emit('sparks', o, 12, { colorHex: hex, speed: 10, life: 0.4 });
      }));
    }
  }

  /** Add (or replace) one system. Returns the created system. */
  addSystem(type, count) {
    if (this.systems.has(type)) this.systems.get(type).dispose?.();
    const Ctor = this.backend === 'gpu' ? GPUParticleSystem : InstancedParticleSystem;
    const sys = new Ctor({
      type, capacity: count,
      gravity: this.gravity, ship: this.ship,
    });
    sys.attachTo(this.scene);
    this.systems.set(type, sys);
    return sys;
  }

  /** Manually emit particles into a named system. Respects global cap. */
  emit(type, origin, count, opts = {}) {
    const sys = this.systems.get(type);
    if (!sys) return 0;
    // Enforce global cap by computing headroom.
    const total = this.getActiveCount();
    const headroom = Math.max(0, this.totalCap - total);
    const n = Math.min(count | 0, headroom);
    if (n <= 0) return 0;
    return sys.emit(origin, n, opts);
  }

  /** Sum of live particles across systems. */
  getActiveCount() {
    let n = 0;
    for (const s of this.systems.values()) n += s.count;
    return n;
  }

  /** Per-frame tick. */
  update(dt) {
    if (this._disposed) return;

    // Refill accretion: keep it at ~60% of capacity for steady-state spectacle.
    const acc = this.systems.get('accretion');
    if (acc && this.gravity) {
      const target = Math.floor(acc.pool.capacity * 0.6);
      const deficit = target - acc.count;
      if (deficit > 0) {
        const refill = Math.min(deficit, Math.max(1, Math.ceil(deficit * dt * 1.5)));
        this.emit('accretion', this.gravity.center, refill, {
          outerRadius: 14,
          tangentialSpeed: 9,
          inwardSpeed: 0.5,
        });
      }
    }

    // Thrust trail: continuous emission gated by ship intent (any horizontal
    // velocity is treated as "thrusting" — close enough for visuals).
    const ship = this.ship;
    if (ship && ship.alive !== false) {
      const sp = ship.position;
      const vx = ship.velocity?.x ?? 0;
      const vz = ship.velocity?.z ?? 0;
      const speed = Math.hypot(vx, vz);
      if (speed > 1.0) {
        this._thrustTimer += dt;
        // Rate scales with speed — faster ship => denser trail.
        const rate = Math.min(120, 30 + speed * 4);
        const interval = 1 / rate;
        const h = ship.heading ?? 0;
        // Backward = opposite of heading direction.
        const dirX = -Math.sin(h);
        const dirZ = -Math.cos(h);
        // Emission point slightly behind hull.
        const ex = sp.x + dirX * 0.7;
        const ez = sp.z + dirZ * 0.7;
        const ey = (sp.y ?? 0) + 0.15;
        let burst = 0;
        while (this._thrustTimer >= interval && burst < 8) {
          this._thrustTimer -= interval;
          burst++;
        }
        if (burst > 0) {
          _tmpVec.set(ex, ey, ez);
          this.emit('thrust', _tmpVec, burst, {
            dirX, dirZ, spread: 0.45, speed: 8, life: 0.5,
          });
        }
      } else {
        this._thrustTimer = 0;
      }
    }

    // Propagate LOD anchor + distance squared into each system before render.
    const anchor = this._lodAnchor ?? this.ship?.position ?? null;
    const lodSq = (Number.isFinite(this.lodDistance) && anchor)
      ? (this.lodDistance * this.lodDistance)
      : Infinity;
    const ax = anchor?.x ?? 0, ay = anchor?.y ?? 0, az = anchor?.z ?? 0;
    for (const s of this.systems.values()) {
      s._lodAx = ax; s._lodAy = ay; s._lodAz = az;
      s._lodDistSq = lodSq;
      s.update(dt);
    }
  }

  /** Update bound gravity/ship references (e.g. after run reset). */
  setGravity(g) {
    this.gravity = g;
    for (const s of this.systems.values()) s.setGravity?.(g);
  }
  setShip(s) {
    this.ship = s;
    for (const sys of this.systems.values()) sys.setShip?.(s);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const off of this._unsubs) { try { off(); } catch { /* ignore */ } }
    this._unsubs.length = 0;
    for (const s of this.systems.values()) s.dispose?.();
    this.systems.clear();
  }
}

export default ParticleManager;
