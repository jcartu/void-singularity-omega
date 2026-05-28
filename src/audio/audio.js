// AudioCore — single AudioContext for the whole game.
//
// Browsers refuse to start AudioContexts without a user gesture. We construct
// the context lazily on the first click/keydown/pointerdown/touchstart, wire
// the BusGraph, and emit 'audio:ready' on the supplied event bus.
//
// Anything that needs to make sound (music, SFX, UI) should:
//   1. await audio.ready() (or listen for 'audio:ready')
//   2. connect its source to audio.buses[name].input
//
// Volumes and mutes are routed through BusGraph for click-free transitions.

import * as Tone from 'tone';
import { BusGraph, BUS_NAMES } from './buses.js';

/**
 * @typedef {Object} BusHandle
 * @property {(v: number) => void} setVolume
 * @property {() => number} getVolume
 * @property {(on: boolean) => void} setMuted
 * @property {() => boolean} isMuted
 * @property {AudioNode} input  Connect sources to this node.
 */

export class AudioCore {
  /**
   * @param {{ bus?: import('../engine/events.js').EventBus | null }} [opts]
   */
  constructor({ bus = null } = {}) {
    this.bus = bus;
    /** @type {AudioContext | null} */
    this.ctx = null;
    /** @type {BusGraph | null} */
    this.graph = null;
    this.started = false;
    this._readyPromise = new Promise((res) => { this._resolveReady = res; });
    this._gestureBound = false;
    this._onGesture = this._onGesture.bind(this);
    /** @type {Record<string, BusHandle> | null} */
    this._buses = null;
  }

  /**
   * Arm one-shot gesture listeners on the given target (default: window).
   * Safe to call before DOM is fully ready.
   */
  armGestureStart(target = (typeof window !== 'undefined' ? window : null)) {
    if (!target || this._gestureBound || this.started) return;
    this._gestureTarget = target;
    this._gestureBound = true;
    const opts = { once: false, passive: true, capture: true };
    target.addEventListener('pointerdown', this._onGesture, opts);
    target.addEventListener('click', this._onGesture, opts);
    target.addEventListener('keydown', this._onGesture, opts);
    target.addEventListener('touchstart', this._onGesture, opts);
  }

  _unbindGesture() {
    if (!this._gestureBound || !this._gestureTarget) return;
    const t = this._gestureTarget;
    const opts = { capture: true };
    t.removeEventListener('pointerdown', this._onGesture, opts);
    t.removeEventListener('click', this._onGesture, opts);
    t.removeEventListener('keydown', this._onGesture, opts);
    t.removeEventListener('touchstart', this._onGesture, opts);
    this._gestureBound = false;
  }

  _onGesture() {
    // Fire-and-forget; start() is idempotent.
    this.start().catch((e) => console.warn('[OMEGA:audio] start failed:', e));
  }

  /**
   * Resume / create the AudioContext. Must be called from a user gesture stack.
   * Idempotent — safe to invoke many times.
   */
  async start() {
    if (this.started) return;
    // Tone.start() resumes its internal AudioContext (creating it on first call).
    // It must be invoked synchronously from a user gesture; subsequent awaits
    // are fine.
    await Tone.start();
    const toneCtx = Tone.getContext();
    const raw = toneCtx.rawContext._nativeAudioContext
      || toneCtx.rawContext
      || toneCtx;
    // Defensive: ensure we have a real AudioContext.
    const ctx = (raw instanceof (globalThis.AudioContext || function () {}))
      ? raw
      : (toneCtx.rawContext && toneCtx.rawContext._nativeAudioContext) || toneCtx.rawContext;
    this.ctx = ctx;

    // Some browsers leave the context 'suspended' even after Tone.start when
    // the gesture event was synthetic — nudge it.
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch (_) {}
    }

    this.graph = new BusGraph(this.ctx);
    this._buses = this._buildBusHandles();
    this.started = true;
    this._unbindGesture();
    this._resolveReady(this);
    this.bus?.emit('audio:ready', this);
  }

  /** Returns a promise that resolves once start() has completed. */
  ready() {
    return this._readyPromise;
  }

  _buildBusHandles() {
    const out = Object.create(null);
    const names = ['master', ...BUS_NAMES];
    for (const name of names) {
      const g = this.graph;
      out[name] = {
        get input() { return g.input(name === 'master' ? 'master' : name); },
        setVolume: (v) => g.setVolume(name, v),
        getVolume: () => g.getVolume(name),
        setMuted: (on) => g.setMuted(name, on),
        isMuted: () => g.isMuted(name),
      };
    }
    return out;
  }

  /**
   * @returns {{ master: BusHandle, music: BusHandle, sfx: BusHandle, ui: BusHandle } | null}
   */
  getBuses() {
    return this._buses;
  }

  /** Click-free master mute. */
  setMasterMuted(on) {
    if (!this.graph) {
      // Defer until start; remember intent.
      this._pendingMasterMute = !!on;
      this.ready().then(() => this.graph.setMuted('master', !!on));
      return;
    }
    this.graph.setMuted('master', !!on);
  }

  /** Tone Transport for music timing (no allocations to access). */
  getTransport() {
    return Tone.getTransport ? Tone.getTransport() : Tone.Transport;
  }

  dispose() {
    this._unbindGesture();
    try { this.graph?.dispose(); } catch (_) {}
    this.graph = null;
    this._buses = null;
    // Do NOT close the AudioContext — Tone shares it; closing breaks other
    // surfaces and is irreversible per-page. Suspend instead.
    if (this.ctx && this.ctx.state === 'running') {
      this.ctx.suspend().catch(() => {});
    }
    this.started = false;
  }
}
