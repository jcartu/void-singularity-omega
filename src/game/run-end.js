// RunEndManager — orchestrates run-end flow: summary, grants, unlocks,
// achievements, prestige shards, atomic save.
//
// SCOPE (WO-07-C4, SPRINT-07):
//   * Listens for 'run:over' / 'run:victory' from the RunStateMachine.
//   * Builds a canonical run summary (deterministic shape regardless of result).
//   * Grants meta currency (shards) using prestige modifiers + combo multiplier.
//   * Probes unlocks/achievements managers with the summary; collects newly-
//     awarded ids and writes them to the save blob.
//   * Updates aggregate stats (totalRuns, totalDeaths, totalWins, playtime,
//     dailyBest).
//   * Persists via SaveManager.save() — atomic, never partial.
//   * Emits 'run:summary' (always), 'run:rewards' (currency/shards granted),
//     'run:unlocked' (per-unlock), 'achievement:unlocked' (per-achievement),
//     and 'run:saved' (post-persist) for UI consumption.
//
// External managers (prestige / unlocks / achievements) are duck-typed and
// optional. RunEndManager only requires:
//   prestige.getShardMultiplier?()   -> number (default 1)
//   prestige.grantShards?(n)         -> void  (else writes save.prestige.shards)
//   unlocks.evaluate?(summary, save) -> string[] of newly-unlocked ids
//   achievements.evaluate?(summary, save) -> string[] of newly-unlocked ids
//
// MUST NOT:
//   * Block the run state machine (run-end runs synchronously after RUN_OVER
//     is entered; no async I/O on the critical path).
//   * Lose progress on mid-frame kill — save is one atomic write.
//   * Double-process the same run (idempotent on duplicate 'run:over' emits).

const DEFAULT_COMBO_TO_MULT = (combo) => 1 + Math.min(combo, 100) * 0.01;

export class RunEndManager {
  /**
   * @param {object} deps
   * @param {object} deps.economy        - { currency } from createEconomy
   * @param {object} [deps.prestige]     - prestige system (optional)
   * @param {object} [deps.unlocks]      - unlocks system (optional)
   * @param {object} [deps.achievements] - achievements system (optional)
   * @param {import('../engine/save.js').SaveManager} deps.save
   * @param {import('../engine/events.js').EventBus} deps.bus
   * @param {(combo:number)=>number} [deps.comboToMultiplier]
   */
  constructor({ economy, prestige = null, unlocks = null, achievements = null,
                save, bus, comboToMultiplier = DEFAULT_COMBO_TO_MULT } = {}) {
    if (!economy || !economy.currency) throw new Error('RunEndManager: economy.currency required');
    if (!save) throw new Error('RunEndManager: save (SaveManager) required');
    if (!bus)  throw new Error('RunEndManager: bus required');

    this._currency     = economy.currency;
    this._prestige     = prestige;
    this._unlocks      = unlocks;
    this._achievements = achievements;
    this._save         = save;
    this._bus          = bus;
    this._comboToMul   = comboToMultiplier;

    this._lastSummary  = null;
    this._processing   = false;   // re-entrancy guard
    this._lastSeed     = null;    // de-dup guard for duplicate run-end emits

    this._unsubs = [
      bus.on('run:over',    (s) => this.onRunEnd(s, false)),
      bus.on('run:victory', (s) => this.onRunEnd(s, true)),
      bus.on('combo:max',   (e) => { this._maxCombo      = Math.max(this._maxCombo,      e?.combo      | 0); }),
      bus.on('combo:multiplier', (e) => { this._maxMult  = Math.max(this._maxMult,  Number(e?.mult)    || 0); }),
      bus.on('run:start',   () => this._resetRunCounters()),
    ];

    this._resetRunCounters();
  }

  /** Tear down bus subscriptions. */
  dispose() {
    for (const off of this._unsubs) { try { off(); } catch { /* noop */ } }
    this._unsubs.length = 0;
  }

  /** Last computed summary (post-grants). Null until first run ends. */
  getRunSummary() { return this._lastSummary; }

  /** Process a run-end. Returns the finalized summary.
   *  `rsmSummary` is the payload from RunStateMachine.getRunSummary(). */
  onRunEnd(rsmSummary, runComplete) {
    if (this._processing) return this._lastSummary;
    // De-dupe: RSM may emit 'run:over' and later 'run:victory' in edge cases.
    const seedKey = `${rsmSummary?.seed ?? 0}:${runComplete ? 'win' : 'lose'}`;
    if (this._lastSeed === seedKey) return this._lastSummary;
    this._processing = true;

    try {
      const save = this._save.load();
      const summary = this._buildSummary(rsmSummary, runComplete);

      // 1) Currency grant (in-run currency is already accrued; this is the
      //    post-run shard grant against meta currency).
      const shards = this._grantShards(save, summary);
      summary.shardsEarned = shards;

      // 2) Unlock checks.
      const newUnlocks = this._evalSet(this._unlocks, summary, save, save.unlocks);
      for (const id of newUnlocks) {
        save.unlocks.push(id);
        this._bus.emit('run:unlocked', { id, summary });
      }
      summary.newUnlocks = newUnlocks;

      // 3) Achievement checks.
      const newAchievements = this._evalSet(this._achievements, summary, save, save.achievements);
      for (const id of newAchievements) {
        save.achievements.push(id);
        this._bus.emit('achievement:unlocked', { id, summary });
      }
      summary.newAchievements = newAchievements;

      // 4) Aggregate stats + daily best.
      save.totalRuns     = (save.totalRuns     | 0) + 1;
      save.totalPlaytime = (save.totalPlaytime | 0) + Math.max(0, summary.runDuration | 0);
      if (runComplete) save.totalWins   = (save.totalWins   | 0) + 1;
      else             save.totalDeaths = (save.totalDeaths | 0) + 1;

      const today = _today();
      if (save.dailyBest?.date !== today) save.dailyBest = { date: today, score: 0 };
      if (summary.score > (save.dailyBest.score | 0)) save.dailyBest.score = summary.score;

      // 5) Atomic save.
      const persisted = this._save.save(save);

      this._lastSummary = summary;
      this._lastSeed    = seedKey;

      this._bus.emit('run:summary',  summary);
      this._bus.emit('run:rewards',  {
        shards,
        currencyEarned: summary.currencyEarned,
        multiplier:     summary.shardMultiplier,
        combo:          summary.maxCombo,
      });
      this._bus.emit('run:saved',    { ok: persisted, version: this._save.getVersion() });

      return summary;
    } finally {
      this._processing = false;
    }
  }

  // ---- internals ---------------------------------------------------------

  _resetRunCounters() {
    this._maxCombo = 0;
    this._maxMult  = 0;
    this._lastSeed = null;
  }

  _buildSummary(rsm, runComplete) {
    const currencyStats = this._currency.getStats ? this._currency.getStats() : null;
    const currencyEarned = currencyStats ? currencyStats.earned : (rsm?.currencyEarned | 0);
    const wavesCleared   = rsm?.wavesCleared | 0;
    const bossesKilled   = rsm?.bossesKilled | 0;
    const biomesCleared  = rsm?.biomeIndex   | 0;
    const kills          = rsm?.kills        | 0;
    const upgrades       = Array.isArray(rsm?.upgrades) ? rsm.upgrades.slice() : [];
    const score = _computeScore({ wavesCleared, bossesKilled, biomesCleared, kills, runComplete });

    return {
      runSeed:        rsm?.seed >>> 0,
      shipType:       rsm?.shipType ?? null,
      runDuration:    Math.max(0, rsm?.durationMs | 0),
      biomesCleared,
      wavesCleared,
      bossesKilled,
      enemiesKilled:  kills,
      currencyEarned,
      currencySpent:  rsm?.currencySpent | 0,
      upgradesPicked: upgrades,
      maxCombo:       this._maxCombo | 0,
      maxMultiplier:  Number(this._maxMult) || 0,
      score,
      deathCause:     runComplete ? null : (rsm?.deathCause ?? 'unknown'),
      runComplete:    !!runComplete,
      // populated by onRunEnd:
      shardsEarned:    0,
      shardMultiplier: 1,
      newUnlocks:      [],
      newAchievements: [],
    };
  }

  _grantShards(save, summary) {
    const prestigeMul = this._prestige?.getShardMultiplier?.() ?? 1;
    const comboMul    = this._comboToMul(summary.maxCombo) ?? 1;
    const mul         = Math.max(0, prestigeMul * comboMul);
    summary.shardMultiplier = mul;

    // Base shard formula: progression-weighted.
    //   shards = (waves + biomes*5 + bosses*10 + (win ? 25 : 0)) * mul
    const base = summary.wavesCleared
               + summary.biomesCleared * 5
               + summary.bossesKilled  * 10
               + (summary.runComplete ? 25 : 0);
    const granted = Math.max(0, Math.floor(base * mul));
    if (granted === 0) return 0;

    if (typeof this._prestige?.grantShards === 'function') {
      this._prestige.grantShards(granted);
      // Mirror authoritative value back into save (prestige owns the number).
      const after = this._prestige?.getShards?.();
      if (Number.isFinite(after)) save.prestige.shards = after | 0;
      else save.prestige.shards = (save.prestige.shards | 0) + granted;
    } else {
      save.prestige.shards = (save.prestige.shards | 0) + granted;
    }
    return granted;
  }

  /** Probe a duck-typed manager for newly-unlocked ids and filter against the
   *  already-owned `owned` array. Returns a fresh array of strings (may be
   *  empty). Tolerant of missing manager / missing method / thrown errors. */
  _evalSet(manager, summary, save, owned) {
    if (!manager) return [];
    let candidates = [];
    try {
      if (typeof manager.evaluate === 'function') {
        candidates = manager.evaluate(summary, save) || [];
      } else if (typeof manager.check === 'function') {
        candidates = manager.check(summary, save) || [];
      }
    } catch { candidates = []; }
    if (!Array.isArray(candidates) || candidates.length === 0) return [];
    const ownedSet = new Set(owned || []);
    const out = [];
    for (const id of candidates) {
      if (typeof id !== 'string' || !id) continue;
      if (ownedSet.has(id)) continue;
      ownedSet.add(id);
      out.push(id);
    }
    return out;
  }
}

function _today() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function _computeScore({ wavesCleared, bossesKilled, biomesCleared, kills, runComplete }) {
  return (kills          * 10)
       + (wavesCleared   * 100)
       + (bossesKilled   * 500)
       + (biomesCleared  * 1000)
       + (runComplete    ? 5000 : 0);
}

export default RunEndManager;
