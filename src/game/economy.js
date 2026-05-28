// Economy — in-run currency + between-wave shop.
//
// SCOPE (WO-03-E1, SPRINT-03):
//   * Currency accrues from kills, wave clears, and boss kills.
//   * Currency persists only for the lifetime of a run; meta progression is S07.
//   * Shop generates a randomized inventory at biome end and processes purchases.
//   * Per-visit inflation: each purchase in the same shop visit raises the price
//     of the *next* purchase of the same item by INFLATION_STEP (default 10%).
//   * Upgrade hooks (economy category): gain multiplier, shop discount.
//
// This module is intentionally headless: no UI, no audio, no VFX. WO-03-U2 builds
// the shop UI on top of `Shop.getInventory()` / `purchase()`.
//
// Events emitted on the shared EventBus (string literals — bus is non-dev so unknown
// names are allowed; if dev mode is enabled later, register these in EVENTS):
//   'currency:earned'  { amount, source, balance }
//   'currency:spent'   { amount, reason, balance }
//   'shop:opened'      { biome, wave, inventory }
//   'shop:closed'      { spent }
//   'shop:purchased'   { itemId, price, item }

/** Base reward per enemy archetype. Tunable for S07 balance. */
export const KILL_REWARDS = Object.freeze({
  chaser: 5,
  shooter: 8,
  orbiter: 6,
  'mini-boss': 25,
  boss: 100,
});

/** Reward for clearing a wave (pre-modifier). */
export const WAVE_CLEAR_REWARD = 15;

/** Per-visit inflation: each successive purchase of an item in the same visit
 *  raises *that item's* price by this fraction. */
export const INFLATION_STEP = 0.10;

/** Shop size bounds. Inventory size scales with biome index. */
const SHOP_MIN_SIZE = 5;
const SHOP_MAX_SIZE = 7;

/** Item catalog. Prices are *base* — actual price = base * (1 - discount) * inflation.
 *  category controls how the runtime applies the effect (UI layer / game systems
 *  consume `effect`; economy.js only handles money + bookkeeping). */
export const SHOP_CATALOG = Object.freeze({
  // --- Weapons (unlocks) -------------------------------------------------
  weapon_plasma:   { id: 'weapon_plasma',   kind: 'weapon',     name: 'PLASMA SPREAD',    basePrice: 80,  effect: { weaponId: 'plasma' },       rarity: 'common', unique: true },
  weapon_rail:     { id: 'weapon_rail',     kind: 'weapon',     name: 'RAIL / PIERCE',    basePrice: 120, effect: { weaponId: 'rail' },         rarity: 'uncommon', unique: true },
  weapon_arc:      { id: 'weapon_arc',      kind: 'weapon',     name: 'ARC CASCADE',      basePrice: 150, effect: { weaponId: 'arc' },          rarity: 'rare', unique: true },
  weapon_swarm:    { id: 'weapon_swarm',    kind: 'weapon',     name: 'SWARM MISSILES',   basePrice: 110, effect: { weaponId: 'swarm' },        rarity: 'uncommon', unique: true },
  weapon_lance:    { id: 'weapon_lance',    kind: 'weapon',     name: 'GRAV LANCE',       basePrice: 140, effect: { weaponId: 'lance' },        rarity: 'rare', unique: true },
  // --- Heals -------------------------------------------------------------
  heal_25:         { id: 'heal_25',         kind: 'heal',       name: 'REPAIR +25%',      basePrice: 20,  effect: { healFrac: 0.25 },           rarity: 'common' },
  heal_50:         { id: 'heal_50',         kind: 'heal',       name: 'REPAIR +50%',      basePrice: 35,  effect: { healFrac: 0.50 },           rarity: 'common' },
  heal_75:         { id: 'heal_75',         kind: 'heal',       name: 'REPAIR +75%',      basePrice: 50,  effect: { healFrac: 0.75 },           rarity: 'uncommon' },
  heal_full:       { id: 'heal_full',       kind: 'heal',       name: 'FULL REPAIR',      basePrice: 80,  effect: { healFrac: 1.0 },            rarity: 'uncommon' },
  // --- Energy / consumables ---------------------------------------------
  energy_restore:  { id: 'energy_restore',  kind: 'energy',     name: 'ENERGY CELL',      basePrice: 15,  effect: { energyFrac: 1.0 },          rarity: 'common' },
  shield_charge:   { id: 'shield_charge',   kind: 'consumable', name: 'SHIELD CHARGE',    basePrice: 30,  effect: { consumable: 'shield' },     rarity: 'common' },
  damage_boost:    { id: 'damage_boost',    kind: 'consumable', name: 'DMG BOOST 30s',    basePrice: 45,  effect: { consumable: 'dmg_boost', duration: 30 }, rarity: 'uncommon' },
  // --- Meta in-run ------------------------------------------------------
  random_upgrade:  { id: 'random_upgrade',  kind: 'upgrade',    name: 'RANDOM UPGRADE',   basePrice: 40,  effect: { upgrade: 'random' },        rarity: 'common' },
  curse_removal:   { id: 'curse_removal',   kind: 'curse',      name: 'PURGE CURSE',      basePrice: 60,  effect: { removeCurse: 1 },           rarity: 'uncommon' },
});

/** Rarity selection weights when rolling shop inventory. */
const RARITY_WEIGHTS = { common: 5, uncommon: 3, rare: 1 };

// ---------------------------------------------------------------------------

export class CurrencyManager {
  /**
   * @param {{ bus?: import('../engine/events.js').EventBus, initial?: number,
   *           getMultiplier?: () => number }} [opts]
   *   getMultiplier — pull live earn-multiplier from upgrade system; default 1.
   */
  constructor({ bus = null, initial = 0, getMultiplier = null } = {}) {
    this._bus = bus;
    this._balance = Math.max(0, initial | 0);
    this._getMul = typeof getMultiplier === 'function' ? getMultiplier : () => 1;
    this._lifetimeEarned = 0;
    this._lifetimeSpent = 0;
  }

  /** Earn `amount` units, scaled by the upgrade multiplier. Floored to int.
   *  Returns the actual amount credited. */
  earn(amount, source = 'unknown') {
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    const mul = Math.max(0, Number(this._getMul()) || 1);
    const credited = Math.max(0, Math.floor(amount * mul));
    if (credited === 0) return 0;
    this._balance += credited;
    this._lifetimeEarned += credited;
    if (this._bus) this._bus.emit('currency:earned', { amount: credited, source, balance: this._balance });
    return credited;
  }

  /** Reward for killing an enemy of the given type. Returns credited amount. */
  earnFromKill(enemyType) {
    const base = KILL_REWARDS[enemyType];
    if (!base) return 0;
    return this.earn(base, `kill:${enemyType}`);
  }

  /** Reward for clearing a wave. `waveIndex` is 0-based; later waves pay slightly more. */
  earnFromWaveClear(waveIndex = 0) {
    const scaled = WAVE_CLEAR_REWARD + Math.floor(waveIndex * 2);
    return this.earn(scaled, 'wave:clear');
  }

  /** Try to spend `amount`. Returns true on success, false if insufficient. */
  spend(amount, reason = 'unknown') {
    if (!Number.isFinite(amount) || amount <= 0) return false;
    const cost = Math.ceil(amount);
    if (this._balance < cost) return false;
    this._balance -= cost;
    this._lifetimeSpent += cost;
    if (this._bus) this._bus.emit('currency:spent', { amount: cost, reason, balance: this._balance });
    return true;
  }

  /** True iff balance >= amount. */
  canAfford(amount) { return this._balance >= Math.ceil(amount); }

  getBalance() { return this._balance; }
  setBalance(n) { this._balance = Math.max(0, n | 0); }

  /** Diagnostics — useful for run-summary panels. */
  getStats() {
    return { balance: this._balance, earned: this._lifetimeEarned, spent: this._lifetimeSpent };
  }

  /** Wire to the EventBus so kills/wave-clears auto-credit currency.
   *  Returns an unsubscribe fn. Caller controls when to attach (e.g. run start). */
  attachToBus(bus = this._bus) {
    if (!bus) return () => {};
    const offKill = bus.on('enemy:killed', (e) => {
      // Payload contract (best-effort): { type } or { enemyType } or { kind }.
      const t = e && (e.type || e.enemyType || e.kind);
      if (t) this.earnFromKill(t);
    });
    return () => { offKill && offKill(); };
  }
}

// ---------------------------------------------------------------------------

export class Shop {
  /**
   * @param {{ bus?: import('../engine/events.js').EventBus,
   *           rng: import('../engine/rng.js').RNG,
   *           currency: CurrencyManager,
   *           catalog?: typeof SHOP_CATALOG,
   *           getDiscount?: () => number,
   *           isOwnedWeapon?: (weaponId: string) => boolean,
   *         }} opts
   */
  constructor({ bus = null, rng, currency, catalog = SHOP_CATALOG, getDiscount = null, isOwnedWeapon = null }) {
    if (!rng) throw new Error('Shop: rng is required');
    if (!currency) throw new Error('Shop: currency manager is required');
    this._bus = bus;
    this._rng = rng;
    this._currency = currency;
    this._catalog = catalog;
    this._getDiscount = typeof getDiscount === 'function' ? getDiscount : () => 0;
    this._isOwnedWeapon = typeof isOwnedWeapon === 'function' ? isOwnedWeapon : () => false;

    this.isOpen = false;
    this.inventory = [];      // array of { itemId, price, purchased, purchasesThisVisit, ...catalogEntry }
    this.biome = null;
    this.wave = 0;
    this._visitSpent = 0;
  }

  /** Build a randomized stock for the upcoming visit (does not open the shop). */
  generateShop(biome = 'void', wave = 0, size = null) {
    const entries = Object.values(this._catalog);
    // Filter out already-owned uniques (e.g. duplicate weapon unlocks).
    const pool = entries.filter((e) => !(e.unique && e.kind === 'weapon' && this._isOwnedWeapon(e.effect?.weaponId)));

    // Determine slot count.
    let n;
    if (typeof size === 'number') n = size;
    else n = SHOP_MIN_SIZE + this._rng.int(SHOP_MAX_SIZE - SHOP_MIN_SIZE + 1);
    n = Math.min(n, pool.length);

    // Weighted draw without replacement.
    const picks = [];
    const remaining = pool.slice();
    for (let i = 0; i < n; i++) {
      const totalWeight = remaining.reduce((s, e) => s + (RARITY_WEIGHTS[e.rarity] || 1), 0);
      let roll = this._rng.float() * totalWeight;
      let idx = 0;
      for (; idx < remaining.length; idx++) {
        roll -= (RARITY_WEIGHTS[remaining[idx].rarity] || 1);
        if (roll <= 0) break;
      }
      if (idx >= remaining.length) idx = remaining.length - 1;
      picks.push(remaining[idx]);
      remaining.splice(idx, 1);
    }

    // Biome/wave price drift: scale base prices subtly with progression so later
    // shops cost more even before per-visit inflation kicks in.
    const progress = 1 + wave * 0.04;

    this.inventory = picks.map((entry) => ({
      itemId: entry.id,
      name: entry.name,
      kind: entry.kind,
      rarity: entry.rarity,
      effect: entry.effect,
      basePrice: entry.basePrice,
      price: this._computePrice(entry.basePrice * progress, 0),
      purchasesThisVisit: 0,
      purchased: false,
    }));
    this.biome = biome;
    this.wave = wave;
    return this.inventory;
  }

  openShop(biome = null, wave = null) {
    if (biome !== null || wave !== null || this.inventory.length === 0) {
      this.generateShop(biome ?? this.biome ?? 'void', wave ?? this.wave ?? 0);
    }
    this.isOpen = true;
    this._visitSpent = 0;
    if (this._bus) this._bus.emit('shop:opened', { biome: this.biome, wave: this.wave, inventory: this.inventory });
  }

  closeShop() {
    if (!this.isOpen) return;
    this.isOpen = false;
    if (this._bus) this._bus.emit('shop:closed', { spent: this._visitSpent });
    // Clear inventory so a stale list isn't reused — next generateShop populates it.
    this.inventory = [];
  }

  getInventory() { return this.inventory; }

  /** Attempt a purchase. Returns { ok: boolean, reason?, price?, item? }. */
  purchase(itemId) {
    if (!this.isOpen) return { ok: false, reason: 'shop_closed' };
    const slot = this.inventory.find((s) => s.itemId === itemId);
    if (!slot) return { ok: false, reason: 'not_in_stock' };
    // Consumable-style items (heal, energy, consumable, upgrade, curse) can repeat;
    // unique weapons cannot.
    const entry = this._catalog[itemId];
    if (entry?.unique && slot.purchased) return { ok: false, reason: 'already_purchased' };

    const price = slot.price;
    if (!this._currency.canAfford(price)) return { ok: false, reason: 'insufficient_funds', price };

    const ok = this._currency.spend(price, `shop:${itemId}`);
    if (!ok) return { ok: false, reason: 'insufficient_funds', price };

    slot.purchasesThisVisit += 1;
    slot.purchased = true;
    this._visitSpent += price;

    // Inflate THIS slot's price for the next purchase in the same visit.
    if (!entry?.unique) {
      slot.price = this._computePrice(slot.basePrice * (1 + this.wave * 0.04), slot.purchasesThisVisit);
    }

    if (this._bus) this._bus.emit('shop:purchased', { itemId, price, item: { ...slot } });
    return { ok: true, price, item: { ...slot } };
  }

  /** Internal: base * (1 - discount) * (1 + INFLATION_STEP) ** purchases, rounded. */
  _computePrice(base, purchasesThisVisit) {
    const discount = Math.min(0.75, Math.max(0, Number(this._getDiscount()) || 0));
    const inflated = base * Math.pow(1 + INFLATION_STEP, purchasesThisVisit);
    const final = inflated * (1 - discount);
    return Math.max(1, Math.round(final));
  }
}

// ---------------------------------------------------------------------------

/** Convenience factory wiring CurrencyManager + Shop with sensible defaults. */
export function createEconomy({ bus, rng, initialBalance = 0, upgrades = null } = {}) {
  const currency = new CurrencyManager({
    bus,
    initial: initialBalance,
    getMultiplier: upgrades ? () => upgrades.getEconomyMultiplier?.() ?? 1 : null,
  });
  const shop = new Shop({
    bus,
    rng: rng || null,
    currency,
    getDiscount: upgrades ? () => upgrades.getShopDiscount?.() ?? 0 : null,
    isOwnedWeapon: upgrades ? (id) => !!upgrades.hasWeapon?.(id) : null,
  });
  return { currency, shop };
}
