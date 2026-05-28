// HitFeelManager — render-layer "juice" for impacts.
//
// Responsibilities:
//   * Hitstop (freeze frames): briefly pauses game-logic dt while render continues,
//     making big hits punch. Frame budget is hard-capped so input stays responsive.
//   * Knockback: applies a velocity impulse to the victim and tracks a decayed
//     readout for VFX consumers (getKnockback). The impulse itself is one-shot
//     into entity.velocity — the entity's own physics integrates it next step.
//   * Crit escalation: 2× hitstop, 1.5× knockback, emits 'hitfeel:flash' for a
//     brief white screen pulse and 'hitfeel:shake' for camera juice.
//   * Well-surge pulse: when a gravity surge spawns, emits a one-shot ring +
//     shake event and tags nearby enemies with a brief scale pulse.
//
// Strict invariants:
//   * NEVER modifies fixed-step semantics. Hitstop is consumed by the world's
//     update wrapper by zeroing dt for that frame — the loop's accumulator
//     keeps running and render() keeps firing. Cap is HITSTOP_MAX_FRAMES.
//   * Knockback is a one-shot impulse — we don't keep mutating entity velocity
//     over time (that fights ship/enemy control). Decay is purely for our own
//     bookkeeping (visual queries).
//   * No audio, no permanent stat mutations.
//
// Bus events emitted:
//   'hitfeel:flash'      { intensity }       // 0..1, peak this frame
//   'hitfeel:shake'      { trauma, duration }
//   'hitfeel:pulse'      { x, z, radius, strength }   // well-surge ring
//
// Bus events listened (auto-wired if bus provided):
//   'enemy:hit'  { id, type, x, z, damage, hpLeft, crit? }
//
// Consumers:
//   * world.js calls `update(dt)` each frame BEFORE its own systems update,
//     reads `getHitstopFrames()`, and substitutes dt=0 for the systems step
//     while hitstop is active.
//   * postfx / HUD can subscribe to 'hitfeel:flash' for screen flash.

const HITSTOP_MAX_FRAMES = 8;
const HITSTOP_FRAME_DT   = 1 / 120;   // matches engine/loop.js fixed step
const KNOCKBACK_DECAY    = 6.5;       // exp falloff per second for tracked readout
const FLASH_DECAY        = 9.0;       // per second

// Per-damage hitstop budget — tuned so trash damage = 1 frame, big crit = 5-6f.
function _hitstopFromDamage(damage, isCrit) {
  // Base curve: log-ish ramp on damage.
  let frames = 0;
  if (damage >= 80)      frames = 5;
  else if (damage >= 40) frames = 3;
  else if (damage >= 18) frames = 2;
  else if (damage >= 6)  frames = 1;
  else                   frames = 0; // tiny chip damage = no freeze
  if (isCrit) frames = Math.min(HITSTOP_MAX_FRAMES, Math.ceil(frames * 2));
  return frames;
}

// Knockback magnitude curve from damage. Player and enemy use different mults.
function _knockbackImpulse(damage, isCrit) {
  // Square-root keeps high-damage hits from launching things to orbit.
  const base = Math.sqrt(Math.max(0, damage)) * 2.4;
  return isCrit ? base * 1.5 : base;
}

export class HitFeelManager {
  /**
   * @param {object} deps
   * @param {import('../engine/events.js').EventBus} [deps.bus]
   * @param {object} [deps.camera] - either a PerspectiveCamera or a CameraRig.
   *   If it has a `.shake(trauma, duration)` method we call it directly;
   *   otherwise shakes are only emitted on the bus for downstream consumers.
   * @param {object} [deps.opts]
   */
  constructor({ bus = null, camera = null, opts = {} } = {}) {
    this.bus = bus;
    this.camera = camera;
    this.opts = {
      enemyKnockMult: opts.enemyKnockMult ?? 1.0,
      playerKnockMult: opts.playerKnockMult ?? 0.35,   // smaller so control survives
      maxHitstopFrames: Math.min(HITSTOP_MAX_FRAMES, opts.maxHitstopFrames ?? HITSTOP_MAX_FRAMES),
      shakeOnCrit: opts.shakeOnCrit ?? 0.55,
      shakeOnBigHit: opts.shakeOnBigHit ?? 0.3,
      bigHitThreshold: opts.bigHitThreshold ?? 25,
    };

    this._hitstopFrames = 0;            // remaining frames of freeze
    this._flash = 0;                    // 0..1 white-flash intensity
    this._knockbacks = new Map();       // entity -> { vx, vz, t } (decayed tracker)

    this._unsubs = [];
    if (bus && typeof bus.on === 'function') {
      this._unsubs.push(bus.on('enemy:hit', (ev) => {
        // SCRATCH_HIT is reused — read fields, don't retain.
        if (!ev) return;
        this._processEnemyHit(ev);
      }));
    }
  }

  // ---- Public API --------------------------------------------------------

  /**
   * Generic hit dispatch. Use for player-hit-by-enemy or other custom impacts
   * where you have direct attacker/victim references (not all hits flow
   * through the enemy:hit event — e.g. shooter projectile vs ship).
   *
   * @param {object|null} attacker - has .position {x,z} (used for knockback dir).
   * @param {object|null} victim   - has .position {x,z} and (optionally) .velocity.
   * @param {number} damage
   * @param {boolean} [isCrit]
   * @param {object} [opts]
   * @param {boolean} [opts.isPlayerVictim] - applies smaller knockback mult.
   */
  onHit(attacker, victim, damage, isCrit = false, opts = {}) {
    if (!Number.isFinite(damage) || damage <= 0) return;

    // 1. Hitstop budget.
    const frames = _hitstopFromDamage(damage, isCrit);
    if (frames > this._hitstopFrames) {
      this._hitstopFrames = Math.min(this.opts.maxHitstopFrames, frames);
    }

    // 2. Knockback impulse.
    if (victim && victim.position && (attacker && attacker.position)) {
      const isPlayerVictim = !!opts.isPlayerVictim;
      const mult = isPlayerVictim ? this.opts.playerKnockMult : this.opts.enemyKnockMult;
      const impulse = _knockbackImpulse(damage, isCrit) * mult;
      const dx = victim.position.x - attacker.position.x;
      const dz = victim.position.z - attacker.position.z;
      const len = Math.hypot(dx, dz);
      if (len > 1e-4 && impulse > 0) {
        const nx = dx / len;
        const nz = dz / len;
        const vx = nx * impulse;
        const vz = nz * impulse;
        // One-shot impulse into the victim's velocity (the victim's own physics
        // step will integrate + decay it). We don't keep mutating it.
        if (victim.velocity) {
          victim.velocity.x += vx;
          victim.velocity.z += vz;
        }
        // Track decayed readout for VFX consumers.
        this._knockbacks.set(victim, { vx, vz, t: 0 });
      }
    }

    // 3. Crit / big-hit visual escalation.
    if (isCrit) {
      this._flash = Math.max(this._flash, 0.85);
      this._fireShake(this.opts.shakeOnCrit, 0.35);
    } else if (damage >= this.opts.bigHitThreshold) {
      this._flash = Math.max(this._flash, 0.25);
      this._fireShake(this.opts.shakeOnBigHit, 0.22);
    }
  }

  /**
   * Trigger a well-surge pulse: ring VFX + shake + brief enemy scale pulse.
   * Called by whichever system owns gravity surges (gravity.js can be wired
   * to emit this once it has a bus; for now it's a manual hook).
   *
   * @param {{ x:number, z:number, strength?:number, radius?:number, enemies?: Iterable<any> }} p
   */
  wellSurge({ x = 0, z = 0, strength = 2.0, radius = 18, enemies = null } = {}) {
    if (this.bus) {
      this.bus.emit('hitfeel:pulse', { x, z, radius, strength });
    }
    // Camera shake scales with surge strength.
    const trauma = Math.min(0.9, 0.25 + strength * 0.15);
    this._fireShake(trauma, 0.5);
    // Brief enemy scale pulse: tag a transient via ECS transform if exposed.
    // Caller passes the enemies iterable (or null). We just mark a pulse on
    // any enemy whose record exposes a `state` object — read by enemy renderer.
    if (enemies) {
      const r2 = radius * radius;
      for (const e of enemies) {
        if (!e || !e.position) continue;
        const dx = e.position.x - x;
        const dz = e.position.z - z;
        if (dx * dx + dz * dz <= r2 && e.state) {
          e.state._pulseT = 0.35; // seconds; renderers/behaviors may read this
        }
      }
    }
  }

  /** Per-frame advance. dt is REAL dt (do not pass zeroed dt during hitstop). */
  update(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;

    // Decay knockback readout.
    if (this._knockbacks.size) {
      const decay = Math.exp(-KNOCKBACK_DECAY * dt);
      for (const [k, rec] of this._knockbacks) {
        rec.vx *= decay;
        rec.vz *= decay;
        rec.t += dt;
        if (rec.vx * rec.vx + rec.vz * rec.vz < 1e-4) this._knockbacks.delete(k);
      }
    }

    // Decay flash and emit current intensity (consumers sample one event/frame).
    if (this._flash > 0) {
      this._flash = Math.max(0, this._flash - FLASH_DECAY * dt);
      if (this.bus) this.bus.emit('hitfeel:flash', { intensity: this._flash });
    }
  }

  /**
   * Remaining hitstop frames (consumed by world before its system step).
   * IMPORTANT: callers should decrement using consumeHitstopFrame() each
   * fixed-step tick where they want the freeze to "spend" a frame.
   */
  getHitstopFrames() { return this._hitstopFrames; }

  /** Spend one freeze frame. Returns true if a frame was consumed. */
  consumeHitstopFrame() {
    if (this._hitstopFrames > 0) {
      this._hitstopFrames -= 1;
      return true;
    }
    return false;
  }

  /** Decayed knockback velocity for the given entity, or null. */
  getKnockback(entity) {
    const rec = this._knockbacks.get(entity);
    return rec ? { vx: rec.vx, vz: rec.vz, t: rec.t } : null;
  }

  /** Current flash intensity 0..1. */
  getFlash() { return this._flash; }

  dispose() {
    for (const u of this._unsubs) { try { u(); } catch { /* noop */ } }
    this._unsubs.length = 0;
    this._knockbacks.clear();
  }

  // ---- Internals ---------------------------------------------------------

  _processEnemyHit(ev) {
    // ev is the SCRATCH_HIT scratch object: { id, type, x, z, damage, hpLeft, crit? }.
    const isCrit = !!ev.crit;
    const dmg = ev.damage ?? 0;
    const frames = _hitstopFromDamage(dmg, isCrit);
    if (frames > this._hitstopFrames) {
      this._hitstopFrames = Math.min(this.opts.maxHitstopFrames, frames);
    }
    if (isCrit) {
      this._flash = Math.max(this._flash, 0.85);
      this._fireShake(this.opts.shakeOnCrit, 0.35);
    } else if (dmg >= this.opts.bigHitThreshold) {
      this._flash = Math.max(this._flash, 0.25);
      this._fireShake(this.opts.shakeOnBigHit, 0.22);
    }
    // Knockback can't be applied here (no attacker/victim refs in the scratch).
    // The emitter (weapons system or collision step) should call onHit() for
    // the knockback case. This handler covers the juice-only path.
  }

  _fireShake(trauma, duration) {
    if (this.camera && typeof this.camera.shake === 'function') {
      try { this.camera.shake(trauma, duration); } catch { /* noop */ }
    }
    if (this.bus) this.bus.emit('hitfeel:shake', { trauma, duration });
  }
}

// Exposed for tests / debugging.
export const __INTERNAL = Object.freeze({
  HITSTOP_MAX_FRAMES,
  HITSTOP_FRAME_DT,
  KNOCKBACK_DECAY,
  FLASH_DECAY,
  _hitstopFromDamage,
  _knockbackImpulse,
});
