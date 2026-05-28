#!/usr/bin/env node
// SPRINT-09 — Production dist verifier.
//
// Spins a vanilla static HTTP server over the on-disk `dist/` folder, then:
//   1. Smoke-tests the page in headless Chromium (boot + profiler wired up).
//   2. Runs the existing perf harness against that same URL.
//   3. Measures dist/ bundle size (raw + gzipped) and checks the 25 MB budget.
//   4. Writes artifacts/verify-dist.json and prints a verdict.
//
// Usage:
//   node scripts/verify-dist.mjs                     # full verify
//   node scripts/verify-dist.mjs --no-perf           # skip perf phase
//   node scripts/verify-dist.mjs --budget-mb 25      # override gzipped budget
//   node scripts/verify-dist.mjs --port 4173         # override port
//
// Exit codes:
//   0  all phases pass
//   1  smoke / runtime failure
//   2  bundle budget breach
//   3  perf harness reported a breach

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readdir, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve, join, extname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIST = resolve(ROOT, 'dist');
const ARTIFACTS = resolve(ROOT, 'artifacts');

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port ?? 0); // 0 = pick a free port
const RUN_PERF = args['no-perf'] !== true;
const BUDGET_MB = Number(args['budget-mb'] ?? 25);
const SMOKE_TIMEOUT_MS = Number(args['smoke-timeout'] ?? 20_000);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[k] = true;
    else { out[k] = next; i++; }
  }
  return out;
}

const log  = (...m) => console.log('[verify]', ...m);
const warn = (...m) => console.warn('[verify]', ...m);
const fail = (msg, code = 1) => { console.error('[verify:FATAL]', msg); process.exit(code); };

// ---------------------------------------------------------------------------
// Static file server. Minimal — no directory listing, no caching, no range.
// Sourcemaps are ignored entirely (don't ship to a real prod box, anyway).
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map':  'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.glb':  'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ktx2': 'image/ktx2',
  '.hdr':  'application/octet-stream',
  '.bin':  'application/octet-stream',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
  '.woff': 'font/woff',
  '.ttf':  'font/ttf',
};

function startServer(root, port) {
  return new Promise((resolveP, rejectP) => {
    const server = createServer(async (req, res) => {
      try {
        let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
        const filePath = resolve(root, '.' + urlPath);
        // path-traversal guard
        if (!filePath.startsWith(root + sep) && filePath !== root) {
          res.writeHead(403); res.end('forbidden'); return;
        }
        if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
          // SPA-ish: any 404 falls back to index.html if it exists.
          const indexPath = resolve(root, 'index.html');
          if (existsSync(indexPath)) {
            const body = await readFile(indexPath);
            res.writeHead(200, {
              'content-type': MIME['.html'],
              'cache-control': 'no-store',
              'cross-origin-opener-policy': 'same-origin',
              'cross-origin-embedder-policy': 'require-corp',
            });
            res.end(body);
            return;
          }
          res.writeHead(404); res.end('not found'); return;
        }
        const body = await readFile(filePath);
        const ext = extname(filePath).toLowerCase();
        const headers = {
          'content-type': MIME[ext] ?? 'application/octet-stream',
          'cache-control': 'no-store',
        };
        // WebGPU + SharedArrayBuffer benefit from cross-origin isolation.
        if (ext === '.html') {
          headers['cross-origin-opener-policy'] = 'same-origin';
          headers['cross-origin-embedder-policy'] = 'require-corp';
        }
        res.writeHead(200, headers);
        res.end(body);
      } catch (err) {
        warn('server error:', err?.message ?? err);
        try { res.writeHead(500); res.end('server error'); } catch {}
      }
    });
    server.on('error', rejectP);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      resolveP({ server, url: `http://127.0.0.1:${actual}` });
    });
  });
}

// ---------------------------------------------------------------------------
// Bundle-size measurement.
// ---------------------------------------------------------------------------
async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(p));
    else out.push(p);
  }
  return out;
}

async function measureBundle(distDir) {
  if (!existsSync(distDir)) fail(`dist/ not found at ${distDir} — run \`npx vite build\` first`);
  const files = await walk(distDir);
  // Exclude sourcemaps from "ship" measurement, but still account for them.
  const ship  = files.filter((f) => !f.endsWith('.map'));
  const maps  = files.filter((f) => f.endsWith('.map'));

  let rawShip = 0, gzShip = 0, rawMaps = 0;
  const byExt = {};
  const largest = [];
  for (const f of ship) {
    const buf = await readFile(f);
    const gz = gzipSync(buf, { level: 9 }).length;
    rawShip += buf.length;
    gzShip  += gz;
    const ext = extname(f) || '<noext>';
    byExt[ext] ??= { count: 0, raw: 0, gz: 0 };
    byExt[ext].count++; byExt[ext].raw += buf.length; byExt[ext].gz += gz;
    largest.push({ path: relative(distDir, f), raw: buf.length, gz });
  }
  for (const f of maps) rawMaps += (await stat(f)).size;
  largest.sort((a, b) => b.gz - a.gz);

  return {
    files: ship.length,
    sourcemaps: maps.length,
    rawBytes: rawShip,
    gzipBytes: gzShip,
    rawMaps,
    rawMB: round(rawShip / 1e6, 3),
    gzipMB: round(gzShip / 1e6, 3),
    byExt: Object.fromEntries(
      Object.entries(byExt).map(([k, v]) => [k, { count: v.count, rawMB: round(v.raw / 1e6, 3), gzipMB: round(v.gz / 1e6, 3) }]),
    ),
    largest: largest.slice(0, 10).map((x) => ({ path: x.path, rawKB: round(x.raw / 1024, 1), gzKB: round(x.gz / 1024, 1) })),
  };
}

function round(v, p) { const m = 10 ** p; return Math.round(v * m) / m; }

// ---------------------------------------------------------------------------
// Smoke test: boot the page, wait for __OMEGA__ wiring, sanity-check renderer.
// ---------------------------------------------------------------------------
async function smokeTest(url) {
  log('smoke: launching headless chromium');
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--enable-precise-memory-info'],
  });
  const errors = [];
  const consoleErrors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { errors.push(String(e?.message ?? e)); });
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

    log('smoke: navigating to', url);
    await page.goto(url, { waitUntil: 'load', timeout: SMOKE_TIMEOUT_MS });

    // Did boot wire __OMEGA__?
    await page.waitForFunction(
      () => !!(window.__OMEGA__ && window.__OMEGA__.profiler && window.__OMEGA__.loop),
      null,
      { timeout: SMOKE_TIMEOUT_MS },
    );

    // Did the fatal overlay get displayed? (capability detection failure)
    const fatalText = await page.evaluate(() => {
      const el = document.getElementById('fatal');
      return el && el.classList.contains('show') ? el.textContent : null;
    });
    if (fatalText) throw new Error('fatal overlay shown: ' + fatalText);

    // Run a couple of frames so renderer hits at least one draw.
    await page.waitForTimeout(1500);

    const probe = await page.evaluate(() => {
      const om = window.__OMEGA__;
      const t = om?.profiler?.emit?.();
      return {
        hasLoop: !!om?.loop,
        hasProfiler: !!om?.profiler,
        hasRenderer: !!om?.renderer,
        cap: om?.cap ?? null,
        running: !!om?.loop?.running,
        traceSchema: t?.schema ?? null,
        fps: t?.metrics?.fps ?? null,
        drawCalls: t?.metrics?.drawCalls ?? null,
        frame: t?.metrics?.frame ?? null,
      };
    });

    log('smoke: probe =', JSON.stringify(probe));

    const failures = [];
    if (!probe.hasLoop) failures.push('loop missing');
    if (!probe.hasProfiler) failures.push('profiler missing');
    if (probe.traceSchema !== 'omega.profiler.trace') failures.push('profiler emit schema invalid');
    // Filter benign WebGPU teardown / driver warnings that headless Chromium routes through pageerror.
    const benign = /Instance dropped|popErrorScope|GPUDevice.*destroyed|WebGPU.*shutdown|adapter.*destroyed/i;
    const realErrors = errors.filter((e) => !benign.test(e));
    if (realErrors.length) failures.push(`pageerror x${realErrors.length}: ${realErrors[0]}`);

    return {
      ok: failures.length === 0,
      failures,
      probe,
      pageErrors: errors,
      consoleErrors: consoleErrors.slice(0, 10),
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Perf harness re-use.
// ---------------------------------------------------------------------------
function runPerfHarness(url) {
  return new Promise((resolveP) => {
    const outPath = resolve(ARTIFACTS, 'perf-verify-dist.json');
    log('perf: invoking perf-harness against dist URL');
    const p = spawn(
      'node',
      ['scripts/perf-harness.mjs', '--url', url, '--duration', '4000', '--warmup', '1500', '--out', outPath],
      { cwd: ROOT, stdio: 'inherit' },
    );
    p.on('exit', async (code) => {
      let report = null;
      try { report = JSON.parse(await readFile(outPath, 'utf8')); } catch {}
      resolveP({ exitCode: code, outPath, report });
    });
    p.on('error', (e) => resolveP({ exitCode: 1, error: String(e?.message ?? e) }));
  });
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
async function main() {
  await mkdir(ARTIFACTS, { recursive: true });

  // 1. Bundle size first — fast, gives immediate feedback even if smoke fails.
  log('measuring dist/ bundle size');
  const bundle = await measureBundle(DIST);
  log(`bundle: ${bundle.files} files, raw=${bundle.rawMB}MB gzip=${bundle.gzipMB}MB (budget ${BUDGET_MB}MB gzipped)`);
  log('top files by gzip size:');
  for (const f of bundle.largest.slice(0, 5)) log(`  - ${f.path}  ${f.gzKB}KB gz  (${f.rawKB}KB raw)`);
  const bundleOK = bundle.gzipMB <= BUDGET_MB;
  if (!bundleOK) warn(`BUDGET BREACH: ${bundle.gzipMB}MB > ${BUDGET_MB}MB`);

  // 2. Static server.
  log('starting static server on dist/');
  const { server, url } = await startServer(DIST, PORT);
  log('serving', url);

  let smoke, perf = null;
  try {
    smoke = await smokeTest(url);
    log('smoke verdict:', smoke.ok ? 'PASS' : 'FAIL');

    if (RUN_PERF && smoke.ok) {
      perf = await runPerfHarness(url);
      log('perf verdict: exit=' + perf.exitCode);
    }
  } finally {
    await new Promise((r) => server.close(() => r()));
  }

  // 3. Aggregate.
  const verifyReport = {
    schema: 'omega.verify-dist.report',
    version: 1,
    timestamp: new Date().toISOString(),
    distPath: DIST,
    budgetGzipMB: BUDGET_MB,
    bundle,
    smoke,
    perf: perf
      ? { exitCode: perf.exitCode, summary: perf.report?.summary ?? null, stormVerdict: perf.report?.storm?.verdict ?? null }
      : null,
    verdict: 'pending',
  };

  let exitCode = 0;
  const reasons = [];
  if (!bundleOK) { exitCode = 2; reasons.push(`bundle ${bundle.gzipMB}MB > ${BUDGET_MB}MB`); }
  if (!smoke.ok) { exitCode = 1; reasons.push(`smoke failed: ${smoke.failures.join('; ')}`); }
  if (perf && perf.exitCode !== 0) {
    if (exitCode === 0) exitCode = 3;
    reasons.push(`perf harness exit ${perf.exitCode}`);
  }
  verifyReport.verdict = exitCode === 0 ? 'pass' : `fail:${reasons.join(' | ')}`;

  const reportPath = resolve(ARTIFACTS, 'verify-dist.json');
  await writeFile(reportPath, JSON.stringify(verifyReport, null, 2));
  log('wrote', reportPath);

  console.log('\n=========================================================');
  console.log('  VERIFY-DIST VERDICT:', verifyReport.verdict.toUpperCase());
  console.log('=========================================================');
  console.log(`  bundle (gz)   : ${bundle.gzipMB} MB / ${BUDGET_MB} MB   ${bundleOK ? 'OK' : 'BREACH'}`);
  console.log(`  bundle (raw)  : ${bundle.rawMB} MB`);
  console.log(`  smoke         : ${smoke.ok ? 'PASS' : 'FAIL'}`);
  if (perf) console.log(`  perf harness  : exit ${perf.exitCode}`);
  console.log('=========================================================\n');

  process.exit(exitCode);
}

main().catch((e) => fail(e?.stack ?? String(e)));
