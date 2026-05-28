// Prestige — meta-progression layer (SPRINT-07).
//
// SCOPE (WO-07-M1):
//   * "Void shards" are earned on run completion (win OR lose) based on the
//     run summary (biome reached, waves cleared, bosses, kill score).
//   * Spending shards advances the prestige tier. Each tier applies a permanent
//     modifier that the run system reads at run start (via getModifiers()) and
//     applies on top of base ship/weapon/upgrade stats.
//   * Tier purchases are sequential and monotonic — there's no refund and no
//     skipping. `getNextTierCost()` reports the cost of the next tier.
//   * Persistence is delegated to a `save` adapter ({ load, save }) — see
//     `createLocalSave` for a localStorage default.
//
// MUST NOT (per request):
//   * Add UI (WO-07-U1 handles HUD/menu).
//   * Add audio.
//   * Make unlocks unreachable — every tier ≤ TIER_TABLE.length is achievable
//     via accumulated runs; ship/weapon unlocks live in unlocks.js and key off
//     getTier().
//   * Break existing run flow — listeners are passive; getModifiers() returns
//     a neutral object until shards are spent.

/** Prestige tier table. Costs are cumulative-feeling but each entry is the
 *  cost to BUY THAT TIER (not total). Modifiers stack: a player at tier N has
 *  every modifier from tiers 1..N applied. */
export const TIER_TABLE = Object.freeze([
  // tier 1
  { tier: 1,  cost: 100,  name: 'Salvage Protocol',
    description: '+10% currency gain.',
    modifier: { currencyMult: 1.10 } },
  // tier 2
  { tier: 2,  cost: 200,  name: 'Modular Bay',
    description: '+1 starting upgrade slot.',
    modifier: { startingUpgradeSlots: 1 } },
  // tier 3
  { tier: 3,  cost: 350,  name: 'Lance Authorisation',
    description: 'Unlock the LANCE ship.',
    modifier: { unlockShip: 'lance' } },
  // tier 4
  { tier: 4,  cost: 500,  name: 'Overcharged Arrays',
    description: '+15% weapon damage.',
    modifier: { damageMult: 1.15 } },
  // tier 5
  { tier: 5,  cost: 700,  name: 'Aegis Authorisation',
    description: 'Unlock the AEGIS ship.',
    modifier: { unlockShip: 'aegis' } },
  // tier 6
  { tier: 6,  cost: 900,  name: 'Hexbreaker',
    description: 'Curses have 20% reduced drawback.',
    modifier: { curseDrawbackReduction: 0.20 } },
  // tier 7
  { tier: 7,  cost: 1200, name: 'Reinforced Frame',
    description: '+20% max HP.',
    modifier: { maxHpMult: 1.20 } },
  // tier 8
  { tier: 8,  cost: 1500, name: 'Nova Authorisation',
    description: 'Unlock the NOVA ship.',
    modifier: { unlockShip: 'nova' } },
  // tier 9
  { tier: 9,  cost: 2000, name: 'Black Market Pass',
    description: '+1 shop item slot.',
    modifier: { shopItemBonus: 1 } },
  // tier 10
  { tier: 10, cost: 2500, name: 'Eldritch License',
    description: 'All curses are available from the start of every run.',
    modifier: { allCursesUnlocked: true } },
]);

/** Maximum tier the table supports. */
export const MAX_TIER = TIER_TABLE.length;

/** Shard reward weights — tuned so a tier-1 finish (~biome 1, ~5 waves) yields
 *  ~50 shards (half of tier 1) and a full clear (~biome 5, ~25 waves, 5 bosses)
 *  yields ~500–600 shards. Re-tunable from balance data later. */
export const SHARD_WEIGHTS = Object.freeze({
  perBiome:        15,   // biome index reached (0..N)
  perWave:          2,   // wave cleared this run
  perBoss:         20,   // bosses killed this run
  perKill:        0.10,  // raw kill credit
  winBonus:       100,   // flat bonus for full clear
  currencyEarned: 0.02,  // 2% of currency earned this run
});

/** Default empty save shape. */
function _emptyState() {
  return {
    tier: 0,
    shards: 0,
    shardsLifetime: 0,
    shardsSpent: 0,
    runs: 0,
    wins: 0,
  };
}

/** Minimal localStorage save adapter. Safe in non-browser contexts. */
export function createLocalSave(key = 'vso_prestige_v1') {
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

/** Compute shard reward from a run summary (matches RunStateMachine.getRunSummary). */
export function computeShardReward(runSummary = {}) {
  if (!runSummary || typeof runSummary !== 'object') return 0;
  const w = SHARD_WEIGHTS;
  const biome  = Math.max(0, runSummary.biomeIndex | 0);
  const waves  = Math.max(0, runSummary.wavesCleared | 0);
  const bosses = Math.max(0, runSummary.bossesKilled | 0);
  const kills  = Math.max(0, runSummary.kills | 0);
  const earned = Math.max(0, Number(runSummary.currencyEarned) || 0);
  const win    = runSummary.result === 'win';

  let shards = 0;
  shards += biome  * w.perBiome;
  shards += waves  * w.perWave;
  shards += bosses * w.perBoss;
  shards += kills  * w.perKill;
  shards += earned * w.currencyEarned;
  if (win) shards += w.winBonus;
  return Math.max(0, Math.floor(shards));
}

// ---------------------------------------------------------------------------

export class PrestigeManager {
  /**
   * @param {object} [opts]
   * @param {import('../engine/events.js').EventBus} [opts.bus]
   * @param {{ load: () => object|null, save: (data: object) => void }} [opts.save]
   *   Persistence adapter. Defaults to a localStorage adapter.
   */
  constructor({ bus = null, save = null } = {}) {
    this._bus = bus;
    this._save = save || createLocalSave();
    this._state = { ..._emptyState(), ...(this._save.load() || {}) };
    // Sanitize loaded state.
    this._state.tier           = Math.max(0, Math.min(MAX_TIER, this._state.tier | 0));
    this._state.shards         = Math.max(0, this._state.shards | 0);
    this._state.shardsLifetime = Math.max(this._state.shards, this._state.shardsLifetime | 0);
    this._state.shardsSpent    = Math.max(0, this._state.shardsSpent | 0);
    this._state.runs           = Math.max(0, this._state.runs | 0);
    this._state.wins           = Math.max(0, this._state.wins | 0);

    // Subscribe to run completion for auto-grant of shards.
    this._unsubs = [];
    if (this._bus) {
      const onOver = (s) => this.onRunComplete({ ...s, result: 'lose'  });
      const onWin  = (s) => this.onRunComplete({ ...s, result: 'win'   });
      this._unsubs.push(this._bus.on('run:over',    onOver));
      this._unsubs.push(this._bus.on('run:victory', onWin));
    }
  }

  // ---- queries -----------------------------------------------------------

  getTier()           { return this._state.tier; }
  getShards()         { return this._state.shards; }
  getShardsLifetime() { return this._state.shardsLifetime; }
  getShardsSpent()    { return this._state.shardsSpent; }
  getRuns()           { return this._state.runs; }
  getWins()           { return this._state.wins; }

  /** Cost of the next tier, or null if max tier already reached. */
  getNextTierCost() {
    const t = this._state.tier;
    if (t >= MAX_TIER) return null;
    return TIER_TABLE[t].cost;
  }

  /** Definition of the next tier (or null if maxed). */
  getNextTier() {
    const t = this._state.tier;
    if (t >= MAX_TIER) return null;
    return TIER_TABLE[t];
  }

  /** Full tier table — for UI rendering. */
  getTierTable() { return TIER_TABLE; }

  /** True if the next tier is affordable right now. */
  canAdvance() {
    const cost = this.getNextTierCost();
    return cost !== null && this._state.shards >= cost;
  }

  /**
   * Aggregate modifiers from every owned tier. Run system reads this at run
   * start. Always returns a fresh neutral-by-default object so callers can
   * destructure without null checks.
   */
  getModifiers() {
    const mods = {
      currencyMult: 1,
      damageMult: 1,
      maxHpMult: 1,
      startingUpgradeSlots: 0,
      shopItemBonus: 0,
      curseDrawbackReduction: 0,
      allCursesUnlocked: false,
      unlockedShips: ['wraith'],
    };
    for (let i = 0; i < this._state.tier; i++) {
      const m = TIER_TABLE[i].modifier;
      if (!m) continue;
      if (typeof m.currencyMult === 'number')           mods.currencyMult           *= m.currencyMult;
      if (typeof m.damageMult === 'number')             mods.damageMult             *= m.damageMult;
      if (typeof m.maxHpMult === 'number')              mods.maxHpMult              *= m.maxHpMult;
      if (typeof m.startingUpgradeSlots === 'number')   mods.startingUpgradeSlots   += m.startingUpgradeSlots;
      if (typeof m.shopItemBonus === 'number')          mods.shopItemBonus          += m.shopItemBonus;
      if (typeof m.curseDrawbackReduction === 'number') mods.curseDrawbackReduction  = Math.min(0.9, mods.curseDrawbackReduction + m.curseDrawbackReduction);
      if (m.allCursesUnlocked === true)                 mods.allCursesUnlocked       = true;
      if (typeof m.unlockShip === 'string' && !mods.unlockedShips.includes(m.unlockShip)) {
        mods.unlockedShips.push(m.unlockShip);
      }
    }
    return mods;
  }

  // ---- mutations ---------------------------------------------------------

  /**
   * Spend `amount` shards directly (advanced / programmatic use). Returns true
   * on success. Tier is NOT auto-advanced — use advanceTier() for that.
   */
  spendShards(amount, reason = 'manual') {
    if (!Number.isFinite(amount) || amount <= 0) return false;
    const cost = Math.ceil(amount);
    if (this._state.shards < cost) return false;
    this._state.shards      -= cost;
    this._state.shardsSpent += cost;
    this._persist();
    if (this._bus) this._bus.emit('prestige:spend', { amount: cost, reason, balance: this._state.shards });
    return true;
  }

  /** Buy the next tier. Returns the new tier on success, 0 on failure. */
  advanceTier() {
    const next = this.getNextTier();
    if (!next) return 0;
    if (this._state.shards < next.cost) return 0;
    this._state.shards      -= next.cost;
    this._state.shardsSpent += next.cost;
    this._state.tier         = next.tier;
    this._persist();
    if (this._bus) this._bus.emit('prestige:tier', { tier: next.tier, definition: next, balance: this._state.shards });
    return next.tier;
  }

  /**
   * Award shards from a completed run. Idempotent only relative to the call
   * site — the run system should call this exactly once per run completion.
   * Safe to invoke directly OR via the bus subscriptions registered in ctor.
   */
  onRunComplete(runSummary = {}) {
    const earned = computeShardReward(runSummary);
    this._state.runs += 1;
    if (runSummary.result === 'win') this._state.wins += 1;
    if (earned > 0) {
      this._state.shards         += earned;
      this._state.shardsLifetime += earned;
    }
    this._persist();
    if (this._bus) {
      this._bus.emit('prestige:earn', {
        amount: earned,
        balance: this._state.shards,
        lifetime: this._state.shardsLifetime,
        runs: this._state.runs,
        wins: this._state.wins,
      });
    }
    return earned;
  }

  /** Wipe progress. For debug / "reset save" menu. */
  reset() {
    this._state = _emptyState();
    this._persist();
    if (this._bus) this._bus.emit('prestige:reset', {});
  }

  /** Serialize/inspect raw state. */
  serialize() { return { ...this._state }; }

  /** Tear down bus subscriptions. */
  dispose() {
    for (const off of this._unsubs) { try { off(); } catch { /* noop */ } }
    this._unsubs.length = 0;
  }

  // ---- internals ---------------------------------------------------------

  _persist() {
    try { this._save.save(this._state); } catch { /* noop */ }
  }
}

export default PrestigeManager;
