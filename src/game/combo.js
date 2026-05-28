// Combo / Multiplier engine — the identity mechanic.
//
// Player chains kills to grow a combo counter. Combo decays after `decayTime`
// seconds without a kill. The multiplier is a step function over combo count
// (tiers tuned to give meaningful jumps without being too punishing). Multiplier
// affects currency and score (consumers query getMultiplier()).
//
// Events emitted on the bus (if provided):
//   'combo:changed'      { combo, multiplier, prevMultiplier }
//   'combo:multiplier-up' { combo, multiplier, prevMultiplier }
//   'combo:reset'        { combo: 0, multiplier: 1, peak }
//
// Wiring: pass `bus` and ComboManager auto-subscribes to 'enemy:death'.
// Upgrade hooks: setDecayTime, setMultiplierCap, setResetBonus mutate behavior
// without rebuilding the manager.

export const COMBO_DEFAULTS = Object.freeze({
  decayTime: 2.0,            // seconds of no kills before reset
  multiplierCap: 20,         // hard ceiling
  resetBonus: 0,             // grace kills granted after a reset (upgrade hook)
  // Combo thresholds -> multiplier. Sorted ascending by threshold.
  // Reading: at <combo> kills, multiplier becomes <mult>.
  tiers: [
    { combo: 0,   mult: 1 },
    { combo: 5,   mult: 2 },
    { combo: 15,  mult: 3 },
    { combo: 30,  mult: 5 },
    { combo: 60,  mult: 8 },
    { combo: 100, mult: 12 },
    { combo: 160, mult: 20 },
  ],
});

export class ComboManager {
  /**
   * @param {{
   *   bus?: { on(name:string, cb:Function): Function, emit(name:string, payload:any): void } | null,
   *   opts?: Partial<typeof COMBO_DEFAULTS>,
   * }} [params]
   */
  constructor({ bus = null, opts = {} } = {}) {
    this.opts = { ...COMBO_DEFAULTS, ...opts };
    // Defensive copy of tiers; allow caller override.
    this.tiers = (opts.tiers || COMBO_DEFAULTS.tiers).slice().sort((a, b) => a.combo - b.combo);
    this._bus = bus;
    this._combo = 0;
    this._peak = 0;
    this._multiplier = 1;
    this._decayLeft = 0;
    this._unsub = null;
    if (bus && typeof bus.on === 'function') {
      this._unsub = bus.on('enemy:death', (ev) => {
        // Only credit player kills, not despawn/cleanup causes.
        if (!ev || ev.cause === 'damage') this.onKill(ev?.type ?? null);
      });
    }
  }

  /** Credit a kill. Type is unused today but reserved for per-type weights. */
  onKill(/* enemyType */) {
    const prevMult = this._multiplier;
    this._combo += 1;
    if (this._combo > this._peak) this._peak = this._combo;
    this._decayLeft = this.opts.decayTime;
    this._multiplier = this._computeMultiplier(this._combo);
    if (this._bus) {
      this._bus.emit('combo:changed', {
        combo: this._combo,
        multiplier: this._multiplier,
        prevMultiplier: prevMult,
      });
      if (this._multiplier > prevMult) {
        this._bus.emit('combo:multiplier-up', {
          combo: this._combo,
          multiplier: this._multiplier,
          prevMultiplier: prevMult,
        });
      }
    }
  }

  /** Per-frame tick. Decays combo to zero if no kills land within decayTime. */
  update(dt) {
    if (this._combo <= 0) return;
    this._decayLeft -= dt;
    if (this._decayLeft <= 0) {
      this._fullReset();
    }
  }

  _fullReset() {
    const peak = this._peak;
    this._combo = Math.max(0, this.opts.resetBonus | 0);
    this._peak = this._combo;
    this._decayLeft = this._combo > 0 ? this.opts.decayTime : 0;
    this._multiplier = this._computeMultiplier(this._combo);
    if (this._bus) {
      this._bus.emit('combo:reset', {
        combo: this._combo,
        multiplier: this._multiplier,
        peak,
      });
    }
  }

  /** Force-clear the combo (e.g. player took damage and upgrade penalizes it). */
  reset() { this._fullReset(); }

  getCombo() { return this._combo; }
  getMultiplier() { return this._multiplier; }
  /** Remaining decay seconds. 0 when no combo. */
  getDecayTime() { return Math.max(0, this._decayLeft); }
  /** Ratio in [0,1] of decay time remaining (1 = freshly extended). */
  getDecayRatio() {
    if (this._combo <= 0 || this.opts.decayTime <= 0) return 0;
    return Math.max(0, Math.min(1, this._decayLeft / this.opts.decayTime));
  }
  getPeak() { return this._peak; }

  // --- Upgrade hooks ----------------------------------------------------
  setDecayTime(seconds) {
    this.opts.decayTime = Math.max(0.05, seconds);
    if (this._combo > 0) this._decayLeft = Math.min(this._decayLeft, this.opts.decayTime);
  }
  setMultiplierCap(cap) {
    this.opts.multiplierCap = Math.max(1, cap);
    this._multiplier = this._computeMultiplier(this._combo);
  }
  setResetBonus(n) { this.opts.resetBonus = Math.max(0, n | 0); }

  _computeMultiplier(combo) {
    let m = 1;
    for (let i = 0; i < this.tiers.length; i++) {
      if (combo >= this.tiers[i].combo) m = this.tiers[i].mult; else break;
    }
    return Math.min(m, this.opts.multiplierCap);
  }

  dispose() {
    if (this._unsub) { try { this._unsub(); } catch { /* noop */ } this._unsub = null; }
  }
}
