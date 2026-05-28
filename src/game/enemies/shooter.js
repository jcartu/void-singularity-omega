// Shooter — holds stand-off range and fires lead-aimed projectiles.
// Uses linear lead: solves the time-to-impact quadratic against player velocity.

import { ENEMY_DEFAULTS } from './types.js';

export function createShooterState(opts = {}) {
  const d = ENEMY_DEFAULTS.shooter;
  return {
    type: 'shooter',
    maxSpeed: opts.maxSpeed ?? d.maxSpeed,
    accel: opts.accel ?? d.accel,
    preferredMin: opts.preferredMin ?? d.preferredMin,
    preferredMax: opts.preferredMax ?? d.preferredMax,
    fireInterval: opts.fireInterval ?? d.fireInterval,
    fireSpread: opts.fireSpread ?? d.fireSpread,
    bulletSpeed: opts.bulletSpeed ?? d.bulletSpeed,
    bulletDamage: opts.bulletDamage ?? d.bulletDamage,
    bulletTtl: opts.bulletTtl ?? d.bulletTtl,
    bulletColor: opts.bulletColor ?? d.bulletColor,
    fireCooldown: opts.fireInterval ?? d.fireInterval, // stagger initial shot
  };
}

/**
 * Lead-aim solver. Returns a unit vector aiming at the predicted player
 * intercept point, given relative position and player velocity. Falls back
 * to direct aim when no real solution exists.
 *
 * Solving |R + V*t| = S*t for t, where R = player - shooter, V = player vel,
 * S = bullet speed. Quadratic: (V·V - S²)t² + 2(R·V)t + R·R = 0.
 */
export function leadAim(rx, rz, vx, vz, bulletSpeed) {
  const a = vx * vx + vz * vz - bulletSpeed * bulletSpeed;
  const b = 2 * (rx * vx + rz * vz);
  const c = rx * rx + rz * rz;
  let t = 0;
  if (Math.abs(a) < 1e-4) {
    // Linear: bt + c = 0
    if (Math.abs(b) > 1e-6) t = -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const t1 = (-b - sq) / (2 * a);
      const t2 = (-b + sq) / (2 * a);
      // pick smallest positive
      const ts = [t1, t2].filter((x) => x > 0);
      if (ts.length) t = Math.min(...ts);
    }
  }
  const tx = rx + vx * t;
  const tz = rz + vz * t;
  const len = Math.hypot(tx, tz) || 1;
  return { x: tx / len, z: tz / len, leadTime: t };
}

export function tickShooter(enemy, dt, ctx) {
  const s = enemy.state;
  const player = ctx.player;

  // Cool down regardless of player state so timing stays predictable on respawn.
  s.fireCooldown = Math.max(0, s.fireCooldown - dt);

  if (!player || !player.alive) {
    enemy.velocity.x *= Math.max(0, 1 - dt * 0.6);
    enemy.velocity.z *= Math.max(0, 1 - dt * 0.6);
    return;
  }

  const dx = player.position.x - enemy.position.x;
  const dz = player.position.z - enemy.position.z;
  const dist = Math.hypot(dx, dz) || 1;

  // Movement intent: positive = approach, negative = retreat.
  let intent = 0;
  if (dist < s.preferredMin) intent = -1;
  else if (dist > s.preferredMax) intent = 1;
  if (intent !== 0) {
    const ax = (dx / dist) * s.accel * intent;
    const az = (dz / dist) * s.accel * intent;
    enemy.velocity.x += ax * dt;
    enemy.velocity.z += az * dt;
  } else {
    // Strafe gently — gives them readable motion at standoff.
    const px = -dz / dist;
    const pz = dx / dist;
    const wobble = Math.sin((ctx.time ?? 0) * 1.7 + enemy.id * 0.37);
    enemy.velocity.x += px * s.accel * 0.35 * wobble * dt;
    enemy.velocity.z += pz * s.accel * 0.35 * wobble * dt;
  }
  // Damping + speed cap.
  enemy.velocity.x *= Math.max(0, 1 - dt * 1.1);
  enemy.velocity.z *= Math.max(0, 1 - dt * 1.1);
  const sp2 = enemy.velocity.x * enemy.velocity.x + enemy.velocity.z * enemy.velocity.z;
  const cap = s.maxSpeed * s.maxSpeed;
  if (sp2 > cap) {
    const k = s.maxSpeed / Math.sqrt(sp2);
    enemy.velocity.x *= k;
    enemy.velocity.z *= k;
  }

  // Fire when in envelope and cooldown elapsed.
  if (s.fireCooldown === 0 && dist <= s.preferredMax * 1.2 && ctx.projectiles) {
    const pv = player.velocity ?? { x: 0, z: 0 };
    const aim = leadAim(dx, dz, pv.x ?? 0, pv.z ?? 0, s.bulletSpeed);
    // Apply tiny random spread to avoid robotic accuracy.
    const rnd = ctx.rng ? ctx.rng.float() : Math.random();
    const spread = (rnd - 0.5) * 2 * s.fireSpread;
    const cosS = Math.cos(spread), sinS = Math.sin(spread);
    const dirX = aim.x * cosS - aim.z * sinS;
    const dirZ = aim.x * sinS + aim.z * cosS;
    ctx.projectiles.spawn({
      position: [enemy.position.x, 0, enemy.position.z],
      direction: [dirX, 0, dirZ],
      speed: s.bulletSpeed,
      damage: s.bulletDamage,
      ttl: s.bulletTtl,
      color: s.bulletColor,
      size: 1.1,
    });
    if (ctx.bus) {
      ctx.bus.emit('enemy:fire', {
        id: enemy.id,
        type: 'shooter',
        x: enemy.position.x,
        z: enemy.position.z,
        dirX,
        dirZ,
      });
    }
    s.fireCooldown = s.fireInterval;
  }
}
