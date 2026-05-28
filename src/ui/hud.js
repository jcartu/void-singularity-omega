// HUD — minimal in-run overlay (WO-03-U1).
//
// Renders:
//   - Vitals top-left:    HP bar + numeric, EN bar + numeric, shield indicator.
//   - Weapon row bot-left: per-weapon cooldown slot with name, fill, active glow.
//   - Combo center-bottom: large combo count, multiplier badge, decay bar.
//   - Contract banner top-center: name + progress (shown only when active).
//   - Damage numbers:     floating 2D pop-ups over enemy hits (bus-driven).
//   - Debug overlay top-right (F3): FPS/ms/draws/triangles/entities/combo/run.
//
// No internal game state — pure projection of world / profiler / combo /
// run / contract snapshots. Created lazily so the boot screen stays clean.

import { Vector3 } from 'three';

const STYLE_ID = 'omega-hud-style';
const HUD_CSS = `
#omega-hud, #omega-hud-debug, #omega-hud-vitals, #omega-hud-combo,
#omega-hud-contract, #omega-hud-dmg {
  position: fixed; z-index: 50; pointer-events: none;
  font-family: ui-monospace, "JetBrains Mono", "Courier New", monospace;
  color: #cfe9ff; letter-spacing: 0.18em; text-transform: uppercase;
  user-select: none;
}

/* --- Weapon row ---------------------------------------------------- */
#omega-hud { left: 16px; bottom: 16px; display: flex; gap: 10px; align-items: flex-end; }
#omega-hud .slot {
  min-width: 132px; padding: 8px 10px; position: relative;
  background: rgba(6, 12, 28, 0.72);
  border: 1px solid rgba(120, 200, 255, 0.18);
  border-radius: 6px;
  backdrop-filter: blur(4px);
  transition: border-color .15s ease, transform .15s ease, box-shadow .15s ease;
}
#omega-hud .slot .key {
  position: absolute; top: 4px; right: 6px; font-size: 9px; opacity: 0.45;
}
#omega-hud .slot.active {
  border-color: rgba(180, 240, 255, 0.85);
  box-shadow: 0 0 18px rgba(120, 200, 255, 0.35);
  transform: translateY(-2px);
}
#omega-hud .slot.secondary { opacity: 0.78; }
#omega-hud .name { font-size: 10px; opacity: 0.85; }
#omega-hud .bar {
  margin-top: 6px; height: 4px; width: 100%;
  background: rgba(255, 255, 255, 0.08); border-radius: 2px; overflow: hidden;
}
#omega-hud .fill {
  height: 100%; width: 0%;
  background: linear-gradient(90deg, #6ad8ff, #ff5cf2);
  transition: width 60ms linear;
}
#omega-hud .slot.ready .fill { width: 100% !important; opacity: 0.95; }
#omega-hud .slot.cooling .fill { opacity: 0.65; }

/* --- Vitals -------------------------------------------------------- */
#omega-hud-vitals {
  left: 16px; top: 16px; min-width: 240px;
  padding: 10px 12px;
  background: rgba(6, 12, 28, 0.72);
  border: 1px solid rgba(120, 200, 255, 0.18);
  border-radius: 6px;
  backdrop-filter: blur(4px);
}
#omega-hud-vitals .row { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
#omega-hud-vitals .row:first-child { margin-top: 0; }
#omega-hud-vitals .label { font-size: 10px; opacity: 0.85; width: 48px; }
#omega-hud-vitals .vbar {
  flex: 1; height: 6px;
  background: rgba(255,255,255,0.08); border-radius: 3px; overflow: hidden;
  position: relative;
}
#omega-hud-vitals .vfill { height: 100%; width: 100%; transition: width 80ms linear; }
#omega-hud-vitals .vfill.hp { background: linear-gradient(90deg, #ff5c7a, #ffb86a); }
#omega-hud-vitals .vfill.en { background: linear-gradient(90deg, #6ad8ff, #b58cff); }
#omega-hud-vitals .vnum { font-size: 10px; opacity: 0.85; width: 64px; text-align: right; }
#omega-hud-vitals .shield {
  margin-top: 6px; font-size: 10px; letter-spacing: 0.2em;
  color: #8be7ff; opacity: 0; transition: opacity .25s ease;
}
#omega-hud-vitals .shield.on { opacity: 1; text-shadow: 0 0 8px rgba(120,200,255,0.7); }

/* --- Combo / Multiplier ------------------------------------------- */
#omega-hud-combo {
  left: 50%; bottom: 24px; transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  min-width: 180px;
  opacity: 0; transition: opacity .25s ease;
}
#omega-hud-combo.on { opacity: 1; }
#omega-hud-combo .row { display: flex; align-items: baseline; gap: 12px; }
#omega-hud-combo .count {
  font-size: 42px; letter-spacing: 0.06em; font-weight: 700;
  color: #ffffff;
  text-shadow: 0 0 14px rgba(120, 200, 255, 0.55), 0 0 28px rgba(255, 92, 242, 0.35);
  transform-origin: 50% 60%;
  transition: transform .12s ease-out, color .25s ease, text-shadow .25s ease;
}
#omega-hud-combo .count.pulse { animation: omega-combo-pulse 220ms ease-out; }
@keyframes omega-combo-pulse {
  0%   { transform: scale(1.0); }
  50%  { transform: scale(1.22); }
  100% { transform: scale(1.0); }
}
#omega-hud-combo .mult {
  font-size: 22px; letter-spacing: 0.08em; font-weight: 700;
  padding: 2px 10px; border-radius: 4px;
  background: rgba(255, 92, 242, 0.18);
  border: 1px solid rgba(255, 92, 242, 0.55);
  color: #ffdcff;
  text-shadow: 0 0 10px rgba(255, 92, 242, 0.6);
  transition: background .2s ease, border-color .2s ease, transform .15s ease;
}
#omega-hud-combo .mult.up { animation: omega-mult-up 360ms ease-out; }
@keyframes omega-mult-up {
  0%   { transform: scale(1.0); filter: brightness(1.0); }
  40%  { transform: scale(1.35); filter: brightness(1.6); }
  100% { transform: scale(1.0); filter: brightness(1.0); }
}
#omega-hud-combo .label {
  font-size: 9px; opacity: 0.55; letter-spacing: 0.32em;
}
#omega-hud-combo .decay {
  width: 160px; height: 3px; border-radius: 2px;
  background: rgba(255,255,255,0.08); overflow: hidden; margin-top: 2px;
}
#omega-hud-combo .decay-fill {
  height: 100%; width: 100%;
  background: linear-gradient(90deg, #ff5cf2, #6ad8ff);
  transition: width 80ms linear;
}

/* --- Contract banner ---------------------------------------------- */
#omega-hud-contract {
  left: 50%; top: 18px; transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  padding: 8px 18px; min-width: 220px;
  background: rgba(8, 4, 22, 0.72);
  border: 1px solid rgba(255, 92, 242, 0.35);
  border-radius: 6px;
  backdrop-filter: blur(4px);
  box-shadow: 0 0 22px rgba(255, 92, 242, 0.18);
  opacity: 0; transition: opacity .3s ease;
}
#omega-hud-contract.on { opacity: 1; }
#omega-hud-contract .ctitle {
  font-size: 10px; opacity: 0.65; letter-spacing: 0.32em;
}
#omega-hud-contract .cname {
  font-size: 14px; color: #ffd6ff; letter-spacing: 0.22em;
  text-shadow: 0 0 10px rgba(255, 92, 242, 0.55);
}
#omega-hud-contract .cbar {
  margin-top: 4px; width: 220px; height: 4px;
  background: rgba(255,255,255,0.08); border-radius: 2px; overflow: hidden;
}
#omega-hud-contract .cfill {
  height: 100%; width: 0%;
  background: linear-gradient(90deg, #ff5cf2, #b58cff);
  transition: width 200ms ease;
}

/* --- Debug overlay ------------------------------------------------ */
#omega-hud-debug {
  right: 16px; top: 16px; min-width: 240px;
  padding: 10px 12px;
  background: rgba(6, 12, 28, 0.72);
  border: 1px solid rgba(120, 200, 255, 0.18);
  border-radius: 6px;
  backdrop-filter: blur(4px);
  font-size: 10px;
  text-transform: none; letter-spacing: 0.06em;
  line-height: 1.6;
}
#omega-hud-debug .k { opacity: 0.65; display: inline-block; min-width: 92px; }
#omega-hud-debug .v { color: #e8f6ff; }
#omega-hud-debug.hidden { display: none; }

/* --- Damage numbers ----------------------------------------------- */
#omega-hud-dmg { inset: 0; overflow: hidden; }
#omega-hud-dmg .dn {
  position: absolute; transform: translate(-50%, -50%);
  font-size: 14px; font-weight: 700; letter-spacing: 0.05em;
  color: #ffe8a0; text-shadow: 0 0 6px rgba(255, 184, 80, 0.7);
  animation: omega-dn-rise 700ms ease-out forwards;
  will-change: transform, opacity;
}
#omega-hud-dmg .dn.crit { color: #ff8ad0; text-shadow: 0 0 10px rgba(255, 92, 242, 0.85); font-size: 18px; }
@keyframes omega-dn-rise {
  0%   { opacity: 0; transform: translate(-50%, -30%) scale(0.7); }
  15%  { opacity: 1; transform: translate(-50%, -55%) scale(1.0); }
  100% { opacity: 0; transform: translate(-50%, -130%) scale(0.95); }
}
`;

// Reused scratch — avoid allocation in damage-number hot path.
const TMP_PROJ = new Vector3();

export class HUD {
  /**
   * @param {{
   *   weapons: { getCooldownState(): Array<{id:string,name:string,remaining:number,ratio:number,active:boolean}> },
   *   ship?:   { health:number, energy:number, opts:{maxHealth:number,maxEnergy:number}, isInvincible?:boolean },
   *   ecs?:    { entities: Set<number> | { size:number } },
   *   projectilePool?: { alive: Uint8Array, capacity:number },
   *   gravity?: { position:{x:number,y:number,z:number}, mass:number },
   *   profiler?: { snapshot: any },
   *   combo?:  { getCombo():number, getMultiplier():number, getDecayRatio():number, getDecayTime():number },
   *   contract?: { name:string, progress:number, max:number } | (() => { name:string, progress:number, max:number } | null),
   *   run?:    { state:string } | (() => string),
   *   bus?:    { on(name:string, cb:Function): Function } | null,
   *   camera?: any, // THREE.Camera — required to render damage numbers
   *   mount?:  HTMLElement,
   *   showDebug?: boolean,
   *   weaponKeys?: Record<string,string>, // weapon id -> key label
   * }} opts
   */
  constructor({
    weapons,
    ship = null,
    ecs = null,
    projectilePool = null,
    gravity = null,
    profiler = null,
    combo = null,
    contract = null,
    run = null,
    bus = null,
    camera = null,
    mount = document.body,
    showDebug = true,
    weaponKeys = { plasma: '1', rail: '2' },
  } = {}) {
    this.weapons = weapons;
    this.ship = ship;
    this.ecs = ecs;
    this.projectilePool = projectilePool;
    this.gravity = gravity;
    this.profiler = profiler;
    this.combo = combo;
    this.contract = contract;
    this.run = run;
    this.bus = bus;
    this.camera = camera;
    this._mount = mount;
    this._slots = new Map();
    this._debugVisible = !!showDebug;
    this._frameCounter = 0;
    this._weaponKeys = weaponKeys;
    this._lastCombo = 0;
    this._lastMult = 1;
    this._dmgUnsub = null;

    this._injectStyle();
    this._build();
    this._bindKeys();
    this._bindEvents();
  }

  _injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = HUD_CSS;
    document.head.appendChild(s);
  }

  _build() {
    // Weapon row.
    this.root = document.createElement('div');
    this.root.id = 'omega-hud';
    this._mount.appendChild(this.root);
    const state = this.weapons.getCooldownState();
    for (const w of state) {
      const slot = document.createElement('div');
      slot.className = 'slot';
      const key = this._weaponKeys[w.id] || '';
      slot.innerHTML = `
        ${key ? `<div class="key">${key}</div>` : ''}
        <div class="name">${w.name}</div>
        <div class="bar"><div class="fill"></div></div>
      `;
      this.root.appendChild(slot);
      this._slots.set(w.id, { root: slot, fill: slot.querySelector('.fill') });
    }

    // Vitals (HP / EN / shield).
    if (this.ship) {
      this.vitals = document.createElement('div');
      this.vitals.id = 'omega-hud-vitals';
      this.vitals.innerHTML = `
        <div class="row">
          <div class="label">HP</div>
          <div class="vbar"><div class="vfill hp"></div></div>
          <div class="vnum hp-num">0 / 0</div>
        </div>
        <div class="row">
          <div class="label">EN</div>
          <div class="vbar"><div class="vfill en"></div></div>
          <div class="vnum en-num">0 / 0</div>
        </div>
        <div class="shield">&#9650; SHIELD ACTIVE</div>
      `;
      this._mount.appendChild(this.vitals);
      this._hpFill = this.vitals.querySelector('.vfill.hp');
      this._enFill = this.vitals.querySelector('.vfill.en');
      this._hpNum = this.vitals.querySelector('.hp-num');
      this._enNum = this.vitals.querySelector('.en-num');
      this._shield = this.vitals.querySelector('.shield');
    }

    // Combo / multiplier (center-bottom).
    this.comboEl = document.createElement('div');
    this.comboEl.id = 'omega-hud-combo';
    this.comboEl.innerHTML = `
      <div class="row">
        <div class="count">0</div>
        <div class="mult">1x</div>
      </div>
      <div class="label">COMBO</div>
      <div class="decay"><div class="decay-fill"></div></div>
    `;
    this._mount.appendChild(this.comboEl);
    this._comboCount = this.comboEl.querySelector('.count');
    this._comboMult = this.comboEl.querySelector('.mult');
    this._comboDecay = this.comboEl.querySelector('.decay-fill');

    // Contract banner (top-center).
    this.contractEl = document.createElement('div');
    this.contractEl.id = 'omega-hud-contract';
    this.contractEl.innerHTML = `
      <div class="ctitle">CONTRACT</div>
      <div class="cname">—</div>
      <div class="cbar"><div class="cfill"></div></div>
    `;
    this._mount.appendChild(this.contractEl);
    this._contractName = this.contractEl.querySelector('.cname');
    this._contractFill = this.contractEl.querySelector('.cfill');

    // Damage numbers layer.
    this.dmgLayer = document.createElement('div');
    this.dmgLayer.id = 'omega-hud-dmg';
    this._mount.appendChild(this.dmgLayer);

    // Debug overlay.
    this.debug = document.createElement('div');
    this.debug.id = 'omega-hud-debug';
    if (!this._debugVisible) this.debug.classList.add('hidden');
    this.debug.innerHTML = `
      <div><span class="k">FPS</span><span class="v" data-k="fps">—</span></div>
      <div><span class="k">Frame ms</span><span class="v" data-k="frameMs">—</span></div>
      <div><span class="k">Draw calls</span><span class="v" data-k="draw">—</span></div>
      <div><span class="k">Triangles</span><span class="v" data-k="tris">—</span></div>
      <div><span class="k">Entities</span><span class="v" data-k="ents">—</span></div>
      <div><span class="k">Projectiles</span><span class="v" data-k="proj">—</span></div>
      <div><span class="k">Well pos</span><span class="v" data-k="gpos">—</span></div>
      <div><span class="k">Well mass</span><span class="v" data-k="gmass">—</span></div>
      <div><span class="k">Weapon</span><span class="v" data-k="wpn">—</span></div>
      <div><span class="k">Combo</span><span class="v" data-k="combo">—</span></div>
      <div><span class="k">Multiplier</span><span class="v" data-k="mult">—</span></div>
      <div><span class="k">Run</span><span class="v" data-k="run">—</span></div>
    `;
    this._mount.appendChild(this.debug);
    this._dbg = {};
    this.debug.querySelectorAll('[data-k]').forEach((el) => {
      this._dbg[el.getAttribute('data-k')] = el;
    });
  }

  _bindKeys() {
    this._onKey = (e) => {
      if (e.code === 'F3') {
        e.preventDefault();
        this.toggleDebug();
      }
    };
    window.addEventListener('keydown', this._onKey);
  }

  _bindEvents() {
    if (!this.bus || typeof this.bus.on !== 'function') return;
    // Damage numbers from 'enemy:hit'. World position projects via camera.
    this._dmgUnsub = this.bus.on('enemy:hit', (ev) => {
      if (!ev || !this.camera) return;
      this.spawnDamageNumber(ev.x ?? 0, ev.z ?? 0, ev.damage ?? 0, !!ev.crit);
    });
  }

  toggleDebug(force) {
    this._debugVisible = typeof force === 'boolean' ? force : !this._debugVisible;
    this.debug.classList.toggle('hidden', !this._debugVisible);
  }

  /** Project a world XZ position (Y=0 plane) to screen and pop a damage number. */
  spawnDamageNumber(worldX, worldZ, amount, crit = false) {
    if (!this.camera) return;
    TMP_PROJ.set(worldX, 0, worldZ).project(this.camera);
    // Behind camera or off-screen — skip.
    if (TMP_PROJ.z > 1 || TMP_PROJ.z < -1) return;
    const w = window.innerWidth, h = window.innerHeight;
    const sx = (TMP_PROJ.x * 0.5 + 0.5) * w;
    const sy = (-TMP_PROJ.y * 0.5 + 0.5) * h;
    const el = document.createElement('div');
    el.className = crit ? 'dn crit' : 'dn';
    el.style.left = `${sx}px`;
    el.style.top = `${sy}px`;
    el.textContent = String(Math.round(amount));
    this.dmgLayer.appendChild(el);
    // Auto-remove after animation completes.
    setTimeout(() => el.remove(), 750);
  }

  update() {
    this._frameCounter++;

    // Weapons (every frame).
    const state = this.weapons.getCooldownState();
    let activeName = '—';
    for (const w of state) {
      const slot = this._slots.get(w.id);
      if (slot) {
        slot.root.classList.toggle('active', w.active);
        slot.root.classList.toggle('secondary', !w.active);
        const ready = w.remaining <= 0;
        slot.root.classList.toggle('ready', ready);
        slot.root.classList.toggle('cooling', !ready);
        slot.fill.style.width = `${Math.max(0, Math.min(1, w.ratio)) * 100}%`;
      }
      if (w.active) activeName = w.name;
    }

    // Vitals.
    if (this.ship && this._hpFill) {
      const maxH = this.ship.opts?.maxHealth ?? 100;
      const maxE = this.ship.opts?.maxEnergy ?? 100;
      const h = Math.max(0, this.ship.health);
      const en = Math.max(0, this.ship.energy);
      this._hpFill.style.width = `${(h / maxH) * 100}%`;
      this._enFill.style.width = `${(en / maxE) * 100}%`;
      this._hpNum.textContent = `${Math.round(h)} / ${maxH}`;
      this._enNum.textContent = `${Math.round(en)} / ${maxE}`;
      const shielded = !!this.ship.isInvincible;
      this._shield.classList.toggle('on', shielded);
    }

    // Combo display.
    if (this.combo) {
      const c = this.combo.getCombo();
      const m = this.combo.getMultiplier();
      const decay = this.combo.getDecayRatio();
      if (c > 0) this.comboEl.classList.add('on'); else this.comboEl.classList.remove('on');

      if (c !== this._lastCombo) {
        this._comboCount.textContent = String(c);
        if (c > this._lastCombo) {
          // Re-trigger pulse animation.
          this._comboCount.classList.remove('pulse');
          // Force reflow so CSS animation restarts.
          // eslint-disable-next-line no-unused-expressions
          void this._comboCount.offsetWidth;
          this._comboCount.classList.add('pulse');
          // Scale text size subtly with combo magnitude.
          const scale = 1 + Math.min(0.6, c / 200);
          this._comboCount.style.fontSize = `${42 * scale}px`;
        } else if (c === 0) {
          this._comboCount.style.fontSize = '';
        }
        this._lastCombo = c;
      }
      if (m !== this._lastMult) {
        this._comboMult.textContent = `${m}x`;
        if (m > this._lastMult) {
          this._comboMult.classList.remove('up');
          // eslint-disable-next-line no-unused-expressions
          void this._comboMult.offsetWidth;
          this._comboMult.classList.add('up');
        }
        this._lastMult = m;
      }
      this._comboDecay.style.width = `${decay * 100}%`;
    }

    // Contract banner.
    if (this.contract) {
      const c = typeof this.contract === 'function' ? this.contract() : this.contract;
      if (c && c.name) {
        this.contractEl.classList.add('on');
        this._contractName.textContent = c.name;
        const ratio = c.max > 0 ? Math.max(0, Math.min(1, c.progress / c.max)) : 0;
        this._contractFill.style.width = `${ratio * 100}%`;
      } else {
        this.contractEl.classList.remove('on');
      }
    }

    // Debug overlay — throttle to every ~6 frames (~10 Hz @ 60fps).
    if (this._debugVisible && (this._frameCounter % 6) === 0) {
      this._updateDebug(activeName);
    }
  }

  _updateDebug(activeName) {
    const d = this._dbg;
    const s = this.profiler?.snapshot;
    if (s) {
      d.fps.textContent = s.fps ? s.fps.toFixed(1) : '—';
      d.frameMs.textContent = s.frameMs ? s.frameMs.toFixed(2) : '—';
      d.draw.textContent = s.drawCalls ?? '—';
      d.tris.textContent = s.triangles ? s.triangles.toLocaleString() : '—';
    }
    if (this.ecs) {
      const sz = this.ecs.entities?.size ?? 0;
      d.ents.textContent = String(sz);
    }
    if (this.projectilePool) {
      let live = 0;
      const a = this.projectilePool.alive;
      for (let i = 0; i < a.length; i++) live += a[i];
      d.proj.textContent = `${live} / ${this.projectilePool.capacity}`;
    }
    if (this.gravity) {
      const p = this.gravity.position;
      d.gpos.textContent = `${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`;
      d.gmass.textContent = String(this.gravity.mass);
    }
    d.wpn.textContent = activeName;
    if (this.combo) {
      d.combo.textContent = String(this.combo.getCombo());
      d.mult.textContent = `${this.combo.getMultiplier()}x`;
    }
    if (this.run) {
      const r = typeof this.run === 'function' ? this.run() : this.run.state;
      d.run.textContent = r ?? '—';
    }
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey);
    if (this._dmgUnsub) { try { this._dmgUnsub(); } catch { /* noop */ } }
    this.root?.remove();
    this.vitals?.remove();
    this.comboEl?.remove();
    this.contractEl?.remove();
    this.dmgLayer?.remove();
    this.debug?.remove();
  }
}
