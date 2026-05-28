// UI Screens — between-action overlay surfaces (WO-03-U1/U2/U3/U4).
//
// Provides four navigable, mouse + keyboard driven screens layered above the
// running Three.js stage:
//   - UpgradeChoiceScreen : 3 cards, click/1-3/Enter to pick, Escape to skip.
//   - ShopScreen          : grid of items, Tab/arrows nav, Enter to buy, Esc to leave.
//   - ShipSelectScreen    : pick a hull pre-run; arrows browse, Enter confirms.
//   - RunSummaryScreen    : end-of-run stats with count-up animation.
//
// All screens are pure DOM overlays. They never touch Three.js directly. The
// ScreenManager owns the mount element and emits lifecycle events on the
// caller-supplied EventBus so the run state machine can pause game time while
// any screen is active.
//
// Events:
//   'screen:show'       { type, data }
//   'screen:hide'       { type }
//   'upgrade:selected'  { id, def, skipped: boolean }
//   'shop:purchased'    { itemId, item, price }  (forwarded from Shop)
//   'shop:left'         { spent }
//   'ship:selected'     { id, def }
//   'run:new'           {}
//   'run:menu'          {}
//
// MUST NOT depend on audio (S05), particles (S04), or run/state machine code
// — screens are passive surfaces orchestrated by their owner.

const STYLE_ID = 'omega-screens-style';

// Rarity color tokens shared across cards & shop items.
const RARITY = Object.freeze({
  common:   { color: '#9aa6b2', glow: 'rgba(154,166,178,0.35)', label: 'COMMON' },
  uncommon: { color: '#6bd47a', glow: 'rgba(107,212,122,0.35)', label: 'UNCOMMON' },
  rare:     { color: '#b58cff', glow: 'rgba(181,140,255,0.40)', label: 'RARE' },
  curse:    { color: '#ff5c7a', glow: 'rgba(255,92,122,0.40)',  label: 'CURSE' },
});

const SHIP_DEFS = Object.freeze([
  {
    id: 'wraith',
    name: 'WRAITH',
    locked: false,
    movement: 'Agile thrust • short dash with i-frames',
    weapon:   'Plasma spread — balanced fire rate',
    color: '#6ad8ff',
  },
  {
    id: 'lance',
    name: 'LANCE',
    locked: true,
    unlockHint: 'Clear 3 biomes with WRAITH',
    movement: 'Heavy hull • boost charge dash',
    weapon:   'Rail — long pierce, slow cadence',
    color: '#ffb86a',
  },
  {
    id: 'arc',
    name: 'ARC',
    locked: true,
    unlockHint: 'Defeat the first boss',
    movement: 'Drift hull • teleport blink',
    weapon:   'Arc cascade — chains between targets',
    color: '#b58cff',
  },
  {
    id: 'swarm',
    name: 'SWARM',
    locked: true,
    unlockHint: 'Spend 1000 currency in shops',
    movement: 'Light hull • double dash',
    weapon:   'Swarm missiles — homing salvo',
    color: '#ff5cf2',
  },
]);

const SCREENS_CSS = `
#omega-screens {
  position: fixed; inset: 0; z-index: 200;
  pointer-events: none;
  font-family: ui-monospace, "JetBrains Mono", "Courier New", monospace;
  color: #cfe9ff;
}
#omega-screens.active { pointer-events: auto; }
#omega-screens .omega-screen {
  position: absolute; inset: 0;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  background: radial-gradient(ellipse at center, rgba(4,6,18,0.62) 0%, rgba(2,3,10,0.86) 70%);
  backdrop-filter: blur(6px);
  opacity: 0; transform: scale(1.02);
  transition: opacity 220ms ease, transform 220ms ease;
}
#omega-screens .omega-screen.visible { opacity: 1; transform: scale(1); }

#omega-screens h1.title {
  font-size: 22px; letter-spacing: 0.4em; text-transform: uppercase;
  color: #e8f6ff; margin: 0 0 4px 0; font-weight: 500;
}
#omega-screens p.subtitle {
  font-size: 11px; letter-spacing: 0.3em; text-transform: uppercase;
  color: rgba(207,233,255,0.55); margin: 0 0 32px 0;
}

/* --- Card grid (upgrades) --- */
.omega-cards {
  display: flex; gap: 22px;
  max-width: min(1100px, 92vw); width: 100%;
  justify-content: center; align-items: stretch;
}
.omega-card {
  flex: 1 1 0; max-width: 320px; min-width: 220px;
  background: linear-gradient(180deg, rgba(10,18,38,0.92), rgba(6,10,22,0.92));
  border: 1px solid rgba(120,200,255,0.18);
  border-radius: 10px;
  padding: 22px 18px 18px;
  display: flex; flex-direction: column;
  cursor: pointer;
  position: relative;
  opacity: 0; transform: translateY(24px);
  transition: transform 180ms ease, box-shadow 180ms ease,
              border-color 180ms ease, opacity 240ms ease;
}
.omega-screen.visible .omega-card { opacity: 1; transform: translateY(0); }
.omega-screen.visible .omega-card:nth-child(1) { transition-delay: 60ms; }
.omega-screen.visible .omega-card:nth-child(2) { transition-delay: 140ms; }
.omega-screen.visible .omega-card:nth-child(3) { transition-delay: 220ms; }
.omega-card:hover, .omega-card.focused {
  transform: translateY(-6px);
  border-color: var(--accent, rgba(180,240,255,0.85));
  box-shadow: 0 18px 50px -16px var(--glow, rgba(120,200,255,0.45)),
              0 0 0 1px var(--accent, rgba(180,240,255,0.55)) inset;
}
.omega-card .rarity {
  font-size: 9px; letter-spacing: 0.32em;
  color: var(--accent, #9aa6b2); margin-bottom: 10px;
}
.omega-card .icon {
  font-size: 38px; line-height: 1;
  color: var(--accent, #cfe9ff);
  margin-bottom: 14px; text-shadow: 0 0 18px var(--glow, transparent);
}
.omega-card .name {
  font-size: 15px; letter-spacing: 0.18em; text-transform: uppercase;
  color: #e8f6ff; margin-bottom: 10px;
}
.omega-card .desc {
  font-size: 12px; line-height: 1.55;
  color: rgba(207,233,255,0.72);
  flex: 1;
  text-transform: none; letter-spacing: 0.04em;
}
.omega-card .hotkey {
  position: absolute; top: 12px; right: 14px;
  font-size: 10px; letter-spacing: 0.18em;
  color: rgba(207,233,255,0.45);
  border: 1px solid rgba(120,200,255,0.2);
  padding: 2px 6px; border-radius: 3px;
}

/* --- Shop grid --- */
.omega-shop-wrap {
  display: flex; flex-direction: column; align-items: center;
  max-width: min(1100px, 92vw); width: 100%;
}
.omega-shop-header {
  display: flex; justify-content: space-between; align-items: baseline;
  width: 100%; margin-bottom: 18px;
}
.omega-shop-balance {
  font-size: 13px; letter-spacing: 0.22em;
  color: #ffd089;
}
.omega-shop-balance .num { color: #fff7c8; }
.omega-shop-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 14px;
  width: 100%;
}
.omega-shop-item {
  background: rgba(8,14,28,0.86);
  border: 1px solid rgba(120,200,255,0.16);
  border-radius: 8px;
  padding: 14px;
  cursor: pointer;
  display: flex; flex-direction: column; gap: 8px;
  position: relative;
  transition: transform 140ms ease, border-color 140ms ease,
              box-shadow 140ms ease, opacity 220ms ease;
  opacity: 0;
}
.omega-screen.visible .omega-shop-item { opacity: 1; }
.omega-shop-item.unaffordable { opacity: 0.4; cursor: not-allowed; }
.omega-shop-item.purchased { opacity: 0.35; cursor: default; }
.omega-shop-item.affordable { border-color: var(--accent, rgba(180,240,255,0.45)); }
.omega-shop-item:hover:not(.unaffordable):not(.purchased),
.omega-shop-item.focused {
  transform: translateY(-3px);
  border-color: var(--accent, rgba(180,240,255,0.85));
  box-shadow: 0 10px 30px -10px var(--glow, rgba(120,200,255,0.4));
}
.omega-shop-item .row1 {
  display: flex; justify-content: space-between; align-items: baseline;
}
.omega-shop-item .name {
  font-size: 12px; letter-spacing: 0.16em; color: #e8f6ff;
}
.omega-shop-item .price {
  font-size: 13px; letter-spacing: 0.15em; color: #ffd089;
}
.omega-shop-item.unaffordable .price { color: #ff5c7a; }
.omega-shop-item .desc {
  font-size: 10px; line-height: 1.5; letter-spacing: 0.05em;
  color: rgba(207,233,255,0.6); text-transform: none;
}
.omega-shop-item .rarity {
  font-size: 8px; letter-spacing: 0.3em; color: var(--accent, #9aa6b2);
}

/* --- Buttons --- */
.omega-btn {
  background: rgba(10,18,38,0.92);
  border: 1px solid rgba(120,200,255,0.4);
  color: #e8f6ff;
  padding: 10px 22px;
  font-family: inherit;
  font-size: 11px; letter-spacing: 0.3em; text-transform: uppercase;
  cursor: pointer;
  border-radius: 4px;
  transition: background 140ms ease, border-color 140ms ease, transform 140ms ease;
}
.omega-btn:hover, .omega-btn.focused {
  background: rgba(120,200,255,0.16);
  border-color: rgba(180,240,255,0.9);
  transform: translateY(-1px);
}
.omega-btn.primary {
  background: linear-gradient(180deg, rgba(106,216,255,0.22), rgba(106,216,255,0.08));
  border-color: rgba(180,240,255,0.7);
}
.omega-actions { display: flex; gap: 14px; margin-top: 28px; }

/* --- Ship select --- */
.omega-ship-row {
  display: flex; gap: 18px; max-width: min(1100px, 92vw); width: 100%;
  justify-content: center;
}
.omega-ship {
  flex: 1 1 0; max-width: 240px; min-width: 180px;
  background: linear-gradient(180deg, rgba(10,18,38,0.92), rgba(6,10,22,0.92));
  border: 1px solid rgba(120,200,255,0.18);
  border-radius: 10px;
  padding: 18px;
  cursor: pointer;
  display: flex; flex-direction: column; gap: 8px;
  position: relative;
  transition: transform 200ms ease, border-color 200ms ease, box-shadow 200ms ease;
}
.omega-ship.locked { opacity: 0.45; cursor: not-allowed; }
.omega-ship:hover:not(.locked), .omega-ship.focused {
  transform: translateY(-6px) rotate(-0.5deg);
  border-color: var(--accent, rgba(180,240,255,0.85));
  box-shadow: 0 20px 50px -16px var(--glow, rgba(120,200,255,0.45));
}
.omega-ship .name {
  font-size: 16px; letter-spacing: 0.28em; color: var(--accent);
}
.omega-ship .label {
  font-size: 9px; letter-spacing: 0.28em;
  color: rgba(207,233,255,0.5); margin-top: 6px;
}
.omega-ship .val {
  font-size: 11px; line-height: 1.4; letter-spacing: 0.04em;
  color: rgba(207,233,255,0.82); text-transform: none;
}
.omega-ship .lock-tag {
  font-size: 10px; letter-spacing: 0.18em;
  color: #ff5c7a; margin-top: 8px;
}
.omega-ship .hull-glyph {
  height: 64px; display: flex; align-items: center; justify-content: center;
  font-size: 36px; color: var(--accent);
  text-shadow: 0 0 14px var(--glow);
  animation: omega-spin 9s linear infinite;
}
@keyframes omega-spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}

/* --- Summary --- */
.omega-summary {
  background: linear-gradient(180deg, rgba(10,18,38,0.95), rgba(4,8,18,0.95));
  border: 1px solid rgba(120,200,255,0.22);
  border-radius: 10px;
  padding: 28px 36px;
  min-width: min(520px, 90vw);
  display: flex; flex-direction: column; gap: 10px;
}
.omega-summary .row {
  display: flex; justify-content: space-between; align-items: baseline;
  border-bottom: 1px dashed rgba(120,200,255,0.12);
  padding: 8px 0;
  font-size: 12px; letter-spacing: 0.15em;
}
.omega-summary .row:last-child { border-bottom: none; }
.omega-summary .row .k { color: rgba(207,233,255,0.62); }
.omega-summary .row .v { color: #fff7c8; font-variant-numeric: tabular-nums; }
.omega-summary .verdict {
  font-size: 22px; letter-spacing: 0.4em; text-transform: uppercase;
  text-align: center; margin: 0 0 4px;
}
.omega-summary .verdict.win  { color: #6bd47a; text-shadow: 0 0 18px rgba(107,212,122,0.4); }
.omega-summary .verdict.lose { color: #ff5c7a; text-shadow: 0 0 18px rgba(255,92,122,0.4); }
.omega-summary .upgrades {
  font-size: 10px; line-height: 1.6; letter-spacing: 0.06em;
  color: rgba(207,233,255,0.7); text-transform: none;
  border-top: 1px dashed rgba(120,200,255,0.12);
  padding-top: 10px; margin-top: 4px;
}

.omega-skip-hint {
  position: absolute; bottom: 22px;
  font-size: 10px; letter-spacing: 0.28em;
  color: rgba(207,233,255,0.4);
}

@media (max-width: 720px) {
  .omega-cards, .omega-ship-row { flex-direction: column; }
  .omega-card, .omega-ship { max-width: none; }
}
`;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = SCREENS_CSS;
  document.head.appendChild(s);
}

function rarityVars(rarity) {
  const r = RARITY[rarity] || RARITY.common;
  return `--accent:${r.color}; --glow:${r.glow};`;
}

// ---------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------

class BaseScreen {
  constructor({ manager, data = {} }) {
    this.manager = manager;
    this.bus = manager.bus;
    this.data = data;
    this.root = document.createElement('div');
    this.root.className = 'omega-screen';
    this._focusIndex = 0;
    this._focusables = [];
    this._onKey = this._onKey.bind(this);
  }

  /** Subclasses build their DOM inside this.root. */
  build() {}

  mount(parent) {
    this.build();
    parent.appendChild(this.root);
    // Two-step so transition fires.
    requestAnimationFrame(() => this.root.classList.add('visible'));
    window.addEventListener('keydown', this._onKey);
  }

  destroy() {
    window.removeEventListener('keydown', this._onKey);
    this.root.classList.remove('visible');
    // Allow CSS transition to finish before removing.
    setTimeout(() => this.root.remove(), 240);
  }

  /** Subclasses register their interactive elements here. */
  setFocusables(list) {
    this._focusables = list.filter(Boolean);
    this._focusIndex = 0;
    this._renderFocus();
  }

  _renderFocus() {
    this._focusables.forEach((el, i) => {
      el.classList.toggle('focused', i === this._focusIndex);
    });
  }

  _moveFocus(delta) {
    if (this._focusables.length === 0) return;
    const n = this._focusables.length;
    this._focusIndex = ((this._focusIndex + delta) % n + n) % n;
    this._renderFocus();
  }

  _activateFocused() {
    const el = this._focusables[this._focusIndex];
    if (el && !el.classList.contains('disabled')) el.click();
  }

  _onKey(e) {
    // Subclasses override and may chain.
  }
}

// ---------------------------------------------------------------------------
// Upgrade Choice
// ---------------------------------------------------------------------------

export class UpgradeChoiceScreen extends BaseScreen {
  build() {
    const cards = this.data.cards || [];
    const title = document.createElement('h1');
    title.className = 'title';
    title.textContent = this.data.title || 'CHOOSE AN UPGRADE';
    const sub = document.createElement('p');
    sub.className = 'subtitle';
    sub.textContent = '1 · 2 · 3 to select   •   Esc to skip';

    const row = document.createElement('div');
    row.className = 'omega-cards';

    const els = cards.slice(0, 3).map((def, i) => {
      const card = document.createElement('div');
      card.className = 'omega-card';
      card.setAttribute('style', rarityVars(def.rarity));
      const rarity = RARITY[def.rarity] || RARITY.common;
      card.innerHTML = `
        <div class="hotkey">${i + 1}</div>
        <div class="rarity">${rarity.label}</div>
        <div class="icon">${def.icon || '◆'}</div>
        <div class="name">${def.name}</div>
        <div class="desc">${def.description || ''}</div>
      `;
      card.addEventListener('click', () => this._pick(def));
      row.appendChild(card);
      return card;
    });

    const hint = document.createElement('div');
    hint.className = 'omega-skip-hint';
    hint.textContent = 'Esc — Skip';

    this.root.appendChild(title);
    this.root.appendChild(sub);
    this.root.appendChild(row);
    this.root.appendChild(hint);
    this.setFocusables(els);
    this._cards = cards;
  }

  _pick(def) {
    this.bus?.emit('upgrade:selected', { id: def.id, def, skipped: false });
    this.manager.hideScreen();
  }

  _skip() {
    this.bus?.emit('upgrade:selected', { id: null, def: null, skipped: true });
    this.manager.hideScreen();
  }

  _onKey(e) {
    if (e.code === 'Digit1' || e.code === 'Numpad1') { e.preventDefault(); if (this._cards[0]) this._pick(this._cards[0]); }
    else if (e.code === 'Digit2' || e.code === 'Numpad2') { e.preventDefault(); if (this._cards[1]) this._pick(this._cards[1]); }
    else if (e.code === 'Digit3' || e.code === 'Numpad3') { e.preventDefault(); if (this._cards[2]) this._pick(this._cards[2]); }
    else if (e.code === 'ArrowLeft')  { e.preventDefault(); this._moveFocus(-1); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); this._moveFocus(+1); }
    else if (e.code === 'Enter' || e.code === 'Space') { e.preventDefault(); this._activateFocused(); }
    else if (e.code === 'Escape') { e.preventDefault(); this._skip(); }
  }
}

// ---------------------------------------------------------------------------
// Shop
// ---------------------------------------------------------------------------

export class ShopScreen extends BaseScreen {
  build() {
    const inventory = this.data.inventory || [];
    const getBalance = this.data.getBalance || (() => 0);

    const wrap = document.createElement('div');
    wrap.className = 'omega-shop-wrap';

    const header = document.createElement('div');
    header.className = 'omega-shop-header';
    header.innerHTML = `
      <h1 class="title" style="margin:0;">SHOP</h1>
      <div class="omega-shop-balance">CREDITS · <span class="num">0</span></div>
    `;
    const balanceEl = header.querySelector('.num');

    const grid = document.createElement('div');
    grid.className = 'omega-shop-grid';

    const itemEls = inventory.map((item, i) => {
      const el = document.createElement('div');
      el.className = 'omega-shop-item';
      el.setAttribute('style', rarityVars(item.rarity));
      const rarity = RARITY[item.rarity] || RARITY.common;
      el.innerHTML = `
        <div class="row1">
          <div class="name">${item.name}</div>
          <div class="price">${item.price} ◊</div>
        </div>
        <div class="rarity">${rarity.label}</div>
        <div class="desc">${this._describeItem(item)}</div>
      `;
      // Staggered fade-in (200-300ms total).
      el.style.transitionDelay = `${40 + i * 30}ms`;
      el.addEventListener('click', () => this._buy(item, el));
      grid.appendChild(el);
      return el;
    });

    const actions = document.createElement('div');
    actions.className = 'omega-actions';
    const leaveBtn = document.createElement('button');
    leaveBtn.className = 'omega-btn';
    leaveBtn.textContent = 'Leave Shop  ·  Esc';
    leaveBtn.addEventListener('click', () => this._leave());
    actions.appendChild(leaveBtn);

    wrap.appendChild(header);
    wrap.appendChild(grid);
    wrap.appendChild(actions);
    this.root.appendChild(wrap);

    this._balanceEl = balanceEl;
    this._itemEls = itemEls;
    this._leaveBtn = leaveBtn;
    this._inventory = inventory;
    this._getBalance = getBalance;
    this._spentAtOpen = 0;
    this._refreshAffordability();
    this.setFocusables([...itemEls, leaveBtn]);
  }

  _describeItem(item) {
    const e = item.effect || {};
    if (e.healFrac)   return `Restores ${Math.round(e.healFrac * 100)}% HP.`;
    if (e.energyFrac) return `Refills ${Math.round(e.energyFrac * 100)}% energy.`;
    if (e.weaponId)   return `Unlocks weapon: ${e.weaponId.toUpperCase()}.`;
    if (e.consumable === 'shield') return 'Adds a shield charge.';
    if (e.consumable === 'dmg_boost') return `+50% damage for ${e.duration || 30}s.`;
    if (e.upgrade === 'random') return 'Roll a random upgrade card.';
    if (e.removeCurse) return 'Purges one curse from this run.';
    return '';
  }

  _refreshAffordability() {
    const bal = this._getBalance();
    if (this._balanceEl) this._balanceEl.textContent = String(bal);
    this._inventory.forEach((item, i) => {
      const el = this._itemEls[i];
      if (!el) return;
      el.classList.remove('affordable', 'unaffordable', 'purchased');
      if (item.purchased && this._isUnique(item)) {
        el.classList.add('purchased');
      } else if (bal >= item.price) {
        el.classList.add('affordable');
      } else {
        el.classList.add('unaffordable');
      }
    });
  }

  _isUnique(item) {
    return item.kind === 'weapon';
  }

  _buy(item, el) {
    if (el.classList.contains('purchased')) return;
    const shop = this.data.shop;
    let result;
    if (shop && typeof shop.purchase === 'function') {
      result = shop.purchase(item.itemId);
    } else {
      // Fallback: direct currency debit through caller hook.
      const debit = this.data.purchase;
      result = debit ? debit(item) : { ok: false, reason: 'no_shop' };
    }
    if (!result || !result.ok) {
      // Visual nudge: shake unaffordable.
      el.animate(
        [{ transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(0)' }],
        { duration: 180, iterations: 1 },
      );
      this._refreshAffordability();
      return;
    }
    // Update price (may have inflated) + balance count-down animation.
    const priceEl = el.querySelector('.price');
    if (priceEl) priceEl.textContent = `${result.item?.price ?? item.price} ◊`;
    if (this._balanceEl) {
      this._animateNumber(this._balanceEl, this._getBalance());
    }
    this.bus?.emit('shop:purchased', { itemId: item.itemId, item: result.item, price: result.price });
    this._refreshAffordability();
  }

  _animateNumber(el, target) {
    const start = parseInt(el.textContent, 10) || 0;
    const dur = 280;
    const t0 = performance.now();
    const tick = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      const v = Math.round(start + (target - start) * k);
      el.textContent = String(v);
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  _leave() {
    const shop = this.data.shop;
    let spent = 0;
    if (shop) {
      // Close emits 'shop:closed' from economy.js; we mirror with a typed event.
      const before = shop._visitSpent ?? 0;
      if (typeof shop.closeShop === 'function') shop.closeShop();
      spent = before;
    }
    this.bus?.emit('shop:left', { spent });
    this.manager.hideScreen();
  }

  _onKey(e) {
    if (e.code === 'Escape') { e.preventDefault(); this._leave(); }
    else if (e.code === 'Tab' || e.code === 'ArrowRight' || e.code === 'ArrowDown') {
      e.preventDefault(); this._moveFocus(+1);
    }
    else if (e.code === 'ArrowLeft' || e.code === 'ArrowUp') {
      e.preventDefault(); this._moveFocus(-1);
    }
    else if (e.code === 'Enter' || e.code === 'Space') { e.preventDefault(); this._activateFocused(); }
  }
}

// ---------------------------------------------------------------------------
// Ship Select
// ---------------------------------------------------------------------------

export class ShipSelectScreen extends BaseScreen {
  build() {
    const ships = (this.data.ships && this.data.ships.length) ? this.data.ships : SHIP_DEFS;

    const title = document.createElement('h1');
    title.className = 'title';
    title.textContent = 'SELECT HULL';
    const sub = document.createElement('p');
    sub.className = 'subtitle';
    sub.textContent = '← → to browse   •   Enter to confirm';

    const row = document.createElement('div');
    row.className = 'omega-ship-row';

    const els = ships.map((s) => {
      const card = document.createElement('div');
      card.className = 'omega-ship' + (s.locked ? ' locked' : '');
      card.style.cssText = `--accent:${s.color}; --glow:${s.color}66;`;
      card.innerHTML = `
        <div class="name">${s.name}</div>
        <div class="hull-glyph">◆</div>
        <div class="label">MOVEMENT</div>
        <div class="val">${s.movement}</div>
        <div class="label">WEAPON</div>
        <div class="val">${s.weapon}</div>
        ${s.locked ? `<div class="lock-tag">LOCKED · ${s.unlockHint || ''}</div>` : ''}
      `;
      card.addEventListener('click', () => this._pick(s));
      row.appendChild(card);
      return card;
    });

    this.root.appendChild(title);
    this.root.appendChild(sub);
    this.root.appendChild(row);

    this._ships = ships;
    this.setFocusables(els);
    // Auto-focus first unlocked.
    const idx = ships.findIndex((s) => !s.locked);
    if (idx >= 0) { this._focusIndex = idx; this._renderFocus(); }
  }

  _pick(s) {
    if (s.locked) return;
    this.bus?.emit('ship:selected', { id: s.id, def: s });
    this.manager.hideScreen();
  }

  _onKey(e) {
    if (e.code === 'ArrowLeft')       { e.preventDefault(); this._moveFocus(-1); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); this._moveFocus(+1); }
    else if (e.code === 'Enter' || e.code === 'Space') {
      e.preventDefault();
      const s = this._ships[this._focusIndex];
      if (s) this._pick(s);
    }
  }
}

// ---------------------------------------------------------------------------
// Run Summary
// ---------------------------------------------------------------------------

export class RunSummaryScreen extends BaseScreen {
  build() {
    const d = this.data || {};
    const outcome = d.outcome || 'lose';   // 'win' | 'lose'
    const stats = d.stats || {};
    const upgrades = d.upgrades || [];

    const wrap = document.createElement('div');
    wrap.className = 'omega-summary';

    const verdict = document.createElement('div');
    verdict.className = `verdict ${outcome === 'win' ? 'win' : 'lose'}`;
    verdict.textContent = outcome === 'win' ? 'RUN COMPLETE' : 'RUN OVER';
    wrap.appendChild(verdict);

    const rows = [
      ['Biomes cleared',   stats.biomesCleared   ?? 0],
      ['Waves survived',   stats.wavesSurvived   ?? 0],
      ['Enemies killed',   stats.enemiesKilled   ?? 0],
      ['Currency earned',  stats.currencyEarned  ?? 0],
      ['Final score',      stats.score           ?? 0],
    ];
    const valueEls = [];
    for (const [k, v] of rows) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<span class="k">${k}</span><span class="v">0</span>`;
      wrap.appendChild(row);
      valueEls.push({ el: row.querySelector('.v'), target: Number(v) || 0 });
    }

    if (upgrades.length) {
      const up = document.createElement('div');
      up.className = 'upgrades';
      up.innerHTML = `<strong>Upgrades:</strong> ${upgrades.map((u) => u.name || u.id || u).join(' · ')}`;
      wrap.appendChild(up);
    }

    const actions = document.createElement('div');
    actions.className = 'omega-actions';
    const newRun = document.createElement('button');
    newRun.className = 'omega-btn primary';
    newRun.textContent = 'New Run';
    newRun.addEventListener('click', () => {
      this.bus?.emit('run:new', {});
      this.manager.hideScreen();
    });
    const menu = document.createElement('button');
    menu.className = 'omega-btn';
    menu.textContent = 'Main Menu';
    menu.addEventListener('click', () => {
      this.bus?.emit('run:menu', {});
      this.manager.hideScreen();
    });
    actions.appendChild(newRun);
    actions.appendChild(menu);

    this.root.appendChild(wrap);
    this.root.appendChild(actions);

    this.setFocusables([newRun, menu]);
    this._focusIndex = 0;
    this._renderFocus();

    // Count-up animation.
    this._animateCounts(valueEls);
  }

  _animateCounts(items) {
    const dur = 700;
    const t0 = performance.now();
    const tick = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - k, 3);
      for (const it of items) {
        const v = Math.round(it.target * eased);
        it.el.textContent = v.toLocaleString();
      }
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  _onKey(e) {
    if (e.code === 'ArrowLeft' || e.code === 'ArrowUp')   { e.preventDefault(); this._moveFocus(-1); }
    else if (e.code === 'ArrowRight' || e.code === 'ArrowDown' || e.code === 'Tab') {
      e.preventDefault(); this._moveFocus(+1);
    }
    else if (e.code === 'Enter' || e.code === 'Space') { e.preventDefault(); this._activateFocused(); }
  }
}

// ---------------------------------------------------------------------------
// Screen Manager
// ---------------------------------------------------------------------------

export const SCREEN_TYPES = Object.freeze({
  UPGRADE: 'upgrade',
  SHOP:    'shop',
  SHIP:    'ship',
  SUMMARY: 'summary',
});

const SCREEN_CTORS = Object.freeze({
  [SCREEN_TYPES.UPGRADE]: UpgradeChoiceScreen,
  [SCREEN_TYPES.SHOP]:    ShopScreen,
  [SCREEN_TYPES.SHIP]:    ShipSelectScreen,
  [SCREEN_TYPES.SUMMARY]: RunSummaryScreen,
});

export class ScreenManager {
  /**
   * @param {{ bus?: any, mount?: HTMLElement }} [opts]
   */
  constructor({ bus = null, mount = null } = {}) {
    injectStyle();
    this.bus = bus;
    this._mount = mount || this._ensureMount();
    this._current = null;
    this._currentType = null;
  }

  _ensureMount() {
    let el = document.getElementById('omega-screens');
    if (!el) {
      el = document.createElement('div');
      el.id = 'omega-screens';
      document.body.appendChild(el);
    }
    return el;
  }

  /** True if any screen is currently visible (game systems should treat as paused). */
  isActive() { return this._current != null; }

  /** Returns current screen type string or null. */
  getCurrentScreen() { return this._currentType; }

  /**
   * Show a screen by type. If a screen is already active, it is hidden first.
   * @param {string} type one of SCREEN_TYPES.*
   * @param {object} data screen-specific payload
   */
  showScreen(type, data = {}) {
    const Ctor = SCREEN_CTORS[type];
    if (!Ctor) {
      // eslint-disable-next-line no-console
      console.warn('[screens] unknown screen type:', type);
      return null;
    }
    if (this._current) this.hideScreen();
    const screen = new Ctor({ manager: this, data });
    this._current = screen;
    this._currentType = type;
    this._mount.classList.add('active');
    screen.mount(this._mount);
    this.bus?.emit('screen:show', { type, data });
    return screen;
  }

  /** Hides the active screen, if any. */
  hideScreen() {
    if (!this._current) return;
    const type = this._currentType;
    this._current.destroy();
    this._current = null;
    this._currentType = null;
    this._mount.classList.remove('active');
    this.bus?.emit('screen:hide', { type });
  }

  dispose() {
    this.hideScreen();
    this._mount?.remove();
  }
}

// Re-exports for downstream wiring.
export { SHIP_DEFS, RARITY };
