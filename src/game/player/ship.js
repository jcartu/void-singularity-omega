// Ship — twin-stick controllable player vessel.
//
// Design goals:
//   - Sub-frame input latency: read raw input every update, integrate immediately.
//   - Twin-stick: WASD/left-stick translates thrust intent; mouse/right-stick aims hull.
//   - Gravity coupling: external systems push acceleration via applyForce(); the ship
//     fights it with its own thrust vector so the gravity well actually pulls you in.
//   - Blink-dash: short-range teleport-ish burst with i-frames. Brief lockout afterwards
//     gives it weight without killing responsiveness.
//   - Health/energy: dash and (later) weapons drain energy; energy regenerates.
//
// The ship lives on the y=0 plane. The world is rendered from above so XZ is the
// gameplay plane; +Z is "forward" in screen space, +X is right.

import {
  Group, Mesh, ConeGeometry, CylinderGeometry, MeshStandardMaterial,
  PointLight, Vector3, Raycaster, Plane, Color, AdditiveBlending,
  SphereGeometry, MeshBasicMaterial,
} from 'three';

const TMP_V = new Vector3();
const TMP_V2 = new Vector3();
const GROUND_PLANE = new Plane(new Vector3(0, 1, 0), 0);

export const SHIP_DEFAULTS = Object.freeze({
  maxSpeed: 28,           // units/sec at full thrust w/o gravity
  thrustAccel: 90,        // units/sec^2
  brakeAccel: 60,         // passive damping when no input
  turnRate: 18,           // rad/sec - hull slew speed toward aim
  maxHealth: 100,
  maxEnergy: 100,
  energyRegen: 28,        // units/sec
  // Dash
  dashSpeed: 110,
  dashDuration: 0.14,
  dashCooldown: 0.55,
  dashEnergyCost: 35,
  dashIFrames: 0.22,      // slightly outlives the dash
  // Visuals
  hullColor: 0x6fd4ff,
  thrustColor: 0xffb070,
});

export class Ship {
  constructor({ scene, input, camera, gravity = null, opts = {} } = {}) {
    if (!scene) throw new Error('Ship: scene required');
    if (!input) throw new Error('Ship: input required');
    if (!camera) throw new Error('Ship: camera required');

    this.scene = scene;
    this.input = input;
    this.camera = camera;
    this.gravity = gravity;          // { position: Vector3, mass: number } or null
    this.opts = { ...SHIP_DEFAULTS, ...opts };

    // Kinematics on XZ plane.
    this.position = new Vector3(12, 0, 0);
    this.velocity = new Vector3();
    this.externalAccel = new Vector3(); // accumulated forces (gravity, knockback)
    this.heading = 0;                   // radians, atan2(x, z) convention

    // State
    this.health = this.opts.maxHealth;
    this.energy = this.opts.maxEnergy;
    this.alive = true;

    // Dash FSM
    this._dashTime = 0;          // remaining dash duration
    this._dashCooldown = 0;
    this._iframeTime = 0;
    this._dashDir = new Vector3();
    this._dashQueued = false;
    this._lastDashKey = false;

    this._raycaster = new Raycaster();
    this._aimPoint = new Vector3();

    this._buildMesh();
  }

  _buildMesh() {
    const g = new Group();

    const hullMat = new MeshStandardMaterial({
      color: this.opts.hullColor,
      emissive: new Color(this.opts.hullColor).multiplyScalar(0.25),
      metalness: 0.6,
      roughness: 0.35,
    });
    // Hull: cone pointing +Z (forward).
    const hull = new Mesh(new ConeGeometry(0.55, 1.6, 16), hullMat);
    hull.rotation.x = Math.PI / 2;
    hull.position.z = 0.2;
    g.add(hull);

    // Wings: a stubby cylinder cross-piece for silhouette readability.
    const wingMat = new MeshStandardMaterial({
      color: 0x2a5478, metalness: 0.5, roughness: 0.5,
    });
    const wings = new Mesh(new CylinderGeometry(0.18, 0.18, 1.6, 12), wingMat);
    wings.rotation.z = Math.PI / 2;
    wings.position.z = -0.05;
    g.add(wings);

    // Engine glow (additive sphere behind hull).
    const glowMat = new MeshBasicMaterial({
      color: this.opts.thrustColor, transparent: true, opacity: 0.9,
      blending: AdditiveBlending, depthWrite: false,
    });
    this._thrustGlow = new Mesh(new SphereGeometry(0.35, 12, 10), glowMat);
    this._thrustGlow.position.z = -0.8;
    this._thrustGlow.scale.set(1, 1, 0.6);
    g.add(this._thrustGlow);

    // Subtle running light.
    const runLight = new PointLight(this.opts.hullColor, 1.8, 8, 2);
    runLight.position.set(0, 0.4, 0);
    g.add(runLight);

    this.group = g;
    this.group.position.copy(this.position);
    this.scene.add(this.group);
  }

  /** Apply an external instantaneous acceleration (units/sec^2). */
  applyForce(ax, ay, az) {
    this.externalAccel.x += ax;
    this.externalAccel.y += ay;
    this.externalAccel.z += az;
  }

  /** Damage; ignored while i-framed. Returns true if damage landed. */
  damage(amount) {
    if (!this.alive || this._iframeTime > 0) return false;
    this.health = Math.max(0, this.health - amount);
    if (this.health === 0) this.alive = false;
    return true;
  }

  get isInvincible() { return this._iframeTime > 0; }
  get isDashing() { return this._dashTime > 0; }

  /** Per-frame update. dt in seconds. */
  update(dt) {
    if (!this.alive) {
      // Settle to a stop on death; let respawn logic (later sprint) restore.
      this.velocity.multiplyScalar(Math.max(0, 1 - dt * 2));
      this._integrate(dt);
      this.externalAccel.set(0, 0, 0);
      return;
    }

    // --- 1. Aim: project mouse onto ground plane, compute target heading. ---
    this._updateAim();

    // --- 2. Read movement intent (twin-stick left stick / WASD). ---
    const axis = this.input.axis();
    // input.axis returns x=right, y=up(forward). Map onto XZ plane (forward = +Z).
    const intent = TMP_V.set(axis.x, 0, axis.y);
    const intentMag = Math.hypot(axis.x, axis.y);

    // --- 3. Dash trigger (Shift / Space). Edge-triggered. ---
    const dashKey = this.input.down('Space') || this.input.down('ShiftLeft') || this.input.down('ShiftRight');
    if (dashKey && !this._lastDashKey) this._dashQueued = true;
    this._lastDashKey = dashKey;

    if (this._dashQueued && this._dashCooldown <= 0 && this.energy >= this.opts.dashEnergyCost) {
      this._startDash(intent, intentMag);
    }
    this._dashQueued = false;

    // --- 4. Integrate. ---
    if (this._dashTime > 0) {
      // Lock velocity to dash vector for the burst.
      this.velocity.copy(this._dashDir).multiplyScalar(this.opts.dashSpeed);
      this._dashTime -= dt;
    } else {
      if (intentMag > 0.01) {
        // Thrust along intent.
        TMP_V2.copy(intent).multiplyScalar(this.opts.thrustAccel * dt);
        this.velocity.add(TMP_V2);
      } else {
        // Passive linear damping when no input — gives the ship "brakes".
        const speed = this.velocity.length();
        if (speed > 0.0001) {
          const drop = Math.min(speed, this.opts.brakeAccel * dt);
          this.velocity.multiplyScalar((speed - drop) / speed);
        }
      }
      // External forces (gravity well, knockbacks) integrate every frame.
      TMP_V2.copy(this.externalAccel).multiplyScalar(dt);
      this.velocity.add(TMP_V2);

      // Speed cap (only on player-driven motion, not gravity bursts? compromise:
      // cap horizontal magnitude but allow brief overshoot from external force).
      const maxV = this.opts.maxSpeed;
      const v2 = this.velocity.lengthSq();
      const cap = maxV * maxV * 2.25; // allow up to 1.5x via external force
      if (v2 > cap) this.velocity.setLength(Math.sqrt(cap));
    }

    this._integrate(dt);

    // --- 5. Hull rotation slews to aim (snappy but not instant). ---
    const targetHeading = Math.atan2(
      this._aimPoint.x - this.position.x,
      this._aimPoint.z - this.position.z,
    );
    this.heading = slewAngle(this.heading, targetHeading, this.opts.turnRate * dt);
    this.group.rotation.y = this.heading;
    this.group.position.copy(this.position);

    // --- 6. Timers & resources. ---
    if (this._dashCooldown > 0) this._dashCooldown -= dt;
    if (this._iframeTime > 0) this._iframeTime -= dt;
    if (this.energy < this.opts.maxEnergy) {
      this.energy = Math.min(this.opts.maxEnergy, this.energy + this.opts.energyRegen * dt);
    }

    // --- 7. Visual feedback: thrust glow + i-frame shimmer. ---
    const thrustPulse = intentMag * 0.7 + (this._dashTime > 0 ? 1.4 : 0);
    this._thrustGlow.scale.setScalar(0.6 + thrustPulse * 0.9);
    this._thrustGlow.material.opacity = 0.55 + Math.min(0.45, thrustPulse * 0.4);
    if (this._iframeTime > 0) {
      // Strobe visibility while invincible.
      const t = performance.now() * 0.025;
      this.group.visible = (Math.sin(t) > -0.2);
    } else {
      this.group.visible = true;
    }

    // Clear externalAccel — it must be re-applied each frame by force sources.
    this.externalAccel.set(0, 0, 0);
  }

  _integrate(dt) {
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    this.position.y = 0;
  }

  _startDash(intent, intentMag) {
    // Dash in input direction if any, otherwise forward along heading.
    if (intentMag > 0.01) {
      this._dashDir.copy(intent).normalize();
    } else {
      this._dashDir.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    }
    this._dashTime = this.opts.dashDuration;
    this._dashCooldown = this.opts.dashCooldown;
    this._iframeTime = this.opts.dashIFrames;
    this.energy -= this.opts.dashEnergyCost;
  }

  _updateAim() {
    // Build a ray from camera through current pointer NDC, intersect ground plane.
    const p = this.input.pointer;
    this._raycaster.setFromCamera({ x: p.nx, y: p.ny }, this.camera);
    const hit = this._raycaster.ray.intersectPlane(GROUND_PLANE, TMP_V);
    if (hit) this._aimPoint.copy(hit);
    // If the ray is parallel to the plane (rare), keep last aim.
  }
}

/** Slew angle `from` toward `to` by up to `maxStep` radians, shortest path. */
function slewAngle(from, to, maxStep) {
  let diff = to - from;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  const step = Math.max(-maxStep, Math.min(maxStep, diff));
  return from + step;
}
