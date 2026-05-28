// Settings Screen — full Graphics / Audio / Controls / Accessibility panel
// (SPRINT-09).
//
// Standalone DOM overlay (independent of ScreenManager). Mirrors the architecture
// of ui/options-audio.js: persisted to localStorage *and* (when a SaveManager is
// supplied) into the canonical save blob under `settings`. All changes apply
// LIVE — no "Save" button required; closing the panel just hides it.
//
// Public surface:
//   const s = new SettingsScreen({ bus, save, audio, postfx, screenFX, a11y, input });
//   s.show();  s.hide();
//   s.updateCategory('accessibility');      // switch tab
//   s.applySettings(state);                 // bulk apply
//   s.saveSettings(); s.loadSettings();     // persist / restore
//
// MUST NOT add audio. MUST NOT break existing audio-options overlay (they
// coexist; settings hosts its own audio sliders that share the same storage
// key via the AudioOptions instance when one is passed in).

import { AUDIO_OPTIONS_LS_KEY } from '../options-audio.js';
import { A11Y_DEFAULTS } from '../../game/a11y.js';

const STYLE_ID = 'omega-settings-style';
const LS_KEY = 'omega_settings_v1';

const QUALITY_TIERS = ['auto', 'ultra', 'high', 'medium', 'low'];
const COLORBLIND_MODES = ['none', 'deuteranopia', 'protanopia', 'tritanopia'];
const SHAKE_LEVELS = ['off', 'reduced', 'normal'];
const FLASH_LEVELS = ['off', 'reduced', 'maximum'];

const CATEGORIES = ['graphics', 'audio', 'controls', 'accessibility'];

// Default keybindings — matches engine/input.js + game/player keys.
const DEFAULT_BINDINGS = Object.freeze({
  moveUp:     'KeyW',
  moveDown:   'KeyS',
  moveLeft:   'KeyA',
  moveRight:  'KeyD',
  fire:       'Space',
  dash:       'ShiftLeft',
  weapon1:    'Digit1',
  weapon2:    'Digit2',
  pause:      'Escape',
  options:    'KeyO',
});

const BINDING_LABELS = Object.freeze({
  moveUp:    'Move Up',
  moveDown:  'Move Down',
  moveLeft:  'Move Left',
  moveRight: 'Move Right',
  fire:      'Fire',
  dash:      'Dash',
  weapon1:   'Weapon 1',
  weapon2:   'Weapon 2',
  pause:     'Pause',
  options:   'Audio Options',
});

const DEFAULTS = Object.freeze({
  graphics: {
    qualityTier: 'auto',
    vsync: true,
    fullscreen: false,
    uiScale: 1.0,
  },
  audio: {
    masterVol: 0.8,
    musicVol:  0.8,
    sfxVol:    0.8,
    uiVol:     0.8,
    reduceIntensity: false,
  },
  controls: {
    bindings: { ...DEFAULT_BINDINGS },
    controller: true,
    aimAssist: false,
    invertY: false,
  },
  accessibility: { ...A11Y_DEFAULTS },
});

const CSS = `
#omega-settings {
  position: fixed; inset: 0; z-index: 260;
  display: none; align-items: center; justify-content: center;
  background: radial-gradient(ellipse at center, rgba(4,6,18,0.7) 0%, rgba(2,3,10,0.92) 70%);
  backdrop-filter: blur(8px);
  font-family: ui-monospace, "JetBrains Mono", "Courier New", monospace;
  color: #cfe9ff;
  opacity: 0; transition: opacity 200ms ease;
}
#omega-settings.visible { display: flex; opacity: 1; }

#omega-settings .panel {
  background: linear-gradient(180deg, rgba(10,18,38,0.97), rgba(6,10,22,0.97));
  border: 1px solid rgba(120,200,255,0.28);
  border-radius: 12px;
  padding: 24px 28px;
  width: min(720px, 94vw);
  max-height: 88vh;
  display: flex; flex-direction: column; gap: 18px;
  box-shadow: 0 28px 70px -20px rgba(120,200,255,0.4);
}
#omega-settings h1 {
  font-size: 20px; letter-spacing: 0.4em; text-transform: uppercase;
  margin: 0; font-weight: 500; color: #e8f6ff;
}
#omega-settings .tabs {
  display: flex; gap: 4px;
  border-bottom: 1px solid rgba(120,200,255,0.18);
}
#omega-settings .tab {
  background: transparent; border: none;
  color: rgba(207,233,255,0.55);
  font-family: inherit; font-size: 11px;
  letter-spacing: 0.28em; text-transform: uppercase;
  padding: 10px 16px; cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: color 140ms ease, border-color 140ms ease;
}
#omega-settings .tab:hover { color: #cfe9ff; }
#omega-settings .tab.active {
  color: #e8f6ff;
  border-bottom-color: #6ad8ff;
}

#omega-settings .body {
  overflow-y: auto; padding-right: 6px;
  display: flex; flex-direction: column; gap: 6px;
  min-height: 320px;
}
#omega-settings .body::-webkit-scrollbar { width: 6px; }
#omega-settings .body::-webkit-scrollbar-thumb {
  background: rgba(120,200,255,0.25); border-radius: 3px;
}

#omega-settings .field {
  display: grid;
  grid-template-columns: 180px 1fr 72px;
  align-items: center;
  gap: 14px;
  padding: 9px 0;
  border-bottom: 1px dashed rgba(120,200,255,0.08);
}
#omega-settings .field:last-child { border-bottom: none; }
#omega-settings .field-label {
  font-size: 11px; letter-spacing: 0.22em; text-transform: uppercase;
  color: rgba(207,233,255,0.82);
}
#omega-settings .field-hint {
  font-size: 9px; letter-spacing: 0.18em;
  color: rgba(207,233,255,0.45);
  text-transform: none; margin-top: 3px;
}
#omega-settings .field-value {
  font-size: 11px; color: #fff7c8;
  font-variant-numeric: tabular-nums;
  text-align: right; letter-spacing: 0.08em;
}

/* Sliders */
#omega-settings input[type="range"] {
  -webkit-appearance: none; appearance: none;
  width: 100%; height: 4px;
  background: rgba(120,200,255,0.18);
  border-radius: 2px; outline: none; cursor: pointer;
}
#omega-settings input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 14px; height: 14px; border-radius: 50%;
  background: #e8f6ff; cursor: pointer;
  box-shadow: 0 0 10px rgba(120,200,255,0.55);
}
#omega-settings input[type="range"]::-moz-range-thumb {
  width: 14px; height: 14px; border-radius: 50%;
  background: #e8f6ff; cursor: pointer;
  box-shadow: 0 0 10px rgba(120,200,255,0.55);
}

/* Selects */
#omega-settings select {
  background: rgba(8,14,28,0.92);
  border: 1px solid rgba(120,200,255,0.3);
  color: #e8f6ff;
  font-family: inherit; font-size: 11px;
  letter-spacing: 0.16em; text-transform: uppercase;
  padding: 6px 10px; border-radius: 4px;
  cursor: pointer; width: 100%;
}
#omega-settings select:hover { border-color: rgba(180,240,255,0.7); }
#omega-settings select:focus { outline: none; border-color: #6ad8ff; }

/* Toggles */
#omega-settings .toggle {
  position: relative; width: 44px; height: 22px;
  background: rgba(120,200,255,0.16);
  border: 1px solid rgba(120,200,255,0.3);
  border-radius: 11px;
  cursor: pointer;
  transition: background 160ms ease, border-color 160ms ease;
  justify-self: start;
}
#omega-settings .toggle::after {
  content: ''; position: absolute;
  top: 2px; left: 2px; width: 16px; height: 16px;
  background: #cfe9ff; border-radius: 50%;
  transition: left 160ms ease, background 160ms ease;
}
#omega-settings .toggle.on {
  background: rgba(106,216,255,0.45);
  border-color: #6ad8ff;
}
#omega-settings .toggle.on::after { left: 24px; background: #fff7c8; }

/* Keybinding buttons */
#omega-settings .keybind {
  background: rgba(8,14,28,0.92);
  border: 1px solid rgba(120,200,255,0.28);
  color: #e8f6ff;
  font-family: inherit; font-size: 10px;
  letter-spacing: 0.16em; text-transform: uppercase;
  padding: 6px 10px; border-radius: 4px;
  cursor: pointer; width: 100%;
  transition: background 140ms ease, border-color 140ms ease;
}
#omega-settings .keybind:hover { border-color: rgba(180,240,255,0.8); }
#omega-settings .keybind.listening {
  background: rgba(255,92,242,0.18);
  border-color: rgba(255,92,242,0.7);
  color: #ffb6f0;
}

#omega-settings .actions {
  display: flex; gap: 10px; justify-content: space-between;
  border-top: 1px solid rgba(120,200,255,0.18);
  padding-top: 16px;
}
#omega-settings .btn {
  background: rgba(10,18,38,0.92);
  border: 1px solid rgba(120,200,255,0.4);
  color: #e8f6ff;
  padding: 9px 20px;
  font-family: inherit;
  font-size: 10px; letter-spacing: 0.3em; text-transform: uppercase;
  cursor: pointer;
  border-radius: 4px;
  transition: background 140ms ease, border-color 140ms ease;
}
#omega-settings .btn:hover {
  background: rgba(120,200,255,0.16);
  border-color: rgba(180,240,255,0.9);
}
#omega-settings .btn.primary {
  background: linear-gradient(180deg, rgba(106,216,255,0.22), rgba(106,216,255,0.08));
}
#omega-settings .btn.danger {
  border-color: rgba(255,92,122,0.5);
  color: #ff8fa3;
}
#omega-settings .btn.danger:hover {
  background: rgba(255,92,122,0.16);
}
`;

function injectStyle() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

function deepClone(o) {
  // Settings are pure data — JSON round-trip is fine and avoids structuredClone
  // compatibility surprises in test envs.
  return JSON.parse(JSON.stringify(o));
}

function sanitize(raw) {
  const d = deepClone(DEFAULTS);
  if (!raw || typeof raw !== 'object') return d;
  // Graphics
  if (raw.graphics) {
    const g = raw.graphics;
    if (QUALITY_TIERS.includes(g.qualityTier)) d.graphics.qualityTier = g.qualityTier;
    if (typeof g.vsync === 'boolean')      d.graphics.vsync = g.vsync;
    if (typeof g.fullscreen === 'boolean') d.graphics.fullscreen = g.fullscreen;
    if (typeof g.uiScale === 'number')     d.graphics.uiScale = clamp(g.uiScale, 0.5, 2.0);
  }
  // Audio
  if (raw.audio) {
    const a = raw.audio;
    if (typeof a.masterVol === 'number') d.audio.masterVol = clamp(a.masterVol, 0, 1);
    if (typeof a.musicVol === 'number')  d.audio.musicVol  = clamp(a.musicVol, 0, 1);
    if (typeof a.sfxVol === 'number')    d.audio.sfxVol    = clamp(a.sfxVol, 0, 1);
    if (typeof a.uiVol === 'number')     d.audio.uiVol     = clamp(a.uiVol, 0, 1);
    if (typeof a.reduceIntensity === 'boolean') d.audio.reduceIntensity = a.reduceIntensity;
  }
  // Controls
  if (raw.controls) {
    const c = raw.controls;
    if (c.bindings && typeof c.bindings === 'object') {
      for (const k of Object.keys(DEFAULT_BINDINGS)) {
        if (typeof c.bindings[k] === 'string' && c.bindings[k].length) {
          d.controls.bindings[k] = c.bindings[k];
        }
      }
    }
    if (typeof c.controller === 'boolean') d.controls.controller = c.controller;
    if (typeof c.aimAssist === 'boolean')  d.controls.aimAssist  = c.aimAssist;
    if (typeof c.invertY === 'boolean')    d.controls.invertY    = c.invertY;
  }
  // Accessibility
  if (raw.accessibility) {
    const x = raw.accessibility;
    if (COLORBLIND_MODES.includes(x.colorblind)) d.accessibility.colorblind = x.colorblind;
    if (SHAKE_LEVELS.includes(x.screenShake))    d.accessibility.screenShake = x.screenShake;
    if (FLASH_LEVELS.includes(x.flashReduction)) d.accessibility.flashReduction = x.flashReduction;
    if (typeof x.highContrast === 'boolean')     d.accessibility.highContrast = x.highContrast;
    if (typeof x.textScale === 'number')         d.accessibility.textScale = clamp(x.textScale, 0.5, 2.0);
  }
  return d;
}

export class SettingsScreen {
  /**
   * @param {{
   *   bus?: any,
   *   save?: any,                    // SaveManager (engine/save.js)
   *   audio?: any,                   // AudioOptions instance (ui/options-audio.js)
   *   audioCore?: any,               // AudioCore — fallback if no AudioOptions
   *   postfx?: any,                  // PostFX (render/postfx.js) for quality tier
   *   screenFX?: any,                // ScreenFX (ui/fx.js)
   *   a11y?: any,                    // A11YManager (game/a11y.js)
   *   input?: any,                   // Input (engine/input.js)
   *   storage?: Storage,
   *   mount?: HTMLElement|null,
   *   hotkey?: string|null,          // KeyboardEvent.code; default null (caller-driven)
   * }} [opts]
   */
  constructor({
    bus = null,
    save = null,
    audio = null,
    audioCore = null,
    postfx = null,
    screenFX = null,
    a11y = null,
    input = null,
    storage = (typeof localStorage !== 'undefined' ? localStorage : null),
    mount = null,
    hotkey = null,
  } = {}) {
    this.bus = bus;
    this.save = save;
    this.audio = audio;
    this.audioCore = audioCore;
    this.postfx = postfx;
    this.screenFX = screenFX;
    this.a11y = a11y;
    this.input = input;
    this.storage = storage;
    this._externalMount = mount;
    this.hotkey = hotkey;

    this._state = deepClone(DEFAULTS);
    this._category = 'graphics';
    this._visible = false;
    this._root = null;
    this._listeningBinding = null;
    this._saveDebounce = 0;
    this._onKey = this._onKey.bind(this);

    this.loadSettings();
    this._buildDOM();
    if (this.hotkey) this._bindHotkey();
    // Apply once at construction so live systems mirror persisted state.
    this.applySettings(this._state);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  show() {
    if (this._visible) return;
    this._visible = true;
    this._syncDOM();
    this._root?.classList.add('visible');
    this.bus?.emit?.('settings:shown', {});
  }

  hide() {
    if (!this._visible) return;
    this._visible = false;
    this._cancelListening();
    this._root?.classList.remove('visible');
    this.bus?.emit?.('settings:hidden', {});
  }

  toggle() { this._visible ? this.hide() : this.show(); }
  isVisible() { return this._visible; }

  /** Switch active tab. */
  updateCategory(category) {
    if (!CATEGORIES.includes(category)) return;
    if (this._category === category) return;
    this._category = category;
    this._renderBody();
    this._syncTabs();
  }

  getSettings() { return deepClone(this._state); }

  /** Return current key bindings (live, mutable copy). */
  getBindings() { return { ...this._state.controls.bindings }; }

  /** Convenience for engine/input.js consumers: returns true if `code` matches the bound action. */
  isBound(action, code) {
    return this._state.controls.bindings[action] === code;
  }

  /**
   * Apply a settings object to all wired systems (live preview).
   * Bulk apply; safe to call with partial state.
   */
  applySettings(state) {
    if (!state) return;
    const merged = sanitize({ ...this._state, ...state });
    this._state = merged;

    // -------- Graphics ---------------------------------------------------
    const g = merged.graphics;
    if (this.postfx && typeof this.postfx.setTier === 'function') {
      // 'auto' = don't override the engine-detected tier.
      if (g.qualityTier !== 'auto') {
        try { this.postfx.setTier(g.qualityTier); } catch (e) { /* swallow */ }
      }
    }
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.style.setProperty('--omega-ui-scale-graphics', String(g.uiScale));
    }
    // Fullscreen toggle — best-effort browser fullscreen on the canvas.
    this._applyFullscreen(g.fullscreen);

    // -------- Audio -------------------------------------------------------
    const a = merged.audio;
    if (this.audio) {
      // Route through AudioOptions when supplied — shares storage with the legacy panel.
      try { this.audio.setMasterVolume(a.masterVol); } catch {}
      try { this.audio.setMusicVolume(a.musicVol); } catch {}
      try { this.audio.setSfxVolume(a.sfxVol); } catch {}
      try { this.audio.setUiVolume(a.uiVol); } catch {}
      try { this.audio.setReduceIntensity(a.reduceIntensity); } catch {}
    } else if (this.audioCore?.getBuses) {
      const buses = this.audioCore.getBuses();
      if (buses?.master?.setVolume) buses.master.setVolume(a.masterVol);
      if (buses?.music?.setVolume)  buses.music.setVolume(a.musicVol);
      if (buses?.sfx?.setVolume)    buses.sfx.setVolume(a.sfxVol);
      if (buses?.ui?.setVolume)     buses.ui.setVolume(a.uiVol);
    }

    // -------- Controls ----------------------------------------------------
    if (this.input) {
      // Stash bindings on input so consumers (player.js etc.) can read them.
      this.input.bindings = { ...merged.controls.bindings };
      this.input.controllerEnabled = merged.controls.controller;
      this.input.aimAssist = merged.controls.aimAssist;
      this.input.invertY = merged.controls.invertY;
    }

    // -------- Accessibility ----------------------------------------------
    if (this.a11y) {
      try { this.a11y.applyAll(merged.accessibility); } catch (e) { /* swallow */ }
    }

    this.bus?.emit?.('settings:changed', { settings: deepClone(merged) });
  }

  loadSettings() {
    let raw = null;
    // Prefer SaveManager-backed settings if present.
    if (this.save && typeof this.save.load === 'function') {
      try {
        const data = this.save.load();
        if (data && data.settings && data.settings.full) {
          raw = data.settings.full;
        }
      } catch { /* fall through */ }
    }
    if (!raw && this.storage) {
      try {
        const s = this.storage.getItem(LS_KEY);
        if (s) raw = JSON.parse(s);
      } catch { /* noop */ }
    }
    // Pull legacy audio settings forward so users don't lose their volumes.
    if (!raw && this.storage) {
      try {
        const legacy = this.storage.getItem(AUDIO_OPTIONS_LS_KEY);
        if (legacy) {
          const parsed = JSON.parse(legacy);
          raw = { audio: parsed };
        }
      } catch { /* noop */ }
    }
    this._state = sanitize(raw);
    return deepClone(this._state);
  }

  saveSettings() {
    const blob = deepClone(this._state);
    // 1. Standalone localStorage key (always written; survives missing SaveManager).
    if (this.storage) {
      try { this.storage.setItem(LS_KEY, JSON.stringify(blob)); } catch { /* quota */ }
    }
    // 2. Canonical SaveManager slot — embed under settings.full so existing
    //    save consumers (run.js etc.) keep working with their narrow keys.
    if (this.save && typeof this.save.load === 'function' && typeof this.save.save === 'function') {
      try {
        const data = this.save.load();
        data.settings = data.settings || {};
        data.settings.full = blob;
        // Mirror audio volume into the legacy narrow keys for back-compat.
        data.settings.audio = {
          master: blob.audio.masterVol,
          music:  blob.audio.musicVol,
          sfx:    blob.audio.sfxVol,
          muted:  false,
        };
        // Mirror graphics into legacy video keys.
        data.settings.video = {
          tier:    blob.graphics.qualityTier,
          postFx:  true,
          motionBlur: true,
          shake:   blob.accessibility.screenShake === 'off' ? 0 :
                   blob.accessibility.screenShake === 'reduced' ? 0.5 : 1,
        };
        this.save.save(data);
      } catch { /* swallow */ }
    }
  }

  dispose() {
    this._cancelListening();
    if (this.hotkey) this._unbindHotkey();
    if (this._saveDebounce) {
      clearTimeout(this._saveDebounce);
      this._saveDebounce = 0;
      this.saveSettings();
    }
    this._root?.remove();
    this._root = null;
  }

  // -------------------------------------------------------------------------
  // Internals — mutation + persistence
  // -------------------------------------------------------------------------

  _set(path, value) {
    // path: 'graphics.qualityTier' | 'controls.bindings.fire' etc.
    const parts = path.split('.');
    let obj = this._state;
    for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
    obj[parts[parts.length - 1]] = value;
    this.applySettings(this._state);
    this._scheduleSave();
  }

  _scheduleSave() {
    if (!this.storage && !this.save) return;
    if (this._saveDebounce) clearTimeout(this._saveDebounce);
    this._saveDebounce = setTimeout(() => {
      this._saveDebounce = 0;
      this.saveSettings();
    }, 160);
  }

  _resetCategory() {
    this._state[this._category] = deepClone(DEFAULTS[this._category]);
    this.applySettings(this._state);
    this._renderBody();
    this._scheduleSave();
  }

  // -------------------------------------------------------------------------
  // Internals — fullscreen
  // -------------------------------------------------------------------------

  _applyFullscreen(on) {
    if (typeof document === 'undefined') return;
    const isFs = !!document.fullscreenElement;
    try {
      if (on && !isFs) {
        const el = document.getElementById('stage') || document.documentElement;
        el.requestFullscreen?.().catch(() => { /* user gesture required; silently ignore */ });
      } else if (!on && isFs) {
        document.exitFullscreen?.().catch(() => { /* noop */ });
      }
    } catch { /* noop */ }
  }

  // -------------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------------

  _ensureMount() {
    if (this._externalMount) return this._externalMount;
    if (typeof document === 'undefined') return null;
    return document.body;
  }

  _buildDOM() {
    if (typeof document === 'undefined') return;
    injectStyle();
    const parent = this._ensureMount();
    if (!parent) return;

    const root = document.createElement('div');
    root.id = 'omega-settings';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Settings');
    root.setAttribute('aria-hidden', 'true');

    const panel = document.createElement('div');
    panel.className = 'panel';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;';
    header.innerHTML = `
      <h1>Settings</h1>
      <div style="font-size:10px;letter-spacing:0.28em;color:rgba(207,233,255,0.5);text-transform:uppercase;">Live preview · auto-saved</div>
    `;
    panel.appendChild(header);

    const tabs = document.createElement('div');
    tabs.className = 'tabs';
    for (const cat of CATEGORIES) {
      const b = document.createElement('button');
      b.className = 'tab';
      b.dataset.cat = cat;
      b.textContent = cat;
      b.addEventListener('click', () => this.updateCategory(cat));
      tabs.appendChild(b);
    }
    panel.appendChild(tabs);

    const body = document.createElement('div');
    body.className = 'body';
    panel.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.innerHTML = `
      <button class="btn danger" data-action="reset">Reset This Tab</button>
      <button class="btn primary" data-action="close">Close · Esc</button>
    `;
    panel.appendChild(actions);

    actions.querySelector('[data-action="reset"]').addEventListener('click', () => this._resetCategory());
    actions.querySelector('[data-action="close"]').addEventListener('click', () => this.hide());

    root.appendChild(panel);
    parent.appendChild(root);

    // Click-outside dismiss.
    root.addEventListener('click', (e) => { if (e.target === root) this.hide(); });

    // Esc + keybinding capture.
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this._onKey, true);
    }

    this._root = root;
    this._tabsEl = tabs;
    this._bodyEl = body;
    this._renderBody();
    this._syncTabs();
  }

  _syncTabs() {
    if (!this._tabsEl) return;
    this._tabsEl.querySelectorAll('.tab').forEach((el) => {
      el.classList.toggle('active', el.dataset.cat === this._category);
    });
  }

  _renderBody() {
    if (!this._bodyEl) return;
    this._bodyEl.innerHTML = '';
    switch (this._category) {
      case 'graphics':      this._renderGraphics(); break;
      case 'audio':         this._renderAudio(); break;
      case 'controls':      this._renderControls(); break;
      case 'accessibility': this._renderA11y(); break;
    }
  }

  _syncDOM() {
    this._root?.setAttribute('aria-hidden', this._visible ? 'false' : 'true');
    this._renderBody();
    this._syncTabs();
  }

  // -------- Field helpers --------------------------------------------------

  _addField(label, controlEl, valueText = '', hint = '') {
    const row = document.createElement('div');
    row.className = 'field';
    const lab = document.createElement('div');
    lab.innerHTML = `<div class="field-label">${label}</div>${hint ? `<div class="field-hint">${hint}</div>` : ''}`;
    const val = document.createElement('div');
    val.className = 'field-value';
    val.textContent = valueText;
    row.appendChild(lab);
    row.appendChild(controlEl);
    row.appendChild(val);
    this._bodyEl.appendChild(row);
    return { row, val };
  }

  _makeSelect(options, current, onChange) {
    const sel = document.createElement('select');
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      if (opt === current) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }

  _makeToggle(current, onChange) {
    const t = document.createElement('div');
    t.className = 'toggle' + (current ? ' on' : '');
    t.setAttribute('role', 'switch');
    t.setAttribute('aria-checked', current ? 'true' : 'false');
    t.addEventListener('click', () => {
      const next = !t.classList.contains('on');
      t.classList.toggle('on', next);
      t.setAttribute('aria-checked', next ? 'true' : 'false');
      onChange(next);
    });
    return t;
  }

  _makeSlider(min, max, step, current, onChange) {
    const sl = document.createElement('input');
    sl.type = 'range';
    sl.min = String(min);
    sl.max = String(max);
    sl.step = String(step);
    sl.value = String(current);
    sl.addEventListener('input', () => onChange(Number(sl.value)));
    return sl;
  }

  // -------- Tab renderers --------------------------------------------------

  _renderGraphics() {
    const g = this._state.graphics;
    // Quality tier
    this._addField(
      'Quality Tier',
      this._makeSelect(QUALITY_TIERS, g.qualityTier, (v) => { this._set('graphics.qualityTier', v); }),
      '',
      'auto = engine-detected based on GPU capability',
    );
    // VSync
    this._addField(
      'VSync',
      this._makeToggle(g.vsync, (v) => { this._set('graphics.vsync', v); }),
      g.vsync ? 'On' : 'Off',
    );
    // Fullscreen
    this._addField(
      'Fullscreen',
      this._makeToggle(g.fullscreen, (v) => { this._set('graphics.fullscreen', v); }),
      g.fullscreen ? 'On' : 'Off',
    );
    // UI scale
    const sl = this._makeSlider(0.5, 2.0, 0.05, g.uiScale, (v) => {
      this._set('graphics.uiScale', v);
      // Live label update inline (don't re-render the whole tab on every tick).
      const valEl = sl.parentElement?.parentElement?.querySelector('.field-value');
      if (valEl) valEl.textContent = `${v.toFixed(2)}x`;
    });
    this._addField('UI Scale', sl, `${g.uiScale.toFixed(2)}x`);
  }

  _renderAudio() {
    const a = this._state.audio;
    const mkVol = (key, label) => {
      const sl = this._makeSlider(0, 1, 0.01, a[key], (v) => {
        this._set(`audio.${key}`, v);
        const valEl = sl.parentElement?.parentElement?.querySelector('.field-value');
        if (valEl) valEl.textContent = `${Math.round(v * 100)}%`;
      });
      this._addField(label, sl, `${Math.round(a[key] * 100)}%`);
    };
    mkVol('masterVol', 'Master Volume');
    mkVol('musicVol',  'Music Volume');
    mkVol('sfxVol',    'SFX Volume');
    mkVol('uiVol',     'UI Volume');
    this._addField(
      'Reduce Audio Intensity',
      this._makeToggle(a.reduceIntensity, (v) => { this._set('audio.reduceIntensity', v); }),
      a.reduceIntensity ? 'On' : 'Off',
      'Softens sharp transients and ducking peaks.',
    );
  }

  _renderControls() {
    const c = this._state.controls;
    // Keybinds
    for (const action of Object.keys(DEFAULT_BINDINGS)) {
      const btn = document.createElement('button');
      btn.className = 'keybind';
      btn.dataset.action = action;
      btn.textContent = this._prettyKey(c.bindings[action]);
      btn.addEventListener('click', () => this._startListening(action, btn));
      this._addField(BINDING_LABELS[action] || action, btn, '');
    }
    // Controller / aim assist / invert Y
    this._addField(
      'Controller Support',
      this._makeToggle(c.controller, (v) => { this._set('controls.controller', v); }),
      c.controller ? 'On' : 'Off',
    );
    this._addField(
      'Aim Assist',
      this._makeToggle(c.aimAssist, (v) => { this._set('controls.aimAssist', v); }),
      c.aimAssist ? 'On' : 'Off',
      'Soft target snap for controller and pointer aim.',
    );
    this._addField(
      'Invert Y',
      this._makeToggle(c.invertY, (v) => { this._set('controls.invertY', v); }),
      c.invertY ? 'On' : 'Off',
    );
  }

  _renderA11y() {
    const x = this._state.accessibility;
    this._addField(
      'Screen Shake',
      this._makeSelect(SHAKE_LEVELS, x.screenShake, (v) => { this._set('accessibility.screenShake', v); }),
      '',
      'Reduces or disables camera shake.',
    );
    this._addField(
      'Flash / Strobe Reduction',
      this._makeSelect(FLASH_LEVELS, x.flashReduction, (v) => { this._set('accessibility.flashReduction', v); }),
      '',
      'maximum suppresses bright flashes entirely.',
    );
    this._addField(
      'Colorblind Mode',
      this._makeSelect(COLORBLIND_MODES, x.colorblind, (v) => { this._set('accessibility.colorblind', v); }),
      '',
      'Applies a daltonization filter to the rendered frame.',
    );
    const sl = this._makeSlider(0.5, 2.0, 0.05, x.textScale, (v) => {
      this._set('accessibility.textScale', v);
      const valEl = sl.parentElement?.parentElement?.querySelector('.field-value');
      if (valEl) valEl.textContent = `${v.toFixed(2)}x`;
    });
    this._addField('Text Scale', sl, `${x.textScale.toFixed(2)}x`);
    this._addField(
      'High Contrast',
      this._makeToggle(x.highContrast, (v) => { this._set('accessibility.highContrast', v); }),
      x.highContrast ? 'On' : 'Off',
      'Boosts HUD contrast and saturates the frame.',
    );
  }

  // -------- Keybinding capture --------------------------------------------

  _startListening(action, btn) {
    this._cancelListening();
    this._listeningBinding = { action, btn };
    btn.classList.add('listening');
    btn.textContent = '— PRESS A KEY —';
  }

  _cancelListening() {
    if (!this._listeningBinding) return;
    const { action, btn } = this._listeningBinding;
    btn.classList.remove('listening');
    btn.textContent = this._prettyKey(this._state.controls.bindings[action]);
    this._listeningBinding = null;
  }

  _prettyKey(code) {
    if (!code) return '—';
    return code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Arrow/, '↑').toUpperCase();
  }

  // -------- Keyboard ------------------------------------------------------

  _bindHotkey() {
    if (typeof window === 'undefined') return;
    // Already bound globally in _buildDOM; this is for the optional toggle hotkey.
  }
  _unbindHotkey() { /* paired with above */ }

  _onKey(e) {
    if (e.repeat) return;
    // Capture mode: bind any non-Escape key to the listening action.
    if (this._listeningBinding) {
      if (e.code === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this._cancelListening();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const { action, btn } = this._listeningBinding;
      this._set(`controls.bindings.${action}`, e.code);
      btn.classList.remove('listening');
      btn.textContent = this._prettyKey(e.code);
      this._listeningBinding = null;
      return;
    }

    if (!this._visible) {
      // Hotkey-driven open (optional).
      if (this.hotkey && e.code === this.hotkey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        this.show();
      }
      return;
    }

    if (e.code === 'Escape') {
      e.preventDefault();
      this.hide();
    }
  }
}

export { DEFAULTS as SETTINGS_DEFAULTS, LS_KEY as SETTINGS_LS_KEY };
export default SettingsScreen;
