// Typed event bus — canonical engine-level pub/sub.
//
// Listeners are invoked synchronously inline so hot-path emitters can pass a
// single, reused scratch payload without allocation. Listeners MUST NOT
// retain references to the payload — copy fields out if you need to defer.
//
// The bus is "typed" by way of the EVENTS dictionary: subsystems import the
// named constants instead of stringly-typed literals so the set of cross-
// system signals is grep-able and constrained.

/** Canonical core event names. Keep this list minimal — add only when a new
 *  cross-subsystem signal is genuinely required. */
export const EVENTS = Object.freeze({
  ENEMY_KILLED:   'enemy:killed',
  BOSS_PHASE:     'boss:phase',
  PLAYER_HIT:     'player:hit',
  UPGRADE_PICKED: 'upgrade:picked',
});

/** Set of allowed event names. dev=true on the bus enforces this set. */
const KNOWN = new Set(Object.values(EVENTS));

export class EventBus {
  /** @param {{ dev?: boolean }} [opts] dev=true throws on unknown event names. */
  constructor({ dev = false } = {}) {
    this._handlers = new Map(); // event -> Array<cb>
    this._dev = dev;
  }

  on(event, cb) {
    if (this._dev && !KNOWN.has(event)) {
      throw new Error(`EventBus: unknown event '${event}'. Add it to EVENTS in engine/events.js.`);
    }
    let arr = this._handlers.get(event);
    if (!arr) { arr = []; this._handlers.set(event, arr); }
    arr.push(cb);
    return () => this.off(event, cb);
  }

  off(event, cb) {
    const arr = this._handlers.get(event);
    if (!arr) return;
    const i = arr.indexOf(cb);
    if (i >= 0) arr.splice(i, 1);
  }

  emit(event, payload) {
    const arr = this._handlers.get(event);
    if (!arr) return;
    // Cache length & iterate by index — no allocation, tolerant of listeners
    // mutating the array only via off() called after emit completes.
    for (let i = 0, n = arr.length; i < n; i++) arr[i](payload);
  }

  clear() { this._handlers.clear(); }
}
