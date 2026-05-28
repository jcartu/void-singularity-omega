// Daily seed mode — WO-07-C3.
//
// Produces a deterministic 32-bit seed from the current UTC date so every
// player on the same calendar day plays from the same seed. Personal best
// score is tracked in the injected `save` adapter (default: localStorage),
// keyed by the UTC date string so yesterday's score doesn't bleed forward.
//
// Pure / headless: no UI, no audio, no global state beyond the optional
// save adapter. RunStateMachine consumers call `getDailySeed()` and pass
// the result to `startRun(shipType, seed)` to enter daily mode.

const STORAGE_KEY = 'omega_daily_v1';

/** Current UTC date as `YYYY-MM-DD`. Stable for 24h regardless of locale. */
export function todayUTC(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * FNV-1a 32-bit hash. Deterministic across V8 / SpiderMonkey / JSC. We avoid
 * Math.random / crypto entirely so the seed is reproducible from the date
 * string alone — required for "same seed for every player".
 */
export function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // Mul by FNV prime 16777619; force to u32 via Math.imul.
    h = Math.imul(h, 0x01000193);
  }
  // Ensure unsigned, avoid returning 0 (some RNGs degenerate on zero seed).
  const seed = h >>> 0;
  return seed === 0 ? 0xDEADBEEF : seed;
}

/** Compute today's daily seed. Optional `date` for testing / preview. */
export function dailySeed(date = new Date()) {
  return fnv1a32(`omega-daily-${todayUTC(date)}`);
}

// ── Save adapter (mirrors achievements.js for symmetry) ────────────────

function defaultSaveAdapter() {
  let storage = null;
  try {
    if (typeof localStorage !== 'undefined') {
      const probe = '__omega_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      storage = localStorage;
    }
  } catch { storage = null; }

  const mem = new Map();
  return {
    get(key) {
      if (storage) {
        try {
          const raw = storage.getItem(key);
          return raw == null ? undefined : JSON.parse(raw);
        } catch { return undefined; }
      }
      return mem.get(key);
    },
    set(key, value) {
      if (storage) {
        try { storage.setItem(key, JSON.stringify(value)); return; } catch { /* fall through */ }
      }
      mem.set(key, value);
    },
  };
}

// ── DailyManager ───────────────────────────────────────────────────────

export class DailyManager {
  /**
   * @param {{ save?: { get(k:string): any, set(k:string, v:any): void },
   *           storageKey?: string,
   *           clock?: () => Date }} [opts]
   */
  constructor({ save = null, storageKey = STORAGE_KEY, clock = null } = {}) {
    this.save = save || defaultSaveAdapter();
    this.storageKey = storageKey;
    this._clock = typeof clock === 'function' ? clock : () => new Date();
    this._active = false;
  }

  /** Today's seed (uint32). Stable for the whole UTC day. */
  getDailySeed() { return dailySeed(this._clock()); }

  /** Today's date key (YYYY-MM-DD UTC). */
  getDailyDate() { return todayUTC(this._clock()); }

  /** True while a daily-mode run is active. */
  isDailyMode() { return this._active; }

  /** Mark the next run as daily mode. Call before RunStateMachine.startRun(). */
  enterDailyMode() { this._active = true; }

  /** Exit daily mode (after run summary recorded). */
  exitDailyMode() { this._active = false; }

  /** Personal best for today (0 if none recorded). */
  getPersonalBest() {
    const today = this.getDailyDate();
    const rec = this.save.get(this.storageKey);
    if (rec && rec.date === today && Number.isFinite(rec.score)) return rec.score;
    return 0;
  }

  /**
   * Update today's personal best if `score` exceeds the stored value.
   * Returns true iff a new best was written. Older records (different date)
   * are silently superseded — yesterday's best does not block today's first.
   */
  updatePersonalBest(score) {
    if (!Number.isFinite(score) || score <= 0) return false;
    const today = this.getDailyDate();
    const rec = this.save.get(this.storageKey);
    const prevSameDay = rec && rec.date === today ? (rec.score || 0) : 0;
    if (score <= prevSameDay) return false;
    this.save.set(this.storageKey, {
      date: today,
      seed: this.getDailySeed(),
      score,
      ts: Date.now(),
    });
    return true;
  }

  /** Diagnostics view — useful for daily-mode HUD/leaderboard hookup. */
  getStatus() {
    return {
      date: this.getDailyDate(),
      seed: this.getDailySeed(),
      active: this._active,
      personalBest: this.getPersonalBest(),
    };
  }
}

// Default singleton convenience (matches the goal's `dailySeed()` export shape).
export default DailyManager;
