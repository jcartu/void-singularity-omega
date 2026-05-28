// VFX module — bullet trails, hit-flashes, death explosions, biome nebula bg.
//
// Design goals (per SPRINT-04 / Art & Juice):
//   - Bullets remain READABLE at max density. Trails are short, low-alpha,
//     hue-locked to the bullet so the eye reads a glowing line, never a haze.
//   - Hit-flash is brief (≤0.2s) and small (radius scales with damage, capped),
//     so it never occludes oncoming bullets.
//   - Explosions use an expanding ring + small spark burst — silhouette stays
//     legible against the background.
//   - Biome nebula is a SHADER on a large back-facing sphere. Low contrast,
//     low frequency, low brightness so foreground always wins.
//
// All effect pools are FIXED-CAPACITY, slot-allocated, zero per-frame alloc.
// Tier caps cap total active VFX instances so we never exceed the budget the
// renderer was provisioned for.
//
// Public API (matches sprint spec):
//   new VFXManager({ renderer, scene, camera, bus, tier })
//   .setBulletMaterial(weaponId, materialOrSpec)
//   .getBulletMaterial(weaponId)  → returns Three.Material for ProjectilePool use
//   .spawnHit(pos, color, damage)
//   .spawnExplosion(pos, color, size)
//   .trackBullet(id, x, y, z, color, size)   // optional, called from pool.update
//   .setBiomePalette(biomeName)
//   .update(dt)
//   .dispose()
//
// The constructor accepts `scene` (required for attaching meshes). The spec
// names {renderer,bus,tier}; we accept those plus scene/camera which are the
// minimal additions any real implementation requires.

import {
  SphereGeometry, RingGeometry, MeshBasicMaterial, AdditiveBlending,
  ShaderMaterial, BackSide, Mesh, Color, DoubleSide,
} from 'three';
import { InstancedRenderer } from './instancing.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tier configuration. Hard caps so we cannot blow the budget at peak density.
// ─────────────────────────────────────────────────────────────────────────────

export const VFX_TIER_CAPS = Object.freeze({
  ultra:  { hits: 256, explosions: 128, trails: 1024, trailSegments: 5, trailEnabled: true },
  high:   { hits: 192, explosions:  96, trails:  768, trailSegments: 4, trailEnabled: true },
  medium: { hits: 128, explosions:  48, trails:  384, trailSegments: 3, trailEnabled: true },
  low:    { hits:  64, explosions:  24, trails:    0, trailSegments: 0, trailEnabled: false },
});

function vfxTierCap(tier) { return VFX_TIER_CAPS[tier] ?? VFX_TIER_CAPS.medium; }

// ─────────────────────────────────────────────────────────────────────────────
// Biome palettes. Three colors per biome: { a: deep, b: mid, c: bright accent }.
// Tuned for low overall luminance so HUD + bullets read clearly on top.
// ─────────────────────────────────────────────────────────────────────────────

export const BIOME_PALETTES = Object.freeze({
  nebula:           { a: 0x1a0a36, b: 0x2c1a7a, c: 0x3ad6ff },   // purple/blue/cyan
  accretion:        { a: 0x2a0a00, b: 0x8a2a00, c: 0xffb046 },   // orange/yellow/red
  event_horizon:    { a: 0x180008, b: 0x5a0028, c: 0xff2a8a },   // deep red/magenta
  singularity_core: { a: 0x0a0014, b: 0x5a3aa0, c: 0xf2eaff },   // white/violet/black
  omega:            { a: 0x1a1a1a, b: 0x7a7a9a, c: 0xffffff },   // all → white
});

// Default fallback palette = nebula.
const DEFAULT_BIOME = 'nebula';

// ─────────────────────────────────────────────────────────────────────────────
// Background nebula shader. Cheap hash-based 3D noise, layered twice, tinted
// by the biome 3-color palette. Kept dim & low-contrast.
// ─────────────────────────────────────────────────────────────────────────────

const _BG_VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const _BG_FRAG = /* glsl */`
  precision mediump float;
  varying vec3 vDir;
  uniform vec3 uColA;
  uniform vec3 uColB;
  uniform vec3 uColC;
  uniform float uTime;
  uniform float uIntensity;

  // Cheap 3D value-noise via hash. No texture sampling.
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash(i + vec3(0,0,0));
    float n100 = hash(i + vec3(1,0,0));
    float n010 = hash(i + vec3(0,1,0));
    float n110 = hash(i + vec3(1,1,0));
    float n001 = hash(i + vec3(0,0,1));
    float n101 = hash(i + vec3(1,0,1));
    float n011 = hash(i + vec3(0,1,1));
    float n111 = hash(i + vec3(1,1,1));
    float nx00 = mix(n000, n100, f.x);
    float nx10 = mix(n010, n110, f.x);
    float nx01 = mix(n001, n101, f.x);
    float nx11 = mix(n011, n111, f.x);
    float nxy0 = mix(nx00, nx10, f.y);
    float nxy1 = mix(nx01, nx11, f.y);
    return mix(nxy0, nxy1, f.z);
  }

  void main() {
    vec3 d = vDir;
    // Two octaves of layered noise, drifting slowly.
    float n1 = vnoise(d * 2.5 + vec3(0.0, uTime * 0.01, 0.0));
    float n2 = vnoise(d * 6.0 + vec3(uTime * 0.02, 0.0, uTime * 0.015));
    float cloud = n1 * 0.65 + n2 * 0.35;
    // Star-ish bright spots (only the very top end).
    float stars = step(0.985, hash(floor(d * 220.0)));
    // Blend palette by noise levels.
    vec3 base = mix(uColA, uColB, smoothstep(0.2, 0.7, cloud));
    base = mix(base, uColC, smoothstep(0.78, 1.0, cloud) * 0.55);
    base += vec3(stars) * uColC * 0.7;
    // Dim global intensity so foreground (bullets, enemies) always wins.
    gl_FragColor = vec4(base * uIntensity, 1.0);
  }
`;

function _hexToVec3(hex) {
  const c = new Color(hex);
  return [c.r, c.g, c.b];
}

// ─────────────────────────────────────────────────────────────────────────────
// VFXManager
// ─────────────────────────────────────────────────────────────────────────────

const _white = new Color(0xffffff);
const _tmpColor = new Color();

export class VFXManager {
  /**
   * @param {object} opts
   * @param {*} opts.renderer  Three renderer (for capability info; not strictly needed at runtime)
   * @param {*} opts.scene     Three.Scene to attach VFX meshes
   * @param {*} [opts.camera]  Optional camera; background follows camera if provided
   * @param {*} [opts.bus]     EventBus — subscribes to 'bullet:hit' & 'enemy:death'
   * @param {string} [opts.tier] 'ultra'|'high'|'medium'|'low'
   */
  constructor({ renderer, scene, camera = null, bus = null, tier = 'medium' } = {}) {
    if (!scene) throw new Error('VFXManager: scene required');
    this.renderer = renderer ?? null;
    this.scene = scene;
    this.camera = camera;
    this.bus = bus;
    this.tier = tier;
    this.caps = vfxTierCap(tier);
    this._disposed = false;
    this._time = 0;

    // Per-weapon bullet materials (caller decides how to apply to ProjectilePool).
    this._bulletMats = new Map();

    // ── HIT FLASH POOL ────────────────────────────────────────────────────
    // Small additive sphere; pulses bright then fades, white→bullet color.
    this._hitGeom = new SphereGeometry(0.5, 10, 8);
    this._hitMat = new MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 1.0,
      blending: AdditiveBlending, depthWrite: false,
    });
    this._hits = new InstancedRenderer({
      scene, geometry: this._hitGeom, material: this._hitMat,
      capacity: Math.max(1, this.caps.hits), mode: 'slot',
    });
    // SoA state for hits.
    const hCap = this.caps.hits;
    this._hitAlive = new Uint8Array(hCap);
    this._hitAge   = new Float32Array(hCap);
    this._hitLife  = new Float32Array(hCap);
    this._hitX     = new Float32Array(hCap);
    this._hitY     = new Float32Array(hCap);
    this._hitZ     = new Float32Array(hCap);
    this._hitR     = new Float32Array(hCap);   // base radius (peak)
    this._hitColR  = new Float32Array(hCap);   // bullet color rgb
    this._hitColG  = new Float32Array(hCap);
    this._hitColB  = new Float32Array(hCap);
    this._hitFree  = [];
    for (let i = hCap - 1; i >= 0; i--) this._hitFree.push(i);

    // ── EXPLOSION POOL ────────────────────────────────────────────────────
    // Expanding additive ring rendered as flat disk (RingGeometry).
    this._expGeom = new RingGeometry(0.85, 1.0, 36);
    this._expMat = new MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 1.0,
      blending: AdditiveBlending, depthWrite: false, side: DoubleSide,
    });
    this._exps = new InstancedRenderer({
      scene, geometry: this._expGeom, material: this._expMat,
      capacity: Math.max(1, this.caps.explosions), mode: 'slot',
    });
    const eCap = this.caps.explosions;
    this._expAlive = new Uint8Array(eCap);
    this._expAge   = new Float32Array(eCap);
    this._expLife  = new Float32Array(eCap);
    this._expX     = new Float32Array(eCap);
    this._expY     = new Float32Array(eCap);
    this._expZ     = new Float32Array(eCap);
    this._expMax   = new Float32Array(eCap);   // peak radius
    this._expColR  = new Float32Array(eCap);
    this._expColG  = new Float32Array(eCap);
    this._expColB  = new Float32Array(eCap);
    this._expFree  = [];
    for (let i = eCap - 1; i >= 0; i--) this._expFree.push(i);

    // ── TRAIL POOL ────────────────────────────────────────────────────────
    // Stream-mode: every frame, trackBullet() emits a short fade of dots.
    if (this.caps.trailEnabled && this.caps.trails > 0) {
      this._trailGeom = new SphereGeometry(0.12, 6, 4);
      this._trailMat = new MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.55,
        blending: AdditiveBlending, depthWrite: false,
      });
      this._trails = new InstancedRenderer({
        scene, geometry: this._trailGeom, material: this._trailMat,
        capacity: this.caps.trails, mode: 'slot',
      });
      const tCap = this.caps.trails;
      this._trailAlive = new Uint8Array(tCap);
      this._trailAge   = new Float32Array(tCap);
      this._trailLife  = new Float32Array(tCap);
      this._trailX     = new Float32Array(tCap);
      this._trailY     = new Float32Array(tCap);
      this._trailZ     = new Float32Array(tCap);
      this._trailScl   = new Float32Array(tCap);
      this._trailColR  = new Float32Array(tCap);
      this._trailColG  = new Float32Array(tCap);
      this._trailColB  = new Float32Array(tCap);
      this._trailFree  = [];
      for (let i = tCap - 1; i >= 0; i--) this._trailFree.push(i);
      // Per-bullet emission throttle so we drop ~one segment per ~0.04s.
      // Map id → last emit time. Bounded by bullet pool size; cleared lazily.
      this._lastEmit = new Map();
      this._trailInterval = 1 / 30; // 30 segments/sec/bullet, capped by pool
    } else {
      this._trails = null;
    }

    // ── BACKGROUND NEBULA ─────────────────────────────────────────────────
    const pal = BIOME_PALETTES[DEFAULT_BIOME];
    this._bgMat = new ShaderMaterial({
      vertexShader: _BG_VERT,
      fragmentShader: _BG_FRAG,
      side: BackSide,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uColA:      { value: _hexToVec3(pal.a) },
        uColB:      { value: _hexToVec3(pal.b) },
        uColC:      { value: _hexToVec3(pal.c) },
        uTime:      { value: 0 },
        uIntensity: { value: 0.55 }, // global dimmer; foreground beats bg
      },
    });
    this._bgGeom = new SphereGeometry(900, 32, 16);
    this._bg = new Mesh(this._bgGeom, this._bgMat);
    this._bg.frustumCulled = false;
    this._bg.renderOrder = -1000;
    scene.add(this._bg);
    this._biomeName = DEFAULT_BIOME;

    // ── BUS WIRING ────────────────────────────────────────────────────────
    this._unsubs = [];
    if (bus) {
      this._unsubs.push(bus.on('bullet:hit', (e) => {
        const col = e.color ?? 0xffffff;
        const dmg = e.damage ?? 10;
        this.spawnHit({ x: e.x ?? 0, y: e.y ?? 0, z: e.z ?? 0 }, col, dmg);
      }));
      this._unsubs.push(bus.on('enemy:death', (e) => {
        const col = e.color ?? 0xff6644;
        const size = e.size ?? e.radius ?? 1.0;
        this.spawnExplosion({ x: e.x ?? 0, y: e.y ?? 0, z: e.z ?? 0 }, col, size);
      }));
    }
  }

  // ── BULLET MATERIALS ───────────────────────────────────────────────────

  /**
   * Register or replace the material used for a weapon's bullets. Accepts
   * either a Three.Material instance, or a spec { color, size } from which
   * we build a standardized emissive additive material.
   *
   * The ProjectilePool today uses a single shared material; callers can
   * adopt per-weapon materials by reading getBulletMaterial(id) when
   * spawning, or by tinting per-instance color (preferred — keeps draw
   * count at 1). We retain the materials here for callers that want
   * unique geometry/material per weapon class.
   */
  setBulletMaterial(weaponId, materialOrSpec) {
    if (!weaponId) return;
    let mat = materialOrSpec;
    if (!mat || !mat.isMaterial) {
      const color = (materialOrSpec && materialOrSpec.color) ?? 0xffffff;
      mat = new MeshBasicMaterial({
        color, transparent: true, blending: AdditiveBlending, depthWrite: false,
      });
    }
    // Dispose any previous owned material for this slot.
    const prev = this._bulletMats.get(weaponId);
    if (prev && prev !== mat) prev.dispose?.();
    this._bulletMats.set(weaponId, mat);
  }

  getBulletMaterial(weaponId) { return this._bulletMats.get(weaponId) ?? null; }

  // ── HIT FLASH ──────────────────────────────────────────────────────────

  /**
   * @param {{x,y,z}} pos  Hit world position
   * @param {number} colorHex  Bullet color
   * @param {number} damage    Damage scalar (drives flash size)
   */
  spawnHit(pos, colorHex = 0xffffff, damage = 10) {
    if (this._disposed) return -1;
    const i = this._hitFree.pop();
    if (i === undefined) return -1;
    this._hitAlive[i] = 1;
    this._hitAge[i] = 0;
    // Brief: 0.10s base, +up to 0.10s with damage. Capped 0.20s.
    this._hitLife[i] = Math.min(0.20, 0.10 + Math.min(1, damage / 80) * 0.10);
    this._hitX[i] = pos.x ?? 0;
    this._hitY[i] = pos.y ?? 0;
    this._hitZ[i] = pos.z ?? 0;
    // Radius: 0.35..0.9 based on damage, capped so it never blocks bullets.
    this._hitR[i] = 0.35 + Math.min(1, damage / 60) * 0.55;
    _tmpColor.set(colorHex);
    this._hitColR[i] = _tmpColor.r;
    this._hitColG[i] = _tmpColor.g;
    this._hitColB[i] = _tmpColor.b;
    // Initial render at peak: white start, full scale.
    this._hits.setSlot(i, this._hitX[i], this._hitY[i], this._hitZ[i],
      this._hitR[i], 0, 0xffffff);
    return i;
  }

  // ── EXPLOSION ──────────────────────────────────────────────────────────

  /**
   * @param {{x,y,z}} pos
   * @param {number} colorHex  Enemy tint
   * @param {number} size      Enemy radius (≈0.5..2.0)
   */
  spawnExplosion(pos, colorHex = 0xff6644, size = 1.0) {
    if (this._disposed) return -1;
    const i = this._expFree.pop();
    if (i === undefined) return -1;
    this._expAlive[i] = 1;
    this._expAge[i] = 0;
    this._expLife[i] = 0.30 + Math.min(1, size / 2) * 0.20; // 0.3..0.5s
    this._expX[i] = pos.x ?? 0;
    this._expY[i] = pos.y ?? 0;
    this._expZ[i] = pos.z ?? 0;
    // Peak radius: 2..6 game units scaled by enemy size.
    this._expMax[i] = 2.0 + size * 2.5;
    _tmpColor.set(colorHex);
    this._expColR[i] = _tmpColor.r;
    this._expColG[i] = _tmpColor.g;
    this._expColB[i] = _tmpColor.b;
    this._exps.setSlot(i, this._expX[i], this._expY[i], this._expZ[i],
      0.01, 0, colorHex);
    return i;
  }

  // ── TRAILS ─────────────────────────────────────────────────────────────

  /**
   * Optional integration hook. Call once per bullet per frame from
   * ProjectilePool.update — we throttle emission internally so density
   * stays bounded regardless of bullet count.
   *
   * @param {number} bulletId  Stable bullet slot id (used for throttling)
   * @param {number} x         Bullet position x
   * @param {number} y         Bullet position y
   * @param {number} z         Bullet position z
   * @param {number} colorHex  Bullet color
   * @param {number} size      Bullet size multiplier (drives trail thickness)
   */
  trackBullet(bulletId, x, y, z, colorHex = 0xffffff, size = 1) {
    if (!this._trails || this._disposed) return;
    const last = this._lastEmit.get(bulletId) ?? 0;
    if (this._time - last < this._trailInterval) return;
    this._lastEmit.set(bulletId, this._time);
    const i = this._trailFree.pop();
    if (i === undefined) return;
    this._trailAlive[i] = 1;
    this._trailAge[i] = 0;
    // Short life (≤0.2s) → 3..5 segments visible per bullet at 30Hz emit.
    this._trailLife[i] = this._caps_trailLife();
    this._trailX[i] = x;
    this._trailY[i] = y;
    this._trailZ[i] = z;
    // Thickness 0.1..0.3 driven by bullet size, clamped.
    this._trailScl[i] = Math.max(0.1, Math.min(0.30, 0.10 + size * 0.12));
    _tmpColor.set(colorHex);
    this._trailColR[i] = _tmpColor.r;
    this._trailColG[i] = _tmpColor.g;
    this._trailColB[i] = _tmpColor.b;
    this._trails.setSlot(i, x, y, z, this._trailScl[i], 0, colorHex);
  }

  // Called once at trail spawn: derives a stable lifetime such that at the
  // configured 30Hz emit rate we get caps.trailSegments visible at once.
  _caps_trailLife() {
    return this._trailInterval * this.caps.trailSegments;
  }

  /** Release any throttle entries for a killed bullet id. */
  forgetBullet(bulletId) {
    if (this._lastEmit) this._lastEmit.delete(bulletId);
  }

  // ── BACKGROUND ─────────────────────────────────────────────────────────

  /**
   * @param {string} biomeName  one of BIOME_PALETTES keys
   */
  setBiomePalette(biomeName) {
    const pal = BIOME_PALETTES[biomeName] ?? BIOME_PALETTES[DEFAULT_BIOME];
    this._biomeName = biomeName in BIOME_PALETTES ? biomeName : DEFAULT_BIOME;
    const u = this._bgMat.uniforms;
    const a = _hexToVec3(pal.a);
    const b = _hexToVec3(pal.b);
    const c = _hexToVec3(pal.c);
    u.uColA.value[0] = a[0]; u.uColA.value[1] = a[1]; u.uColA.value[2] = a[2];
    u.uColB.value[0] = b[0]; u.uColB.value[1] = b[1]; u.uColB.value[2] = b[2];
    u.uColC.value[0] = c[0]; u.uColC.value[1] = c[1]; u.uColC.value[2] = c[2];
  }

  getBiomeName() { return this._biomeName; }

  // ── UPDATE ─────────────────────────────────────────────────────────────

  update(dt) {
    if (this._disposed) return;
    if (!Number.isFinite(dt) || dt < 0) return;
    this._time += dt;
    this._bgMat.uniforms.uTime.value = this._time;

    // Background follows camera (so it never appears to translate).
    if (this.camera) {
      this._bg.position.copy(this.camera.position);
    }

    // -- HITS --
    {
      const hits = this._hits;
      const cap = this.caps.hits;
      for (let i = 0; i < cap; i++) {
        if (!this._hitAlive[i]) continue;
        this._hitAge[i] += dt;
        const t = this._hitAge[i] / this._hitLife[i];
        if (t >= 1) {
          this._hitAlive[i] = 0;
          hits.clearSlot(i);
          this._hitFree.push(i);
          continue;
        }
        // Scale: snaps up fast (first 20%), then shrinks.
        const s = t < 0.2 ? (t / 0.2) * this._hitR[i]
                          : this._hitR[i] * (1 - (t - 0.2) / 0.8);
        // Color: lerp from white → bullet color across life.
        const r = _white.r + (this._hitColR[i] - _white.r) * t;
        const g = _white.g + (this._hitColG[i] - _white.g) * t;
        const b = _white.b + (this._hitColB[i] - _white.b) * t;
        _tmpColor.setRGB(r, g, b);
        hits.setSlot(i, this._hitX[i], this._hitY[i], this._hitZ[i],
          Math.max(0.001, s), 0, _tmpColor.getHex());
      }
    }

    // -- EXPLOSIONS --
    {
      const exps = this._exps;
      const cap = this.caps.explosions;
      for (let i = 0; i < cap; i++) {
        if (!this._expAlive[i]) continue;
        this._expAge[i] += dt;
        const t = this._expAge[i] / this._expLife[i];
        if (t >= 1) {
          this._expAlive[i] = 0;
          exps.clearSlot(i);
          this._expFree.push(i);
          continue;
        }
        // Ring expands linearly, fades quadratically. Color stays at enemy hue.
        const r = this._expMax[i] * t;
        const fade = 1 - t * t;
        _tmpColor.setRGB(this._expColR[i] * fade, this._expColG[i] * fade, this._expColB[i] * fade);
        exps.setSlot(i, this._expX[i], this._expY[i], this._expZ[i],
          Math.max(0.001, r), 0, _tmpColor.getHex());
      }
    }

    // -- TRAILS --
    if (this._trails) {
      const tr = this._trails;
      const cap = this.caps.trails;
      for (let i = 0; i < cap; i++) {
        if (!this._trailAlive[i]) continue;
        this._trailAge[i] += dt;
        const t = this._trailAge[i] / this._trailLife[i];
        if (t >= 1) {
          this._trailAlive[i] = 0;
          tr.clearSlot(i);
          this._trailFree.push(i);
          continue;
        }
        const fade = 1 - t;
        // Shrink slightly + dim.
        const s = this._trailScl[i] * (0.6 + 0.4 * fade);
        _tmpColor.setRGB(this._trailColR[i] * fade, this._trailColG[i] * fade, this._trailColB[i] * fade);
        tr.setSlot(i, this._trailX[i], this._trailY[i], this._trailZ[i],
          Math.max(0.001, s), 0, _tmpColor.getHex());
      }
      tr.endFrame();
    }

    // Flush instance matrices/colors for hit + explosion renderers.
    this._hits.endFrame();
    this._exps.endFrame();
  }

  // ── INTROSPECTION ──────────────────────────────────────────────────────

  getActiveCount() {
    const hits = this.caps.hits - this._hitFree.length;
    const exps = this.caps.explosions - this._expFree.length;
    const trails = this._trails ? (this.caps.trails - this._trailFree.length) : 0;
    return { hits, explosions: exps, trails };
  }

  // ── LIFECYCLE ──────────────────────────────────────────────────────────

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const off of this._unsubs) { try { off(); } catch { /* ignore */ } }
    this._unsubs.length = 0;
    this._hits.dispose();
    this._exps.dispose();
    if (this._trails) this._trails.dispose();
    this.scene.remove(this._bg);
    this._hitGeom.dispose();
    this._hitMat.dispose();
    this._expGeom.dispose();
    this._expMat.dispose();
    if (this._trailGeom) this._trailGeom.dispose();
    if (this._trailMat)  this._trailMat.dispose();
    this._bgGeom.dispose();
    this._bgMat.dispose();
    for (const mat of this._bulletMats.values()) mat.dispose?.();
    this._bulletMats.clear();
    if (this._lastEmit) this._lastEmit.clear();
  }
}

export default VFXManager;
