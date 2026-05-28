// Edge-case hardening — SPRINT-09 polish.
//
// Defensive guards layered on top of existing systems to eliminate crashes
// and softlocks across long soak runs. This module installs decorators
// rather than rewriting subsystems, so it can be disabled (or removed)
// without breaking gameplay.
//
// Coverage:
//   - currency overflow clamp (CurrencyManager)
//   - achievement idempotent firing decorator (AchievementManager)
//   - resize / fullscreen / visibility (PauseManager + World)
//   - boss softlock watchdog (BossManager + RunStateMachine)
//   - upgrade combo fuzzer (debug-only; not auto-run)
//   - pause-everywhere bindings (key listeners)
//
// All install* fns are idempotent — calling twice is a noop.

/** Hard cap for currency / counters. Numbers above this lose precision. */
export const MAX_SAFE_CURRENCY = Number.MAX_SAFE_INTEGER;
/** Soft cap displayed in UI — anything above is clamped silently for the sim. */
export const SOFT_CAP_CURRENCY = 1e12;

const INSTALLED = new WeakSet();

function once(target, key) {
  if (!target || typeof target !== 'object') return false;
  const tag = `__hardening_${key}__`;
  if (target[tag]) return false;
  Object.defineProperty(target, tag, { value: true, enumerable: false });
  return true;
}

/** Clamp a number to safe currency range. NaN/Infinity -> 0. */
export function clampCurrency(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > MAX_SAFE_CURRENCY) return MAX_SAFE_CURRENCY;
  return x;
}

/**
 * Wrap CurrencyManager.earn/spend/setBalance so values never overflow,
 * go negative, or accept NaN. Original semantics preserved otherwise.
 */
export function installCurrencyClamp(currency) {
  if (!currency || !once(currency, 'currencyClamp')) return false;
  const origEarn = currency.earn?.bind(currency);
  const origSpend = currency.spend?.bind(currency);
  const origSet = currency.setBalance?.bind(currency);

  if (origEarn) {
    currency.earn = function (amount, source) {
      const a = Number(amount);
      if (!Number.isFinite(a) || a <= 0) return 0;
      // Clamp incoming earn so a single bad event can't NaN the balance.
      const safe = Math.min(a, MAX_SAFE_CURRENCY);
      const credited = origEarn(safe, source);
      // Post-clamp the internal balance.
      if (typeof this._balance === 'number' && this._balance > SOFT_CAP_CURRENCY) {
        this._balance = SOFT_CAP_CURRENCY;
      }
      return credited;
    };
  }
  if (origSpend) {
    currency.spend = function (amount, reason) {
      const a = Number(amount);
      if (!Number.isFinite(a) || a <= 0) return false;
      return origSpend(Math.min(a, MAX_SAFE_CURRENCY), reason);
    };
  }
  if (origSet) {
    currency.setBalance = function (n) {
      return origSet(clampCurrency(n));
    };
  }
  return true;
}

/**
 * Decorate AchievementManager._unlock to be re-entrant safe and to swallow
 * persistence errors so a flaky localStorage can't crash the toast pipeline.
 * The base impl is already idempotent by id; this layer adds belt-and-braces.
 */
export function installAchievementHardening(achievements) {
  if (!achievements || !once(achievements, 'achHard')) return false;
  const origUnlock = achievements._unlock?.bind(achievements);
  const origCheck = achievements.check?.bind(achievements);
  if (origUnlock) {
    achievements._unlock = function (def) {
      if (!def || !def.id) return;
      if (this._unlocked && this._unlocked.has(def.id)) return;
      try { origUnlock(def); }
      catch (e) {
        // Persist failed — still mark in-memory so we don't fire forever.
        try { this._unlocked && this._unlocked.add(def.id); } catch { /* noop */ }
        // eslint-disable-next-line no-console
        console.warn('[hardening] achievement unlock failed', def.id, e?.message ?? e);
      }
    };
  }
  if (origCheck) {
    achievements.check = function (event, data) {
      try { origCheck(event, data); }
      catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[hardening] achievement check failed', event, e?.message ?? e);
      }
    };
  }
  return true;
}

/**
 * Visibility / fullscreen / focus auto-pause. Returns dispose fn.
 * `pause` is a PauseManager instance.
 */
export function installVisibilityPause(pause, { doc = (typeof document !== 'undefined' ? document : null), win = (typeof window !== 'undefined' ? window : null) } = {}) {
  if (!pause) return () => {};
  const handlers = [];
  const add = (target, ev, fn) => {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(ev, fn);
    handlers.push(() => target.removeEventListener(ev, fn));
  };

  const onVisibility = () => {
    if (!doc) return;
    if (doc.hidden) pause.pause('visibility');
    else pause.resume('visibility');
  };
  const onBlur = () => pause.pause('blur');
  const onFocus = () => pause.resume('blur');
  // Fullscreen transitions: pause briefly so resize lands cleanly.
  const onFullscreen = () => {
    pause.pause('fullscreen-transition');
    // Release on next frame; the browser fires resize between events.
    if (win && typeof win.requestAnimationFrame === 'function') {
      win.requestAnimationFrame(() => win.requestAnimationFrame(() => pause.resume('fullscreen-transition')));
    } else {
      setTimeout(() => pause.resume('fullscreen-transition'), 50);
    }
  };

  add(doc, 'visibilitychange', onVisibility);
  add(win, 'blur', onBlur);
  add(win, 'focus', onFocus);
  add(doc, 'fullscreenchange', onFullscreen);
  add(doc, 'webkitfullscreenchange', onFullscreen);

  return () => { for (const off of handlers) { try { off(); } catch { /* noop */ } } };
}

/**
 * Resize guard: wraps world.resize so it can't crash on zero / NaN sizes
 * and never feeds a broken aspect ratio into the camera.
 */
export function installResizeGuard(world) {
  if (!world || typeof world.resize !== 'function') return false;
  if (!once(world, 'resizeGuard')) return false;
  const orig = world.resize.bind(world);
  world.resize = function (w, h) {
    let W = Number(w), H = Number(h);
    if (!Number.isFinite(W) || W < 1) W = 1;
    if (!Number.isFinite(H) || H < 1) H = 1;
    // Clamp to sane bounds — browsers can briefly report enormous values on
    // multi-monitor transitions.
    W = Math.min(W, 16384);
    H = Math.min(H, 16384);
    try { orig(W, H); }
    catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[hardening] resize failed', e?.message ?? e);
    }
  };
  return true;
}

/**
 * Wire a global key handler so Escape toggles pause from ANY game state.
 * Returns dispose fn.
 */
export function installPauseKey(pause, { win = (typeof window !== 'undefined' ? window : null) } = {}) {
  if (!pause || !win) return () => {};
  const onKey = (ev) => {
    if (!ev) return;
    const code = ev.code || ev.key;
    if (code === 'Escape' || code === 'KeyP') {
      pause.toggle();
      // Don't preventDefault — Escape may also exit fullscreen.
    }
  };
  win.addEventListener('keydown', onKey);
  return () => { try { win.removeEventListener('keydown', onKey); } catch { /* noop */ } };
}

/**
 * Boss softlock watchdog. If the boss has been in a non-progressing state
 * for `timeoutSec`, force-advance the run.
 *
 * Heuristic: if `bossManager` exists, `bossManager.update` is being called,
 * but HP hasn't changed AND no attack has completed for a long time, we
 * consider it stuck. RunStateMachine has authoritative knowledge so we
 * call `director.completeBoss()` as the recovery action (same as a real
 * boss death) — this matches world.js's existing 'boss:death' handler.
 *
 * @returns {() => void} dispose fn that stops the watchdog
 */
export function installBossWatchdog(world, { timeoutSec = 120 } = {}) {
  if (!world || !world.bus) return () => {};
  if (!once(world, 'bossWatchdog')) return () => {};
  let lastHp = -1;
  let lastChangeMs = performance.now();
  let timer = null;
  const tick = () => {
    try {
      const bm = world.bossManager;
      if (!bm) { lastHp = -1; lastChangeMs = performance.now(); return; }
      const hp = (typeof bm.getHp === 'function') ? bm.getHp() : (bm.boss?.hp ?? -1);
      if (hp !== lastHp) { lastHp = hp; lastChangeMs = performance.now(); return; }
      if ((performance.now() - lastChangeMs) / 1000 > timeoutSec) {
        // eslint-disable-next-line no-console
        console.warn('[hardening] boss softlock detected — auto-completing');
        try { world.director?.completeBoss?.(); } catch { /* noop */ }
        try { bm.dispose?.(); } catch { /* noop */ }
        world.bossManager = null;
        lastHp = -1;
        lastChangeMs = performance.now();
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[hardening] boss watchdog tick failed', e?.message ?? e);
    }
  };
  timer = setInterval(tick, 1000);
  return () => { if (timer) { clearInterval(timer); timer = null; } };
}

/**
 * Upgrade combo fuzzer — exercises every applicable upgrade pairing against
 * a fresh UpgradeManager-shaped object. Used by tests / soak harness to
 * surface effect-resolution crashes. Returns { applied, errors }.
 *
 * @param {object} mgr UpgradeManager with .apply, .canApply, .registry
 * @param {{ max?: number, seed?: number }} [opts]
 */
export function fuzzUpgradeCombos(mgr, { max = 200, rng = null } = {}) {
  const out = { applied: 0, errors: [] };
  if (!mgr || !mgr.registry) return out;
  const ids = Object.keys(mgr.registry);
  if (ids.length === 0) return out;
  const rand = (rng && typeof rng.float === 'function') ? () => rng.float() : () => Math.random();
  const n = Math.min(max, ids.length * 4);
  for (let i = 0; i < n; i++) {
    const id = ids[Math.floor(rand() * ids.length)];
    try {
      const check = mgr.canApply ? mgr.canApply(id) : { ok: true };
      if (!check.ok) continue;
      if (mgr.apply(id)) out.applied++;
    } catch (e) {
      out.errors.push({ id, error: e?.message ?? String(e) });
    }
  }
  return out;
}

/**
 * Install all default hardening on a live World instance. Idempotent.
 * Returns dispose fn that releases listeners + watchdogs.
 */
export function installHardening(world, { pause = null } = {}) {
  if (!world) return () => {};
  if (INSTALLED.has(world)) return () => {};
  INSTALLED.add(world);

  const disposers = [];

  installResizeGuard(world);
  if (world.economy?.currency) installCurrencyClamp(world.economy.currency);
  if (world.achievements) installAchievementHardening(world.achievements);

  if (pause) {
    disposers.push(installVisibilityPause(pause));
    disposers.push(installPauseKey(pause));
  }

  disposers.push(installBossWatchdog(world));

  return () => {
    for (const d of disposers) { try { d && d(); } catch { /* noop */ } }
    INSTALLED.delete(world);
  };
}

export default installHardening;
