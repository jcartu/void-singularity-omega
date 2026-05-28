// Meta UI screens — SPRINT-07 (WO-07-U2).
//
// Four polished, keyboard-navigable overlays that surface meta-progression
// systems built in WO-07-M1..M3:
//
//   - PrestigeScreen     : void-shard balance, tier table, next-tier purchase.
//   - UnlocksScreen      : ship / weapon / modifier unlock tree with locks.
//   - AchievementsScreen : gallery, category filter, progress bars, totals.
//   - DailyScreen        : today's seed, personal best, current run, start.
//
// All four share a single root mount + stylesheet, layered above the running
// stage just like the in-run screens (screens.js). Screens are pure DOM —
// they never touch Three.js, audio (forbidden), or controller (S09). They are
// passive surfaces driven by a snapshot supplied via `update(data)`.
//
// Public API:
//   const meta = new MetaScreens({ bus, mount, getData });
//   meta.showPrestige();      meta.showUnlocks();
//   meta.showAchievements();  meta.showDaily();
//   meta.update(data);        meta.hide();   meta.dispose();
//
// Events (emitted on the supplied bus):
//   'meta:show'           { type }
//   'meta:hide'           { type }
//   'prestige:advance'    {}                       (player clicked PRESTIGE)
//   'daily:start'         { seed }                 (player clicked START DAILY)
//   'meta:nav'            { from, to }             (user pressed nav tab)
//
// Data contract — every field is optional; the screen renders sensible
// fallbacks when the host hasn't wired a system yet:
//
//   data.prestige = {
//     tier, shards, shardsLifetime, shardsSpent, runs, wins,
//     nextTier: { tier, cost, name, description } | null,
//     canAdvance: boolean,
//     tierTable: [{ tier, cost, name, description, owned: boolean }],
//   }
//
//   data.unlocks = {
//     ships:      [{ id, name, unlocked, requirement, color? }],
//     weapons:    [{ id, name, unlocked, requirement }],
//     modifiers:  [{ id, name, unlocked, requirement, description? }],
//   }
//
//   data.achievements = [
//     { id, name, desc, cat, rarity, unlocked, progress?: { current, target } },
//   ]
//
//   data.daily = {
//     seed: string|number, date: string,
//     best: { score, biome?, waves?, date? } | null,
//     current: { score, active: boolean } | null,
//   }
//
// MUST NOT (per the request):
//   - Add audio.
//   - Add controller support.
//   - Break or modify existing screens.

const STYLE_ID = 'omega-meta-style';

const RARITY_COLOR = Object.freeze({
  common:    '#9aa6b2',
  uncommon:  '#6bd47a',
  rare:      '#b58cff',
  legendary: '#ffd089',
  curse:     '#ff5c7a',
});

const CATEGORY_LABEL = Object.freeze({
  all:     'ALL',
  skill:   'SKILL',
  explore: 'EXPLORATION',
  mastery: 'MASTERY',
  silly:   'SILLY',
});

const META_CSS = `
#omega-meta {
  position: fixed; inset: 0; z-index: 220;
  pointer-events: none;
  font-family: ui-monospace, "JetBrains Mono", "Courier New", monospace;
  color: #cfe9ff;
}
#omega-meta.active { pointer-events: auto; }
#omega-meta .meta-veil {
  position: absolute; inset: 0;
  background: radial-gradient(ellipse at center, rgba(4,6,18,0.7) 0%, rgba(2,3,10,0.92) 70%);
  backdrop-filter: blur(8px);
  opacity: 0;
  transition: opacity 220ms ease;
}
#omega-meta.active .meta-veil { opacity: 1; }

#omega-meta .meta-frame {
  position: absolute;
  top: 50%; left: 50%;
  transform: translate(-50%, calc(-50% + 18px));
  width: min(1120px, 94vw);
  max-height: 86vh;
  display: flex; flex-direction: column;
  background: linear-gradient(180deg, rgba(10,18,38,0.95), rgba(4,8,18,0.95));
  border: 1px solid rgba(120,200,255,0.22);
  border-radius: 12px;
  box-shadow: 0 28px 80px -28px rgba(0,0,0,0.8),
              0 0 0 1px rgba(120,200,255,0.08) inset;
  opacity: 0;
  transition: opacity 220ms ease, transform 220ms ease;
}
#omega-meta.active .meta-frame { opacity: 1; transform: translate(-50%, -50%); }

#omega-meta .meta-header {
  display: flex; align-items: center; gap: 24px;
  padding: 20px 28px 0 28px;
  border-bottom: 1px solid rgba(120,200,255,0.12);
}
#omega-meta .meta-tabs {
  display: flex; gap: 4px; flex: 1;
}
#omega-meta .meta-tab {
  background: transparent; border: none; color: rgba(207,233,255,0.5);
  font-family: inherit;
  font-size: 11px; letter-spacing: 0.32em; text-transform: uppercase;
  padding: 12px 16px;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: color 160ms ease, border-color 160ms ease;
}
#omega-meta .meta-tab:hover { color: #cfe9ff; }
#omega-meta .meta-tab.active {
  color: #e8f6ff;
  border-bottom-color: rgba(180,240,255,0.85);
  text-shadow: 0 0 10px rgba(120,200,255,0.4);
}
#omega-meta .meta-tab.focused {
  color: #e8f6ff;
  border-bottom-color: rgba(180,240,255,0.45);
}
#omega-meta .meta-close {
  background: transparent; border: 1px solid rgba(120,200,255,0.25);
  color: rgba(207,233,255,0.7);
  font-family: inherit; font-size: 10px; letter-spacing: 0.28em;
  padding: 6px 12px; border-radius: 4px;
  cursor: pointer;
  transition: border-color 140ms ease, color 140ms ease, background 140ms ease;
}
#omega-meta .meta-close:hover, #omega-meta .meta-close.focused {
  border-color: rgba(255,180,180,0.7); color: #ffd0d0;
  background: rgba(255,120,120,0.08);
}

#omega-meta .meta-body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 24px 28px 28px 28px;
  scrollbar-width: thin;
  scrollbar-color: rgba(120,200,255,0.25) transparent;
}
#omega-meta .meta-body::-webkit-scrollbar { width: 6px; }
#omega-meta .meta-body::-webkit-scrollbar-thumb {
  background: rgba(120,200,255,0.25); border-radius: 3px;
}

#omega-meta h2.meta-title {
  margin: 0 0 4px 0;
  font-size: 18px; letter-spacing: 0.36em; text-transform: uppercase;
  color: #e8f6ff; font-weight: 500;
}
#omega-meta p.meta-sub {
  margin: 0 0 22px 0;
  font-size: 11px; letter-spacing: 0.24em; text-transform: uppercase;
  color: rgba(207,233,255,0.5);
}

/* --- Prestige ----------------------------------------------------- */
#omega-meta .prestige-top {
  display: grid; grid-template-columns: 1fr 1fr; gap: 18px;
  margin-bottom: 24px;
}
#omega-meta .stat-card {
  background: rgba(6,12,28,0.72);
  border: 1px solid rgba(120,200,255,0.16);
  border-radius: 8px;
  padding: 16px 18px;
  display: flex; flex-direction: column; gap: 4px;
}
#omega-meta .stat-card .label {
  font-size: 10px; letter-spacing: 0.3em; text-transform: uppercase;
  color: rgba(207,233,255,0.5);
}
#omega-meta .stat-card .value {
  font-size: 28px; letter-spacing: 0.12em;
  color: #fff7c8;
  font-variant-numeric: tabular-nums;
}
#omega-meta .stat-card.shards .value { color: #b58cff; text-shadow: 0 0 18px rgba(181,140,255,0.35); }

#omega-meta .progress {
  margin-top: 10px;
  position: relative;
  height: 8px; width: 100%;
  background: rgba(255,255,255,0.06);
  border-radius: 4px; overflow: hidden;
}
#omega-meta .progress .fill {
  position: absolute; inset: 0;
  width: 0%;
  background: linear-gradient(90deg, rgba(181,140,255,0.6), rgba(120,200,255,0.85));
  box-shadow: 0 0 12px rgba(181,140,255,0.5);
  transition: width 420ms ease;
}
#omega-meta .progress .label {
  position: absolute; top: -16px; right: 0;
  font-size: 9px; letter-spacing: 0.2em;
  color: rgba(207,233,255,0.6);
}

#omega-meta .prestige-action {
  display: flex; align-items: center; gap: 16px;
  background: rgba(8,14,28,0.78);
  border: 1px solid rgba(180,240,255,0.22);
  border-radius: 8px;
  padding: 16px 18px;
  margin-bottom: 22px;
}
#omega-meta .prestige-action .next {
  flex: 1;
  display: flex; flex-direction: column; gap: 4px;
}
#omega-meta .prestige-action .next .heading {
  font-size: 10px; letter-spacing: 0.28em; color: rgba(207,233,255,0.5);
}
#omega-meta .prestige-action .next .name {
  font-size: 14px; letter-spacing: 0.18em; color: #e8f6ff;
}
#omega-meta .prestige-action .next .desc {
  font-size: 11px; letter-spacing: 0.04em; color: rgba(207,233,255,0.7);
  text-transform: none;
}
#omega-meta .prestige-action .cost {
  font-size: 18px; letter-spacing: 0.12em; color: #b58cff;
}
#omega-meta .prestige-action .cost.too-expensive { color: #ff5c7a; }

#omega-meta .tier-list {
  display: flex; flex-direction: column; gap: 8px;
}
#omega-meta .tier-row {
  display: grid;
  grid-template-columns: 56px 1fr auto;
  align-items: center; gap: 14px;
  background: rgba(6,12,28,0.6);
  border: 1px solid rgba(120,200,255,0.1);
  border-radius: 6px;
  padding: 10px 14px;
  opacity: 0.55;
  transition: opacity 200ms ease, border-color 200ms ease;
}
#omega-meta .tier-row.owned {
  opacity: 1;
  border-color: rgba(107,212,122,0.4);
  background: linear-gradient(90deg, rgba(107,212,122,0.06), rgba(6,12,28,0.6) 60%);
}
#omega-meta .tier-row.next {
  opacity: 1;
  border-color: rgba(181,140,255,0.55);
  box-shadow: 0 0 18px -4px rgba(181,140,255,0.35);
}
#omega-meta .tier-row .tier-num {
  font-size: 18px; letter-spacing: 0.18em;
  color: rgba(207,233,255,0.7);
  text-align: center;
}
#omega-meta .tier-row.owned .tier-num { color: #6bd47a; }
#omega-meta .tier-row.next  .tier-num { color: #b58cff; }
#omega-meta .tier-row .tier-name {
  font-size: 12px; letter-spacing: 0.18em; color: #e8f6ff;
}
#omega-meta .tier-row .tier-desc {
  font-size: 10px; letter-spacing: 0.04em; color: rgba(207,233,255,0.65);
  text-transform: none;
  margin-top: 3px;
}
#omega-meta .tier-row .tier-cost {
  font-size: 11px; letter-spacing: 0.18em; color: #b58cff;
}
#omega-meta .tier-row.owned .tier-cost { color: rgba(107,212,122,0.7); }

/* --- Unlocks ------------------------------------------------------ */
#omega-meta .unlock-section {
  margin-bottom: 24px;
}
#omega-meta .unlock-section .heading {
  font-size: 11px; letter-spacing: 0.3em; text-transform: uppercase;
  color: rgba(207,233,255,0.55);
  margin: 0 0 10px 0;
  display: flex; align-items: baseline; gap: 10px;
}
#omega-meta .unlock-section .heading .count {
  font-size: 10px; color: rgba(207,233,255,0.4);
}
#omega-meta .unlock-tree {
  position: relative;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 14px;
}
#omega-meta .unlock-node {
  position: relative;
  background: rgba(6,12,28,0.78);
  border: 1px solid rgba(120,200,255,0.16);
  border-radius: 8px;
  padding: 14px;
  display: flex; flex-direction: column; gap: 6px;
  transition: transform 160ms ease, border-color 160ms ease, box-shadow 160ms ease;
  --accent: rgba(180,240,255,0.5);
  --glow: rgba(120,200,255,0.35);
}
#omega-meta .unlock-node.unlocked {
  border-color: var(--accent);
  box-shadow: 0 0 18px -8px var(--glow);
}
#omega-meta .unlock-node.locked {
  opacity: 0.55;
  border-style: dashed;
}
#omega-meta .unlock-node.focused,
#omega-meta .unlock-node:hover {
  transform: translateY(-3px);
  border-color: var(--accent);
}
#omega-meta .unlock-node .glyph {
  width: 36px; height: 36px;
  display: flex; align-items: center; justify-content: center;
  background: rgba(120,200,255,0.06);
  border: 1px solid var(--accent);
  border-radius: 50%;
  font-size: 16px; color: var(--accent);
  text-shadow: 0 0 12px var(--glow);
  margin-bottom: 4px;
}
#omega-meta .unlock-node.locked .glyph { color: rgba(207,233,255,0.4); }
#omega-meta .unlock-node .name {
  font-size: 12px; letter-spacing: 0.18em; color: #e8f6ff;
}
#omega-meta .unlock-node .req {
  font-size: 10px; letter-spacing: 0.04em; color: rgba(207,233,255,0.55);
  text-transform: none;
}
#omega-meta .unlock-node.unlocked .req { color: rgba(107,212,122,0.85); }
#omega-meta .unlock-node .badge {
  position: absolute; top: 10px; right: 12px;
  font-size: 8px; letter-spacing: 0.28em;
  color: rgba(207,233,255,0.55);
}
#omega-meta .unlock-node.unlocked .badge { color: #6bd47a; }
#omega-meta .unlock-node.locked .badge { color: #ff5c7a; }

/* Visual tree connectors: faint vertical line on the left of each section
 * with horizontal stubs to each node — approximated via pseudo-elements. */
#omega-meta .unlock-tree::before {
  content: '';
  position: absolute;
  left: 6px; top: 18px; bottom: 14px;
  width: 1px;
  background: linear-gradient(180deg,
    rgba(120,200,255,0.0),
    rgba(120,200,255,0.18) 12%,
    rgba(120,200,255,0.18) 88%,
    rgba(120,200,255,0.0));
}
#omega-meta .unlock-node::before {
  content: '';
  position: absolute;
  left: -10px; top: 22px;
  width: 16px; height: 1px;
  background: rgba(120,200,255,0.18);
  pointer-events: none;
}
@media (max-width: 720px) {
  #omega-meta .unlock-tree::before,
  #omega-meta .unlock-node::before { display: none; }
}

/* --- Achievements ------------------------------------------------- */
#omega-meta .ach-header {
  display: flex; flex-wrap: wrap; align-items: baseline;
  gap: 14px; margin-bottom: 14px;
}
#omega-meta .ach-count {
  font-size: 12px; letter-spacing: 0.2em;
  color: rgba(207,233,255,0.75);
}
#omega-meta .ach-count .num { color: #fff7c8; }
#omega-meta .ach-filters {
  display: flex; gap: 6px; margin-left: auto; flex-wrap: wrap;
}
#omega-meta .ach-filter {
  background: transparent; border: 1px solid rgba(120,200,255,0.18);
  color: rgba(207,233,255,0.6);
  font-family: inherit;
  font-size: 10px; letter-spacing: 0.24em; text-transform: uppercase;
  padding: 6px 10px; border-radius: 4px;
  cursor: pointer;
  transition: border-color 140ms ease, color 140ms ease, background 140ms ease;
}
#omega-meta .ach-filter:hover,
#omega-meta .ach-filter.focused { color: #e8f6ff; border-color: rgba(180,240,255,0.5); }
#omega-meta .ach-filter.active {
  color: #04060f;
  background: rgba(180,240,255,0.85);
  border-color: rgba(180,240,255,0.95);
}

#omega-meta .ach-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
}
#omega-meta .ach-card {
  background: rgba(6,12,28,0.78);
  border: 1px solid rgba(120,200,255,0.14);
  border-radius: 8px;
  padding: 12px 14px;
  display: flex; flex-direction: column; gap: 6px;
  position: relative;
  --accent: rgba(180,240,255,0.6);
  transition: border-color 160ms ease, transform 160ms ease, box-shadow 160ms ease;
}
#omega-meta .ach-card.locked { opacity: 0.55; }
#omega-meta .ach-card.unlocked {
  border-color: var(--accent);
  box-shadow: 0 0 18px -8px var(--accent);
}
#omega-meta .ach-card.focused,
#omega-meta .ach-card:hover { transform: translateY(-3px); }
#omega-meta .ach-card .top {
  display: flex; align-items: center; gap: 10px;
}
#omega-meta .ach-card .seal {
  width: 28px; height: 28px;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--accent);
  border-radius: 6px;
  font-size: 14px;
  color: var(--accent);
}
#omega-meta .ach-card.locked .seal { color: rgba(207,233,255,0.3); border-color: rgba(120,200,255,0.18); }
#omega-meta .ach-card .name {
  font-size: 12px; letter-spacing: 0.16em; color: #e8f6ff;
}
#omega-meta .ach-card .rarity-tag {
  position: absolute; top: 10px; right: 12px;
  font-size: 8px; letter-spacing: 0.28em; color: var(--accent);
}
#omega-meta .ach-card .desc {
  font-size: 10px; line-height: 1.5; letter-spacing: 0.04em;
  color: rgba(207,233,255,0.65);
  text-transform: none;
}
#omega-meta .ach-card .ach-progress {
  height: 4px; background: rgba(255,255,255,0.06);
  border-radius: 2px; overflow: hidden; margin-top: 2px;
  position: relative;
}
#omega-meta .ach-card .ach-progress .pf {
  position: absolute; inset: 0; width: 0%;
  background: linear-gradient(90deg, var(--accent), rgba(120,200,255,0.85));
}
#omega-meta .ach-card .ach-progress-label {
  font-size: 9px; letter-spacing: 0.14em; color: rgba(207,233,255,0.55);
}

/* --- Daily seed --------------------------------------------------- */
#omega-meta .daily-hero {
  background: linear-gradient(180deg, rgba(20,30,60,0.85), rgba(8,14,32,0.85));
  border: 1px solid rgba(180,240,255,0.25);
  border-radius: 10px;
  padding: 24px 28px;
  display: grid; grid-template-columns: 1fr auto;
  gap: 18px;
  margin-bottom: 18px;
  position: relative; overflow: hidden;
}
#omega-meta .daily-hero::before {
  content: '';
  position: absolute; inset: -40%;
  background: radial-gradient(circle at 30% 50%,
    rgba(120,200,255,0.18), transparent 40%);
  pointer-events: none;
}
#omega-meta .daily-hero .seed-block { position: relative; }
#omega-meta .daily-hero .seed-label {
  font-size: 10px; letter-spacing: 0.32em; text-transform: uppercase;
  color: rgba(207,233,255,0.55);
}
#omega-meta .daily-hero .seed-value {
  font-size: 22px; letter-spacing: 0.22em;
  color: #b8e4ff;
  text-shadow: 0 0 14px rgba(120,200,255,0.45);
  margin-top: 6px;
  font-variant-numeric: tabular-nums;
  word-break: break-all;
}
#omega-meta .daily-hero .date {
  font-size: 11px; letter-spacing: 0.22em;
  color: rgba(207,233,255,0.7);
  margin-top: 4px;
}
#omega-meta .daily-hero .start-btn {
  align-self: center;
  background: linear-gradient(180deg, rgba(106,216,255,0.28), rgba(106,216,255,0.08));
  border: 1px solid rgba(180,240,255,0.7);
  color: #e8f6ff;
  font-family: inherit;
  font-size: 12px; letter-spacing: 0.32em; text-transform: uppercase;
  padding: 14px 28px;
  border-radius: 6px;
  cursor: pointer;
  position: relative;
  transition: transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease;
}
#omega-meta .daily-hero .start-btn:hover,
#omega-meta .daily-hero .start-btn.focused {
  transform: translateY(-2px);
  border-color: rgba(180,240,255,0.95);
  box-shadow: 0 14px 40px -16px rgba(120,200,255,0.7);
}
#omega-meta .daily-hero .start-btn[disabled] {
  opacity: 0.6; cursor: not-allowed; transform: none; box-shadow: none;
}

#omega-meta .daily-stats {
  display: grid; grid-template-columns: 1fr 1fr; gap: 14px;
}

/* --- Generic empty state ----------------------------------------- */
#omega-meta .empty {
  padding: 28px;
  text-align: center;
  color: rgba(207,233,255,0.5);
  font-size: 11px; letter-spacing: 0.22em;
}
`;

function injectStyle() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = META_CSS;
  document.head.appendChild(el);
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function pct(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n)) * 100;
}

function rarityAccent(rarity) {
  return RARITY_COLOR[rarity] || RARITY_COLOR.common;
}

const SCREEN_TYPES = Object.freeze({
  PRESTIGE:     'prestige',
  UNLOCKS:      'unlocks',
  ACHIEVEMENTS: 'achievements',
  DAILY:        'daily',
});

const TAB_ORDER = [
  SCREEN_TYPES.PRESTIGE,
  SCREEN_TYPES.UNLOCKS,
  SCREEN_TYPES.ACHIEVEMENTS,
  SCREEN_TYPES.DAILY,
];

const TAB_LABEL = Object.freeze({
  [SCREEN_TYPES.PRESTIGE]:     'PRESTIGE',
  [SCREEN_TYPES.UNLOCKS]:      'UNLOCKS',
  [SCREEN_TYPES.ACHIEVEMENTS]: 'ACHIEVEMENTS',
  [SCREEN_TYPES.DAILY]:        'DAILY SEED',
});

export class MetaScreens {
  /**
   * @param {object} [opts]
   * @param {any} [opts.bus]       EventBus (optional). When present, lifecycle and
   *                               action events are emitted on it.
   * @param {HTMLElement} [opts.mount]  Mount node. Auto-created if absent.
   * @param {() => object} [opts.getData]  Optional snapshot provider; if set,
   *                               re-invoked on every show() and update().
   */
  constructor({ bus = null, mount = null, getData = null } = {}) {
    injectStyle();
    this.bus = bus;
    this._getData = typeof getData === 'function' ? getData : null;
    this._data = this._getData ? (this._getData() || {}) : {};
    this._mount = mount || this._ensureMount();
    this._current = null;
    this._achFilter = 'all';
    this._focusables = [];
    this._focusIndex = 0;
    this._onKey = this._onKey.bind(this);

    // Build static frame (header + body), rendered once.
    this._mount.innerHTML = '';
    const veil = document.createElement('div');
    veil.className = 'meta-veil';

    const frame = document.createElement('div');
    frame.className = 'meta-frame';

    const header = document.createElement('div');
    header.className = 'meta-header';

    const tabs = document.createElement('div');
    tabs.className = 'meta-tabs';
    const tabEls = {};
    for (const t of TAB_ORDER) {
      const btn = document.createElement('button');
      btn.className = 'meta-tab';
      btn.type = 'button';
      btn.dataset.tab = t;
      btn.textContent = TAB_LABEL[t];
      btn.addEventListener('click', () => this._navTo(t));
      tabs.appendChild(btn);
      tabEls[t] = btn;
    }
    header.appendChild(tabs);

    const close = document.createElement('button');
    close.className = 'meta-close';
    close.type = 'button';
    close.textContent = 'Close · Esc';
    close.addEventListener('click', () => this.hide());
    header.appendChild(close);

    const body = document.createElement('div');
    body.className = 'meta-body';

    frame.appendChild(header);
    frame.appendChild(body);
    this._mount.appendChild(veil);
    this._mount.appendChild(frame);

    this._tabEls = tabEls;
    this._body = body;
    this._closeBtn = close;
  }

  _ensureMount() {
    let el = document.getElementById('omega-meta');
    if (!el) {
      el = document.createElement('div');
      el.id = 'omega-meta';
      document.body.appendChild(el);
    }
    return el;
  }

  // ---- public API --------------------------------------------------

  /** True while any meta screen is visible. */
  isActive() { return this._current != null; }
  getCurrentScreen() { return this._current; }

  showPrestige()     { return this._show(SCREEN_TYPES.PRESTIGE); }
  showUnlocks()      { return this._show(SCREEN_TYPES.UNLOCKS); }
  showAchievements() { return this._show(SCREEN_TYPES.ACHIEVEMENTS); }
  showDaily()        { return this._show(SCREEN_TYPES.DAILY); }

  hide() {
    if (!this._current) return;
    const from = this._current;
    this._current = null;
    this._mount.classList.remove('active');
    window.removeEventListener('keydown', this._onKey);
    this.bus?.emit?.('meta:hide', { type: from });
  }

  /** Refresh snapshot. Re-renders the currently-shown screen, if any. */
  update(data) {
    if (data && typeof data === 'object') this._data = data;
    else if (this._getData) this._data = this._getData() || {};
    if (this._current) this._renderCurrent();
  }

  dispose() {
    this.hide();
    this._mount?.remove();
  }

  // ---- internals ---------------------------------------------------

  _show(type) {
    if (this._getData && (!this._data || !this._current)) {
      this._data = this._getData() || {};
    }
    const wasActive = this._current != null;
    this._current = type;
    this._mount.classList.add('active');
    this._renderCurrent();
    if (!wasActive) {
      window.addEventListener('keydown', this._onKey);
    }
    this.bus?.emit?.('meta:show', { type });
    return this;
  }

  _navTo(type) {
    if (this._current === type) return;
    const from = this._current;
    this._current = type;
    this._renderCurrent();
    this.bus?.emit?.('meta:nav', { from, to: type });
  }

  _renderCurrent() {
    const t = this._current;
    for (const k of TAB_ORDER) {
      this._tabEls[k].classList.toggle('active', k === t);
    }
    if (t === SCREEN_TYPES.PRESTIGE)          this._renderPrestige();
    else if (t === SCREEN_TYPES.UNLOCKS)      this._renderUnlocks();
    else if (t === SCREEN_TYPES.ACHIEVEMENTS) this._renderAchievements();
    else if (t === SCREEN_TYPES.DAILY)        this._renderDaily();
    this._body.scrollTop = 0;
    this._rebuildFocusables();
  }

  _rebuildFocusables() {
    const tabs = TAB_ORDER.map((k) => this._tabEls[k]);
    const inBody = Array.from(this._body.querySelectorAll(
      '[data-focusable="1"], button, .ach-filter, .ach-card, .unlock-node',
    ));
    this._focusables = [...tabs, ...inBody, this._closeBtn];
    this._focusIndex = TAB_ORDER.indexOf(this._current);
    if (this._focusIndex < 0) this._focusIndex = 0;
    this._renderFocus();
  }

  _renderFocus() {
    for (let i = 0; i < this._focusables.length; i++) {
      this._focusables[i].classList.toggle('focused', i === this._focusIndex);
    }
  }

  _moveFocus(delta) {
    const n = this._focusables.length;
    if (n === 0) return;
    this._focusIndex = ((this._focusIndex + delta) % n + n) % n;
    this._renderFocus();
    const el = this._focusables[this._focusIndex];
    if (el && typeof el.scrollIntoView === 'function') {
      try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch { /* noop */ }
    }
  }

  _activateFocused() {
    const el = this._focusables[this._focusIndex];
    if (el && !el.classList.contains('disabled')) el.click();
  }

  _onKey(e) {
    if (e.code === 'Escape')        { e.preventDefault(); this.hide(); return; }
    if (e.code === 'Tab') {
      e.preventDefault();
      this._moveFocus(e.shiftKey ? -1 : +1);
      return;
    }
    if (e.code === 'ArrowRight' || e.code === 'ArrowDown') {
      e.preventDefault(); this._moveFocus(+1); return;
    }
    if (e.code === 'ArrowLeft' || e.code === 'ArrowUp') {
      e.preventDefault(); this._moveFocus(-1); return;
    }
    if (e.code === 'Enter' || e.code === 'Space') {
      e.preventDefault(); this._activateFocused(); return;
    }
    // Tab quick-jumps: 1..4
    if (e.code === 'Digit1') { e.preventDefault(); this._navTo(TAB_ORDER[0]); }
    else if (e.code === 'Digit2') { e.preventDefault(); this._navTo(TAB_ORDER[1]); }
    else if (e.code === 'Digit3') { e.preventDefault(); this._navTo(TAB_ORDER[2]); }
    else if (e.code === 'Digit4') { e.preventDefault(); this._navTo(TAB_ORDER[3]); }
  }

  // ── Prestige ─────────────────────────────────────────────────────

  _renderPrestige() {
    const p = this._data.prestige || {};
    const tier         = Number(p.tier) || 0;
    const shards       = Number(p.shards) || 0;
    const lifetime     = Number(p.shardsLifetime) || shards;
    const runs         = Number(p.runs) || 0;
    const wins         = Number(p.wins) || 0;
    const nextTier     = p.nextTier || null;
    const canAdvance   = !!p.canAdvance && nextTier != null;
    const tierTable    = Array.isArray(p.tierTable) ? p.tierTable : [];

    const progressFrac = nextTier
      ? Math.min(1, shards / Math.max(1, Number(nextTier.cost) || 1))
      : 1;

    const html = `
      <h2 class="meta-title">Prestige</h2>
      <p class="meta-sub">Spend void shards to unlock permanent modifiers.</p>

      <div class="prestige-top">
        <div class="stat-card">
          <span class="label">Current Tier</span>
          <span class="value">${tier} <span style="font-size:11px;letter-spacing:0.2em;color:rgba(207,233,255,0.45);">/ ${tierTable.length || tier}</span></span>
        </div>
        <div class="stat-card shards">
          <span class="label">Void Shards</span>
          <span class="value">◊ ${shards.toLocaleString()}</span>
          <div class="progress" aria-label="progress to next tier">
            <div class="label">${nextTier ? `Next: ${esc(nextTier.name)} · ${nextTier.cost.toLocaleString()} ◊` : 'MAX TIER'}</div>
            <div class="fill" style="width:${pct(progressFrac).toFixed(1)}%;"></div>
          </div>
        </div>
      </div>

      <div class="prestige-action">
        <div class="next">
          ${nextTier ? `
            <span class="heading">Next Unlock · Tier ${nextTier.tier}</span>
            <span class="name">${esc(nextTier.name)}</span>
            <span class="desc">${esc(nextTier.description || '')}</span>
          ` : `
            <span class="heading">Status</span>
            <span class="name">All Tiers Unlocked</span>
            <span class="desc">You are at the apex of prestige.</span>
          `}
        </div>
        <span class="cost ${nextTier && !canAdvance ? 'too-expensive' : ''}">
          ${nextTier ? `${nextTier.cost.toLocaleString()} ◊` : ''}
        </span>
        <button class="omega-meta-prestige-btn meta-close" data-focusable="1" ${nextTier ? '' : 'disabled'} style="
          padding:10px 22px; font-size:11px; letter-spacing:0.3em;
          color:${canAdvance ? '#04060f' : 'rgba(207,233,255,0.5)'};
          background:${canAdvance ? 'linear-gradient(180deg, rgba(181,140,255,0.95), rgba(120,200,255,0.85))' : 'rgba(8,14,28,0.7)'};
          border-color:${canAdvance ? 'rgba(181,140,255,0.95)' : 'rgba(120,200,255,0.2)'};
          ${canAdvance ? '' : 'cursor:not-allowed;'}
        ">
          ${canAdvance ? 'PRESTIGE' : nextTier ? 'NEED MORE' : 'MAXED'}
        </button>
      </div>

      <div class="tier-list">
        ${tierTable.length ? tierTable.map((row) => this._tierRow(row, tier)).join('') : `
          <div class="empty">No tier data available.</div>
        `}
      </div>

      <div style="margin-top:18px; display:flex; gap:18px; font-size:10px; letter-spacing:0.22em; color:rgba(207,233,255,0.45);">
        <span>Lifetime Shards · <span style="color:#fff7c8;">${lifetime.toLocaleString()}</span></span>
        <span>Runs · <span style="color:#fff7c8;">${runs.toLocaleString()}</span></span>
        <span>Wins · <span style="color:#6bd47a;">${wins.toLocaleString()}</span></span>
      </div>
    `;
    this._body.innerHTML = html;

    const btn = this._body.querySelector('.omega-meta-prestige-btn');
    if (btn) {
      btn.addEventListener('click', () => {
        if (!canAdvance) return;
        this.bus?.emit?.('prestige:advance', {});
      });
    }
  }

  _tierRow(row, currentTier) {
    const owned = !!row.owned || row.tier <= currentTier;
    const isNext = !owned && row.tier === currentTier + 1;
    const cls = owned ? 'owned' : isNext ? 'next' : '';
    return `
      <div class="tier-row ${cls}">
        <div class="tier-num">${esc(row.tier)}</div>
        <div>
          <div class="tier-name">${esc(row.name || '')}</div>
          <div class="tier-desc">${esc(row.description || '')}</div>
        </div>
        <div class="tier-cost">${(Number(row.cost) || 0).toLocaleString()} ◊</div>
      </div>
    `;
  }

  // ── Unlocks ──────────────────────────────────────────────────────

  _renderUnlocks() {
    const u = this._data.unlocks || {};
    const sections = [
      { key: 'ships',     title: 'Ships',     items: u.ships     || [] },
      { key: 'weapons',   title: 'Weapons',   items: u.weapons   || [] },
      { key: 'modifiers', title: 'Modifiers', items: u.modifiers || [] },
    ];
    const total = sections.reduce((s, x) => s + x.items.length, 0);
    const unlocked = sections.reduce(
      (s, x) => s + x.items.filter((i) => i.unlocked).length, 0,
    );

    const html = `
      <h2 class="meta-title">Unlocks</h2>
      <p class="meta-sub">${unlocked} / ${total} unlocked · ships · weapons · modifiers</p>
      ${sections.map((sec) => this._unlockSection(sec)).join('')}
    `;
    this._body.innerHTML = html;
  }

  _unlockSection(sec) {
    if (!sec.items.length) {
      return `
        <div class="unlock-section">
          <h3 class="heading">${esc(sec.title)}<span class="count">0 / 0</span></h3>
          <div class="empty">No ${esc(sec.title.toLowerCase())} defined yet.</div>
        </div>
      `;
    }
    const unlockedCount = sec.items.filter((i) => i.unlocked).length;
    return `
      <div class="unlock-section">
        <h3 class="heading">${esc(sec.title)}<span class="count">${unlockedCount} / ${sec.items.length}</span></h3>
        <div class="unlock-tree">
          ${sec.items.map((item) => this._unlockNode(item)).join('')}
        </div>
      </div>
    `;
  }

  _unlockNode(item) {
    const unlocked = !!item.unlocked;
    const accent = item.color || (unlocked ? '#6bd47a' : '#9aa6b2');
    return `
      <div class="unlock-node ${unlocked ? 'unlocked' : 'locked'}"
           data-focusable="1"
           tabindex="-1"
           style="--accent:${accent}; --glow:${accent}55;">
        <span class="badge">${unlocked ? 'UNLOCKED' : 'LOCKED'}</span>
        <div class="glyph">${unlocked ? '◆' : '◇'}</div>
        <div class="name">${esc(item.name || item.id || '???')}</div>
        <div class="req">
          ${unlocked
            ? esc(item.description || 'Available for selection.')
            : esc(item.requirement || 'Requirement unknown.')}
        </div>
      </div>
    `;
  }

  // ── Achievements ─────────────────────────────────────────────────

  _renderAchievements() {
    const list = Array.isArray(this._data.achievements) ? this._data.achievements : [];
    const total = list.length;
    const unlocked = list.filter((a) => a.unlocked).length;
    const categories = ['all', 'skill', 'explore', 'mastery', 'silly'];
    const filtered = this._achFilter === 'all'
      ? list
      : list.filter((a) => (a.cat || 'skill') === this._achFilter);

    const html = `
      <h2 class="meta-title">Achievements</h2>
      <p class="meta-sub">Trophies earned across all runs.</p>

      <div class="ach-header">
        <span class="ach-count"><span class="num">${unlocked}</span> / ${total} unlocked</span>
        <div class="ach-filters">
          ${categories.map((c) => `
            <button class="ach-filter ${c === this._achFilter ? 'active' : ''}"
                    data-cat="${c}" data-focusable="1" type="button">
              ${esc(CATEGORY_LABEL[c] || c)}
            </button>
          `).join('')}
        </div>
      </div>

      <div class="ach-gallery">
        ${filtered.length
          ? filtered.map((a) => this._achCard(a)).join('')
          : '<div class="empty">No achievements in this category yet.</div>'}
      </div>
    `;
    this._body.innerHTML = html;

    this._body.querySelectorAll('.ach-filter').forEach((btn) => {
      btn.addEventListener('click', () => {
        this._achFilter = btn.dataset.cat || 'all';
        this._renderAchievements();
        this._rebuildFocusables();
      });
    });
  }

  _achCard(a) {
    const unlocked = !!a.unlocked;
    const accent = rarityAccent(a.rarity);
    const prog = a.progress;
    const showProg = !unlocked && prog && Number.isFinite(prog.current) && Number.isFinite(prog.target) && prog.target > 0;
    const fracPct = showProg ? Math.min(100, (prog.current / prog.target) * 100) : 0;
    return `
      <div class="ach-card ${unlocked ? 'unlocked' : 'locked'}"
           data-focusable="1" tabindex="-1"
           style="--accent:${accent};">
        <span class="rarity-tag">${esc((a.rarity || 'common').toUpperCase())}</span>
        <div class="top">
          <div class="seal">${unlocked ? '★' : '☆'}</div>
          <div class="name">${esc(a.name || a.id || '???')}</div>
        </div>
        <div class="desc">${esc(a.desc || '')}</div>
        ${showProg ? `
          <div class="ach-progress"><div class="pf" style="width:${fracPct.toFixed(1)}%;"></div></div>
          <div class="ach-progress-label">${Math.floor(prog.current)} / ${prog.target}</div>
        ` : ''}
      </div>
    `;
  }

  // ── Daily ────────────────────────────────────────────────────────

  _renderDaily() {
    const d = this._data.daily || {};
    const today = d.date || new Date().toISOString().slice(0, 10);
    const seed = d.seed != null ? String(d.seed) : this._defaultDailySeed(today);
    const best = d.best || null;
    const current = d.current || null;

    const html = `
      <h2 class="meta-title">Daily Seed</h2>
      <p class="meta-sub">One shared run per day · same seed for everyone.</p>

      <div class="daily-hero">
        <div class="seed-block">
          <div class="seed-label">Today's Seed</div>
          <div class="seed-value">${esc(seed)}</div>
          <div class="date">${esc(today)}</div>
        </div>
        <button class="start-btn" data-focusable="1" type="button"
                ${current && current.active ? 'disabled' : ''}>
          ${current && current.active ? 'In Progress…' : 'Start Daily Run'}
        </button>
      </div>

      <div class="daily-stats">
        <div class="stat-card">
          <span class="label">Personal Best</span>
          <span class="value">${best ? Number(best.score || 0).toLocaleString() : '—'}</span>
          ${best ? `
            <span style="font-size:10px;letter-spacing:0.18em;color:rgba(207,233,255,0.55);margin-top:4px;">
              ${best.biome != null ? `Biome ${esc(best.biome)} · ` : ''}${best.waves != null ? `${esc(best.waves)} waves` : ''}
              ${best.date ? ` · ${esc(best.date)}` : ''}
            </span>
          ` : `
            <span style="font-size:10px;letter-spacing:0.18em;color:rgba(207,233,255,0.45);margin-top:4px;">
              No daily run completed yet.
            </span>
          `}
        </div>
        <div class="stat-card">
          <span class="label">Current Run</span>
          <span class="value">${current ? Number(current.score || 0).toLocaleString() : '—'}</span>
          <span style="font-size:10px;letter-spacing:0.18em;color:rgba(207,233,255,0.55);margin-top:4px;">
            ${current
              ? (current.active ? 'Daily run in progress…' : 'Last attempt')
              : `Press Start to begin today's run.`}
          </span>
        </div>
      </div>

      <div style="margin-top:18px; padding:14px 16px; background:rgba(6,12,28,0.5);
                  border:1px dashed rgba(120,200,255,0.18); border-radius:6px;
                  font-size:10px; letter-spacing:0.04em; line-height:1.6;
                  color:rgba(207,233,255,0.55); text-transform:none;">
        Daily seeds reset at <strong style="color:#cfe9ff;">00:00 UTC</strong>.
        Your score is recorded locally. Runs in daily mode use the published
        seed for biome layout, enemy waves, and shop inventory — making them
        fair to compare with the community.
      </div>
    `;
    this._body.innerHTML = html;

    const startBtn = this._body.querySelector('.start-btn');
    if (startBtn) {
      startBtn.addEventListener('click', () => {
        if (startBtn.hasAttribute('disabled')) return;
        this.bus?.emit?.('daily:start', { seed });
      });
    }
  }

  /** Stable fallback seed derived from the date when no daily.js is wired yet. */
  _defaultDailySeed(dateStr) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < dateStr.length; i++) {
      h ^= dateStr.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return `OMEGA-${dateStr.replace(/-/g, '')}-${h.toString(16).toUpperCase().padStart(8, '0')}`;
  }
}

export { SCREEN_TYPES as META_SCREEN_TYPES };
export default MetaScreens;
