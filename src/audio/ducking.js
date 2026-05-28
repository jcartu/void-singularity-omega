// DuckingManager — sidechain-style music ducking driven by gameplay events.
//
// Routing (after construction):
//
//   music sub-bus ─► duckGain ─► master
//
// The music sub-bus is detached from master and re-routed through a private
// GainNode owned by this manager. The BusGraph's own music volume (set by the
// user / settings UI) is preserved upstream of the duck node — ducking only
// scales the *output* of the music bus, never the stored user volume.
//
// Active ducks are tracked as small envelope objects. Every update() tick we
// compute, per duck, its instantaneous dB attenuation, take the deepest
// (most-negative) value across all active ducks, and apply that to duckGain.
// "Deepest wins" means stacking is safe: tiny ducks never override a big one,
// and small overlapping ducks don't sum into audible pumping.
//
// Envelope shape per duck:
//   t ∈ [0, attack]              → linear ramp from 0 → -amount dB
//   t ∈ [attack, attack+hold]    → hold at -amount dB
//   t ∈ [attack+hold, +release]  → exponential recover toward 0 dB
//
// Recovery uses a one-pole exponential approach so it sounds natural and
// doesn't introduce a hard knee back to unity. release is the time-constant
// at which we cross ~95% of the way back to 0 dB.
//
// All time-domain work is in milliseconds on a logical clock advanced by
// update(dt). No setTimeout / no AudioParam ramp scheduling — ducks survive
// frame stalls and never desync from gameplay time.

import { EVENTS } from '../engine/events.js';

const DEFAULT_ATTACK_MS = 30;
const DEFAULT_RELEASE_MS = 400;
const APPLY_LERP_PER_MS = 0.02; // smooths target → applied to kill micro-jitter

/** dB → linear amplitude. */
function dbToGain(db) {
  return Math.pow(10, db / 20);
}

/** Preset duck shapes keyed by an internal reason. */
export const DUCK_PRESETS = Object.freeze({
  boss_spawn:     { amount: 6, hold: 2000, attack: 40, release: 600 },
  player_death:   { amount: 8, hold: 3000, attack: 60, release: 900 },
  screen_clear:   { amount: 4, hold: 600,  attack: 20, release: 350 },
  upgrade_pickup: { amount: 3, hold: 300,  attack: 15, release: 250 },
});

export class DuckingManager {
  /**
   * @param {{
   *   audio: any,             // AudioCore (must be started)
   *   buses?: any,            // BusGraph (defaults to audio.graph)
   *   bus?: any,              // EventBus (optional)
   * }} opts
   */
  constructor({ audio, buses = null, bus = null }) {
    if (!audio) throw new Error('DuckingManager: audio is required');
    this.audio = audio;
    this.bus = bus;
    this.buses = buses || audio.graph || null;
    if (!this.buses) throw new Error('DuckingManager: buses (BusGraph) not available — start AudioCore first');

    const ctx = this.buses.ctx;
    const musicNode = this.buses.subs?.music;
    const masterNode = this.buses.master;
    if (!ctx || !musicNode || !masterNode) {
      throw new Error('DuckingManager: BusGraph is missing music/master nodes');
    }

    // Insert duckGain into the music chain.
    this._ctx = ctx;
    this._musicNode = musicNode;
    this._masterNode = masterNode;
    this._duckGain = ctx.createGain();
    this._duckGain.gain.value = 1.0;

    try { musicNode.disconnect(); } catch (_) {}
    musicNode.connect(this._duckGain);
    this._duckGain.connect(masterNode);

    /** Active ducks. Pre-allocated free list to avoid GC churn. */
    this._active = [];     // array of envelope objects
    this._free = [];       // reusable envelope objects
    /** Logical clock in ms, advanced by update(dt). */
    this._tMs = 0;
    /** Last applied dB (≤ 0). Lerped toward target each tick. */
    this._appliedDb = 0;
    /** Computed target dB this frame (≤ 0). */
    this._targetDb = 0;

    // Event subscriptions (optional — only if a bus is supplied).
    this._unsubs = [];
    if (this.bus && typeof this.bus.on === 'function') this._wireEvents();
  }

  _wireEvents() {
    const sub = (event, handler) => {
      const off = this.bus.on(event, handler);
      if (typeof off === 'function') this._unsubs.push(off);
      else this._unsubs.push(() => this.bus.off?.(event, handler));
    };

    sub('boss:encounter',   () => this._fromPreset('boss_spawn'));
    sub('run:over',         () => this._fromPreset('player_death'));
    sub('upgrade:picked',   () => this._fromPreset('upgrade_pickup'));
    sub(EVENTS.UPGRADE_PICKED, () => this._fromPreset('upgrade_pickup'));
    // enemy:death only ducks for bosses — the payload must say so.
    sub('enemy:death', (p) => {
      if (p && (p.isBoss || p.boss || p.kind === 'boss')) this._fromPreset('screen_clear');
    });
    // Generic screen-clear hook for explosions / smart bombs.
    sub('screen:clear', () => this._fromPreset('screen_clear'));
  }

  _fromPreset(key) {
    const p = DUCK_PRESETS[key];
    if (!p) return;
    this.duck(p.amount, p.hold, key, p);
  }

  /**
   * Trigger a duck.
   * @param {number} amountDb       Positive dB of attenuation (e.g. 6 = -6 dB).
   * @param {number} holdMs         Time at peak attenuation, in ms.
   * @param {string} [reason]       Tag for debugging / observability.
   * @param {{attack?:number, release?:number}} [shape]
   */
  duck(amountDb, holdMs, reason = '', shape = null) {
    const amount = Math.max(0, +amountDb || 0);
    const hold   = Math.max(0, +holdMs   || 0);
    if (amount <= 0) return;
    const attack  = Math.max(1, shape?.attack  ?? DEFAULT_ATTACK_MS);
    const release = Math.max(1, shape?.release ?? DEFAULT_RELEASE_MS);

    const env = this._free.pop() || {};
    env.amount  = amount;
    env.hold    = hold;
    env.attack  = attack;
    env.release = release;
    env.t0      = this._tMs;       // attack starts now
    env.reason  = reason;
    // Conservative kill-time: attack + hold + ~6 time-constants of release.
    env.expireMs = env.t0 + attack + hold + release * 6;
    // Cached: peak dB at this instant (for the release exponential).
    env.releaseStartMs = env.t0 + attack + hold;
    this._active.push(env);
  }

  /** Instantaneous dB attenuation for one envelope at the manager's clock. */
  _envDbAt(env, tMs) {
    const local = tMs - env.t0;
    if (local <= 0) return 0;
    if (local < env.attack) {
      return -env.amount * (local / env.attack);
    }
    if (local < env.attack + env.hold) {
      return -env.amount;
    }
    // Release phase — exponential recovery to 0 dB.
    const r = (local - (env.attack + env.hold)) / env.release;
    // amplitude factor: 1 at r=0, → 0 as r → ∞.
    const k = Math.exp(-3.0 * r); // ~5% remaining at r=1
    return -env.amount * k;
  }

  /**
   * Advance the ducking state by dt seconds, then write the resulting gain
   * to the duck node. Cheap: O(active ducks), no allocations.
   * @param {number} dt seconds
   */
  update(dt) {
    const dtMs = Math.max(0, dt * 1000) || 0;
    this._tMs += dtMs;
    const t = this._tMs;

    // Compute deepest active duck (most negative dB).
    let target = 0;
    const a = this._active;
    let writeIdx = 0;
    for (let i = 0; i < a.length; i++) {
      const env = a[i];
      if (t >= env.expireMs) {
        // Drop. Recycle into free list.
        this._free.push(env);
        continue;
      }
      const db = this._envDbAt(env, t);
      if (db < target) target = db;
      // Compact in place (avoid splice).
      if (writeIdx !== i) a[writeIdx] = env;
      writeIdx++;
    }
    a.length = writeIdx;

    this._targetDb = target;

    // Smooth applied → target (kills micro-jitter from sub-ms envelope edges).
    // alpha clamped to [0,1]; large dt jumps still converge fast.
    const alpha = Math.min(1, APPLY_LERP_PER_MS * dtMs);
    this._appliedDb = this._appliedDb + (target - this._appliedDb) * (alpha || 1);

    // Write to audio param. setValueAtTime avoids ramps fighting our own
    // per-frame writes — we are the smoothing layer.
    const g = dbToGain(this._appliedDb);
    try {
      this._duckGain.gain.setValueAtTime(g, this._ctx.currentTime);
    } catch (_) {
      // Fallback for non-standard nodes.
      this._duckGain.gain.value = g;
    }
  }

  /** @returns {number} current applied duck depth in dB (≤ 0). */
  getDuckAmount() { return this._appliedDb; }

  /** @returns {number} the deepest target dB this frame (≤ 0). */
  getTargetDuck() { return this._targetDb; }

  /** @returns {number} number of active duck envelopes. */
  getActiveCount() { return this._active.length; }

  /** Clear all active ducks immediately (gain ramps back over one tick). */
  clear() {
    while (this._active.length) this._free.push(this._active.pop());
    this._targetDb = 0;
  }

  dispose() {
    // Unsubscribe from events.
    for (const u of this._unsubs) { try { u(); } catch (_) {} }
    this._unsubs.length = 0;

    // Restore music → master direct connection.
    try { this._musicNode.disconnect(this._duckGain); } catch (_) {}
    try { this._duckGain.disconnect(); } catch (_) {}
    try { this._musicNode.connect(this._masterNode); } catch (_) {}
    this._duckGain = null;
    this._active.length = 0;
    this._free.length = 0;
  }
}
