// Accessibility manager (SPRINT-09).
//
// Applies player-facing accessibility settings to the render/UX surfaces:
//   - Colorblind palette filters (deuteranopia / protanopia / tritanopia)
//   - Screen shake intensity scaling (off / reduced / normal)
//   - Flash / strobe reduction (off / reduced / maximum)
//   - High-contrast mode
//   - Text scale (UI font-size multiplier)
//
// Implementation strategy (lightweight, non-invasive):
//   * Colorblind filters and high-contrast mode are applied as SVG color-matrix
//     filters injected once into <head>, then attached to the WebGPU canvas via
//     CSS `filter:` chain. This avoids touching the TSL post-FX graph and is
//     reversible — flipping the mode just rewrites the filter chain string.
//   * Screen shake reduction forwards through ScreenFX.setIntensityMultiplier()
//     and ScreenFX.setFlashIntensity() so the existing throttling and merging
//     in ui/fx.js stays authoritative.
//   * Text scale sets a `--omega-ui-scale` CSS variable on documentElement that
//     ui/hud.js (and any future UI) reads via `font-size: calc(1em * var(...))`.
//   * Settings emit `a11y:changed` on the bus so debug/HUD can react live.
//
// MUST NOT:
//   - Add audio.
//   - Mutate fixed-step game state.
//   - Break existing screens (every effect is a CSS / scalar tweak).

const SVG_ID = 'omega-a11y-svg';
const STYLE_ID = 'omega-a11y-style';

// Color-matrix coefficients derived from Machado et al. (2009) simulations,
// rounded to 3 sig figs for the URL-encoded SVG. These approximate how each
// dichromacy *sees* color — applying them as a "correction" daltonizes the
// frame so distinguishable hues survive. Good enough for accessibility; not
// medically accurate.
const CB_MATRICES = Object.freeze({
  // No transformation.
  none: null,
  // Daltonization-style corrections — shift confusion-line colors toward
  // the surviving axis. Each is a 4x5 matrix (rgba in/out + alpha pass-through).
  deuteranopia: '0.625 0.375 0 0 0  0.7 0.3 0 0 0  0 0.3 0.7 0 0  0 0 0 1 0',
  protanopia:   '0.567 0.433 0 0 0  0.558 0.442 0 0 0  0 0.242 0.758 0 0  0 0 0 1 0',
  tritanopia:   '0.95 0.05 0 0 0  0 0.433 0.567 0 0  0 0.475 0.525 0 0  0 0 0 1 0',
});

// Shake/flash level → multipliers for the existing ScreenFX intensity scalar.
const SHAKE_LEVELS = Object.freeze({
  off:     0,
  reduced: 0.45,
  normal:  1.0,
});
const FLASH_LEVELS = Object.freeze({
  off:     1.0,   // means "maximum reduction is off" — full flashes allowed
  reduced: 0.5,   // half-strength flashes
  maximum: 0.0,   // suppress flashes entirely
});

const TEXT_SCALE_MIN = 0.5;
const TEXT_SCALE_MAX = 2.0;

const DEFAULTS = Object.freeze({
  colorblind: 'none',          // none|deuteranopia|protanopia|tritanopia
  screenShake: 'normal',       // off|reduced|normal
  flashReduction: 'off',       // off|reduced|maximum
  highContrast: false,
  textScale: 1.0,
});

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

function injectSVG() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(SVG_ID)) return;
  // Build a single hidden SVG containing every named filter we toggle into the
  // canvas CSS filter chain.
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.id = SVG_ID;
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;';
  const defs = document.createElementNS(ns, 'defs');
  for (const [name, values] of Object.entries(CB_MATRICES)) {
    if (!values) continue;
    const filter = document.createElementNS(ns, 'filter');
    filter.setAttribute('id', `omega-a11y-${name}`);
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    const fe = document.createElementNS(ns, 'feColorMatrix');
    fe.setAttribute('type', 'matrix');
    fe.setAttribute('values', values);
    filter.appendChild(fe);
    defs.appendChild(filter);
  }
  svg.appendChild(defs);
  document.body.appendChild(svg);
}

function injectStyle() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
:root {
  --omega-ui-scale: 1;
}
html.omega-a11y-high-contrast {
  --omega-hc-text: #ffffff;
  --omega-hc-bg:   #000000;
  --omega-hc-accent: #ffeb3b;
}
html.omega-a11y-high-contrast #omega-hud,
html.omega-a11y-high-contrast #omega-hud-vitals,
html.omega-a11y-high-contrast #omega-hud-combo,
html.omega-a11y-high-contrast #omega-hud-contract,
html.omega-a11y-high-contrast #omega-hud-debug {
  background: rgba(0,0,0,0.92) !important;
  border-color: var(--omega-hc-accent) !important;
  color: var(--omega-hc-text) !important;
}
html.omega-a11y-high-contrast #omega-hud .slot,
html.omega-a11y-high-contrast #omega-hud-vitals {
  border-color: var(--omega-hc-accent) !important;
}
html.omega-a11y-high-contrast #omega-hud-combo .count,
html.omega-a11y-high-contrast #omega-hud-vitals .vnum {
  color: var(--omega-hc-text) !important;
  text-shadow: none !important;
}
html.omega-a11y-high-contrast #omega-hud-combo .mult {
  background: var(--omega-hc-accent) !important;
  color: #000 !important;
  border-color: var(--omega-hc-accent) !important;
  text-shadow: none !important;
}
/* UI text scale — applied to all HUD/overlay surfaces. Avoids the run canvas. */
#omega-hud, #omega-hud-vitals, #omega-hud-combo, #omega-hud-contract,
#omega-hud-debug, #omega-screens, #omega-audio-options, #omega-settings {
  font-size: calc(1em * var(--omega-ui-scale, 1));
}
`;
  document.head.appendChild(s);
}

export class A11YManager {
  /**
   * @param {{
   *   postfx?: any,            // PostFX instance (postfx.js)
   *   screenFX?: any,          // ScreenFX instance (ui/fx.js)
   *   bus?: any,               // EventBus
   *   canvas?: HTMLCanvasElement|null,  // canvas the CSS filter is applied to
   *   root?: HTMLElement|null, // root element receiving high-contrast / scale classes (defaults to <html>)
   * }} [opts]
   */
  constructor({
    postfx = null,
    screenFX = null,
    bus = null,
    canvas = null,
    root = null,
  } = {}) {
    this.postfx = postfx;
    this.screenFX = screenFX;
    this.bus = bus;
    this._canvas = canvas
      || (typeof document !== 'undefined' ? document.getElementById('stage') : null);
    this._root = root || (typeof document !== 'undefined' ? document.documentElement : null);

    this._state = { ...DEFAULTS };

    if (typeof document !== 'undefined') {
      injectSVG();
      injectStyle();
    }

    // Apply defaults so the DOM is in a known state.
    this._applyAll();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Returns a clone of the live state. */
  getState() { return { ...this._state }; }

  /** Bulk apply — silently ignores unknown keys. */
  applyAll(state) {
    if (!state || typeof state !== 'object') return;
    if (typeof state.colorblind === 'string')      this._state.colorblind     = this._sanitizeColorblind(state.colorblind);
    if (typeof state.screenShake === 'string')     this._state.screenShake    = this._sanitizeShake(state.screenShake);
    if (typeof state.flashReduction === 'string')  this._state.flashReduction = this._sanitizeFlash(state.flashReduction);
    if (typeof state.highContrast === 'boolean')   this._state.highContrast   = state.highContrast;
    if (typeof state.textScale === 'number')       this._state.textScale      = clamp(state.textScale, TEXT_SCALE_MIN, TEXT_SCALE_MAX);
    this._applyAll();
  }

  setColorblindMode(mode) {
    const m = this._sanitizeColorblind(mode);
    if (this._state.colorblind === m) return;
    this._state.colorblind = m;
    this._applyCanvasFilter();
    this._emit('colorblind');
  }

  setScreenShake(level) {
    const l = this._sanitizeShake(level);
    if (this._state.screenShake === l) return;
    this._state.screenShake = l;
    this._applyShake();
    this._emit('screenShake');
  }

  setFlashReduction(level) {
    const l = this._sanitizeFlash(level);
    if (this._state.flashReduction === l) return;
    this._state.flashReduction = l;
    this._applyFlash();
    this._emit('flashReduction');
  }

  setHighContrast(enabled) {
    const on = !!enabled;
    if (this._state.highContrast === on) return;
    this._state.highContrast = on;
    this._applyContrast();
    this._emit('highContrast');
  }

  setTextScale(scale) {
    const s = clamp(scale, TEXT_SCALE_MIN, TEXT_SCALE_MAX);
    if (this._state.textScale === s) return;
    this._state.textScale = s;
    this._applyTextScale();
    this._emit('textScale');
  }

  /** Reattach to a new canvas (e.g. after renderer swap). */
  setCanvas(canvas) {
    this._canvas = canvas || null;
    this._applyCanvasFilter();
  }

  /** Reattach external systems (post-build wiring). */
  setSystems({ postfx, screenFX } = {}) {
    if (postfx !== undefined) this.postfx = postfx;
    if (screenFX !== undefined) this.screenFX = screenFX;
    this._applyShake();
    this._applyFlash();
  }

  dispose() {
    // Best-effort: clear filter chain so a hot-reloaded manager doesn't leave
    // a stale CSS filter on the canvas.
    if (this._canvas && this._canvas.style) this._canvas.style.filter = '';
    if (this._root) this._root.classList.remove('omega-a11y-high-contrast');
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  _sanitizeColorblind(m) {
    return (m === 'deuteranopia' || m === 'protanopia' || m === 'tritanopia') ? m : 'none';
  }
  _sanitizeShake(l) {
    return (l === 'off' || l === 'reduced' || l === 'normal') ? l : 'normal';
  }
  _sanitizeFlash(l) {
    return (l === 'off' || l === 'reduced' || l === 'maximum') ? l : 'off';
  }

  _applyAll() {
    this._applyCanvasFilter();
    this._applyShake();
    this._applyFlash();
    this._applyContrast();
    this._applyTextScale();
  }

  _applyCanvasFilter() {
    if (!this._canvas || !this._canvas.style) return;
    const parts = [];
    if (this._state.colorblind !== 'none') {
      parts.push(`url(#omega-a11y-${this._state.colorblind})`);
    }
    if (this._state.highContrast) {
      // Boost contrast & saturation on the rendered frame so silhouettes pop
      // even outside the HUD. Conservative to avoid total whiteout.
      parts.push('contrast(1.25)');
      parts.push('saturate(1.35)');
    }
    this._canvas.style.filter = parts.length ? parts.join(' ') : '';
  }

  _applyShake() {
    if (!this.screenFX) return;
    const m = SHAKE_LEVELS[this._state.screenShake] ?? 1;
    if (typeof this.screenFX.setIntensityMultiplier === 'function') {
      this.screenFX.setIntensityMultiplier(m);
    }
  }

  _applyFlash() {
    // Wrap ScreenFX.flash() so reduction is applied at trigger time without
    // touching shake. Stash the original once so toggling between levels is
    // reversible.
    const fx = this.screenFX;
    if (!fx || typeof fx.flash !== 'function') return;
    if (!fx._a11yOriginalFlash) {
      fx._a11yOriginalFlash = fx.flash.bind(fx);
    }
    const level = this._state.flashReduction;
    if (level === 'maximum') {
      fx.flash = function () { /* suppressed by a11y */ };
    } else if (level === 'reduced') {
      const orig = fx._a11yOriginalFlash;
      fx.flash = function (color, intensity = 0.3, duration = 0.12) {
        return orig(color, intensity * 0.5, duration);
      };
    } else {
      fx.flash = fx._a11yOriginalFlash;
    }
  }

  _applyContrast() {
    if (!this._root) return;
    this._root.classList.toggle('omega-a11y-high-contrast', !!this._state.highContrast);
    // High-contrast also touches the canvas filter chain (extra saturation).
    this._applyCanvasFilter();
  }

  _applyTextScale() {
    if (!this._root) return;
    this._root.style.setProperty('--omega-ui-scale', String(this._state.textScale));
  }

  _emit(field) {
    if (!this.bus?.emit) return;
    try {
      this.bus.emit('a11y:changed', { field, value: this._state[field], state: { ...this._state } });
    } catch { /* dev-bus may reject */ }
  }
}

export { DEFAULTS as A11Y_DEFAULTS };
export default A11YManager;
