// WO-02-P1 — Storm scenario.
//
// Drives the BulletPool simulation at "storm density" (10k+ live bullets vs
// dozens-hundreds of targets) to surface per-phase bottlenecks. Runs entirely
// headless — no scene mutation, no renderer pressure — so the numbers report
// pure simulation cost (integration, broadphase grid build, collision).
//
// Exposed on window.__OMEGA__.scenarios.runStorm({...}) for the perf harness.

import { BulletPool, TEAM_PLAYER, TEAM_ENEMY } from '../game/projectiles.js';
import { GravityWell } from '../game/gravity.js';
import { EventBus } from '../engine/events.js';
import { RNG } from '../engine/rng.js';

const DEFAULTS = {
  bullets: 10000,
  enemies: 120,
  durationMs: 4000,
  worldExtent: 80,
  cellSize: 3,
  bulletSpeed: 28,
  bulletTTL: 12,
};

let _rng = null;
function rand(min, max) {
  const r = _rng ? _rng.float() : Math.random();
  return min + r * (max - min);
}
function unitDir() {
  const r = _rng ? _rng.float() : Math.random();
  const t = r * Math.PI * 2;
  return [Math.cos(t), 0, Math.sin(t)];
}

function buildTargets(n, extent) {
  const t = {
    px: new Float32Array(n),
    py: new Float32Array(n),
    pz: new Float32Array(n),
    radius: new Float32Array(n),
    team: new Uint8Array(n),
    alive: new Uint8Array(n),
    count: n,
  };
  for (let k = 0; k < n; k++) {
    t.px[k] = rand(-extent * 0.7, extent * 0.7);
    t.py[k] = 0;
    t.pz[k] = rand(-extent * 0.7, extent * 0.7);
    t.radius[k] = rand(0.8, 1.8);
    t.team[k] = TEAM_ENEMY;
    t.alive[k] = 1;
  }
  return t;
}

function refill(pool, target, extent, speed, ttl) {
  // Spawn until pool is saturated to target population.
  while (pool.count < target) {
    const x = rand(-extent * 0.9, extent * 0.9);
    const z = rand(-extent * 0.9, extent * 0.9);
    const d = unitDir();
    const id = pool.spawn(
      x, 0, z,
      d[0] * speed, 0, d[2] * speed,
      0.25, ttl, 10, 0, TEAM_PLAYER, 0, 1,
    );
    if (id < 0) break;
  }
}

function stats(arr) {
  if (!arr.length) return { avg: 0, p50: 0, p99: 0, max: 0, n: 0 };
  const sorted = Float64Array.from(arr).sort();
  const n = sorted.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += sorted[i];
  return {
    n,
    avg: sum / n,
    p50: sorted[Math.floor(n * 0.5)],
    p99: sorted[Math.min(n - 1, Math.floor(n * 0.99))],
    max: sorted[n - 1],
  };
}

/**
 * Run a storm scenario for a fixed wall-clock window. Resolves with a JSON
 * trace of per-phase timings.
 *
 * @param {Partial<typeof DEFAULTS>} opts
 */
export async function runStorm(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  _rng = (opts.seed != null) ? new RNG(opts.seed) : null;

  // Disable gravity inside this isolated pool — the world's gravity well is a
  // global singleton we don't want to recurve mid-test. Pass an inert well.
  const gravity = new GravityWell({ mass: 0 });
  const events = new EventBus();
  // Sink event traffic into counters so we exercise the dispatch path but
  // don't pay for listener work.
  let hitCount = 0;
  let despawnCount = 0;
  events.on?.('bullet:hit', () => { hitCount++; });
  events.on?.('bullet:despawn', () => { despawnCount++; });

  const pool = new BulletPool({
    capacity: Math.max(1024, cfg.bullets + 2048),
    worldExtent: cfg.worldExtent,
    cellSize: cfg.cellSize,
    gravity,
    events,
  });
  const targets = buildTargets(cfg.enemies, cfg.worldExtent);
  pool.setTargets(targets);

  const integrate = [];
  const grid = [];
  const collide = [];
  const total = [];
  const liveCounts = [];

  const fixedDt = 1 / 120;
  const start = performance.now();
  let frames = 0;

  // Drive frames via rAF to coexist with the live render loop. Each rAF tick
  // we do one fixed-step sim slice — enough work to push the harness, while
  // letting the main game loop continue to drive renderer.info counters.
  await new Promise((resolve) => {
    function tick() {
      if (performance.now() - start >= cfg.durationMs) {
        resolve();
        return;
      }
      refill(pool, cfg.bullets, cfg.worldExtent, cfg.bulletSpeed, cfg.bulletTTL);

      const t0 = performance.now();
      pool._integrate(fixedDt);
      const t1 = performance.now();
      pool._buildGrid();
      const t2 = performance.now();
      pool._collide();
      const t3 = performance.now();
      pool._compactHighWater();
      const t4 = performance.now();

      integrate.push(t1 - t0);
      grid.push(t2 - t1);
      collide.push(t3 - t2);
      total.push(t4 - t0);
      liveCounts.push(pool.count);

      // Periodically resurrect dead targets so collisions keep firing.
      if ((frames & 31) === 0) {
        for (let k = 0; k < targets.count; k++) targets.alive[k] = 1;
      }
      frames++;
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });

  // Tear down the renderer-less pool so we don't leak typed arrays.
  pool.clear();

  return {
    schema: 'omega.scenario.storm',
    config: cfg,
    frames,
    bulletsAvg: liveCounts.length ? liveCounts.reduce((s, v) => s + v, 0) / liveCounts.length : 0,
    bulletsPeak: liveCounts.length ? Math.max(...liveCounts) : 0,
    hits: hitCount,
    despawns: despawnCount,
    phases: {
      integrate: stats(integrate),
      grid: stats(grid),
      collide: stats(collide),
      total: stats(total),
    },
  };
}

export default runStorm;
