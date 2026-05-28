// World — owns the scene graph, camera, ECS, and the per-frame orchestration.
// The scaffold renders a placeholder singularity (core + accretion disk + starfield)
// so the build is visibly alive. Gameplay systems are layered in SPRINT-02+.

import {
  Scene, PerspectiveCamera, Group, Color,
  IcosahedronGeometry, TorusGeometry, BufferGeometry, Float32BufferAttribute,
  Mesh, Points, MeshBasicMaterial, PointsMaterial,
  PointLight, AmbientLight, AdditiveBlending,
  OctahedronGeometry, BoxGeometry,
} from 'three';
import { ECS } from '../engine/ecs.js';
import { createPostFX } from '../render/postfx.js';
import { createAccretionDiskMaterial } from '../shaders/disk.js';
import { Ship } from './player/ship.js';
import { ProjectilePool } from './projectiles/pool.js';
import { WeaponSystem } from './weapons/system.js';
import { HUD } from '../ui/hud.js';
import { EnemyInstancedRenderers } from '../render/instancing.js';
import { ENEMY_TYPES } from './enemies/types.js';
import { EnemyManager } from './enemies/index.js';
import { createRngStreams } from '../engine/rng.js';
import { EventBus } from '../engine/events.js';

// Gravitational constant tuned for arcade feel (not physical).
const GRAV_K = 320;
// Soft clamp radius to prevent infinite acceleration near the singularity.
const GRAV_SOFT = 3.0;

export class World {
  constructor({ renderer, input, cap, seed = 0xC0FFEE, bus = null } = {}) {
    this.renderer = renderer;
    this.input = input;
    this.cap = cap;
    this.seed = seed >>> 0;
    this.rng = createRngStreams(this.seed);
    this.bus = bus ?? new EventBus();
    this.ecs = new ECS();
    this.scene = new Scene();
    this.scene.background = new Color(0x02030a);
    this.camera = new PerspectiveCamera(60, 1, 0.1, 2000);
    this.camera.position.set(0, 14, 26);
    this.camera.lookAt(0, 0, 0);
    this._firstFrameCbs = [];
    this._framed = false;
    this._firePrev = false;
  }

  async init() {
    // Lights
    this.scene.add(new AmbientLight(0x0a1430, 0.6));
    const core = new PointLight(0xff7a2a, 40, 200, 2);
    this.scene.add(core);

    // Singularity core
    this.core = new Mesh(
      new IcosahedronGeometry(2.2, 4),
      new MeshBasicMaterial({ color: 0x000000 }),
    );
    this.scene.add(this.core);

    // Accretion disk (placeholder torus; SPRINT-04 swaps for GPU-particle disk)
    const disk = createAccretionDiskMaterial({
      colorInner: 0xffd089,
      colorOuter: 0xff2a08,
      intensity: 4.5,
      swirlSpeed: 1.6,
      swirlAmount: 0.4,
    });
    this.diskFx = disk;
    this.disk = new Mesh(
      new TorusGeometry(6, 1.8, 32, 192),
      disk.material,
    );
    this.disk.rotation.x = Math.PI / 2.2;
    this.scene.add(this.disk);

    // Starfield
    this.scene.add(this._starfield(4000, 600));

    // Post FX (passthrough in scaffold)
    this.fx = createPostFX(this.renderer, this.scene, this.camera);

    // Player ship.
    this.gravitySource = { position: this.core.position, mass: 1 };
    this.ship = new Ship({
      scene: this.scene,
      input: this.input,
      camera: this.camera,
      gravity: this.gravitySource,
    });

    // Projectile pool + weapons.
    this.projectilePool = new ProjectilePool({ scene: this.scene, capacity: 1024 });
    this.weapons = new WeaponSystem({ pool: this.projectilePool });
    this.hud = new HUD({
      weapons: this.weapons,
      ship: this.ship,
      ecs: this.ecs,
      projectilePool: this.projectilePool,
      gravity: this.gravitySource,
      profiler: null, // wired post-construction by main.js
    });
    this._weaponSwitchPrev = { d1: false, d2: false, q: false };

    // Enemy instanced renderers — one draw call per enemy type, ECS-driven.
    this.enemyRenderers = new EnemyInstancedRenderers({
      scene: this.scene,
      ecs: this.ecs,
      registry: {
        [ENEMY_TYPES.CHASER]: {
          geometry: new OctahedronGeometry(0.85, 0),
          material: new MeshBasicMaterial({ color: 0xffffff }),
          capacity: 512,
          defaultColor: 0xff5066,
        },
        [ENEMY_TYPES.SHOOTER]: {
          geometry: new BoxGeometry(1.2, 1.2, 1.2),
          material: new MeshBasicMaterial({ color: 0xffffff }),
          capacity: 256,
          defaultColor: 0xff9a3a,
        },
        [ENEMY_TYPES.ORBITER]: {
          geometry: new IcosahedronGeometry(0.9, 0),
          material: new MeshBasicMaterial({ color: 0xffffff }),
          capacity: 384,
          defaultColor: 0x9d6bff,
        },
      },
    });

    // Enemy manager — owns spawn/death/behavior; renders via ECS instancing above.
    this.enemies = new EnemyManager({
      ecs: this.ecs,
      bus: this.bus,
      projectiles: this.projectilePool,
      gravity: this.gravitySource,
    });
    this.enemies.setPlayer(this.ship);
    // Seed encounter so all three behaviors are visibly active out of the box.
    this.enemies.spawn({ type: ENEMY_TYPES.CHASER,  position: [22, 0, 18] });
    this.enemies.spawn({ type: ENEMY_TYPES.SHOOTER, position: [-20, 0, 16] });
    this.enemies.spawn({ type: ENEMY_TYPES.ORBITER, position: [11, 0, 0],  params: { direction: 1 } });
    this.enemies.spawn({ type: ENEMY_TYPES.ORBITER, position: [-11, 0, 0], params: { direction: -1 } });
  }

  _starfield(count, radius) {
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const rnd = this.rng.fx;
      const r = radius * (0.6 + rnd.float() * 0.4);
      const th = rnd.float() * Math.PI * 2;
      const ph = Math.acos(2 * rnd.float() - 1);
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.cos(ph);
      pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    return new Points(g, new PointsMaterial({
      size: 1.2, color: 0x9fcfff, transparent: true, opacity: 0.9,
      blending: AdditiveBlending, depthWrite: false,
    }));
  }

  onFirstFrame(cb) { this._firstFrameCbs.push(cb); }

  update(dt /*, t */) {
    this.disk.rotation.z += dt * 0.4;
    this.core.rotation.y += dt * 0.6;

    // Gravity well -> ship. Inverse-square with softening.
    if (this.ship && this.ship.alive) {
      const sp = this.ship.position;
      const gp = this.gravitySource.position;
      const dx = gp.x - sp.x;
      const dz = gp.z - sp.z;
      const r2 = dx * dx + dz * dz + GRAV_SOFT * GRAV_SOFT;
      const invR = 1 / Math.sqrt(r2);
      const a = (GRAV_K * this.gravitySource.mass) / r2;
      this.ship.applyForce(dx * invR * a, 0, dz * invR * a);
      this.ship.update(dt);
      this._handleWeapons(dt);
    }

    this.projectilePool.update(dt);
    this.weapons.update(dt);
    if (this.enemies) this.enemies.update(dt, performance.now() * 0.001);
    this.enemyRenderers.update();
    this.hud.update();

    this.ecs.run(dt);
  }

  render(/* alpha */) {
    this.fx.render();
    if (!this._framed) {
      this._framed = true;
      this._firstFrameCbs.forEach((cb) => cb());
    }
  }

  _handleWeapons(/* dt */) {
    // Weapon switching: 1=plasma, 2=rail, Q=cycle (edge-triggered).
    const i = this.input;
    const d1 = i.down('Digit1');
    const d2 = i.down('Digit2');
    const q = i.down('KeyQ');
    if (d1 && !this._weaponSwitchPrev.d1) this.weapons.setActive('plasma');
    if (d2 && !this._weaponSwitchPrev.d2) this.weapons.setActive('rail');
    if (q && !this._weaponSwitchPrev.q) this.weapons.cycle(1);
    this._weaponSwitchPrev.d1 = d1;
    this._weaponSwitchPrev.d2 = d2;
    this._weaponSwitchPrev.q = q;

    // Fire: held mouse OR KeyF (auto-fire while held; the per-weapon cooldown gates rate).
    const wantFire = i.pointer.down || i.down('KeyF');
    if (wantFire && this.weapons.ready()) {
      const sp = this.ship.position;
      // Direction comes from the ship's current hull heading (atan2(x,z) convention).
      const h = this.ship.heading;
      const nx = Math.sin(h);
      const nz = Math.cos(h);
      // Spawn slightly ahead of the hull so bullets don't clip the ship mesh.
      this.weapons.fire({
        position: [sp.x + nx * 0.9, sp.y + 0.2, sp.z + nz * 0.9],
        direction: [nx, 0, nz],
      });
    }
    this._firePrev = wantFire;
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.fx.setSize(w, h);
  }
}
