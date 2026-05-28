// Backwards-compat shim. The canonical bus + typed event names live in
// engine/events.js; this module re-exports them so legacy game-side imports
// keep working.
export { EventBus, EVENTS } from '../engine/events.js';
