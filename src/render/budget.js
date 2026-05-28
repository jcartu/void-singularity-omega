// Frame Budget Manager — per-system instrumentation + auto-tiering (SPRINT-08).
//
// Tracks four budgeted systems each frame: sim, render, post, audio.
// Maintains a 60-frame rolling average per system and a "total" average
// (sum-of-per-system, NOT wall-clock frame time — keeps the abstraction
// independent of vsync/idle gaps and matches the per-tier budget table).
//
// Auto-tiering walks the ladder ultra ↔ high ↔ medium ↔ low with hysteresis:
//   downgrade — total avg > tierTotal for 5 consecutive frames (after warmup)
//   upgrade   — total avg <= 0.70 * nextTierTotal for 10 consecutive frames
//   cooldown  — at least 3s between tier transitions
//
// On a transition `BudgetManager` emits a 'tier:change' event on its bus
// (when provided) and calls `postfx.setTier(newTier)` if available so the
// post-FX graph reconfigures alongside the budget gates.
//
// Hot-path overhead: measureSystem() is a single performance.now()/now() pair
// and a Float64 ring write — typically < 0.001ms per call on V8. The full
// update() per frame walks at most 4 ring buffers of 60 entries.

const ROLLING_WINDOW = 60;
const DOWNGRADE_FRAMES = 5;
const UPGRADE_FRAMES = 10;
const COOLDOWN_MS = 3000;
const UPGRADE_HEADROOM = 0.70; // require comfortable headroom to upgrade

/** Tier ladder, low → ultra (index = power level). */
export const TIER_LADDER = Object.freeze(['low', 'medium', 'high', 'ultra']);

/**
 * Per-system ms budgets. Sum is the "total frame budget" we compare against.
 *   ultra : 4 + 6 + 8 + 1 = 19ms  (120fps target, ~8.3ms wall, slack via post)
 *   high  : 5 + 7 +10 + 1 = 23ms  (60fps target, 16.6ms wall)
 *   medium: 6 + 8 + 6 + 1 = 21ms  (60fps, reduced post)
 *   low   : 8 +10 + 3 + 1 = 22ms  (30fps, 33ms wall, plenty of slack)
 */
export const BUDGET_TABLE = Object.freeze({
  ultra:  Object.freeze({ sim: 4, render: 6, post: 8,  audio: 1 }),
  high:   Object.freeze({ sim: 5, render: 7, post: 10, audio: 1 }),
  medium: Object.freeze({ sim: 6, render: 8, post: 6,  audio: 1 }),
  low:    Object.freeze({ sim: 8, render:10, post: 3,  audio: 1 }),
});

const SYSTEM_NAMES = Object.freeze(['sim', 'render', 'post', 'audio']);

function tierTotal(tier) {
  const b = BUDGET_TABLE[tier];
  if (!b) return Infinity;
  return b.sim + b.render + b.post + b.audio;
}

function clampTierIndex(i) {
  if (i < 0) return 0;
  if (i >= TIER_LADDER.length) return TIER_LADDER.length - 1;
  return i;
}

export class BudgetManager {
  /**
   * @param {{
   *   profiler?: any,                 // optional Profiler — read-only co-existence
   *   postfx?:   any,                 // optional PostFX wrapper (gets setTier(newTier))
   *   bus?:      { emit: Function, on?: Function } | null,
   *   tier?:     'ultra'|'high'|'medium'|'low',
   *   onTierChange?: (info:{from:string,to:string,reason:string}) => void,
   * }} opts
   */
  constructor({
    profiler = null,
    postfx = null,
    bus = null,
    tier = 'high',
    onTierChange = null,
  } = {}) {
    this.profiler = profiler;
    this.postfx = postfx;
    this.bus = bus;
    this.onTierChange = onTierChange;

    // Tier state.
    this._tier = (BUDGET_TABLE[tier] ? tier : 'high');
    this._tierIndex = TIER_LADDER.indexOf(this._tier);

    // Pre-allocated ring buffers per system — no allocation on hot path.
    this._rings = {
      sim:    new Float64Array(ROLLING_WINDOW),
      render: new Float64Array(ROLLING_WINDOW),
      post:   new Float64Array(ROLLING_WINDOW),
      audio:  new Float64Array(ROLLING_WINDOW),
    };
    this._head = { sim: 0, render: 0, post: 0, audio: 0 };
    this._count = { sim: 0, render: 0, post: 0, audio: 0 };
    this._sum = { sim: 0, render: 0, post: 0, audio: 0 };  // running sum for O(1) avg

    // Per-frame scratch — last sample value for overlay.
    this._last = { sim: 0, render: 0, post: 0, audio: 0 };

    // Hysteresis counters.
    this._overFrames = 0;
    this._underFrames = 0;
    this._cooldownUntil = 0;
    this._frame = 0;
    this._lastTransitionAt = 0;
    this._log = [];   // tier transition history (small, for harness/inspection)
  }

  // -------------------------------------------------------------------------
  // Tier API
  // -------------------------------------------------------------------------
  getTier()  { return this._tier; }
  getBudgets() { return BUDGET_TABLE[this._tier]; }
  getBudgetTotal() { return tierTotal(this._tier); }

  /**
   * Force a tier change (bypassing hysteresis counters but still honoring the
   * cooldown so back-to-back forced changes can't oscillate).
   * @param {'ultra'|'high'|'medium'|'low'} tier
   * @param {string} [reason='manual']
   */
  setTier(tier, reason = 'manual') {
    if (!BUDGET_TABLE[tier]) return false;
    if (tier === this._tier) return false;
    const now = performance.now();
    if (now < this._cooldownUntil && reason !== 'force') return false;
    this._applyTier(tier, reason, now);
    return true;
  }

  _applyTier(tier, reason, now) {
    const from = this._tier;
    this._tier = tier;
    this._tierIndex = TIER_LADDER.indexOf(tier);
    this._cooldownUntil = now + COOLDOWN_MS;
    this._lastTransitionAt = now;
    this._overFrames = 0;
    this._underFrames = 0;
    // Reset rolling stats so the next decision is made on the new tier's
    // post-transition steady state — prevents immediate ping-pong.
    this._resetRings();

    // Propagate to PostFX if it understands tiers.
    if (this.postfx && typeof this.postfx.setTier === 'function') {
      try { this.postfx.setTier(tier); } catch { /* noop */ }
    }
    // Note: PerfGate also has its own tier; main.js may update perfGate.tier
    // via the 'tier:change' subscriber.

    const info = { from, to: tier, reason, frame: this._frame, t: now };
    this._log.push(info);
    if (this._log.length > 32) this._log.shift();

    if (this.bus && typeof this.bus.emit === 'function') {
      try { this.bus.emit('tier:change', info); } catch { /* noop */ }
    }
    if (typeof this.onTierChange === 'function') {
      try { this.onTierChange(info); } catch { /* noop */ }
    }
    // eslint-disable-next-line no-console
    console.info('[budget] tier', from, '→', tier, `(${reason})`);
  }

  _resetRings() {
    for (const k of SYSTEM_NAMES) {
      const r = this._rings[k];
      for (let i = 0; i < r.length; i++) r[i] = 0;
      this._head[k] = 0;
      this._count[k] = 0;
      this._sum[k] = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Instrumentation
  // -------------------------------------------------------------------------
  /**
   * Wrap a system update with high-resolution timing. Records the elapsed ms
   * in the rolling window for `name`. Returns whatever `fn()` returned.
   * Overhead: one performance.now() pair + one Float64 write + one O(1) sum
   * update. Empirically < 0.001ms on V8.
   * @template T
   * @param {string} name one of 'sim'|'render'|'post'|'audio'
   * @param {() => T} fn
   * @returns {T}
   */
  measureSystem(name, fn) {
    if (!this._rings[name]) return fn();
    const t0 = performance.now();
    const result = fn();
    const dt = performance.now() - t0;
    this.record(name, dt);
    return result;
  }

  /**
   * Record a pre-measured ms sample for `name`. Useful when the timing is
   * supplied externally (e.g. PostFX.lastRenderMs, which is captured by the
   * pass renderer itself).
   * @param {string} name
   * @param {number} ms
   */
  record(name, ms) {
    const ring = this._rings[name];
    if (!ring) return;
    if (!Number.isFinite(ms) || ms < 0) return;
    const head = this._head[name];
    const prev = ring[head];
    ring[head] = ms;
    this._head[name] = (head + 1) % ROLLING_WINDOW;
    if (this._count[name] < ROLLING_WINDOW) this._count[name]++;
    // Maintain running sum so getAvg() is O(1).
    this._sum[name] += ms - prev;
    this._last[name] = ms;
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------
  getAvg(name) {
    const n = this._count[name];
    if (!n) return 0;
    return this._sum[name] / n;
  }

  getTotalAvg() {
    let sum = 0;
    for (const k of SYSTEM_NAMES) sum += this.getAvg(k);
    return sum;
  }

  /** Snapshot of per-system ms (last sample + rolling avg) plus tier state. */
  getOverlayData() {
    const budgets = BUDGET_TABLE[this._tier];
    const total = this.getTotalAvg();
    const totalBudget = tierTotal(this._tier);
    return {
      tier: this._tier,
      systems: {
        sim:    { last: this._last.sim,    avg: this.getAvg('sim'),    budget: budgets.sim },
        render: { last: this._last.render, avg: this.getAvg('render'), budget: budgets.render },
        post:   { last: this._last.post,   avg: this.getAvg('post'),   budget: budgets.post },
        audio:  { last: this._last.audio,  avg: this.getAvg('audio'),  budget: budgets.audio },
      },
      total: { avg: total, budget: totalBudget, ratio: totalBudget ? total / totalBudget : 0 },
      cooldownRemainingMs: Math.max(0, this._cooldownUntil - performance.now()),
      overFrames: this._overFrames,
      underFrames: this._underFrames,
    };
  }

  /** Tier transition history (most recent at end). Bounded to 32 entries. */
  getLog() { return this._log.slice(); }

  // -------------------------------------------------------------------------
  // Hysteresis / auto-tier
  // -------------------------------------------------------------------------
  /**
   * Advance hysteresis. Called once per rendered frame from world.render().
   * @param {number} _dt seconds (unused — we use real wall time for cooldown)
   */
  update(_dt) {
    this._frame++;
    // Warmup: wait until at least one ring is full before making decisions.
    // We pick the slowest-filling (audio) since it's usually smallest cadence —
    // but in practice all four fill together so `sim` is fine.
    if (this._count.sim < ROLLING_WINDOW) return;
    this.checkBudgets();
  }

  /**
   * Compare the rolling totals against the active tier budget and step the
   * hysteresis counters. Triggers a transition when thresholds are crossed
   * and the cooldown has elapsed.
   */
  checkBudgets() {
    const now = performance.now();
    const inCooldown = now < this._cooldownUntil;
    const total = this.getTotalAvg();
    const budget = tierTotal(this._tier);

    if (total > budget) {
      this._overFrames++;
      this._underFrames = 0;
    } else {
      // Track upgrade pressure against the NEXT tier up (stricter budget).
      // If we can't fit comfortably in the next tier, reset upgrade counter.
      const nextIdx = clampTierIndex(this._tierIndex + 1);
      const canUpgrade = nextIdx !== this._tierIndex
        && total <= UPGRADE_HEADROOM * tierTotal(TIER_LADDER[nextIdx]);
      if (canUpgrade) {
        this._underFrames++;
      } else {
        this._underFrames = 0;
      }
      this._overFrames = 0;
    }

    if (inCooldown) return;

    // Downgrade has priority — never starve the downgrade path.
    if (this._overFrames >= DOWNGRADE_FRAMES) {
      const lowerIdx = clampTierIndex(this._tierIndex - 1);
      if (lowerIdx !== this._tierIndex) {
        this._applyTier(TIER_LADDER[lowerIdx], 'downgrade:over-budget', now);
        return;
      }
      // Already at the floor — clear counter so we don't spin.
      this._overFrames = 0;
      return;
    }
    if (this._underFrames >= UPGRADE_FRAMES) {
      const upperIdx = clampTierIndex(this._tierIndex + 1);
      if (upperIdx !== this._tierIndex) {
        this._applyTier(TIER_LADDER[upperIdx], 'upgrade:headroom', now);
      } else {
        this._underFrames = 0;
      }
    }
  }
}

export default BudgetManager;
