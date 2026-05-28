// Chaser — accelerates straight toward the player and rams.
// No firing. Contact damage handled by the manager on overlap.

import { ENEMY_DEFAULTS } from './types.js';

export function createChaserState(opts = {}) {
  const d = ENEMY_DEFAULTS.chaser;
  return {
    type: 'chaser',
    maxSpeed: opts.maxSpeed ?? d.maxSpeed,
    accel: opts.accel ?? d.accel,
    contactDamage: opts.contactDamage ?? d.contactDamage,
    contactRadius: opts.contactRadius ?? d.contactRadius,
  };
}

/**
 * Steer the chaser toward the player.
 * Mutates `enemy.velocity`. Position integration is handled by the manager.
 */
export function tickChaser(enemy, dt, ctx) {
  const s = enemy.state;
  const player = ctx.player;
  if (!player || !player.alive) {
    // Coast and decelerate gently.
    enemy.velocity.x *= Math.max(0, 1 - dt * 0.8);
    enemy.velocity.z *= Math.max(0, 1 - dt * 0.8);
    return;
  }
  const dx = player.position.x - enemy.position.x;
  const dz = player.position.z - enemy.position.z;
  const dist = Math.hypot(dx, dz) || 1;
  const ax = (dx / dist) * s.accel;
  const az = (dz / dist) * s.accel;
  enemy.velocity.x += ax * dt;
  enemy.velocity.z += az * dt;
  // Speed cap.
  const sp2 = enemy.velocity.x * enemy.velocity.x + enemy.velocity.z * enemy.velocity.z;
  const cap = s.maxSpeed * s.maxSpeed;
  if (sp2 > cap) {
    const k = s.maxSpeed / Math.sqrt(sp2);
    enemy.velocity.x *= k;
    enemy.velocity.z *= k;
  }
}
