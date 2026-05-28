# VOID SINGULARITY: OMEGA — Controls Reference

Twin-stick shooter. Move with your left hand, aim with your right. The game
favors mouse aim; gamepad and full-keyboard play are first-class as well.

---

## Keyboard + Mouse (recommended)

| Action          | Binding                              |
| --------------- | ------------------------------------ |
| Move            | `W` `A` `S` `D` / Arrow keys         |
| Aim             | Mouse                                |
| Fire            | Hold **Left Mouse** / **Space**      |
| Dash / Boost    | **Space** / **Left Shift**           |
| Pause / Menu    | **Esc**                              |
| Confirm / Pick  | **Enter** / **Space**                |
| Cancel / Back   | **Esc**                              |
| Cycle UI option | **Tab** / Arrow keys                 |
| Skip cutscene   | **Esc**                              |

Hold-fire is the intended pattern; tap-fire works but does not increase DPS.

---

## Gamepad (Xbox / PlayStation / generic)

Detected automatically via the Web Gamepad API. Most reasonable XInput-class
controllers work out of the box. PlayStation controllers map by physical
position (✕ = A, ◯ = B).

| Action          | Binding                              |
| --------------- | ------------------------------------ |
| Move            | Left stick (deadzone 0.15)           |
| Aim             | Right stick                          |
| Fire            | RT / R2 (or A / ✕)                   |
| Dash            | A / ✕ (or LB / L1)                   |
| Pause / Menu    | Start / Options                      |
| Confirm         | A / ✕                                |
| Cancel          | B / ◯                                |
| Cycle UI option | D-pad / Left stick                   |

Rumble is **not** wired in v1.0.

---

## Menu Navigation

All menus accept keyboard, mouse, and gamepad simultaneously.

- **Arrow keys / D-pad / Tab**: move focus.
- **Enter / Space / A**: activate focused item.
- **Esc / B**: back / dismiss.
- **Mouse click**: works everywhere.

---

## Accessibility

- **High-contrast HUD**: HUD elements use thick outlines and saturated
  hit-flash colors so bullet-on-background contrast remains readable on
  dim screens.
- **No mandatory color cues**: enemy / projectile identification uses
  shape & motion in addition to color.
- **Hit-feel toggle**: time-slice and screenshake amplitude are clamped on
  the **low** graphics tier to reduce motion intensity. (A dedicated motion
  toggle is planned post-1.0.)
- **Pause**: any time, no penalty. Pausing fully halts simulation, audio
  ducks, post-FX freezes.
- **Audio bus mix**: per-bus volume (Music / SFX / UI) via the Options
  menu. Each bus has an independent mute.
- **Forced WebGL2**: append `?webgl2=1` to the URL to force the WebGL2
  renderer (useful for older GPUs or motion-sensitivity, since fewer
  post-FX nodes run).
- **No flashing strobes**: post-FX bloom is energy-conserving; chromatic
  aberration & scanlines are subtle and can be disabled by selecting the
  **low** graphics tier.

---

## Tier Override

Force a graphics tier via URL parameter:

```
index.html?tier=ultra
index.html?tier=high
index.html?tier=medium
index.html?tier=low
index.html?webgl2=1
```

Auto-detect runs at boot and will downgrade dynamically if the perf gate
detects a sustained over-budget condition.
