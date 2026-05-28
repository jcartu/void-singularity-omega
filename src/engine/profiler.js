// Frame-sampling profiler for VOID SINGULARITY: OMEGA.
// Tracks: fps, frame-time percentiles (avg/p50/p1% worst), draw calls, triangles,
// programs, heap size. Designed for <1% overhead: pure scalar work per frame,
// ring buffer of fixed size, no allocations in the hot path.
//
// Emits a JSON trace consumable by scripts/perf-harness.mjs and the Opus auditor.

const TRACE_VERSION = 1;

export class Profiler {
  /**
   * @param {{ renderer?: any, loop?: any, sampleSize?: number }} opts
   */
  constructor({ renderer = null, loop = null, sampleSize = 600 } = {}) {
    this.renderer = renderer;
    this.loop = loop;
    this.sampleSize = sampleSize;

    // Pre-allocated ring buffer (Float64 for perf.now ms timings).
    this._frameTimes = new Float64Array(sampleSize);
    this._head = 0;
    this._count = 0;

    // Live snapshot, mutated in place to avoid GC churn.
    this.snapshot = {
      frame: 0,
      fps: 0,
      frameMs: 0,
      avgMs: 0,
      p50Ms: 0,
      p99Ms: 0,        // p1% worst frame (99th percentile of frame time)
      drawCalls: 0,
      triangles: 0,
      programs: 0,
      heapMB: 0,
      heapLimitMB: 0,
      tNow: 0,
    };

    this._frameStart = 0;
    this._lastEmit = 0;
    this._enabled = true;

    // Capture starting baselines so per-frame draw call delta is accurate
    // (Three.js renderer.info counters reset each render() call by default;
    // we record absolute on endFrame).
    this._renderInfo = renderer?.info ?? null;
  }

  enable()  { this._enabled = true; }
  disable() { this._enabled = false; }

  beginFrame() {
    if (!this._enabled) return;
    this._frameStart = performance.now();
  }

  endFrame() {
    if (!this._enabled) return;
    const now = performance.now();
    const dt = now - this._frameStart;

    // Ring-buffer write (no allocation).
    this._frameTimes[this._head] = dt;
    this._head = (this._head + 1) % this.sampleSize;
    if (this._count < this.sampleSize) this._count++;

    const s = this.snapshot;
    s.frame++;
    s.frameMs = dt;
    s.tNow = now;

    // Renderer counters — Three.js WebGPURenderer exposes .info.render.
    const info = this._renderInfo;
    if (info) {
      s.drawCalls = info.render?.calls ?? 0;
      s.triangles = info.render?.triangles ?? 0;
      s.programs  = info.programs?.length ?? 0;
    }

    // Heap — only Chrome/Edge expose performance.memory.
    const mem = performance.memory;
    if (mem) {
      s.heapMB      = mem.usedJSHeapSize / (1024 * 1024);
      s.heapLimitMB = mem.jsHeapSizeLimit / (1024 * 1024);
    }

    // FPS from loop if available; else derive from rolling avg.
    if (this.loop && Number.isFinite(this.loop.fps)) {
      s.fps = this.loop.fps;
    } else if (dt > 0) {
      s.fps = 1000 / dt;
    }
  }

  /** Computes stats over the current sample window. O(n log n) — call sparingly. */
  computeStats() {
    const n = this._count;
    const s = this.snapshot;
    if (n === 0) {
      s.avgMs = s.p50Ms = s.p99Ms = 0;
      return s;
    }
    // Copy active region and sort.
    const sorted = new Float64Array(n);
    for (let i = 0; i < n; i++) sorted[i] = this._frameTimes[i];
    Array.prototype.sort.call(sorted, (a, b) => a - b);

    let sum = 0;
    for (let i = 0; i < n; i++) sum += sorted[i];
    s.avgMs = sum / n;
    s.p50Ms = sorted[Math.floor(n * 0.50)];
    s.p99Ms = sorted[Math.min(n - 1, Math.floor(n * 0.99))];
    return s;
  }

  /**
   * Emits a JSON-serializable trace snapshot.
   * Schema is stable; bump TRACE_VERSION on breaking changes.
   */
  emit() {
    this.computeStats();
    const s = this.snapshot;
    const cap = (typeof window !== 'undefined' && window.__OMEGA__?.cap) || null;
    return {
      schema: 'omega.profiler.trace',
      version: TRACE_VERSION,
      timestamp: Date.now(),
      sampleWindow: this._count,
      capability: cap ? { webgpu: !!cap.webgpu, webgl2: !!cap.webgl2, tier: cap.tier ?? null } : null,
      metrics: {
        frame: s.frame,
        fps: round(s.fps, 2),
        frameMs: round(s.frameMs, 3),
        avgMs:   round(s.avgMs, 3),
        p50Ms:   round(s.p50Ms, 3),
        p99Ms:   round(s.p99Ms, 3),   // p1% worst frame time
        drawCalls: s.drawCalls,
        triangles: s.triangles,
        programs:  s.programs,
        heapMB:      round(s.heapMB, 2),
        heapLimitMB: round(s.heapLimitMB, 2),
      },
    };
  }

  /** Returns raw frame-time samples (oldest-first) for offline analysis. */
  dumpSamples() {
    const n = this._count;
    const out = new Array(n);
    // Reconstruct chronological order from ring buffer.
    const start = this._count < this.sampleSize ? 0 : this._head;
    for (let i = 0; i < n; i++) {
      out[i] = this._frameTimes[(start + i) % this.sampleSize];
    }
    return out;
  }
}

function round(v, p) {
  if (!Number.isFinite(v)) return 0;
  const m = 10 ** p;
  return Math.round(v * m) / m;
}
