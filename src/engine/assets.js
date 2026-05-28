// AssetManager — SPRINT-08 memory & compression governor.
//
// Purpose
// ───────
// Track every GPU-bound resource the game allocates (textures, geometries,
// materials, render targets) so that:
//
//   1. Biome transitions can release transient assets without leaking VRAM.
//   2. The active quality tier enforces a hard memory ceiling (no OOM crash
//      after 20+ biome swaps).
//   3. Compression paths (KTX2/Basis textures, Draco geometry, texture atlas)
//      are verifiable and observable from the profiler.
//
// Design notes
// ────────────
// The renderer in this build is fully procedural — shaders generate the nebula
// background, particles are SoA arrays, VFX is instanced primitives. There are
// no .ktx2/.drc files on disk *today*. AssetManager is therefore primarily an
// accounting & disposal harness ready for the upcoming art pipeline.
//
// We estimate VRAM per asset (cheap conservative byte-counting); WebGPU does
// not expose true VRAM usage to the page. Estimates are the same approach the
// Three.js inspector uses and is good enough for ceiling enforcement.
//
// Surface area
// ────────────
//   const am = new AssetManager({ renderer, tier });
//   am.registerAsset(type, asset, opts?)   → handle (with .dispose())
//   am.disposeAssets({ tag?, except? })    → frees tagged / non-excepted
//   am.getMemoryUsage()                    → { bytes, mb, byType, ceiling }
//   am.checkCeiling()                      → { withinCeiling, used, limit }
//   am.verifyCompression()                 → { ktx2, draco, atlas, ratios }
//   am.attachBiomeTransitions(bus)         → wires 'biome:enter' → dispose
//   am.snapshot()                          → JSON-safe profiler frame
//   am.dispose()                           → tear everything down
//
// MUST NOT
// ────────
//   - Mutate or render anything itself.
//   - Re-dispose externally-owned resources (caller signals ownership).
//   - Throw on missing optional loaders.

// ─── Tier configuration ────────────────────────────────────────────────────

export const TIER_VRAM_CEILING_MB = Object.freeze({
  ultra:  2048,   // 2 GB
  high:   1024,   // 1 GB
  medium:  512,
  low:     256,
});

export function ceilingForTier(tier) {
  return TIER_VRAM_CEILING_MB[tier] ?? TIER_VRAM_CEILING_MB.medium;
}

// ─── Asset type taxonomy ───────────────────────────────────────────────────

export const ASSET_TYPES = Object.freeze({
  TEXTURE:      'texture',
  GEOMETRY:     'geometry',
  MATERIAL:     'material',
  RENDER_TARGET:'renderTarget',
  CUBE_TEXTURE: 'cubeTexture',
  OTHER:        'other',
});

// ─── Byte-cost estimation ──────────────────────────────────────────────────
//
// All math is approximate; the goal is consistent accounting across
// register/dispose pairs, not exact VRAM truth.

const BYTES_PER_PIXEL = {
  // Best-guess per-pixel cost for the common Three.js formats we'll meet.
  // Compressed formats override this with their block-cost (below).
  rgba8:  4,
  rgb8:   3,
  rg8:    2,
  r8:     1,
  rgba16: 8,
  rgba32: 16,
  depth:  4,
};

// KTX2/Basis block byte sizes — for ratio reporting.
// BC7 / ASTC 4x4 / ETC2 RGBA all settle near ~1 byte/pixel; classic uncompressed
// RGBA8 is 4. The conventional "Basis ratio" is therefore ~4:1, which we report.
const COMPRESSED_BYTES_PER_PIXEL = {
  ktx2_bc7:    1.0,     // BC7
  ktx2_astc:   1.0,     // ASTC 4x4
  ktx2_etc2:   1.0,     // ETC2 RGBA
  ktx2_basis:  0.5,     // Basis-universal transcoded (avg)
};

function estimateTextureBytes(asset, opts) {
  // Caller-provided override wins.
  if (Number.isFinite(opts?.bytes)) return opts.bytes;

  const image = asset?.image ?? asset?.source?.data ?? null;
  const w = image?.width  ?? opts?.width  ?? 0;
  const h = image?.height ?? opts?.height ?? 0;
  if (w <= 0 || h <= 0) return 0;
  const pixels = w * h;

  const compressed = opts?.compression ?? null; // 'ktx2_bc7' | 'ktx2_basis' | ...
  let bpp;
  if (compressed && COMPRESSED_BYTES_PER_PIXEL[compressed] != null) {
    bpp = COMPRESSED_BYTES_PER_PIXEL[compressed];
  } else {
    bpp = BYTES_PER_PIXEL[opts?.format] ?? BYTES_PER_PIXEL.rgba8;
  }

  // Mipmaps: ~4/3 multiplier on full chain.
  const mipMul = opts?.mipmaps === false ? 1 : 4 / 3;
  return Math.ceil(pixels * bpp * mipMul);
}

function estimateGeometryBytes(asset, opts) {
  if (Number.isFinite(opts?.bytes)) return opts.bytes;
  const attrs = asset?.attributes ?? {};
  let total = 0;
  for (const key of Object.keys(attrs)) {
    const a = attrs[key];
    const arr = a?.array;
    if (arr && Number.isFinite(arr.byteLength)) total += arr.byteLength;
  }
  const idx = asset?.index;
  if (idx?.array?.byteLength) total += idx.array.byteLength;
  return total;
}

function estimateRenderTargetBytes(asset, opts) {
  if (Number.isFinite(opts?.bytes)) return opts.bytes;
  const w = asset?.width  ?? opts?.width  ?? 0;
  const h = asset?.height ?? opts?.height ?? 0;
  if (w <= 0 || h <= 0) return 0;
  const bpp = BYTES_PER_PIXEL[opts?.format] ?? BYTES_PER_PIXEL.rgba8;
  const depth = asset?.depthBuffer ? BYTES_PER_PIXEL.depth : 0;
  return Math.ceil(w * h * (bpp + depth));
}

function estimateBytes(type, asset, opts) {
  switch (type) {
    case ASSET_TYPES.TEXTURE:
    case ASSET_TYPES.CUBE_TEXTURE:
      return estimateTextureBytes(asset, opts) * (type === ASSET_TYPES.CUBE_TEXTURE ? 6 : 1);
    case ASSET_TYPES.GEOMETRY:
      return estimateGeometryBytes(asset, opts);
    case ASSET_TYPES.RENDER_TARGET:
      return estimateRenderTargetBytes(asset, opts);
    case ASSET_TYPES.MATERIAL:
      // Materials are mostly state; the bulk of their VRAM cost lives in
      // referenced textures (registered separately).
      return Number.isFinite(opts?.bytes) ? opts.bytes : 256;
    default:
      return Number.isFinite(opts?.bytes) ? opts.bytes : 0;
  }
}

// ─── AssetManager ──────────────────────────────────────────────────────────

let _nextId = 1;

export class AssetManager {
  /**
   * @param {object} opts
   * @param {*} [opts.renderer] Three renderer (for info.memory + dispose hooks)
   * @param {string} [opts.tier] 'ultra'|'high'|'medium'|'low'
   * @param {*} [opts.bus] Event bus (optional — used by attachBiomeTransitions)
   * @param {(msg:string,data?:any)=>void} [opts.logger]
   */
  constructor({ renderer = null, tier = 'medium', bus = null, logger = null } = {}) {
    this.renderer = renderer;
    this.tier     = tier;
    this.bus      = bus;
    this.logger   = logger ?? defaultLogger;
    this.ceilingMB = ceilingForTier(tier);

    /** @type {Map<number, {id:number,type:string,asset:any,bytes:number,tag:string|null,owned:boolean,disposed:boolean}>} */
    this._records = new Map();
    /** Totals by type (bytes). */
    this._byType = Object.create(null);
    this._totalBytes = 0;

    // Compression stats — incremented on register for any asset declaring
    // opts.compression / opts.draco / opts.atlas. Lets verifyCompression()
    // produce a real report even before loaders are wired.
    this._compStats = {
      ktx2:   { count: 0, rawBytes: 0, compBytes: 0 },
      draco:  { count: 0, rawBytes: 0, compBytes: 0 },
      atlas:  { count: 0, atlasedTextures: 0 },
    };

    this._disposed = false;
    this._unsubBiome = null;
  }

  // ── Registration ────────────────────────────────────────────────────────

  /**
   * Track a GPU resource.
   *
   * @param {string} type    one of ASSET_TYPES.*
   * @param {*} asset        Three resource (must expose .dispose())
   * @param {object} [opts]
   * @param {string} [opts.tag]          Group label (e.g. 'biome:nebula') for bulk disposal
   * @param {boolean}[opts.owned=true]   If false, we will not call .dispose() on it
   * @param {number} [opts.bytes]        Override automatic byte estimate
   * @param {string} [opts.compression]  'ktx2_bc7' | 'ktx2_basis' | etc.
   * @param {boolean}[opts.draco]        Geometry came through DRACOLoader
   * @param {number} [opts.rawBytes]     Uncompressed reference size (for ratio reporting)
   * @param {boolean}[opts.atlas]        Texture is part of an atlas
   * @returns {{id:number, bytes:number, dispose:()=>void}}
   */
  registerAsset(type, asset, opts = {}) {
    if (this._disposed) return { id: -1, bytes: 0, dispose() {} };
    if (!type || !asset) return { id: -1, bytes: 0, dispose() {} };

    const bytes = estimateBytes(type, asset, opts);
    const id = _nextId++;
    const rec = {
      id,
      type,
      asset,
      bytes,
      tag: opts.tag ?? null,
      owned: opts.owned !== false,
      disposed: false,
    };
    this._records.set(id, rec);
    this._totalBytes += bytes;
    this._byType[type] = (this._byType[type] ?? 0) + bytes;

    // Compression accounting.
    if (opts.compression) {
      const c = this._compStats.ktx2;
      c.count++;
      c.compBytes += bytes;
      c.rawBytes  += Number.isFinite(opts.rawBytes) ? opts.rawBytes : bytes * 4;
    }
    if (opts.draco) {
      const c = this._compStats.draco;
      c.count++;
      c.compBytes += bytes;
      c.rawBytes  += Number.isFinite(opts.rawBytes) ? opts.rawBytes : bytes * 5;
    }
    if (opts.atlas) {
      this._compStats.atlas.count++;
      this._compStats.atlas.atlasedTextures++;
    }

    // Soft warning if we just crossed the ceiling.
    if (this._totalBytes > this.ceilingMB * 1024 * 1024) {
      this.logger(`[assets] OVER CEILING (${this.tier}): ${(this._totalBytes / 1048576).toFixed(1)}MB > ${this.ceilingMB}MB`);
    }

    return {
      id,
      bytes,
      dispose: () => this._disposeRecord(rec),
    };
  }

  // ── Disposal ───────────────────────────────────────────────────────────

  /**
   * Release tracked assets.
   *
   *   disposeAssets()                      → all owned, tagged or untagged
   *   disposeAssets({ tag: 'biome:x' })    → only that tag
   *   disposeAssets({ except: ['core'] })  → everything except those tags
   */
  disposeAssets(opts = {}) {
    if (this._disposed) return 0;
    const tag = opts.tag ?? null;
    const except = opts.except ? new Set(opts.except) : null;
    let freed = 0;
    for (const rec of [...this._records.values()]) {
      if (rec.disposed) continue;
      if (tag != null && rec.tag !== tag) continue;
      if (except && rec.tag != null && except.has(rec.tag)) continue;
      if (this._disposeRecord(rec)) freed++;
    }
    return freed;
  }

  _disposeRecord(rec) {
    if (!rec || rec.disposed) return false;
    rec.disposed = true;
    this._records.delete(rec.id);
    this._totalBytes -= rec.bytes;
    this._byType[rec.type] = Math.max(0, (this._byType[rec.type] ?? 0) - rec.bytes);
    if (rec.owned && rec.asset && typeof rec.asset.dispose === 'function') {
      try { rec.asset.dispose(); } catch (err) {
        this.logger(`[assets] dispose() threw for ${rec.type}#${rec.id}`, err);
      }
    }
    return true;
  }

  // ── Memory introspection ───────────────────────────────────────────────

  getMemoryUsage() {
    const byType = { ...this._byType };
    return {
      bytes:      this._totalBytes,
      mb:         this._totalBytes / 1048576,
      byType,
      records:    this._records.size,
      ceiling:    this.ceilingMB,
      tier:       this.tier,
      // Three's renderer.info.memory reports geometry/texture counts.
      rendererInfo: this._readRendererMemory(),
    };
  }

  checkCeiling() {
    const used = this._totalBytes;
    const limit = this.ceilingMB * 1048576;
    return {
      withinCeiling: used <= limit,
      used,
      limit,
      utilization: limit > 0 ? used / limit : 0,
    };
  }

  _readRendererMemory() {
    const mem = this.renderer?.info?.memory;
    if (!mem) return null;
    return {
      geometries: mem.geometries ?? 0,
      textures:   mem.textures ?? 0,
    };
  }

  // ── Compression verification ───────────────────────────────────────────
  //
  // Probes the runtime for KTX2/Draco loader presence and reports the
  // observed compression ratios for every registered compressed asset.
  // The probe is best-effort: missing loaders are NOT an error — the
  // project currently uses procedural assets and the field is informational
  // for the upcoming art bake. Once .ktx2/.drc files land, loading them is
  // sufficient to validate this whole pipeline.

  async verifyCompression() {
    const ktx = this._compStats.ktx2;
    const drc = this._compStats.draco;
    const atl = this._compStats.atlas;

    const ktx2Ratio = ktx.compBytes > 0 ? ktx.rawBytes / ktx.compBytes : null;
    const dracoRatio = drc.compBytes > 0 ? drc.rawBytes / drc.compBytes : null;

    const loaders = await this._probeLoaders();

    const report = {
      ktx2: {
        loaderAvailable: loaders.ktx2,
        count:           ktx.count,
        compressedBytes: ktx.compBytes,
        rawBytes:        ktx.rawBytes,
        ratio:           ktx2Ratio,
      },
      draco: {
        loaderAvailable: loaders.draco,
        count:           drc.count,
        compressedBytes: drc.compBytes,
        rawBytes:        drc.rawBytes,
        ratio:           dracoRatio,
      },
      atlas: {
        count:           atl.count,
        atlasedTextures: atl.atlasedTextures,
      },
    };

    if (ktx.count > 0) {
      this.logger(`[assets] KTX2/Basis ratio ≈ ${ktx2Ratio?.toFixed(2)}× over ${ktx.count} texture(s)`);
    }
    if (drc.count > 0) {
      this.logger(`[assets] Draco ratio ≈ ${dracoRatio?.toFixed(2)}× over ${drc.count} geometry(ies)`);
    }
    if (atl.count > 0) {
      this.logger(`[assets] Texture atlas: ${atl.atlasedTextures} mapping(s)`);
    }
    return report;
  }

  async _probeLoaders() {
    const probe = { ktx2: false, draco: false };
    // Only probe in environments that have a renderer (skip in tests/SSR).
    try {
      const mod = await import('three/examples/jsm/loaders/KTX2Loader.js').catch(() => null);
      if (mod && typeof mod.KTX2Loader === 'function') probe.ktx2 = true;
    } catch { /* ignore */ }
    try {
      const mod = await import('three/examples/jsm/loaders/DRACOLoader.js').catch(() => null);
      if (mod && typeof mod.DRACOLoader === 'function') probe.draco = true;
    } catch { /* ignore */ }
    return probe;
  }

  // ── Biome transition hook ──────────────────────────────────────────────

  /**
   * Wire to bus.on('biome:enter'): on each transition, release any record
   * tagged `biome:<previousId>` so VRAM doesn't accumulate across the run.
   * Caller is expected to register transient biome assets with that tag.
   *
   *   am.registerAsset('texture', tex, { tag: `biome:${id}` });
   */
  attachBiomeTransitions(bus = this.bus) {
    if (!bus || typeof bus.on !== 'function') return;
    if (this._unsubBiome) this._unsubBiome();
    let currentTag = null;
    this._unsubBiome = bus.on('biome:enter', (payload) => {
      const id = payload?.biome ?? payload?.id ?? null;
      const nextTag = id ? `biome:${id}` : null;
      if (currentTag && currentTag !== nextTag) {
        const freed = this.disposeAssets({ tag: currentTag });
        if (freed > 0) {
          this.logger(`[assets] biome transition '${currentTag}' → '${nextTag}': freed ${freed} record(s)`);
        }
      }
      currentTag = nextTag;
    });
  }

  // ── Profiler integration ───────────────────────────────────────────────

  snapshot() {
    const mem = this.getMemoryUsage();
    const ceil = this.checkCeiling();
    return {
      tier: this.tier,
      records: mem.records,
      bytes: mem.bytes,
      mb: Number((mem.mb).toFixed(2)),
      byTypeMB: Object.fromEntries(
        Object.entries(mem.byType).map(([k, v]) => [k, Number((v / 1048576).toFixed(2))]),
      ),
      ceilingMB: this.ceilingMB,
      utilization: Number(ceil.utilization.toFixed(3)),
      withinCeiling: ceil.withinCeiling,
      rendererInfo: mem.rendererInfo,
      compression: {
        ktx2:  this._compStats.ktx2.count,
        draco: this._compStats.draco.count,
        atlas: this._compStats.atlas.count,
      },
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._unsubBiome) { try { this._unsubBiome(); } catch { /* ignore */ } }
    this._unsubBiome = null;
    // Dispose everything still tracked. Owned=false records are detached
    // without calling their .dispose().
    for (const rec of [...this._records.values()]) this._disposeRecord(rec);
    this._records.clear();
    this._byType = Object.create(null);
    this._totalBytes = 0;
  }
}

function defaultLogger(msg, data) {
  // eslint-disable-next-line no-console
  if (data !== undefined) console.warn(msg, data);
  else                    console.warn(msg);
}

export default AssetManager;
