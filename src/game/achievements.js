// Achievement system — WO-07-C3.
//
// Subscribes to the existing EventBus and fires named achievements exactly
// once per definition (idempotent across reloads via the injected `save`).
// Emits `achievement:unlocked` events that the UI layer (WO-07-U1) consumes
// to render toast notifications. This module does NOT touch DOM, audio, or
// run-state directly.
//
// Persistence contract — `save` adapter is duck-typed:
//   save.get(key)             -> value | undefined
//   save.set(key, value)      -> void   (caller may persist immediately or batch)
//   save.save?()              -> optional flush hook (called after every unlock)
// If `save` is omitted, a localStorage-backed default is used, falling back
// to in-memory if storage is unavailable (SSR / private mode).
//
// Achievement firing is single-shot: once an id is in the unlocked set, the
// matching check is a noop. The unlocked set is rehydrated from `save` on
// construction so survives full reload.

const STORAGE_KEY = 'omega_achievements_v1';

/** Rarity tiers (used by UI / future scoring). */
const R = Object.freeze({
  COMMON:    'common',
  UNCOMMON:  'uncommon',
  RARE:      'rare',
  LEGENDARY: 'legendary',
});

/**
 * Definition table. `event` is the bus event the achievement listens to;
 * `cond(data, ctx)` returns truthy to fire. `ctx` is a small runtime state
 * object the manager maintains (kills, dashes, curses, etc).
 *
 * Order is stable — UI iterates this list for the achievement screen.
 */
export const ACHIEVEMENTS = Object.freeze([
  // ── Skill ────────────────────────────────────────────────────────────
  { id: 'first_blood',    name: 'First Blood',     desc: 'Kill your first enemy.',                      cat: 'skill', rarity: R.COMMON,
    event: 'enemy:death', cond: (_d, ctx) => ctx.kills >= 1 },
  { id: 'combo_master',   name: 'Combo Master',    desc: 'Reach a 10x multiplier.',                     cat: 'skill', rarity: R.UNCOMMON,
    event: 'combo:multiplier-up', cond: (d) => (d?.multiplier ?? 0) >= 10 },
  { id: 'combo_god',      name: 'Combo God',       desc: 'Reach a 20x multiplier.',                     cat: 'skill', rarity: R.RARE,
    event: 'combo:multiplier-up', cond: (d) => (d?.multiplier ?? 0) >= 20 },
  { id: 'speed_runner',   name: 'Speed Runner',    desc: 'Complete Biome 1 in under 3 minutes.',        cat: 'skill', rarity: R.RARE,
    event: 'biome:complete', cond: (d, ctx) => (d?.biomeIndex === 0 || d?.biomeIndex === 1)
      && (performance.now() - ctx.runStartMs) < 180_000 },
  { id: 'marathon',       name: 'Marathon',        desc: 'Survive for 30 minutes in a single run.',     cat: 'skill', rarity: R.RARE,
    event: 'tick', cond: (_d, ctx) => ctx.runStartMs > 0 && (performance.now() - ctx.runStartMs) >= 1_800_000 },
  { id: 'clean_sweep',    name: 'Clean Sweep',     desc: 'Clear a wave without taking damage.',         cat: 'skill', rarity: R.UNCOMMON,
    event: 'wave:complete', cond: (_d, ctx) => ctx.damageTakenThisWave === 0 && ctx.waveStartedClean },
  { id: 'perfect_run',    name: 'Perfect Run',     desc: 'Complete a run without dying.',               cat: 'skill', rarity: R.LEGENDARY,
    event: 'run:victory', cond: () => true },

  // ── Exploration ──────────────────────────────────────────────────────
  { id: 'explore_nebula',    name: 'Nebula Explorer',    desc: 'Reach the Nebula biome.',              cat: 'explore', rarity: R.COMMON,
    event: 'biome:enter', cond: (d) => matchBiome(d, ['nebula_drift', 'nebula']) },
  { id: 'explore_accretion', name: 'Accretion Explorer', desc: 'Reach the Accretion biome.',           cat: 'explore', rarity: R.COMMON,
    event: 'biome:enter', cond: (d) => matchBiome(d, ['accretion_verge', 'accretion']) },
  { id: 'explore_horizon',   name: 'Horizon Explorer',   desc: 'Reach the Event Horizon biome.',       cat: 'explore', rarity: R.UNCOMMON,
    event: 'biome:enter', cond: (d) => matchBiome(d, ['event_horizon', 'horizon']) },
  { id: 'explore_core',      name: 'Core Explorer',      desc: 'Reach the Singularity Core biome.',    cat: 'explore', rarity: R.RARE,
    event: 'biome:enter', cond: (d) => matchBiome(d, ['singularity_core', 'core', 'pulsar_field']) },
  { id: 'explore_omega',     name: 'OMEGA Explorer',     desc: 'Reach the OMEGA biome.',               cat: 'explore', rarity: R.LEGENDARY,
    event: 'biome:enter', cond: (d) => matchBiome(d, ['omega']) },
  { id: 'boss_slayer',       name: 'Boss Slayer',        desc: 'Defeat your first boss.',              cat: 'explore', rarity: R.UNCOMMON,
    event: 'boss:complete', cond: (_d, ctx) => ctx.bossesKilled >= 1 },
  { id: 'all_bosses',        name: 'All Bosses',         desc: 'Defeat all 5 biome bosses.',           cat: 'explore', rarity: R.RARE,
    event: 'boss:complete', cond: (_d, ctx) => ctx.uniqueBosses.size >= 5 },
  { id: 'omega_slayer',      name: 'OMEGA Slayer',       desc: 'Defeat the OMEGA boss.',               cat: 'explore', rarity: R.LEGENDARY,
    event: 'boss:complete', cond: (d) => {
      const b = (d?.biome || d?.bossId || '').toString().toLowerCase();
      return b.includes('omega');
    } },

  // ── Mastery ──────────────────────────────────────────────────────────
  { id: 'prestige_1',     name: 'Prestige I',     desc: 'Reach prestige tier 1.',                       cat: 'mastery', rarity: R.UNCOMMON,
    event: 'prestige:tier', cond: (d) => (d?.tier ?? 0) >= 1 },
  { id: 'prestige_5',     name: 'Prestige V',     desc: 'Reach prestige tier 5.',                       cat: 'mastery', rarity: R.RARE,
    event: 'prestige:tier', cond: (d) => (d?.tier ?? 0) >= 5 },
  { id: 'prestige_10',    name: 'Prestige X',     desc: 'Reach prestige tier 10.',                      cat: 'mastery', rarity: R.LEGENDARY,
    event: 'prestige:tier', cond: (d) => (d?.tier ?? 0) >= 10 },
  { id: 'all_ships',      name: 'All Ships',      desc: 'Unlock every ship.',                           cat: 'mastery', rarity: R.RARE,
    event: 'ship:unlock', cond: (d) => (d?.unlockedCount ?? 0) >= (d?.totalCount ?? Infinity) },
  { id: 'all_weapons',    name: 'All Weapons',    desc: 'Unlock every weapon.',                         cat: 'mastery', rarity: R.RARE,
    event: 'weapon:unlock', cond: (d) => (d?.unlockedCount ?? 0) >= (d?.totalCount ?? Infinity) },
  { id: 'curse_collector', name: 'Curse Collector', desc: 'Accept 10 different curses across all runs.', cat: 'mastery', rarity: R.RARE,
    event: 'upgrade:picked', cond: (_d, ctx) => ctx.uniqueCurses.size >= 10 },
  { id: 'upgrade_hoarder', name: 'Upgrade Hoarder', desc: 'Pick 20 upgrades in a single run.',           cat: 'mastery', rarity: R.UNCOMMON,
    event: 'upgrade:picked', cond: (_d, ctx) => ctx.upgradesThisRun >= 20 },

  // ── Silly ────────────────────────────────────────────────────────────
  { id: 'magnet_victim',  name: 'Magnet Victim',  desc: 'Die from a gravity well.',                     cat: 'silly', rarity: R.UNCOMMON,
    event: 'run:over', cond: (d) => {
      const c = (d?.deathCause || d?.lastDamageSource || '').toString().toLowerCase();
      return c.includes('gravity') || c.includes('well') || c.includes('singularity');
    } },
  { id: 'friendly_fire',  name: 'Friendly Fire',  desc: 'Kill an enemy with a ricocheted bullet.',       cat: 'silly', rarity: R.UNCOMMON,
    event: 'enemy:death', cond: (d) => {
      const c = (d?.cause || d?.source || '').toString().toLowerCase();
      return c.includes('ricochet') || c.includes('bounce') || d?.ricochet === true;
    } },
  { id: 'dash_master',    name: 'Dash Master',    desc: 'Dash 100 times in a single run.',              cat: 'silly', rarity: R.UNCOMMON,
    event: 'player:dash', cond: (_d, ctx) => ctx.dashesThisRun >= 100 },
  { id: 'shopaholic',     name: 'Shopaholic',     desc: 'Spend 500 currency in a single run.',          cat: 'silly', rarity: R.UNCOMMON,
    event: 'currency:spent', cond: (_d, ctx) => ctx.spentThisRun >= 500 },
]);

function matchBiome(d, candidates) {
  if (!d) return false;
  const id = (d.biome || d.id || d.biomeId || '').toString().toLowerCase();
  const name = (d.name || d.biomeName || '').toString().toLowerCase();
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i].toLowerCase();
    if (id === c || id.includes(c) || name.includes(c)) return true;
  }
  return false;
}

// ── Save adapter ───────────────────────────────────────────────────────

function defaultSaveAdapter() {
  let storage = null;
  try {
    if (typeof localStorage !== 'undefined') {
      // Probe — some browsers throw on access in private mode.
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
    save() { /* synchronous already */ },
  };
}

// ── Manager ────────────────────────────────────────────────────────────

export class AchievementManager {
  /**
   * @param {{ bus: import('../engine/events.js').EventBus,
   *           save?: { get(k:string): any, set(k:string, v:any): void, save?: () => void },
   *           defs?: typeof ACHIEVEMENTS,
   *           storageKey?: string }} opts
   */
  constructor({ bus, save = null, defs = ACHIEVEMENTS, storageKey = STORAGE_KEY } = {}) {
    if (!bus) throw new Error('AchievementManager: bus is required');
    this.bus = bus;
    this.save = save || defaultSaveAdapter();
    this.defs = defs;
    this.storageKey = storageKey;

    // Index defs by event for O(1) dispatch.
    this._byEvent = new Map();
    this._byId = new Map();
    for (const def of defs) {
      this._byId.set(def.id, def);
      let arr = this._byEvent.get(def.event);
      if (!arr) { arr = []; this._byEvent.set(def.event, arr); }
      arr.push(def);
    }

    // Rehydrate unlocked set.
    const stored = this.save.get(storageKey);
    this._unlocked = new Set(Array.isArray(stored?.unlocked) ? stored.unlocked : []);

    // Runtime context — tracks state needed for stateful conditions.
    this.ctx = this._freshContext();

    // Subscribe to all relevant bus events. Some events (like 'tick',
    // 'player:dash', 'prestige:tier', 'ship:unlock', 'weapon:unlock',
    // 'player:hit') may not exist yet — the bus is non-dev, so `on` is safe.
    this._unsubs = [];
    for (const event of this._byEvent.keys()) {
      this._unsubs.push(this.bus.on(event, (data) => this.check(event, data)));
    }
    // Side-channel listeners that update ctx but don't directly drive checks.
    this._unsubs.push(this.bus.on('run:start',  () => this._onRunStart()));
    this._unsubs.push(this.bus.on('enemy:death', (d) => this._onEnemyDeath(d)));
    this._unsubs.push(this.bus.on('boss:complete', (d) => this._onBossComplete(d)));
    this._unsubs.push(this.bus.on('player:hit', (d) => this._onPlayerHit(d)));
    this._unsubs.push(this.bus.on('wave:start', () => this._onWaveStart()));
    this._unsubs.push(this.bus.on('upgrade:picked', (d) => this._onUpgradePicked(d)));
    this._unsubs.push(this.bus.on('currency:spent', (d) => this._onCurrencySpent(d)));
    this._unsubs.push(this.bus.on('player:dash', () => this._onDash()));
  }

  _freshContext() {
    return {
      runStartMs: 0,
      kills: 0,
      bossesKilled: 0,
      uniqueBosses: new Set(),
      damageTakenThisWave: 0,
      waveStartedClean: true,
      upgradesThisRun: 0,
      uniqueCurses: this._loadUniqueCurses(),  // persists across runs
      dashesThisRun: 0,
      spentThisRun: 0,
    };
  }

  _loadUniqueCurses() {
    const stored = this.save.get(this.storageKey);
    return new Set(Array.isArray(stored?.uniqueCurses) ? stored.uniqueCurses : []);
  }

  // ── public API ────────────────────────────────────────────────────────

  /** Evaluate any achievements bound to `event` against `data`. Idempotent. */
  check(event, data) {
    const defs = this._byEvent.get(event);
    if (!defs) return;
    for (let i = 0; i < defs.length; i++) {
      const def = defs[i];
      if (this._unlocked.has(def.id)) continue;
      let ok = false;
      try { ok = !!def.cond(data, this.ctx); } catch { ok = false; }
      if (ok) this._unlock(def);
    }
  }

  /** Per-frame poke for time-based checks (Marathon). Safe to call frequently. */
  tick() { this.check('tick', null); }

  /** Returns array of { ...def, unlocked: boolean }. */
  getAchievements() {
    const out = new Array(this.defs.length);
    for (let i = 0; i < this.defs.length; i++) {
      const d = this.defs[i];
      out[i] = {
        id: d.id, name: d.name, desc: d.desc, cat: d.cat, rarity: d.rarity,
        unlocked: this._unlocked.has(d.id),
      };
    }
    return out;
  }

  getUnlockedCount() { return this._unlocked.size; }

  isUnlocked(id) { return this._unlocked.has(id); }

  /** Emit toast event for UI. Called automatically on unlock; exposed for tests. */
  showToast(achievement) {
    this.bus.emit('achievement:unlocked', {
      id: achievement.id,
      name: achievement.name,
      desc: achievement.desc,
      rarity: achievement.rarity,
      cat: achievement.cat,
    });
  }

  /** Force-unlock (debug / migration). Returns true if newly unlocked. */
  forceUnlock(id) {
    const def = this._byId.get(id);
    if (!def || this._unlocked.has(id)) return false;
    this._unlock(def);
    return true;
  }

  /** Wipe all unlocks. For settings → reset progress. */
  resetAll() {
    this._unlocked.clear();
    this.ctx.uniqueCurses.clear();
    this._persist();
  }

  dispose() {
    for (const off of this._unsubs) { try { off(); } catch { /* noop */ } }
    this._unsubs.length = 0;
  }

  // ── internals ─────────────────────────────────────────────────────────

  _unlock(def) {
    this._unlocked.add(def.id);
    this._persist();
    this.showToast(def);
  }

  _persist() {
    this.save.set(this.storageKey, {
      unlocked: Array.from(this._unlocked),
      uniqueCurses: Array.from(this.ctx.uniqueCurses),
    });
    if (typeof this.save.save === 'function') {
      try { this.save.save(); } catch { /* noop */ }
    }
  }

  _onRunStart() {
    // Preserve cross-run state (uniqueCurses); reset per-run counters.
    const carry = this.ctx.uniqueCurses;
    this.ctx = this._freshContext();
    this.ctx.uniqueCurses = carry;
    this.ctx.runStartMs = performance.now();
  }

  _onEnemyDeath(d) {
    if (d && d.cause && d.cause !== 'damage') return; // matches combo.js gating
    this.ctx.kills += 1;
  }

  _onBossComplete(d) {
    this.ctx.bossesKilled += 1;
    const id = (d?.biome || d?.bossId || d?.id || `boss_${this.ctx.bossesKilled}`).toString();
    this.ctx.uniqueBosses.add(id);
  }

  _onPlayerHit(d) {
    const dmg = Number(d?.damage ?? d?.amount ?? 1);
    if (dmg > 0) this.ctx.damageTakenThisWave += dmg;
  }

  _onWaveStart() {
    this.ctx.damageTakenThisWave = 0;
    this.ctx.waveStartedClean = true;
  }

  _onUpgradePicked(d) {
    this.ctx.upgradesThisRun += 1;
    const card = d?.card || d;
    const isCurse = card?.isCurse === true
      || card?.rarity === 'curse'
      || card?.kind === 'curse'
      || (typeof card?.id === 'string' && card.id.toLowerCase().startsWith('curse_'));
    if (isCurse && card?.id) {
      const before = this.ctx.uniqueCurses.size;
      this.ctx.uniqueCurses.add(card.id);
      if (this.ctx.uniqueCurses.size > before) this._persist();
    }
  }

  _onCurrencySpent(d) {
    const amt = Number(d?.amount ?? 0);
    if (amt > 0) this.ctx.spentThisRun += amt;
  }

  _onDash() { this.ctx.dashesThisRun += 1; }
}

export default AchievementManager;
