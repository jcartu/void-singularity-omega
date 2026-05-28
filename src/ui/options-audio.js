// Audio Options Panel — persisted audio settings with live preview (SPRINT-05).
//
// Standalone DOM overlay. Independent of ScreenManager so it can be toggled
// from anywhere (O key, pause menu, etc.) without colliding with run screens.
//
// Settings persist to localStorage under `omega_audio_settings`.
// All changes apply live to the supplied AudioCore (via its bus handles) and
// emit 'audio:settings_changed' on the event bus.
//
// MUST NOT block the main thread, MUST NOT import audio internals beyond the
// AudioCore handle that callers pass in, MUST NOT break existing screens.

const STYLE_ID = 'omega-audio-options-style';
const LS_KEY = 'omega_audio_settings';

const DEFAULTS = Object.freeze({
  masterVol: 0.8,
  musicVol: 0.8,
  sfxVol: 0.8,
  uiVol: 0.8,
  masterMuted: false,
  musicMuted: false,
  sfxMuted: false,
  reduceIntensity: false,
});

const CSS = `
#omega-audio-options {
  position: fixed; inset: 0; z-index: 250;
  display: none;
  align-items: center; justify-content: center;
  background: radial-gradient(ellipse at center, rgba(4,6,18,0.62) 0%, rgba(2,3,10,0.88) 70%);
  backdrop-filter: blur(6px);
  font-family: ui-monospace, "JetBrains Mono", "Courier New", monospace;
  color: #cfe9ff;
  opacity: 0; transition: opacity 180ms ease;
}
#omega-audio-options.visible { display: flex; opacity: 1; }

#omega-audio-options .panel {
  background: linear-gradient(180deg, rgba(10,18,38,0.96), rgba(6,10,22,0.96));
  border: 1px solid rgba(120,200,255,0.28);
  border-radius: 10px;
  padding: 28px 32px;
  min-width: min(480px, 92vw);
  max-width: 560px;
  box-shadow: 0 24px 60px -20px rgba(120,200,255,0.35);
}
#omega-audio-options h1 {
  font-size: 18px; letter-spacing: 0.4em; text-transform: uppercase;
  margin: 0 0 4px; font-weight: 500; color: #e8f6ff;
}
#omega-audio-options .subtitle {
  font-size: 10px; letter-spacing: 0.3em; text-transform: uppercase;
  color: rgba(207,233,255,0.55); margin: 0 0 22px;
}
#omega-audio-options .row {
  display: grid;
  grid-template-columns: 96px 1fr 48px 56px;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px dashed rgba(120,200,255,0.1);
}
#omega-audio-options .row:last-of-type { border-bottom: none; }
#omega-audio-options .label {
  font-size: 11px; letter-spacing: 0.22em; text-transform: uppercase;
  color: rgba(207,233,255,0.78);
}
#omega-audio-options input[type="range"] {
  -webkit-appearance: none; appearance: none;
  width: 100%; height: 4px;
  background: linear-gradient(90deg, rgba(120,200,255,0.55) 0%, rgba(120,200,255,0.55) var(--v,80%), rgba(120,200,255,0.12) var(--v,80%), rgba(120,200,255,0.12) 100%);
  border-radius: 2px; outline: none; cursor: pointer;
}
#omega-audio-options input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 14px; height: 14px; border-radius: 50%;
  background: #e8f6ff; border: 1px solid rgba(180,240,255,0.8);
  cursor: pointer; box-shadow: 0 0 12px rgba(120,200,255,0.55);
}
#omega-audio-options input[type="range"]::-moz-range-thumb {
  width: 14px; height: 14px; border-radius: 50%;
  background: #e8f6ff; border: 1px solid rgba(180,240,255,0.8);
  cursor: pointer; box-shadow: 0 0 12px rgba(120,200,255,0.55);
}
#omega-audio-options input[type="range"]:disabled { opacity: 0.35; cursor: not-allowed; }
#omega-audio-options .val {
  font-size: 11px; letter-spacing: 0.1em;
  color: #fff7c8; font-variant-numeric: tabular-nums;
  text-align: right;
}
#omega-audio-options .mute-btn {
  background: rgba(10,18,38,0.92);
  border: 1px solid rgba(120,200,255,0.3);
  color: rgba(207,233,255,0.7);
  font-family: inherit; font-size: 9px;
  letter-spacing: 0.2em; text-transform: uppercase;
  padding: 5px 0; border-radius: 3px; cursor: pointer;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
}
#omega-audio-options .mute-btn:hover { border-color: rgba(180,240,255,0.7); }
#omega-audio-options .mute-btn.on {
  background: rgba(255,92,122,0.18);
  border-color: rgba(255,92,122,0.6);
  color: #ff8fa3;
}
#omega-audio-options .mute-btn.placeholder { visibility: hidden; }

#omega-audio-options .a11y {
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid rgba(120,200,255,0.18);
}
#omega-audio-options .a11y-title {
  font-size: 10px; letter-spacing: 0.32em; text-transform: uppercase;
  color: rgba(207,233,255,0.55); margin-bottom: 10px;
}
#omega-audio-options .check-row {
  display: flex; align-items: center; gap: 10px;
  font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase;
  color: rgba(207,233,255,0.85);
  cursor: pointer;
  padding: 6px 0;
}
#omega-audio-options .check-row input { accent-color: #6ad8ff; cursor: pointer; width: 14px; height: 14px; }
#omega-audio-options .check-row .hint {
  display: block;
  font-size: 9px; letter-spacing: 0.18em;
  color: rgba(207,233,255,0.45);
  text-transform: none; margin-top: 2px;
}

#omega-audio-options .actions {
  display: flex; gap: 10px; justify-content: flex-end;
  margin-top: 22px;
}
#omega-audio-options .btn {
  background: rgba(10,18,38,0.92);
  border: 1px solid rgba(120,200,255,0.45);
  color: #e8f6ff;
  padding: 8px 18px;
  font-family: inherit;
  font-size: 10px; letter-spacing: 0.3em; text-transform: uppercase;
  cursor: pointer;
  border-radius: 4px;
  transition: background 140ms ease, border-color 140ms ease;
}
#omega-audio-options .btn:hover {
  background: rgba(120,200,255,0.16);
  border-color: rgba(180,240,255,0.9);
}
#omega-audio-options .btn.primary {
  background: linear-gradient(180deg, rgba(106,216,255,0.22), rgba(106,216,255,0.08));
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

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function sanitize(obj) {
  const o = obj && typeof obj === 'object' ? obj : {};
  return {
    masterVol: clamp01(o.masterVol ?? DEFAULTS.masterVol),
    musicVol:  clamp01(o.musicVol  ?? DEFAULTS.musicVol),
    sfxVol:    clamp01(o.sfxVol    ?? DEFAULTS.sfxVol),
    uiVol:     clamp01(o.uiVol     ?? DEFAULTS.uiVol),
    masterMuted: !!(o.masterMuted ?? DEFAULTS.masterMuted),
    musicMuted:  !!(o.musicMuted  ?? DEFAULTS.musicMuted),
    sfxMuted:    !!(o.sfxMuted    ?? DEFAULTS.sfxMuted),
    reduceIntensity: !!(o.reduceIntensity ?? DEFAULTS.reduceIntensity),
  };
}

export class AudioOptions {
  /**
   * @param {{
   *   bus?: any,
   *   audio?: any,                     // AudioCore (or compatible) — optional
   *   storage?: Storage,               // override for tests
   *   hotkey?: string|null,            // KeyboardEvent.code; default 'KeyO'. null disables.
   *   mount?: HTMLElement|null,
   * }} [opts]
   */
  constructor({
    bus = null,
    audio = null,
    storage = (typeof localStorage !== 'undefined' ? localStorage : null),
    hotkey = 'KeyO',
    mount = null,
  } = {}) {
    this.bus = bus;
    this.audio = audio;
    this.storage = storage;
    this.hotkey = hotkey;
    this._externalMount = mount;
    this._root = null;
    this._visible = false;
    this._els = {};
    this._settings = { ...DEFAULTS };
    this._onKey = this._onKey.bind(this);
    this._onAudioReady = this._onAudioReady.bind(this);
    this._saveDebounce = 0;

    this.loadSettings();
    this._buildDOM();
    this._bindHotkey();
    this._applyToAudio();
    if (this.bus?.on) this.bus.on('audio:ready', this._onAudioReady);
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  show() {
    if (this._visible) return;
    this._visible = true;
    this._syncDOM();
    this._root.classList.add('visible');
    this.bus?.emit?.('audio:options_shown', {});
  }

  hide() {
    if (!this._visible) return;
    this._visible = false;
    this._root.classList.remove('visible');
    this.bus?.emit?.('audio:options_hidden', {});
  }

  toggle() { this._visible ? this.hide() : this.show(); }

  isVisible() { return this._visible; }

  setMasterVolume(v) { this._setVol('masterVol', v); }
  setMusicVolume(v)  { this._setVol('musicVol',  v); }
  setSfxVolume(v)    { this._setVol('sfxVol',    v); }
  setUiVolume(v)     { this._setVol('uiVol',     v); }

  setMasterMuted(on) { this._setMute('masterMuted', !!on); }
  setMusicMuted(on)  { this._setMute('musicMuted',  !!on); }
  setSfxMuted(on)    { this._setMute('sfxMuted',    !!on); }

  setReduceIntensity(on) {
    const next = !!on;
    if (this._settings.reduceIntensity === next) return;
    this._settings.reduceIntensity = next;
    this._syncDOM();
    this._emitChange('reduceIntensity');
    this._scheduleSave();
  }

  getSettings() { return { ...this._settings }; }

  loadSettings() {
    let raw = null;
    try {
      raw = this.storage ? this.storage.getItem(LS_KEY) : null;
    } catch (_) { /* private mode, etc. */ }
    let parsed = null;
    if (raw) { try { parsed = JSON.parse(raw); } catch (_) {} }
    this._settings = sanitize(parsed);
    return { ...this._settings };
  }

  saveSettings() {
    if (!this.storage) return;
    try {
      this.storage.setItem(LS_KEY, JSON.stringify(this._settings));
    } catch (_) { /* quota, private mode */ }
  }

  /** Reapply current settings to the audio backend (e.g. after audio:ready). */
  applyToAudio(audio = null) {
    if (audio) this.audio = audio;
    this._applyToAudio();
  }

  dispose() {
    this._unbindHotkey();
    if (this.bus?.off) this.bus.off('audio:ready', this._onAudioReady);
    if (this._saveDebounce) {
      clearTimeout(this._saveDebounce);
      this._saveDebounce = 0;
      this.saveSettings();
    }
    this._root?.remove();
    this._root = null;
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  _setVol(key, v) {
    const next = clamp01(v);
    if (this._settings[key] === next) return;
    this._settings[key] = next;
    this._syncDOM();
    this._applyVol(key);
    this._emitChange(key);
    this._scheduleSave();
  }

  _setMute(key, on) {
    if (this._settings[key] === on) return;
    this._settings[key] = on;
    this._syncDOM();
    this._applyMute(key);
    this._emitChange(key);
    this._scheduleSave();
  }

  _busFor(key) {
    const buses = this.audio?.getBuses?.();
    if (!buses) return null;
    switch (key) {
      case 'masterVol': case 'masterMuted': return buses.master;
      case 'musicVol':  case 'musicMuted':  return buses.music;
      case 'sfxVol':    case 'sfxMuted':    return buses.sfx;
      case 'uiVol':                         return buses.ui;
      default: return null;
    }
  }

  _applyVol(key) {
    const handle = this._busFor(key);
    if (handle?.setVolume) handle.setVolume(this._settings[key]);
  }

  _applyMute(key) {
    if (key === 'masterMuted' && this.audio?.setMasterMuted) {
      this.audio.setMasterMuted(this._settings.masterMuted);
      return;
    }
    const handle = this._busFor(key);
    if (handle?.setMuted) handle.setMuted(this._settings[key]);
  }

  _applyToAudio() {
    if (!this.audio) return;
    this._applyVol('masterVol');
    this._applyVol('musicVol');
    this._applyVol('sfxVol');
    this._applyVol('uiVol');
    this._applyMute('masterMuted');
    this._applyMute('musicMuted');
    this._applyMute('sfxMuted');
  }

  _onAudioReady(audio) {
    if (audio && !this.audio) this.audio = audio;
    this._applyToAudio();
  }

  _emitChange(field) {
    if (!this.bus?.emit) return;
    this.bus.emit('audio:settings_changed', {
      field,
      value: this._settings[field],
      settings: { ...this._settings },
    });
  }

  _scheduleSave() {
    if (!this.storage) return;
    if (this._saveDebounce) clearTimeout(this._saveDebounce);
    this._saveDebounce = setTimeout(() => {
      this._saveDebounce = 0;
      this.saveSettings();
    }, 120);
  }

  // ---------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------

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
    root.id = 'omega-audio-options';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Audio Options');
    root.setAttribute('aria-hidden', 'true');

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <h1>Audio Options</h1>
      <p class="subtitle">Live preview · saved automatically</p>
      <div class="rows"></div>
      <div class="a11y">
        <div class="a11y-title">Accessibility</div>
        <label class="check-row">
          <input type="checkbox" data-a11y="reduceIntensity" />
          <span>
            Reduce audio intensity
            <span class="hint">Softens sharp transients, sidechains and ducking peaks.</span>
          </span>
        </label>
      </div>
      <div class="actions">
        <button class="btn" data-action="reset">Reset</button>
        <button class="btn primary" data-action="close">Close · Esc</button>
      </div>
    `;
    root.appendChild(panel);
    parent.appendChild(root);

    const rows = panel.querySelector('.rows');
    const rowDefs = [
      { key: 'masterVol', muteKey: 'masterMuted', label: 'Master' },
      { key: 'musicVol',  muteKey: 'musicMuted',  label: 'Music'  },
      { key: 'sfxVol',    muteKey: 'sfxMuted',    label: 'SFX'    },
      { key: 'uiVol',     muteKey: null,          label: 'UI'     },
    ];
    this._els.sliders = {};
    this._els.values = {};
    this._els.mutes = {};
    for (const def of rowDefs) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <div class="label">${def.label}</div>
        <input type="range" min="0" max="100" step="1" data-key="${def.key}" aria-label="${def.label} volume" />
        <div class="val" data-val-for="${def.key}">80%</div>
        ${def.muteKey
          ? `<button class="mute-btn" data-mute-key="${def.muteKey}" aria-pressed="false">Mute</button>`
          : `<button class="mute-btn placeholder" tabindex="-1" aria-hidden="true">Mute</button>`}
      `;
      rows.appendChild(row);
      const slider = row.querySelector('input[type="range"]');
      const valEl  = row.querySelector(`[data-val-for="${def.key}"]`);
      this._els.sliders[def.key] = slider;
      this._els.values[def.key] = valEl;
      slider.addEventListener('input', (e) => {
        const pct = Number(e.target.value);
        this._setVol(def.key, pct / 100);
      });
      if (def.muteKey) {
        const btn = row.querySelector('.mute-btn:not(.placeholder)');
        this._els.mutes[def.muteKey] = btn;
        btn.addEventListener('click', () => {
          this._setMute(def.muteKey, !this._settings[def.muteKey]);
        });
      }
    }

    this._els.reduce = panel.querySelector('[data-a11y="reduceIntensity"]');
    this._els.reduce.addEventListener('change', (e) => {
      this.setReduceIntensity(!!e.target.checked);
    });

    panel.querySelector('[data-action="close"]').addEventListener('click', () => this.hide());
    panel.querySelector('[data-action="reset"]').addEventListener('click', () => this._resetDefaults());

    // Click outside the panel to dismiss.
    root.addEventListener('click', (e) => { if (e.target === root) this.hide(); });

    this._root = root;
    this._syncDOM();
  }

  _syncDOM() {
    if (!this._root) return;
    const s = this._settings;
    this._root.setAttribute('aria-hidden', this._visible ? 'false' : 'true');
    const setSlider = (key) => {
      const sl = this._els.sliders[key];
      const val = this._els.values[key];
      if (!sl || !val) return;
      const pct = Math.round(s[key] * 100);
      if (sl.value !== String(pct)) sl.value = String(pct);
      sl.style.setProperty('--v', `${pct}%`);
      val.textContent = `${pct}%`;
    };
    setSlider('masterVol');
    setSlider('musicVol');
    setSlider('sfxVol');
    setSlider('uiVol');

    const setMute = (key) => {
      const btn = this._els.mutes[key];
      if (!btn) return;
      const on = !!s[key];
      btn.classList.toggle('on', on);
      btn.textContent = on ? 'Muted' : 'Mute';
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    };
    setMute('masterMuted');
    setMute('musicMuted');
    setMute('sfxMuted');

    // Master mute disables child sliders visually (audio bus already mutes).
    const masterOff = !!s.masterMuted;
    for (const k of ['musicVol', 'sfxVol', 'uiVol']) {
      const sl = this._els.sliders[k];
      if (sl) sl.disabled = masterOff;
    }

    if (this._els.reduce) this._els.reduce.checked = !!s.reduceIntensity;
  }

  _resetDefaults() {
    this._settings = { ...DEFAULTS };
    this._syncDOM();
    this._applyToAudio();
    this.bus?.emit?.('audio:settings_changed', {
      field: 'reset',
      value: null,
      settings: { ...this._settings },
    });
    this._scheduleSave();
  }

  // ---------------------------------------------------------------------
  // Hotkey
  // ---------------------------------------------------------------------

  _bindHotkey() {
    if (!this.hotkey || typeof window === 'undefined') return;
    window.addEventListener('keydown', this._onKey);
  }

  _unbindHotkey() {
    if (typeof window === 'undefined') return;
    window.removeEventListener('keydown', this._onKey);
  }

  _onKey(e) {
    if (e.repeat) return;
    // Don't hijack typing in inputs/textareas.
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;

    if (this._visible && e.code === 'Escape') {
      e.preventDefault();
      this.hide();
      return;
    }
    if (this.hotkey && e.code === this.hotkey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.toggle();
    }
  }
}

export { DEFAULTS as AUDIO_OPTIONS_DEFAULTS, LS_KEY as AUDIO_OPTIONS_LS_KEY };
