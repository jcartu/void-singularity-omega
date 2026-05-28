// RunStateMachine — high-level run orchestration.
//
// Wraps the WaveDirector (which owns wave/boss micro-flow) with a player-facing
// macro state machine that gates progression on between-wave choices:
//   biome intro → wave fight → upgrade choice → (shop?) → next wave → … → boss
//   → biome complete → next biome … → final boss → run complete (or run over).
//
// Coordination contract:
//   - The RSM is the ONLY thing that ticks the director. During non-combat
//     states (BIOME_INTRO, WAVE_COMPLETE, UPGRADE_CHOICE, SHOP, BIOME_COMPLETE,
//     RUN_COMPLETE, RUN_OVER) the director is paused; the director's own
//     between-wave breather is therefore inert and the RSM drives the next
//     `director.startWave()` call explicitly.
//   - Director events (`wave:complete`, `boss:encounter`, `boss:complete`,
//     `run:complete`) feed state transitions.
//   - Ship death is polled each tick during combat states.
//
// MUST NOT (per SPRINT-03 scope):
//   - Build UI screens (handled by WO-03-U1/U2 reading getState/getUpgradeCards).
//   - Implement boss AI (SPRINT-06 — current placeholder auto-resolves the boss
//     slot after BOSS_PLACEHOLDER_DURATION so runs complete end-to-end).
//   - Persist anything across runs (SPRINT-07 meta-progression).

import { BIOMES } from './director.js';

/** Run-level states. UI/HUD code keys off these. */
export const RUN_STATE = Object.freeze({
  MENU:           'menu',
  BIOME_INTRO:    'biome_intro',
  WAVE_ACTIVE:    'wave_active',
  WAVE_COMPLETE:  'wave_complete',
  UPGRADE_CHOICE: 'upgrade_choice',
  SHOP:           'shop',
  BOSS_FIGHT:     'boss_fight',
  BIOME_COMPLETE: 'biome_complete',
  RUN_COMPLETE:   'run_complete',
  RUN_OVER:       'run_over',
});

/** Seconds of title-card fade before the wave begins. */
const BIOME_INTRO_DURATION = 3.0;
/** Seconds of post-boss celebration before transitioning to next biome. */
const BIOME_COMPLETE_DURATION = 2.0;
/** Placeholder boss duration — SPRINT-06 replaces this with real boss AI. */
const BOSS_PLACEHOLDER_DURATION = 2.5;
/** How many upgrade cards to present per choice. */
const UPGRADE_CARD_COUNT = 3;
/** Show shop after every Nth wave (matches biome boss cadence). */
const SHOP_EVERY_N_WAVES = 5;

export class RunStateMachine {
  /**
   * @param {object} deps
   * @param {object} deps.ship          - Ship instance (reads .health for death)
   * @param {import('./director.js').WaveDirector} deps.director
   * @param {import('./upgrades.js').UpgradeManager} deps.upgrades
   * @param {{ currency: object, shop: object }} deps.economy
   * @param {import('../engine/events.js').EventBus} [deps.bus]
   * @param {object} [deps.rng]
   */
  constructor({ ship, director, upgrades, economy, bus = null, rng = null } = {}) {
    if (!director) throw new Error('RunStateMachine: director required');
    if (!upgrades) throw new Error('RunStateMachine: upgrades required');
    if (!economy || !economy.currency || !economy.shop) {
      throw new Error('RunStateMachine: economy { currency, shop } required');
    }
    this.ship = ship || null;
    this.director = director;
    this.upgrades = upgrades;
    this.currency = economy.currency;
    this.shop = economy.shop;
    this.bus = bus;
    this.rng = rng;

    this.state = RUN_STATE.MENU;
    this._prevState = RUN_STATE.MENU;
    this._timer = 0;

    this.shipType = null;
    this.seed = 0;

    // Snapshots stashed for getState / UI consumers.
    this._upgradeCards = [];
    this._lastCompletedWave = 0; // 1-based; 0 = none completed yet
    this._biomeIndexCache = 0;

    // Run stats — surfaced on RUN_OVER / RUN_COMPLETE for meta-progression (S07).
    this._stats = this._freshStats();

    // Subscribe to director + combat events.
    this._unsubs = [];
    if (this.bus) {
      this._unsubs.push(this.bus.on('wave:complete',  this._onWaveComplete));
      this._unsubs.push(this.bus.on('boss:encounter', this._onBossEncounter));
      this._unsubs.push(this.bus.on('boss:complete',  this._onBossComplete));
      this._unsubs.push(this.bus.on('run:complete',   this._onDirectorRunComplete));
      this._unsubs.push(this.bus.on('enemy:death',    this._onEnemyDeath));
    }
  }

  // ---- public API ---------------------------------------------------------

  /** Begin a new run. Resets state, director, upgrades-applied counters. */
  startRun(shipType = 'default', seed = 0xC0FFEE) {
    this.shipType = shipType;
    this.seed = seed >>> 0;
    this._stats = this._freshStats();
    this._stats.shipType = shipType;
    this._stats.seed = this.seed;
    this._lastCompletedWave = 0;
    this._upgradeCards.length = 0;

    // Seed starting currency from any meta upgrade (e.g. Trust Fund).
    const startCash = this.upgrades?.meta?.startingCurrency || 0;
    if (this.currency.setBalance) this.currency.setBalance(startCash);

    this.director.startRun(this.seed);
    this._biomeIndexCache = 0;
    this._enterBiomeIntro();
    if (this.bus) this.bus.emit('run:start', { shipType, seed: this.seed });
  }

  /** Frame tick. Drives director only during combat states. */
  update(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;

    // Death poll — applies during any state where the ship can take damage.
    if ((this.state === RUN_STATE.WAVE_ACTIVE || this.state === RUN_STATE.BOSS_FIGHT)
        && this.ship && (this.ship.health <= 0 || this.ship.alive === false)) {
      this._enterRunOver();
      return;
    }

    this._timer += dt;

    switch (this.state) {
      case RUN_STATE.BIOME_INTRO:
        if (this._timer >= BIOME_INTRO_DURATION) this._beginWave();
        break;

      case RUN_STATE.WAVE_ACTIVE:
      case RUN_STATE.BOSS_FIGHT:
        this.director.update(dt);
        // Boss placeholder: auto-resolve after BOSS_PLACEHOLDER_DURATION so the
        // run loop is testable end-to-end without S06 boss code.
        if (this.state === RUN_STATE.BOSS_FIGHT
            && this._timer >= BOSS_PLACEHOLDER_DURATION) {
          this.director.completeBoss();
        }
        break;

      case RUN_STATE.WAVE_COMPLETE:
        // Single-tick gate so HUD has at least one frame to render the banner.
        this._enterUpgradeChoice();
        break;

      case RUN_STATE.BIOME_COMPLETE:
        if (this._timer >= BIOME_COMPLETE_DURATION) {
          if (this._biomeIndexCache >= BIOMES.length) {
            this._enterRunComplete();
          } else {
            this._enterBiomeIntro();
          }
        }
        break;

      // MENU / UPGRADE_CHOICE / SHOP / RUN_OVER / RUN_COMPLETE: idle (await input)
      default: break;
    }
  }

  /** Player picks card 0..UPGRADE_CARD_COUNT-1. */
  selectUpgrade(index) {
    if (this.state !== RUN_STATE.UPGRADE_CHOICE) return false;
    const card = this._upgradeCards[index | 0];
    if (!card) return false;
    const applied = this.upgrades.apply(card.id);
    if (applied && this.bus) this.bus.emit('upgrade:picked', { id: card.id, card });
    this._stats.upgrades.push(card.id);
    this._afterUpgradeChoice();
    return applied;
  }

  /** Player declines all cards. */
  skipUpgrade() {
    if (this.state !== RUN_STATE.UPGRADE_CHOICE) return false;
    if (this.bus) this.bus.emit('upgrade:skipped', {});
    this._afterUpgradeChoice();
    return true;
  }

  /** Buy a shop item by id; returns the shop's purchase result. */
  purchaseShopItem(itemId) {
    if (this.state !== RUN_STATE.SHOP) return { ok: false, reason: 'not_in_shop' };
    return this.shop.purchase(itemId);
  }

  /** Leave the shop and start the next wave (or boss). */
  closeShop() {
    if (this.state !== RUN_STATE.SHOP) return false;
    this.shop.closeShop();
    this._beginWave();
    return true;
  }

  /** Current state + context snapshot. UI/HUD reads this every frame. */
  getState() {
    const waveState = this.director.getWaveState ? this.director.getWaveState() : null;
    return {
      state: this.state,
      previous: this._prevState,
      timer: this._timer,
      biomeIndex: this._biomeIndexCache,
      biome: waveState ? waveState.biome : null,
      biomeName: waveState ? waveState.biomeName : null,
      wave: waveState ? waveState.wave : 0,
      globalWave: waveState ? waveState.globalWave : 0,
      totalWaves: waveState ? waveState.totalWaves : 0,
      lastCompletedWave: this._lastCompletedWave,
      cards: this._upgradeCards.slice(),
      shopInventory: this.state === RUN_STATE.SHOP ? this.shop.getInventory() : [],
      balance: this.currency.getBalance ? this.currency.getBalance() : 0,
      stats: { ...this._stats, upgrades: this._stats.upgrades.slice() },
    };
  }

  /** Current upgrade cards (or [] when not in UPGRADE_CHOICE). */
  getUpgradeCards() { return this._upgradeCards.slice(); }

  /** Current shop inventory (or [] when not in SHOP). */
  getShopInventory() {
    if (this.state !== RUN_STATE.SHOP) return [];
    return this.shop.getInventory ? this.shop.getInventory() : [];
  }

  /** Final run report (also emitted via 'run:over' / 'run:victory'). */
  getRunSummary() {
    const balance = this.currency.getBalance ? this.currency.getBalance() : 0;
    const currencyStats = this.currency.getStats ? this.currency.getStats() : null;
    const result =
      this.state === RUN_STATE.RUN_COMPLETE ? 'win' :
      this.state === RUN_STATE.RUN_OVER     ? 'lose' :
      'incomplete';
    return {
      result,
      shipType: this.shipType,
      seed: this.seed,
      biomeIndex: this._biomeIndexCache,
      lastCompletedWave: this._lastCompletedWave,
      kills: this._stats.kills,
      wavesCleared: this._stats.waves,
      bossesKilled: this._stats.bosses,
      upgrades: this._stats.upgrades.slice(),
      currencyEarned: currencyStats ? currencyStats.earned : this._stats.currencyEarned,
      currencySpent: currencyStats ? currencyStats.spent : 0,
      balance,
      durationMs: performance.now() - this._stats.startTime,
    };
  }

  /** Tear down bus subscriptions. */
  dispose() {
    for (const off of this._unsubs) { try { off(); } catch { /* noop */ } }
    this._unsubs.length = 0;
  }

  // ---- internals: transitions --------------------------------------------

  _freshStats() {
    return {
      shipType: null,
      seed: 0,
      kills: 0,
      waves: 0,
      bosses: 0,
      currencyEarned: 0,
      upgrades: [],
      startTime: typeof performance !== 'undefined' ? performance.now() : 0,
    };
  }

  _setState(next) {
    if (this.state === next) return;
    this._prevState = this.state;
    this.state = next;
    this._timer = 0;
    if (this.bus) this.bus.emit('run:state', { from: this._prevState, to: next });
  }

  _enterBiomeIntro() {
    const ws = this.director.getWaveState ? this.director.getWaveState() : null;
    const biomeIndex = ws ? ws.biomeIndex : this._biomeIndexCache;
    this._biomeIndexCache = biomeIndex;
    this._setState(RUN_STATE.BIOME_INTRO);
    if (this.bus) {
      this.bus.emit('biome:enter', {
        biome: ws ? ws.biome : null,
        biomeIndex,
        name: ws ? ws.biomeName : null,
      });
    }
  }

  _beginWave() {
    // Apply per-wave shield from upgrades (e.g. Wave Aegis).
    const startShield = this.upgrades?.meta?.startingShield || 0;
    if (startShield > 0 && this.ship) {
      this.ship.shield = (this.ship.shield || 0) + startShield;
    }
    this._setState(RUN_STATE.WAVE_ACTIVE);
    // Director's startWave handles both normal waves and the boss-gap slot
    // automatically based on its internal wave counter.
    this.director.startWave();
  }

  _enterUpgradeChoice() {
    let cards = [];
    if (this.upgrades.getUpgradePool) {
      try {
        cards = this.upgrades.getUpgradePool(UPGRADE_CARD_COUNT, [], { includeCurses: false }) || [];
      } catch { cards = []; }
    }
    this._upgradeCards = cards;
    // Edge case: nothing to offer (all upgrades owned). Skip straight through.
    if (cards.length === 0) {
      this._afterUpgradeChoice();
      return;
    }
    this._setState(RUN_STATE.UPGRADE_CHOICE);
    if (this.bus) this.bus.emit('upgrade:offer', { cards: cards.slice() });
  }

  _afterUpgradeChoice() {
    this._upgradeCards = [];
    // Shop slot every Nth completed wave (5, 10, 15, 20, 25 by default).
    if (this._lastCompletedWave > 0
        && this._lastCompletedWave % SHOP_EVERY_N_WAVES === 0) {
      this._enterShop();
    } else {
      this._beginWave();
    }
  }

  _enterShop() {
    const ws = this.director.getWaveState ? this.director.getWaveState() : null;
    const biome = ws ? ws.biome : 'void';
    const wave  = ws ? ws.globalWave : this._lastCompletedWave;
    if (this.shop.generateShop) this.shop.generateShop(biome, wave);
    if (this.shop.openShop)     this.shop.openShop(biome, wave);
    this._setState(RUN_STATE.SHOP);
  }

  _enterRunOver() {
    this._setState(RUN_STATE.RUN_OVER);
    const summary = this.getRunSummary();
    if (this.bus) this.bus.emit('run:over', summary);
  }

  _enterRunComplete() {
    this._setState(RUN_STATE.RUN_COMPLETE);
    const summary = this.getRunSummary();
    if (this.bus) this.bus.emit('run:victory', summary);
  }

  // ---- internals: bus handlers (arrow props for stable identity) ---------

  _onWaveComplete = (payload) => {
    if (this.state !== RUN_STATE.WAVE_ACTIVE) return;
    const globalWave = payload?.globalWave || (this._lastCompletedWave + 1);
    this._lastCompletedWave = globalWave;
    this._stats.waves = Math.max(this._stats.waves, globalWave);
    // Credit currency for the clear; the director's `currencyBonus` is a
    // breather/normal multiplier — we apply it on top of the base reward.
    if (this.currency && this.currency.earnFromWaveClear) {
      const bonus = payload?.currencyBonus || 1;
      const credited = this.currency.earnFromWaveClear(globalWave - 1);
      if (bonus > 1 && credited > 0 && this.currency.earn) {
        // Top-up the bonus delta as a separate emit so HUD can flash it.
        const extra = Math.floor(credited * (bonus - 1));
        if (extra > 0) this.currency.earn(extra, 'wave:bonus');
      }
      this._stats.currencyEarned += credited;
    }
    this._setState(RUN_STATE.WAVE_COMPLETE);
  };

  _onBossEncounter = (payload) => {
    // Director moves to PHASE.BOSS; we surface a BOSS_FIGHT state. Re-emitting
    // here is redundant with the director's own emit, but keeps a single
    // contract for HUD listeners that only care about run-level events.
    this._biomeIndexCache = payload?.biomeIndex ?? this._biomeIndexCache;
    this._setState(RUN_STATE.BOSS_FIGHT);
  };

  _onBossComplete = (payload) => {
    if (this.state !== RUN_STATE.BOSS_FIGHT) return;
    this._stats.bosses += 1;
    // Director already advanced biomeIndex internally; mirror it here.
    const ws = this.director.getWaveState ? this.director.getWaveState() : null;
    this._biomeIndexCache = ws ? ws.biomeIndex : (this._biomeIndexCache + 1);
    this._setState(RUN_STATE.BIOME_COMPLETE);
    if (this.bus) {
      this.bus.emit('biome:complete', {
        biomeIndex: payload?.biomeIndex ?? this._biomeIndexCache,
        biome: payload?.biome,
      });
    }
  };

  _onDirectorRunComplete = (/* payload */) => {
    // Director signals final boss cleared. If we're already mid-transition
    // (BIOME_COMPLETE), let update() catch the run-complete next tick — but
    // mark biomeIndex past the end so the transition routes correctly.
    this._biomeIndexCache = BIOMES.length;
    if (this.state !== RUN_STATE.BIOME_COMPLETE && this.state !== RUN_STATE.RUN_COMPLETE) {
      this._enterRunComplete();
    }
  };

  _onEnemyDeath = (/* payload */) => {
    if (this.state === RUN_STATE.WAVE_ACTIVE || this.state === RUN_STATE.BOSS_FIGHT) {
      this._stats.kills += 1;
    }
  };
}

export default RunStateMachine;
