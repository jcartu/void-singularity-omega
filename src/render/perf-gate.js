// PerfGate — release valve for SPRINT-04 post-FX stack.
//
// Measures per-node post-FX cost, enforces tier budgets, and degrades the
// chain gracefully (reduce intensity → disable node) when the rolling average
// exceeds the budget. The in-loop hot path is allocation-free and reads only
// PostFX.lastRenderMs (a single Float64) so per-frame overhead is < 0.1ms.
//
// Per-node cost is measured by differential A/B sampling:
//   baseline (all enabled) → disable node N → measure delta → restore
// This captures CPU-side encoding cost (true GPU per-pass time would need
// WebGPU timestamp-query-set, not yet exposed by WebGPURenderer). The number
// is a useful relative ordering for "which node should I drop next?".
//
// Calibration runs on-demand via calibrate() — typically once after warmup
// (the harness drives this). Until calibrated, a static cost prior is used
// for ordering so enforceBudget() still makes sensible choices.
//
// Tier budgets (total post-FX time per frame):
//   ultra:  8 ms   (120fps target)
//   high:  10 ms   (60fps target, leaves room for game)
//   medium: 6 ms   (60fps, reduced node count)
//   low:    3 ms   (bloom + tonemap only)

export const TIER_BUDGETS = Object.freeze({
  ultra: 8.0,
  high: 10.0,
  medium: 6.0,
  low: 3.0,
});

// Maximum acceptable cost for a single node. The harness flags violators.
export const PER_NODE_BUDGET_MS = 2.0;

// Static fallback ordering until a real calibration runs. Higher → drop first.
const COST_PRIOR_MS = Object.freeze({
  ssr: 3.0,
  gtao: 2.0,
  dof: 1.5,
  motionBlur: 1.0,
  bloom: 1.0,
  ca: 0.4,
  grain: 0.3,
  lensing: 0.2,
  vignette: 0.1,
});

// Rolling window for the budget check (≈ half a second at 60fps).
const ROLL_WINDOW = 30;

// Drop order when no per-node data exists yet — visual-impact prior.
// Cheapest visual loss first: motionBlur, ca, grain, dof, ssr, gtao, lensing.
const DROP_PRIORITY = ['motionBlur', 'ca', 'grain', 'dof', 'ssr', 'gtao', 'lensing', 'bloom', 'vignette'];

function round(v, p = 3) {
  if (!Number.isFinite(v)) return 0;
  const m = 10 ** p;
  return Math.round(v * m) / m;
}

export class PerfGate {
  /**
   * @param {object} opts
   * @param {object} opts.postfx   Either a PostFX instance OR the createPostFX handle
   *                                (the handle is unwrapped via .fx).
   * @param {object} [opts.profiler] optional Profiler instance for action logging
   * @param {string} [opts.tier='high'] 'low'|'medium'|'high'|'ultra'
   * @param {number} [opts.checkEvery=30] frames between budget enforcement checks
   */
  constructor({ postfx, profiler = null, tier = 'high', checkEvery = ROLL_WINDOW }) {
    // Accept either the raw PostFX or the createPostFX() wrapper.
    this.fx = postfx?.fx ?? postfx;
    if (!this.fx || typeof this.fx.getNodes !== 'function') {
      throw new Error('[perf-gate] postfx must expose getNodes()/enableNode()/setIntensity()');
    }
    this.profiler = profiler;
    this.tier = tier;
    this.budgetMs = TIER_BUDGETS[tier] ?? TIER_BUDGETS.high;
    this.checkEvery = Math.max(1, checkEvery | 0);

    // Rolling ring buffer of total post-FX render ms (one slot per frame).
    this._ring = new Float64Array(ROLL_WINDOW);
    this._ringHead = 0;
    this._ringCount = 0;

    this.frame = 0;
    this._framesSinceCheck = 0;
    this._lastSampledMs = this.fx.lastRenderMs ?? 0;

    // Per-node stats. ms is the calibrated cost; samples track future drift.
    this._nodeStats = {};
    for (const n of this.fx.getNodes()) {
      this._nodeStats[n.name] = {
        name: n.name,
        ms: COST_PRIOR_MS[n.name] ?? 0.5,  // prior until calibrated
        avg: 0, p50: 0, p99: 0, max: 0,
        samples: [],
        calibrated: false,
      };
    }

    this._calibrated = false;
    this._calibrating = false;

    // Action log — disable/reduce events for the harness report.
    this.log = [];
  }

  // -------------------------------------------------------------------------
  // Hot path — called every frame from world.render(). Must be allocation-free.
  // -------------------------------------------------------------------------
  measureFrame() {
    const ms = this.fx.lastRenderMs;
    if (Number.isFinite(ms) && ms > 0) {
      this._ring[this._ringHead] = ms;
      this._ringHead = (this._ringHead + 1) % ROLL_WINDOW;
      if (this._ringCount < ROLL_WINDOW) this._ringCount++;
      this._lastSampledMs = ms;
    }
    this.frame++;
  }

  update(/* dt */) {
    this.measureFrame();
    this._framesSinceCheck++;
    if (this._framesSinceCheck >= this.checkEvery) {
      this._framesSinceCheck = 0;
      // Fire-and-forget; never block the loop on calibration/enforcement.
      this.enforceBudget().catch((e) => {
        // eslint-disable-next-line no-console
        console.warn('[perf-gate] enforce failed:', e?.message ?? e);
      });
    }
  }

  // -------------------------------------------------------------------------
  // Rolling stats
  // -------------------------------------------------------------------------
  rollingAvg() {
    const n = this._ringCount;
    if (n === 0) return 0;
    let s = 0;
    for (let i = 0; i < n; i++) s += this._ring[i];
    return s / n;
  }

  rollingP99() {
    const n = this._ringCount;
    if (n === 0) return 0;
    const sorted = new Float64Array(n);
    for (let i = 0; i < n; i++) sorted[i] = this._ring[i];
    Array.prototype.sort.call(sorted, (a, b) => a - b);
    return sorted[Math.min(n - 1, Math.floor(n * 0.99))];
  }

  // -------------------------------------------------------------------------
  // Per-node calibration. Differential A/B sampling: baseline vs node-disabled.
  // -------------------------------------------------------------------------
  async calibrate({ framesPerNode = 4, dt = 1 / 60 } = {}) {
    if (this._calibrating) return;
    this._calibrating = true;
    try {
      // Snapshot current enabled set so we can restore on failure paths.
      const initialEnabled = {};
      for (const n of this.fx.getNodes()) initialEnabled[n.name] = n.enabled;

      // Warmup
      await this._timeRender(2, dt);

      const baseline = await this._timeRender(framesPerNode, dt);

      for (const node of this.fx.getNodes()) {
        if (!initialEnabled[node.name]) continue;
        // Toggle off (this triggers a _build() — small one-time hit).
        this.fx.enableNode(node.name, false);
        // Settle one frame so the rebuilt graph is hot.
        await this._timeRender(1, dt);
        const without = await this._timeRender(framesPerNode, dt);
        // Restore.
        this.fx.enableNode(node.name, true);

        const delta = Math.max(0, baseline - without);
        const s = this._nodeStats[node.name];
        if (s) {
          s.ms = delta;
          s.avg = delta;
          s.p50 = delta;
          s.p99 = delta;
          s.max = delta;
          s.samples = [delta];
          s.calibrated = true;
        }
      }
      // Final settle render with original config restored.
      await this._timeRender(1, dt);
      this._calibrated = true;
    } finally {
      this._calibrating = false;
    }
  }

  /** Render `samples` frames, return trimmed-mean wall time (ms). */
  async _timeRender(samples, dt) {
    const arr = [];
    for (let i = 0; i < samples; i++) {
      const t0 = performance.now();
      await this.fx.render(dt);
      arr.push(performance.now() - t0);
    }
    if (arr.length === 0) return 0;
    if (arr.length === 1) return arr[0];
    arr.sort((a, b) => a - b);
    arr.pop(); // drop max as outlier
    let s = 0;
    for (const v of arr) s += v;
    return s / arr.length;
  }

  // -------------------------------------------------------------------------
  // Budget enforcement. Disables the most expensive enabled node, or reduces
  // intensity first on ultra tier. Re-runs until under budget (one action per
  // call to avoid hysteresis — the next 30-frame check picks up where we left off).
  // -------------------------------------------------------------------------
  async enforceBudget() {
    if (this._calibrating) return;
    if (this._ringCount < this.checkEvery) return; // not enough samples yet
    const avg = this.rollingAvg();
    if (avg <= this.budgetMs) return;

    // Identify enabled nodes ranked by cost (calibrated if available, else prior).
    const enabled = this.fx.getNodes().filter((n) => n.enabled);
    if (enabled.length === 0) return;

    enabled.sort((a, b) => {
      const ca = this._nodeStats[a.name]?.ms ?? COST_PRIOR_MS[a.name] ?? 0;
      const cb = this._nodeStats[b.name]?.ms ?? COST_PRIOR_MS[b.name] ?? 0;
      if (cb !== ca) return cb - ca;
      // Tie-break: lower drop priority wins (prefer cheap-visual-loss nodes).
      return DROP_PRIORITY.indexOf(a.name) - DROP_PRIORITY.indexOf(b.name);
    });

    const target = enabled[0];
    const targetStats = this._nodeStats[target.name];

    // Ultra tier: exhaust intensity reduction before disabling (per spec).
    if (this.tier === 'ultra' && target.intensity > 0.1) {
      const from = target.intensity;
      const to = Math.max(0.05, from * 0.5);
      this.fx.setIntensity(target.name, to);
      this._record('reduce-intensity', { node: target.name, from: round(from, 3), to: round(to, 3), avgMs: round(avg), budget: this.budgetMs });
      return;
    }

    // All other tiers (or ultra with intensity already exhausted) → disable.
    this.fx.enableNode(target.name, false);
    if (targetStats) targetStats.ms = 0; // its cost is now zero
    this._record('disable', { node: target.name, avgMs: round(avg), budget: this.budgetMs, costMs: round(targetStats?.ms ?? 0) });

    // Reset the ring so the next check measures the post-action state.
    this._ringCount = 0;
    this._ringHead = 0;
  }

  _record(action, extra) {
    const entry = { frame: this.frame, action, t: performance.now(), ...extra };
    this.log.push(entry);
    if (this.profiler && Array.isArray(this.profiler.events)) {
      this.profiler.events.push(entry);
    } else if (this.profiler?.log) {
      try { this.profiler.log('perf-gate', entry); } catch { /* noop */ }
    }
    // eslint-disable-next-line no-console
    console.info('[perf-gate]', action, extra);
  }

  // -------------------------------------------------------------------------
  // Reporting
  // -------------------------------------------------------------------------
  getReport() {
    const avg = this.rollingAvg();
    const p99 = this.rollingP99();
    const nodes = this.fx.getNodes().map((n) => {
      const s = this._nodeStats[n.name] ?? {};
      const cost = s.ms ?? 0;
      return {
        name: n.name,
        tier: n.tier,
        enabled: n.enabled,
        intensity: round(n.intensity, 3),
        msCost: round(cost),
        avg: round(s.avg ?? 0),
        p50: round(s.p50 ?? 0),
        p99: round(s.p99 ?? 0),
        max: round(s.max ?? 0),
        calibrated: !!s.calibrated,
        overPerNodeBudget: cost > PER_NODE_BUDGET_MS,
      };
    });

    // Sort report by cost desc for human readability.
    nodes.sort((a, b) => b.msCost - a.msCost);

    return {
      schema: 'omega.perf-gate.report',
      version: 1,
      tier: this.tier,
      budget: this.budgetMs,
      perNodeBudget: PER_NODE_BUDGET_MS,
      rollingAvgMs: round(avg),
      rollingP99Ms: round(p99),
      lastFrameMs: round(this._lastSampledMs),
      frames: this.frame,
      sampleWindow: this._ringCount,
      calibrated: this._calibrated,
      underBudget: avg <= this.budgetMs,
      nodes,
      log: this.log.slice(),
    };
  }

  /** Reset all toggles to tier defaults — called between harness sweeps. */
  reset() {
    this.fx.setTier?.(this.tier);
    this._ringCount = 0;
    this._ringHead = 0;
    this._framesSinceCheck = 0;
    this.log.length = 0;
    for (const n of this.fx.getNodes()) {
      const s = this._nodeStats[n.name];
      if (s && !s.calibrated) s.ms = COST_PRIOR_MS[n.name] ?? 0.5;
    }
  }
}

export default PerfGate;
