# VOID SINGULARITY: OMEGA — scaffold spine

This is the **bootable foundation** the autonomous build extends. It already compiles and
renders a placeholder singularity (core + accretion disk + starfield) on WebGPU with an
automatic WebGL2 fallback. Treat it as SPRINT-00's accepted output — do not rewrite it,
extend it.

## Run

```bash
npm install
npm run dev      # http://localhost:5173  — needs a WebGPU-capable browser (Chrome 113+, FF 147+, Safari 26+)
npm run build    # static bundle in dist/ — self-hostable (chuck on the QNAP, serve as static files)
npm run preview  # serve the production build
```

> Verified: `vite build` succeeds clean on three@0.184.0 (`three/webgpu` + `three/tsl`),
> rapier3d-compat, tone. 14 modules, ~48 KB gzip three core.

## Layout

```
src/
  main.js              boot: capability detect -> renderer -> world -> loop
  engine/
    loop.js            fixed-step sim (1/120) + render interpolation alpha
    ecs.js             tiny ECS (entities=int ids, component stores, queries, systems)
    input.js           keyboard / mouse twin-stick / gamepad
  render/
    renderer.js        WebGPURenderer w/ WebGL2 fallback + capability tiering
    postfx.js          node post-processing graph (passthrough now; chain in SPRINT-04)
  game/
    world.js           scene graph, camera, ECS wiring, placeholder singularity
  shaders/
    lensing.js         TSL gravitational-lensing post node (signature effect stub)
```

## Contracts the agents must honor
- `window.__OMEGA__ = { world, renderer, loop, cap }` is the test/observability hook. Keep it.
- Sim runs at a **fixed 1/120 step**; never put gameplay logic in render. Replays depend on this.
- Post-processing is a **swappable node graph**: reassign `post.outputNode`, call `rebuild()`.
- Renderer must keep the **WebGL2 fallback path** alive (`forceWebGL`); no WebGPU-only hard deps
  in gameplay logic — quality features degrade, the game still runs.

See `../05-ARCHITECTURE.md` for the full module contract and `../09-MILESTONE-ARC.md` for sequencing.
