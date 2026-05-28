// SaveManager — versioned, atomic-ish persistence for meta-progression.
//
// SCOPE (SPRINT-07):
//   * Single save slot keyed by SAVE_KEY in localStorage (or injected storage).
//   * Versioned schema { version, data } with forward-only migrations.
//   * "Atomic" write: write to TEMP_KEY first, then atomically swap into SAVE_KEY
//     (single localStorage.setItem call is atomic at the API boundary, so we use
//     temp-key staging to guard against partial JSON.stringify or quota errors
//     mid-write corrupting the canonical slot). On load, if SAVE_KEY is missing
//     but TEMP_KEY exists, we recover from temp (crash mid-swap).
//   * Schema validation on load; corrupt blobs fall back to fresh defaults and
//     get backed up under BACKUP_KEY so user data is never silently destroyed.
//
// MUST NOT:
//   * Throw on missing localStorage (SSR/headless tests use in-memory shim).
//   * Lose data on migration — every migration is a pure data -> data fn.
//   * Block the main thread on large writes (writes are sync but tiny; runs save
//     once at run-end, not per-frame).

/** Current schema version. Bump when SAVE_SCHEMA changes incompatibly. */
export const SAVE_VERSION = 1;

export const SAVE_KEY    = 'omega:save:v1';
const TEMP_KEY           = 'omega:save:v1:tmp';
const BACKUP_KEY         = 'omega:save:v1:corrupt';

/** Fresh-default save payload. Migration functions must converge to this shape
 *  (for their target version). */
export function freshSaveData() {
  return {
    prestige:      { tier: 0, shards: 0 },
    unlocks:       [],           // string[] of unlock ids
    achievements:  [],           // string[] of achievement ids
    dailyBest:     { date: null, score: 0 },
    settings: {
      audio: { master: 1, music: 1, sfx: 1, muted: false },
      video: { tier: 'auto', postFx: true, motionBlur: true, shake: 1 },
    },
    totalPlaytime: 0,            // ms accumulated across runs
    totalRuns:     0,
    totalDeaths:   0,
    totalWins:     0,
    ftueComplete:  false,         // SPRINT-09 FTUE — set on first-biome clear / skip
  };
}

/** Migration registry. Key = source version → fn(data) returning data shaped
 *  for source+1. Add entries when SAVE_VERSION bumps; never mutate input.
 *  e.g. MIGRATIONS[1] = (data) => ({ ...data, newField: 0 });    // v1 -> v2
 */
const MIGRATIONS = Object.create(null);

/** Minimal in-memory storage shim with the localStorage interface. */
export function createMemoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
    get length() { return m.size; },
    key: (i) => Array.from(m.keys())[i] ?? null,
  };
}

/** Resolve a storage backend: explicit > globalThis.localStorage > in-memory. */
function resolveStorage(storage) {
  if (storage) return storage;
  try {
    if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
      // Probe — Safari private mode throws on setItem.
      const probe = '__omega_probe__';
      globalThis.localStorage.setItem(probe, '1');
      globalThis.localStorage.removeItem(probe);
      return globalThis.localStorage;
    }
  } catch { /* fall through to memory */ }
  return createMemoryStorage();
}

export class SaveManager {
  /**
   * @param {{ storage?: Storage, key?: string, version?: number,
   *           migrations?: Record<number, (data:any)=>any>,
   *           defaults?: () => object }} [opts]
   */
  constructor({ storage = null, key = SAVE_KEY, version = SAVE_VERSION,
                migrations = MIGRATIONS, defaults = freshSaveData } = {}) {
    this._storage  = resolveStorage(storage);
    this._key      = key;
    this._tmpKey   = key + ':tmp';
    this._bakKey   = key + ':corrupt';
    this._version  = version;
    this._migrations = migrations;
    this._defaults = defaults;
  }

  /** Current schema version known by this build. */
  getVersion() { return this._version; }

  /** Load + migrate. Always returns a populated data object — never throws.
   *  If the stored blob is corrupt or unmigratable, the bad blob is moved to
   *  BACKUP_KEY and a fresh default is returned. */
  load() {
    // Recover from a crash mid-swap: if main slot is empty but tmp exists,
    // promote tmp before reading.
    try {
      const main = this._storage.getItem(this._key);
      const tmp  = this._storage.getItem(this._tmpKey);
      if (main == null && tmp != null) {
        this._storage.setItem(this._key, tmp);
        try { this._storage.removeItem(this._tmpKey); } catch { /* noop */ }
      }
    } catch { /* noop */ }

    let raw;
    try { raw = this._storage.getItem(this._key); }
    catch { raw = null; }

    if (raw == null) return this._defaults();

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch {
      this._quarantine(raw, 'parse_error');
      return this._defaults();
    }

    if (!parsed || typeof parsed !== 'object'
        || typeof parsed.version !== 'number'
        || parsed.data == null || typeof parsed.data !== 'object') {
      this._quarantine(raw, 'shape_error');
      return this._defaults();
    }

    let data = parsed.data;
    let v = parsed.version | 0;

    // Future-dated save (downgrade) — never auto-mutate; preserve as best-effort
    // merge with defaults so the game keeps running.
    if (v > this._version) {
      return this._mergeDefaults(data);
    }

    // Run forward migrations until current.
    try {
      while (v < this._version) {
        const fn = this._migrations[v];
        if (typeof fn !== 'function') {
          throw new Error(`SaveManager: no migration from v${v} to v${v + 1}`);
        }
        data = fn(data);
        v += 1;
      }
    } catch (err) {
      this._quarantine(raw, 'migration_error:' + (err?.message || 'unknown'));
      return this._defaults();
    }

    return this._mergeDefaults(data);
  }

  /** Atomically persist `data`. Returns true on success, false on failure
   *  (e.g. quota exceeded, storage disabled). Never throws. */
  save(data) {
    let body;
    try {
      body = JSON.stringify({ version: this._version, data });
    } catch { return false; }

    // Stage to tmp first, then swap. localStorage.setItem is atomic at the API
    // boundary; the tmp-swap pattern guards against tab-kill between two writes
    // (we'd rather lose tmp than corrupt the main slot).
    try {
      this._storage.setItem(this._tmpKey, body);
    } catch { return false; }

    try {
      this._storage.setItem(this._key, body);
    } catch {
      // Main write failed but tmp is intact — recoverable on next load.
      return false;
    }

    try { this._storage.removeItem(this._tmpKey); } catch { /* noop */ }
    return true;
  }

  /** Replace the canonical slot with fresh defaults. Returns the new data. */
  reset() {
    const fresh = this._defaults();
    this.save(fresh);
    return fresh;
  }

  /** Migrate an arbitrary blob from `oldVersion` to current. Pure — does not
   *  touch storage. Returns { ok, data | error }. */
  migrateFrom(oldVersion, data) {
    let v = oldVersion | 0;
    if (v === this._version) return { ok: true, data };
    if (v > this._version)   return { ok: false, error: 'newer_than_current' };
    try {
      let out = data;
      while (v < this._version) {
        const fn = this._migrations[v];
        if (typeof fn !== 'function') return { ok: false, error: `no_migration_from_v${v}` };
        out = fn(out);
        v += 1;
      }
      return { ok: true, data: out };
    } catch (e) {
      return { ok: false, error: e?.message || 'migration_failed' };
    }
  }

  // ---- internals ---------------------------------------------------------

  _quarantine(raw, reason) {
    try {
      this._storage.setItem(this._bakKey, JSON.stringify({ at: Date.now(), reason, raw }));
      this._storage.removeItem(this._key);
      this._storage.removeItem(this._tmpKey);
    } catch { /* best-effort */ }
  }

  /** Shallow-merge missing top-level keys from defaults so newly-added fields
   *  in this build don't read as undefined when an old save lacks them. */
  _mergeDefaults(data) {
    const def = this._defaults();
    const out = { ...def, ...data };
    // Deep-merge a known set of nested objects we own.
    if (data && typeof data === 'object') {
      if (data.prestige)     out.prestige     = { ...def.prestige,     ...data.prestige };
      if (data.dailyBest)    out.dailyBest    = { ...def.dailyBest,    ...data.dailyBest };
      if (data.settings) {
        out.settings = { ...def.settings, ...data.settings };
        if (data.settings.audio) out.settings.audio = { ...def.settings.audio, ...data.settings.audio };
        if (data.settings.video) out.settings.video = { ...def.settings.video, ...data.settings.video };
      }
      // Arrays we don't merge — replace wholesale.
      if (Array.isArray(data.unlocks))      out.unlocks      = data.unlocks.slice();
      if (Array.isArray(data.achievements)) out.achievements = data.achievements.slice();
    }
    return out;
  }
}

export default SaveManager;
