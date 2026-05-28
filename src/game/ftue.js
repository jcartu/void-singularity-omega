// First-Time User Experience (FTUE) — gentle on-ramp for new players.
//
// SPRINT-09 polish: teaches movement, fire, dash, special, and the gravity-well
// pull within the first ~60 seconds of play, without blocking gameplay and
// without ever pestering returning players.
//
// Mechanics:
//   * SaveManager flag `ftueComplete` gates the entire system. If the flag is
//     already set on construction, the manager is inert: isFTUE() === false,
//     getDifficultyMod() === 1, no overlay, no listeners. Returning-player
//     cost is exactly one save-load + one boolean check.
//   * While active, a small top-center DOM overlay surfaces one contextual
//     hint at a time. Hints disappear the moment the player demonstrates the
//     skill (e.g. first WASD press dismisses the movement hint).
//   * The first biome is tuned to ~0.65× spawn budget via the director's
//     `budgetMultiplier` hook. The mod releases automatically once the FTUE
//     completes (first biome cleared, 120s elapsed, Escape pressed, or
//     run ends).
//   * Persistence is opt-in: markComplete() writes the flag through SaveManager
//     immediately so a reload in the middle of run 2 doesn't replay the hints.
//
// MUST NOT:
//   * Play audio (S05's bus events are not emitted by FTUE itself).
//   * Block input or pause gameplay — overlay is pointer-events:none.
//   * Mutate game state on returning players.
//   * Touch the run state machine directly (talks through bus + difficulty mod).

const STYLE_ID = 'omega-ftue-style';

const FTUE_CSS = `
#omega-ftue {
  position: fixed; left: 50%; top: 92px;
  transform: translate(-50%, -12px);
  z-index: 180; pointer-events: none;
  font-family: ui-monospace, "JetBrains Mono", "Courier New", monospace;
  color: #cfe9ff; letter-spacing: 0.22em; text-transform: uppercase;
  min-width: 320px; max-width: 80vw;
  padding: 12px 22px;
  background: rgba(6, 12, 28, 0.78);
  border: 1px solid rgba(120, 200, 255, 0.35);
  border-radius: 6px;
  backdrop-filter: blur(4px);
  box-shadow: 0 0 24px rgba(120, 200, 255, 0.18);
  opacity: 0;
  transition: opacity 280ms ease, transform 280ms ease;
  text-align: center;
}
#omega-ftue.show { opacity: 1; transform: translate(-50%, 0); }
#omega-ftue .ftue-keys {
  font-size: 13px; color: #ffffff; letter-spacing: 0.28em;
  text-shadow: 0 0 10px rgba(120, 200, 255, 0.55);
  margin-bottom: 4px;
}
#omega-ftue .ftue-msg {
  font-size: 10px; color: rgba(207, 233, 255, 0.78);
  letter-spacing: 0.22em; text-transform: uppercase;
}
#omega-ftue .ftue-skip {
  margin-top: 6px;
  font-size: 8px; color: rgba(207, 233, 255, 0.35);
  letter-spacing: 0.32em;
}
#omega-ftue-pull {
  position: fixed; left: 50%; bottom: 110px;
  transform: translateX(-50%);
  z-index: 170; pointer-events: none;
  font-family: ui-monospace, "JetBrains Mono", monospace;
  font-size: 11px; letter-spacing: 0.3em; text-transform: uppercase;
  color: #ff8ad0;
  text-shadow: 0 0 10px rgba(255, 92, 242, 0.55);
  padding: 6px 14px;
  border: 1px solid rgba(255, 92, 242, 0.5);
  border-radius: 4px;
  background: rgba(20, 6, 28, 0.72);
  opacity: 0; transition: opacity 200ms ease;
}
#omega-ftue-pull.show { opacity: 1; animation: omega-ftue-pulse 1.6s ease-in-out infinite; }
@keyframes omega-ftue-pulse {
  0%, 100% { box-shadow: 0 0 12px rgba(255, 92, 242, 0.25); }
  50%      { box-shadow: 0 0 24px rgba(255, 92, 242, 0.55); }
}
`;

/** Built-in hint catalog. Each entry: { keys, msg, contexts: string[] }. */
const HINTS = Object.freeze({
  move: {
    keys: 'WASD · ↑ ← ↓ →',
    msg: 'Move — drift through the void',
  },
  fire: {
    keys: 'LMB · F',
    msg: 'Fire — hold to chain shots',
  },
  dash: {
    keys: 'SPACE · SHIFT',
    msg: 'Dash — short blink with i-frames',
  },
  special: {
    keys: 'Z · X · C · V',
    msg: 'Specials — burst abilities',
  },
  upgrade: {
    keys: '1 · 2 · 3',
    msg: 'Pick an upgrade — survive longer',
  },
  gravity: {
    keys: 'GRAVITY',
    msg: 'The singularity pulls — thrust outward',
  },
});

/** Stage delay timings (seconds) for hint progression when player is passive. */
const STAGE_TIMINGS = Object.freeze({
  move:    0.0,
  fire:    3.5,
  dash:   12.0,
  special: 22.0,
});

/** Auto-dismiss durations (seconds) per hint so the overlay never lingers. */
const HINT_DURATIONS = Object.freeze({
  move:     8.0,
  fire:     6.0,
  dash:     8.0,
  special:  9.0,
  upgrade:  6.0,
  gravity:  5.0,
});

/** Maximum FTUE duration (hard cap). */
const FTUE_MAX_DURATION = 120.0;

/** Difficulty multiplier applied to director budget during FTUE. */
const FTUE_DIFFICULTY_MOD = 0.65;

/** Distance from gravity well within which the pull-hint surfaces (units). */
const FTUE_GRAVITY_HINT_RADIUS = 14;
const FTUE_GRAVITY_HINT_DWELL = 0.4; // seconds inside radius before showing

export class FTUEManager {
  /**
   * @param {object} deps
   * @param {object} [deps.bus]     EventBus — for fire/dash/upgrade/run events.
   * @param {object} [deps.save]    SaveManager — for ftueComplete persistence.
   * @param {object} [deps.ship]    Ship — for movement + gravity proximity polling.
   * @param {object} [deps.gravity] { position:{x,z} } — well center.
   * @param {HTMLElement} [deps.mount] DOM mount (defaults to document.body).
   * @param {Document} [deps.doc]   Document override for headless tests.
   * @param {Window}   [deps.win]   Window override for headless tests.
   */
  constructor({
    bus = null,
    save = null,
    ship = null,
    gravity = null,
    mount = null,
    doc = (typeof document !== 'undefined' ? document : null),
    win = (typeof window !== 'undefined' ? window : null),
  } = {}) {
    this._bus = bus;
    this._save = save;
    this._ship = ship;
    this._gravity = gravity;
    this._doc = doc;
    this._win = win;
    this._mount = mount || (doc ? doc.body : null);

    // Load persisted state. If save layer is unavailable we still run an
    // ephemeral FTUE (useful in headless tests / SSR).
    this._saveData = null;
    try { this._saveData = save?.load ? save.load() : null; } catch { /* noop */ }
    this._complete = !!(this._saveData && this._saveData.ftueComplete);

    // Per-skill demonstration flags. Setting a flag dismisses any showing
    // hint for that skill and prevents it from re-queueing.
    this._seen = {
      move: false, fire: false, dash: false, special: false,
      upgrade: false, gravity: false,
    };

    this._elapsed = 0;
    this._activeHint = null;        // currently-displayed hint key or null
    this._activeHintT = 0;          // seconds the active hint has been visible
    this._gravityDwell = 0;         // seconds dwelled inside well radius
    this._wavesCleared = 0;
    this._unsubs = [];
    this._disposed = false;

    if (this._complete) return;     // returning player: become inert.

    this._injectStyle();
    this._buildOverlay();
    this._bindEvents();
    this._bindKeys();

    // Seed the first hint (movement) immediately so the player sees direction
    // from frame 1. It'll auto-dismiss on first WASD press or after timeout.
    this._showHint('move');
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** True while the FTUE is active (first-time player, not yet completed). */
  isFTUE() { return !this._complete && !this._disposed; }

  /**
   * Difficulty multiplier to apply to director spawn budget during the FTUE.
   * Returns 1.0 once FTUE has completed.
   */
  getDifficultyMod() {
    return this.isFTUE() ? FTUE_DIFFICULTY_MOD : 1.0;
  }

  /**
   * Look up the catalog hint for a context key. Useful for tests and for
   * HUD consumers that want to render the hint differently.
   * @param {string} context one of 'move'|'fire'|'dash'|'special'|'upgrade'|'gravity'
   */
  getHint(context) {
    const h = HINTS[context];
    return h ? { ...h, context } : null;
  }

  /**
   * Persistently mark the FTUE as complete. Idempotent. Tears down the
   * overlay and stops emitting hints. Called automatically on Escape, on
   * the first biome:complete, on run:over / run:victory, and on the
   * hard time cap.
   */
  markComplete(reason = 'manual') {
    if (this._complete) return;
    this._complete = true;
    // Persist if possible. Errors are non-fatal — overlay is already gone.
    if (this._save && typeof this._save.save === 'function') {
      try {
        const data = (this._saveData && typeof this._saveData === 'object')
          ? this._saveData
          : (this._save.load ? this._save.load() : {});
        data.ftueComplete = true;
        this._save.save(data);
        this._saveData = data;
      } catch { /* noop */ }
    }
    this._hideOverlay();
    if (this._bus) {
      try { this._bus.emit('ftue:complete', { reason }); } catch { /* noop */ }
    }
  }

  /**
   * Frame tick. Advances FTUE timers, evaluates passive hint progression,
   * and watches the gravity-well proximity. dt in seconds.
   */
  update(dt) {
    if (this._complete || this._disposed) return;
    if (!Number.isFinite(dt) || dt <= 0) return;

    this._elapsed += dt;

    // Hard time cap — graduates the player even if they've been idle.
    if (this._elapsed >= FTUE_MAX_DURATION) {
      this.markComplete('time_cap');
      return;
    }

    // Movement detection by polling ship velocity (input-agnostic fallback —
    // the keydown listener also catches WASD edges).
    if (!this._seen.move && this._ship && this._ship.velocity) {
      const v = this._ship.velocity;
      if ((v.x * v.x + v.z * v.z) > 1.0) {
        this._markSeen('move');
      }
    }

    // Gravity-well proximity hint: dwell inside FTUE_GRAVITY_HINT_RADIUS for
    // a short moment to ensure the pull is being felt, not a flyby.
    if (!this._seen.gravity && this._ship && this._gravity) {
      const sp = this._ship.position;
      const gp = this._gravity.position;
      const dx = (sp?.x ?? 0) - (gp?.x ?? 0);
      const dz = (sp?.z ?? 0) - (gp?.z ?? 0);
      const r = Math.hypot(dx, dz);
      if (r < FTUE_GRAVITY_HINT_RADIUS) {
        this._gravityDwell += dt;
        if (this._gravityDwell >= FTUE_GRAVITY_HINT_DWELL && this._activeHint !== 'gravity') {
          // Surface the pull warning. It does NOT block the active skill hint
          // — it has its own dedicated DOM node.
          this._showPullHint(true);
        }
      } else {
        this._gravityDwell = Math.max(0, this._gravityDwell - dt * 2);
        if (this._gravityDwell <= 0 && this._pullVisible) {
          this._showPullHint(false);
        }
      }
    }

    // Advance the active hint and auto-dismiss when its window elapses.
    if (this._activeHint) {
      this._activeHintT += dt;
      const dur = HINT_DURATIONS[this._activeHint] ?? 6.0;
      if (this._activeHintT >= dur) {
        this._dismissActiveHint();
      }
    }

    // Passive stage progression: when nothing is showing, escalate based on
    // elapsed time. Hints are skipped if the player already demonstrated them.
    if (!this._activeHint) {
      const next = this._nextStage();
      if (next) this._showHint(next);
    }
  }

  /** Bus-friendly event hook for external systems that want to advance state. */
  onAction(context) {
    if (this._complete) return;
    if (context in this._seen) this._markSeen(context);
  }

  /** Tear down listeners + DOM. Idempotent. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._hideOverlay();
    for (const off of this._unsubs) { try { off(); } catch { /* noop */ } }
    this._unsubs.length = 0;
    if (this._onKey && this._win) {
      try { this._win.removeEventListener('keydown', this._onKey); } catch { /* noop */ }
    }
    if (this._root) {
      try { this._root.remove(); } catch { /* noop */ }
      this._root = null;
    }
    if (this._pullEl) {
      try { this._pullEl.remove(); } catch { /* noop */ }
      this._pullEl = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internals — DOM
  // ---------------------------------------------------------------------------

  _injectStyle() {
    if (!this._doc) return;
    if (this._doc.getElementById(STYLE_ID)) return;
    const s = this._doc.createElement('style');
    s.id = STYLE_ID;
    s.textContent = FTUE_CSS;
    this._doc.head.appendChild(s);
  }

  _buildOverlay() {
    if (!this._doc || !this._mount) return;
    const el = this._doc.createElement('div');
    el.id = 'omega-ftue';
    el.innerHTML = `
      <div class="ftue-keys"></div>
      <div class="ftue-msg"></div>
      <div class="ftue-skip">ESC — Skip Tutorial</div>
    `;
    this._mount.appendChild(el);
    this._root = el;
    this._keysEl = el.querySelector('.ftue-keys');
    this._msgEl  = el.querySelector('.ftue-msg');

    const pull = this._doc.createElement('div');
    pull.id = 'omega-ftue-pull';
    pull.textContent = HINTS.gravity.msg;
    this._mount.appendChild(pull);
    this._pullEl = pull;
    this._pullVisible = false;
  }

  _showHint(context) {
    if (this._complete || this._seen[context]) return;
    const h = HINTS[context];
    if (!h || !this._root) return;
    this._activeHint = context;
    this._activeHintT = 0;
    this._keysEl.textContent = h.keys;
    this._msgEl.textContent  = h.msg;
    // Force reflow so re-show animation re-plays.
    this._root.classList.remove('show');
    // eslint-disable-next-line no-unused-expressions
    void this._root.offsetWidth;
    this._root.classList.add('show');
    if (this._bus) {
      try { this._bus.emit('ftue:hint', { context, hint: h }); } catch { /* noop */ }
    }
  }

  _dismissActiveHint() {
    if (!this._activeHint) return;
    this._activeHint = null;
    this._activeHintT = 0;
    if (this._root) this._root.classList.remove('show');
  }

  _showPullHint(on) {
    if (!this._pullEl) return;
    if (on && this._seen.gravity) return;
    this._pullEl.classList.toggle('show', !!on);
    this._pullVisible = !!on;
    if (on) {
      // Once shown, mark gravity as demonstrated after a brief moment so we
      // don't nag the player every approach.
      if (this._win && typeof this._win.setTimeout === 'function') {
        this._win.setTimeout(() => {
          if (!this._complete) this._markSeen('gravity');
          if (this._pullEl) {
            this._pullEl.classList.remove('show');
            this._pullVisible = false;
          }
        }, 2400);
      } else {
        this._seen.gravity = true;
      }
    }
  }

  _hideOverlay() {
    if (this._root) this._root.classList.remove('show');
    if (this._pullEl) {
      this._pullEl.classList.remove('show');
      this._pullVisible = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Internals — event/key wiring
  // ---------------------------------------------------------------------------

  _bindEvents() {
    const bus = this._bus;
    if (!bus || typeof bus.on !== 'function') return;
    const sub = (name, fn) => { try { this._unsubs.push(bus.on(name, fn)); } catch { /* noop */ } };

    // Weapons emit 'projectile:spawn' on each fired bullet. We also catch the
    // singularity-grenade/dash-nuke bursts via 'weapon:fire' if present.
    sub('projectile:spawn', () => this._markSeen('fire'));
    sub('weapon:fire',      () => this._markSeen('fire'));

    // Ship's dash emits 'sfx:dash' for the audio bus — repurpose as the
    // canonical signal that the player has dashed at least once.
    sub('sfx:dash', () => this._markSeen('dash'));

    // Secondary weapons (Z/X/C/V) — keydown handler covers this too, but the
    // bus event is more reliable (fires only on successful spend).
    sub('weapon:special', () => this._markSeen('special'));

    // Upgrade screen surfaced → the player gets to read the cards. Mark the
    // upgrade hint as seen the moment one is picked or skipped.
    sub('upgrade:offer',    () => this._showHint('upgrade'));
    sub('upgrade:picked',   () => this._markSeen('upgrade'));
    sub('upgrade:skipped',  () => this._markSeen('upgrade'));
    sub('upgrade:selected', () => this._markSeen('upgrade'));

    // First biome cleared → graduate the player off training wheels.
    sub('biome:complete', () => this.markComplete('biome_complete'));

    // End-of-run signals — either outcome terminates the FTUE for safety.
    sub('run:over',     () => this.markComplete('run_over'));
    sub('run:victory',  () => this.markComplete('run_victory'));

    // Track wave completions for stage gating (special hint surfaces after
    // the first wave clear, matching the run flow's first-upgrade window).
    sub('wave:complete', () => {
      this._wavesCleared += 1;
    });
  }

  _bindKeys() {
    if (!this._win) return;
    this._onKey = (e) => {
      if (this._complete) return;
      const code = e.code || '';
      // WASD / arrows → movement demonstrated.
      if (code === 'KeyW' || code === 'KeyA' || code === 'KeyS' || code === 'KeyD'
          || code === 'ArrowUp' || code === 'ArrowDown'
          || code === 'ArrowLeft' || code === 'ArrowRight') {
        this._markSeen('move');
      }
      // Fire (F) — mouse clicks are caught via bus 'projectile:spawn'.
      else if (code === 'KeyF') {
        this._markSeen('fire');
      }
      // Dash.
      else if (code === 'Space' || code === 'ShiftLeft' || code === 'ShiftRight') {
        this._markSeen('dash');
      }
      // Specials.
      else if (code === 'KeyZ' || code === 'KeyX' || code === 'KeyC' || code === 'KeyV') {
        this._markSeen('special');
      }
      // Manual skip.
      else if (code === 'Escape') {
        this.markComplete('escape');
      }
    };
    this._win.addEventListener('keydown', this._onKey);
  }

  // ---------------------------------------------------------------------------
  // Internals — stage progression
  // ---------------------------------------------------------------------------

  _markSeen(key) {
    if (this._complete || !(key in this._seen)) return;
    if (this._seen[key]) return;
    this._seen[key] = true;
    if (this._activeHint === key) this._dismissActiveHint();
    if (this._bus) {
      try { this._bus.emit('ftue:seen', { context: key }); } catch { /* noop */ }
    }
    // If every skill is demonstrated before the biome ends, graduate early.
    if (this._seen.move && this._seen.fire && this._seen.dash
        && this._seen.special && this._seen.gravity) {
      this.markComplete('all_demonstrated');
    }
  }

  /**
   * Decide which hint (if any) to surface next based on elapsed time and
   * which skills the player has yet to demonstrate. Returns the hint key
   * or null.
   */
  _nextStage() {
    // Strict ordering: move → fire → dash → special. Upgrade hint is event
    // driven (surfaces on 'upgrade:offer'); gravity hint is proximity driven.
    const order = ['move', 'fire', 'dash', 'special'];
    for (const key of order) {
      if (this._seen[key]) continue;
      const delay = STAGE_TIMINGS[key] ?? 0;
      if (this._elapsed >= delay) return key;
      // First un-demonstrated skill not yet due — wait for it; don't skip ahead.
      return null;
    }
    return null;
  }
}

export const FTUE_CONSTANTS = Object.freeze({
  FTUE_MAX_DURATION,
  FTUE_DIFFICULTY_MOD,
  FTUE_GRAVITY_HINT_RADIUS,
  STAGE_TIMINGS,
  HINT_DURATIONS,
  HINTS,
});

export default FTUEManager;
