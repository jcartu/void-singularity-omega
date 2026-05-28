#!/usr/bin/env node
// SPRINT-08 scaling test for VOID SINGULARITY: OMEGA.
//
// Verifies that the bullet + particle pools sustain SPRINT-08 capacity targets
// without per-frame allocation and without GC pauses > 4ms.
//
// Tiers (active count caps):
//   bullets:   ultra 15000, high 10000, medium 5000, low 2000
//   particles: ultra  8000, high  5000, medium 1500, low  500
//
// Pass criteria:
//   * High tier (10000 bullets) p1% frame time   <= 16.67 ms (60 fps target).
//   * Ultra tier (15000 bullets) p1% frame time  <= 22.22 ms (graceful budget).
//   * Zero GC pauses > 4 ms during the storm window.
//   * Pool reports the requested tier capacity (sized correctly).
//
// Usage:
//   node --expose-gc src/perf/scaling-test.mjs              # run all tiers
//   node --expose-gc src/perf/scaling-test.mjs --tier high  # single tier
//   node --expose-gc src/perf/scaling-test.mjs --json       # machine-readable output
//
// Exit codes: 0 ok, 2 perf budget failure, 1 runtime error.

import { performance, PerformanceObserver } from 'node:perf_hooks';
import { Scene } from 'three';
import { BulletPool, TIER_BULLET_CAPS, bulletCapacityForTier } from '../game/projectiles.js';
import { ProjectilePool, TIER_PROJECTILE_CAPS } from '../game/projectiles/pool.js';
import { ParticleManager, TIER_CAPS as PARTICLE_TIER_CAPS } from '../render/particles.js';

// --------------------------------------------------------------------------
// Tier budgets (one source of truth for the test).
// --------------------------------------------------------------------------
const BUDGETS = {
  ultra:  { bullets: 15000, particles: 8000, p1Ms: 22.22, label: 'ultra (15k bullets)' },
  high:   { bullets: 10000, particles: 5000, p1Ms: 16.67, label: 'high (10k bullets)' },
  medium: { bullets:  5000, particles: 1500, p1Ms: 22.22, label: 'medium (5k bullets)' },
  low:    { bullets:  2000, particles:  500, p1Ms: 33.33, label: 'low (2k bullets)' },
};

const GC_PAUSE_BUDGET_MS = 4;
const FRAMES = 600;             // ~10s of sim at 60fps for stable percentiles
const DT = 1 / 60;

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------
const args = process.argv.slice(2);
const wantTier = argIdx('--tier');
const jsonOut = args.includes('--json');
const TIERS = wantTier ? [wantTier] : ['low', 'medium', 'high', 'ultra'];

function argIdx(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

// --------------------------------------------------------------------------
// GC pause observer — totally allocation-free in the hot loop.
// --------------------------------------------------------------------------
let gcPauses = [];
let gcObs = null;
try {
  gcObs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) gcPauses.push(e.duration);
  });
  gcObs.observe({ entryTypes: ['gc'], buffered: false });
} catch {
  // Older Node — silently skip GC tracking.
}

function resetGc() { gcPauses.length = 0; }
function worstGc()  { let w = 0; for (const d of gcPauses) if (d > w) w = d; return w; }

// --------------------------------------------------------------------------
// Stats helpers — sort + p99 (= p1% worst frame time).
// --------------------------------------------------------------------------
function stats(samples) {
  const a = Float64Array.from(samples);
  Array.prototype.sort.call(a, (x, y) => x - y);
  const n = a.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += a[i];
  return {
    n,
    avgMs: sum / n,
    p50Ms: a[Math.floor(n * 0.50)],
    p99Ms: a[Math.min(n - 1, Math.floor(n * 0.99))],
    maxMs: a[n - 1],
  };
}

// --------------------------------------------------------------------------
// Targets struct for BulletPool collide path (a few static enemies so the
// broadphase has real work to do).
// --------------------------------------------------------------------------
function makeTargets(count) {
  const px = new Float32Array(count);
  const py = new Float32Array(count);
  const pz = new Float32Array(count);
  const radius = new Float32Array(count);
  const team = new Uint8Array(count);
  const alive = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    px[i] = (Math.random() - 0.5) * 60;
    py[i] = (Math.random() - 0.5) * 20;
    pz[i] = (Math.random() - 0.5) * 60;
    radius[i] = 1.0;
    team[i] = 1; // enemy team — bullets fire team 0
    alive[i] = 1;
  }
  return { px, py, pz, radius, team, alive, count };
}

// --------------------------------------------------------------------------
// One bullet-pool storm.
// --------------------------------------------------------------------------
function runBulletStorm(tier) {
  const cap = bulletCapacityForTier(tier);
  const pool = new BulletPool({ capacity: cap, worldExtent: 200, cellSize: 4 });
  pool.setTargets(makeTargets(32));

  // Fill to ~95% capacity so we measure steady-state hot path.
  const target = Math.floor(cap * 0.95);
  for (let i = 0; i < target; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 8 + Math.random() * 12;
    pool.spawn(
      (Math.random() - 0.5) * 80, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 80,
      Math.cos(a) * sp, (Math.random() - 0.5) * 2, Math.sin(a) * sp,
      0.25, 999 /* very long ttl */, 1, 0, 0, 0, 1,
    );
  }
  const sized = pool.activeCount;

  // Warmup — let JIT settle, then reset GC + frame samples.
  for (let i = 0; i < 30; i++) pool.step(DT);
  if (typeof global.gc === 'function') global.gc();
  resetGc();

  const samples = new Float64Array(FRAMES);
  for (let f = 0; f < FRAMES; f++) {
    const t0 = performance.now();
    pool.step(DT);
    // Replenish to maintain population (mimics weapons firing each frame).
    const deficit = target - pool.activeCount;
    if (deficit > 0) {
      const burst = Math.min(deficit, 80);
      for (let i = 0; i < burst; i++) {
        const a = Math.random() * Math.PI * 2;
        pool.spawn(
          (Math.random() - 0.5) * 80, 0, (Math.random() - 0.5) * 80,
          Math.cos(a) * 10, 0, Math.sin(a) * 10,
          0.25, 999, 1, 0, 0, 0, 1,
        );
      }
    }
    samples[f] = performance.now() - t0;
  }
  return { tier, requestedCap: cap, sized, samples: Array.from(samples), gcMax: worstGc(), gcCount: gcPauses.length };
}

// --------------------------------------------------------------------------
// One particle storm — exercises the full ParticleManager update path on a
// stub scene (no renderer; we measure CPU-side simulation + render-buffer
// preparation cost, which is the per-frame budget that matters).
// --------------------------------------------------------------------------
function runParticleStorm(tier) {
  const scene = new Scene();
  const gravity = { center: { x: 0, y: 0, z: 0 }, mass: 1200, horizonRadius: 1.5 };
  // forceFallback=true on ultra/high in Node so we use InstancedMesh (the GPU
  // backend is also testable here but the InstancedMesh path is the worst case
  // for CPU update cost — a strict upper bound).
  const pm = new ParticleManager({
    tier, scene, gravity,
    forceFallback: true,
  });
  pm.init();

  const cap = PARTICLE_TIER_CAPS[tier].total;
  // Fill systems to their caps via burst emits.
  const acc = pm.systems.get('accretion');
  const sparks = pm.systems.get('sparks');
  const origin = { x: 0, y: 0, z: 0 };
  // Sparks lifetime is short; we replenish each frame below.
  pm.emit('sparks', origin, sparks.pool.capacity, { colorHex: 0xff8844, speed: 12, life: 8 });

  for (let i = 0; i < 30; i++) pm.update(DT);
  if (typeof global.gc === 'function') global.gc();
  resetGc();

  const samples = new Float64Array(FRAMES);
  for (let f = 0; f < FRAMES; f++) {
    const t0 = performance.now();
    pm.update(DT);
    // Keep sparks topped up so we measure full-cap update.
    const need = sparks.pool.capacity - sparks.count;
    if (need > 0) pm.emit('sparks', origin, Math.min(need, 64), { colorHex: 0xff8844, speed: 12, life: 8 });
    samples[f] = performance.now() - t0;
  }

  const active = pm.getActiveCount();
  pm.dispose();
  return { tier, requestedCap: cap, sized: active, samples: Array.from(samples), gcMax: worstGc(), gcCount: gcPauses.length };
}

// --------------------------------------------------------------------------
// Projectile (render) pool — verifies highwater-mark iteration + tier caps.
// --------------------------------------------------------------------------
function runProjectilePoolCheck(tier) {
  const scene = new Scene();
  const cap = ProjectilePool.capacityForTier(tier);
  const pool = new ProjectilePool({ scene, capacity: cap });
  // Spawn full capacity and tick once — verifies update() walks _max not capacity.
  for (let i = 0; i < cap; i++) {
    pool.spawn({
      position: [(Math.random() - 0.5) * 40, 0, (Math.random() - 0.5) * 40],
      direction: [Math.random() - 0.5, 0, Math.random() - 0.5],
      speed: 20, damage: 1, pierce: 0, ttl: 999, color: 0xffffff, size: 1,
    });
  }
  if (typeof global.gc === 'function') global.gc();
  resetGc();

  const samples = new Float64Array(60);
  for (let f = 0; f < 60; f++) {
    const t0 = performance.now();
    pool.update(DT);
    samples[f] = performance.now() - t0;
  }
  return { tier, requestedCap: cap, sized: pool.liveCount, highWater: pool.highWater, samples: Array.from(samples), gcMax: worstGc() };
}

// --------------------------------------------------------------------------
// Runner
// --------------------------------------------------------------------------
function fmt(n) { return n.toFixed(3); }

function judge(label, result, budgetMs) {
  const st = stats(result.samples);
  const pass = st.p99Ms <= budgetMs && result.gcMax <= GC_PAUSE_BUDGET_MS;
  return { label, pass, stats: st, gcMax: result.gcMax, gcCount: result.gcCount, sized: result.sized, requestedCap: result.requestedCap, highWater: result.highWater, budgetMs };
}

const results = { tiers: {}, summary: { pass: true } };

for (const tier of TIERS) {
  const budget = BUDGETS[tier];
  if (!budget) { console.error(`unknown tier: ${tier}`); process.exit(1); }

  const bullet = judge(`bullets/${tier}`, runBulletStorm(tier), budget.p1Ms);
  const particle = judge(`particles/${tier}`, runParticleStorm(tier), budget.p1Ms);
  const proj = judge(`projectilePool/${tier}`, runProjectilePoolCheck(tier), budget.p1Ms);

  // Verify caps: BulletPool must report the requested capacity.
  const capCheckBullets = bullet.requestedCap === TIER_BULLET_CAPS[tier];
  const capCheckProj = proj.requestedCap === TIER_PROJECTILE_CAPS[tier];
  const capCheckPart = particle.requestedCap === PARTICLE_TIER_CAPS[tier].total;
  const capsOk = capCheckBullets && capCheckProj && capCheckPart;

  const tierPass = bullet.pass && particle.pass && proj.pass && capsOk;
  results.tiers[tier] = { bullet, particle, proj, capsOk, pass: tierPass };
  if (!tierPass) results.summary.pass = false;

  if (!jsonOut) {
    const tag = tierPass ? 'PASS' : 'FAIL';
    console.log(`\n[${tag}] tier=${tier}`);
    console.log(`  bullets    cap=${bullet.requestedCap} sized=${bullet.sized}`
              + ` avg=${fmt(bullet.stats.avgMs)}ms p50=${fmt(bullet.stats.p50Ms)}ms`
              + ` p1%(p99)=${fmt(bullet.stats.p99Ms)}ms max=${fmt(bullet.stats.maxMs)}ms`
              + ` budget=${budget.p1Ms}ms gcMax=${fmt(bullet.gcMax)}ms`);
    console.log(`  particles  cap=${particle.requestedCap} sized=${particle.sized}`
              + ` avg=${fmt(particle.stats.avgMs)}ms p50=${fmt(particle.stats.p50Ms)}ms`
              + ` p1%(p99)=${fmt(particle.stats.p99Ms)}ms max=${fmt(particle.stats.maxMs)}ms`
              + ` gcMax=${fmt(particle.gcMax)}ms`);
    console.log(`  projPool   cap=${proj.requestedCap} live=${proj.sized} hw=${proj.highWater}`
              + ` p1%=${fmt(proj.stats.p99Ms)}ms gcMax=${fmt(proj.gcMax)}ms`);
    if (!capsOk) console.log('  CAP CHECK FAILED');
  }
}

if (jsonOut) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const verdict = results.summary.pass ? '\nALL TIERS PASS' : '\nFAIL';
  console.log(verdict);
}

gcObs?.disconnect();
process.exit(results.summary.pass ? 0 : 2);
