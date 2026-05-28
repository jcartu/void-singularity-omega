// VOID SINGULARITY: OMEGA — boot entry.
// Responsibilities: detect GPU capability, create the renderer (WebGPU -> WebGL2 fallback),
// hand off to the engine loop. Real systems are layered in across SPRINT-00..09.

import { createRenderer, detectCapability } from './render/renderer.js';
import { Loop } from './engine/loop.js';
import { Input } from './engine/input.js';
import { World } from './game/world.js';
import { Profiler } from './engine/profiler.js';
import { runStorm } from './scenarios/storm.js';
import { PerfGate } from './render/perf-gate.js';
import { BudgetManager } from './render/budget.js';
import { AudioCore } from './audio/audio.js';
import { HitchPrevention } from './engine/hitch-prevention.js';

const bootEl = document.getElementById('boot');
const fatalEl = document.getElementById('fatal');
const canvas = document.getElementById('stage');

function fatal(msg) {
  fatalEl.textContent = msg;
  fatalEl.classList.add('show');
  bootEl.classList.add('hidden');
  console.error('[OMEGA:FATAL]', msg);
}

async function main() {
  const cap = await detectCapability();
  // Perf-matrix override: ?webgl2=1 forces the WebGL2 fallback path so the
  // matrix harness can validate the fallback even on WebGPU-capable hardware.
  try {
    const qs = new URLSearchParams(globalThis.location?.search ?? '');
    if (qs.get('webgl2') === '1') {
      cap.webgpu = false;
      cap.hdr = false;
      cap.tier = cap.webgl2 ? 'medium' : 'low';
      console.info('[OMEGA] forced WebGL2 path via ?webgl2=1');
    }
  } catch { /* non-browser */ }
  console.info('[OMEGA] capability:', cap);

  if (!cap.webgpu && !cap.webgl2) {
    return fatal('No supported GPU backend. This game requires WebGPU (preferred) or WebGL2.');
  }

  let renderer;
  try {
    renderer = await createRenderer(canvas, cap);
  } catch (err) {
    return fatal('Renderer init failed: ' + (err?.message ?? err));
  }

  const input = new Input(canvas);
  const world = new World({ renderer, input, cap });
  await world.init();

  const profiler = new Profiler({ renderer, sampleSize: 600 });

  let _lastFrameT = 0;
  const loop = new Loop({
    update: (dt, t) => world.update(dt, t),
    render: (alpha) => {
      profiler.beginFrame();
      world.render(alpha);
      profiler.endFrame();
      // Frame-time monitor: wall-clock delta between consecutive render calls.
      const h = world.hitch;
      if (h) {
        const now = performance.now();
        if (_lastFrameT > 0) h.update((now - _lastFrameT) / 1000);
        _lastFrameT = now;
      }
    },
  });
  profiler.loop = loop;
    world.hud.profiler = profiler;

  // Reveal the stage once the first frame is ready.
  world.onFirstFrame(() => {
    bootEl.classList.add('hidden');
  });

  window.addEventListener('resize', () => world.resize(window.innerWidth, window.innerHeight));
  world.resize(window.innerWidth, window.innerHeight);

  // Expose for the perf harness + opus capture scripts.
  // PerfGate: per-node post-FX timing + tier-budget enforcement (SPRINT-04).
  const perfGate = new PerfGate({ postfx: world.fx, profiler, tier: cap.tier ?? 'high' });
  world.perfGate = perfGate;

  // BudgetManager: per-system frame-time + auto-tiering with hysteresis (SPRINT-08).
  const budget = new BudgetManager({
    profiler,
    postfx: world.fx,
    bus: world.bus,
    tier: cap.tier ?? 'high',
  });
  world.budget = budget;
  if (world.hud) world.hud.budget = budget;
  // Keep PerfGate.tier in sync with auto-tier transitions so the node-drop
  // budget matches the active tier.
  const PERFGATE_TIER_MS = { ultra: 8, high: 10, medium: 6, low: 3 };
  world.bus?.on?.('tier:change', (info) => {
    if (perfGate && info?.to) {
      perfGate.tier = info.to;
      perfGate.budgetMs = PERFGATE_TIER_MS[info.to] ?? perfGate.budgetMs;
    }
  });

  // Audio: single context, started on first user gesture (autoplay-policy safe).
  // Audio: single context, started on first user gesture (autoplay-policy safe).
  const audio = new AudioCore({ bus: world.bus });
  audio.armGestureStart(window);

  // Hitch prevention: shader pre-warm + biome preload + frame-time monitoring (SPRINT-08).
  const hitch = new HitchPrevention({ verbose: false });
  try {
    hitch.mark('prewarm');
    await hitch.prewarmShaders({ renderer, postfx: world.fx, scene: world.scene, camera: world.camera });
    hitch.measure('prewarm');
  } catch (e) {
    console.warn('[OMEGA] prewarm failed (continuing):', e?.message ?? e);
  }
  // Kick off preload of the next biome after the current one resolves.
  try {
    const curId = world.biomeSkins?.getCurrentId?.() ?? null;
    hitch.preloadNextBiome(curId, { biomeSkins: world.biomeSkins });
  } catch { /* non-fatal */ }
  // Preload subsequent biomes whenever the current one completes.
  try {
    world.bus?.on?.('biome:complete', (p) => {
      const id = p?.biomeId ?? world.biomeSkins?.getCurrentId?.() ?? null;
      hitch.preloadNextBiome(id, { biomeSkins: world.biomeSkins });
    });
  } catch { /* non-fatal */ }
  // Audit any heavy initialization we recorded above.
  hitch.auditInit();
  world.hitch = hitch;

  // Expose for the perf harness + opus capture scripts.
  window.__OMEGA__ = { world, renderer, loop, cap, profiler, perfGate, budget, audio, hitch, scenarios: { runStorm } };

  loop.start();
}

main().catch((e) => fatal('Boot exception: ' + (e?.stack ?? e)));
