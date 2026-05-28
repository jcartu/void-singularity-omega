// Reactive SFX system — procedural-synth voice pool with positional pan/pitch,
// per-category voice caps, and oldest-voice stealing.
//
// Design constraints (SPRINT-05 / WO-05-AU2):
//   - Fixed pool of MAX_VOICES (200). Zero pool growth at runtime.
//   - Reusable per-voice GainNode + StereoPannerNode + BiquadFilterNode chains
//     (allocated once, persisted for the life of the manager).
//   - OscillatorNode / AudioBufferSourceNode are inherently one-shot in the
//     Web Audio API (start() can only be called once), so those leaf source
//     nodes are created per trigger. Everything else is recycled.
//   - Hot-path scratch objects (the panner-target vector, the play opts
//     destructure, the SFX def lookup) are kept tight; no per-event closures,
//     no map/filter allocations on play().
//   - Per-category caps prevent machine-gun clipping (e.g. 80 simultaneous hit
//     pings will degrade to oldest-stealing at the 81st).
//
// Public API:
//   const sfx = new SFXManager({ audio, bus });
//   sfx.playFire(weaponId, pos);
//   sfx.playHit(damage, pos, isCrit);
//   sfx.playExplosion(enemyType, pos);
//   sfx.playPickup(pos);
//   sfx.playLevelUp();
//   sfx.playDash(pos);
//   sfx.playBossPhase(pos);
//   sfx.play(type, opts);          // generic
//   sfx.update(dt);                // call once per frame to reap finished voices
//   sfx.getActiveVoices();
//
// `audio` is expected to expose:
//   - audio.ctx        : AudioContext (preferred), or
//   - audio.context    : AudioContext (fallback)
// `bus` is an AudioNode (typically the SFX sub-bus output) that this manager
// connects every voice chain to.

const MAX_VOICES = 200;

// Per-category active-voice caps. Sum may exceed MAX_VOICES on purpose:
// the global pool is the hard ceiling, categories just prevent any one type
// from monopolising it.
const CATEGORY_CAPS = Object.freeze({
  fire:       50,
  hit:        80,
  explode:    20,
  pickup:     10,
  curse:      10,
  levelup:    10,
  dash:       10,
  boss_phase: 10,
});

// Pan mapping: world-X → stereo pan in [-1, 1].
// PAN_HALF_WIDTH is the world half-extent that maps to full pan.
const PAN_HALF_WIDTH = 30;

// Crit modifiers.
const CRIT_PITCH_MUL  = 1.5;
const CRIT_VOLUME_MUL = 1.35;

// --- Procedural SFX definitions ------------------------------------------------
//
// Each def is consumed by _renderVoice() to wire a source onto a recycled
// voice chain. `synth` is one of:
//   'tone'   — single oscillator + envelope
//   'noise'  — filtered noise buffer + envelope
//   'sweep'  — noise + low oscillator hybrid (explosions)
//   'chord'  — multiple simultaneous oscillators (curse/levelup/arpeggio)
//
// `duration` is the audible lifetime in seconds (we use this for voice-busy
// bookkeeping; the envelope itself fades out before this elapses).

const SFX_DEFS = Object.freeze({
  fire: Object.freeze({
    category: 'fire',
    duration: 0.12,
    synth: 'noise+tone',
    oscType: 'square',
    pitch: 600,                  // overridden by weapon
    filterFreq: 2200,
    filterQ: 4,
    attack: 0.002,
    decay: 0.10,
    gain: 0.18,
    pitchDecay: 0.6,             // multiplier applied at end (downward sweep)
  }),
  hit: Object.freeze({
    category: 'hit',
    duration: 0.10,
    synth: 'tone',
    oscType: 'triangle',
    pitch: 420,                  // scaled by damage
    filterFreq: 3000,
    filterQ: 1.5,
    attack: 0.001,
    decay: 0.09,
    gain: 0.16,
    pitchDecay: 0.7,
  }),
  explode: Object.freeze({
    category: 'explode',
    duration: 0.55,
    synth: 'sweep',
    oscType: 'sawtooth',
    pitch: 90,
    filterFreq: 1400,
    filterFreqEnd: 80,           // sweep down
    filterQ: 2,
    attack: 0.003,
    decay: 0.50,
    gain: 0.34,
    pitchDecay: 0.3,
  }),
  pickup: Object.freeze({
    category: 'pickup',
    duration: 0.18,
    synth: 'tone',
    oscType: 'sine',
    pitch: 680,
    pitchEnd: 1280,              // ascending
    filterFreq: 6000,
    filterQ: 0.5,
    attack: 0.002,
    decay: 0.16,
    gain: 0.20,
  }),
  curse: Object.freeze({
    category: 'curse',
    duration: 0.65,
    synth: 'chord',
    oscType: 'sawtooth',
    chord: [110, 117, 156],      // dissonant cluster (semitone + minor 4th)
    filterFreq: 900,
    filterQ: 6,
    attack: 0.04,
    decay: 0.60,
    gain: 0.18,
  }),
  levelup: Object.freeze({
    category: 'levelup',
    duration: 0.55,
    synth: 'chord',
    oscType: 'triangle',
    chord: [523, 659, 784, 1047], // C major arpeggio (C5 E5 G5 C6)
    chordStagger: 0.07,
    filterFreq: 6000,
    filterQ: 0.7,
    attack: 0.005,
    decay: 0.45,
    gain: 0.22,
  }),
  dash: Object.freeze({
    category: 'dash',
    duration: 0.22,
    synth: 'noise',
    filterFreq: 1800,
    filterFreqEnd: 400,          // whoosh down
    filterQ: 3,
    attack: 0.004,
    decay: 0.20,
    gain: 0.22,
  }),
  boss_phase: Object.freeze({
    category: 'boss_phase',
    duration: 1.10,
    synth: 'sweep',
    oscType: 'sawtooth',
    pitch: 55,                   // deep rumble
    filterFreq: 220,
    filterFreqEnd: 60,
    filterQ: 1.5,
    attack: 0.08,
    decay: 1.00,
    gain: 0.40,
  }),
});

// Weapon → fire-pitch table. Unknown weapons fall back to the def default.
const WEAPON_FIRE_PITCH = Object.freeze({
  plasma:               560,
  rail:                 1150,
  homing:               520,
  beam:                 320,
  ricochet:             820,
  voidlob:              280,
  dash_nuke:            180,
  time_dilation:        420,
  singularity_grenade:  150,
  drone_swarm:          740,
});

// Enemy → explosion-pitch table.
const ENEMY_EXPLODE_PITCH = Object.freeze({
  chaser:  110,
  shooter: 130,
  orbiter:  95,
});

// --- Noise buffer cache --------------------------------------------------------
// One short white-noise buffer, shared across all noise voices. Generated lazily
// on first noise play so we never touch the AudioContext until needed.
let _sharedNoiseBuffer = null;
function _getNoiseBuffer(ctx) {
  if (_sharedNoiseBuffer && _sharedNoiseBuffer.sampleRate === ctx.sampleRate) {
    return _sharedNoiseBuffer;
  }
  const len = Math.floor(ctx.sampleRate * 0.5); // 0.5s of noise is plenty
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  _sharedNoiseBuffer = buf;
  return buf;
}

// --- Voice ---------------------------------------------------------------------
// Persistent per-slot chain. `source` rotates per play; gain/filter/panner stay.
class Voice {
  constructor(ctx, dest, id) {
    this.id = id;
    this.gain   = ctx.createGain();
    this.filter = ctx.createBiquadFilter();
    this.panner = ctx.createStereoPanner();
    // Chain: source -> filter -> gain -> panner -> dest
    this.filter.connect(this.gain);
    this.gain.connect(this.panner);
    this.panner.connect(dest);

    this.gain.gain.value = 0;
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 22000;
    this.filter.Q.value = 0.5;
    this.panner.pan.value = 0;

    this.active = false;
    this.category = '';
    this.startedAt = 0;
    this.endsAt = 0;
    // Holds the currently-playing source nodes so we can stop() on steal.
    // Most defs use a single source; chord uses up to 4. Pre-size to 4.
    this._sources = [null, null, null, null];
    this._sourceCount = 0;
  }

  stopImmediate(ctx) {
    const now = ctx.currentTime;
    try { this.gain.gain.cancelScheduledValues(now); } catch (_) {}
    try { this.gain.gain.setValueAtTime(0, now); } catch (_) {}
    for (let i = 0; i < this._sourceCount; i++) {
      const s = this._sources[i];
      if (s) {
        try { s.stop(now); } catch (_) {}
        try { s.disconnect(); } catch (_) {}
        this._sources[i] = null;
      }
    }
    this._sourceCount = 0;
    this.active = false;
    this.category = '';
  }
}

// --- SFXManager ----------------------------------------------------------------
export class SFXManager {
  /**
   * @param {{ audio: { ctx?: AudioContext, context?: AudioContext }, bus: AudioNode }} opts
   */
  constructor({ audio, bus }) {
    if (!audio) throw new Error('SFXManager: `audio` is required');
    if (!bus)   throw new Error('SFXManager: `bus` is required');
    /** @type {AudioContext} */
    this.ctx = audio.ctx || audio.context;
    if (!this.ctx) throw new Error('SFXManager: audio.ctx (AudioContext) missing');
    this.dest = bus;

    // Pool ------------------------------------------------------------------
    /** @type {Voice[]} */
    this.voices = new Array(MAX_VOICES);
    for (let i = 0; i < MAX_VOICES; i++) {
      this.voices[i] = new Voice(this.ctx, this.dest, i);
    }

    // Per-category active count (avoid per-play scan of the whole pool).
    this._catActive = Object.create(null);
    for (const k of Object.keys(CATEGORY_CAPS)) this._catActive[k] = 0;

    // Free-list cursor; tries pool[hint..] first to reduce scans under load.
    this._scanHint = 0;
    this._totalActive = 0;

    // Reusable scratch — no per-event allocation.
    this._scratchPos = { x: 0, y: 0, z: 0 };
  }

  // -- High-level convenience wrappers --------------------------------------

  playFire(weaponId, pos) {
    const pitch = WEAPON_FIRE_PITCH[weaponId] ?? SFX_DEFS.fire.pitch;
    return this._spawn('fire', pos, pitch, 1, 0);
  }

  playHit(damage, pos, isCrit = false) {
    const def = SFX_DEFS.hit;
    // Damage in [0, 100+] → pitch in [def.pitch, def.pitch * 2.5].
    const d = Math.max(0, Math.min(100, damage || 0));
    let pitch = def.pitch + (d / 100) * def.pitch * 1.5;
    let volMul = 1;
    if (isCrit) { pitch *= CRIT_PITCH_MUL; volMul *= CRIT_VOLUME_MUL; }
    return this._spawn('hit', pos, pitch, volMul, 0);
  }

  playExplosion(enemyType, pos) {
    const pitch = ENEMY_EXPLODE_PITCH[enemyType] ?? SFX_DEFS.explode.pitch;
    return this._spawn('explode', pos, pitch, 1, 0);
  }

  playPickup(pos)        { return this._spawn('pickup',     pos, 0, 1, 0); }
  playLevelUp()          { return this._spawn('levelup',    null, 0, 1, 0); }
  playDash(pos)          { return this._spawn('dash',       pos, 0, 1, 0); }
  playBossPhase(pos)     { return this._spawn('boss_phase', pos, 0, 1, 0); }
  playCurse(pos)         { return this._spawn('curse',      pos, 0, 1, 0); }

  /**
   * Generic entry. opts may contain { pos, damage, weaponType, enemyType, isCrit }.
   */
  play(type, opts) {
    if (!opts) return this._spawn(type, null, 0, 1, 0);
    if (type === 'fire')    return this.playFire(opts.weaponType, opts.pos);
    if (type === 'hit')     return this.playHit(opts.damage, opts.pos, opts.isCrit);
    if (type === 'explode') return this.playExplosion(opts.enemyType, opts.pos);
    return this._spawn(type, opts.pos || null, 0, 1, 0);
  }

  // -- Per-frame tick -------------------------------------------------------

  update(/* dt */) {
    // Reap finished voices. AudioContext schedules envelopes, but we still
    // need to update active counters so caps stay accurate.
    const now = this.ctx.currentTime;
    const voices = this.voices;
    for (let i = 0; i < MAX_VOICES; i++) {
      const v = voices[i];
      if (v.active && now >= v.endsAt) {
        // Disconnect sources (gain/panner/filter stay live, recycled next play).
        for (let s = 0; s < v._sourceCount; s++) {
          const src = v._sources[s];
          if (src) { try { src.disconnect(); } catch (_) {} v._sources[s] = null; }
        }
        v._sourceCount = 0;
        v.active = false;
        const cat = v.category;
        if (cat && this._catActive[cat] > 0) this._catActive[cat]--;
        v.category = '';
        this._totalActive--;
      }
    }
  }

  getActiveVoices() { return this._totalActive; }

  // -- Internals ------------------------------------------------------------

  /**
   * Acquire a voice. Strategy:
   *   1. If the category cap is already met, steal the oldest voice in that
   *      category (so a 51st 'fire' replaces the longest-running 'fire').
   *   2. Else find a free slot starting at _scanHint.
   *   3. Else steal the oldest voice in the entire pool.
   * @param {string} category
   * @returns {Voice|null}
   */
  _acquireVoice(category) {
    const cap = CATEGORY_CAPS[category] ?? 10;
    const voices = this.voices;

    if (this._catActive[category] >= cap) {
      // Steal oldest in this category.
      let oldest = null;
      let oldestT = Infinity;
      for (let i = 0; i < MAX_VOICES; i++) {
        const v = voices[i];
        if (v.active && v.category === category && v.startedAt < oldestT) {
          oldestT = v.startedAt;
          oldest = v;
        }
      }
      if (oldest) {
        oldest.stopImmediate(this.ctx);
        this._catActive[category]--;
        this._totalActive--;
        return oldest;
      }
    }

    // Find a free slot — single linear scan from hint.
    const start = this._scanHint;
    for (let i = 0; i < MAX_VOICES; i++) {
      const idx = (start + i) % MAX_VOICES;
      const v = voices[idx];
      if (!v.active) {
        this._scanHint = (idx + 1) % MAX_VOICES;
        return v;
      }
    }

    // Pool fully saturated — steal the global oldest.
    let oldest = voices[0];
    for (let i = 1; i < MAX_VOICES; i++) {
      if (voices[i].startedAt < oldest.startedAt) oldest = voices[i];
    }
    oldest.stopImmediate(this.ctx);
    if (oldest.category && this._catActive[oldest.category] > 0) {
      this._catActive[oldest.category]--;
    }
    this._totalActive--;
    return oldest;
  }

  /**
   * Pan from world position. Null pos → center.
   */
  _panFromPos(pos) {
    if (!pos) return 0;
    const x = pos.x || 0;
    const p = x / PAN_HALF_WIDTH;
    return p < -1 ? -1 : (p > 1 ? 1 : p);
  }

  /**
   * Core spawn. Routes a fresh source through a recycled voice chain.
   */
  _spawn(type, pos, pitchOverride, volMul, _reserved) {
    const def = SFX_DEFS[type];
    if (!def) return null;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const voice = this._acquireVoice(def.category);
    if (!voice) return null;

    // Configure recycled chain.
    const pan = this._panFromPos(pos);
    voice.panner.pan.setValueAtTime(pan, now);

    const filter = voice.filter;
    filter.frequency.cancelScheduledValues(now);
    filter.Q.cancelScheduledValues(now);
    filter.frequency.setValueAtTime(def.filterFreq || 22000, now);
    filter.Q.setValueAtTime(def.filterQ ?? 0.5, now);
    if (def.filterFreqEnd != null) {
      filter.frequency.exponentialRampToValueAtTime(
        Math.max(20, def.filterFreqEnd),
        now + def.decay,
      );
    }

    // Envelope on the gain.
    const peak = (def.gain || 0.2) * (volMul || 1);
    const g = voice.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(0, now);
    g.linearRampToValueAtTime(peak, now + (def.attack || 0.002));
    // Exponential ramp to a tiny floor (not zero — exponentialRampToValueAtTime
    // forbids zero target) then setValueAtTime(0) at the very end.
    const tailEnd = now + (def.attack || 0.002) + (def.decay || 0.1);
    g.exponentialRampToValueAtTime(0.0001, tailEnd);
    g.setValueAtTime(0, tailEnd + 0.001);

    // Source wiring per synth flavour.
    const tailStop = tailEnd + 0.02;
    this._wireSource(voice, def, pitchOverride, now, tailEnd);

    voice.active = true;
    voice.category = def.category;
    voice.startedAt = now;
    voice.endsAt = tailStop;
    this._catActive[def.category] = (this._catActive[def.category] || 0) + 1;
    this._totalActive++;
    return voice;
  }

  /**
   * Build and start the source node(s) for this voice. Source nodes are
   * one-shot per the Web Audio API spec; gain/filter/panner are reused.
   */
  _wireSource(voice, def, pitchOverride, now, endAt) {
    const ctx = this.ctx;
    const dest = voice.filter;

    // Reset source slots.
    voice._sourceCount = 0;
    const useToneAt = (freq, type, startOffset = 0, stopAt = endAt) => {
      const osc = ctx.createOscillator();
      osc.type = type || def.oscType || 'sine';
      osc.frequency.setValueAtTime(freq, now + startOffset);
      if (def.pitchEnd != null) {
        osc.frequency.exponentialRampToValueAtTime(
          Math.max(20, def.pitchEnd), stopAt,
        );
      } else if (def.pitchDecay != null) {
        osc.frequency.exponentialRampToValueAtTime(
          Math.max(20, freq * def.pitchDecay), stopAt,
        );
      }
      osc.connect(dest);
      osc.start(now + startOffset);
      osc.stop(stopAt + 0.02);
      voice._sources[voice._sourceCount++] = osc;
      return osc;
    };
    const useNoise = (stopAt = endAt) => {
      const src = ctx.createBufferSource();
      src.buffer = _getNoiseBuffer(ctx);
      src.loop = false;
      src.connect(dest);
      src.start(now);
      src.stop(stopAt + 0.02);
      voice._sources[voice._sourceCount++] = src;
      return src;
    };

    switch (def.synth) {
      case 'tone': {
        const f = pitchOverride > 0 ? pitchOverride : def.pitch;
        useToneAt(f, def.oscType);
        break;
      }
      case 'noise': {
        useNoise();
        break;
      }
      case 'noise+tone': {
        useNoise();
        const f = pitchOverride > 0 ? pitchOverride : def.pitch;
        useToneAt(f, def.oscType);
        break;
      }
      case 'sweep': {
        useNoise();
        const f = pitchOverride > 0 ? pitchOverride : def.pitch;
        useToneAt(f, def.oscType);
        break;
      }
      case 'chord': {
        const chord = def.chord || [def.pitch];
        const stagger = def.chordStagger || 0;
        const max = Math.min(chord.length, voice._sources.length);
        for (let i = 0; i < max; i++) {
          useToneAt(chord[i], def.oscType, i * stagger);
        }
        break;
      }
      default: {
        // Fallback: single sine tone.
        useToneAt(def.pitch || 440, 'sine');
      }
    }
  }
}

export const SFX_TYPES = Object.freeze(Object.keys(SFX_DEFS));
export { MAX_VOICES, CATEGORY_CAPS };
