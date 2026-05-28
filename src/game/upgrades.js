// Upgrades & Curses — between-wave card system.
//
// Architecture:
//   - UPGRADES is a frozen registry keyed by id. Each entry is pure data.
//   - UpgradeManager attaches to a ship + weapons system and a `meta` bag of
//     gameplay flags that other systems (combo, economy, gravity, etc.) read.
//   - Stacking rules:
//       * `add` operators sum within a stat (additive across upgrades on same stat).
//       * `mul` operators compound multiplicatively across upgrades.
//       * `set` operators force a boolean / scalar flag (last-write-wins).
//   - Weapon defs in defs.js are frozen; we shallow-clone them into a mutable
//     mirror at attach time so per-run modifications don't leak across runs.
//
// Effect stat paths:
//   ship.<key>        e.g. 'ship.maxSpeed'        - mutates ship.opts
//   weapon.<id|*>.<k> e.g. 'weapon.plasma.damage' - mutates mutable defs mirror
//   meta.<key>        e.g. 'meta.critChance'      - flags consumed by other systems
//
// Public API:
//   const mgr = new UpgradeManager({ ship, weapons, rng });
//   mgr.applyUpgrade('damage_up_1');
//   mgr.applyCurse('pyromaniac');
//   mgr.getUpgradePool(3, excludeIds);  // shuffled card draw
//   mgr.canApply(id);
//   mgr.applied;                         // array of applied ids
//   mgr.meta;                            // current meta-stat bag
//
// MUST NOT crash on bad inputs — every mutation is defensive.

import { WEAPONS, WEAPON_ORDER } from './weapons/defs.js';

// Meta-stat defaults. Other systems read these via mgr.meta.<key>.
export const DEFAULT_META = Object.freeze({
  // Damage
  critChance: 0,
  critMult: 2,
  bossDamageMult: 1,
  incomingDamageMult: 1,
  damageMissingHpMaxBonus: 0,   // berserker: extra +X% at 1 HP
  // Projectile
  bulletSplitOnKill: false,
  extraBullets: 0,
  pierceBonus: 0,
  bulletSpeedMul: 1,
  wellCurve: false,
  // Movement / dash
  dashSpeedMul: 1,
  dashCooldownMul: 1,
  // Survivability
  hpRegen: 0,                   // hp/sec passive
  passiveDrain: 0,              // hp/sec drain (curse)
  loomImmunity: 0,              // 0..1, multiplicative dmg reduction from loom
  startingShield: 0,            // shield HP applied at wave start
  noIframesOnHit: false,
  // Gravity / environment interactions
  horizonDamagesEnemies: false,
  horizonDamagesPlayer: false,
  contactDamage: 0,             // damage to enemies from touch
  playerGravityRadius: 0,       // > 0: ship pulls enemies
  playerGravityPullSelf: 0,     // enemies pull ship back
  // Economy
  currencyMult: 1,
  shopPriceMult: 1,
  startingCurrency: 0,
  cantSpendShop: false,
  lootMagnetMul: 1,             // pickup pull strength multiplier (curse: also 2x)
  // Combo
  comboCapMul: 1,
  comboDecayMul: 1,             // <1 = slower decay
  comboTimerBonus: 0,           // seconds added on kill
  // Time
  timeScale: 1,
  cooldownMult: 1,              // affects weapon cooldowns multiplicatively
  // Martyr
  martyrAvailable: false,
});

// Effect helper constructors (just for readability in the registry).
const add = (stat, value) => ({ stat, operator: 'add', value });
const mul = (stat, value) => ({ stat, operator: 'mul', value });
const set = (stat, value) => ({ stat, operator: 'set', value });

// Upgrade registry. Categories: damage, firerate, movement, survivability,
//   projectile, gravity, economy, combo, curse.
// Rarity: common / uncommon / rare / curse.
export const UPGRADES = Object.freeze({
  damage_up_1: {
    id: 'damage_up_1', name: 'Overcharged Rounds',
    description: '+20% weapon damage.',
    category: 'damage', rarity: 'common', icon: '⚡',
    effects: [mul('weapon.*.damage', 1.20)],
  },
  damage_up_2: {
    id: 'damage_up_2', name: 'Heavy Slugs',
    description: '+35% weapon damage, -5% fire rate.',
    category: 'damage', rarity: 'uncommon', icon: '⚒',
    effects: [mul('weapon.*.damage', 1.35), mul('weapon.*.cooldown', 1.0526)],
  },
  damage_boss: {
    id: 'damage_boss', name: 'Giant Slayer',
    description: '+50% damage to bosses.',
    category: 'damage', rarity: 'uncommon', icon: '☠',
    effects: [mul('meta.bossDamageMult', 1.50)],
  },
  critical_hits: {
    id: 'critical_hits', name: 'Hairline Triggers',
    description: '15% chance to crit for 2× damage.',
    category: 'damage', rarity: 'rare', icon: '✦',
    effects: [add('meta.critChance', 0.15), set('meta.critMult', 2)],
  },
  critical_amp: {
    id: 'critical_amp', name: 'Amplified Crits',
    description: '+20% crit chance, crit multiplier 3×.',
    category: 'damage', rarity: 'rare', icon: '✸',
    prerequisites: ['critical_hits'],
    effects: [add('meta.critChance', 0.20), set('meta.critMult', 3)],
  },
  plasma_focus: {
    id: 'plasma_focus', name: 'Plasma Focus',
    description: '+40% plasma damage.',
    category: 'damage', rarity: 'uncommon', icon: '🜂',
    effects: [mul('weapon.plasma.damage', 1.40)],
  },
  rail_focus: {
    id: 'rail_focus', name: 'Rail Tuning',
    description: '+50% rail damage.',
    category: 'damage', rarity: 'uncommon', icon: '🜄',
    effects: [mul('weapon.rail.damage', 1.50)],
  },

  firerate_up_1: {
    id: 'firerate_up_1', name: 'Trigger Discipline',
    description: '+15% fire rate.',
    category: 'firerate', rarity: 'common', icon: '⏱',
    effects: [mul('weapon.*.cooldown', 1 / 1.15)],
  },
  firerate_up_2: {
    id: 'firerate_up_2', name: 'Hair Trigger',
    description: '+25% fire rate, -10% damage.',
    category: 'firerate', rarity: 'uncommon', icon: '⚡',
    effects: [mul('weapon.*.cooldown', 1 / 1.25), mul('weapon.*.damage', 0.90)],
  },
  firerate_rail: {
    id: 'firerate_rail', name: 'Capacitor Bank',
    description: '+30% rail fire rate.',
    category: 'firerate', rarity: 'uncommon', icon: '⚙',
    effects: [mul('weapon.rail.cooldown', 1 / 1.30)],
  },

  speed_up_1: {
    id: 'speed_up_1', name: 'Thruster Boost',
    description: '+15% movement speed.',
    category: 'movement', rarity: 'common', icon: '➤',
    effects: [mul('ship.maxSpeed', 1.15), mul('ship.thrustAccel', 1.15)],
  },
  dash_speed: {
    id: 'dash_speed', name: 'Slipspace Dash',
    description: '+20% dash speed.',
    category: 'movement', rarity: 'common', icon: '⇶',
    effects: [mul('meta.dashSpeedMul', 1.20), mul('ship.dashSpeed', 1.20)],
  },
  dash_cooldown: {
    id: 'dash_cooldown', name: 'Quick Recovery',
    description: '-20% dash cooldown.',
    category: 'movement', rarity: 'uncommon', icon: '↻',
    effects: [mul('meta.dashCooldownMul', 0.80), mul('ship.dashCooldown', 0.80)],
  },
  dash_iframes: {
    id: 'dash_iframes', name: 'Phase Shift',
    description: '+50% i-frames during dash.',
    category: 'movement', rarity: 'uncommon', icon: '◌',
    effects: [mul('ship.dashIFrames', 1.50)],
  },

  hp_up_1: {
    id: 'hp_up_1', name: 'Reinforced Hull',
    description: '+25 max HP.',
    category: 'survivability', rarity: 'common', icon: '♥',
    effects: [add('ship.maxHealth', 25)],
  },
  hp_up_2: {
    id: 'hp_up_2', name: 'Plated Armor',
    description: '+50 max HP.',
    category: 'survivability', rarity: 'uncommon', icon: '🛡',
    effects: [add('ship.maxHealth', 50)],
  },
  energy_up: {
    id: 'energy_up', name: 'Auxiliary Cells',
    description: '+20 max energy.',
    category: 'survivability', rarity: 'common', icon: '◉',
    effects: [add('ship.maxEnergy', 20)],
  },
  energy_regen: {
    id: 'energy_regen', name: 'Fast Regen',
    description: '+50% energy regen.',
    category: 'survivability', rarity: 'uncommon', icon: '↑',
    effects: [mul('ship.energyRegen', 1.50)],
  },
  hp_regen: {
    id: 'hp_regen', name: 'Nanite Repair',
    description: '+10% HP regen per second.',
    category: 'survivability', rarity: 'rare', icon: '✚',
    effects: [add('meta.hpRegen', 0.10)],
  },
  wave_shield: {
    id: 'wave_shield', name: 'Wave Aegis',
    description: 'Start each wave with 25 shield HP.',
    category: 'survivability', rarity: 'rare', icon: '◈',
    effects: [add('meta.startingShield', 25)],
  },
  loom_immunity: {
    id: 'loom_immunity', name: 'Horizon Mantle',
    description: '+30% damage reduction from gravity loom.',
    category: 'survivability', rarity: 'uncommon', icon: '◐',
    effects: [add('meta.loomImmunity', 0.30)],
  },

  extra_bullet: {
    id: 'extra_bullet', name: 'Multi-Shot',
    description: '+1 bullet per shot (spread weapons).',
    category: 'projectile', rarity: 'uncommon', icon: '⁂',
    effects: [add('meta.extraBullets', 1), add('weapon.plasma.bullets', 1)],
  },
  bullet_speed: {
    id: 'bullet_speed', name: 'Hot Loads',
    description: '+20% bullet speed.',
    category: 'projectile', rarity: 'common', icon: '➤',
    effects: [mul('meta.bulletSpeedMul', 1.20), mul('weapon.*.speed', 1.20)],
  },
  pierce_up: {
    id: 'pierce_up', name: 'Penetrators',
    description: '+1 pierce on all bullets.',
    category: 'projectile', rarity: 'uncommon', icon: '↦',
    effects: [add('meta.pierceBonus', 1), add('weapon.*.pierce', 1)],
  },
  split_on_kill: {
    id: 'split_on_kill', name: 'Fragmentation',
    description: 'Bullets split into 2 on kill.',
    category: 'projectile', rarity: 'rare', icon: '✺',
    effects: [set('meta.bulletSplitOnKill', true)],
  },

  well_curve: {
    id: 'well_curve', name: 'Gravity Whip',
    description: 'Bullets curve through the gravity well.',
    category: 'gravity', rarity: 'rare', icon: '◯',
    effects: [set('meta.wellCurve', true)],
  },
  horizon_damages_enemies: {
    id: 'horizon_damages_enemies', name: 'Event Lash',
    description: 'The event horizon damages enemies caught in it.',
    category: 'gravity', rarity: 'rare', icon: '☼',
    effects: [set('meta.horizonDamagesEnemies', true)],
  },

  currency_up: {
    id: 'currency_up', name: 'Salvage Plus',
    description: '+15% currency gain.',
    category: 'economy', rarity: 'common', icon: '◊',
    effects: [mul('meta.currencyMult', 1.15)],
  },
  shop_discount: {
    id: 'shop_discount', name: 'Black Market Contact',
    description: '-10% shop prices.',
    category: 'economy', rarity: 'uncommon', icon: '$',
    effects: [mul('meta.shopPriceMult', 0.90)],
  },
  starting_cash: {
    id: 'starting_cash', name: 'Trust Fund',
    description: '+50 starting currency this run.',
    category: 'economy', rarity: 'common', icon: '★',
    effects: [add('meta.startingCurrency', 50)],
  },

  combo_cap: {
    id: 'combo_cap', name: 'Higher Ceiling',
    description: '+10% multiplier cap.',
    category: 'combo', rarity: 'common', icon: '∧',
    effects: [mul('meta.comboCapMul', 1.10)],
  },
  combo_decay: {
    id: 'combo_decay', name: 'Steady Hand',
    description: 'Combo decays 20% slower.',
    category: 'combo', rarity: 'uncommon', icon: '∾',
    effects: [mul('meta.comboDecayMul', 0.80)],
  },
  combo_timer: {
    id: 'combo_timer', name: 'Killstreak',
    description: 'Kills add 2s to the combo timer.',
    category: 'combo', rarity: 'uncommon', icon: '⏲',
    effects: [add('meta.comboTimerBonus', 2)],
  },

  pyromaniac: {
    id: 'pyromaniac', name: 'Pyromaniac',
    description: '+60% damage, -40% max HP.',
    category: 'curse', rarity: 'curse', icon: '🜂',
    effects: [mul('weapon.*.damage', 1.60), mul('ship.maxHealth', 0.60)],
  },
  magnet: {
    id: 'magnet', name: 'Magnet',
    description: 'Well pulls 2× strong — but so does loot.',
    category: 'curse', rarity: 'curse', icon: '⚹',
    effects: [mul('meta.lootMagnetMul', 2.0)],
    // Well-pull doubling is handled by world.js reading meta.lootMagnetMul too.
  },
  glass_cannon: {
    id: 'glass_cannon', name: 'Glass Cannon',
    description: '+100% damage, +50% incoming damage.',
    category: 'curse', rarity: 'curse', icon: '🜺',
    effects: [mul('weapon.*.damage', 2.0), mul('meta.incomingDamageMult', 1.50)],
  },
  addict: {
    id: 'addict', name: 'Addict',
    description: '+30% all stats, -1 HP/sec passive drain.',
    category: 'curse', rarity: 'curse', icon: '⌬',
    effects: [
      mul('weapon.*.damage', 1.30),
      mul('ship.maxSpeed', 1.30),
      mul('ship.thrustAccel', 1.30),
      mul('weapon.*.cooldown', 1 / 1.30),
      add('meta.passiveDrain', 1),
    ],
  },
  reckless: {
    id: 'reckless', name: 'Reckless',
    description: 'No i-frames on hit, +50% damage.',
    category: 'curse', rarity: 'curse', icon: '✖',
    effects: [set('meta.noIframesOnHit', true), mul('weapon.*.damage', 1.50)],
  },
  hoarder: {
    id: 'hoarder', name: 'Hoarder',
    description: 'Triple currency — but you can\'t spend it.',
    category: 'curse', rarity: 'curse', icon: '💰',
    effects: [mul('meta.currencyMult', 3.0), set('meta.cantSpendShop', true)],
  },
  berserker: {
    id: 'berserker', name: 'Berserker',
    description: 'Damage scales with missing HP (up to +100% at 1 HP).',
    category: 'curse', rarity: 'curse', icon: '⚔',
    effects: [add('meta.damageMissingHpMaxBonus', 1.0)],
  },
  void_touch: {
    id: 'void_touch', name: 'Void Touch',
    description: 'Contact damages enemies — but the horizon damages you too.',
    category: 'curse', rarity: 'curse', icon: '◉',
    effects: [
      add('meta.contactDamage', 25),
      set('meta.horizonDamagesPlayer', true),
    ],
  },
  overclock: {
    id: 'overclock', name: 'Overclock',
    description: '+40% fire rate, -30% bullet speed.',
    category: 'curse', rarity: 'curse', icon: '⚡',
    effects: [
      mul('weapon.*.cooldown', 1 / 1.40),
      mul('weapon.*.speed', 0.70),
      mul('meta.bulletSpeedMul', 0.70),
    ],
  },
  martyr: {
    id: 'martyr', name: 'Martyr',
    description: 'On death: explode for 500% damage, respawn at 25% HP (once).',
    category: 'curse', rarity: 'curse', icon: '✟',
    effects: [set('meta.martyrAvailable', true)],
  },
  gravity_well_self: {
    id: 'gravity_well_self', name: 'Gravity Well',
    description: 'You pull on enemies. They pull on you.',
    category: 'curse', rarity: 'curse', icon: '◯',
    effects: [
      add('meta.playerGravityRadius', 12),
      add('meta.playerGravityPullSelf', 0.4),
    ],
  },
  time_bender: {
    id: 'time_bender', name: 'Time Bender',
    description: 'Slow time 20% — but all cooldowns are 20% longer.',
    category: 'curse', rarity: 'curse', icon: '⏳',
    effects: [
      mul('meta.timeScale', 0.80),
      mul('meta.cooldownMult', 1.20),
      mul('weapon.*.cooldown', 1.20),
      mul('ship.dashCooldown', 1.20),
    ],
  },
});

export const UPGRADE_IDS = Object.freeze(Object.keys(UPGRADES));
export const CURSE_IDS = Object.freeze(
  UPGRADE_IDS.filter((id) => UPGRADES[id].category === 'curse'),
);
export const NON_CURSE_IDS = Object.freeze(
  UPGRADE_IDS.filter((id) => UPGRADES[id].category !== 'curse'),
);

// UpgradeManager — applies effects, tracks state, builds card pools.
export class UpgradeManager {
  /**
   * @param {object} ctx
   * @param {object} [ctx.ship]     - Ship instance (mutates .opts and clamps .health/.energy)
   * @param {object} [ctx.weapons]  - WeaponSystem instance (we replace .defs with mutable mirror)
   * @param {object} [ctx.rng]      - RNG with .float()/.int() (mulberry32 fork)
   * @param {object} [ctx.registry] - Override registry (defaults to UPGRADES)
   */
  constructor({ ship = null, weapons = null, rng = null, registry = UPGRADES } = {}) {
    this.ship = ship;
    this.weapons = weapons;
    this.rng = rng;
    this.registry = registry;
    this.applied = [];                // ordered list of applied ids
    this.appliedSet = new Set();
    this.meta = { ...DEFAULT_META };

    // Mirror the frozen weapon defs into a mutable per-run copy so upgrades
    // can edit them without leaking across runs. Keep the WEAPON_ORDER intact.
    if (this.weapons && this.weapons.defs === WEAPONS) {
      const mirror = Object.create(null);
      for (const id of WEAPON_ORDER) {
        const src = WEAPONS[id];
        if (src) mirror[id] = { ...src };
      }
      this.weapons.defs = mirror;
    }
  }


  /** Returns the upgrade definition or null. */
  get(id) {
    return this.registry[id] || null;
  }

  /** True if id is already applied. */
  has(id) {
    return this.appliedSet.has(id);
  }

  /**
   * Checks prerequisites + conflicts + duplicate rules.
   * Returns { ok: bool, reason?: string }.
   */
  canApply(id) {
    const def = this.get(id);
    if (!def) return { ok: false, reason: 'unknown_id' };
    if (this.appliedSet.has(id) && !def.stackable) {
      return { ok: false, reason: 'already_applied' };
    }
    if (def.prerequisites) {
      for (const pre of def.prerequisites) {
        if (!this.appliedSet.has(pre)) {
          return { ok: false, reason: `missing_prereq:${pre}` };
        }
      }
    }
    if (def.conflicts) {
      for (const c of def.conflicts) {
        if (this.appliedSet.has(c)) {
          return { ok: false, reason: `conflicts_with:${c}` };
        }
      }
    }
    return { ok: true };
  }

  /**
   * Apply any upgrade or curse by id. Returns true on success.
   * Defensive: skips silently on invalid id / failed canApply.
   */
  apply(id) {
    const check = this.canApply(id);
    if (!check.ok) return false;
    const def = this.get(id);
    for (const eff of def.effects || []) {
      try {
        this._applyEffect(eff);
      } catch (e) {
        // Never crash from a single bad effect; log to console once.
        // eslint-disable-next-line no-console
        console.warn('[upgrades] effect failed', id, eff, e);
      }
    }
    this.applied.push(id);
    this.appliedSet.add(id);
    return true;
  }

  /** Alias for clarity in callers. */
  applyUpgrade(id) { return this.apply(id); }
  applyCurse(id) {
    const def = this.get(id);
    if (!def || def.category !== 'curse') return false;
    return this.apply(id);
  }

  /**
   * Build a shuffled card pool. By default draws from non-curse pool.
   * @param {number} count           - how many cards to return
   * @param {string[]} [excludeIds]  - ids to skip (e.g. already shown / owned)
   * @param {object} [opts]
   * @param {boolean} [opts.includeCurses=false]
   * @param {boolean} [opts.cursesOnly=false]
   * @returns {object[]} array of upgrade defs (length <= count)
   */
  getUpgradePool(count, excludeIds = [], opts = {}) {
    const { includeCurses = false, cursesOnly = false } = opts;
    const exclude = new Set(excludeIds);
    let candidates;
    if (cursesOnly) {
      candidates = CURSE_IDS.slice();
    } else if (includeCurses) {
      candidates = UPGRADE_IDS.slice();
    } else {
      candidates = NON_CURSE_IDS.slice();
    }
    // Filter: not excluded, not already applied (unless stackable), prereqs satisfied.
    candidates = candidates.filter((id) => {
      if (exclude.has(id)) return false;
      const c = this.canApply(id);
      return c.ok;
    });
    // Fisher-Yates shuffle using injected RNG (deterministic) or Math.random fallback.
    const rng = this.rng;
    const rand = rng && typeof rng.float === 'function'
      ? () => rng.float()
      : () => Math.random();
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = candidates[i]; candidates[i] = candidates[j]; candidates[j] = tmp;
    }
    const n = Math.max(0, Math.min(count | 0, candidates.length));
    return candidates.slice(0, n).map((id) => this.registry[id]);
  }

  /** Snapshot for debug / save. */
  serialize() {
    return {
      applied: this.applied.slice(),
      meta: { ...this.meta },
    };
  }


  /**
   * Resolve a stat path into { target, key } where target[key] is the field
   * to mutate. Wildcards ('weapon.*.damage') are expanded by the caller.
   */
  _resolveTargets(path) {
    if (typeof path !== 'string' || !path) return [];
    const parts = path.split('.');
    const root = parts[0];
    if (root === 'ship') {
      if (!this.ship || !this.ship.opts) return [];
      const key = parts.slice(1).join('.');
      if (!key) return [];
      return [{ target: this.ship.opts, key, root: 'ship' }];
    }
    if (root === 'weapon') {
      if (!this.weapons || !this.weapons.defs) return [];
      const wid = parts[1];
      const key = parts.slice(2).join('.');
      if (!key) return [];
      if (wid === '*') {
        const out = [];
        for (const id of Object.keys(this.weapons.defs)) {
          const def = this.weapons.defs[id];
          if (def && key in def) out.push({ target: def, key, root: 'weapon' });
        }
        return out;
      }
      const def = this.weapons.defs[wid];
      if (!def) return [];
      if (!(key in def)) return [];
      return [{ target: def, key, root: 'weapon' }];
    }
    if (root === 'meta') {
      const key = parts.slice(1).join('.');
      if (!key) return [];
      return [{ target: this.meta, key, root: 'meta' }];
    }
    return [];
  }

  _applyEffect(eff) {
    if (!eff || typeof eff !== 'object') return;
    const { stat, operator, value } = eff;
    const targets = this._resolveTargets(stat);
    if (targets.length === 0) return;
    for (const { target, key, root } of targets) {
      const prev = target[key];
      let next;
      switch (operator) {
        case 'add': {
          const base = typeof prev === 'number' ? prev : 0;
          next = base + Number(value);
          break;
        }
        case 'mul': {
          const base = typeof prev === 'number' ? prev : 0;
          next = base * Number(value);
          break;
        }
        case 'set': {
          next = value;
          break;
        }
        default: return;
      }
      if (typeof next === 'number' && !Number.isFinite(next)) return;
      target[key] = next;

      // Side-effects: clamp live ship state when caps change so the player
      // doesn't end up with health > maxHealth after a +25 max HP roll.
      if (root === 'ship' && this.ship) {
        if (key === 'maxHealth') {
          // Heal proportionally on max HP increases; clamp on decreases.
          if (typeof value === 'number' && operator === 'add' && value > 0) {
            this.ship.health = Math.min(target[key], (this.ship.health || 0) + value);
          } else {
            this.ship.health = Math.min(this.ship.health || 0, target[key]);
          }
        } else if (key === 'maxEnergy') {
          if (typeof value === 'number' && operator === 'add' && value > 0) {
            this.ship.energy = Math.min(target[key], (this.ship.energy || 0) + value);
          } else {
            this.ship.energy = Math.min(this.ship.energy || 0, target[key]);
          }
        }
      }
    }
  }
}

// Convenience: list helpers used by the card UI in WO-03-U1/U2.
export function listByCategory(category) {
  return UPGRADE_IDS.filter((id) => UPGRADES[id].category === category)
    .map((id) => UPGRADES[id]);
}

export function listByRarity(rarity) {
  return UPGRADE_IDS.filter((id) => UPGRADES[id].rarity === rarity)
    .map((id) => UPGRADES[id]);
}
