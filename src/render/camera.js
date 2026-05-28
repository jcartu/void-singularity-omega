// CameraRig — follow rig with look-ahead, smooth damping, and a shake hook.
// The shake hook is callable but inert in the scaffold; SPRINT-XX wires real shake.

import { Vector3, PerspectiveCamera } from 'three';

const _tmp = new Vector3();
const _tmp2 = new Vector3();

export class CameraRig {
  /**
   * @param {object} opts
   * @param {PerspectiveCamera} opts.camera - The camera to drive.
   * @param {object} [opts.target] - Initial follow target with `.position` (Vector3).
   * @param {Vector3} [opts.offset] - Camera offset from target in world space.
   * @param {number} [opts.lookAhead] - Distance to project lookAt forward along target velocity.
   * @param {number} [opts.positionDamping] - Lerp factor per second for position (higher = snappier).
   * @param {number} [opts.lookDamping] - Lerp factor per second for lookAt (higher = snappier).
   */
  constructor({
    camera,
    target = null,
    offset = new Vector3(0, 14, 26),
    lookAhead = 6,
    positionDamping = 4,
    lookDamping = 6,
  } = {}) {
    if (!camera) throw new Error('CameraRig requires a camera');
    this.camera = camera;
    this.target = target;
    this.offset = offset.clone();
    this.lookAhead = lookAhead;
    this.positionDamping = positionDamping;
    this.lookDamping = lookDamping;

    // Internal smoothed state.
    this._lookAt = new Vector3();
    this._lastTargetPos = new Vector3();
    this._velocity = new Vector3();

    // Shake hook state — invoked but inert in scaffold.
    this._shakeHandlers = [];
    this._shakeOffset = new Vector3();

    if (target?.position) {
      this._lastTargetPos.copy(target.position);
      this._lookAt.copy(target.position);
      this.camera.position.copy(target.position).add(this.offset);
      this.camera.lookAt(this._lookAt);
    }
  }

  setTarget(target) {
    this.target = target;
    if (target?.position) {
      this._lastTargetPos.copy(target.position);
      this._lookAt.copy(target.position);
    }
  }

  setOffset(x, y, z) {
    if (x?.isVector3) this.offset.copy(x);
    else this.offset.set(x, y, z);
  }

  setLookAhead(distance) {
    this.lookAhead = distance;
  }

  /**
   * Register a shake handler. Callable hook — implementations can push transient
   * offsets into `_shakeOffset` via `addShakeOffset`. Returns an unsubscribe fn.
   * @param {(ctx: { trauma: number, duration: number, rig: CameraRig }) => void} fn
   */
  onShake(fn) {
    this._shakeHandlers.push(fn);
    return () => {
      const i = this._shakeHandlers.indexOf(fn);
      if (i >= 0) this._shakeHandlers.splice(i, 1);
    };
  }

  /**
   * Trigger the shake hook. No actual shake is applied in the scaffold —
   * registered handlers are invoked so future systems can wire effects.
   * @param {number} [trauma=1] - Normalized intensity 0..1.
   * @param {number} [duration=0.4] - Seconds.
   */
  shake(trauma = 1, duration = 0.4) {
    const ctx = { trauma, duration, rig: this };
    for (const h of this._shakeHandlers) h(ctx);
  }

  /** Handlers may push offsets here; consumed and decayed in update(). */
  addShakeOffset(v) {
    this._shakeOffset.add(v);
  }

  update(dt) {
    if (!this.target?.position || dt <= 0) return;
    const tp = this.target.position;

    // Estimate target velocity (per second) from frame delta.
    _tmp.subVectors(tp, this._lastTargetPos).divideScalar(dt);
    // Smooth velocity estimate to avoid jitter (exponential moving average).
    const velAlpha = 1 - Math.exp(-8 * dt);
    this._velocity.lerp(_tmp, velAlpha);
    this._lastTargetPos.copy(tp);

    // Desired camera position = target + offset (in world space for scaffold).
    _tmp.copy(tp).add(this.offset).add(this._shakeOffset);

    // Frame-rate independent damping: alpha = 1 - exp(-k * dt).
    const posAlpha = 1 - Math.exp(-this.positionDamping * dt);
    this.camera.position.lerp(_tmp, posAlpha);

    // Look-ahead: project the lookAt point forward along velocity direction.
    _tmp2.copy(this._velocity);
    const speed = _tmp2.length();
    if (speed > 1e-4 && this.lookAhead > 0) {
      _tmp2.multiplyScalar(this.lookAhead / Math.max(speed, 1e-4));
      _tmp.copy(tp).add(_tmp2);
    } else {
      _tmp.copy(tp);
    }
    const lookAlpha = 1 - Math.exp(-this.lookDamping * dt);
    this._lookAt.lerp(_tmp, lookAlpha);
    this.camera.lookAt(this._lookAt);

    // Decay shake offset (scaffold: handlers don't push, so this stays zero).
    const decay = 1 - Math.exp(-12 * dt);
    this._shakeOffset.multiplyScalar(1 - decay);
  }
}
