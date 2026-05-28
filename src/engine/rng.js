// Deterministic seeded PRNG (mulberry32). Same seed + same input sequence
// reproduces an identical run — required for self-play replay and offline
// regression diffs.
//
// Usage:
//   const rng = new RNG(0xC0FFEE);
//   rng.float();        // [0,1)
//   rng.range(a, b);    // [a,b)
//   rng.int(n);         // [0,n) integer
//   rng.pick(arr);      // uniform element
//   rng.sign();         // -1 or +1
//   rng.fork('enemies'); // derive an independent stream by string label
//
// Streams: derive sub-RNGs for independent subsystems so adding a single
// random call in one system doesn't desync every other system downstream.

function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export class RNG {
  constructor(seed = 1) {
    this.seed = (seed >>> 0) || 1;
    this._state = this.seed;
  }

  // mulberry32 — fast, decent statistical quality, 32-bit state.
  float() {
    let t = (this._state = (this._state + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(a, b) { return a + (b - a) * this.float(); }
  int(n) { return Math.floor(this.float() * n); }
  sign() { return this.float() < 0.5 ? -1 : 1; }
  pick(arr) { return arr[this.int(arr.length)]; }
  bool(p = 0.5) { return this.float() < p; }

  /** Returns a child RNG derived from this seed + label (deterministic). */
  fork(label) {
    return new RNG((this.seed ^ hash32(String(label))) >>> 0);
  }

  /** Snapshot for replay diagnostics. */
  getState() { return this._state >>> 0; }
  setState(s) { this._state = (s >>> 0) || 1; }
}

/** Convenience: build a master RNG and pre-fork the common streams. */
export function createRngStreams(seed) {
  const master = new RNG(seed);
  return {
    master,
    spawn: master.fork('spawn'),
    ai: master.fork('ai'),
    fx: master.fork('fx'),
    loot: master.fork('loot'),
  };
}
