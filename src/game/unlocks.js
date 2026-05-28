// Unlocks — content gating tree (SPRINT-07).
//
// SCOPE (WO-07-M2):
//   * Defines the unlock catalogue (ships, weapons, modifiers, cosmetics).
//   * Each unlock declares a `condition` that resolves against the current
//     player state: prestige tier, achievements earned, deepest biome reached,
//     bosses defeated.
//   * UnlockManager keeps a derived set of unlocked ids and updates it lazily
//     (call `checkUnlocks()`) or on bus events ('run:over', 'run:victory',
//     'prestige:tier', 'biome:complete', 'boss:complete', 'achievement:earn').
//   * Persistence is delegated to a `save` adapter ({ load, save }).
//
// MUST NOT (per request):
//   * Add UI (consumers read getUnlocked / getUnlockTree).
//   * Make anything unreachable — every condition is satisfiable via prestige
//     tiers ≤ MAX_TIER, biomes that exist in director.js, or achievements
//     emitted by the game (or via the public `grantAchievement` API).

import { PrestigeManager } from './prestige.js';

/** Unlock catalogue. `default: true` means available from a fresh save. */
export const UNLOCK_TREE = Object.freeze({
  ships: Object.freeze([
    { id: 'wraith', type: 'ship', name: 'WRAITH', default: true,
      description: 'Balanced starter frame.' },
    { id: 'lance',  type: 'ship', name: 'LANCE',
      description: 'Glass-cannon dash specialist.',
      condition: { prestigeTier: 3 } },
    { id: 'aegis',  type: 'ship', name: 'AEGIS',
      description: 'Heavy shielded bulwark.',
      condition: { prestigeTier: 5 } },
    { id: 'nova',   type: 'ship', name: 'NOVA',
      description: 'AoE pulse-burst frame.',
      condition: { prestigeTier: 8 } },
  ]),
  weapons: Object.freeze([
    { id: 'plasma',   type: 'weapon', name: 'PLASMA SPREAD', default: true },
    { id: 'rail',     type: 'weapon', name: 'RAIL / PIERCE', default: true },
    { id: 'homing',   type: 'weapon', name: 'HOMING DARTS',
      condition: { prestigeTier: 1 } },
    { id: 'beam',     type: 'weapon', name: 'CONTINUOUS BEAM',
      condition: { prestigeTier: 2 } },
    { id: 'ricochet', type: 'weapon', name: 'RICOCHET CORE',
      condition: { prestigeTier: 4 } },
    { id: 'voidlob',  type: 'weapon', name: 'VOID LOB',
      condition: { prestigeTier: 6 } },
  ]),
  modifiers: Object.freeze([
    { id: 'extra_upgrade_slot', type: 'modifier', name: 'Modular Bay',
      description: '+1 starting upgrade slot.',
      condition: { prestigeTier: 2 } },
    { id: 'extra_shop_slot',    type: 'modifier', name: 'Black Market Pass',
      description: '+1 shop item slot.',
      condition: { prestigeTier: 9 } },
  ]),
  cosmetics: Object.freeze([
    { id: 'trail_neon',   type: 'cosmetic', name: 'Neon Trail',
      condition: { achievement: 'first_boss' } },
    { id: 'trail_void',   type: 'cosmetic', name: 'Void Trail',
      condition: { biomeReached: 3 } },
    { id: 'bullet_gold',  type: 'cosmetic', name: 'Gold Bullets',
      condition: { achievement: 'first_win' } },
    { id: 'bullet_crimson', type: 'cosmetic', name: 'Crimson Bullets',
      condition: { bossDefeated: 'apex' } },
  ]),
});

/** Flat list of every entry in the tree. */
export const ALL_UNLOCKS = Object.freeze([
  ...UNLOCK_TREE.ships,
  ...UNLOCK_TREE.weapons,
  ...UNLOCK_TREE.modifiers,
  ...UNLOCK_TREE.cosmetics,
]);

/** Default-unlocked ids (always available). */
export const DEFAULT_UNLOCKS = Object.freeze(
  ALL_UNLOCKS.filter((u) => u.default === true).map((u) => u.id),
);

function _emptyState() {
  return {
    unlocked: [...DEFAULT_UNLOCKS],
    achievements: [],
    bestBiome: 0,
    bossesDefeated: [],
  };
}

/** Minimal localStorage save adapter. Safe in non-browser contexts. */
export function createLocalSave(key = 'vso_unlocks_v1') {
  const hasLS = typeof globalThis !== 'undefined'
             && globalThis.localStorage
             && typeof globalThis.localStorage.getItem === 'function';
  return {
    load() {
      if (!hasLS) return null;
      try {
        const raw = globalThis.localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    },
    save(data) {
      if (!hasLS) return;
      try { globalThis.localStorage.setItem(key, JSON.stringify(data)); } catch { /* noop */ }
    },
  };
}

// ---------------------------------------------------------------------------

export class UnlockManager {
  /**
   * @param {object} opts
   * @param {import('../engine/events.js').EventBus} [opts.bus]
   * @param {{ load: () => object|null, save: (data: object) => void }} [opts.save]
   * @param {PrestigeManager} [opts.prestige] - source for current prestige tier.
   * @param {object} [opts.tree] - override unlock tree (tests).
   */
  constructor({ bus = null, save = null, prestige = null, tree = UNLOCK_TREE } = {}) {
    this._bus = bus;
    this._save = save || createLocalSave();
    this._prestige = prestige || null;
    this._tree = tree;
    this._flat = [
      ...(tree.ships || []),
      ...(tree.weapons || []),
      ...(tree.modifiers || []),
      ...(tree.cosmetics || []),
    ];
    this._byId = new Map(this._flat.map((u) => [u.id, u]));

    const loaded = this._save.load() || {};
    const fresh = _emptyState();
    this._state = {
      unlocked:       Array.isArray(loaded.unlocked) ? loaded.unlocked.slice() : fresh.unlocked,
      achievements:   Array.isArray(loaded.achievements) ? loaded.achievements.slice() : fresh.achievements,
      bestBiome:      Math.max(0, loaded.bestBiome | 0),
      bossesDefeated: Array.isArray(loaded.bossesDefeated) ? loaded.bossesDefeated.slice() : fresh.bossesDefeated,
    };
    // Always re-apply defaults so newly-added default content is granted.
    for (const id of DEFAULT_UNLOCKS) {
      if (!this._state.unlocked.includes(id)) this._state.unlocked.push(id);
    }
    this._unlockedSet = new Set(this._state.unlocked);

    // Subscribe to events that affect unlock state.
    this._unsubs = [];
    if (this._bus) {
      const refresh = () => this.checkUnlocks();
      this._unsubs.push(this._bus.on('prestige:tier', refresh));
      this._unsubs.push(this._bus.on('run:victory',   (s) => { this._ingestRun(s, true);  refresh(); }));
      this._unsubs.push(this._bus.on('run:over',      (s) => { this._ingestRun(s, false); refresh(); }));
      this._unsubs.push(this._bus.on('biome:complete', (p) => {
        const idx = (p && (p.biomeIndex | 0)) || 0;
        if (idx + 1 > this._state.bestBiome) {
          this._state.bestBiome = idx + 1;
          this._persist();
          refresh();
        }
      }));
      this._unsubs.push(this._bus.on('boss:complete', (p) => {
        const id = p && (p.bossId || p.boss || p.id);
        if (id && !this._state.bossesDefeated.includes(id)) {
          this._state.bossesDefeated.push(id);
          this._persist();
          refresh();
        }
      }));
      this._unsubs.push(this._bus.on('achievement:earn', (p) => {
        const id = p && (p.id || p.achievement);
        if (id) this.grantAchievement(id);
      }));
    }

    // Initial reconcile so prestige-derived unlocks are available immediately.
    this.checkUnlocks();
  }

  // ---- queries -----------------------------------------------------------

  /** True if `id` is unlocked. */
  isUnlocked(id) { return this._unlockedSet.has(id); }

  /** Array of unlocked ids (copy). */
  getUnlocked() { return this._state.unlocked.slice(); }

  /** Returns the unlock entry for `id`, or null. */
  getEntry(id) { return this._byId.get(id) || null; }

  /** Returns the full categorised unlock tree (frozen). */
  getUnlockTree() { return this._tree; }

  /** Returns entries grouped by type, each tagged with `unlocked` boolean. */
  getStatus() {
    const tag = (arr) => arr.map((u) => ({ ...u, unlocked: this._unlockedSet.has(u.id) }));
    return {
      ships:     tag(this._tree.ships     || []),
      weapons:   tag(this._tree.weapons   || []),
      modifiers: tag(this._tree.modifiers || []),
      cosmetics: tag(this._tree.cosmetics || []),
    };
  }

  /** Unlocked ids of a given type. */
  getUnlockedByType(type) {
    return this._flat.filter((u) => u.type === type && this._unlockedSet.has(u.id)).map((u) => u.id);
  }

  // ---- mutations ---------------------------------------------------------

  /**
   * Reconcile unlocked set against current conditions. Emits 'unlock:new'
   * for each newly-unlocked id. Returns the array of newly-unlocked ids.
   */
  checkUnlocks() {
    const newly = [];
    for (const entry of this._flat) {
      if (this._unlockedSet.has(entry.id)) continue;
      if (this._evaluate(entry)) {
        this._unlockedSet.add(entry.id);
        this._state.unlocked.push(entry.id);
        newly.push(entry.id);
        if (this._bus) this._bus.emit('unlock:new', { id: entry.id, entry });
      }
    }
    if (newly.length > 0) this._persist();
    return newly;
  }

  /** Manually unlock an id (debug / shop reward / etc.). */
  forceUnlock(id) {
    if (!this._byId.has(id)) return false;
    if (this._unlockedSet.has(id)) return false;
    this._unlockedSet.add(id);
    this._state.unlocked.push(id);
    this._persist();
    if (this._bus) this._bus.emit('unlock:new', { id, entry: this._byId.get(id), forced: true });
    return true;
  }

  /** Record an achievement; triggers unlock check. */
  grantAchievement(id) {
    if (!id || this._state.achievements.includes(id)) return false;
    this._state.achievements.push(id);
    this._persist();
    this.checkUnlocks();
    return true;
  }

  /** Wipe all non-default unlocks and achievements. */
  reset() {
    this._state = _emptyState();
    this._unlockedSet = new Set(this._state.unlocked);
    this._persist();
    if (this._bus) this._bus.emit('unlock:reset', {});
  }

  /** Serialize raw state. */
  serialize() {
    return {
      unlocked: this._state.unlocked.slice(),
      achievements: this._state.achievements.slice(),
      bestBiome: this._state.bestBiome,
      bossesDefeated: this._state.bossesDefeated.slice(),
    };
  }

  /** Tear down bus subscriptions. */
  dispose() {
    for (const off of this._unsubs) { try { off(); } catch { /* noop */ } }
    this._unsubs.length = 0;
  }

  // ---- internals ---------------------------------------------------------

  /** True if the entry's condition is satisfied. Defaults to true (no condition). */
  _evaluate(entry) {
    if (entry.default === true) return true;
    const cond = entry.condition;
    if (!cond) return true;

    if (typeof cond.prestigeTier === 'number') {
      const tier = this._prestige ? this._prestige.getTier() : 0;
      if (tier < cond.prestigeTier) return false;
    }
    if (typeof cond.biomeReached === 'number') {
      if (this._state.bestBiome < cond.biomeReached) return false;
    }
    if (typeof cond.achievement === 'string') {
      if (!this._state.achievements.includes(cond.achievement)) return false;
    }
    if (typeof cond.bossDefeated === 'string') {
      if (!this._state.bossesDefeated.includes(cond.bossDefeated)) return false;
    }
    return true;
  }

  /** Update derived stats from a run summary. */
  _ingestRun(summary, isWin) {
    if (!summary || typeof summary !== 'object') return;
    const biome = (summary.biomeIndex | 0) + (isWin ? 1 : 0);
    if (biome > this._state.bestBiome) this._state.bestBiome = biome;
    if (isWin && !this._state.achievements.includes('first_win')) {
      this._state.achievements.push('first_win');
    }
    if ((summary.bossesKilled | 0) > 0 && !this._state.achievements.includes('first_boss')) {
      this._state.achievements.push('first_boss');
    }
    this._persist();
  }

  _persist() {
    try { this._save.save(this.serialize()); } catch { /* noop */ }
  }
}

export default UnlockManager;
