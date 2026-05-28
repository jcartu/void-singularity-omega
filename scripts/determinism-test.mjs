// WO-02-G6 — Determinism test.
//
// Verifies that the seeded PRNG produces identical sequences for the same
// seed across independent runs, and that forked streams stay independent.
// Run: `node scripts/determinism-test.mjs`

import { RNG, createRngStreams } from '../src/engine/rng.js';
import { EventBus, EVENTS } from '../src/engine/events.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; }
  else       { console.log ('ok  :', msg); }
}

// --- 1. Same seed -> identical float sequence -----------------------------
{
  const a = new RNG(0xC0FFEE);
  const b = new RNG(0xC0FFEE);
  const seqA = Array.from({ length: 1000 }, () => a.float());
  const seqB = Array.from({ length: 1000 }, () => b.float());
  assert(JSON.stringify(seqA) === JSON.stringify(seqB),
    'same-seed RNGs produce identical 1000-element float sequences');
}

// --- 2. Different seeds -> different sequences ----------------------------
{
  const a = new RNG(1);
  const b = new RNG(2);
  let same = 0;
  for (let i = 0; i < 100; i++) if (a.float() === b.float()) same++;
  assert(same < 5, 'different-seed RNGs diverge (got '+same+' overlaps)');
}

// --- 3. Forked streams are deterministic & independent --------------------
{
  const s1 = createRngStreams(42);
  const s2 = createRngStreams(42);
  const spawnsA = Array.from({ length: 50 }, () => s1.spawn.float());
  const spawnsB = Array.from({ length: 50 }, () => s2.spawn.float());
  assert(JSON.stringify(spawnsA) === JSON.stringify(spawnsB),
    'forked spawn stream identical across runs (same seed)');

  // Mutating the ai stream in one run must NOT desync the spawn stream.
  const s3 = createRngStreams(42);
  for (let i = 0; i < 100; i++) s3.ai.float();
  const spawnsC = Array.from({ length: 50 }, () => s3.spawn.float());
  assert(JSON.stringify(spawnsA) === JSON.stringify(spawnsC),
    'spawn stream unaffected by unrelated ai-stream consumption');
}

// --- 4. Simulated mini-run: identical seed + identical inputs = identical trace
{
  function runSim(seed, inputs) {
    const rng = new RNG(seed);
    const trace = [];
    let x = 0, y = 0, hp = 100;
    for (const cmd of inputs) {
      if (cmd === 'spawn')  trace.push(['spawn', rng.range(-10, 10), rng.range(-10, 10)]);
      else if (cmd === 'hit') { hp -= Math.floor(rng.range(5, 15)); trace.push(['hit', hp]); }
      else if (cmd === 'move') { x += rng.sign(); y += rng.sign(); trace.push(['move', x, y]); }
    }
    return { trace, finalHp: hp, finalX: x, finalY: y };
  }
  const inputs = ['spawn', 'move', 'hit', 'spawn', 'move', 'move', 'hit', 'spawn'];
  const a = runSim(0xDEADBEEF, inputs);
  const b = runSim(0xDEADBEEF, inputs);
  assert(JSON.stringify(a) === JSON.stringify(b),
    'mini sim: same seed + inputs -> identical trace');
  const c = runSim(0xCAFEBABE, inputs);
  assert(JSON.stringify(a) !== JSON.stringify(c),
    'mini sim: different seed -> different trace');
}

// --- 5. Event bus typed signals decouple producer/consumer ----------------
{
  const bus = new EventBus();
  const got = [];
  bus.on(EVENTS.ENEMY_KILLED,   (p) => got.push(['killed', p.id]));
  bus.on(EVENTS.BOSS_PHASE,     (p) => got.push(['phase',  p.phase]));
  bus.on(EVENTS.PLAYER_HIT,     (p) => got.push(['phit',   p.dmg]));
  bus.on(EVENTS.UPGRADE_PICKED, (p) => got.push(['upg',    p.kind]));

  bus.emit(EVENTS.ENEMY_KILLED,   { id: 7 });
  bus.emit(EVENTS.BOSS_PHASE,     { phase: 2 });
  bus.emit(EVENTS.PLAYER_HIT,     { dmg: 10 });
  bus.emit(EVENTS.UPGRADE_PICKED, { kind: 'plasma' });

  assert(JSON.stringify(got) === JSON.stringify([
    ['killed', 7], ['phase', 2], ['phit', 10], ['upg', 'plasma'],
  ]), 'typed bus dispatches the four core events in order');
}

// --- 6. Dev mode rejects unknown events -----------------------------------
{
  const bus = new EventBus({ dev: true });
  let threw = false;
  try { bus.on('totally:fake', () => {}); } catch { threw = true; }
  assert(threw, 'dev bus throws on unknown event name');
}

if (failures) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
} else {
  console.log('\nAll determinism + event-bus tests passed.');
}
