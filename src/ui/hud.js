// HUD — minimal in-run overlay (WO-02-U1).
// Renders:
//   - Health + Energy bars (read from ship)
//   - Weapon cooldown slots (read from WeaponSystem.getCooldownState())
//   - Debug overlay: FPS, frame ms, draw calls, entity count, projectile count,
//     gravity well state (position + mass).
// No internal game state — pure projection of world/profiler snapshots. Created
// lazily so the boot screen stays clean. Toggle debug overlay with F3.

const STYLE_ID = 'omega-hud-style';
const HUD_CSS = `
#omega-hud, #omega-hud-debug, #omega-hud-vitals {
  position: fixed; z-index: 50; pointer-events: none;
  font-family: ui-monospace, "JetBrains Mono", "Courier New", monospace;
  color: #cfe9ff; letter-spacing: 0.18em; text-transform: uppercase;
  user-select: none;
}
#omega-hud { left: 16px; bottom: 16px; display: flex; gap: 10px; }
#omega-hud .slot {
  min-width: 132px; padding: 8px 10px;
  background: rgba(6, 12, 28, 0.72);
  border: 1px solid rgba(120, 200, 255, 0.18);
  border-radius: 6px;
  backdrop-filter: blur(4px);
  transition: border-color .15s ease, transform .15s ease;
}
#omega-hud .slot.active {
  border-color: rgba(180, 240, 255, 0.85);
  box-shadow: 0 0 18px rgba(120, 200, 255, 0.35);
  transform: translateY(-2px);
}
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

#omega-hud-vitals {
  left: 16px; top: 16px; min-width: 220px;
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
}
#omega-hud-vitals .vfill { height: 100%; width: 100%; transition: width 80ms linear; }
#omega-hud-vitals .vfill.hp { background: linear-gradient(90deg, #ff5c7a, #ffb86a); }
#omega-hud-vitals .vfill.en { background: linear-gradient(90deg, #6ad8ff, #b58cff); }
#omega-hud-vitals .vnum { font-size: 10px; opacity: 0.85; width: 56px; text-align: right; }

#omega-hud-debug {
  right: 16px; top: 16px; min-width: 220px;
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
`;

export class HUD {
  /**
   * @param {{
   *   weapons: { getCooldownState(): Array<{id:string,name:string,remaining:number,ratio:number,active:boolean}> },
   *   ship?: { health:number, energy:number, opts:{maxHealth:number,maxEnergy:number} },
   *   ecs?: { entities: Set<number> | { size:number } },
   *   projectilePool?: { alive: Uint8Array, capacity:number },
   *   gravity?: { position:{x:number,y:number,z:number}, mass:number },
   *   profiler?: { snapshot: any },
   *   mount?: HTMLElement,
   *   showDebug?: boolean,
   * }} opts
   */
  constructor({
    weapons,
    ship = null,
    ecs = null,
    projectilePool = null,
    gravity = null,
    profiler = null,
    mount = document.body,
    showDebug = true,
  } = {}) {
    this.weapons = weapons;
    this.ship = ship;
    this.ecs = ecs;
    this.projectilePool = projectilePool;
    this.gravity = gravity;
    this.profiler = profiler;
    this._mount = mount;
    this._slots = new Map();
    this._debugVisible = !!showDebug;
    this._frameCounter = 0;

    this._injectStyle();
    this._build();
    this._bindKeys();
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
      slot.innerHTML = `
        <div class="name">${w.name}</div>
        <div class="bar"><div class="fill"></div></div>
      `;
      this.root.appendChild(slot);
      this._slots.set(w.id, { root: slot, fill: slot.querySelector('.fill') });
    }

    // Vitals (HP / EN).
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
      `;
      this._mount.appendChild(this.vitals);
      this._hpFill = this.vitals.querySelector('.vfill.hp');
      this._enFill = this.vitals.querySelector('.vfill.en');
      this._hpNum = this.vitals.querySelector('.hp-num');
      this._enNum = this.vitals.querySelector('.en-num');
    }

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

  toggleDebug(force) {
    this._debugVisible = typeof force === 'boolean' ? force : !this._debugVisible;
    this.debug.classList.toggle('hidden', !this._debugVisible);
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
        const ready = w.remaining <= 0;
        slot.root.classList.toggle('ready', ready);
        slot.root.classList.toggle('cooling', !ready);
        slot.fill.style.width = `${Math.max(0, Math.min(1, w.ratio)) * 100}%`;
      }
      if (w.active) activeName = w.name;
    }

    // Vitals (every frame — cheap).
    if (this.ship && this._hpFill) {
      const maxH = this.ship.opts?.maxHealth ?? 100;
      const maxE = this.ship.opts?.maxEnergy ?? 100;
      const h = Math.max(0, this.ship.health);
      const en = Math.max(0, this.ship.energy);
      this._hpFill.style.width = `${(h / maxH) * 100}%`;
      this._enFill.style.width = `${(en / maxE) * 100}%`;
      this._hpNum.textContent = `${Math.round(h)} / ${maxH}`;
      this._enNum.textContent = `${Math.round(en)} / ${maxE}`;
    }

    // Debug overlay — throttle to every ~6 frames (~10 Hz @ 60fps) to keep DOM cheap.
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
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey);
    this.root?.remove();
    this.vitals?.remove();
    this.debug?.remove();
  }
}
