#!/usr/bin/env node
// Perf harness for VOID SINGULARITY: OMEGA.
//
// Boots a headless Chromium via Playwright against `vite preview`, lets the
// game run for a fixed warmup + capture window, then pulls a JSON trace from
// `window.__OMEGA__.profiler.emit()` for the Opus auditor.
//
// Usage:
//   node scripts/perf-harness.mjs                          # build + run, write artifacts/perf.json
//   node scripts/perf-harness.mjs --url http://host:5173   # use an already-running server
//   node scripts/perf-harness.mjs --duration 8000          # capture window in ms (default 5000)
//   node scripts/perf-harness.mjs --warmup 2000            # warmup window in ms (default 2000)
//   node scripts/perf-harness.mjs --out artifacts/perf.json
//
// Exit codes: 0 ok, 1 boot/runtime failure, 2 perf budget breach (reserved).

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const args = parseArgs(process.argv.slice(2));
const DURATION_MS = Number(args.duration ?? 5000);
const WARMUP_MS   = Number(args.warmup   ?? 2000);
const OUT_PATH    = resolve(ROOT, args.out ?? 'artifacts/perf.json');
const EXPLICIT_URL = args.url ?? null;
const SCENARIO    = String(args.scenario ?? 'idle'); // 'idle' | 'storm'

// Per-tier load presets for the storm scenario. Budget = 1000/targetFps in ms.
const TIER_PROFILES = {
  ultra:  { bullets: 16000, enemies: 200, targetFps: 60, budgetMs: 16.67 },
  high:   { bullets: 12000, enemies: 160, targetFps: 60, budgetMs: 16.67 },
  medium: { bullets:  8000, enemies: 120, targetFps: 45, budgetMs: 22.22 },
  low:    { bullets:  4000, enemies:  60, targetFps: 30, budgetMs: 33.33 },
};
const TIERS = ['ultra', 'high', 'medium', 'low'];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    }
  }
  return out;
}

function log(...m) { console.log('[perf]', ...m); }
function warn(...m) { console.warn('[perf]', ...m); }
function die(msg, code = 1) { console.error('[perf:FATAL]', msg); process.exit(code); }

async function ensureBuilt() {
  if (existsSync(resolve(ROOT, 'dist/index.html'))) {
    log('using existing dist/');
    return;
  }
  log('no dist/ — running vite build');
  await run('npx', ['vite', 'build'], { cwd: ROOT });
}

function run(cmd, argv, opts = {}) {
  return new Promise((resolveP, rejectP) => {
    const p = spawn(cmd, argv, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
    p.on('exit', (code) => code === 0 ? resolveP() : rejectP(new Error(`${cmd} exited ${code}`)));
    p.on('error', rejectP);
  });
}

function startPreviewServer() {
  return new Promise((resolveP, rejectP) => {
    const proc = spawn('npx', ['vite', 'preview', '--port', '0', '--strictPort', 'false'], {
      cwd: ROOT,
      shell: process.platform === 'win32',
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    let resolved = false;
    let buf = '';
    const onData = (chunk) => {
      const text = chunk.toString();
      buf += text;
      process.stdout.write(text);
      const m = buf.match(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/);
      if (m && !resolved) {
        resolved = true;
        resolveP({ proc, url: m[0] });
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => {
      if (!resolved) rejectP(new Error(`vite preview exited ${code} before printing URL`));
    });
    setTimeout(() => {
      if (!resolved) rejectP(new Error('vite preview timed out waiting for URL'));
    }, 30_000);
  });
}

async function main() {
  let serverProc = null;
  let url = EXPLICIT_URL;

  if (!url) {
    await ensureBuilt();
    log('starting vite preview');
    const started = await startPreviewServer();
    serverProc = started.proc;
    url = started.url;
  }
  log('target url:', url);

  const browser = await chromium.launch({
    headless: true,
    args: [
      // Expose performance.memory + GC; allow WebGPU when available.
      '--enable-precise-memory-info',
      '--js-flags=--expose-gc',
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
    ],
  });

  const traces = [];
  let exitCode = 0;

  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => warn('pageerror:', e.message));
    page.on('console', (msg) => {
      const t = msg.type();
      if (t === 'error' || t === 'warning') warn(`${t}:`, msg.text());
    });

    log('navigating');
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });

    // Wait for boot to finish wiring the profiler.
    await page.waitForFunction(
      () => !!(window.__OMEGA__ && window.__OMEGA__.profiler && window.__OMEGA__.loop),
      null,
      { timeout: 20_000 },
    );

    log(`warmup ${WARMUP_MS}ms`);
    await page.waitForTimeout(WARMUP_MS);

    const t0 = Date.now();
    let stormReport = null;
    let postfxReport = null;
    if (SCENARIO === 'storm') {
      log('running storm scenario sweep across tiers:', TIERS.join(', '));
      stormReport = await runStormSweep(page);
    } else if (SCENARIO === 'postfx') {
      log('running postfx per-node perf scenario');
      postfxReport = await runPostFXScenario(page);
    } else {
      log(`sampling ${DURATION_MS}ms`);
      const t0s = t0;
      while (Date.now() - t0s < DURATION_MS) {
        const trace = await page.evaluate(() => window.__OMEGA__.profiler.emit());
        traces.push(trace);
        await page.waitForTimeout(500);
      }
    }

    // Final consolidated trace.
    const final = await page.evaluate(() => window.__OMEGA__.profiler.emit());
    traces.push(final);

    // Validate schema invariants.
    if (!final || final.schema !== 'omega.profiler.trace') {
      die('profiler returned invalid trace schema');
    }
    const req = ['fps', 'frameMs', 'avgMs', 'p50Ms', 'p99Ms', 'drawCalls', 'heapMB'];
    for (const k of req) {
      if (!(k in final.metrics)) die(`trace missing required metric: ${k}`);
    }

    const report = {
      schema: 'omega.perf-harness.report',
      version: 2,
      scenario: SCENARIO,
      url,
      startedAt: new Date(t0).toISOString(),
      durationMs: DURATION_MS,
      warmupMs: WARMUP_MS,
      samples: traces,
      final,
      summary: summarize(traces),
      storm: stormReport,
      postfx: postfxReport,
    };

    await mkdir(dirname(OUT_PATH), { recursive: true });
    await writeFile(OUT_PATH, JSON.stringify(report, null, 2));
    log('wrote', OUT_PATH);
    log('summary:', JSON.stringify(report.summary));
    if (stormReport) log('storm verdict:', stormReport.verdict);
    if (postfxReport) log('postfx verdict:', postfxReport.verdict);
  } catch (err) {
    console.error('[perf:ERROR]', err?.stack ?? err);
    exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
    if (serverProc) {
      serverProc.kill('SIGTERM');
      // Give it a moment to die cleanly.
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  process.exit(exitCode);
}

function summarize(traces) {
  if (!traces.length) return null;
  const last = traces[traces.length - 1].metrics;
  const fpsSeries = traces.map((t) => t.metrics.fps).filter(Number.isFinite);
  const p99Series = traces.map((t) => t.metrics.p99Ms).filter(Number.isFinite);
  const heapSeries = traces.map((t) => t.metrics.heapMB).filter(Number.isFinite);
  return {
    fpsAvg: avg(fpsSeries),
    fpsMin: Math.min(...fpsSeries),
    p99MsMax: Math.max(...p99Series),
    heapMBMax: Math.max(...heapSeries),
    drawCalls: last.drawCalls,
    triangles: last.triangles,
  };
}
function avg(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }

async function runStormSweep(page) {
  // Sanity: the runStorm helper must be wired in by main.js.
  const hasScenario = await page.evaluate(() => !!window.__OMEGA__?.scenarios?.runStorm);
  if (!hasScenario) die('runStorm scenario not exposed on window.__OMEGA__.scenarios');

  const tier = await page.evaluate(() => window.__OMEGA__?.cap?.tier ?? null);
  log('detected device tier:', tier);

  const perTier = {};
  for (const t of TIERS) {
    const profile = TIER_PROFILES[t];
    log(`storm[${t}] bullets=${profile.bullets} enemies=${profile.enemies} target=${profile.targetFps}fps`);
    // Force GC between tiers so heap noise doesn't leak across runs.
    await page.evaluate(() => { try { window.gc && window.gc(); } catch {} });
    const result = await page.evaluate(async (opts) => {
      return await window.__OMEGA__.scenarios.runStorm(opts);
    }, { bullets: profile.bullets, enemies: profile.enemies, durationMs: 3000 });

    const totalAvg = result?.phases?.total?.avg ?? 0;
    const totalP99 = result?.phases?.total?.p99 ?? 0;
    const fpsAvg = totalAvg > 0 ? 1000 / totalAvg : 0;
    const fpsP1  = totalP99 > 0 ? 1000 / totalP99 : 0;
    const pass = fpsP1 >= profile.targetFps;

    perTier[t] = {
      profile,
      result,
      derived: {
        fpsAvg: round(fpsAvg, 2),
        fpsP1: round(fpsP1, 2),
        budgetMs: profile.budgetMs,
        overBudget: round(Math.max(0, totalP99 - profile.budgetMs), 3),
        pass,
        bottleneck: identifyBottleneck(result, profile),
      },
    };
    log(`  -> avg=${fpsAvg.toFixed(1)}fps p1%=${fpsP1.toFixed(1)}fps`, pass ? 'OK' : 'BREACH');
    if (!pass) log(`     bottleneck: ${perTier[t].derived.bottleneck.phase} (${perTier[t].derived.bottleneck.share}% of frame)`);
  }

  const breaches = Object.entries(perTier).filter(([, r]) => !r.derived.pass).map(([t]) => t);
  return {
    schema: 'omega.perf-harness.storm',
    deviceTier: tier,
    perTier,
    breaches,
    verdict: breaches.length === 0 ? 'all-tiers-pass' : `breach:${breaches.join(',')}`,
  };
}

function identifyBottleneck(result, profile) {
  const phases = result?.phases ?? {};
  // Compare avg cost of named phases — pick the biggest contributor.
  const named = ['integrate', 'grid', 'collide'];
  let total = 0;
  for (const p of named) total += phases[p]?.avg ?? 0;
  let topName = 'none', topVal = -1;
  for (const p of named) {
    const v = phases[p]?.avg ?? 0;
    if (v > topVal) { topVal = v; topName = p; }
  }
  const share = total > 0 ? round((topVal / total) * 100, 1) : 0;
  const totalP99 = phases.total?.p99 ?? 0;
  return {
    phase: topName,
    share,
    avgMs: round(topVal, 3),
    overBudgetMs: round(Math.max(0, totalP99 - profile.budgetMs), 3),
    hint: hintFor(topName),
  };
}

function hintFor(phase) {
  switch (phase) {
    case 'collide': return 'broadphase grid scan dominates — consider larger cells, target AABB pre-pass, or SIMD/wasm';
    case 'integrate': return 'gravity/integrate loop dominates — consider skip-bands, fewer fixed steps, or SoA SIMD';
    case 'grid': return 'grid rebuild dominates — consider incremental cell updates instead of full rebuild';
    default: return 'no dominant phase';
  }
}

function round(v, p) { if (!Number.isFinite(v)) return 0; const m = 10 ** p; return Math.round(v * m) / m; }

// ---------------------------------------------------------------------------
// Post-FX per-node scenario (SPRINT-04 release valve).
// ---------------------------------------------------------------------------
const POSTFX_TIER_BUDGETS = { ultra: 8.0, high: 10.0, medium: 6.0, low: 3.0 };
const POSTFX_PER_NODE_BUDGET_MS = 2.0;

async function runPostFXScenario(page) {
  const hasGate = await page.evaluate(() => !!window.__OMEGA__?.perfGate);
  if (!hasGate) die('perfGate not exposed on window.__OMEGA__.perfGate');

  const tier = await page.evaluate(() => window.__OMEGA__?.cap?.tier ?? window.__OMEGA__?.perfGate?.tier ?? 'high');
  log('postfx: tier', tier);
  const budget = POSTFX_TIER_BUDGETS[tier] ?? POSTFX_TIER_BUDGETS.high;

  // Drive storm load in the background so the post-FX chain encodes against
  // realistic geometry — total cost includes scene complexity, not just FX.
  log('postfx: starting background storm load');
  await page.evaluate(() => {
    // Fire-and-forget; we don't await the storm so it runs concurrently.
    window.__OMEGA__.scenarios.runStorm({ bullets: 4000, enemies: 80, durationMs: 30_000 })
      .catch((e) => console.warn('[storm bg]', e?.message ?? e));
  });
  await page.waitForTimeout(800);

  // Reset gate state and trigger per-node calibration.
  log('postfx: calibrating per-node cost (differential A/B sampling)');
  await page.evaluate(async () => {
    const g = window.__OMEGA__.perfGate;
    g.reset?.();
    await g.calibrate({ framesPerNode: 5 });
  });

  // Settle. Now let the in-loop measureFrame() build a rolling average.
  log('postfx: sampling rolling average for budget assessment');
  await page.waitForTimeout(1500);

  const beforeReport = await page.evaluate(() => window.__OMEGA__.perfGate.getReport());

  // Run several enforceBudget passes to test auto-degradation. Each pass
  // disables (or reduces) one node if the rolling average is over budget.
  log('postfx: invoking enforceBudget up to 5 times to test degradation');
  for (let i = 0; i < 5; i++) {
    const acted = await page.evaluate(async () => {
      const g = window.__OMEGA__.perfGate;
      const before = g.log.length;
      await g.enforceBudget();
      return g.log.length > before;
    });
    if (!acted) break;
    // Allow new rolling samples to accumulate before next decision.
    await page.waitForTimeout(700);
  }

  const afterReport = await page.evaluate(() => window.__OMEGA__.perfGate.getReport());

  const overPerNode = afterReport.nodes.filter((n) => n.overPerNodeBudget && n.calibrated);
  const verdict = afterReport.underBudget && overPerNode.length === 0
    ? 'pass'
    : (afterReport.underBudget ? `per-node-breach:${overPerNode.map((n) => n.name).join(',')}` : 'over-budget');

  const out = {
    schema: 'omega.perf-harness.postfx',
    version: 1,
    tier,
    budgetMs: budget,
    perNodeBudgetMs: POSTFX_PER_NODE_BUDGET_MS,
    verdict,
    before: beforeReport,
    after: afterReport,
    overPerNodeBudget: overPerNode.map((n) => ({ name: n.name, msCost: n.msCost })),
    actions: afterReport.log,
  };

  const outPath = resolve(ROOT, 'artifacts/perf-postfx.json');
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(out, null, 2));
  log('postfx: wrote', outPath);
  log(`postfx: rollingAvg=${afterReport.rollingAvgMs}ms budget=${budget}ms verdict=${verdict}`);
  if (overPerNode.length) {
    for (const n of overPerNode) log(`  per-node breach: ${n.name} = ${n.msCost}ms (max ${POSTFX_PER_NODE_BUDGET_MS}ms)`);
  }
  for (const a of afterReport.log) log(`  action[${a.frame}] ${a.action} ${a.node ?? ''} avg=${a.avgMs}`);
  return out;
}

main().catch((e) => die(e?.stack ?? String(e)));
