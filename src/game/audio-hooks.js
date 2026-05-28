// AudioHooks — bridge between gameplay systems and the audio module.
//
// Gameplay subsystems emit raw mechanical signals (enemy:hit, enemy:death,
// upgrade:picked, biome:enter, …). AudioHooks subscribes to those and
// re-emits *audio-shaped* events on the same bus so the audio module can
// stay a pure consumer:
//
//   sfx:fire        { pos:[x,y,z], weaponType, intensity }
//   sfx:hit         { pos, damage, isCrit, enemyType, intensity }
//   sfx:explode     { pos, enemyType, intensity }
//   sfx:pickup      { pos, kind, amount }
//   sfx:levelup     { id }
//   sfx:dash        { pos }
//   sfx:boss_phase  { pos, phase }
//   music:intensity { value }          // 0..1
//   music:biome     { biomeName, biome }
//   music:cue       { cueName, payload? }
//   duck:trigger    { amount, duration, reason }
//
// IMPORTANT:
//   - This module has zero audio-stack dependencies (no Tone, no AudioContext).
//   - If the audio module is absent, these events are simply unhandled — the
//     game keeps running.
//   - All scratch payloads are reused on the hot path (sfx:hit fires per
//     bullet). Listeners must NOT retain references; copy fields out.

const SCRATCH_FIRE     = { pos: [0, 0, 0], weaponType: '', intensity: 1 };
const SCRATCH_HIT      = { pos: [0, 0, 0], damage: 0, isCrit: false, enemyType: '', intensity: 1 };
const SCRATCH_EXPLODE  = { pos: [0, 0, 0], enemyType: '', intensity: 1 };
const SCRATCH_PICKUP   = { pos: [0, 0, 0], kind: '', amount: 0 };
const SCRATCH_LEVELUP  = { id: '' };
const SCRATCH_DASH     = { pos: [0, 0, 0] };
const SCRATCH_BOSS_PH  = { pos: [0, 0, 0], phase: 0 };
const SCRATCH_INTENS   = { value: 0 };
const SCRATCH_BIOME    = { biomeName: '', biome: '' };
const SCRATCH_CUE      = { cueName: '', payload: null };
const SCRATCH_DUCK     = { amount: 0.5, duration: 0.3, reason: '' };

/** Crit threshold: damage above this is flagged as a crit for the audio side. */
const CRIT_DAMAGE = 25;

/** Cadence of music:intensity re-emits (seconds). Intensity also re-emits on
 *  any meaningful jump regardless of cadence. */
const INTENSITY_TICK = 0.25;
const INTENSITY_JUMP = 0.08;

export class AudioHooks {
  /**
   * @param {object} deps
   * @param {import('../engine/events.js').EventBus} deps.bus
   * @param {{ getWaveState?: Function }} [deps.director]  optional, used for intensity
   * @param {{ alive?: boolean, health?: number, opts?: { maxHealth?: number } }} [deps.ship]
   */
  constructor({ bus, director = null, ship = null } = {}) {
    if (!bus) throw new Error('AudioHooks: bus required');
    this.bus = bus;
    this.director = director;
    this.ship = ship;

    this._unsubs = [];
    this._lastIntensity = -1;
    this._intensityClock = 0;
    this._lastBiome = null;

    this._wire();
  }

  setDirector(d) { this.director = d; }
  setShip(s) { this.ship = s; }

  // ---- public emit helpers (called from gameplay where no existing event maps) ----

  emitFire(pos, weaponType, intensity = 1) {
    SCRATCH_FIRE.pos[0] = pos[0]; SCRATCH_FIRE.pos[1] = pos[1]; SCRATCH_FIRE.pos[2] = pos[2];
    SCRATCH_FIRE.weaponType = weaponType || '';
    SCRATCH_FIRE.intensity = intensity;
    this.bus.emit('sfx:fire', SCRATCH_FIRE);
  }

  emitDash(pos) {
    SCRATCH_DASH.pos[0] = pos[0]; SCRATCH_DASH.pos[1] = pos[1]; SCRATCH_DASH.pos[2] = pos[2];
    this.bus.emit('sfx:dash', SCRATCH_DASH);
  }

  emitPickup(pos, kind = 'currency', amount = 0) {
    SCRATCH_PICKUP.pos[0] = pos[0]; SCRATCH_PICKUP.pos[1] = pos[1]; SCRATCH_PICKUP.pos[2] = pos[2];
    SCRATCH_PICKUP.kind = kind;
    SCRATCH_PICKUP.amount = amount;
    this.bus.emit('sfx:pickup', SCRATCH_PICKUP);
  }

  emitBossPhase(pos, phase) {
    SCRATCH_BOSS_PH.pos[0] = pos?.[0] ?? 0;
    SCRATCH_BOSS_PH.pos[1] = pos?.[1] ?? 0;
    SCRATCH_BOSS_PH.pos[2] = pos?.[2] ?? 0;
    SCRATCH_BOSS_PH.phase = phase | 0;
    this.bus.emit('sfx:boss_phase', SCRATCH_BOSS_PH);
    SCRATCH_DUCK.amount = 0.6; SCRATCH_DUCK.duration = 0.6; SCRATCH_DUCK.reason = 'boss_phase';
    this.bus.emit('duck:trigger', SCRATCH_DUCK);
  }

  /** Frame tick — pumps continuous music intensity from director/ship state. */
  update(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    this._intensityClock += dt;
    const target = this._computeIntensity();
    const jumped = Math.abs(target - this._lastIntensity) >= INTENSITY_JUMP;
    if (jumped || this._intensityClock >= INTENSITY_TICK) {
      this._intensityClock = 0;
      this._lastIntensity = target;
      SCRATCH_INTENS.value = target;
      this.bus.emit('music:intensity', SCRATCH_INTENS);
    }
  }

  dispose() {
    for (const off of this._unsubs) { try { off(); } catch { /* noop */ } }
    this._unsubs.length = 0;
  }

  // ---- internals ----------------------------------------------------------

  _wire() {
    const bus = this.bus;

    // Enemy hit -> sfx:hit (per bullet — hot path, scratch payload).
    this._unsubs.push(bus.on('enemy:hit', (ev) => {
      if (!ev) return;
      SCRATCH_HIT.pos[0] = ev.x ?? 0;
      SCRATCH_HIT.pos[1] = 0;
      SCRATCH_HIT.pos[2] = ev.z ?? 0;
      SCRATCH_HIT.damage = ev.damage ?? 0;
      SCRATCH_HIT.isCrit = (ev.damage ?? 0) >= CRIT_DAMAGE;
      SCRATCH_HIT.enemyType = ev.type ?? '';
      SCRATCH_HIT.intensity = SCRATCH_HIT.isCrit ? 1.0 : 0.6;
      bus.emit('sfx:hit', SCRATCH_HIT);
    }));

    // Enemy death -> sfx:explode. 'horizon' deaths get a slightly different
    // flavor via intensity; cleanup deaths are skipped (no audible event).
    this._unsubs.push(bus.on('enemy:death', (ev) => {
      if (!ev || ev.cause === 'cleanup') return;
      SCRATCH_EXPLODE.pos[0] = ev.x ?? 0;
      SCRATCH_EXPLODE.pos[1] = 0;
      SCRATCH_EXPLODE.pos[2] = ev.z ?? 0;
      SCRATCH_EXPLODE.enemyType = ev.type ?? '';
      SCRATCH_EXPLODE.intensity = ev.cause === 'horizon' ? 0.5 : 1.0;
      bus.emit('sfx:explode', SCRATCH_EXPLODE);
    }));

    // Currency pickup. Position unknown at the event site (currency is
    // abstract); audio side can localize to camera/player.
    this._unsubs.push(bus.on('currency:earned', (ev) => {
      if (!ev || (ev.amount || 0) <= 0) return;
      const p = this.ship?.position;
      SCRATCH_PICKUP.pos[0] = p?.x ?? 0;
      SCRATCH_PICKUP.pos[1] = p?.y ?? 0;
      SCRATCH_PICKUP.pos[2] = p?.z ?? 0;
      SCRATCH_PICKUP.kind = ev.source ?? 'currency';
      SCRATCH_PICKUP.amount = ev.amount;
      bus.emit('sfx:pickup', SCRATCH_PICKUP);
    }));

    // Upgrade picked -> sfx:levelup + brief duck so the stinger sits up.
    this._unsubs.push(bus.on('upgrade:picked', (ev) => {
      SCRATCH_LEVELUP.id = ev?.id ?? '';
      bus.emit('sfx:levelup', SCRATCH_LEVELUP);
      SCRATCH_DUCK.amount = 0.4; SCRATCH_DUCK.duration = 0.5; SCRATCH_DUCK.reason = 'levelup';
      bus.emit('duck:trigger', SCRATCH_DUCK);
    }));

    // Biome / run cues -> music:biome + music:cue.
    this._unsubs.push(bus.on('biome:enter', (ev) => {
      const name = ev?.name ?? ev?.biome ?? '';
      if (name === this._lastBiome) return;
      this._lastBiome = name;
      SCRATCH_BIOME.biomeName = name;
      SCRATCH_BIOME.biome = ev?.biome ?? '';
      bus.emit('music:biome', SCRATCH_BIOME);
    }));

    this._unsubs.push(bus.on('boss:encounter', (ev) => {
      SCRATCH_CUE.cueName = 'boss_intro';
      SCRATCH_CUE.payload = ev ?? null;
      bus.emit('music:cue', SCRATCH_CUE);
      SCRATCH_DUCK.amount = 0.5; SCRATCH_DUCK.duration = 1.0; SCRATCH_DUCK.reason = 'boss_intro';
      bus.emit('duck:trigger', SCRATCH_DUCK);
    }));

    this._unsubs.push(bus.on('boss:phase', (ev) => {
      this.emitBossPhase([ev?.x ?? 0, 0, ev?.z ?? 0], ev?.phase ?? 0);
    }));

    this._unsubs.push(bus.on('run:victory', (ev) => {
      SCRATCH_CUE.cueName = 'victory';
      SCRATCH_CUE.payload = ev ?? null;
      bus.emit('music:cue', SCRATCH_CUE);
    }));

    this._unsubs.push(bus.on('run:over', (ev) => {
      SCRATCH_CUE.cueName = 'death';
      SCRATCH_CUE.payload = ev ?? null;
      bus.emit('music:cue', SCRATCH_CUE);
      SCRATCH_DUCK.amount = 0.7; SCRATCH_DUCK.duration = 1.5; SCRATCH_DUCK.reason = 'death';
      bus.emit('duck:trigger', SCRATCH_DUCK);
    }));

    // Wave transitions feed intensity envelope (immediate kick on start).
    this._unsubs.push(bus.on('wave:start', () => {
      this._intensityClock = INTENSITY_TICK; // force re-emit next tick
    }));
    this._unsubs.push(bus.on('wave:complete', () => {
      this._intensityClock = INTENSITY_TICK;
    }));
  }

  /** Map director / ship state to a 0..1 intensity scalar. */
  _computeIntensity() {
    let value = 0.2; // ambient floor
    const ws = this.director?.getWaveState ? this.director.getWaveState() : null;
    if (ws) {
      // Progression ramps base from 0.25 → 0.7 across the run.
      const total = Math.max(1, ws.totalWaves || 25);
      const progress = Math.min(1, (ws.globalWave || 0) / total);
      value = 0.25 + progress * 0.45;
      // Active combat raises it; pending spawns + alive enemies count toward heat.
      const heat = Math.min(1, ((ws.enemiesAlive || 0) + (ws.enemiesPending || 0)) / 12);
      value += heat * 0.2;
      if (ws.isBoss) value = Math.max(value, 0.95);
      else if (ws.isBreather) value *= 0.7;
    }
    // Low-HP tension bump (ship near death tightens the mix).
    const ship = this.ship;
    if (ship && ship.alive !== false) {
      const maxH = ship.opts?.maxHealth ?? 100;
      const hpFrac = Math.max(0, Math.min(1, (ship.health ?? maxH) / maxH));
      if (hpFrac < 0.35) value += (0.35 - hpFrac) * 0.4;
    }
    return Math.max(0, Math.min(1, value));
  }
}

export default AudioHooks;
