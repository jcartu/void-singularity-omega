// Pause system — global pause state with bus integration.
//
// Owns a single boolean and emits 'pause:change' on transitions. Consumers
// gate their updates by reading `paused` (cheap) rather than subscribing,
// so this works from any state (menu, wave, boss, shop, run-end).
//
// Sources that pause the game:
//   - explicit user input (Escape / pause button)
//   - document visibility change (alt-tab)
//   - shop / upgrade card screens (caller-driven)
//   - run-over / run-victory (caller-driven)
//
// Sources are tracked as a Set so the game only resumes once ALL sources
// release. This prevents "alt-tab while in shop -> tab back -> game runs
// behind shop overlay" bugs.

export class PauseManager {
  /**
   * @param {{ bus?: import('../engine/events.js').EventBus }} [opts]
   */
  constructor({ bus = null } = {}) {
    this._bus = bus;
    /** Set of string keys currently requesting pause. Empty = running. */
    this._sources = new Set();
    /** Last emitted paused value, used to dedupe events. */
    this._lastEmitted = false;
  }

  /** True if any source has paused the game. */
  get paused() { return this._sources.size > 0; }

  /** Active pause source ids. */
  getSources() { return Array.from(this._sources); }

  /**
   * Request a pause from `source` (string key). Idempotent per source.
   * Returns true if the global paused state transitioned to paused.
   */
  pause(source = 'user') {
    if (typeof source !== 'string' || !source) source = 'user';
    const wasPaused = this.paused;
    this._sources.add(source);
    return this._emit(!wasPaused);
  }

  /**
   * Release a pause request from `source`. Idempotent.
   * Returns true if the global paused state transitioned to running.
   */
  resume(source = 'user') {
    if (typeof source !== 'string' || !source) source = 'user';
    const wasPaused = this.paused;
    this._sources.delete(source);
    const nowPaused = this.paused;
    return this._emit(wasPaused && !nowPaused ? false : null) && wasPaused && !nowPaused;
  }

  /** Toggle user pause source only. Other sources untouched. */
  toggle() {
    if (this._sources.has('user')) this.resume('user');
    else this.pause('user');
    return this.paused;
  }

  /** Force-clear all sources (e.g. on run restart). */
  clear() {
    if (this._sources.size === 0) return false;
    this._sources.clear();
    this._emit(false);
    return true;
  }

  /** Returns an unsubscribe fn. */
  onChange(cb) {
    if (!this._bus || typeof cb !== 'function') return () => {};
    return this._bus.on('pause:change', cb);
  }

  // ── internals ─────────────────────────────────────────────────────────
  _emit(transitioned) {
    // Emit only on real transitions.
    const now = this.paused;
    if (now === this._lastEmitted) return false;
    this._lastEmitted = now;
    if (this._bus) {
      try {
        this._bus.emit('pause:change', { paused: now, sources: this.getSources() });
      } catch { /* non-fatal */ }
    }
    return true;
  }
}

export default PauseManager;
