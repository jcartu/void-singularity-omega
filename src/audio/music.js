// Adaptive procedural music engine — Tone.js-driven layered stems whose
// blend follows a combat-intensity scalar in [0,1].
//
// Design summary
// --------------
// • Four always-running layers (calm pad → bass → lead → distorted tutti).
//   Each layer's master gain crossfades to a target value on bar boundaries,
//   so transitions are quantized and click-free.
// • Intensity scalar fuses three signals:
//     enemyCount  (40%)  — sliding window of live enemies, log-mapped.
//     bossPhase   (30%)  — 0 outside bosses; rises with phase ordinal.
//     comboMult   (30%)  — combo multiplier, log-mapped against cap.
//   Internal value is lerped toward the target each update() to avoid the
//   "twitch" you'd get reacting to single-frame spawn/death noise.
// • A `cue` overlay supersedes intensity-driven mixing for boss_intro /
//   victory / death stingers. Cues schedule short Transport-quantized events
//   and (where needed) duck/halt the steady-state layers.
// • Biomes select key/mode/tempo. Layer note material is generated from the
//   biome's scale degrees, not hard-coded note names, so every biome reuses
//   the same musical "shape" with a fresh tonality.
//
// The engine does NOT call Tone.start(); the caller (a UI gesture) must have
// already resumed the AudioContext before setIntensity / playCue cause any
// audible output. setEnabled(true) is the trigger that actually starts the
// Transport — wire it from the same gesture that resumes audio.
//
// Output routing: connects to `audio.musicBus` if provided, else
// `audio.master`, else Tone.getDestination(). Never connects directly to a
// raw destination if a bus is available.

import * as Tone from 'tone';

// ---------------------------------------------------------------------------
// Biome → musical context table.
//
// `scale` is expressed as semitone offsets from `root` (PC names). `bpm` and
// `swing` give each biome a distinct groove. The "mode" comment is the
// musicological label; the engine itself only consumes the integer scale.
// ---------------------------------------------------------------------------
export const BIOME_MUSIC = Object.freeze({
  // D minor — ethereal, open fifths.
  nebula:            { root: 'D3', scale: [0, 2, 3, 5, 7, 8, 10], bpm: 84,  swing: 0.0 },
  // E phrygian — flat-2 anxiety.
  accretion:         { root: 'E3', scale: [0, 1, 3, 5, 7, 8, 10], bpm: 96,  swing: 0.08 },
  // F harmonic minor — augmented-2 menace.
  'event-horizon':   { root: 'F3', scale: [0, 2, 3, 5, 7, 8, 11], bpm: 110, swing: 0.12 },
  // G locrian — diminished tonic, unstable.
  'singularity-core':{ root: 'G3', scale: [0, 1, 3, 5, 6, 8, 10], bpm: 124, swing: 0.16 },
  // A minor → resolves to major during victory cue.
  omega:             { root: 'A2', scale: [0, 2, 3, 5, 7, 8, 10], bpm: 138, swing: 0.10 },
});
const DEFAULT_BIOME = 'nebula';

// Intensity → layer-gain envelope (per layer, target gain at given intensity).
// Each layer has a fade-in/fade-out band so they bleed across thresholds
// rather than slamming on at a single point. Values in [0,1] linear gain.
const LAYER_CURVES = [
  // L0 ambient pad — always on but ducks slightly under chaos.
  (i) => 0.55 - 0.20 * Math.max(0, Math.min(1, (i - 0.5) / 0.5)),
  // L1 bass — ramps in 0.10..0.35, full above.
  (i) => clamp01((i - 0.10) / 0.25) * 0.85,
  // L2 lead — ramps in 0.40..0.65.
  (i) => clamp01((i - 0.40) / 0.25) * 0.80,
  // L3 distorted tutti — ramps in 0.70..0.90.
  (i) => clamp01((i - 0.70) / 0.20) * 0.95,
];

const LAYER_FADE_SEC = 1.6;        // crossfade duration on bar boundary
const INTENSITY_LERP_TAU = 0.7;    // seconds — exponential lerp time const
const TEMPO_RANGE = 1.18;          // 1.0× at low intensity → 1.18× at 1.0
const ENEMY_SOFT_CAP = 40;         // intensity from enemy count saturates here
const COMBO_LOG_CAP = 20;          // matches COMBO_DEFAULTS.multiplierCap

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function lerp(a, b, t) { return a + (b - a) * t; }

// Resolve a scale-degree into an absolute frequency. degree may be negative
// (octave down) or >= scale.length (octave up); we wrap with proper octave
// arithmetic so motifs can span ranges without explicit octave fields.
function noteFor(rootNote, scale, degree) {
  const len = scale.length;
  const octShift = Math.floor(degree / len);
  const within = ((degree % len) + len) % len;
  const semis = scale[within] + 12 * octShift;
  return Tone.Frequency(rootNote).transpose(semis).toNote();
}

// ===========================================================================
// MusicEngine
// ===========================================================================
export class MusicEngine {
  /**
   * @param {object} deps
   * @param {object} [deps.audio] - audio core. We look for `musicBus` (a
   *   Tone-compatible node) or `master`; fall back to Tone.getDestination().
   * @param {object} [deps.bus]   - typed event bus exposing `on(name, cb)`.
   * @param {string} [deps.biome] - initial biome id (default 'nebula').
   * @param {number} [deps.intensity] - initial intensity in [0,1].
   * @param {boolean} [deps.autoSubscribe] - subscribe to combat events from
   *   `bus` to drive intensity automatically (default true).
   */
  constructor({
    audio = null,
    bus = null,
    biome = DEFAULT_BIOME,
    intensity = 0,
    autoSubscribe = true,
  } = {}) {
    this._bus = bus;
    this._biome = BIOME_MUSIC[biome] ? biome : DEFAULT_BIOME;
    this._biomeData = BIOME_MUSIC[this._biome];

    this._intensity = clamp01(intensity);
    this._intensityTarget = this._intensity;

    // Inputs feeding the intensity fuse.
    this._enemyCount = 0;
    this._bossPhase = 0;        // 0 = no boss; phase ordinal otherwise
    this._inBossEncounter = false;
    this._comboMult = 1;
    this._lastWaveState = null;

    // Cue state: { name, until } or null. While active, intensity-driven
    // layer gains are suspended in favor of cue-specified mix.
    this._cue = null;

    // Lifecycle.
    this._started = false;
    this._enabled = false;
    this._disposed = false;
    this._barWatchId = null;
    this._lastBarTime = -1;

    // Wire output destination.
    this._dest = audio?.musicBus ?? audio?.master ?? Tone.getDestination();

    // Build signal graph.
    this._build();

    // Default tempo before any setBiome side-effect.
    Tone.getTransport().bpm.value = this._biomeData.bpm;
    Tone.getTransport().swing = this._biomeData.swing;
    Tone.getTransport().swingSubdivision = '8n';

    // Subscriptions.
    this._unsubs = [];
    if (bus && autoSubscribe && typeof bus.on === 'function') {
      this._unsubs.push(bus.on('enemy:spawn',     () => { this._enemyCount += 1; }));
      this._unsubs.push(bus.on('enemy:death',     () => { this._enemyCount = Math.max(0, this._enemyCount - 1); }));
      this._unsubs.push(bus.on('combo:changed',   (p) => { this._comboMult = p?.multiplier ?? 1; }));
      this._unsubs.push(bus.on('combo:reset',     (p) => { this._comboMult = p?.multiplier ?? 1; }));
      this._unsubs.push(bus.on('boss:encounter',  (p) => {
        this._inBossEncounter = true;
        this._bossPhase = 1;
        this.playCue('boss_intro', p);
      }));
      this._unsubs.push(bus.on('boss:phase',      (p) => {
        this._bossPhase = Math.max(1, (p?.phase ?? 1) | 0);
        if (this._bossPhase > 1) this.playCue('boss_phase', p);
      }));
      this._unsubs.push(bus.on('boss:complete',   () => {
        this._inBossEncounter = false;
        this._bossPhase = 0;
      }));
    }
  }

  // --- Public API ----------------------------------------------------------

  /** Start/stop the Transport. MUST be called from a user gesture. */
  setEnabled(on) {
    if (this._disposed) return;
    on = !!on;
    if (on === this._enabled) return;
    this._enabled = on;
    const T = Tone.getTransport();
    if (on) {
      if (!this._started) {
        this._scheduleLayers();
        this._installBarWatcher();
        this._started = true;
      }
      // Ramp master from 0 to avoid the click that a hard-start at full gain
      // would produce when Transport jumps from 0 to non-zero.
      this._master.gain.cancelScheduledValues(Tone.now());
      this._master.gain.setValueAtTime(0.0001, Tone.now());
      this._master.gain.exponentialRampToValueAtTime(1, Tone.now() + 0.25);
      if (T.state !== 'started') T.start('+0.05');
    } else {
      this._master.gain.cancelScheduledValues(Tone.now());
      this._master.gain.exponentialRampToValueAtTime(0.0001, Tone.now() + 0.25);
      // Don't stop the transport — other audio systems may rely on it. Just
      // mute the music. Disposal stops everything.
    }
  }

  /** Update target intensity. The actual value is eased toward this. */
  setIntensity(x) {
    this._intensityTarget = clamp01(x);
  }

  /** Returns the *current* (eased) intensity, not the target. */
  getIntensity() { return this._intensity; }

  /** Change the harmonic context. Tempo+swing crossfade on bar boundary. */
  setBiome(name) {
    if (!BIOME_MUSIC[name] || name === this._biome) return;
    this._biome = name;
    this._biomeData = BIOME_MUSIC[name];
    const T = Tone.getTransport();
    // Quantize tempo change to next bar to avoid mid-pattern stutter.
    T.scheduleOnce(() => {
      T.bpm.rampTo(this._biomeData.bpm, 1.5);
      T.swing = this._biomeData.swing;
      // Rebuild patterns so they emit notes in the new scale next bar.
      this._refreshPatterns();
    }, '@1m');
  }

  /**
   * Trigger a named cue. Cues are short, dramatic, and ride on top of the
   * background mix. Known: 'boss_intro', 'boss_phase', 'victory', 'death'.
   */
  playCue(name, payload = null) {
    if (this._disposed) return;
    switch (name) {
      case 'boss_intro': this._cueBossIntro(); break;
      case 'boss_phase': this._cueBossPhase(); break;
      case 'victory':    this._cueVictory(); break;
      case 'death':      this._cueDeath(); break;
      default:           /* unknown cue — silently ignore */ break;
    }
    if (this._bus && typeof this._bus.emit === 'function') {
      // Re-emit for analytics; subsystems may want to flash UI in sync.
      try { this._bus.emit('music:cue', { name, payload }); } catch { /* noop */ }
    }
  }

  /** Per-frame tick. dt in seconds. */
  update(dt) {
    if (this._disposed || !Number.isFinite(dt) || dt <= 0) return;

    // Recompute intensity target from inputs (caller may also setIntensity()
    // manually; their value is used as the floor here).
    const fused = this._fuseIntensity();
    const target = Math.max(this._intensityTarget, fused);

    // Exponential lerp: framerate-independent smoothing.
    const a = 1 - Math.exp(-dt / INTENSITY_LERP_TAU);
    this._intensity = lerp(this._intensity, target, a);

    // Drive tempo gently with intensity inside the biome's nominal band.
    const T = Tone.getTransport();
    const desiredBpm = this._biomeData.bpm * (1 + (TEMPO_RANGE - 1) * this._intensity);
    // ramp continuously but with a generous time constant so we don't fight
    // the bar-quantized BPM change in setBiome.
    if (Math.abs(T.bpm.value - desiredBpm) > 0.5) T.bpm.rampTo(desiredBpm, 2.5);

    // Cue expiry check.
    if (this._cue && Tone.now() >= this._cue.until) {
      this._cue = null;
      this._restoreSteadyState();
    }
  }

  /** Convenience: feed snapshot of wave state from WaveDirector each frame. */
  setWaveState(state) {
    if (!state) return;
    this._lastWaveState = state;
    if (state.biome && state.biome !== this._biome) this.setBiome(state.biome);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const off of this._unsubs) { try { off(); } catch { /* noop */ } }
    this._unsubs.length = 0;
    if (this._barWatchId != null) {
      try { Tone.getTransport().clear(this._barWatchId); } catch { /* noop */ }
      this._barWatchId = null;
    }
    for (const p of this._patterns) { try { p.dispose(); } catch { /* noop */ } }
    for (const n of this._nodes)    { try { n.dispose(); } catch { /* noop */ } }
    this._patterns.length = 0;
    this._nodes.length = 0;
  }

  // --- Internals: graph construction --------------------------------------

  _build() {
    this._patterns = [];
    this._nodes = [];

    // Master limiter → destination. Prevents the cue stingers from clipping
    // when they stack on top of full-density layers.
    this._limiter = new Tone.Limiter(-1).connect(this._dest);
    this._master = new Tone.Gain(0.0001).connect(this._limiter);
    this._nodes.push(this._limiter, this._master);

    // One gain per layer. _layerGain[i] is the bar-quantized fade target.
    this._layerGains = [];
    for (let i = 0; i < 4; i++) {
      const g = new Tone.Gain(0).connect(this._master);
      this._layerGains.push(g);
      this._nodes.push(g);
    }

    // ---- Layer 0: ambient pad + slow arpeggio ----------------------------
    const padFilter = new Tone.Filter(900, 'lowpass').connect(this._layerGains[0]);
    const padReverb = new Tone.Reverb({ decay: 6, wet: 0.55 }).connect(padFilter);
    padReverb.generate(); // async; safe to ignore (it ramps in)
    this._pad = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'sine' },
      envelope: { attack: 1.8, decay: 0.4, sustain: 0.9, release: 4.0 },
      volume: -10,
    }).connect(padReverb);
    this._arp = new Tone.MonoSynth({
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.02, decay: 0.6, sustain: 0.2, release: 0.6 },
      filter: { Q: 1, type: 'lowpass', rolloff: -12 },
      filterEnvelope: { attack: 0.01, decay: 0.4, sustain: 0.2, baseFrequency: 400, octaves: 2 },
      volume: -16,
    }).connect(padReverb);
    this._nodes.push(padFilter, padReverb, this._pad, this._arp);

    // ---- Layer 1: bass line ----------------------------------------------
    const bassDist = new Tone.Distortion({ distortion: 0.08, wet: 0.25 }).connect(this._layerGains[1]);
    this._bass = new Tone.MonoSynth({
      oscillator: { type: 'sawtooth' },
      envelope: { attack: 0.005, decay: 0.18, sustain: 0.4, release: 0.25 },
      filter: { Q: 2, type: 'lowpass', rolloff: -24 },
      filterEnvelope: { attack: 0.01, decay: 0.15, sustain: 0.1, baseFrequency: 250, octaves: 2.5 },
      volume: -8,
    }).connect(bassDist);
    // Light percussion: noise burst hat + low kick.
    this._kick = new Tone.MembraneSynth({
      pitchDecay: 0.04, octaves: 6,
      envelope: { attack: 0.001, decay: 0.32, sustain: 0.0, release: 0.2 },
      volume: -8,
    }).connect(this._layerGains[1]);
    this._hat = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.06, sustain: 0, release: 0.04 },
      volume: -22,
    }).connect(new Tone.Filter(7000, 'highpass').connect(this._layerGains[1]));
    this._nodes.push(bassDist, this._bass, this._kick, this._hat);

    // ---- Layer 2: lead synth + heavier drums -----------------------------
    const leadDelay = new Tone.FeedbackDelay({ delayTime: '8n.', feedback: 0.32, wet: 0.28 }).connect(this._layerGains[2]);
    this._lead = new Tone.MonoSynth({
      oscillator: { type: 'square' },
      envelope: { attack: 0.005, decay: 0.25, sustain: 0.55, release: 0.4 },
      filter: { Q: 4, type: 'lowpass', rolloff: -24 },
      filterEnvelope: { attack: 0.01, decay: 0.18, sustain: 0.3, baseFrequency: 800, octaves: 3 },
      volume: -12,
    }).connect(leadDelay);
    this._snare = new Tone.NoiseSynth({
      noise: { type: 'pink' },
      envelope: { attack: 0.001, decay: 0.18, sustain: 0, release: 0.1 },
      volume: -14,
    }).connect(this._layerGains[2]);
    this._nodes.push(leadDelay, this._lead, this._snare);

    // ---- Layer 3: distorted tutti (chord stabs + fast hat) ---------------
    const stabDist = new Tone.Distortion({ distortion: 0.55, wet: 0.7 }).connect(this._layerGains[3]);
    this._stab = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'sawtooth' },
      envelope: { attack: 0.002, decay: 0.18, sustain: 0.15, release: 0.18 },
      volume: -16,
    }).connect(stabDist);
    this._fastHat = new Tone.MetalSynth({
      envelope: { attack: 0.001, decay: 0.08, release: 0.04 },
      harmonicity: 5.1, modulationIndex: 32, resonance: 4000, octaves: 1.5,
      volume: -32,
    }).connect(this._layerGains[3]);
    this._nodes.push(stabDist, this._stab, this._fastHat);
  }

  // --- Internals: patterns -------------------------------------------------

  _scheduleLayers() {
    this._refreshPatterns();
  }

  _refreshPatterns() {
    // Dispose old patterns (called on biome change).
    for (const p of this._patterns) { try { p.dispose(); } catch { /* noop */ } }
    this._patterns.length = 0;

    const { root, scale } = this._biomeData;

    // Pad: long held chord progression (i — VI — iv — v), one chord per 2 bars.
    // We voice each chord as root+third+fifth+octave-down for warmth.
    const chordDegrees = [
      [0, 2, 4, -7],
      [5, 7, 9, -2],
      [3, 5, 7, -4],
      [4, 6, 8, -3],
    ];
    const padPattern = new Tone.Loop((time) => {
      const idx = padPattern._step = (padPattern._step ?? -1) + 1;
      const ch = chordDegrees[idx % chordDegrees.length];
      const notes = ch.map((d) => noteFor(root, scale, d));
      this._pad.triggerAttackRelease(notes, '2m', time, 0.7);
    }, '2m').start(0);
    padPattern._step = -1;
    this._patterns.push(padPattern);

    // Arp: slow eighth-note arpeggio across the current pad chord.
    const arpDegrees = [0, 2, 4, 7, 4, 2];
    const arpPattern = new Tone.Loop((time) => {
      const idx = (arpPattern._step = (arpPattern._step ?? -1) + 1) % arpDegrees.length;
      this._arp.triggerAttackRelease(noteFor(root, scale, arpDegrees[idx]), '8n', time, 0.5);
    }, '4n').start('1m');
    arpPattern._step = -1;
    this._patterns.push(arpPattern);

    // Bass: root + fifth root-octave pulse, quarter notes.
    const bassDegrees = [-7, -7, -3, -7, -7, -7, 0, -7];
    const bassPattern = new Tone.Loop((time) => {
      const idx = (bassPattern._step = (bassPattern._step ?? -1) + 1) % bassDegrees.length;
      this._bass.triggerAttackRelease(noteFor(root, scale, bassDegrees[idx]), '8n', time, 0.85);
    }, '8n').start(0);
    bassPattern._step = -1;
    this._patterns.push(bassPattern);

    // Kick on 1,3 ; hat on every 8th but ducked on the kick beats.
    const drumPattern = new Tone.Loop((time) => {
      const step = (drumPattern._step = (drumPattern._step ?? -1) + 1) % 8;
      if (step === 0 || step === 4) this._kick.triggerAttackRelease('C1', '8n', time);
      if (step !== 0 && step !== 4) this._hat.triggerAttackRelease('32n', time, 0.4);
    }, '8n').start(0);
    drumPattern._step = -1;
    this._patterns.push(drumPattern);

    // Lead: a sparse 4-bar motif. Rests are encoded as null degrees.
    const leadMotif = [0, null, 4, 2, 7, null, 4, null, 9, 7, 4, 2, null, 0, null, null];
    const leadPattern = new Tone.Loop((time) => {
      const step = (leadPattern._step = (leadPattern._step ?? -1) + 1) % leadMotif.length;
      const d = leadMotif[step];
      if (d != null) this._lead.triggerAttackRelease(noteFor(root, scale, d), '16n', time, 0.75);
    }, '16n').start('1m');
    leadPattern._step = -1;
    this._patterns.push(leadPattern);

    // Snare on backbeat (2 & 4).
    const snarePattern = new Tone.Loop((time) => {
      const step = (snarePattern._step = (snarePattern._step ?? -1) + 1) % 4;
      if (step === 1 || step === 3) this._snare.triggerAttackRelease('16n', time, 0.6);
    }, '4n').start(0);
    snarePattern._step = -1;
    this._patterns.push(snarePattern);

    // Stab: chord stab on the off-beats; the distortion is what sells it.
    const stabPattern = new Tone.Loop((time) => {
      const step = (stabPattern._step = (stabPattern._step ?? -1) + 1) % 4;
      if (step === 0 || step === 2) {
        const ch = chordDegrees[(step >> 1) % chordDegrees.length].map((d) => noteFor(root, scale, d));
        this._stab.triggerAttackRelease(ch, '16n', time, 0.6);
      }
    }, '4n').start(0);
    stabPattern._step = -1;
    this._patterns.push(stabPattern);

    // Fast hat: sixteenths.
    const fastHatPattern = new Tone.Loop((time) => {
      this._fastHat.triggerAttackRelease('32n', time, 0.5);
    }, '16n').start(0);
    this._patterns.push(fastHatPattern);
  }

  // --- Internals: bar watcher & mix ---------------------------------------

  _installBarWatcher() {
    // Once per bar, snap layer gains toward their intensity-derived targets.
    // Doing this on the bar avoids audible volume sweeps mid-phrase.
    this._barWatchId = Tone.getTransport().scheduleRepeat((time) => {
      this._applyLayerMix(time);
    }, '1m');
  }

  _applyLayerMix(time) {
    if (this._cue) return; // cue owns the mix while active
    const i = this._intensity;
    for (let k = 0; k < this._layerGains.length; k++) {
      const target = LAYER_CURVES[k](i);
      const g = this._layerGains[k].gain;
      g.cancelScheduledValues(time);
      g.setValueAtTime(g.value, time);
      g.linearRampToValueAtTime(target, time + LAYER_FADE_SEC);
    }
  }

  _restoreSteadyState() {
    // Called when a cue ends — reapply intensity mix at the next bar.
    Tone.getTransport().scheduleOnce((time) => this._applyLayerMix(time), '@1m');
  }

  // --- Internals: intensity fuse ------------------------------------------

  _fuseIntensity() {
    // Enemy density: log-soft saturating curve so 0→8 feels meaningful but
    // 30→40 doesn't keep pushing the mix harder than it should.
    const ec = this._enemyCount;
    const enemyTerm = clamp01(Math.log2(1 + ec) / Math.log2(1 + ENEMY_SOFT_CAP));

    // Boss phase: 0 outside, jumps to 0.6 on encounter, 0.8 on phase 2,
    // 1.0 on phase 3+. Hits hard so bosses are unmistakable.
    let bossTerm = 0;
    if (this._inBossEncounter) {
      bossTerm = this._bossPhase <= 1 ? 0.6
               : this._bossPhase === 2 ? 0.85
               : 1.0;
    }

    // Combo: log-mapped to multiplier cap.
    const comboTerm = clamp01(Math.log2(1 + Math.max(1, this._comboMult) - 1) / Math.log2(COMBO_LOG_CAP));

    return clamp01(0.40 * enemyTerm + 0.30 * bossTerm + 0.30 * comboTerm);
  }

  // --- Internals: cues -----------------------------------------------------

  _engageCue(name, durationSec, layerGains) {
    // Snap layers to the cue's mix on the next bar; record so update() knows
    // when to release.
    const T = Tone.getTransport();
    T.scheduleOnce((time) => {
      for (let k = 0; k < this._layerGains.length; k++) {
        const g = this._layerGains[k].gain;
        g.cancelScheduledValues(time);
        g.setValueAtTime(g.value, time);
        g.linearRampToValueAtTime(layerGains[k] ?? 0, time + 0.4);
      }
    }, '@1m');
    this._cue = { name, until: Tone.now() + durationSec };
  }

  _cueBossIntro() {
    // Two-bar stinger: low brass-ish stab then sustained dissonant chord.
    const { root, scale } = this._biomeData;
    const T = Tone.getTransport();
    // Duck steady layers down hard, then back up.
    this._engageCue('boss_intro', /*duration sec*/ (2 * 60 / T.bpm.value) * 4, [0.2, 0, 0, 0.4]);
    T.scheduleOnce((time) => {
      // Tritone + flat-5 cluster for menace, ignoring biome mode for shock.
      const stab = [noteFor(root, scale, -7), noteFor(root, scale, -4), noteFor(root, scale, -1)];
      this._stab.triggerAttackRelease(stab, '2n', time, 0.95);
      this._kick.triggerAttackRelease('C1', '2n', time);
    }, '@1m');
    T.scheduleOnce((time) => {
      const swell = [noteFor(root, scale, -7), noteFor(root, scale, -3), noteFor(root, scale, 0), noteFor(root, scale, 4)];
      this._pad.triggerAttackRelease(swell, '2m', time, 0.9);
    }, '@1m');
  }

  _cueBossPhase() {
    // One-bar escalation: rising 4-note ascent on lead.
    const { root, scale } = this._biomeData;
    const T = Tone.getTransport();
    this._engageCue('boss_phase', (2 * 60 / T.bpm.value) * 2, [0.3, 0.5, 0.7, 0.85]);
    const degrees = [0, 3, 5, 7];
    for (let i = 0; i < degrees.length; i++) {
      T.scheduleOnce((time) => {
        this._lead.triggerAttackRelease(noteFor(root, scale, degrees[i]), '8n', time, 0.9);
      }, `@1m + ${i} * 8n`);
    }
  }

  _cueVictory() {
    // Resolving I-IV-V-I (with the omega biome resolving its parallel major).
    const { root, scale } = this._biomeData;
    const T = Tone.getTransport();
    const major = [0, 4, 7];  // explicit major triad for resolution
    const sub   = [5, 9, 12]; // IV
    const dom   = [7, 11, 14];// V (raised 7 against minor scales = picardy)
    this._engageCue('victory', (4 * 60 / T.bpm.value) * 4, [0.65, 0.0, 0.5, 0.0]);
    const chords = [major, sub, dom, major];
    for (let i = 0; i < chords.length; i++) {
      T.scheduleOnce((time) => {
        const notes = chords[i].map((d) => noteFor(root, scale, d));
        this._pad.triggerAttackRelease(notes, '1m', time, 0.9);
      }, `@1m + ${i} * 1m`);
    }
  }

  _cueDeath() {
    // Descending minor progression, then long fade to silence.
    const { root, scale } = this._biomeData;
    const T = Tone.getTransport();
    const fall = [[0, 3, 7], [-2, 1, 5], [-4, 0, 3], [-7, -3, 0]];
    this._engageCue('death', (4 * 60 / T.bpm.value) * 4, [0.5, 0.0, 0.0, 0.0]);
    for (let i = 0; i < fall.length; i++) {
      T.scheduleOnce((time) => {
        const notes = fall[i].map((d) => noteFor(root, scale, d));
        this._pad.triggerAttackRelease(notes, '1m', time, 0.7);
      }, `@1m + ${i} * 1m`);
    }
    // Final fade of master to silence; doesn't dispose so cue can be undone.
    T.scheduleOnce((time) => {
      this._master.gain.cancelScheduledValues(time);
      this._master.gain.setValueAtTime(this._master.gain.value, time);
      this._master.gain.exponentialRampToValueAtTime(0.0001, time + 3.0);
    }, `@1m + 3 * 1m`);
  }
}

export default MusicEngine;
