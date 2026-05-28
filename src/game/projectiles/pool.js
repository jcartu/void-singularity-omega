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

import { SphereGeometry, MeshBasicMaterial, AdditiveBlending } from 'three';
import { InstancedRenderer } from '../../render/instancing.js';

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
    // Seed transform + color into the renderer immediately so the slot
    // shows up before the next update tick writes the integrated position.
    this.renderer.setSlot(i, position[0], position[1], position[2], size, 0, color);
    return i;
  }

  kill(i) {
    if (!this.alive[i]) return;
    this.alive[i] = 0;
    this.ttl[i] = 0;
    this.renderer.clearSlot(i);
  }

  update(dt) {
    const cap = this.capacity;
    const r = this.renderer;
    for (let i = 0; i < cap; i++) {
      if (!this.alive[i]) continue;
      this.ttl[i] -= dt;
      if (this.ttl[i] <= 0) { this.kill(i); continue; }
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      r.setSlot(i, this.px[i], this.py[i], this.pz[i], this.size[i], 0, null);
    }
    r.endFrame();
  }

  forEach(cb) {
    for (let i = 0; i < this.capacity; i++) {
      if (this.alive[i]) cb(i, this);
    }
  }

  get liveCount() {
    return this.capacity - this._free.length;
  }
}
