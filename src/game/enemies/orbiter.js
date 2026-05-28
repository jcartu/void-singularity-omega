// Orbiter — circles the gravity well at a fixed radius.
// Angular velocity is constant; we project onto the desired ring each frame so
// gravity tugging doesn't slowly de-orbit them. The result is enemies that
// trace clean rings, framing the singularity visually.

import { ENEMY_DEFAULTS } from './types.js';

export function createOrbiterState(opts = {}) {
  const d = ENEMY_DEFAULTS.orbiter;
  const radius = opts.orbitRadius ?? d.defaultOrbitRadius;
  return {
    type: 'orbiter',
    maxSpeed: opts.maxSpeed ?? d.maxSpeed,
    contactDamage: opts.contactDamage ?? d.contactDamage,
    contactRadius: opts.contactRadius ?? d.contactRadius,
    orbitRadius: radius,
    angularSpeed: opts.angularSpeed ?? d.angularSpeed,
    direction: opts.direction ?? 1,        // +1 ccw, -1 cw
    // Phase derived from spawn position by the manager.
    angle: opts.angle ?? 0,
  };
}

export function tickOrbiter(enemy, dt, ctx) {
  const s = enemy.state;
  const center = ctx.gravity?.position ?? { x: 0, z: 0 };
  s.angle += s.angularSpeed * s.direction * dt;
  const cx = center.x ?? 0;
  const cz = center.z ?? 0;
  const nx = cx + Math.cos(s.angle) * s.orbitRadius;
  const nz = cz + Math.sin(s.angle) * s.orbitRadius;
  // Derive velocity from positional delta so contact tests / debris inherit it.
  enemy.velocity.x = (nx - enemy.position.x) / Math.max(dt, 1e-4);
  enemy.velocity.z = (nz - enemy.position.z) / Math.max(dt, 1e-4);
  enemy.position.x = nx;
  enemy.position.z = nz;
}
