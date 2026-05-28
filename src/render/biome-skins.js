// Per-biome art skins — SPRINT-06 / WO-06-C2.
//
// A "skin" is a parameter set applied to existing render systems. NO new
// shader pipelines, NO mid-run recompilation. Switching biomes is a series of
// number/color assignments + a palette swap on the nebula shader's existing
// uniforms, so the cost is well under one frame.
//
// Surface area:
//   const skins = new BiomeSkins({ postfx, vfx, particles, renderer, scene });
//   skins.preload();                         // optional warm-up (no-op today)
//   skins.setBiome('accretion');             // <1ms parameter swap
//   skins.update(dt, currentBiomeId);        // advance pulsing/flicker
//   skins.getBiomeSkin('event-horizon');     // read preset (immutable copy)
//   skins.dispose();
//
// Five biomes — ids aligned with director.js plus the SPRINT-06 spec names.
// Both name spellings map to the same skin:
//   nebula           ⇄ nebula-drift     (Nebula Drift)
//   accretion        ⇄ accretion-verge  (Accretion Verge)
//   pulsar           ⇄ pulsar-field     (Pulsar Field)
//   debris           ⇄ debris-belt      (Debris Belt)
//   event-horizon    ⇄ event-horizon    (Event Horizon)
//   singularity-core, omega -> aliased to event-horizon (close visual cousin)
//
// What we drive:
//   - postfx.setIntensity(node, v)    bloom, ca, grain, vignette, lensing, dof, motionBlur
//   - vfx.setBiomePalette(name)        existing palette table
//   - vfx._bgMat.uniforms.uIntensity   pulsing brightness on Pulsar
//   - particles.systems('sparks').emit upward embers, dust clouds, inward spiral
//   - scene.fog                        Three FogExp2 (created lazily, density per biome)
//
// MUST NOT:
//   - Build new pipelines (rebuild() on PostFX is explicitly avoided)
//   - Touch audio
//   - Allocate per-frame
//
// Switch cost: one set of small writes; on the order of a few hundred ns.

import { FogExp2, Color, Vector3 } from 'three';

// ──────────────────────────────────────────────────────────────────────────
// Preset table.
// ──────────────────────────────────────────────────────────────────────────
//
// Each preset holds:
//   post     — node intensity overrides (only PostFX-known node names)
//   palette  — biome key understood by vfx.setBiomePalette()
//   nebula   — { intensity } drives uIntensity on the background shader
//   particles— { sparkRate, sparkColor, sparkSpeed, sparkLife, sparkDrift,
//               sparkSpread, motePattern, motionMode }
//               motionMode ∈ 'drift'|'upward'|'burst'|'rotate'|'inward'
//   fog      — { enabled, color, density } (FogExp2)
//   pulse    — optional time-based modulation
//               { node, base, amp, freq }  on postfx intensity
//               { uniform: 'nebulaIntensity', base, amp, freq } on bg dimmer
//
// Numbers chosen to land each biome's palette target without ever clipping —
// HUD + bullets always win on luminance.

const PRESETS = Object.freeze({
  // Nebula Drift — moody purple/cyan, soft fog, slow floating motes.
  'nebula-drift': {
    post: {
      bloom:    0.85,
      ca:       0.35,
      grain:    0.025,
      vignette: 0.55,
      lensing:  0.50,
      dof:      0.45,
      motionBlur: 0.35,
    },
    palette: 'nebula',
    nebula: { intensity: 0.62 },
    particles: {
      sparkRate: 6,             // motes/sec emitted near singularity
      sparkColor: 0x9ad6ff,
      sparkSpeed: 1.2,
      sparkLife: 3.5,
      sparkDrift: { x: 0, y: 0, z: 0 },
      sparkSpread: 18,
      motionMode: 'drift',
    },
    fog: { enabled: true, color: 0x1a0a36, density: 0.018 },
    pulse: null,
  },

  // Accretion Verge — warm, hot bloom + CA, ember sparks rising upward.
  'accretion-verge': {
    post: {
      bloom:    1.10,
      ca:       0.75,
      grain:    0.030,
      vignette: 0.45,
      lensing:  0.65,
      dof:      0.40,
      motionBlur: 0.45,
    },
    palette: 'accretion',
    nebula: { intensity: 0.68 },
    particles: {
      sparkRate: 14,
      sparkColor: 0xffa040,
      sparkSpeed: 4.0,
      sparkLife: 1.2,
      sparkDrift: { x: 0, y: 3.5, z: 0 },   // upward bias
      sparkSpread: 22,
      motionMode: 'upward',
    },
    fog: { enabled: true, color: 0x2a0a00, density: 0.008 },
    pulse: null,
  },

  // Pulsar Field — clear, sharp, white/violet, rhythmic brightness bursts.
  'pulsar-field': {
    post: {
      bloom:    1.20,
      ca:       0.40,
      grain:    0.020,
      vignette: 0.30,
      lensing:  0.45,
      dof:      0.35,
      motionBlur: 0.30,
    },
    palette: 'singularity_core',           // white/violet/black — matches spec
    nebula: { intensity: 0.55 },
    particles: {
      sparkRate: 0,                         // emitted in bursts via pulse
      sparkColor: 0xf2eaff,
      sparkSpeed: 12.0,
      sparkLife: 0.5,
      sparkDrift: { x: 0, y: 0, z: 0 },
      sparkSpread: 0.5,                     // burst from center
      motionMode: 'burst',
      burstEvery: 1.2,                      // seconds — the pulse rhythm
      burstCount: 32,
    },
    fog: { enabled: false, color: 0x000000, density: 0 },
    pulse: {
      // Bloom + nebula brightness sync to a 1.2s pulse — that's the rhythm.
      freq: 1 / 1.2,
      bloom: { base: 1.20, amp: 0.35 },
      nebulaIntensity: { base: 0.55, amp: 0.18 },
    },
  },

  // Debris Belt — desaturated, dusty, slow rotating dust clouds.
  'debris-belt': {
    post: {
      bloom:    0.55,
      ca:       0.25,
      grain:    0.045,                      // more grit
      vignette: 0.80,                       // boost
      lensing:  0.40,
      dof:      0.55,
      motionBlur: 0.40,
    },
    palette: 'omega',                       // muted grays — closest in table
    nebula: { intensity: 0.45 },
    particles: {
      sparkRate: 10,
      sparkColor: 0x8a7a6a,                 // dusty tan
      sparkSpeed: 0.8,
      sparkLife: 4.0,
      sparkDrift: { x: 0, y: 0, z: 0 },
      sparkSpread: 26,
      motionMode: 'rotate',
      rotateSpeed: 0.15,                    // rad/s tangential bias
    },
    fog: { enabled: true, color: 0x3a342c, density: 0.022 },
    pulse: null,
  },

  // Event Horizon — extreme vignette + lensing, inward spiral, deep red/magenta.
  'event-horizon': {
    post: {
      bloom:    0.95,
      ca:       0.85,
      grain:    0.030,
      vignette: 0.95,                       // extreme
      lensing:  0.95,                       // boost
      dof:      0.60,
      motionBlur: 0.55,
    },
    palette: 'event_horizon',
    nebula: { intensity: 0.50 },
    particles: {
      sparkRate: 18,
      sparkColor: 0xff2a8a,
      sparkSpeed: 6.0,
      sparkLife: 1.8,
      sparkDrift: { x: 0, y: 0, z: 0 },
      sparkSpread: 24,
      motionMode: 'inward',                 // pull toward singularity
    },
    // Dense at edges, clear at center — FogExp2 is uniform; we lean on heavy
    // vignette + lensing for the edge bias and keep density moderate-high.
    fog: { enabled: true, color: 0x180008, density: 0.025 },
    pulse: null,
  },
});

// Alias map — accepts every reasonable spelling, including director.js ids.
const ALIASES = Object.freeze({
  'nebula':           'nebula-drift',
  'nebula-drift':     'nebula-drift',
  'nebuladrift':      'nebula-drift',

  'accretion':        'accretion-verge',
  'accretion-verge':  'accretion-verge',
  'accretionverge':   'accretion-verge',

  'pulsar':           'pulsar-field',
  'pulsar-field':     'pulsar-field',
  'pulsarfield':      'pulsar-field',

  'debris':           'debris-belt',
  'debris-belt':      'debris-belt',
  'debrisbelt':       'debris-belt',

  'event-horizon':    'event-horizon',
  'eventhorizon':     'event-horizon',
  'event_horizon':    'event-horizon',
  // Legacy director ids that don't yet have their own preset — alias to the
  // closest visual cousin so the run doesn't fall through to default.
  'singularity-core': 'event-horizon',
  'omega':            'event-horizon',
});

const DEFAULT_ID = 'nebula-drift';

function normalizeBiomeId(id) {
  if (!id) return DEFAULT_ID;
  const key = String(id).toLowerCase().trim();
  return ALIASES[key] ?? DEFAULT_ID;
}

// Deep-freeze copy helper for getBiomeSkin so callers can't mutate presets.
function clonePreset(p) {
  // Small, flat-ish structure — JSON round-trip is fine and avoids prototype
  // pollution / sharing of nested refs.
  return JSON.parse(JSON.stringify(p));
}

// ──────────────────────────────────────────────────────────────────────────
// BiomeSkins
// ──────────────────────────────────────────────────────────────────────────

const _tmpVec = new Vector3();
const _tmpOrigin = new Vector3();

export class BiomeSkins {
  /**
   * @param {object}  opts
   * @param {*}       opts.postfx     PostFX or the createPostFX() handle
   * @param {*}       opts.vfx        VFXManager
   * @param {*}       opts.particles  ParticleManager
   * @param {*}       [opts.renderer] WebGPURenderer (held for parity; not required)
   * @param {*}       [opts.scene]    THREE.Scene (for fog assignment)
   * @param {string}  [opts.initial='nebula-drift']
   */
  constructor({ postfx, vfx, particles, renderer = null, scene = null, initial = DEFAULT_ID } = {}) {
    if (!postfx) throw new Error('BiomeSkins: postfx required');
    if (!vfx)    throw new Error('BiomeSkins: vfx required');
    if (!particles) throw new Error('BiomeSkins: particles required');

    // postfx may be either a PostFX instance or the createPostFX() handle.
    // Both expose setIntensity via .fx or directly.
    this._postfx = postfx.fx ?? postfx;
    this._vfx = vfx;
    this._particles = particles;
    this._renderer = renderer;
    this._scene = scene ?? null;

    this._disposed = false;

    // Active state.
    this._currentId = normalizeBiomeId(initial);
    this._timeInBiome = 0;
    this._burstAccum = 0;

    // Fog ownership: we install a single FogExp2 on first enable and keep it
    // around so we never reallocate. Tweaks are pure attribute writes.
    this._fog = null;          // FogExp2 instance (created on demand)
    this._prevFog = scene?.fog ?? null;  // remember what was there (we'll restore on dispose)

    // PostFX node names we drive — only those actually present in PostFX.
    this._postNodes = ['bloom', 'ca', 'grain', 'vignette', 'lensing', 'dof', 'motionBlur'];

    // Apply initial preset immediately so the first frame is correctly tinted.
    this._apply(this._currentId);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Preload — kept as a no-op today: every visual asset (palettes, bg shader,
  // particle pools, post graph) is already constructed by the time BiomeSkins
  // sees them, so there is nothing to compile. The method exists so callers
  // can wire it into a future asset bake without API churn.
  // ────────────────────────────────────────────────────────────────────────
  preload() {
    if (this._disposed) return;
    // Touch every preset to ensure aliases resolve up front (cheap validation).
    for (const id of Object.keys(PRESETS)) {
      // ignore — just ensures the table is reachable.
      void PRESETS[id];
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // setBiome — swap to a different skin. Pure parameter writes; no recompile.
  // ────────────────────────────────────────────────────────────────────────
  setBiome(biomeId) {
    if (this._disposed) return;
    const id = normalizeBiomeId(biomeId);
    if (id === this._currentId) return;
    this._currentId = id;
    this._timeInBiome = 0;
    this._burstAccum = 0;
    this._apply(id);
  }

  /** Returns an immutable copy of the resolved preset for inspection. */
  getBiomeSkin(biomeId) {
    const id = normalizeBiomeId(biomeId);
    return clonePreset(PRESETS[id]);
  }

  /** Currently active resolved id. */
  getCurrentId() { return this._currentId; }

  // ────────────────────────────────────────────────────────────────────────
  // update — advance time-based modulations (pulsar pulse, burst emission).
  // No-op when the active biome has no pulse / no burst pattern.
  // ────────────────────────────────────────────────────────────────────────
  update(dt, biomeId = null) {
    if (this._disposed) return;
    if (!Number.isFinite(dt) || dt <= 0) return;

    // Late-switch via update(): cheap; honours the "no extra frame" contract.
    if (biomeId != null) {
      const id = normalizeBiomeId(biomeId);
      if (id !== this._currentId) this.setBiome(id);
    }

    this._timeInBiome += dt;

    const preset = PRESETS[this._currentId];
    if (!preset) return;

    // ── pulse: sinusoidal modulation of bloom + nebula brightness ────────
    if (preset.pulse) {
      const w = 2 * Math.PI * preset.pulse.freq;
      const s = Math.sin(w * this._timeInBiome);   // -1..1
      const half = 0.5 + 0.5 * s;                  // 0..1 envelope (more readable)

      if (preset.pulse.bloom) {
        const v = preset.pulse.bloom.base + preset.pulse.bloom.amp * s;
        this._setPostIntensity('bloom', v);
      }
      if (preset.pulse.nebulaIntensity) {
        const v = preset.pulse.nebulaIntensity.base + preset.pulse.nebulaIntensity.amp * s;
        this._setNebulaIntensity(v);
      }

      // Burst particle emission synced to peak.
      const p = preset.particles;
      if (p && p.motionMode === 'burst' && p.burstEvery > 0) {
        this._burstAccum += dt;
        if (this._burstAccum >= p.burstEvery) {
          this._burstAccum -= p.burstEvery;
          this._emitBurst(p);
        }
      }
      // suppress unused var hint
      void half;
    }

    // ── continuous emission (drift, upward, rotate, inward) ───────────────
    const p = preset.particles;
    if (p && p.sparkRate > 0 && p.motionMode !== 'burst') {
      this._emitContinuous(p, dt);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // dispose — restore the previous fog and detach. Does not destroy postfx,
  // vfx or particles (we don't own them).
  // ────────────────────────────────────────────────────────────────────────
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._scene) {
      // Restore prior fog (or remove ours).
      this._scene.fog = this._prevFog ?? null;
    }
    this._fog = null;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────────────

  _apply(id) {
    const preset = PRESETS[id];
    if (!preset) return;

    // 1) Post-FX node intensities — only setIntensity, never rebuild().
    for (const name of this._postNodes) {
      const v = preset.post?.[name];
      if (v != null) this._setPostIntensity(name, v);
    }

    // 2) VFX nebula palette + global brightness.
    try { this._vfx.setBiomePalette?.(preset.palette); } catch { /* ignore */ }
    if (preset.nebula?.intensity != null) {
      this._setNebulaIntensity(preset.nebula.intensity);
    }

    // 3) Scene fog.
    if (this._scene) this._applyFog(preset.fog);

    // 4) Particles: there is no per-rate API on ParticleManager, so we drive
    //    emission ourselves via update(). Reset transient state.
    this._burstAccum = 0;
  }

  _setPostIntensity(name, v) {
    const fx = this._postfx;
    if (!fx || typeof fx.setIntensity !== 'function') return;
    // setIntensity clamps to 0..1 internally for the gated intensities; we
    // pass through so bloom (which we want above 1 sometimes) still lands.
    // PostFX's setIntensity clamps 0..1 — for values above 1 we still want a
    // visible boost, so clamp here too.
    fx.setIntensity(name, Math.max(0, Math.min(1, v)));
  }

  _setNebulaIntensity(v) {
    // Reach into the VFXManager's background shader uniform. Pure scalar write.
    const u = this._vfx?._bgMat?.uniforms?.uIntensity;
    if (u) u.value = Math.max(0, v);
  }

  _applyFog(fogSpec) {
    if (!this._scene) return;
    if (!fogSpec || !fogSpec.enabled) {
      // Disable fog (but keep our instance around for reuse).
      this._scene.fog = null;
      return;
    }
    if (!this._fog) {
      this._fog = new FogExp2(fogSpec.color ?? 0x000000, fogSpec.density ?? 0.01);
    } else {
      this._fog.color = new Color(fogSpec.color ?? 0x000000);
      this._fog.density = fogSpec.density ?? 0.01;
    }
    this._scene.fog = this._fog;
  }

  // ── particle emission helpers ───────────────────────────────────────────

  /** Singularity / origin lookup — falls back to (0,0,0). */
  _origin() {
    const g = this._particles?.gravity;
    const c = g?.center;
    if (c) _tmpOrigin.set(c.x ?? 0, c.y ?? 0, c.z ?? 0);
    else   _tmpOrigin.set(0, 0, 0);
    return _tmpOrigin;
  }

  _emitContinuous(p, dt) {
    // We accumulate a fractional emit count so low rates still produce one
    // particle every few frames without per-frame allocation.
    const target = p.sparkRate * dt;
    // Use a per-instance accumulator stored on the closure.
    this._contAccum = (this._contAccum ?? 0) + target;
    if (this._contAccum < 1) return;
    const n = Math.floor(this._contAccum);
    this._contAccum -= n;

    const origin = this._origin();
    const opts = this._sparkOpts(p);

    if (p.motionMode === 'inward') {
      // Spawn far, fly inward — invert speed direction by emitting at outer
      // ring and reusing the sparks system's natural gravity pull (sparks are
      // already gravity-affected at 45% strength).
      // Offset origin to a random ring point so velocity is mostly tangential.
      this._emitRingFromOrigin(origin, n, opts, p.sparkSpread, 0);
      return;
    }

    if (p.motionMode === 'rotate') {
      this._emitRingFromOrigin(origin, n, opts, p.sparkSpread, p.rotateSpeed ?? 0.1);
      return;
    }

    if (p.motionMode === 'upward') {
      // Spread on XZ, push upward via drift bias on velocity.
      _tmpVec.set(
        origin.x + (Math.random() - 0.5) * p.sparkSpread,
        origin.y + (Math.random() - 0.5) * 0.5,
        origin.z + (Math.random() - 0.5) * p.sparkSpread,
      );
      this._particles.emit('sparks', _tmpVec, n, opts);
      return;
    }

    // drift (default): scatter widely, slow speed, long life.
    _tmpVec.set(
      origin.x + (Math.random() - 0.5) * p.sparkSpread,
      origin.y + (Math.random() - 0.5) * 1.0,
      origin.z + (Math.random() - 0.5) * p.sparkSpread,
    );
    this._particles.emit('sparks', _tmpVec, n, opts);
  }

  _emitBurst(p) {
    const origin = this._origin();
    const opts = this._sparkOpts(p);
    // Burst from center, radial.
    _tmpVec.set(origin.x, origin.y, origin.z);
    this._particles.emit('sparks', _tmpVec, p.burstCount ?? 24, opts);
  }

  _emitRingFromOrigin(center, n, opts, spread, _tangentialHint) {
    // Spawn points distributed on a ring of radius ~spread/2. ParticleManager's
    // sparks system applies gravity pull and drag, so inward/rotate motion
    // emerges naturally; we just place the seed and pick a velocity flavor.
    const r = Math.max(1, spread * 0.5);
    for (let k = 0; k < n; k++) {
      const th = Math.random() * Math.PI * 2;
      _tmpVec.set(
        center.x + Math.cos(th) * r,
        center.y + (Math.random() - 0.5) * 0.6,
        center.z + Math.sin(th) * r,
      );
      this._particles.emit('sparks', _tmpVec, 1, opts);
    }
  }

  _sparkOpts(p) {
    return {
      colorHex: p.sparkColor ?? 0xffffff,
      speed:    p.sparkSpeed ?? 4,
      life:     p.sparkLife  ?? 1.0,
    };
  }
}

// Convenience: re-export the preset table (frozen) and the alias map for
// tests / inspectors. Mutating these from outside is a no-op (Object.freeze).
export const BIOME_PRESETS = PRESETS;
export const BIOME_ALIASES = ALIASES;

export default BiomeSkins;
