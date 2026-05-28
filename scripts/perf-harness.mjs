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

    log(`sampling ${DURATION_MS}ms`);
    const t0 = Date.now();
    while (Date.now() - t0 < DURATION_MS) {
      const trace = await page.evaluate(() => window.__OMEGA__.profiler.emit());
      traces.push(trace);
      await page.waitForTimeout(500);
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
      version: 1,
      url,
      startedAt: new Date(t0).toISOString(),
      durationMs: DURATION_MS,
      warmupMs: WARMUP_MS,
      samples: traces,
      final,
      summary: summarize(traces),
    };

    await mkdir(dirname(OUT_PATH), { recursive: true });
    await writeFile(OUT_PATH, JSON.stringify(report, null, 2));
    log('wrote', OUT_PATH);
    log('summary:', JSON.stringify(report.summary));
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

main().catch((e) => die(e?.stack ?? String(e)));
