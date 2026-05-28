// InstancedRenderer — single draw-call batched mesh for repeated geometry.
//
// Two write modes:
//   'stream' — call beginFrame() / pushInstance() / endFrame() each frame.
//              mesh.count tracks how many instances were written this frame.
//              Best fit: ECS-driven entities (enemies) where the live set is
//              recomputed by query each tick.
//
//   'slot'   — call setSlot(i, ...) / clearSlot(i) for stable slot ids.
//              mesh.count is fixed at capacity; unused slots are parked
//              offscreen with zero scale. Best fit: pooled actors (bullets)
//              where the caller owns slot lifetimes.
//
// In both modes the renderer performs ZERO per-frame allocation: a single
// Object3D scratch and Color scratch are reused for all writes.

import {
  InstancedMesh, Object3D, Color, DynamicDrawUsage,
} from 'three';

const PARK_Y = -9999;

export class InstancedRenderer {
  constructor({
    scene, geometry, material, capacity,
    mode = 'stream',
    castShadow = false, receiveShadow = false,
    frustumCulled = false,
  }) {
    if (!scene) throw new Error('InstancedRenderer: scene required');
    if (!geometry || !material) throw new Error('InstancedRenderer: geometry+material required');
    if (!Number.isFinite(capacity) || capacity <= 0) throw new Error('InstancedRenderer: capacity > 0 required');
    if (mode !== 'stream' && mode !== 'slot') throw new Error(`InstancedRenderer: bad mode ${mode}`);

    this.scene = scene;
    this.capacity = capacity;
    this.mode = mode;
    this._geom = geometry;
    this._mat = material;
    this._ownGeom = false;
    this._ownMat = false;

    this.mesh = new InstancedMesh(geometry, material, capacity);
    this.mesh.frustumCulled = frustumCulled;
    this.mesh.castShadow = castShadow;
    this.mesh.receiveShadow = receiveShadow;
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = mode === 'slot' ? capacity : 0;
    scene.add(this.mesh);

    // Reusable scratch — never reallocated.
    this._scratch = new Object3D();
    this._color = new Color();
    this._writeIdx = 0;
    this._colorDirty = false;

    if (mode === 'slot') this._parkAll();
  }

  _parkAll() {
    this._scratch.position.set(0, PARK_Y, 0);
    this._scratch.scale.setScalar(0);
    this._scratch.rotation.set(0, 0, 0);
    this._scratch.updateMatrix();
    for (let i = 0; i < this.capacity; i++) {
      this.mesh.setMatrixAt(i, this._scratch.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  // -- stream mode --------------------------------------------------------

  beginFrame() {
    this._writeIdx = 0;
  }

  /**
   * Append one instance for this frame. Stream mode only.
   * Returns true if written, false if capacity exceeded (soft drop).
   * rotY/scale/color are optional (defaults: 0, 1, no color override).
   */
  pushInstance(x, y, z, scale = 1, rotY = 0, colorHex = null) {
    if (this._writeIdx >= this.capacity) return false;
    const i = this._writeIdx++;
    const s = this._scratch;
    s.position.set(x, y, z);
    s.rotation.set(0, rotY, 0);
    s.scale.setScalar(scale);
    s.updateMatrix();
    this.mesh.setMatrixAt(i, s.matrix);
    if (colorHex !== null) {
      this._color.set(colorHex);
      this.mesh.setColorAt(i, this._color);
      this._colorDirty = true;
    }
    return true;
  }

  // -- slot mode ----------------------------------------------------------

  /** Set transform at a stable slot index. Slot mode only. */
  setSlot(i, x, y, z, scale = 1, rotY = 0, colorHex = null) {
    const s = this._scratch;
    s.position.set(x, y, z);
    s.rotation.set(0, rotY, 0);
    s.scale.setScalar(scale);
    s.updateMatrix();
    this.mesh.setMatrixAt(i, s.matrix);
    if (colorHex !== null) {
      this._color.set(colorHex);
      this.mesh.setColorAt(i, this._color);
      this._colorDirty = true;
    }
  }

  /** Park a slot offscreen (scale=0) without affecting draw count. */
  clearSlot(i) {
    const s = this._scratch;
    s.position.set(0, PARK_Y, 0);
    s.rotation.set(0, 0, 0);
    s.scale.setScalar(0);
    s.updateMatrix();
    this.mesh.setMatrixAt(i, s.matrix);
  }

  // -- frame flush --------------------------------------------------------

  endFrame() {
    if (this.mode === 'stream') {
      this.mesh.count = this._writeIdx;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this._colorDirty && this.mesh.instanceColor) {
      this.mesh.instanceColor.needsUpdate = true;
      this._colorDirty = false;
    }
  }

  // -- lifecycle ----------------------------------------------------------

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.dispose?.();
    if (this._ownGeom) this._geom.dispose?.();
    if (this._ownMat) this._mat.dispose?.();
  }
}

/**
 * EnemyInstancedRenderers — one InstancedRenderer per enemy type, all driven
 * from an ECS query each frame. Yields one draw call per type regardless of
 * the live enemy count (up to per-type capacity).
 *
 * Expected ECS components:
 *   'transform' : { position: {x,y,z}, rotationY?: number, scale?: number }
 *   'enemyType' : { type: string, color?: number }
 *
 * Registry shape (passed to ctor):
 *   { [type]: { geometry, material, capacity, defaultColor? } }
 */
export class EnemyInstancedRenderers {
  constructor({ scene, ecs, registry }) {
    this.ecs = ecs;
    this.renderers = new Map();
    this.defaultColors = new Map();
    for (const [type, def] of Object.entries(registry)) {
      this.renderers.set(type, new InstancedRenderer({
        scene,
        geometry: def.geometry,
        material: def.material,
        capacity: def.capacity ?? 512,
        mode: 'stream',
      }));
      if (def.defaultColor !== undefined) this.defaultColors.set(type, def.defaultColor);
    }
  }

  /**
   * Sync transforms from ECS. Allocation-free: iterates the smaller of the
   * two stores via ECS.query and writes instances per-type.
   */
  update() {
    for (const r of this.renderers.values()) r.beginFrame();

    const transforms = this.ecs.stores.get('transform');
    const enemyTypes = this.ecs.stores.get('enemyType');
    if (transforms && enemyTypes) {
      // Iterate the smaller store to minimize work; inline the join.
      const [small, other] = transforms.size <= enemyTypes.size
        ? [transforms, enemyTypes]
        : [enemyTypes, transforms];
      for (const [id, a] of small) {
        const b = other.get(id);
        if (b === undefined) continue;
        const t = transforms === small ? a : b;
        const e = enemyTypes === small ? a : b;
        const r = this.renderers.get(e.type);
        if (!r) continue;
        const p = t.position;
        const col = e.color ?? this.defaultColors.get(e.type) ?? null;
        r.pushInstance(p.x, p.y, p.z, t.scale ?? 1, t.rotationY ?? 0, col);
      }
    }

    for (const r of this.renderers.values()) r.endFrame();
  }

  dispose() {
    for (const r of this.renderers.values()) r.dispose();
    this.renderers.clear();
  }
}
