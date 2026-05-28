// Post-processing graph (WebGPU-native, TSL nodes) for SPRINT-04.
//
// Pipeline order:
//   scenePass(color, depth)
//     -> GTAO        (high+)     multiplies AO into color
//     -> SSR         (ultra)     blends reflective accumulation
//     -> bloom       (all)       additive emissive bloom
//     -> lensing     (high+)     stub passthrough — WO-04-A2 hardens this
//     -> DOF         (medium+)   bokeh radius driven by intensity
//     -> motionBlur  (high+)     camera-velocity approximation
//     -> CA + grain + vignette (high+)
//     -> ACES        (all)       applied by PostProcessing via outputColorTransform=true
//
// Each node has: { enabled, intensity, tier } and is individually toggleable via
// enableNode(name, bool). getNodes() exposes the live state + a CPU ms placeholder
// the profiler can drive (GPU per-node timing isn't exposed by WebGPURenderer yet).
//
// Tier policy:
//   ultra:  all nodes enabled
//   high:   GTAO, bloom, lensing, DOF, motionBlur, CA, grain, vignette  (no SSR)
//   medium: bloom, lensing, DOF (reduced), vignette                     (no GTAO/SSR/motionBlur/CA/grain)
//   low:    bloom + tonemap only
//
// Output color transform stays true so three.js wraps the graph with renderOutput()
// (renderer.toneMapping = ACESFilmicToneMapping, outputColorSpace = sRGB). Same graph
// runs on WebGPU and the WebGL2 fallback that three.js auto-selects internally.

import { PostProcessing, Vector3 } from 'three/webgpu';
import {
  pass, uniform, uv, vec2, vec3, vec4, float, mix, smoothstep, length,
  texture, time, hash, sin, fract, dot, rtt,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { motionBlur } from 'three/addons/tsl/display/MotionBlur.js';
import { chromaticAberration } from 'three/addons/tsl/display/ChromaticAberrationNode.js';
import { film } from 'three/addons/tsl/display/FilmNode.js';
import { LensingEffect } from '../shaders/lensing.js';

// ---------------------------------------------------------------------------
// Tier defaults — { enabled, intensity, tier-min }
// ---------------------------------------------------------------------------
const NODE_DEFS = {
  gtao:       { tier: 'high',   intensity: 0.7 },
  ssr:        { tier: 'ultra',  intensity: 0.5 },
  bloom:      { tier: 'low',    intensity: 0.8 },
  lensing:    { tier: 'high',   intensity: 0.6 }, // stub
  dof:        { tier: 'medium', intensity: 0.5 },
  motionBlur: { tier: 'high',   intensity: 0.4 },
  ca:         { tier: 'high',   intensity: 0.5 },
  grain:      { tier: 'high',   intensity: 0.03 },
  vignette:   { tier: 'medium', intensity: 0.5 },
};

const TIER_ORDER = { low: 0, medium: 1, high: 2, ultra: 3 };

function tierAllows(active, required) {
  return (TIER_ORDER[active] ?? 0) >= (TIER_ORDER[required] ?? 0);
}

// Detect whether the renderer is the WebGL2 fallback. SSR/GTAO need depth
// sampling that works on both, but motionBlur velocity MRT requires extra
// plumbing — we keep it simple here and still allow the chain on WebGL2.
function isWebGPU(renderer) {
  return !!(renderer && renderer.backend && renderer.backend.isWebGPUBackend);
}

// ---------------------------------------------------------------------------
// PostFX — the public class
// ---------------------------------------------------------------------------
export class PostFX {
  /**
   * @param {object} opts
   * @param {THREE.WebGPURenderer} opts.renderer
   * @param {THREE.Scene}          opts.scene
   * @param {THREE.Camera}         opts.camera
   * @param {string}               [opts.tier='high']  'low'|'medium'|'high'|'ultra'
   * @param {object}               [opts.profiler]     optional Profiler instance
   */
  constructor({ renderer, scene, camera, tier = 'high', profiler = null }) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.tier = tier;
    this.profiler = profiler;
    this._webgpu = isWebGPU(renderer);

    // Per-node live state. Cloned from NODE_DEFS, enabled flag derived from tier.
    this.nodes = {};
    for (const [name, def] of Object.entries(NODE_DEFS)) {
      this.nodes[name] = {
        name,
        tier: def.tier,
        intensity: def.intensity,
        enabled: tierAllows(this.tier, def.tier),
        ms: 0, // populated externally if/when GPU timestamps are wired
      };
    }

    // Camera-velocity tracking for motion-blur fallback (no MRT velocity yet).
    this._prevCamPos = new Vector3().copy(camera.position);
    this._velocityUniform = uniform(vec2(0, 0));
    this._timeAccum = 0;
    this.lastRenderMs = 0;

    // Intensity uniforms — bound once, mutated each frame via _syncUniforms().
    this._u = {
      gtao:       uniform(this.nodes.gtao.intensity),
      ssr:        uniform(this.nodes.ssr.intensity),
      lensing:    uniform(this.nodes.lensing.intensity),
      dof:        uniform(this.nodes.dof.intensity),
      motionBlur: uniform(this.nodes.motionBlur.intensity),
      ca:         uniform(this.nodes.ca.intensity),
      grain:      uniform(this.nodes.grain.intensity),
      vignette:   uniform(this.nodes.vignette.intensity),
    };

    // Lensing effect — real implementation (SPRINT-04 signature). Owns its
    // own uniforms internally; we forward _u.lensing into its intensity each
    // frame via _syncUniforms().
    this._lensing = new LensingEffect({
      intensity:          this.nodes.lensing.intensity,
      accretionIntensity: 1.0,
      chromaticStrength:  0.02,
    });

    this.post = new PostProcessing(renderer);
    this._build();
  }

  // -------------------------------------------------------------------------
  // Chain construction
  // -------------------------------------------------------------------------
  _build() {
    const { scene, camera } = this;

    const scenePass = pass(scene, camera);
    this.scenePass = scenePass;

    const sceneColor = scenePass.getTextureNode('output');
    const sceneDepth = scenePass.getTextureNode('depth');
    const viewZ      = scenePass.getViewZNode();

    let color = sceneColor;

    // -------- GTAO (high+) -- multiplies AO into the beauty pass --------
    if (this._isOn('gtao')) {
      try {
        const aoPass = ao(sceneDepth, null, camera);
        // Tuned conservatively so the placeholder-Basic-material scene doesn't go pitch black.
        aoPass.radius.value = 0.25;
        aoPass.thickness.value = 1.0;
        const aoFactor = aoPass.getTextureNode().r;
        // Mix between 1.0 (no AO) and aoFactor based on intensity uniform.
        const aoMix = mix(float(1.0), aoFactor, this._u.gtao);
        color = vec4(color.rgb.mul(aoMix), color.a);
        this._gtaoPass = aoPass;
      } catch (e) {
        console.warn('[postfx] GTAO disabled:', e?.message ?? e);
        this.nodes.gtao.enabled = false;
      }
    }

    // -------- SSR (ultra only) -- skipped on WebGL2 fallback --------
    if (this._isOn('ssr') && this._webgpu) {
      try {
        // Scene currently uses MeshBasicMaterial — no real normals/metalness MRT.
        // We provide constant fallbacks so the chain compiles. Effective reflection
        // contribution is near-zero (metalness ~ 0) until SPRINT-04-A2 plumbs MRT.
        const fakeNormal    = vec3(0, 1, 0);
        const fakeMetalness = float(0.0);
        const fakeRoughness = float(1.0);
        const ssrPass = ssr(color, sceneDepth, fakeNormal, fakeMetalness, fakeRoughness, camera);
        const ssrColor = ssrPass.getTextureNode();
        color = mix(color, ssrColor, this._u.ssr.mul(float(0.5)));
        this._ssrPass = ssrPass;
      } catch (e) {
        console.warn('[postfx] SSR disabled:', e?.message ?? e);
        this.nodes.ssr.enabled = false;
      }
    }

    // -------- Bloom (all tiers) --------
    if (this._isOn('bloom')) {
      // (strength, radius, threshold). Threshold high so only true emissives bloom.
      const strength = this.nodes.bloom.intensity;
      const bloomPass = bloom(color, strength, 0.6, 0.85);
      color = color.add(bloomPass);
      this.bloomPass = bloomPass;
    }

    // -------- Gravitational lensing (high+) — screen-space ray deflection --------
    // We snapshot the current chain into an RTT so the lensing fragment can
    // sample it at warped UVs. The effect handles chromatic split, the event-
    // horizon shadow, and the accretion + photon rings internally.
    if (this._isOn('lensing')) {
      try {
        const colorTex = rtt(color);
        color = this._lensing.colorNode(colorTex);
      } catch (e) {
        console.warn('[postfx] lensing disabled:', e?.message ?? e);
        this.nodes.lensing.enabled = false;
      }
    }

    // -------- DOF (medium+) --------
    if (this._isOn('dof')) {
      try {
        const intensity = this.nodes.dof.intensity;
        // Reduced bokeh on medium per the tier policy.
        const bokehScale = tierAllows(this.tier, 'high') ? 1.5 : 0.6;
        // Focus on the singularity (origin); focal length covers the playfield.
        const dofPass = dof(color, viewZ, uniform(26.0), uniform(18.0), uniform(bokehScale * intensity));
        // dof returns vec4 directly.
        color = dofPass;
        this._dofPass = dofPass;
      } catch (e) {
        console.warn('[postfx] DOF disabled:', e?.message ?? e);
        this.nodes.dof.enabled = false;
      }
    }

    // -------- Motion blur (high+) — camera-velocity approximation --------
    if (this._isOn('motionBlur')) {
      try {
        const v = this._velocityUniform.mul(this._u.motionBlur);
        color = motionBlur(color, v);
      } catch (e) {
        console.warn('[postfx] motionBlur disabled:', e?.message ?? e);
        this.nodes.motionBlur.enabled = false;
      }
    }

    // -------- Chromatic aberration (high+) --------
    if (this._isOn('ca')) {
      try {
        // ChromaticAberrationNode expects strength in 0..N — 0.3-0.8 px maps to ~0.005 range.
        const strength = this._u.ca.mul(float(0.006));
        color = chromaticAberration(color, strength);
      } catch (e) {
        console.warn('[postfx] CA disabled:', e?.message ?? e);
        this.nodes.ca.enabled = false;
      }
    }

    // -------- Film grain (high+) --------
    if (this._isOn('grain')) {
      try {
        color = film(color, this._u.grain);
      } catch (e) {
        console.warn('[postfx] grain disabled:', e?.message ?? e);
        this.nodes.grain.enabled = false;
      }
    }

    // -------- Vignette (medium+) -- inline radial darkening --------
    if (this._isOn('vignette')) {
      const uvc = uv().sub(vec2(0.5, 0.5));
      const r = length(uvc);
      // Darken edges. smoothstep(0.3, 0.95, r) -> 0 at centre, 1 at far corner.
      const v = smoothstep(float(0.3), float(0.95), r).mul(this._u.vignette);
      color = vec4(color.rgb.mul(float(1.0).sub(v)), color.a);
    }

    // PostProcessing applies ACES + sRGB via outputColorTransform=true (default).
    this.post.outputNode = color;
    this.post.needsUpdate = true;
  }

  _isOn(name) {
    const n = this.nodes[name];
    if (!n) return false;
    return n.enabled && tierAllows(this.tier, n.tier);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------
  setTier(tier) {
    if (!(tier in TIER_ORDER)) return;
    this.tier = tier;
    for (const [name, def] of Object.entries(NODE_DEFS)) {
      this.nodes[name].enabled = tierAllows(tier, def.tier);
    }
    this._build();
  }

  enableNode(name, on) {
    const n = this.nodes[name];
    if (!n) return;
    n.enabled = !!on && tierAllows(this.tier, n.tier);
    this._build();
  }

  setIntensity(name, v) {
    const n = this.nodes[name];
    if (!n) return;
    n.intensity = Math.max(0, Math.min(1, v));
    if (this._u[name]) this._u[name].value = n.intensity;
  }

  getNodes() {
    return Object.values(this.nodes).map((n) => ({
      name: n.name,
      enabled: n.enabled,
      tier: n.tier,
      intensity: n.intensity,
      ms: n.ms,
    }));
  }

  setSize(w, h) {
    this.post.setSize?.(w, h);
    this._lensing.setSize(w, h);
  }

  /**
   * Per-frame lensing update. Forward the current gravity-well state so the
   * effect projects the singularity centre into smoothed screen UVs.
   */
  updateLensing(wellPos, mass, horizonRadius, dt) {
    this._lensing.update(wellPos, mass, horizonRadius, this.camera, dt);
  }

  /**
   * Render one frame. dt is optional — used to advance camera-velocity for motion blur.
   */
  render(dt = 1 / 60) {
    this._syncUniforms(dt);
    const t0 = performance.now();
    const p = this.post.renderAsync();
    // Wall-clock around the async render call — captures CPU-side encoding cost
    // (true GPU time would require WebGPU timestamp-query-set, not yet exposed by
    // WebGPURenderer). Good enough for relative per-node deltas and budget gating.
    Promise.resolve(p).then(() => {
      this.lastRenderMs = performance.now() - t0;
    }).catch(() => { /* swallow; renderer surfaces its own errors */ });
    return p;
  }

  _syncUniforms(dt) {
    // Push intensity uniforms (cheap; only changes when API mutates).
    for (const k of Object.keys(this._u)) {
      this._u[k].value = this.nodes[k].intensity;
    }
    // Forward lensing intensity into the effect's own uniform.
    this._lensing.setIntensity(this.nodes.lensing.intensity);
    // Camera-velocity for motion blur fallback: world-delta projected to screen-space.
    const cp = this.camera.position;
    const dx = cp.x - this._prevCamPos.x;
    const dy = cp.y - this._prevCamPos.y;
    // Heuristic: scale by inverse fov and dt so fast cam swings get visible smear.
    const k = Math.min(0.02, (dt > 0 ? 1.0 : 0.0)); // clamp
    this._velocityUniform.value.set(dx * k, dy * k);
    this._prevCamPos.copy(cp);
  }

  rebuild() { this._build(); }
}

// ---------------------------------------------------------------------------
// Back-compat factory — keeps the SPRINT-01 call site (world.js) working
// while exposing the new class shape on the returned handle.
// ---------------------------------------------------------------------------
export function createPostFX(renderer, scene, camera, opts = {}) {
  const tier = opts.tier
    ?? (typeof window !== 'undefined' ? window.__OMEGA__?.cap?.tier : null)
    ?? 'high';
  const fx = new PostFX({ renderer, scene, camera, tier, profiler: opts.profiler ?? null });
  return {
    post:       fx.post,
    scenePass:  fx.scenePass,
    bloomPass:  fx.bloomPass,
    fx,
    setSize:    (w, h) => fx.setSize(w, h),
    render:     (dt)   => fx.render(dt),
    rebuild:    ()     => fx.rebuild(),
    setTier:    (t)    => fx.setTier(t),
    enableNode: (n, b) => fx.enableNode(n, b),
    getNodes:   ()     => fx.getNodes(),
    updateLensing: (p, m, h, dt) => fx.updateLensing(p, m, h, dt),
    lensing:    fx._lensing,
  };
}
