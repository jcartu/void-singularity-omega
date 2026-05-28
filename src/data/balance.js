// Centralized balance data — SPRINT-07 (WO-07-C1).
//
// SINGLE SOURCE OF TRUTH for all tunable economy / progression / scoring
// numbers. Other systems (economy, run, prestige, achievements, run-summary)
// import from here and MUST NOT hardcode magic numbers locally.
//
// Tuning targets (S07 design):
//   * Average run length:           ~12 waves, ~15 minutes.
//   * Currency per minute:          ~45 (≈ 675 / run before bosses).
//   * Cursed upgrade take-rate:     30–50 %  (offer rate + payoff balance).
//   * No dominant strategy:         every category has a ~comparable
//                                   currency-per-DPS / currency-per-HP ratio.
//   * No softlock:                  cheapest healing item (REPAIR +25%) costs
//                                   less than two wave-clear bonuses, so a
//                                   broke player who clears one extra wave
//                                   can always recover.
//
// Numbers are deliberately whole / round so designers can tweak via diff
// review. Anything fractional has a comment explaining the derivation.

/**
 * @typedef {Object} CurrencyBalance
 * @property {Record<string, number>} killRewards   Per-enemy-archetype base reward.
 * @property {number} waveClearBonus                Base bonus on wave clear.
 * @property {number} waveClearScaling              Added per wave index (linear).
 * @property {number} bossReward                    Boss kill payout.
 * @property {number} miniBossReward                Mini-boss kill payout.
 * @property {number} breatherBonusMult             Multiplier applied during BREATHER state.
 * @property {number} inflationRate                 Fraction added per repeat shop purchase.
 * @property {number} shopDiscountCap               Hard cap on stacked shop discount [0..1].
 * @property {number} shopWavePriceDrift            Fraction added per wave to base prices.
 */

/**
 * @typedef {Object} UpgradeBalance
 * @property {number} commonCost                    Reference shop cost for a common item.
 * @property {number} uncommonCost                  Reference shop cost for an uncommon item.
 * @property {number} rareCost                      Reference shop cost for a rare item.
 * @property {number} curseCost                     Reference "cost" of a curse — negative = bounty.
 * @property {number} curseTakeRate                 Designer target take-rate for cursed offers.
 * @property {number} curseOfferRate                Probability that a curse is shown in a card pool.
 * @property {Record<string, number>} rarityWeights Weighted rolls when building shop inventory.
 */

/** All balance constants the game reads. Frozen so mutations throw in strict mode. */
export const BALANCE = Object.freeze({
  // ── Currency ────────────────────────────────────────────────────────────
  currency: Object.freeze({
    killRewards: Object.freeze({
      chaser: 5,
      shooter: 8,
      orbiter: 6,
      'mini-boss': 25,
      boss: 100,
    }),
    waveClearBonus: 15,
    waveClearScaling: 2,   // +2 per wave index (so wave 10 pays 35).
    bossReward: 100,
    miniBossReward: 25,
    breatherBonusMult: 1.25, // matches director BREATHER_CURRENCY_MULT.
    inflationRate: 0.10,
    shopDiscountCap: 0.75,
    shopWavePriceDrift: 0.04,
  }),

  // ── Upgrades / shop catalog tiers ───────────────────────────────────────
  // Reference prices the shop catalog SHOULD cluster around. Individual
  // catalog entries may diverge (e.g. unique weapons are gated higher) but
  // designers can audit drift by diffing entry.basePrice vs the tier value.
  upgrades: Object.freeze({
    commonCost: 25,
    uncommonCost: 60,
    rareCost: 130,
    curseCost: -40,          // Bounty: taking a curse should "feel" like +40g equiv.
    curseTakeRate: 0.40,     // 30–50 % target; midpoint.
    curseOfferRate: 0.25,    // 1 curse offered per 4-card pull on average.
    rarityWeights: Object.freeze({
      common: 5,
      uncommon: 3,
      rare: 1,
      curse: 1,
    }),
  }),

  // ── Run pacing ─────────────────────────────────────────────────────────
  run: Object.freeze({
    avgWaves: 12,
    avgTimeMinutes: 15,
    /** Designer target — verified by run-summary telemetry. */
    currencyPerMinute: 45,
  }),

  // ── Prestige (consumed by WO-07-C2) ────────────────────────────────────
  prestige: Object.freeze({
    /** Currency awarded per prestige tier earned (on run-end). */
    currencyPerTier: 100,
    /** Cost ladder for prestige unlocks. Index = tier. */
    unlockCosts: Object.freeze([0, 100, 300, 700, 1500, 3000, 6000, 12000]),
  }),

  // ── Achievements (consumed by WO-07-C3) ────────────────────────────────
  achievements: Object.freeze({
    pointValues: Object.freeze({
      common: 5,
      uncommon: 10,
      rare: 25,
      legendary: 100,
    }),
  }),
});

// ─── Helpers ─────────────────────────────────────────────────────────────
// Pure data-derivation helpers other modules can use to keep computation
// out of hot paths. All deterministic, no side effects.

/** Wave-clear reward at a given 0-based wave index. */
export function waveClearPayout(waveIndex = 0) {
  const c = BALANCE.currency;
  return c.waveClearBonus + Math.max(0, Math.floor(waveIndex) * c.waveClearScaling);
}

/** Recommended cost tier for a given rarity string. */
export function tierCost(rarity) {
  const u = BALANCE.upgrades;
  switch (rarity) {
    case 'common':   return u.commonCost;
    case 'uncommon': return u.uncommonCost;
    case 'rare':     return u.rareCost;
    case 'curse':    return u.curseCost;
    default:         return u.commonCost;
  }
}

/**
 * Inflation-adjusted price for an item with `purchases` prior buys this visit
 * and an active multiplicative `discount` ∈ [0..shopDiscountCap].
 * Rounded to an integer ≥ 1.
 */
export function inflatedPrice(basePrice, purchases = 0, discount = 0) {
  const c = BALANCE.currency;
  const d = Math.min(c.shopDiscountCap, Math.max(0, Number(discount) || 0));
  const inflated = basePrice * Math.pow(1 + c.inflationRate, Math.max(0, purchases | 0));
  return Math.max(1, Math.round(inflated * (1 - d)));
}

export default BALANCE;
