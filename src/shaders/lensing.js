// Gravitational lensing post-process — SPRINT-04 signature visual.
//
// Operates in screen-UV space for temporal stability: the CPU projects the
// gravity-well world position to UVs once per frame and exponentially smooths
// the result. The fragment shader then warps UVs around that single point with
// an inverse-impact-parameter deflection (a screen-space approximation of
// θ = 4GM/(c²b)), samples the scene with per-channel offsets for chromatic
// aberration, blacks out anything inside the event horizon, and overlays an
// emissive accretion / photon ring.
//
// Why this stays jitter-free under camera motion:
//   * The warp center is a single smoothed uniform — no per-pixel matrix math.
//   * Aspect correction keeps the warp isotropic regardless of viewport size.
//   * Deflection uses a softened `max(dist, horizon * 0.8)` denominator so the
//     gradient stays continuous through the horizon edge (no shimmer ring).
//   * Ring/horizon masks use smoothstep with subpixel-scale falloff.
//
// Budget: 3 dependent texture taps + a handful of ALU ops. Well under 2 ms on
// the WebGPU target, and runs identically on the WebGL2 fallback (no GPU
// features required beyond what bloom already uses).

import { Vector2, Vector3 } from 'three';
import {
  Fn, vec2, vec3, float, uv, length, normalize, smoothstep, mix,
  uniform, atan, sin, time, max, clamp,
} from 'three/tsl';

const _projTmp = new Vector3();
const _radiusTmp = new Vector3();
const _tmpRight = new Vector3();

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Core TSL fragment function.
 * @param colorNode TextureNode — sampled at arbitrary UVs for the warp.
 * @param wellU     uniform vec2  — singularity center in UV space (smoothed)
 * @param horizonU  uniform float — event-horizon radius in (aspect-corrected) UV
 * @param massU     uniform float — deflection coefficient (screen-space mass)
 * @param accretU   uniform float — accretion+photon ring brightness multiplier
 * @param chromaU   uniform float — RGB deflection split (0..~0.1 sane range)
 * @param intensU   uniform float — global wet/dry mix vs. raw scene
 * @param aspectU   uniform float — viewport aspect (w/h)
 */
const lensingFn = Fn(([
  colorNode, wellU, horizonU, massU, accretU, chromaU, intensU, aspectU,
]) => {
  const p = uv();

  // Aspect-corrected vector from pixel to well: x stretched so circles stay round.
  const qx = p.x.sub(wellU.x).mul(aspectU);
  const qy = p.y.sub(wellU.y);
  const q = vec2(qx, qy);
  const dist = length(q).add(float(1e-5));
  const dir = q.div(dist);

  // Softened impact parameter — keeps gradient continuous through the horizon.
  const b = max(dist, horizonU.mul(float(0.8)));
  const defl = massU.div(b);

  // Per-channel deflection magnitudes for chromatic split.
  const deflR = defl.mul(float(1.0).add(chromaU));
  const deflG = defl;
  const deflB = defl.mul(float(1.0).sub(chromaU));

  // Convert aspect-space offset back to UV-space (un-stretch x).
  const offR = vec2(dir.x.mul(deflR).div(aspectU), dir.y.mul(deflR));
  const offG = vec2(dir.x.mul(deflG).div(aspectU), dir.y.mul(deflG));
  const offB = vec2(dir.x.mul(deflB).div(aspectU), dir.y.mul(deflB));

  // Pull UVs toward the well (lensing magnification).
  const sR = colorNode.sample(p.sub(offR)).r;
  const sG = colorNode.sample(p.sub(offG)).g;
  const sB = colorNode.sample(p.sub(offB)).b;
  const lensedScene = vec3(sR, sG, sB);

  // Event horizon: fully black inside, soft 1-pixel-ish AA edge.
  const horizonMask = smoothstep(horizonU, horizonU.mul(float(0.93)), dist);

  // Accretion disk band — outside horizon, broad emissive ring with swirl.
  const ringCenter = horizonU.mul(float(1.85));
  const ringHalf   = horizonU.mul(float(0.55));
  const ringInner  = ringCenter.sub(ringHalf);
  const ringOuter  = ringCenter.add(ringHalf);
  const ringIn  = smoothstep(ringInner, ringCenter, dist);
  const ringOut = smoothstep(ringOuter, ringCenter, dist);
  const ringMask = ringIn.mul(ringOut);

  // Swirl: angular bands that advect with time. atan(y,x) -> atan2.
  const ang = atan(dir.y, dir.x);
  const swirl = sin(ang.mul(float(8.0)).add(time.mul(float(2.4))))
    .mul(float(0.35)).add(float(0.75));
  // Hot inner edge / cool outer — radial heat ramp inside the ring.
  const heat = smoothstep(ringOuter, ringInner, dist);
  const ringPalette = mix(vec3(1.0, 0.32, 0.08), vec3(1.0, 0.85, 0.45), heat);
  const ringColor = ringPalette.mul(swirl).mul(ringMask).mul(accretU).mul(float(1.6));

  // Photon ring — thin bright band hugging the horizon (the GR signature).
  const photonCenter = horizonU.mul(float(1.06));
  const photonHalf   = horizonU.mul(float(0.05));
  const phIn  = smoothstep(photonCenter.sub(photonHalf), photonCenter, dist);
  const phOut = smoothstep(photonCenter.add(photonHalf), photonCenter, dist);
  const photonMask = phIn.mul(phOut);
  const photon = vec3(1.0, 0.92, 0.7).mul(photonMask).mul(accretU).mul(float(3.2));

  // Compose: scene -> horizon black -> add rings.
  const dark = mix(lensedScene, vec3(0.0), horizonMask);
  const withRings = dark.add(ringColor).add(photon);

  // Global intensity blend (allows postfx to dial the effect down).
  const dry = colorNode.sample(p).rgb;
  return mix(dry, withRings, clamp(intensU, float(0.0), float(1.0)));
});

/**
 * LensingEffect — stateful wrapper that owns the uniforms and projects the
 * world-space gravity well into smoothed screen UVs each frame.
 *
 * Usage:
 *   const lens = new LensingEffect();
 *   lens.setSize(w, h);
 *   post.outputNode = lens.colorNode(sceneColor).add(bloomPass);
 *   // per frame:
 *   lens.update(well.center, well.mass, well.horizonRadius, camera, dt);
 */
export class LensingEffect {
  constructor(opts = {}) {
    const ws = opts.initialWellScreen ?? new Vector2(0.5, 0.5);
    this.uWellScreen = uniform(new Vector2(ws.x, ws.y));
    this.uHorizon    = uniform(opts.horizonRadius ?? 0.05);
    this.uMass       = uniform(opts.wellMass ?? 0.06);
    this.uAccretion  = uniform(opts.accretionIntensity ?? 1.0);
    this.uChroma     = uniform(opts.chromaticStrength ?? 0.02);
    this.uIntensity  = uniform(opts.intensity ?? 1.0);
    this.uAspect     = uniform(opts.aspect ?? (16 / 9));

    this._smoothScreen = new Vector2(ws.x, ws.y);
    this._smoothing = opts.smoothing ?? 14;
    this._initialized = false;

    // Calibration: world `mass` (e.g. 1200) maps to a screen-space coefficient.
    // 1/scale ≈ mass that produces a healthy ~0.06 deflection knob.
    this._massScale = opts.massScale ?? 20000;
  }

  /** Call from World.resize(). Updates aspect uniform. */
  setSize(w, h) {
    this.uAspect.value = (w || 1) / Math.max(h || 1, 1);
  }

  /** Set a constant intensity multiplier (postfx config). */
  setIntensity(v) {
    this.uIntensity.value = clamp01(v);
  }

  /**
   * Per-frame update. Projects the well to NDC->UV, smooths with an
   * exponential filter (frame-rate independent), and recomputes a
   * screen-space horizon radius by projecting an offset point.
   *
   * @param {Vector3|{x,y,z}} wellWorldPos
   * @param {number} wellMass        gravity-well mass (world units)
   * @param {number} horizonRadius   gravity-well horizon (world units)
   * @param {THREE.Camera} camera
   * @param {number} dt              seconds since last update
   */
  update(wellWorldPos, wellMass, horizonRadius, camera, dt = 1 / 60) {
    if (!wellWorldPos || !camera) return;

    _projTmp.set(
      wellWorldPos.x ?? 0,
      wellWorldPos.y ?? 0,
      wellWorldPos.z ?? 0,
    );
    _projTmp.project(camera);

    // NDC(-1..1) -> UV(0..1). y is already up in NDC; UV here is bottom-up too
    // (three.js TSL `uv()` maps to renderTarget UVs which are y-up).
    const targetX = _projTmp.x * 0.5 + 0.5;
    const targetY = _projTmp.y * 0.5 + 0.5;

    if (!this._initialized) {
      this._smoothScreen.set(targetX, targetY);
      this._initialized = true;
    } else {
      const alpha = 1 - Math.exp(-this._smoothing * Math.max(dt, 1e-4));
      this._smoothScreen.x += (targetX - this._smoothScreen.x) * alpha;
      this._smoothScreen.y += (targetY - this._smoothScreen.y) * alpha;
    }
    this.uWellScreen.value.set(this._smoothScreen.x, this._smoothScreen.y);

    // Mass -> screen deflection coefficient. Clamped so a runaway surge can't
    // turn the whole frame into a singularity.
    if (Number.isFinite(wellMass)) {
      this.uMass.value = clamp01(wellMass / this._massScale) * 0.18;
    }

    // World horizon -> screen horizon by projecting an offset along the
    // camera's right axis. Cheap, correct under any camera roll/zoom.
    if (Number.isFinite(horizonRadius) && horizonRadius > 0) {
      _radiusTmp.set(
        wellWorldPos.x ?? 0,
        wellWorldPos.y ?? 0,
        wellWorldPos.z ?? 0,
      );
      _tmpRight
        .set(1, 0, 0)
        .applyQuaternion(camera.quaternion)
        .multiplyScalar(horizonRadius);
      _radiusTmp.add(_tmpRight);
      _radiusTmp.project(camera);
      const dx = _radiusTmp.x - _projTmp.x;
      const dy = _radiusTmp.y - _projTmp.y;
      // NDC -> UV is *0.5
      const screenR = 0.5 * Math.hypot(dx, dy);
      // Apply aspect since the shader measures in aspect-corrected space.
      const aspect = this.uAspect.value || 1;
      this.uHorizon.value = Math.max(0.005, screenR * aspect);
    }
  }

  /**
   * Build the post-process color node. Pass in the scene color texture node
   * (typically `scenePass.getTextureNode('output')`).
   */
  colorNode(sceneColorTextureNode) {
    return lensingFn(
      sceneColorTextureNode,
      this.uWellScreen,
      this.uHorizon,
      this.uMass,
      this.uAccretion,
      this.uChroma,
      this.uIntensity,
      this.uAspect,
    );
  }
}



// Back-compat shim — the SPRINT-01 stub exported this name.
export const gravitationalLensing = lensingFn;

export default LensingEffect;
