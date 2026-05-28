// ScreenFX — screen-space juice manager (SPRINT-04).
//
// Provides intensity-scalable visual feedback that hangs off the event bus:
//
//   * Screen shake          — camera-position offset, sinusoidal decay.
//                             Type presets: subtle / medium / heavy. Pushes
//                             offsets into the existing CameraRig shake hook
//                             (camera.js) so the rig owns final composition.
//   * Screen flash          — full-screen color overlay, ease-out opacity.
//                             Throttled to keep flash *frequency* below 3 Hz
//                             (photosensitive-epilepsy guideline). Bright
//                             flashes that would breach the cadence are
//                             merged with the in-flight flash instead of
//                             stacking new triggers.
//   * Speed lines           — radial DOM/CSS lines from screen centre,
//                             fading out. Cheap conic-gradient overlay; no
//                             per-line DOM nodes in the hot path.
//   * Level-up bloom        — temporary boost to PostFX bloom intensity,
//                             ease-out back to baseline.
//   * Damage vignette       — red radial vignette tied to ship HP fraction,
//                             updated every frame (cheap CSS variable poke).
//
// All effects scale with `intensityMultiplier` (0..2) for accessibility. A
// value of 0 disables every effect; 1 = default; 2 = double intensity.
//
// DOM strategy: one fixed overlay div at z-index above HUD but below modals,
// pointer-events: none, with three layered children (flash, speed-lines,
// vignette). CSS variables drive opacity / colour so the renderer only ever
// writes 2-3 style props per frame and we throttle those writes to 30 Hz.
//
// MUST NOT:
//   - Audio (handled elsewhere).
//   - Block visibility (max overlay opacity 0.55).
//   - Trigger flashes faster than ~3 Hz.
//   - Mutate fixed-step gameplay state (this is render-only).

const STYLE_ID = 'omega-fx-style';
const OVERLAY_ID = 'omega-fx-overlay';

const FX_CSS = `
#${OVERLAY_ID} {
  position: fixed; inset: 0; z-index: 60; pointer-events: none;
  overflow: hidden; mix-blend-mode: normal;
}
#${OVERLAY_ID} .fx-flash {
  position: absolute; inset: 0;
  background: var(--fx-flash-color, #ffffff);
  opacity: var(--fx-flash-opacity, 0);
  will-change: opacity;
  transition: none;
}
#${OVERLAY_ID} .fx-vignette {
  position: absolute; inset: 0;
  background: radial-gradient(
    ellipse at center,
    rgba(0,0,0,0) 45%,
    rgba(120, 8, 12, var(--fx-vignette-mid, 0)) 75%,
    rgba(40, 0, 4, var(--fx-vignette-edge, 0)) 100%
  );
  opacity: var(--fx-vignette-opacity, 0);
  will-change: opacity;
  transition: opacity 120ms linear;
}
#${OVERLAY_ID} .fx-speedlines {
  position: absolute; inset: -10%;
  background:
    repeating-conic-gradient(
      from var(--fx-sl-angle, 0deg) at 50% 50%,
      rgba(255, 255, 255, 0.0) 0deg,
      rgba(255, 255, 255, 0.0) 4deg,
      rgba(220, 240, 255, 0.55) 4.2deg,
      rgba(255, 255, 255, 0.0) 5deg
    );
  -webkit-mask-image: radial-gradient(
    ellipse at center,
    rgba(0,0,0,0) 25%,
    rgba(0,0,0,1) 75%
  );
          mask-image: radial-gradient(
    ellipse at center,
    rgba(0,0,0,0) 25%,
    rgba(0,0,0,1) 75%
  );
  opacity: var(--fx-sl-opacity, 0);
  transform: rotate(var(--fx-sl-rot, 0deg));
  will-change: opacity, transform;
}
`;

// Type → (trauma, duration) defaults in world-units / seconds.
const SHAKE_TYPES = {
  subtle: { trauma: 0.25, duration: 0.15 },
  medium: { trauma: 0.55, duration: 0.28 },
  heavy:  { trauma: 1.10, duration: 0.45 },
};

const FLASH_MIN_INTERVAL = 0.34; // seconds between *new* flashes (≈ 2.9 Hz)
const FLASH_MAX_OPACITY  = 0.55;
const VIGNETTE_MAX_OPACITY = 0.85;
const STYLE_UPDATE_INTERVAL = 1 / 30; // 30 Hz DOM writes

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class ScreenFX {
  /**
   * @param {object} opts
   * @param {object} opts.bus              — EventBus (events.js).
   * @param {object} [opts.camera]         — CameraRig (camera.js) for shake.
   * @param {object} [opts.postfx]         — PostFX instance (postfx.js) for bloom boost.
   * @param {number} [opts.intensityMultiplier=1] — Accessibility scale 0..2.
   * @param {HTMLElement} [opts.mount=document.body]
   */
  constructor({
    bus,
    camera = null,
    postfx = null,
    intensityMultiplier = 1,
    mount = (typeof document !== 'undefined' ? document.body : null),
  } = {}) {
    this.bus = bus ?? null;
    this.camera = camera;
    this.postfx = postfx;
    this.intensity = clamp(intensityMultiplier, 0, 2);
    this._mount = mount;

    // -------- Shake state ---------
    // Per-axis offset target & decay timer; sinusoidal jitter on top of trauma.
    this._shake = {
      trauma: 0,       // current 0..N magnitude
      duration: 0,     // total length of current pulse
      elapsed: 0,
      seedX: Math.random() * 1000,
      seedZ: Math.random() * 1000,
      tmp: { x: 0, y: 0, z: 0 },
    };

    // -------- Flash state ---------
    this._flash = {
      opacity: 0,
      color: '#ffffff',
      duration: 0,
      elapsed: 0,
      cooldown: 0, // counts down to enforce <3 Hz
    };

    // -------- Speed-lines state ---
    this._speedLines = {
      opacity: 0,
      duration: 0,
      elapsed: 0,
      angleDeg: 0,
      spinSpeed: 0,
    };

    // -------- Vignette ------------
    this._vignette = {
      opacity: 0, // smoothed toward target
      target: 0,
    };

    // -------- Bloom boost ---------
    this._bloomBoost = {
      active: false,
      duration: 0,
      elapsed: 0,
      baseline: 0,
      peak: 0,
    };

    // -------- DOM throttling ------
    this._styleAccum = 0;
    this._lastFlashOpacity = -1;
    this._lastVignetteOpacity = -1;
    this._lastSLOpacity = -1;
    this._lastSLAngle = -1;

    // Build DOM + bind events (browser only).
    if (this._mount) {
      this._injectStyle();
      this._build();
    }
    this._bindEvents();
  }

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------
  _injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = FX_CSS;
    document.head.appendChild(s);
  }

  _build() {
    // Avoid duplicates if hot-reloaded.
    const existing = document.getElementById(OVERLAY_ID);
    if (existing) existing.remove();

    this.root = document.createElement('div');
    this.root.id = OVERLAY_ID;
    this.root.innerHTML = `
      <div class="fx-vignette"></div>
      <div class="fx-speedlines"></div>
      <div class="fx-flash"></div>
    `;
    this._mount.appendChild(this.root);
    this._elFlash = this.root.querySelector('.fx-flash');
    this._elVignette = this.root.querySelector('.fx-vignette');
    this._elSpeedLines = this.root.querySelector('.fx-speedlines');
  }

  _bindEvents() {
    if (!this.bus || typeof this.bus.on !== 'function') return;
    this._unsubs = [];

    // Player took damage → medium shake + red flash.
    this._unsubs.push(this.bus.on('player:hit', (ev) => {
      const dmg = (ev && typeof ev.damage === 'number') ? ev.damage : 10;
      const norm = clamp(dmg / 30, 0.3, 1.2);
      this.shake('medium', norm, 0.25);
      this.flash('#ff3344', 0.35 * norm, 0.12);
    }));

    // Enemy died → subtle shake. Boss kills bump it.
    const onDeath = (ev) => {
      const isBoss = !!(ev && (ev.boss || ev.isBoss));
      if (isBoss) {
        this.shake('heavy', 1.0, 0.45);
        this.flash('#ffe0a0', 0.4, 0.18);
        this.speedLines(null, 0.4);
      } else {
        this.shake('subtle', 0.4, 0.1);
      }
    };
    this._unsubs.push(this.bus.on('enemy:killed', onDeath));
    // 'enemy:death' is also wired in case future systems emit it.
    try { this._unsubs.push(this.bus.on('enemy:death', onDeath)); } catch (_) { /* dev-bus may reject */ }

    // Combo multiplier-up → small bright flash + subtle shake.
    this._unsubs.push(this.bus.on('combo:multiplier-up', (ev) => {
      const m = (ev && ev.multiplier) || 2;
      const k = clamp((m - 1) / 8, 0.15, 0.5);
      this.flash('#b0ffff', 0.2 + k * 0.2, 0.14);
      this.shake('subtle', 0.35, 0.12);
    }));

    // Upgrade picked → level-up bloom spike + white flash.
    this._unsubs.push(this.bus.on('upgrade:picked', () => {
      this.levelUpBloom(0.8);
      this.flash('#ffffff', 0.45, 0.18);
    }));

    // Boss phase change — heavy shake + speed lines.
    try {
      this._unsubs.push(this.bus.on('boss:phase', () => {
        this.shake('heavy', 0.9, 0.4);
        this.flash('#ff66ff', 0.35, 0.18);
        this.speedLines(null, 0.4);
      }));
    } catch (_) { /* dev-bus may reject */ }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  /**
   * Trigger screen shake.
   * @param {'subtle'|'medium'|'heavy'} [type='medium']
   * @param {number} [intensityScale=1] — multiplier on the preset trauma (0..2).
   * @param {number} [duration]         — override seconds.
   */
  shake(type = 'medium', intensityScale = 1, duration = null) {
    if (this.intensity <= 0) return;
    const preset = SHAKE_TYPES[type] || SHAKE_TYPES.medium;
    const trauma = clamp(preset.trauma * intensityScale * this.intensity, 0, 2);
    const dur    = clamp(duration ?? preset.duration, 0.05, 0.6);
    // Take the stronger of in-flight / new — additive shakes feel mushy.
    if (trauma > this._shake.trauma) {
      this._shake.trauma   = trauma;
      this._shake.duration = dur;
      this._shake.elapsed  = 0;
    } else if (dur > this._shake.duration - this._shake.elapsed) {
      // Extend duration if the new pulse outlasts the current one.
      this._shake.duration = this._shake.elapsed + dur;
    }
  }

  /**
   * Trigger screen flash.
   * @param {string} [color='#ffffff'] — CSS colour.
   * @param {number} [intensity=0.3]   — peak opacity 0..0.5 (clamped).
   * @param {number} [duration=0.12]   — seconds.
   */
  flash(color = '#ffffff', intensity = 0.3, duration = 0.12) {
    if (this.intensity <= 0) return;
    // Photosensitive-epilepsy guard: no new flash within ~340 ms.
    if (this._flash.cooldown > 0) {
      // If the requested flash is brighter than what's in flight, merge it
      // into the existing one rather than firing a new one.
      const peak = clamp(intensity * this.intensity, 0, 0.5);
      if (peak > this._flash.opacity) this._flash.opacity = peak;
      return;
    }
    this._flash.color    = color;
    this._flash.opacity  = clamp(intensity * this.intensity, 0, FLASH_MAX_OPACITY);
    this._flash.duration = clamp(duration, 0.03, 0.3);
    this._flash.elapsed  = 0;
    this._flash.cooldown = FLASH_MIN_INTERVAL;
  }

  /**
   * Trigger speed lines.
   * @param {{x:number,z:number}|null} [direction=null] — XZ world direction or null for radial.
   * @param {number} [duration=0.3]
   */
  speedLines(direction = null, duration = 0.3) {
    if (this.intensity <= 0) return;
    const dur = clamp(duration, 0.1, 0.6);
    let angle = 0;
    if (direction && (direction.x || direction.z)) {
      // Map XZ direction to a screen-rotation around the centre. The pattern
      // is rotationally symmetric so any angle is fine; we just lock it for
      // visual consistency relative to motion.
      angle = (Math.atan2(direction.x, -direction.z) * 180) / Math.PI;
    } else {
      angle = Math.random() * 360;
    }
    this._speedLines.opacity   = clamp(0.55 * this.intensity, 0, 0.7);
    this._speedLines.duration  = dur;
    this._speedLines.elapsed   = 0;
    this._speedLines.angleDeg  = angle;
    this._speedLines.spinSpeed = (Math.random() < 0.5 ? -1 : 1) * 60; // deg/s
  }

  /**
   * Briefly boost PostFX bloom intensity, ease back to baseline.
   * @param {number} [duration=0.7]
   */
  levelUpBloom(duration = 0.7) {
    if (this.intensity <= 0 || !this.postfx || !this.postfx.nodes?.bloom) return;
    const node = this.postfx.nodes.bloom;
    const baseline = this._bloomBoost.active
      ? this._bloomBoost.baseline
      : node.intensity;
    this._bloomBoost.baseline = baseline;
    this._bloomBoost.peak     = baseline + 1.4 * this.intensity;
    this._bloomBoost.duration = clamp(duration, 0.2, 1.2);
    this._bloomBoost.elapsed  = 0;
    this._bloomBoost.active   = true;
    // Kick to peak immediately.
    if (typeof this.postfx.setIntensity === 'function') {
      // PostFX.setIntensity clamps 0..1; bloom strength is unbounded internally
      // so write straight into the node + uniform when available.
      node.intensity = this._bloomBoost.peak;
      if (this.postfx._u?.bloom) this.postfx._u.bloom.value = node.intensity;
    } else {
      node.intensity = this._bloomBoost.peak;
    }
  }

  /** Accessibility: 0 disables all FX, 1 default, 2 double. */
  setIntensityMultiplier(m) {
    this.intensity = clamp(m, 0, 2);
    if (this.intensity === 0) {
      // Kill in-flight effects immediately.
      this._shake.trauma = 0;
      this._flash.opacity = 0;
      this._speedLines.opacity = 0;
      this._vignette.target = 0;
      this._vignette.opacity = 0;
    }
  }

  /**
   * Advance all effects.
   * @param {number} dt                 — seconds.
   * @param {number} [shipHealth]       — current HP for vignette.
   * @param {number} [shipMaxHealth=100]
   */
  update(dt, shipHealth = null, shipMaxHealth = 100) {
    if (dt <= 0) return;

    // ---- Shake ---------------------------------------------------------
    // Undo last frame's direct camera-position offset (only for raw cameras).
    if (this._shake.applied && this.camera?.position) {
      this.camera.position.x -= this._shake.applied.x;
      this.camera.position.y -= this._shake.applied.y;
      this.camera.position.z -= this._shake.applied.z;
      this._shake.applied = null;
    }
    if (this._shake.trauma > 0) {
      this._shake.elapsed += dt;
      const t = this._shake.elapsed / this._shake.duration;
      if (t >= 1) {
        this._shake.trauma = 0;
      } else {
        // Sinusoidal jitter * (1 - t)^2 decay.
        const decay = (1 - t) * (1 - t);
        const mag = this._shake.trauma * decay;
        const ph = this._shake.elapsed * 60;
        // Two co-prime frequencies per axis -> non-repeating wobble.
        const ox = Math.sin(ph * 23.7 + this._shake.seedX) * mag;
        const oz = Math.sin(ph * 19.3 + this._shake.seedZ) * mag * 0.85;
        const oy = Math.sin(ph * 14.1) * mag * 0.35;
        if (this.camera && typeof this.camera.addShakeOffset === 'function') {
          // CameraRig path: push into the rig's decaying offset accumulator.
          // Vector3.add() reads .x/.y/.z so a plain object is fine here.
          this._shake.tmp.x = ox;
          this._shake.tmp.y = oy;
          this._shake.tmp.z = oz;
          this.camera.addShakeOffset(this._shake.tmp);
        } else if (this.camera?.position) {
          // Raw THREE.Camera path: apply delta directly, remember it so the
          // next frame can subtract it before recomputing. This keeps the
          // owning camera-follow logic (if any) authoritative over the base.
          this.camera.position.x += ox;
          this.camera.position.y += oy;
          this.camera.position.z += oz;
          this._shake.applied = { x: ox, y: oy, z: oz };
        }
      }
    }

    // ---- Flash ---------------------------------------------------------
    if (this._flash.cooldown > 0) this._flash.cooldown -= dt;
    if (this._flash.opacity > 0) {
      this._flash.elapsed += dt;
      const t = this._flash.elapsed / this._flash.duration;
      if (t >= 1) {
        this._flash.opacity = 0;
      } else {
        // Quick attack (first 20%), ease-out fade (remaining 80%).
        const peak = this._flash.opacity;
        // We don't store original peak separately — recompute by holding
        // the captured peak and easing it. Re-derive from current * easing
        // is fine since we only write to DOM, not back into state.
        const ease = t < 0.2 ? (t / 0.2) : (1 - (t - 0.2) / 0.8);
        this._flashRender = peak * clamp(ease, 0, 1);
      }
    } else {
      this._flashRender = 0;
    }

    // ---- Speed lines ---------------------------------------------------
    if (this._speedLines.opacity > 0) {
      this._speedLines.elapsed += dt;
      const t = this._speedLines.elapsed / this._speedLines.duration;
      this._speedLines.angleDeg += this._speedLines.spinSpeed * dt;
      if (t >= 1) {
        this._speedLines.opacity = 0;
        this._slRender = 0;
      } else {
        // Ease-out: 1 - t^2
        const k = 1 - t * t;
        this._slRender = this._speedLines.opacity * k;
      }
    } else {
      this._slRender = 0;
    }

    // ---- Damage vignette ----------------------------------------------
    if (shipHealth !== null && shipMaxHealth > 0 && this.intensity > 0) {
      const frac = clamp(shipHealth / shipMaxHealth, 0, 1);
      // 0–50% HP → 0..1 intensity (full at 0 HP).
      const want = frac >= 0.5 ? 0 : (1 - frac / 0.5);
      this._vignette.target = want * VIGNETTE_MAX_OPACITY * this.intensity;
    } else {
      this._vignette.target = 0;
    }
    // Smooth toward target (frame-rate independent).
    const alpha = 1 - Math.exp(-6 * dt);
    this._vignette.opacity += (this._vignette.target - this._vignette.opacity) * alpha;

    // ---- Bloom boost --------------------------------------------------
    if (this._bloomBoost.active && this.postfx?.nodes?.bloom) {
      this._bloomBoost.elapsed += dt;
      const t = this._bloomBoost.elapsed / this._bloomBoost.duration;
      const node = this.postfx.nodes.bloom;
      if (t >= 1) {
        node.intensity = this._bloomBoost.baseline;
        if (this.postfx._u?.bloom) this.postfx._u.bloom.value = node.intensity;
        this._bloomBoost.active = false;
      } else {
        // Spike-and-decay: sharp peak in first 15%, ease back over remainder.
        const shape = t < 0.15
          ? 1.0
          : 1 - ((t - 0.15) / 0.85);
        const v = this._bloomBoost.baseline
                + (this._bloomBoost.peak - this._bloomBoost.baseline) * clamp(shape, 0, 1);
        node.intensity = v;
        if (this.postfx._u?.bloom) this.postfx._u.bloom.value = v;
      }
    }

    // ---- DOM writes (throttled to 30 Hz) ------------------------------
    this._styleAccum += dt;
    if (this._styleAccum < STYLE_UPDATE_INTERVAL) return;
    this._styleAccum = 0;
    this._flushStyles();
  }

  _flushStyles() {
    if (!this.root) return;
    const style = this.root.style;

    // Flash
    const fo = this._flashRender ?? 0;
    if (Math.abs(fo - this._lastFlashOpacity) > 0.005) {
      style.setProperty('--fx-flash-opacity', fo.toFixed(3));
      style.setProperty('--fx-flash-color', this._flash.color);
      this._lastFlashOpacity = fo;
    }

    // Vignette
    const vo = this._vignette.opacity;
    if (Math.abs(vo - this._lastVignetteOpacity) > 0.005) {
      style.setProperty('--fx-vignette-opacity', vo.toFixed(3));
      // Inner/outer ramp scales with the same value so the gradient feels
      // continuous rather than just fading a uniform layer.
      style.setProperty('--fx-vignette-mid', (vo * 0.6).toFixed(3));
      style.setProperty('--fx-vignette-edge', (vo * 0.9).toFixed(3));
      this._lastVignetteOpacity = vo;
    }

    // Speed lines
    const so = this._slRender ?? 0;
    if (Math.abs(so - this._lastSLOpacity) > 0.01) {
      style.setProperty('--fx-sl-opacity', so.toFixed(3));
      this._lastSLOpacity = so;
    }
    const sa = this._speedLines.angleDeg;
    if (so > 0 && Math.abs(sa - this._lastSLAngle) > 0.5) {
      style.setProperty('--fx-sl-rot', `${sa.toFixed(1)}deg`);
      this._lastSLAngle = sa;
    }
  }

  dispose() {
    if (this._unsubs) {
      for (const u of this._unsubs) { try { u(); } catch (_) { /* noop */ } }
      this._unsubs = null;
    }
    // Restore bloom if we yanked it.
    if (this._bloomBoost.active && this.postfx?.nodes?.bloom) {
      this.postfx.nodes.bloom.intensity = this._bloomBoost.baseline;
      if (this.postfx._u?.bloom) this.postfx._u.bloom.value = this._bloomBoost.baseline;
    }
    this.root?.remove();
    this.root = null;
  }
}
