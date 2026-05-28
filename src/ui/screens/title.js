// Title Screen — SPRINT-09 polish, spectacular boot-up surface.
//
// Pure-DOM + SVG overlay built on the same BaseScreen lifecycle as the
// in-run screens. Designed to layer cleanly above whatever the WebGPU stage
// is rendering (idle attract loop, world-init scaffold, etc) without ever
// touching Three.js, audio, or gameplay state.
//
// Visual budget:
//   - Rotating SVG accretion-disk (CSS @keyframes; GPU-composited).
//   - Photon-ring + event-horizon overlay; lensing-grade glow.
//   - 64 deterministic particle motes (CSS-animated, no JS RAF).
//   - Logo with letterpress treatment + subtitle.
//   - 5 menu buttons w/ keyboard nav, hover lift, focus glow.
//   - Build-tag corner watermark.
//
// Emits (via shared EventBus):
//   'title:newrun'  — clicked / Enter on "New Run"
//   'title:continue'— clicked when a save exists
//   'title:meta'    — open meta-progression
//   'title:options' — open options/settings
//   'title:credits' — open credits roll
//
// MUST NOT:
//   - Allocate per-frame
//   - Touch audio (host wires music cues separately)
//   - Pause/resume the game loop (caller owns lifecycle)

import { BaseScreen } from '../screens.js';

const STYLE_ID = 'omega-title-style';

const TITLE_CSS = `
.omega-title {
  background: radial-gradient(120% 90% at 50% 38%,
    rgba(20,28,64,0.55) 0%,
    rgba(6,8,22,0.85) 55%,
    rgba(2,3,10,0.96) 100%) !important;
  backdrop-filter: blur(2px) !important;
  overflow: hidden;
}
.omega-title .stage {
  position: absolute; inset: 0;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  pointer-events: none;
}
.omega-title .stage > * { pointer-events: auto; }

/* --- Rotating accretion disk -------------------------------------- */
.omega-title .disk {
  position: absolute; top: 50%; left: 50%;
  width: min(120vmin, 1400px); aspect-ratio: 1;
  transform: translate(-50%, -50%);
  pointer-events: none;
  opacity: 0.78;
  filter: blur(0.4px);
  animation: omega-title-disk 38s linear infinite;
  will-change: transform;
}
.omega-title .disk svg { width: 100%; height: 100%; display: block; }
.omega-title .disk.r2 { animation-duration: 64s; animation-direction: reverse; opacity: 0.45; }
.omega-title .disk.r3 { animation-duration: 96s; opacity: 0.22; }

@keyframes omega-title-disk {
  from { transform: translate(-50%, -50%) rotate(0deg); }
  to   { transform: translate(-50%, -50%) rotate(360deg); }
}

/* --- Event-horizon shadow + photon ring --------------------------- */
.omega-title .horizon {
  position: absolute; top: 50%; left: 50%;
  width: 22vmin; aspect-ratio: 1;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: radial-gradient(circle at 50% 50%,
    #000 0%, #000 58%,
    rgba(255,180,120,0.55) 62%,
    rgba(255,220,150,0.18) 70%,
    transparent 78%);
  box-shadow:
    0 0 60px 8px rgba(255,170,100,0.25),
    0 0 180px 40px rgba(120,80,255,0.18),
    inset 0 0 30px 6px rgba(0,0,0,0.95);
  pointer-events: none;
  animation: omega-title-horizon 6s ease-in-out infinite;
}
@keyframes omega-title-horizon {
  0%, 100% { box-shadow:
      0 0 60px 8px rgba(255,170,100,0.25),
      0 0 180px 40px rgba(120,80,255,0.18),
      inset 0 0 30px 6px rgba(0,0,0,0.95); }
  50%      { box-shadow:
      0 0 90px 14px rgba(255,200,140,0.35),
      0 0 240px 60px rgba(140,100,255,0.26),
      inset 0 0 30px 6px rgba(0,0,0,0.95); }
}

/* --- Particle motes ----------------------------------------------- */
.omega-title .motes {
  position: absolute; inset: 0;
  pointer-events: none;
  overflow: hidden;
}
.omega-title .mote {
  position: absolute;
  width: 2px; height: 2px;
  border-radius: 50%;
  background: #cfe9ff;
  box-shadow: 0 0 6px 1px rgba(180,220,255,0.55);
  opacity: 0;
  animation: omega-title-mote linear infinite;
  will-change: transform, opacity;
}
@keyframes omega-title-mote {
  0%   { transform: translate(0, 0) scale(0.4); opacity: 0; }
  10%  { opacity: 0.9; }
  90%  { opacity: 0.6; }
  100% { transform: translate(var(--dx), var(--dy)) scale(1); opacity: 0; }
}

/* --- Logo / title text ------------------------------------------- */
.omega-title .logo-wrap {
  position: relative; z-index: 5;
  margin-top: -8vh;
  text-align: center;
  pointer-events: none;
}
.omega-title .logo-line1 {
  font-family: ui-monospace, "JetBrains Mono", "Courier New", monospace;
  font-size: clamp(28px, 5.8vw, 84px);
  font-weight: 500;
  letter-spacing: 0.42em;
  color: #f4f9ff;
  text-shadow:
    0 0 18px rgba(140,210,255,0.55),
    0 0 42px rgba(120,180,255,0.30),
    0 2px 0 rgba(0,0,0,0.6);
  margin: 0;
  text-transform: uppercase;
  animation: omega-title-glow 5.2s ease-in-out infinite;
}
.omega-title .logo-line2 {
  font-family: ui-monospace, "JetBrains Mono", monospace;
  font-size: clamp(14px, 2.4vw, 28px);
  letter-spacing: 0.74em;
  color: #ffd089;
  text-shadow:
    0 0 16px rgba(255,170,80,0.55),
    0 0 32px rgba(255,120,40,0.25);
  margin: 6px 0 0 0;
  padding-left: 0.74em; /* offset to balance kerning */
  text-transform: uppercase;
}
.omega-title .tagline {
  margin-top: 14px;
  font-family: ui-monospace, monospace;
  font-size: 11px;
  letter-spacing: 0.5em;
  color: rgba(207,233,255,0.45);
  text-transform: uppercase;
}
@keyframes omega-title-glow {
  0%, 100% { text-shadow:
    0 0 18px rgba(140,210,255,0.55),
    0 0 42px rgba(120,180,255,0.30),
    0 2px 0 rgba(0,0,0,0.6); }
  50%      { text-shadow:
    0 0 26px rgba(180,230,255,0.78),
    0 0 60px rgba(140,200,255,0.45),
    0 2px 0 rgba(0,0,0,0.6); }
}

/* --- Menu -------------------------------------------------------- */
.omega-title .menu {
  position: relative; z-index: 5;
  margin-top: clamp(28px, 5vh, 56px);
  display: flex; flex-direction: column; gap: 10px;
  min-width: 260px;
  align-items: stretch;
}
.omega-title .menu-btn {
  background: linear-gradient(180deg,
    rgba(10,18,38,0.78), rgba(6,10,22,0.78));
  border: 1px solid rgba(120,200,255,0.22);
  color: #e8f6ff;
  padding: 13px 24px;
  font-family: ui-monospace, "JetBrains Mono", monospace;
  font-size: 12px;
  letter-spacing: 0.34em;
  text-transform: uppercase;
  cursor: pointer;
  border-radius: 4px;
  position: relative;
  transition: background 160ms ease, border-color 160ms ease,
              transform 160ms ease, box-shadow 160ms ease, color 160ms ease;
  text-align: center;
}
.omega-title .menu-btn::before {
  content: ''; position: absolute; left: 10px; top: 50%;
  width: 6px; height: 6px; border-radius: 50%;
  transform: translateY(-50%) scale(0);
  background: #6ad8ff;
  box-shadow: 0 0 10px rgba(106,216,255,0.85);
  transition: transform 160ms ease;
}
.omega-title .menu-btn:hover:not(.disabled),
.omega-title .menu-btn.focused {
  background: linear-gradient(180deg,
    rgba(40,90,160,0.45), rgba(20,40,90,0.45));
  border-color: rgba(180,240,255,0.95);
  color: #ffffff;
  transform: translateX(2px);
  box-shadow:
    0 0 0 1px rgba(180,240,255,0.45) inset,
    0 12px 36px -12px rgba(120,200,255,0.55);
}
.omega-title .menu-btn:hover:not(.disabled)::before,
.omega-title .menu-btn.focused::before {
  transform: translateY(-50%) scale(1);
}
.omega-title .menu-btn.disabled {
  opacity: 0.32; cursor: not-allowed;
  color: rgba(207,233,255,0.5);
}
.omega-title .menu-btn.primary {
  background: linear-gradient(180deg,
    rgba(106,216,255,0.30), rgba(60,140,220,0.18));
  border-color: rgba(180,240,255,0.7);
}
.omega-title .menu-btn .hk {
  position: absolute; right: 12px; top: 50%;
  transform: translateY(-50%);
  font-size: 9px; letter-spacing: 0.22em;
  color: rgba(207,233,255,0.4);
}

/* --- Build watermark + version ----------------------------------- */
.omega-title .watermark {
  position: absolute; bottom: 16px; left: 18px;
  font-family: ui-monospace, monospace;
  font-size: 9px; letter-spacing: 0.3em;
  color: rgba(207,233,255,0.32);
  text-transform: uppercase;
  pointer-events: none;
}
.omega-title .copyright {
  position: absolute; bottom: 16px; right: 18px;
  font-family: ui-monospace, monospace;
  font-size: 9px; letter-spacing: 0.3em;
  color: rgba(207,233,255,0.28);
  text-transform: uppercase;
  pointer-events: none;
}

/* Initial fade-in cascade */
.omega-title .logo-wrap,
.omega-title .menu,
.omega-title .watermark,
.omega-title .copyright {
  opacity: 0;
  transform: translateY(10px);
  transition: opacity 600ms ease, transform 600ms ease;
}
.omega-screen.visible.omega-title .logo-wrap { opacity: 1; transform: none; transition-delay: 120ms; }
.omega-screen.visible.omega-title .menu { opacity: 1; transform: none; transition-delay: 360ms; }
.omega-screen.visible.omega-title .watermark,
.omega-screen.visible.omega-title .copyright { opacity: 1; transform: none; transition-delay: 720ms; }

@media (max-width: 720px) {
  .omega-title .menu { min-width: 220px; }
  .omega-title .horizon { width: 28vmin; }
}
`;

function injectStyle() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = TITLE_CSS;
  document.head.appendChild(s);
}

// Deterministic PRNG so motes look identical each visit (avoids re-layout flicker).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DISK_SVG = `
<svg viewBox="-100 -100 200 200" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="omegaDiskGrad" cx="50%" cy="50%" r="50%">
      <stop offset="0%"  stop-color="rgba(0,0,0,0)"/>
      <stop offset="20%" stop-color="rgba(0,0,0,0)"/>
      <stop offset="34%" stop-color="rgba(255,200,120,0.0)"/>
      <stop offset="42%" stop-color="rgba(255,170,80,0.85)"/>
      <stop offset="55%" stop-color="rgba(255,90,200,0.45)"/>
      <stop offset="72%" stop-color="rgba(100,80,255,0.35)"/>
      <stop offset="100%" stop-color="rgba(20,20,80,0)"/>
    </radialGradient>
    <filter id="omegaDiskBlur"><feGaussianBlur stdDeviation="1.2"/></filter>
  </defs>
  <ellipse cx="0" cy="0" rx="92" ry="22" fill="url(#omegaDiskGrad)" filter="url(#omegaDiskBlur)"/>
  <ellipse cx="0" cy="0" rx="92" ry="22" fill="none"
           stroke="rgba(255,210,150,0.18)" stroke-width="0.4"/>
  <ellipse cx="0" cy="0" rx="76" ry="18" fill="none"
           stroke="rgba(255,170,100,0.22)" stroke-width="0.3"/>
  <ellipse cx="0" cy="0" rx="58" ry="13.5" fill="none"
           stroke="rgba(180,140,255,0.25)" stroke-width="0.3"/>
</svg>`;

// ---------------------------------------------------------------------------
// TitleScreen
// ---------------------------------------------------------------------------

export class TitleScreen extends BaseScreen {
  build() {
    injectStyle();
    this.root.classList.add('omega-title');

    const stage = document.createElement('div');
    stage.className = 'stage';

    // ---- Layered rotating accretion disks ----
    for (const cls of ['', 'r2', 'r3']) {
      const d = document.createElement('div');
      d.className = `disk ${cls}`.trim();
      d.innerHTML = DISK_SVG;
      stage.appendChild(d);
    }

    // ---- Event horizon ----
    const horizon = document.createElement('div');
    horizon.className = 'horizon';
    stage.appendChild(horizon);

    // ---- Particle motes (CSS-animated, no RAF) ----
    const motes = document.createElement('div');
    motes.className = 'motes';
    const rng = mulberry32(0xC0FFEE);
    const N = 64;
    for (let i = 0; i < N; i++) {
      const m = document.createElement('div');
      m.className = 'mote';
      const x = rng() * 100;
      const y = rng() * 100;
      const dx = (rng() - 0.5) * 280;
      const dy = (rng() - 0.5) * 280 - 40;
      const dur = 8 + rng() * 14;
      const delay = -rng() * dur; // staggered already-running
      const size = 1 + rng() * 2.2;
      const hueRoll = rng();
      const color = hueRoll < 0.6
        ? '#cfe9ff'
        : (hueRoll < 0.85 ? '#ffd089' : '#b58cff');
      m.style.left = `${x}%`;
      m.style.top = `${y}%`;
      m.style.width = `${size}px`;
      m.style.height = `${size}px`;
      m.style.background = color;
      m.style.setProperty('--dx', `${dx}px`);
      m.style.setProperty('--dy', `${dy}px`);
      m.style.animationDuration = `${dur}s`;
      m.style.animationDelay = `${delay}s`;
      motes.appendChild(m);
    }
    stage.appendChild(motes);

    // ---- Logo ----
    const logoWrap = document.createElement('div');
    logoWrap.className = 'logo-wrap';
    const l1 = document.createElement('h1');
    l1.className = 'logo-line1';
    l1.textContent = 'VOID  SINGULARITY';
    const l2 = document.createElement('h2');
    l2.className = 'logo-line2';
    l2.textContent = 'OMEGA';
    const tag = document.createElement('div');
    tag.className = 'tagline';
    tag.textContent = '// Cross the Event Horizon //';
    logoWrap.appendChild(l1);
    logoWrap.appendChild(l2);
    logoWrap.appendChild(tag);
    stage.appendChild(logoWrap);

    // ---- Menu ----
    const menu = document.createElement('div');
    menu.className = 'menu';

    const hasSave = !!this.data.hasSave;
    const items = [
      { id: 'newrun',   label: 'New Run',  hk: 'ENTER', primary: true,  event: 'title:newrun' },
      { id: 'continue', label: 'Continue', hk: 'C',     disabled: !hasSave, event: 'title:continue' },
      { id: 'meta',     label: 'Meta',     hk: 'M',     event: 'title:meta' },
      { id: 'options',  label: 'Settings', hk: 'O',     event: 'title:options' },
      { id: 'credits',  label: 'Credits',  hk: 'R',     event: 'title:credits' },
    ];

    const btnEls = items.map((it) => {
      const b = document.createElement('button');
      b.className = 'menu-btn';
      if (it.primary) b.classList.add('primary');
      if (it.disabled) b.classList.add('disabled');
      b.type = 'button';
      b.innerHTML = `<span>${it.label}</span><span class="hk">${it.hk}</span>`;
      b.addEventListener('click', () => this._activate(it));
      b.addEventListener('mouseenter', () => {
        const idx = btnEls.indexOf(b);
        if (idx >= 0) { this._focusIndex = idx; this._renderFocus(); }
      });
      menu.appendChild(b);
      return b;
    });

    // Watermark / copyright
    const wm = document.createElement('div');
    wm.className = 'watermark';
    wm.textContent = `// OMEGA · BUILD ${this.data.buildTag || 'SPRINT-09'}`;
    const cp = document.createElement('div');
    cp.className = 'copyright';
    cp.textContent = '// EVENT HORIZON STUDIOS';

    this.root.appendChild(stage);
    stage.appendChild(menu);
    this.root.appendChild(wm);
    this.root.appendChild(cp);

    this._items = items;
    this._btnEls = btnEls;
    // Focus first non-disabled item.
    const firstFocusable = items.findIndex((it) => !it.disabled);
    this.setFocusables(btnEls);
    if (firstFocusable >= 0) {
      this._focusIndex = firstFocusable;
      this._renderFocus();
    }
  }

  _activate(it) {
    if (it.disabled) return;
    this.bus?.emit(it.event, { id: it.id });
    // 'newrun' implies the host wants to hand off to the run state machine —
    // the host listens and decides whether to hide this screen. Default fallback:
    if (it.id === 'newrun') this.manager.hideScreen();
  }

  _moveFocusSkipDisabled(delta) {
    if (!this._items?.length) return;
    const n = this._items.length;
    let i = this._focusIndex;
    for (let step = 0; step < n; step++) {
      i = ((i + delta) % n + n) % n;
      if (!this._items[i].disabled) {
        this._focusIndex = i;
        this._renderFocus();
        return;
      }
    }
  }

  _onKey(e) {
    if (e.code === 'ArrowDown' || e.code === 'Tab') {
      e.preventDefault();
      this._moveFocusSkipDisabled(+1);
    } else if (e.code === 'ArrowUp') {
      e.preventDefault();
      this._moveFocusSkipDisabled(-1);
    } else if (e.code === 'Enter' || e.code === 'Space') {
      e.preventDefault();
      const it = this._items[this._focusIndex];
      if (it) this._activate(it);
    } else if (e.code === 'KeyC' && this._items[1] && !this._items[1].disabled) {
      e.preventDefault(); this._activate(this._items[1]);
    } else if (e.code === 'KeyM') {
      e.preventDefault(); this._activate(this._items[2]);
    } else if (e.code === 'KeyO') {
      e.preventDefault(); this._activate(this._items[3]);
    } else if (e.code === 'KeyR') {
      e.preventDefault(); this._activate(this._items[4]);
    }
  }
}

export default TitleScreen;
