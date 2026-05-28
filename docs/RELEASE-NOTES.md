# VOID SINGULARITY: OMEGA — Release Notes

## Version 1.0.0 — "Event Horizon" (SPRINT-09 ship)

A self-hosted, self-contained WebGPU 3D bullet-hell roguelite. Built from a static
folder — no servers, no telemetry, no accounts. Open `index.html` (or serve `dist/`
behind any static file server) and play.

---

## Feature Highlights

### Core engine (SPRINT-00 → SPRINT-01)
- **WebGPU-first renderer** with automatic **WebGL2 fallback** for older hardware.
- Deterministic fixed-timestep loop with interpolated rendering.
- Hardened ECS, pooled allocations, seedable RNG, save/load.
- In-engine profiler (`window.__OMEGA__.profiler`) exposed for headless harnesses.
- Hitch-prevention (long-task budget split across frames).

### Combat & content (SPRINT-02 → SPRINT-05)
- 4 enemy archetypes (chaser, orbiter, shooter, suicide swarm).
- 6 bosses: Pulse Warden, Void Reaver, Scrap Collector, Horizon Eater,
  Magma Titan, **Omega Core** (final).
- 12+ weapon definitions with stacking modifiers, elemental side-channels.
- Gravity wells, projectile inheritance, hit-feel (screenshake / time-slice / flash).
- Combo / multiplier system with decay & milestone shockwaves.

### Roguelite meta (SPRINT-04 → SPRINT-06)
- Director / spawn pacing tied to biome and threat budget.
- 8 biomes with skinned visuals, music & particle palettes.
- Upgrade draft between waves, economy with banking and burn-down.
- Achievements, unlocks, daily seed mode, prestige loop.

### Audio (SPRINT-04)
- Tone.js-driven bus graph (music / sfx / ui) with ducking sidechain.
- Per-biome music stems, weapon SFX layer, run-end stinger.

### Visuals (SPRINT-05 → SPRINT-07)
- HDR-aware post-FX stack (bloom, tonemap, chromatic, vignette, scanlines).
- **PerfGate**: per-node post-FX budget enforcement with auto-degradation.
- GPU-instanced bullets / enemies / debris. Particle pools with soft-particle blend.
- Boss-specific VFX (event horizon, lava plumes, scrap shrapnel, etc.).
- Camera kit (shake, punch, kickback, slow-zoom).

### UI / UX (SPRINT-06 → SPRINT-08)
- HUD with health/shields, combo meter, weapon stack, boss bar.
- Title / pause / draft / end-of-run / achievements / unlock / daily screens.
- Keyboard, mouse, and **gamepad** support (twin-stick).
- Audio options menu (per-bus volume), graphics tier override.

### Performance & QA (SPRINT-08 → SPRINT-09)
- Storm scenario sweep across `ultra / high / medium / low` tiers.
- 5-tier perf matrix (`tests/perf-matrix.mjs`) including CDP CPU throttling
  and forced WebGL2 fallback.
- Smoke + perf gate runnable against the production `dist/` (`scripts/verify-dist.mjs`).
- Determinism harness verifying identical run output from identical seed.

---

## Known Issues

- **Safari**: WebGPU is enabled on Safari 18+; older Safari falls back to WebGL2 at the
  `medium` tier. Post-FX bloom may render at half-resolution on the fallback.
- **Firefox**: WebGPU shipped in 141 (desktop, Windows); other platforms route to WebGL2.
- **Integrated GPUs**: First boot may take 1-2 s while shaders compile. Subsequent runs
  hit the browser's shader cache and boot in < 400 ms.
- **Gamepad rumble**: Not wired (browser support is still inconsistent).
- **Touch input**: Not a target for v1.0; pointer events fall through but there is no
  on-screen joystick yet.

---

## System Requirements

| Tier   | GPU                                  | CPU                | Browser              | Target FPS |
| ------ | ------------------------------------ | ------------------ | -------------------- | ---------- |
| Ultra  | Discrete GPU, ≤2 yrs old             | 8-core, ≤2 yrs old | Chrome / Edge 129+   | 60         |
| High   | Discrete or strong iGPU              | 6-core             | Chrome / Edge / FF   | 60         |
| Medium | Modern iGPU                          | 4-core             | Chrome / Edge / FF   | 45         |
| Low    | Old iGPU / Chromebook                | 2-core             | Any evergreen        | 30         |
| WebGL2 | Anything with WebGL2 + 1 GB GPU mem  | 2-core             | Any evergreen        | 30         |

- **Resolution**: scales to viewport; downsamples on low tiers automatically.
- **Memory**: ~ 250 MB JS heap at steady state in storm load.
- **Disk**: `dist/` is < 25 MB ungzipped.

---

## Hosting

Drop the contents of `dist/` behind any static file server (nginx, `python -m http.server`,
GitHub Pages, S3, itch.io HTML5). No build step required at runtime; no environment
variables; no CORS configuration beyond serving the assets from the same origin.

---

## Credits

- **Engine, rendering, gameplay, audio, content, balance**: solo build.
- **three** by mrdoob & contributors — scene graph & WebGPU renderer.
- **@dimforge/rapier3d-compat** — physics (used by gravity wells & boss collisions).
- **tone** by Yotam Mann — audio engine.
- **stats-gl, lil-gui** — dev-only HUD / GUI.
- **vite, playwright, @gltf-transform/cli** — toolchain.

Built with love and a lot of frame-time tracing.
