// Transitions — SPRINT-09 polish.
//
// DOM-only screen-effect layer: fade-to-black, white/red flashes, screen
// shake, biome handoff palette wash, boss-intro letterbox stinger, death
// summary fade. Everything runs through CSS transitions on a dedicated
// fullscreen overlay above the WebGPU canvas (z-index just under HUD).
//
// The Transitions manager is event-bus aware: subscribe()ing wires it to the
// usual gameplay events (biome:begin, biome:complete, boss:intro, run:over,
// player:death) so the rest of the engine doesn't have to know it exists.
// Each effect can also be invoked imperatively.
//
// Performance:
//   - Single overlay element, allocated once.
//   - Effects use CSS transitions + transforms (compositor-only).
//   - No per-frame RAF; one setTimeout per effect to clear state.
//
// MUST NOT:
//   - Mutate audio, gameplay, or render systems.
//   - Block the loop. All effects are fire-and-forget.

const OVERLAY_ID  = 'omega-transitions';
const SHAKE_ID    = 'omega-shake-host';
const STYLE_ID    = 'omega-transitions-style';

const CSS = `
#${OVERLAY_ID} {
  position: fixed; inset: 0; z-index: 180;
  pointer-events: none;
  opacity: 0;
  background: #000;
  transition: opacity 380ms ease;
  will-change: opacity, background;
}
#${OVERLAY_ID}.visible { opacity: 1; }
#${OVERLAY_ID}.fast    { transition-duration: 140ms; }
#${OVERLAY_ID}.slow    { transition-duration: 900ms; }

#${OVERLAY_ID}.flash-white { background: #ffffff; }
#${OVERLAY_ID}.flash-red   {
  background: radial-gradient(ellipse at center,
    rgba(255,40,80,0.65) 0%, rgba(120,0,20,0.85) 70%, rgba(40,0,10,0.95) 100%);
}
#${OVERLAY_ID}.flash-warm  {
  background: radial-gradient(ellipse at center,
    rgba(255,200,120,0.55) 0%, rgba(180,60,30,0.45) 60%, rgba(20,5,2,0.85) 100%);
}
#${OVERLAY_ID}.biome-wash {
  background: radial-gradient(circle at 50% 50%,
    var(--biome-color, rgba(120,200,255,0.45)) 0%,
    rgba(2,3,10,0.85) 75%);
  transition: opacity 700ms ease, background 700ms ease;
}

/* Letterbox for boss intro */
#${OVERLAY_ID} .letterbox-top,
#${OVERLAY_ID} .letterbox-bot {
  position: absolute; left: 0; right: 0; height: 0;
  background: #000; transition: height 380ms ease;
}
#${OVERLAY_ID} .letterbox-top { top: 0; }
#${OVERLAY_ID} .letterbox-bot { bottom: 0; }
#${OVERLAY_ID}.letterboxed .letterbox-top,
#${OVERLAY_ID}.letterboxed .letterbox-bot { height: 12vh; }

#${OVERLAY_ID} .stinger {
  position: absolute; left: 50%; top: 50%;
  transform: translate(-50%, -50%);
  font-family: ui-monospace, "JetBrains Mono", monospace;
  letter-spacing: 0.6em; text-transform: uppercase;
  font-size: clamp(18px, 3vw, 36px);
  color: #ff5c7a;
  text-shadow: 0 0 24px rgba(255,80,120,0.7),
               0 0 48px rgba(180,40,80,0.4);
  opacity: 0; transition: opacity 240ms ease, letter-spacing 700ms ease;
  pointer-events: none;
}
#${OVERLAY_ID} .stinger.show { opacity: 1; letter-spacing: 0.78em; }

/* Screen-shake host wraps the canvas element. */
#${SHAKE_ID} { will-change: transform; }
#${SHAKE_ID}.shake-light  { animation: omega-shake-light  280ms cubic-bezier(.36,.07,.19,.97) both; }
#${SHAKE_ID}.shake-medium { animation: omega-shake-medium 420ms cubic-bezier(.36,.07,.19,.97) both; }
#${SHAKE_ID}.shake-heavy  { animation: omega-shake-heavy  600ms cubic-bezier(.36,.07,.19,.97) both; }

@keyframes omega-shake-light {
  10%, 90% { transform: translate(-1px, 0); }
  20%, 80% { transform: translate(2px, 0); }
  30%, 50%, 70% { transform: translate(-3px, 1px); }
  40%, 60% { transform: translate(3px, -1px); }
}
@keyframes omega-shake-medium {
  10%, 90% { transform: translate(-2px, 1px); }
  20%, 80% { transform: translate(3px, -1px); }
  30%, 50%, 70% { transform: translate(-5px, 2px); }
  40%, 60% { transform: translate(5px, -2px); }
}
@keyframes omega-shake-heavy {
  10%, 90% { transform: translate(-3px, 2px); }
  20%, 80% { transform: translate(6px, -2px); }
  30%, 50%, 70% { transform: translate(-9px, 4px); }
  40%, 60% { transform: translate(9px, -4px); }
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

// Per-biome palette tints used by biomeWash() — color cues match the
// per-biome post-FX palette so the transition reads as a real handoff.
const BIOME_TINTS = Object.freeze({
  'nebula':            'rgba(120,160,255,0.40)',
  'nebula-drift':      'rgba(120,160,255,0.40)',
  'accretion':         'rgba(255,170,80,0.45)',
  'accretion-verge':   'rgba(255,170,80,0.45)',
  'pulsar':            'rgba(180,255,220,0.42)',
  'pulsar-field':      'rgba(180,255,220,0.42)',
  'debris':            'rgba(200,170,140,0.38)',
  'debris-belt':       'rgba(200,170,140,0.38)',
  'event-horizon':     'rgba(255,80,200,0.45)',
  'singularity-core':  'rgba(140,80,255,0.50)',
  'omega':             'rgba(255,210,120,0.55)',
});

export class Transitions {
  constructor({ bus = null, shakeTarget = null } = {}) {
    injectStyle();
    this.bus = bus;
    this._timers = new Set();
    this._mounted = false;
    this._mount();

    // Default shake target — the canvas or its #app parent so the HUD does NOT shake.
    this._shakeTarget = shakeTarget
      || (typeof document !== 'undefined'
          ? (document.getElementById('stage') || document.getElementById('app'))
          : null);
    if (this._shakeTarget) this._shakeTarget.id = this._shakeTarget.id || SHAKE_ID;
    // We use the host's own id-based animation classes; tag the target.
    if (this._shakeTarget) this._shakeTarget.classList.add(SHAKE_ID + '-tagged');
  }

  _mount() {
    if (typeof document === 'undefined' || this._mounted) return;
    let el = document.getElementById(OVERLAY_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = OVERLAY_ID;
      const top = document.createElement('div'); top.className = 'letterbox-top';
      const bot = document.createElement('div'); bot.className = 'letterbox-bot';
      const sting = document.createElement('div'); sting.className = 'stinger';
      el.appendChild(top); el.appendChild(bot); el.appendChild(sting);
      document.body.appendChild(el);
    }
    this._overlay = el;
    this._stinger = el.querySelector('.stinger');
    this._mounted = true;
  }

  _after(ms, fn) {
    const id = setTimeout(() => {
      this._timers.delete(id);
      try { fn(); } catch { /* noop */ }
    }, ms);
    this._timers.add(id);
    return id;
  }

  _resetClasses() {
    if (!this._overlay) return;
    this._overlay.classList.remove(
      'visible', 'fast', 'slow',
      'flash-white', 'flash-red', 'flash-warm',
      'biome-wash', 'letterboxed',
    );
    this._overlay.style.setProperty('--biome-color', '');
    this._stinger?.classList.remove('show');
  }

  // -------------------------------------------------------------------
  // Imperative effects
  // -------------------------------------------------------------------

  /** Fade screen to black over `inMs`, hold `holdMs`, fade out over `outMs`. */
  fadeToBlack({ inMs = 380, holdMs = 0, outMs = 380, onMid = null, onDone = null } = {}) {
    if (!this._overlay) return;
    this._resetClasses();
    if (inMs <= 200) this._overlay.classList.add('fast');
    else if (inMs >= 700) this._overlay.classList.add('slow');
    this._overlay.style.transitionDuration = `${inMs}ms`;
    requestAnimationFrame(() => this._overlay.classList.add('visible'));
    this._after(inMs, () => {
      try { onMid?.(); } catch {}
      this._after(holdMs, () => {
        this._overlay.style.transitionDuration = `${outMs}ms`;
        this._overlay.classList.remove('visible');
        this._after(outMs + 20, () => {
          this._resetClasses();
          this._overlay.style.transitionDuration = '';
          try { onDone?.(); } catch {}
        });
      });
    });
  }

  /** Quick fade-from-black entry (run-start handoff). */
  fadeFromBlack({ ms = 600 } = {}) {
    if (!this._overlay) return;
    this._resetClasses();
    this._overlay.classList.add('visible');
    this._overlay.style.transitionDuration = '0ms';
    // Force layout, then animate out.
    void this._overlay.offsetHeight;
    this._overlay.style.transitionDuration = `${ms}ms`;
    this._overlay.classList.remove('visible');
    this._after(ms + 20, () => {
      this._resetClasses();
      this._overlay.style.transitionDuration = '';
    });
  }

  /** Bright white flash (parry, big damage). */
  flashWhite({ ms = 220 } = {}) {
    if (!this._overlay) return;
    this._resetClasses();
    this._overlay.classList.add('flash-white', 'fast', 'visible');
    this._after(60, () => this._overlay.classList.remove('visible'));
    this._after(ms + 80, () => this._resetClasses());
  }

  /** Red blood-flash (player hit / death). */
  flashRed({ ms = 320 } = {}) {
    if (!this._overlay) return;
    this._resetClasses();
    this._overlay.classList.add('flash-red', 'fast', 'visible');
    this._after(80, () => this._overlay.classList.remove('visible'));
    this._after(ms + 80, () => this._resetClasses());
  }

  /** Warm wash (pickup, level-up). */
  flashWarm({ ms = 320 } = {}) {
    if (!this._overlay) return;
    this._resetClasses();
    this._overlay.classList.add('flash-warm', 'fast', 'visible');
    this._after(80, () => this._overlay.classList.remove('visible'));
    this._after(ms + 80, () => this._resetClasses());
  }

  /** Biome handoff palette wash. */
  biomeWash(biomeId, { ms = 700 } = {}) {
    if (!this._overlay) return;
    const tint = BIOME_TINTS[biomeId] || 'rgba(120,200,255,0.40)';
    this._resetClasses();
    this._overlay.style.setProperty('--biome-color', tint);
    this._overlay.classList.add('biome-wash', 'visible');
    this._after(ms * 0.55, () => this._overlay.classList.remove('visible'));
    this._after(ms + 60, () => this._resetClasses());
  }

  /** Boss intro stinger with letterbox + label. */
  bossIntro({ label = 'WARNING', ms = 1400 } = {}) {
    if (!this._overlay || !this._stinger) return;
    this._resetClasses();
    this._stinger.textContent = label;
    this._overlay.classList.add('letterboxed');
    this._after(60, () => this._stinger.classList.add('show'));
    this._after(ms - 380, () => this._stinger.classList.remove('show'));
    this._after(ms, () => this._resetClasses());
  }

  /** Screen shake. Strength: 'light' | 'medium' | 'heavy'. */
  shake(strength = 'medium') {
    const tgt = this._shakeTarget;
    if (!tgt) return;
    const cls = `shake-${strength}`;
    tgt.classList.remove('shake-light', 'shake-medium', 'shake-heavy');
    // Force reflow so re-adding the same class restarts the animation.
    void tgt.offsetWidth;
    tgt.classList.add(cls);
    this._after(800, () => tgt.classList.remove(cls));
  }

  /** Death transition: red flash → heavy shake → fade to black → callback. */
  death({ onSummary = null, fadeMs = 700 } = {}) {
    this.flashRed({ ms: 280 });
    this.shake('heavy');
    this._after(420, () => {
      this.fadeToBlack({ inMs: fadeMs, holdMs: 120, outMs: 0, onMid: onSummary });
    });
  }

  // -------------------------------------------------------------------
  // EventBus subscription (optional convenience).
  // -------------------------------------------------------------------
  subscribe(bus = this.bus) {
    if (!bus || typeof bus.on !== 'function') return () => {};
    const offs = [];
    const on = (ev, fn) => {
      const off = bus.on(ev, fn);
      if (typeof off === 'function') offs.push(off);
    };

    on('run:start',       () => this.fadeFromBlack({ ms: 700 }));
    on('biome:intro',     (p) => this.biomeWash(p?.biomeId, { ms: 800 }));
    on('biome:begin',     (p) => this.biomeWash(p?.biomeId ?? p?.id, { ms: 800 }));
    on('biome:complete',  (p) => this.biomeWash(p?.biomeId ?? p?.id, { ms: 600 }));
    on('boss:intro',      (p) => {
      this.bossIntro({ label: (p?.name || 'WARNING').toUpperCase(), ms: 1500 });
      this.shake('light');
    });
    on('player:hit',      () => this.flashRed({ ms: 220 }));
    on('player:death',    () => this.death());
    on('run:over',        () => this.fadeToBlack({ inMs: 700, holdMs: 80, outMs: 0 }));
    on('pickup:upgrade',  () => this.flashWarm({ ms: 260 }));

    this._unsubscribe = () => { for (const o of offs) try { o(); } catch {} offs.length = 0; };
    return this._unsubscribe;
  }

  dispose() {
    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();
    if (typeof this._unsubscribe === 'function') {
      try { this._unsubscribe(); } catch { /* noop */ }
    }
    if (this._overlay && this._overlay.parentElement) {
      this._overlay.parentElement.removeChild(this._overlay);
    }
    this._overlay = null;
    this._stinger = null;
    this._mounted = false;
  }
}

export default Transitions;
