// Signature effect: screen-space gravitational lensing around the singularity.
// This is a TSL stub the art-shader-worker hardens in SPRINT-04 (RUBRIC-visual-fidelity).
// Approach: sample the scene color with UVs warped toward the projected singularity
// center, magnitude ~ 1/r^2 inside a soft event-horizon radius, plus an emissive
// accretion ring. Real version adds chromatic split + temporal stabilization.

import { Fn, vec2, vec3, float, uv, length, normalize, smoothstep, mix } from 'three/tsl';

/**
 * @param colorNode  scene color texture node
 * @param centerU    uniform vec2 — singularity center in UV space
 * @param strengthU  uniform float — lensing magnitude
 * @param radiusU    uniform float — event-horizon radius in UV
 */
export const gravitationalLensing = Fn(([colorNode, centerU, strengthU, radiusU]) => {
  const p = uv();
  const toCenter = centerU.sub(p);
  const dist = length(toCenter);
  const dir = normalize(toCenter);

  // Warp UVs inward; falloff concentrated near the horizon.
  const pull = strengthU.mul(smoothstep(radiusU.mul(float(3.0)), float(0.0), dist));
  const warped = p.add(dir.mul(pull));

  const scene = colorNode.sample(warped);

  // Accretion ring glow (placeholder palette; art lane replaces with HDR ramp).
  const ring = smoothstep(radiusU.add(float(0.02)), radiusU, dist)
    .sub(smoothstep(radiusU, radiusU.sub(float(0.02)), dist));
  const glow = vec3(1.0, 0.55, 0.18).mul(ring).mul(float(2.0));

  // Hard shadow inside the horizon.
  const inside = smoothstep(radiusU, radiusU.sub(float(0.01)), dist);
  const out = mix(scene.rgb, vec3(0.0), inside).add(glow);
  return out;
});
