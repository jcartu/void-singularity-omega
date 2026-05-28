// Renderer factory. Three.js r184 WebGPURenderer auto-falls-back to WebGL2 internally,
// but we probe explicitly so the game can scale quality tiers up front.

import { WebGPURenderer } from 'three/webgpu';
import { ACESFilmicToneMapping, SRGBColorSpace } from 'three';

export async function detectCapability() {
  const cap = { webgpu: false, webgl2: false, hdr: false, adapter: null, tier: 'low' };

  // WebGPU probe
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (adapter) {
        cap.webgpu = true;
        cap.adapter = adapter.info ?? null;
        cap.hdr = adapter.features?.has?.('rg11b10ufloat-renderable') ?? false;
      }
    } catch { /* fall through */ }
  }

  // WebGL2 probe
  try {
    const c = document.createElement('canvas');
    cap.webgl2 = !!c.getContext('webgl2');
  } catch { /* ignore */ }

  // Crude tiering — refined by the runtime auto-profiler in SPRINT-08.
  if (cap.webgpu) cap.tier = cap.hdr ? 'ultra' : 'high';
  else if (cap.webgl2) cap.tier = 'medium';
  return cap;
}

export async function createRenderer(canvas, cap) {
  const renderer = new WebGPURenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
    // forceWebGL flips the backend if WebGPU is unavailable.
    forceWebGL: !cap.webgpu,
  });
  await renderer.init();

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x02030a, 1);
  renderer.toneMapping = ACESFilmicToneMapping; // AgX swap evaluated in ART-DIRECTION gate
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = SRGBColorSpace;
  return renderer;
}
