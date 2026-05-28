// Accretion disk material (TSL). HDR emissive ramp + angular swirl distortion.
// Authored to feed the bloom pass — output values can exceed 1.0 on purpose.
// SPRINT-04 swaps the host mesh for GPU-particle instancing; this material remains
// usable as the underlying ring fill.

import { AdditiveBlending, Color, DoubleSide } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn, uv, float, time, sin, mix, smoothstep, uniform, abs,
} from 'three/tsl';

/**
 * Build a TSL accretion-disk material.
 * Params are exposed as live uniforms on the returned object so the runtime
 * GUI / director can drive them without rebuilding the shader graph.
 *
 * @param {object} opts
 * @param {THREE.ColorRepresentation} [opts.colorInner]  Hot inner ring color
 * @param {THREE.ColorRepresentation} [opts.colorOuter]  Cool outer ring color
 * @param {number} [opts.intensity]   HDR multiplier (>=1 feeds bloom)
 * @param {number} [opts.swirlSpeed]  Angular advection rate (rad/s scale)
 * @param {number} [opts.swirlAmount] Magnitude of UV angular distortion
 */
export function createAccretionDiskMaterial(opts = {}) {
  const params = {
    colorInner: new Color(opts.colorInner ?? 0xffd66b),
    colorOuter: new Color(opts.colorOuter ?? 0xff2a08),
    intensity: opts.intensity ?? 4.5,
    swirlSpeed: opts.swirlSpeed ?? 1.6,
    swirlAmount: opts.swirlAmount ?? 0.35,
  };

  const uColorInner = uniform(params.colorInner);
  const uColorOuter = uniform(params.colorOuter);
  const uIntensity  = uniform(params.intensity);
  const uSwirlSpeed = uniform(params.swirlSpeed);
  const uSwirlAmt   = uniform(params.swirlAmount);

  const diskColor = Fn(() => {
    // Torus UVs: x ~ angle around main ring (0..1), y ~ cross-tube (0..1).
    const u = uv().x;
    const v = uv().y;

    // Radial coordinate centered on the tube (0 at midline, 1 at edges).
    const radial = abs(v.sub(float(0.5))).mul(float(2.0));

    // Angular advection — slower outer, faster inner (Keplerian-ish flavour).
    const t = time.mul(uSwirlSpeed);
    const swirl = u.mul(float(6.2831853))
      .add(t.mul(float(1.0).sub(radial.mul(float(0.6)))))
      .add(uSwirlAmt.mul(sin(v.mul(float(12.566)).add(t.mul(float(0.7))))));

    // Bright filaments: a few overlapping sin bands rotating with swirl.
    const band1 = sin(swirl.mul(float(3.0))).mul(float(0.5)).add(float(0.5));
    const band2 = sin(swirl.mul(float(7.0)).add(float(1.7))).mul(float(0.5)).add(float(0.5));
    const filament = band1.mul(float(0.7)).add(band2.mul(float(0.3)));

    // Radial brightness falloff — bright midline, dim edges.
    const ringMask = smoothstep(float(1.0), float(0.0), radial);

    // Inner/outer palette blend driven by radial position with filament jitter.
    const heat = smoothstep(float(0.0), float(1.0),
      ringMask.mul(float(0.85)).add(filament.mul(float(0.4))));

    const palette = mix(uColorOuter, uColorInner, heat);

    // HDR output — multiply by intensity * ring mask * filament hotspot.
    const hot = ringMask.mul(filament.mul(float(0.6)).add(float(0.4)));
    return palette.mul(uIntensity).mul(hot);
  });

  const material = new MeshBasicNodeMaterial({
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
    toneMapped: true,
  });
  material.colorNode = diskColor();

  // Runtime knobs — mutate .value to retune live.
  const uniforms = {
    colorInner: uColorInner,
    colorOuter: uColorOuter,
    intensity:  uIntensity,
    swirlSpeed: uSwirlSpeed,
    swirlAmount: uSwirlAmt,
  };

  return { material, uniforms, params };
}
