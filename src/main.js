// VOID SINGULARITY: OMEGA — boot entry.
// Responsibilities: detect GPU capability, create the renderer (WebGPU -> WebGL2 fallback),
// hand off to the engine loop. Real systems are layered in across SPRINT-00..09.

import { createRenderer, detectCapability } from './render/renderer.js';
import { Loop } from './engine/loop.js';
import { Input } from './engine/input.js';
import { World } from './game/world.js';
import { Profiler } from './engine/profiler.js';

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

  const loop = new Loop({
    update: (dt, t) => world.update(dt, t),
    render: (alpha) => {
      profiler.beginFrame();
      world.render(alpha);
      profiler.endFrame();
    },
  });
  profiler.loop = loop;

  // Reveal the stage once the first frame is ready.
  world.onFirstFrame(() => {
    bootEl.classList.add('hidden');
  });

  window.addEventListener('resize', () => world.resize(window.innerWidth, window.innerHeight));
  world.resize(window.innerWidth, window.innerHeight);

  // Expose for the perf harness + opus capture scripts.
  window.__OMEGA__ = { world, renderer, loop, cap, profiler };

  loop.start();
}

main().catch((e) => fatal('Boot exception: ' + (e?.stack ?? e)));
