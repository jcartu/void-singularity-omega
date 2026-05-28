// HUD — DOM overlay for weapon cooldowns. Created lazily so the boot screen stays clean.
// Reads from WeaponSystem.getCooldownState() each frame; no internal state besides DOM nodes.

const STYLE_ID = 'omega-hud-style';
const HUD_CSS = `
#omega-hud {
  position: fixed; left: 16px; bottom: 16px; z-index: 50;
  display: flex; gap: 10px; pointer-events: none;
  font-family: ui-monospace, "JetBrains Mono", "Courier New", monospace;
  color: #cfe9ff; letter-spacing: 0.18em; text-transform: uppercase;
  user-select: none;
}
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
`;

export class HUD {
  constructor({ weapons, mount = document.body } = {}) {
    this.weapons = weapons;
    this._mount = mount;
    this._slots = new Map();
    this._injectStyle();
    this.root = document.createElement('div');
    this.root.id = 'omega-hud';
    mount.appendChild(this.root);
    this._build();
  }

  _injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = HUD_CSS;
    document.head.appendChild(s);
  }

  _build() {
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
  }

  update() {
    const state = this.weapons.getCooldownState();
    for (const w of state) {
      const slot = this._slots.get(w.id);
      if (!slot) continue;
      slot.root.classList.toggle('active', w.active);
      const ready = w.remaining <= 0;
      slot.root.classList.toggle('ready', ready);
      slot.root.classList.toggle('cooling', !ready);
      slot.fill.style.width = `${Math.max(0, Math.min(1, w.ratio)) * 100}%`;
    }
  }

  dispose() {
    this.root.remove();
  }
}
