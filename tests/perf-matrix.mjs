#!/usr/bin/env node
// SPRINT-08 — Performance Matrix Harness.
//
// Runs the existing in-page profiler + storm scenario across a simulated tier
// matrix (ultra / high / medium / low / webgl2) crossed with four gameplay
// scenarios (idle / storm / boss / soak). CPU/GPU throttling is applied via
// Chrome DevTools Protocol (CDP); the WebGL2 fallback is forced by URL param.
//
// For each cell we measure:
//   - fpsAvg          mean FPS over the capture window
//   - fpsP1           1st percentile FPS (worst 1% of frames, derived from p99 frame ms)
//   - frameP99Ms      99th percentile frame time
// And mark PASS/FAIL against the tier floor.
//
// Outputs:
//   artifacts/perf-matrix.json   raw machine-readable results
//   docs/PERF-RESULTS.md         human-readable results table (regenerated)
//
// Usage:
//   node tests/perf-matrix.mjs                            # full matrix
//   node tests/perf-matrix.mjs --tiers ultra,high         # subset
//   node tests/perf-matrix.mjs --scenarios idle,storm     # subset
//   node tests/perf-matrix.mjs --soak-ms 30000            # short soak (default 30s)
//   node tests/perf-matrix.mjs --url http://host:5173     # reuse running server
//   node tests/perf-matrix.mjs --capture-ms 5000          # capture window
//
// Exit codes: 0 ok, 1 boot/runtime failure, 2 one or more tier floors breached.

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Tier / scenario configuration.
// ---------------------------------------------------------------------------

/**
 * Tier simulation profiles. CDP CPU throttling multiplies measured CPU time
 * by `cpuRate`. WebGPU adapter memory caps aren't directly throttlable from
 * CDP, but the storm load (bullets/enemies) scales the GPU workload so the
 * effective budget is exercised. floorFps is the p1% FPS we must hit to PASS.
 */
const TIER_PROFILES = {
  ultra:  { cpuRate: 1,  storm: { bullets: 16000, enemies: 200 }, floorFps: 60, forceWebGL2: false, label: 'ultra  (no throttle)' },
  high:   { cpuRate: 4,  storm: { bullets: 12000, enemies: 160 }, floorFps: 60, forceWebGL2: false, label: 'high   (CPU 4x)' },
  medium: { cpuRate: 8,  storm: { bullets:  8000, enemies: 120 }, floorFps: 45, forceWebGL2: false, label: 'medium (CPU 8x)' },
  low:    { cpuRate: 16, storm: { bullets:  4000, enemies:  60 }, floorFps: 30, forceWebGL2: false, label: 'low    (CPU 16x)' },
  webgl2: { cpuRate: 8,  storm: { bullets:  4000, enemies:  60 }, floorFps: 30, forceWebGL2: true,  label: 'webgl2 (fallback, CPU 8x)' },
};

const ALL_TIERS = ['ultra', 'high', 'medium', 'low', 'webgl2'];
const ALL_SCENARIOS = ['idle', 'storm', 'boss', 'soak'];

// ---------------------------------------------------------------------------
// CLI args.
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const TIERS = (args.tiers ? String(args.tiers).split(',') : ALL_TIERS).filter((t) => TIER_PROFILES[t]);
const SCENARIOS = (args.scenarios ? String(args.scenarios).split(',') : ALL_SCENARIOS).filter((s) => ALL_SCENARIOS.includes(s));
const CAPTURE_MS = Number(args['capture-ms'] ?? 5000);
const WARMUP_MS = Number(args.warmup ?? 1500);
const SOAK_MS = Number(args['soak-ms'] ?? 30000);
const EXPLICIT_URL = args.url ?? null;
const OUT_JSON = resolve(ROOT, args.out ?? 'artifacts/perf-matrix.json');
const OUT_MD = resolve(ROOT, args.md ?? 'docs/PERF-RESULTS.md');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[k] = true;
      else { out[k] = next; i++; }
    }
  }
  return out;
}

const log = (...m) => console.log('[perf-matrix]', ...m);
const warn = (...m) => console.warn('[perf-matrix]', ...m);
function die(msg, code = 1) { console.error('[perf-matrix:FATAL]', msg); process.exit(code); }

// ---------------------------------------------------------------------------
// Build + preview server (reused pattern from scripts/perf-harness.mjs).
// ---------------------------------------------------------------------------

async function ensureBuilt() {
  if (existsSync(resolve(ROOT, 'dist/index.html'))) { log('using existing dist/'); return; }
  log('no dist/ — running vite build');
  await run('npx', ['vite', 'build'], { cwd: ROOT });
}

function run(cmd, argv, opts = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, argv, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
    p.on('exit', (code) => code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`)));
    p.on('error', rej);
  });
}

function startPreviewServer() {
  return new Promise((res, rej) => {
    const proc = spawn('npx', ['vite', 'preview', '--port', '0', '--strictPort', 'false'], {
      cwd: ROOT, shell: process.platform === 'win32', env: { ...process.env, FORCE_COLOR: '0' },
    });
    let resolved = false, buf = '';
    // Vite preview injects ANSI codes mid-URL (e.g. localhost:\x1b[1m33991), so
    // strip them before regex matching.
    const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
    const onData = (chunk) => {
      const text = chunk.toString();
      buf += text;
      process.stdout.write(text);
      const m = buf.replace(ANSI_RE, '').match(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/);
      if (m && !resolved) { resolved = true; res({ proc, url: m[0] }); }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => { if (!resolved) rej(new Error(`vite preview exited ${code} before printing URL`)); });
    setTimeout(() => { if (!resolved) rej(new Error('vite preview timed out')); }, 30_000);
  });
}

// ---------------------------------------------------------------------------
// CDP throttling helpers.
// ---------------------------------------------------------------------------

async function applyCpuThrottle(page, rate) {
  const client = await page.context().newCDPSession(page);
  await client.send('Emulation.setCPUThrottlingRate', { rate });
  return client;
}

async function clearCpuThrottle(client) {
  try { await client.send('Emulation.setCPUThrottlingRate', { rate: 1 }); } catch {}
  try { await client.detach(); } catch {}
}

// ---------------------------------------------------------------------------
// Scenario execution.
// ---------------------------------------------------------------------------

/**
 * Run a single scenario in the page and return aggregated metrics derived from
 * the in-page profiler traces collected over the capture window.
 */
async function runScenario(page, scenario, profile) {
  // Optionally kick off a long-running storm so render/sim load is realistic.
  let stormPromise = null;
  if (scenario === 'storm' || scenario === 'boss' || scenario === 'soak') {
    const stormCfg = scenarioStormCfg(scenario, profile);
    stormPromise = page.evaluate((cfg) => {
      // Fire-and-forget; we sample the profiler concurrently. Catch errors so
      // a scenario crash doesn't take down the harness — we'll see the impact
      // in the FPS numbers regardless.
      return window.__OMEGA__.scenarios.runStorm(cfg).catch((e) => ({
        error: String(e?.message ?? e),
      }));
    }, stormCfg);
    // Let the storm warm up before we begin sampling.
    await page.waitForTimeout(500);
  }

  // Reset profiler ring so this window is clean.
  await page.evaluate(() => { try { window.__OMEGA__.profiler.reset?.(); } catch {} });

  const captureMs = scenario === 'soak' ? SOAK_MS : CAPTURE_MS;
  const traces = [];
  const start = Date.now();
  // Sample profiler every 500ms for the capture window.
  while (Date.now() - start < captureMs) {
    const t = await page.evaluate(() => window.__OMEGA__.profiler.emit());
    if (t && t.metrics) traces.push(t);
    await page.waitForTimeout(500);
  }
  // One final trace for headline metrics.
  const finalTrace = await page.evaluate(() => window.__OMEGA__.profiler.emit());
  if (finalTrace) traces.push(finalTrace);

  // Let any background storm tear down before we move on.
  if (stormPromise) {
    try { await Promise.race([stormPromise, page.waitForTimeout(2000)]); } catch {}
  }

  return aggregateTraces(traces);
}

function scenarioStormCfg(scenario, profile) {
  // Storm = full load, Boss = fewer bullets + heavy VFX surrogate (lower
  // enemy count means each enemy soaks more collisions), Soak = full load
  // sustained for the soak duration.
  const base = profile.storm;
  switch (scenario) {
    case 'storm':
      return { bullets: 10000, enemies: Math.min(200, base.enemies), durationMs: CAPTURE_MS + 1500 };
    case 'boss':
      return { bullets: Math.floor(base.bullets * 0.4), enemies: 8, durationMs: CAPTURE_MS + 1500 };
    case 'soak':
      return { bullets: base.bullets, enemies: base.enemies, durationMs: SOAK_MS + 2000 };
    default:
      return { bullets: base.bullets, enemies: base.enemies, durationMs: CAPTURE_MS };
  }
}

function aggregateTraces(traces) {
  if (!traces.length) return { fpsAvg: 0, fpsP1: 0, frameP99Ms: 0, samples: 0 };
  const fpsSeries = traces.map((t) => t.metrics?.fps).filter(Number.isFinite);
  const p99Series = traces.map((t) => t.metrics?.p99Ms).filter((v) => Number.isFinite(v) && v > 0);
  const fpsAvg = fpsSeries.length ? fpsSeries.reduce((s, v) => s + v, 0) / fpsSeries.length : 0;
  // p1% FPS = 1000 / worst observed p99 frame-ms across the window.
  const frameP99Ms = p99Series.length ? Math.max(...p99Series) : 0;
  const fpsP1 = frameP99Ms > 0 ? 1000 / frameP99Ms : 0;
  return {
    fpsAvg: round(fpsAvg, 2),
    fpsP1: round(fpsP1, 2),
    frameP99Ms: round(frameP99Ms, 3),
    samples: traces.length,
  };
}

function round(v, p) { if (!Number.isFinite(v)) return 0; const m = 10 ** p; return Math.round(v * m) / m; }

// ---------------------------------------------------------------------------
// Matrix driver.
// ---------------------------------------------------------------------------

async function runMatrix() {
  let serverProc = null;
  let baseUrl = EXPLICIT_URL;
  if (!baseUrl) {
    await ensureBuilt();
    log('starting vite preview');
    const started = await startPreviewServer();
    serverProc = started.proc;
    baseUrl = started.url;
  }
  log('target url:', baseUrl);
  log('tiers:', TIERS.join(', '));
  log('scenarios:', SCENARIOS.join(', '));

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--enable-precise-memory-info',
      '--js-flags=--expose-gc',
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
    ],
  });

  const matrix = {}; // matrix[tier][scenario] = { fpsAvg, fpsP1, frameP99Ms, pass, ... }
  let breaches = 0;

  try {
    for (const tier of TIERS) {
      const profile = TIER_PROFILES[tier];
      matrix[tier] = {};
      log(`=== tier ${tier} (cpuRate=${profile.cpuRate}, forceWebGL2=${profile.forceWebGL2}) ===`);

      // One context per tier so navigation cost / GPU memory pressure resets cleanly.
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => warn('pageerror:', e.message));

      const url = profile.forceWebGL2
        ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}webgl2=1`
        : baseUrl;

      // Apply CPU throttle BEFORE navigation so boot timings stress the budget too.
      const cdp = await applyCpuThrottle(page, profile.cpuRate);

      try {
        await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
        await page.waitForFunction(
          () => !!(window.__OMEGA__ && window.__OMEGA__.profiler && window.__OMEGA__.loop && window.__OMEGA__.scenarios?.runStorm),
          null, { timeout: 30_000 },
        );

        // Confirm the renderer backend matches the tier expectation.
        const cap = await page.evaluate(() => ({
          webgpu: !!window.__OMEGA__?.cap?.webgpu,
          webgl2: !!window.__OMEGA__?.cap?.webgl2,
          tier: window.__OMEGA__?.cap?.tier ?? null,
        }));
        log(`  cap: webgpu=${cap.webgpu} webgl2=${cap.webgl2} reportedTier=${cap.tier}`);
        if (profile.forceWebGL2 && cap.webgpu) {
          warn('  WebGL2 force flag did not take effect (page still reports webgpu=true)');
        }

        log(`  warmup ${WARMUP_MS}ms`);
        await page.waitForTimeout(WARMUP_MS);

        for (const scenario of SCENARIOS) {
          const tStart = Date.now();
          log(`  [${tier}/${scenario}] running...`);
          let cell;
          try {
            cell = await runScenario(page, scenario, profile);
          } catch (err) {
            warn(`  [${tier}/${scenario}] error:`, err?.message ?? err);
            cell = { fpsAvg: 0, fpsP1: 0, frameP99Ms: 0, samples: 0, error: String(err?.message ?? err) };
          }
          const pass = cell.fpsP1 >= profile.floorFps;
          if (!pass) breaches++;
          cell.pass = pass;
          cell.floorFps = profile.floorFps;
          cell.elapsedMs = Date.now() - tStart;
          matrix[tier][scenario] = cell;
          log(`  [${tier}/${scenario}] fpsAvg=${cell.fpsAvg} fpsP1=${cell.fpsP1} p99=${cell.frameP99Ms}ms floor=${profile.floorFps}fps ${pass ? 'PASS' : 'FAIL'}`);
        }
        // Force-GC between tiers.
        try { await page.evaluate(() => { try { window.gc && window.gc(); } catch {} }); } catch {}
      } finally {
        await clearCpuThrottle(cdp);
        await ctx.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
    if (serverProc) {
      serverProc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  const report = {
    schema: 'omega.perf-matrix.report',
    version: 1,
    generatedAt: new Date().toISOString(),
    tiers: TIERS,
    scenarios: SCENARIOS,
    captureMs: CAPTURE_MS,
    warmupMs: WARMUP_MS,
    soakMs: SOAK_MS,
    profiles: TIER_PROFILES,
    matrix,
    breaches,
    verdict: breaches === 0 ? 'all-tiers-pass' : `breaches:${breaches}`,
  };

  await mkdir(dirname(OUT_JSON), { recursive: true });
  await writeFile(OUT_JSON, JSON.stringify(report, null, 2));
  log('wrote', OUT_JSON);

  await mkdir(dirname(OUT_MD), { recursive: true });
  await writeFile(OUT_MD, renderMarkdown(report));
  log('wrote', OUT_MD);

  log('verdict:', report.verdict);
  return report;
}

// ---------------------------------------------------------------------------
// Markdown renderer.
// ---------------------------------------------------------------------------

function renderMarkdown(report) {
  const lines = [];
  lines.push('# PERF-RESULTS — Cross-device Performance Matrix');
  lines.push('');
  lines.push(`_Generated: ${report.generatedAt}_`);
  lines.push('');
  lines.push('Auto-generated by `tests/perf-matrix.mjs`. Do not hand-edit — re-run the matrix instead:');
  lines.push('');
  lines.push('```bash');
  lines.push('node tests/perf-matrix.mjs');
  lines.push('```');
  lines.push('');
  lines.push('## Tier Simulation');
  lines.push('');
  lines.push('| Tier | CPU throttle | Storm load (bullets/enemies) | Renderer | Floor fps (p1%) |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const t of report.tiers) {
    const p = report.profiles[t];
    lines.push(`| \`${t}\` | ${p.cpuRate}x | ${p.storm.bullets} / ${p.storm.enemies} | ${p.forceWebGL2 ? 'WebGL2 (forced)' : 'WebGPU → WebGL2 fallback'} | ${p.floorFps} |`);
  }
  lines.push('');
  lines.push('## Scenarios');
  lines.push('');
  lines.push('- **idle** — menu screen, no gameplay load.');
  lines.push('- **storm** — 10k bullets, max particles, dense collision.');
  lines.push('- **boss** — heavy VFX surrogate: reduced bullets, very few targets so per-target collisions soak.');
  lines.push(`- **soak** — sustained storm load for ${Math.round(report.soakMs / 1000)}s (set via \`--soak-ms\`; production target is 30 minutes).`);
  lines.push('');
  lines.push('## Results');
  lines.push('');
  for (const tier of report.tiers) {
    const p = report.profiles[tier];
    lines.push(`### Tier: \`${tier}\` — floor ${p.floorFps} fps (p1%)`);
    lines.push('');
    lines.push('| Scenario | fps avg | fps p1% | frame p99 (ms) | Verdict |');
    lines.push('| --- | ---: | ---: | ---: | :---: |');
    for (const sc of report.scenarios) {
      const cell = report.matrix[tier]?.[sc];
      if (!cell) { lines.push(`| ${sc} | – | – | – | SKIP |`); continue; }
      const verdict = cell.error ? `ERROR (${cell.error})` : (cell.pass ? 'PASS' : 'FAIL');
      lines.push(`| ${sc} | ${cell.fpsAvg.toFixed(2)} | ${cell.fpsP1.toFixed(2)} | ${cell.frameP99Ms.toFixed(2)} | ${verdict} |`);
    }
    lines.push('');
  }
  lines.push('## WebGL2 Fallback');
  lines.push('');
  if (report.tiers.includes('webgl2') && report.matrix.webgl2) {
    const cells = Object.values(report.matrix.webgl2);
    const allPass = cells.every((c) => c.pass);
    lines.push(`Verified by forcing \`?webgl2=1\` and applying ${report.profiles.webgl2.cpuRate}x CPU throttle. Floor: ${report.profiles.webgl2.floorFps} fps (p1%).`);
    lines.push('');
    lines.push(allPass ? '**Result:** playable on all tested scenarios.' : '**Result:** floor breached on one or more scenarios — see table above.');
  } else {
    lines.push('Not tested in this run.');
  }
  lines.push('');
  lines.push('## Overall Verdict');
  lines.push('');
  lines.push(report.breaches === 0
    ? '**ALL TIERS PASS** — every tier hits its floor across every scenario, WebGL2 fallback included.'
    : `**${report.breaches} BREACH(ES)** — see per-tier tables.`);
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Entrypoint.
// ---------------------------------------------------------------------------

runMatrix().then((report) => {
  process.exit(report.breaches === 0 ? 0 : 2);
}).catch((e) => die(e?.stack ?? String(e)));
