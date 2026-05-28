// BusGraph — audio routing skeleton.
//
//   music ─┐
//   sfx   ─┼─► master ─► limiter ─► destination
//   ui    ─┘
//
// Each sub-bus owns a GainNode whose .gain is ramped (never set directly) to
// avoid zipper noise. mute() ramps to silence; unmute() restores the last
// volume. setVolume() updates the stored level and re-ramps if not muted.
//
// Built on Tone.js so Transport-driven music (later sprints) shares the same
// AudioContext, but we use raw Web Audio nodes for the bus graph — zero Tone
// allocations on the hot path.

import * as Tone from 'tone';

const RAMP_VOL = 0.01;  // 10ms, perceptually instant but click-free.
const RAMP_MUTE = 0.10; // 100ms, smooth fade to silence.

/** Names of the sub-buses fed into master. */
export const BUS_NAMES = Object.freeze(['music', 'sfx', 'ui']);

export class BusGraph {
  /**
   * @param {AudioContext} ctx Web Audio context (Tone.getContext().rawContext).
   */
  constructor(ctx) {
    this.ctx = ctx;

    // Limiter: brickwall-ish DynamicsCompressor to catch peaks. Cheap, no
    // dependency on Tone.Limiter (avoid extra Tone graph nodes).
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1;     // dBFS
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;         // hard limit
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.05;
    this.limiter.connect(ctx.destination);

    // Master gain.
    this.master = ctx.createGain();
    this.master.gain.value = 1.0;
    this.master.connect(this.limiter);

    // Sub-buses.
    /** @type {Record<string, GainNode>} */
    this.subs = Object.create(null);
    /** @type {Record<string, number>} */
    this._volumes = Object.create(null);
    /** @type {Record<string, boolean>} */
    this._muted = Object.create(null);

    for (const name of BUS_NAMES) {
      const g = ctx.createGain();
      g.gain.value = 1.0;
      g.connect(this.master);
      this.subs[name] = g;
      this._volumes[name] = 1.0;
      this._muted[name] = false;
    }

    this._volumes.master = 1.0;
    this._muted.master = false;
  }

  /** Where SFX/music/UI generators should connect. */
  input(busName) {
    if (busName === 'master') return this.master;
    const g = this.subs[busName];
    if (!g) throw new Error(`BusGraph: unknown bus '${busName}'`);
    return g;
  }

  _node(busName) {
    return busName === 'master' ? this.master : this.subs[busName];
  }

  /**
   * Set volume on a bus (0..1). Ramps over RAMP_VOL seconds.
   * If the bus is currently muted, only the stored level updates; the audible
   * gain stays at 0 until unmute().
   */
  setVolume(busName, value) {
    const node = this._node(busName);
    if (!node) throw new Error(`BusGraph: unknown bus '${busName}'`);
    const v = Math.max(0, Math.min(1, +value || 0));
    this._volumes[busName] = v;
    if (this._muted[busName]) return;
    const t = this.ctx.currentTime;
    const g = node.gain;
    // Cancel pending ramps then linear-ramp to target.
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(v, t + RAMP_VOL);
  }

  getVolume(busName) {
    return this._volumes[busName] ?? 0;
  }

  isMuted(busName) {
    return !!this._muted[busName];
  }

  /** Click-free mute (RAMP_MUTE fade). Idempotent. */
  mute(busName) {
    const node = this._node(busName);
    if (!node) throw new Error(`BusGraph: unknown bus '${busName}'`);
    if (this._muted[busName]) return;
    this._muted[busName] = true;
    const t = this.ctx.currentTime;
    const g = node.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + RAMP_MUTE);
  }

  /** Click-free unmute back to stored volume. */
  unmute(busName) {
    const node = this._node(busName);
    if (!node) throw new Error(`BusGraph: unknown bus '${busName}'`);
    if (!this._muted[busName]) return;
    this._muted[busName] = false;
    const t = this.ctx.currentTime;
    const g = node.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(this._volumes[busName] ?? 1, t + RAMP_MUTE);
  }

  setMuted(busName, on) {
    if (on) this.mute(busName);
    else this.unmute(busName);
  }

  dispose() {
    try { this.master.disconnect(); } catch (_) {}
    try { this.limiter.disconnect(); } catch (_) {}
    for (const name of BUS_NAMES) {
      try { this.subs[name].disconnect(); } catch (_) {}
    }
  }
}
