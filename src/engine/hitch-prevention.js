// Hitch Prevention — SPRINT-08 / WO-08-?.
//
// Eliminates first-appearance compile and load hitches on three fronts:
//
//   1) Shader pre-warm
//      The WebGPU / WebGL2 backends only compile a pipeline the first time it
//      is bound. The PostFX graph builds a TSL node tree that is lazily
//      compiled in the render pass — so the first time GTAO, SSR, lensing,
//      DOF, motion-blur, etc. are *active* the user pays the compile cost in
//      one frame. prewarmShaders() walks every post-FX node, flips it on, and
//      forces one render() so the pipeline is hot before gameplay starts.
//      The biome skin presets are also touched so their FogExp2 / palette
//      paths get exercised once.
//
//   2) Asset preload
//      preloadNextBiome(currentId) maps the current biome id to the next one
//      in the rotation and schedules a low-priority warm of that preset using
//      requestIdleCallback (with a setTimeout fallback). The preset lookup
//      itself is just an object read, but warming nudges the JIT, exercises
//      the alias map, and parses the FogExp2 color. Cheap, opportunistic, and
//      runs off the critical frame.
//
//   3) Lazy-init audit
//      mark()/measure() let other systems report heavy initialization. We
//      keep a single Map of (label -> ms) and log anything above the warn
//      threshold (default 8 ms — half a 60 Hz frame). auditInit() emits the
//      sorted table once at boot.
//
// Frame-time monitoring runs every update(dt): a Float64 ring buffer
// (default 600 entries -> 10 s at 60 Hz) of the last frame durations, plus a
// dedicated hitch list capturing every frame > 50 ms (with a timestamp), so
// the perf harness can grep for them.
//
// MUST NOT:
//   - allocate per-frame (ring buffer is pre-sized)
//   - run while gameplay is hot (prewarm is one-shot, preload is idle-only)
//   - throw if PostFX nodes fail to enable (we swallow and continue)
//   - cause memory leaks (no listeners are attached without cleanup)

const DEFAULT_RING_SIZE = 600;
const DEFAULT_HITCH_MS = 50;
const DEFAULT_INIT_WARN_MS = 8;

// Biome rotation used by preloadNextBiome(). Matches the director's traversal
// order; aliases resolved through BiomeSkins.getBiomeSkin() so we don't need to
// know preset names exactly.
const BIOME_ROTATION = [
  'nebula-drift',
  'accretion-verge',
  'pulsar-field',
  'debris-belt',
  'event-horizon',
];

// Schedule a callback for an idle moment. Falls back to setTimeout(0) on
// browsers without requestIdleCallback (Safari).
function scheduleIdle(cb, timeout = 250) {
  if (typeof requestIdleCallback === 'function') {
    return requestIdleCallback(cb, { timeout });
  }
  return setTimeout(cb, 0);
}

function cancelIdle(handle) {
  if (handle == null) return;
  if (typeof cancelIdleCallback === 'function') {
    try { cancelIdleCallback(handle); return; } catch { /* fall through */ }
  }
  try { clearTimeout(handle); } catch { /* ignore */ }
}

export class HitchPrevention {
  /**
   * @param {object} opts
   * @param {number} [opts.ringSize=600]      frame-time history length
   * @param {number} [opts.hitchMs=50]        threshold for "hitch" frames (ms)
   * @param {number} [opts.initWarnMs=8]      init duration that triggers a warn log
   * @param {boolean}[opts.verbose=false]     emit console.info during prewarm
   */
  constructor({
    ringSize = DEFAULT_RING_SIZE,
    hitchMs = DEFAULT_HITCH_MS,
    initWarnMs = DEFAULT_INIT_WARN_MS,
    verbose = false,
  } = {}) {
    this.ringSize = ringSize | 0;
    this.hitchMs = hitchMs;
    this.initWarnMs = initWarnMs;
    this.verbose = !!verbose;

    // Frame-time ring (ms). Pre-allocated; never reallocated.
    this._frames = new Float64Array(this.ringSize);
    this._head = 0;
    this._count = 0;

    // Hitch log — bounded so we don't grow without limit during a long run.
    this._hitches = [];
    this._hitchCap = 256;
    this._hitchCount = 0;       // total hitches observed (uncapped count)

    // Init timing audit. label -> { ms, ts }.
    this._init = new Map();
    this._marks = new Map();    // label -> performance.now() at mark()

    // Prewarm state.
    this._prewarmDone = false;
    this._prewarmStats = null;

    // Preload state.
    this._preloadHandles = new Map();   // biomeId -> idle handle
    this._preloadedIds = new Set();

    // Live snapshot exposed to the profiler / debug HUD.
    this.snapshot = {
      frame: 0,
      hitchCount: 0,
      lastHitchMs: 0,
      lastHitchAt: 0,
      maxMs: 0,
      avgMs: 0,
      prewarmDone: false,
      preloaded: [],
    };

    this._lastT = 0;
  }

  // ── frame-time monitoring ────────────────────────────────────────────────

  /**
   * Advance frame-time monitoring. Call once per rendered frame from the
   * engine loop, after the render pass so the dt covers the *full* frame.
   * @param {number} dt seconds since last frame (engine-clock)
   */
  update(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    const ms = dt * 1000;

    // Ring write.
    this._frames[this._head] = ms;
    this._head = (this._head + 1) % this.ringSize;
    if (this._count < this.ringSize) this._count++;

    // Hitch detection.
    if (ms > this.hitchMs) {
      this._hitchCount++;
      if (this._hitches.length >= this._hitchCap) this._hitches.shift();
      const at = performance.now();
      this._hitches.push({ ms, at });
      this.snapshot.lastHitchMs = ms;
      this.snapshot.lastHitchAt = at;
    }

    // Rolling stats (cheap — only over current window).
    let sum = 0;
    let max = 0;
    const n = this._count;
    for (let i = 0; i < n; i++) {
      const v = this._frames[i];
      sum += v;
      if (v > max) max = v;
    }
    this.snapshot.frame++;
    this.snapshot.hitchCount = this._hitchCount;
    this.snapshot.maxMs = max;
    this.snapshot.avgMs = n > 0 ? sum / n : 0;
    this.snapshot.prewarmDone = this._prewarmDone;
  }

  /** Returns a copy of the last `limit` frame durations in chronological order. */
  getFrameTimes(limit = 0) {
    const n = this._count;
    const want = limit > 0 ? Math.min(limit, n) : n;
    const out = new Array(want);
    // Oldest sample is at (head - count) mod ringSize.
    let idx = (this._head - n + this.ringSize) % this.ringSize;
    // Skip ahead if caller wants a tail slice.
    if (want < n) idx = (idx + (n - want)) % this.ringSize;
    for (let i = 0; i < want; i++) {
      out[i] = this._frames[idx];
      idx = (idx + 1) % this.ringSize;
    }
    return out;
  }

  /** Returns the bounded hitch list (newest last). */
  getHitches() { return this._hitches.slice(); }

  /** Total hitch count (uncapped). */
  getHitchCount() { return this._hitchCount; }

  // ── lazy-init audit ──────────────────────────────────────────────────────

  /** Record the start of a heavy init. Pair with measure(label). */
  mark(label) {
    this._marks.set(label, performance.now());
  }

  /**
   * Close a mark()/measure() pair. Returns the elapsed ms. If the elapsed
   * exceeds initWarnMs, a console.warn is emitted so the auditor can spot it.
   */
  measure(label) {
    const start = this._marks.get(label);
    if (start == null) return 0;
    this._marks.delete(label);
    const ms = performance.now() - start;
    this._init.set(label, { ms, ts: performance.now() });
    if (ms > this.initWarnMs) {
      console.warn(`[hitch] heavy init: ${label} = ${ms.toFixed(1)}ms`);
    } else if (this.verbose) {
      console.info(`[hitch] init: ${label} = ${ms.toFixed(1)}ms`);
    }
    return ms;
  }

  /**
   * Manually record an init timing without using mark/measure (e.g. for an
   * async block timed externally).
   */
  recordInit(label, ms) {
    this._init.set(label, { ms, ts: performance.now() });
    if (ms > this.initWarnMs) {
      console.warn(`[hitch] heavy init: ${label} = ${ms.toFixed(1)}ms`);
    }
  }

  /** Log a sorted audit of all recorded init timings. Returns the table. */
  auditInit() {
    const rows = Array.from(this._init.entries())
      .map(([label, v]) => ({ label, ms: v.ms }))
      .sort((a, b) => b.ms - a.ms);
    if (rows.length === 0) {
      if (this.verbose) console.info('[hitch] audit: (no init samples)');
      return rows;
    }
    const total = rows.reduce((s, r) => s + r.ms, 0);
    console.info(`[hitch] init audit — ${rows.length} samples, total ${total.toFixed(1)}ms`);
    for (const r of rows) {
      const tag = r.ms > this.initWarnMs ? '⚠' : ' ';
      console.info(`  ${tag} ${r.label.padEnd(28)} ${r.ms.toFixed(1)}ms`);
    }
    return rows;
  }

  // ── shader pre-warm ──────────────────────────────────────────────────────

  /**
   * Force one render() per post-FX node so every pipeline compiles before
   * gameplay starts. We accept either the createPostFX() handle or a raw
   * PostFX instance, and silently skip nodes that fail to enable on the
   * active tier. Restores the original enable mask when done.
   *
   * @param {object} args
   * @param {*} args.renderer  WebGPURenderer (used for info only)
   * @param {*} args.postfx    PostFX handle (createPostFX() return value or PostFX)
   * @param {*} [args.scene]   unused — postfx already binds the scene
   * @param {*} [args.camera]  unused — postfx already binds the camera
   * @returns {Promise<{warmed:string[], skipped:string[], totalMs:number}>}
   */
  async prewarmShaders({ renderer, postfx, scene = null, camera = null } = {}) {
    void renderer; void scene; void camera;
    if (this._prewarmDone) return this._prewarmStats;
    const fx = postfx?.fx ?? postfx;
    if (!fx || typeof fx.render !== 'function' || typeof fx.getNodes !== 'function') {
      this._prewarmDone = true;
      this._prewarmStats = { warmed: [], skipped: [], totalMs: 0 };
      return this._prewarmStats;
    }

    const t0 = performance.now();
    const warmed = [];
    const skipped = [];

    // Snapshot original enabled mask.
    const before = new Map();
    for (const n of fx.getNodes()) before.set(n.name, n.enabled);

    // First: render the current graph once as a baseline (compiles the
    // tier-default pipeline). This is what would have hitched on first
    // gameplay frame today.
    try {
      await Promise.resolve(fx.render(1 / 60));
    } catch (e) {
      if (this.verbose) console.warn('[hitch] baseline prewarm render failed:', e?.message ?? e);
    }

    // For every node not currently enabled, flip it on, render once, then
    // restore. We do *not* call rebuild() ourselves — enableNode() does it.
    for (const node of fx.getNodes()) {
      const name = node.name;
      const wasOn = before.get(name);
      try {
        if (!wasOn) {
          fx.enableNode(name, true);
          // The enable might be denied if the active tier disallows the node
          // (PostFX.enableNode gates on tierAllows). Skip in that case.
          const live = fx.getNodes().find((n) => n.name === name);
          if (!live?.enabled) {
            skipped.push(name);
            continue;
          }
        }
        await Promise.resolve(fx.render(1 / 60));
        warmed.push(name);
      } catch (e) {
        skipped.push(name);
        if (this.verbose) console.warn(`[hitch] prewarm '${name}' failed:`, e?.message ?? e);
      } finally {
        // Restore original enable state. enableNode() rebuilds the chain;
        // we only call it if the state actually changed to keep the cost low.
        const live = fx.getNodes().find((n) => n.name === name);
        if (live && live.enabled !== wasOn) {
          try { fx.enableNode(name, !!wasOn); } catch { /* ignore */ }
        }
      }
    }

    // One final render with the restored mask so the next live frame doesn't
    // pay the rebuild() cost we just incurred.
    try {
      await Promise.resolve(fx.render(1 / 60));
    } catch { /* ignore */ }

    const totalMs = performance.now() - t0;
    this._prewarmDone = true;
    this._prewarmStats = { warmed, skipped, totalMs };
    this.snapshot.prewarmDone = true;

    console.info(
      `[hitch] prewarm complete — ${warmed.length} warmed, ${skipped.length} skipped, ${totalMs.toFixed(1)}ms`
      + (warmed.length ? ` [${warmed.join(', ')}]` : '')
      + (skipped.length ? `  skipped:[${skipped.join(', ')}]` : ''),
    );

    return this._prewarmStats;
  }

  // ── biome preload ────────────────────────────────────────────────────────

  /**
   * Look up the next biome in rotation given a current biome id, and warm its
   * preset on an idle callback. Safe to call repeatedly; cached after first
   * call per next-id. Accepts BiomeSkins via opts.biomeSkins so we can resolve
   * aliases and touch the resolved preset's palette path.
   *
   * @param {string} currentBiomeId
   * @param {object} [opts]
   * @param {*}     [opts.biomeSkins]  optional BiomeSkins instance for warming
   * @returns {string|null} the next biome id, or null if at end of rotation
   */
  preloadNextBiome(currentBiomeId, opts = {}) {
    const { biomeSkins = null } = opts;
    const next = this._nextBiomeId(currentBiomeId);
    if (!next) return null;
    if (this._preloadedIds.has(next)) return next;
    if (this._preloadHandles.has(next)) return next;

    const handle = scheduleIdle(() => {
      this._preloadHandles.delete(next);
      const t0 = performance.now();
      try {
        // Touch the preset (alias resolution + clone forces the JS engine to
        // walk the table once on a cold cache).
        if (biomeSkins && typeof biomeSkins.getBiomeSkin === 'function') {
          const skin = biomeSkins.getBiomeSkin(next);
          // Reference fields so V8 doesn't elide the clone.
          void skin?.palette;
          void skin?.fog?.color;
        }
      } catch (e) {
        if (this.verbose) console.warn(`[hitch] preload '${next}' failed:`, e?.message ?? e);
      } finally {
        const ms = performance.now() - t0;
        this._preloadedIds.add(next);
        this.snapshot.preloaded = Array.from(this._preloadedIds);
        if (this.verbose) {
          console.info(`[hitch] preloaded biome '${next}' in ${ms.toFixed(2)}ms`);
        }
      }
    }, 500);
    this._preloadHandles.set(next, handle);
    return next;
  }

  _nextBiomeId(currentId) {
    if (!currentId) return BIOME_ROTATION[0];
    // Match by prefix so aliases like 'nebula' resolve to 'nebula-drift'.
    const cur = String(currentId).toLowerCase();
    let idx = BIOME_ROTATION.findIndex((id) => id === cur || cur.startsWith(id.split('-')[0]));
    if (idx < 0) idx = -1;
    const ni = idx + 1;
    if (ni >= BIOME_ROTATION.length) return null;
    return BIOME_ROTATION[ni];
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** Cancel pending idle callbacks. Safe to call multiple times. */
  dispose() {
    for (const h of this._preloadHandles.values()) cancelIdle(h);
    this._preloadHandles.clear();
  }
}

export default HitchPrevention;
