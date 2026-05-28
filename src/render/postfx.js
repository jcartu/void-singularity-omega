// Post-processing graph (WebGPU-native, TSL nodes). Runtime-swappable via outputNode.
//
// Current chain (SPRINT-01 R4):
//   scenePass(color) + bloom(color)  ->  renderOutput (ACES + sRGB, applied by PostProcessing)
//
// SPRINT-04 will splice in: GTAO -> bloom -> SSR -> gravitationalLensing -> DOF -> grain/CA.
// outputColorTransform stays true so PostProcessing wraps outputNode with renderOutput(),
// applying renderer.toneMapping (ACES Filmic) + renderer.outputColorSpace (sRGB). Same
// graph runs on WebGPU and the WebGL2 fallback that three.js auto-selects internally.

import { PostProcessing } from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

export function createPostFX(renderer, scene, camera) {
  const post = new PostProcessing(renderer);

  const scenePass = pass(scene, camera);
  const sceneColor = scenePass.getTextureNode('output');

  // (strength, radius, threshold). Tuned mild so emissive pops without nuking SDR.
  // SPRINT-04 swaps this to MRT emissive-only bloom.
  const bloomPass = bloom(sceneColor, 0.8, 0.6, 0.85);

  // PostProcessing applies ACES + sRGB downstream via outputColorTransform.
  post.outputNode = sceneColor.add(bloomPass);

  return {
    post,
    scenePass,
    bloomPass,
    setSize: (w, h) => post.setSize?.(w, h),
    render: () => post.renderAsync(),
    // SPRINT-04 lane: reassign post.outputNode then call rebuild().
    rebuild: () => { post.needsUpdate = true; },
  };
}
