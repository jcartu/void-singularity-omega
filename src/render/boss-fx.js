// BossFX — boss-specific visual spectacle.
//
// Responsibilities:
//   * Phase-transition cinematic: lensing spike + chromatic shockwave ring +
//     particle eruption + heavy screen shake + bright flash. Tier-degraded.
//   * Per-boss signature visuals that continuously decorate the boss while
//     it lives (fog tendrils, lava trail, pulse rings, debris orbit, gravity
//     distortion, singularity collapse).
//   * Spawn + death stingers.
//
// Design rules (from sprint goals):
//   * Reuse existing systems: VFXManager (rings, hits), ParticleManager
//     (sparks/accretion bursts), ScreenFX (shake/flash/speedlines),
//     HitFeelManager (juice coordination), PostFX (lensing/CA pokes).
//     NEVER creates new shader pipelines or render passes.
//   * No audio.
//   * Particle bursts capped by tier and global ParticleManager headroom.
//   * Phase events from boss framework arrive via bus 'boss:phase' with
//     payload `{ bossId, phase, x, z }` (audio-hooks reads the same shape).
//
// Tier degradation (intensity ramp):
//   ultra:  all effects, full counts, full lensing/CA spike.
//   high:   all effects, ~70% particle counts, lensing/CA spike.
//   medium: screen FX + basic particles, NO lensing/CA spike.
//   low:    screen shake + flash only.
//
// Public API:
//   const bfx = new BossFX({ vfx, particles, screenFX, hitfeel, postfx, bus, tier });
//   bfx.onBossSpawn(bossId, pos);
//   bfx.onPhaseTransition(bossId, phaseIndex, pos);
//   bfx.onBossDeath(bossId, pos);
//   bfx.update(dt, bossState);   // bossState: { id, position:{x,y,z}, hpFrac, alive }
//   bfx.setTier(tier);
//   bfx.dispose();

const _TMP_POS = { x: 0, y: 0, z: 0 };

// Per-boss palette + signature config. Hex colors picked to match biome
// palettes in vfx.js so the boss "fits" its arena.
const BOSS_CONFIG = Object.freeze({
  'void-reaver': {
    color: 0xb37bff,
    accentColor: 0x6a3ad6,
    signature: 'fog-tendrils',
    signatureRate: 12, // particles/sec
  },
  'magma-titan': {
    color: 0xff7022,
    accentColor: 0xffd060,
    signature: 'lava-trail',
    signatureRate: 18,
  },
  'pulse-warden': {
    color: 0x3ad6ff,
    accentColor: 0x88f0ff,
    signature: 'pulse-rings',
    signatureRate: 0,      // rings emitted on a 0.6s cadence below
    pulsePeriod: 0.6,
  },
  'scrap-collector': {
    color: 0xc8aa55,
    accentColor: 0xff8844,
    signature: 'debris-orbit',
    signatureRate: 10,
  },
  'horizon-eater': {
    color: 0xff2a8a,
    accentColor: 0x5a0028,
    signature: 'gravity-distortion',
    signatureRate: 22,
  },
  'omega-core': {
    color: 0xffffff,
    accentColor: 0xa080ff,
    signature: 'singularity',
    signatureRate: 28,
    pulsePeriod: 0.45,
  },
});

const DEFAULT_CONFIG = Object.freeze({
  color: 0xffffff, accentColor: 0xaaaaaa, signature: null, signatureRate: 0,
});

// Tier → effect-enable + intensity multipliers.
const TIER_PROFILE = Object.freeze({
  ultra:  { particleMul: 1.00, sigRateMul: 1.00, lensSpike: true,  ringEnabled: true,  signatures: true },
  high:   { particleMul: 0.70, sigRateMul: 0.70, lensSpike: true,  ringEnabled: true,  signatures: true },
  medium: { particleMul: 0.45, sigRateMul: 0.40, lensSpike: false, ringEnabled: true,  signatures: true },
  low:    { particleMul: 0.00, sigRateMul: 0.00, lensSpike: false, ringEnabled: false, signatures: false },
});

function _tierProfile(t) { return TIER_PROFILE[t] ?? TIER_PROFILE.medium; }
function _bossConfig(id)  { return BOSS_CONFIG[id]    ?? DEFAULT_CONFIG; }

export class BossFX {
  /**
   * @param {object} opts
   * @param {*} [opts.vfx]       VFXManager — rings & hit flashes
   * @param {*} [opts.particles] ParticleManager — bursts
   * @param {*} [opts.screenFX]  ScreenFX — shake/flash/speed lines
   * @param {*} [opts.hitfeel]   HitFeelManager — well surge / shake coordination
   * @param {*} [opts.postfx]    PostFX — lensing/CA intensity poke
   * @param {*} [opts.bus]       EventBus — subscribes to 'boss:phase'
   * @param {string} [opts.tier] 'ultra'|'high'|'medium'|'low'
   */
  constructor({
    vfx = null, particles = null, screenFX = null, hitfeel = null,
    postfx = null, bus = null, tier = 'medium',
  } = {}) {
    this.vfx = vfx;
    this.particles = particles;
    this.screenFX = screenFX;
    this.hitfeel = hitfeel;
    this.postfx = postfx;
    this.bus = bus;
    this.tier = tier;
    this.profile = _tierProfile(tier);
    this._disposed = false;

    // Active boss tracking. We track one primary boss for signature emission;
    // can be extended to a small set if multi-boss waves are added.
    this._activeBossId = null;
    this._sigAccum = 0;
    this._pulseAccum = 0;

    // PostFX baseline snapshot (so we can return values after a spike).
    this._lensBaseline = postfx?.nodes?.lensing?.intensity ?? null;
    this._caBaseline   = postfx?.nodes?.ca?.intensity ?? null;
    this._lensSpike = { active: false, t: 0, duration: 0, peak: 0 };
    this._caSpike   = { active: false, t: 0, duration: 0, peak: 0 };

    // Bus wiring.
    this._unsubs = [];
    if (bus && typeof bus.on === 'function') {
      // Phase transitions
      try {
        this._unsubs.push(bus.on('boss:phase', (ev) => {
          if (!ev) return;
          const pos = { x: ev.x ?? 0, y: ev.y ?? 0, z: ev.z ?? 0 };
          this.onPhaseTransition(ev.bossId ?? ev.id ?? null, ev.phase ?? 0, pos);
        }));
      } catch (_) { /* dev-bus may reject */ }
      // Spawn/death are optional (boss framework emits when wired).
      try {
        this._unsubs.push(bus.on('boss:encounter', (ev) => {
          if (!ev) return;
          const pos = { x: ev.x ?? 0, y: ev.y ?? 0, z: ev.z ?? 0 };
          this.onBossSpawn(ev.bossId ?? ev.id ?? null, pos);
        }));
      } catch (_) { /* may not exist */ }
      try {
        this._unsubs.push(bus.on('boss:killed', (ev) => {
          if (!ev) return;
          const pos = { x: ev.x ?? 0, y: ev.y ?? 0, z: ev.z ?? 0 };
          this.onBossDeath(ev.bossId ?? ev.id ?? null, pos);
        }));
      } catch (_) { /* may not exist */ }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tier
  // ─────────────────────────────────────────────────────────────────────────
  setTier(tier) {
    this.tier = tier;
    this.profile = _tierProfile(tier);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public triggers
  // ─────────────────────────────────────────────────────────────────────────

  onBossSpawn(bossId, pos) {
    if (this._disposed) return;
    const cfg = _bossConfig(bossId);
    this._activeBossId = bossId;
    this._sigAccum = 0;
    this._pulseAccum = 0;

    // Subtle but unmistakable: tight ring + sparks ring + medium shake + flash.
    if (this.profile.ringEnabled && this.vfx) {
      this.vfx.spawnExplosion(pos, cfg.color, 1.4);
    }
    this._burstSparks(pos, cfg.color, 28);
    if (this.screenFX) {
      this.screenFX.shake('medium', 0.9, 0.32);
      this.screenFX.flash(this._hexCss(cfg.color), 0.35, 0.18);
    }
  }

  onPhaseTransition(bossId, phaseIndex, pos) {
    if (this._disposed) return;
    const cfg = _bossConfig(bossId);
    const prof = this.profile;
    // Phase index scales spectacle: later phases hit harder.
    const phaseScale = 1 + Math.min(2, (phaseIndex ?? 0)) * 0.18;

    // --- Heavy screen FX ---
    if (this.screenFX) {
      this.screenFX.shake('heavy', 1.0 * phaseScale, 0.45);
      this.screenFX.flash('#ffffff', 0.45, 0.10);
      this.screenFX.flash(this._hexCss(cfg.accentColor), 0.35, 0.20);
      this.screenFX.speedLines(null, 0.5);
    }

    // --- Chromatic shockwave: expanding ring at boss position ---
    if (prof.ringEnabled && this.vfx) {
      this.vfx.spawnExplosion(pos, cfg.color,       2.4 * phaseScale);
      // Second offset ring in accent hue gives the "shockwave" double-edge.
      this.vfx.spawnExplosion(pos, cfg.accentColor, 1.6 * phaseScale);
    }

    // --- Particle eruption ---
    const burstN = Math.floor(80 * phaseScale * prof.particleMul);
    this._burstSparks(pos, cfg.color, burstN);

    // --- Hit-feel coordination: pulse to scale enemies near boss + bus event ---
    if (this.hitfeel && typeof this.hitfeel.wellSurge === 'function') {
      try {
        this.hitfeel.wellSurge({
          x: pos.x ?? 0, z: pos.z ?? 0,
          strength: 1.4 * phaseScale, radius: 14,
        });
      } catch (_) { /* hitfeel may not be ready */ }
    }

    // --- Lensing spike (ultra/high only) ---
    if (prof.lensSpike) {
      this._spikeLensing(0.55 * phaseScale, 0.6);
      this._spikeCA(0.85 * phaseScale, 0.4);
    }

    // Make this boss the active one for signature emission.
    if (bossId) this._activeBossId = bossId;
  }

  onBossDeath(bossId, pos) {
    if (this._disposed) return;
    const cfg = _bossConfig(bossId);
    const prof = this.profile;

    // Sustained collapse: multi-ring + huge spark burst + heavy shake + bright flash.
    if (prof.ringEnabled && this.vfx) {
      this.vfx.spawnExplosion(pos, cfg.color,       3.2);
      this.vfx.spawnExplosion(pos, cfg.accentColor, 2.2);
      this.vfx.spawnExplosion(pos, 0xffffff,        1.2);
    }
    this._burstSparks(pos, cfg.color,       Math.floor(140 * prof.particleMul));
    this._burstSparks(pos, cfg.accentColor, Math.floor( 80 * prof.particleMul));
    if (this.screenFX) {
      this.screenFX.shake('heavy', 1.2, 0.55);
      this.screenFX.flash('#ffffff', 0.5, 0.22);
      this.screenFX.speedLines(null, 0.55);
    }
    if (prof.lensSpike) {
      this._spikeLensing(0.7, 0.9);
      this._spikeCA(1.0, 0.7);
    }

    if (this._activeBossId === bossId) this._activeBossId = null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Per-frame
  // ─────────────────────────────────────────────────────────────────────────
  update(dt, bossState = null) {
    if (this._disposed) return;
    if (!Number.isFinite(dt) || dt <= 0) return;

    // Decay any active postfx spikes back to baseline.
    this._tickSpike(this._lensSpike, 'lensing', this._lensBaseline, dt);
    this._tickSpike(this._caSpike,   'ca',      this._caBaseline,   dt);

    // Continuous signature emission for the active boss.
    if (!this.profile.signatures || !this.particles) return;
    if (!bossState || bossState.alive === false) return;
    const id = bossState.id ?? this._activeBossId;
    if (!id) return;
    const cfg = _bossConfig(id);
    if (!cfg.signature) return;
    const pos = bossState.position;
    if (!pos) return;

    const rate = cfg.signatureRate * this.profile.sigRateMul;
    if (rate > 0) {
      this._sigAccum += dt * rate;
      const n = this._sigAccum | 0;
      if (n > 0) {
        this._sigAccum -= n;
        this._emitSignature(cfg, pos, n);
      }
    }

    // Periodic ring pulses (Pulse Warden / Omega Core).
    if (cfg.pulsePeriod && this.vfx && this.profile.ringEnabled) {
      this._pulseAccum += dt;
      while (this._pulseAccum >= cfg.pulsePeriod) {
        this._pulseAccum -= cfg.pulsePeriod;
        this.vfx.spawnExplosion(pos, cfg.color, 1.1);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────────────────────────────────

  _emitSignature(cfg, pos, n) {
    const x = pos.x ?? 0, y = pos.y ?? 0.2, z = pos.z ?? 0;
    _TMP_POS.x = x; _TMP_POS.y = y; _TMP_POS.z = z;

    switch (cfg.signature) {
      case 'fog-tendrils':
        // Slow upward drifters tinted purple.
        this.particles.emit('sparks', _TMP_POS, n, {
          colorHex: cfg.accentColor, speed: 3, life: 1.8, size: 0.32,
        });
        break;

      case 'lava-trail':
        // Bright, fast embers.
        this.particles.emit('sparks', _TMP_POS, n, {
          colorHex: cfg.color, speed: 11, life: 0.7, size: 0.22,
        });
        break;

      case 'pulse-rings':
        // Thin radial sparks; rings come from cfg.pulsePeriod path.
        this.particles.emit('sparks', _TMP_POS, n, {
          colorHex: cfg.accentColor, speed: 14, life: 0.45, size: 0.16,
        });
        break;

      case 'debris-orbit':
        // Mixed orange/gold sparks with sideways drift (uses sparks burst).
        this.particles.emit('sparks', _TMP_POS, n, {
          colorHex: cfg.color, speed: 8, life: 1.0, size: 0.20,
        });
        break;

      case 'gravity-distortion':
        // Inward-pulled magenta wisps — accretion system pulls toward gravity.
        this.particles.emit('accretion', _TMP_POS, n, {
          outerRadius: 6, tangentialSpeed: 5, inwardSpeed: 1.8,
          life: 1.4, size: 0.16,
        });
        break;

      case 'singularity':
        // The kitchen sink: white-hot sparks + tendril drift.
        this.particles.emit('sparks', _TMP_POS, n, {
          colorHex: 0xffffff, speed: 13, life: 0.6, size: 0.20,
        });
        this.particles.emit('accretion', _TMP_POS, n >> 1, {
          outerRadius: 7, tangentialSpeed: 9, inwardSpeed: 1.2,
          life: 1.2, size: 0.14,
        });
        break;

      default:
        break;
    }
  }

  _burstSparks(pos, colorHex, n) {
    if (!this.particles || n <= 0) return;
    _TMP_POS.x = pos.x ?? 0;
    _TMP_POS.y = pos.y ?? 0.2;
    _TMP_POS.z = pos.z ?? 0;
    this.particles.emit('sparks', _TMP_POS, n | 0, {
      colorHex, speed: 18, life: 0.8, size: 0.24,
    });
  }

  _spikeLensing(peakDelta, duration) {
    if (!this.postfx || this.postfx.nodes?.lensing == null) return;
    const node = this.postfx.nodes.lensing;
    if (!node.enabled) return;
    if (this._lensBaseline == null) this._lensBaseline = node.intensity ?? 0;
    const peak = Math.min(1, this._lensBaseline + Math.max(0, peakDelta));
    this._setPostfx('lensing', peak);
    this._lensSpike.active = true;
    this._lensSpike.t = 0;
    this._lensSpike.duration = Math.max(0.05, duration);
    this._lensSpike.peak = peak;
  }

  _spikeCA(peakDelta, duration) {
    if (!this.postfx || this.postfx.nodes?.ca == null) return;
    const node = this.postfx.nodes.ca;
    if (!node.enabled) return;
    if (this._caBaseline == null) this._caBaseline = node.intensity ?? 0;
    const peak = Math.min(1, this._caBaseline + Math.max(0, peakDelta));
    this._setPostfx('ca', peak);
    this._caSpike.active = true;
    this._caSpike.t = 0;
    this._caSpike.duration = Math.max(0.05, duration);
    this._caSpike.peak = peak;
  }

  _tickSpike(spike, name, baseline, dt) {
    if (!spike.active) return;
    spike.t += dt;
    const u = spike.t / spike.duration;
    if (u >= 1) {
      spike.active = false;
      if (baseline != null) this._setPostfx(name, baseline);
      return;
    }
    // Ease-out from peak back to baseline.
    const base = baseline ?? 0;
    const v = base + (spike.peak - base) * (1 - u) * (1 - u);
    this._setPostfx(name, v);
  }

  _setPostfx(name, v) {
    if (!this.postfx) return;
    if (typeof this.postfx.setIntensity === 'function') {
      try { this.postfx.setIntensity(name, v); return; } catch (_) { /* fall through */ }
    }
    const node = this.postfx.nodes?.[name];
    if (node) node.intensity = v;
    if (this.postfx._u?.[name]) this.postfx._u[name].value = v;
  }

  _hexCss(hex) {
    const v = (hex >>> 0) & 0xffffff;
    return `#${v.toString(16).padStart(6, '0')}`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const off of this._unsubs) { try { off(); } catch (_) { /* ignore */ } }
    this._unsubs.length = 0;
    // Restore postfx baselines if we were mid-spike.
    if (this._lensSpike.active && this._lensBaseline != null) this._setPostfx('lensing', this._lensBaseline);
    if (this._caSpike.active   && this._caBaseline   != null) this._setPostfx('ca',      this._caBaseline);
    this._lensSpike.active = false;
    this._caSpike.active   = false;
    this._activeBossId = null;
  }
}

export default BossFX;
