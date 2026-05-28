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
import { ComboManager } from './combo.js';
import { EnemyInstancedRenderers } from '../render/instancing.js';
import { ENEMY_TYPES } from './enemies/types.js';
import { EnemyManager } from './enemies/index.js';
import { createRngStreams } from '../engine/rng.js';
import { EventBus } from '../engine/events.js';
import { WaveDirector } from './director.js';
import { UpgradeManager } from './upgrades.js';
import { createEconomy } from './economy.js';
import { RunStateMachine } from './run.js';

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
    this.weapons = new WeaponSystem({
      pool: this.projectilePool,
      ship: this.ship,
      enemyProvider: () => (this.enemies ? this.enemies.enemies.values() : null),
    });
    this.combo = new ComboManager({ bus: this.bus });
    this.hud = new HUD({
      weapons: this.weapons,
      ship: this.ship,
      ecs: this.ecs,
      projectilePool: this.projectilePool,
      gravity: this.gravitySource,
      profiler: null, // wired post-construction by main.js
      combo: this.combo,
      contract: () => this._currentContract(),
      run: () => this.runState?.state ?? 'idle',
      bus: this.bus,
      camera: this.camera,
    });
    this._weaponSwitchPrev = {
      d1: false, d2: false, d3: false, d4: false, d5: false, d6: false, q: false,
      f1: false, f2: false, f3: false, f4: false,
    };

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

    // Run orchestration: director + upgrades + economy + state machine.
    // The four systems are headless; HUD/UI screens (WO-03-U1/U2) read from
    // runState.getState() each frame. We do NOT seed a debug encounter here
    // anymore — runState.startRun() spawns the first wave via the director.
    this.upgradesMgr = new UpgradeManager({
      ship: this.ship,
      weapons: this.weapons,
      rng: this.rng.fx,
    });
    this.economy = createEconomy({
      bus: this.bus,
      rng: this.rng.fx,
      initialBalance: 0,
    });
    this._unsubKills = this.economy.currency.attachToBus(this.bus);
    this.director = new WaveDirector({
      enemies: this.enemies,
      bus: this.bus,
      rng: this.rng.fx,
      gravity: this.gravitySource,
    });
    this.runState = new RunStateMachine({
      ship: this.ship,
      director: this.director,
      upgrades: this.upgradesMgr,
      economy: this.economy,
      bus: this.bus,
      rng: this.rng.fx,
    });

    // Subscribe to run-level signals so the game pauses on win/lose. The HUD
    // will render the actual summary panels (WO-03-U2); world.js only owns
    // the gameplay-pause toggle here.
    this._runPaused = false;
    this._unsubRunOver    = this.bus.on('run:over',    (summary) => {
      this._runPaused = true;
      this._lastRunSummary = summary;
    });
    this._unsubRunVictory = this.bus.on('run:victory', (summary) => {
      this._runPaused = true;
      this._lastRunSummary = summary;
    });

    // Kick off the run on init. Future: gated by ship-select screen (WO-03-U2).
    this.runState.startRun('default', this.seed);
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
    if (this.runState && !this._runPaused) this.runState.update(dt);
    this.enemyRenderers.update();
    if (this.combo) this.combo.update(dt);
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
    // Weapon switching: 1..6 = primaries; Q = cycle primaries; F1..F4 = secondaries.
    const i = this.input;
    const sw = this._weaponSwitchPrev;
    const d1 = i.down('Digit1');
    const d2 = i.down('Digit2');
    const d3 = i.down('Digit3');
    const d4 = i.down('Digit4');
    const d5 = i.down('Digit5');
    const d6 = i.down('Digit6');
    const q  = i.down('KeyQ');
    if (d1 && !sw.d1) this.weapons.setActive('plasma');
    if (d2 && !sw.d2) this.weapons.setActive('rail');
    if (d3 && !sw.d3) this.weapons.setActive('homing');
    if (d4 && !sw.d4) this.weapons.setActive('beam');
    if (d5 && !sw.d5) this.weapons.setActive('ricochet');
    if (d6 && !sw.d6) this.weapons.setActive('voidlob');
    if (q  && !sw.q)  this.weapons.cycle(1);
    sw.d1 = d1; sw.d2 = d2; sw.d3 = d3; sw.d4 = d4; sw.d5 = d5; sw.d6 = d6; sw.q = q;

    // Secondaries on Z/X/C/V (F-keys conflict with browser & HUD F3 toggle).
    const f1 = i.down('KeyZ');
    const f2 = i.down('KeyX');
    const f3 = i.down('KeyC');
    const f4 = i.down('KeyV');
    const sp = this.ship.position;
    const h  = this.ship.heading;
    const nx = Math.sin(h), nz = Math.cos(h);
    const secCtx = {
      position: [sp.x + nx * 0.9, sp.y + 0.2, sp.z + nz * 0.9],
      direction: [nx, 0, nz],
    };
    if (f1 && !sw.f1) this.weapons.fire(secCtx, 'dash_nuke');
    if (f2 && !sw.f2) this.weapons.fire(secCtx, 'time_dilation');
    if (f3 && !sw.f3) this.weapons.fire(secCtx, 'singularity_grenade');
    if (f4 && !sw.f4) this.weapons.fire(secCtx, 'drone_swarm');
    sw.f1 = f1; sw.f2 = f2; sw.f3 = f3; sw.f4 = f4;

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

  /** Compute the current contract banner payload, or null to hide. */
  _currentContract() {
    if (!this.runState) return null;
    const s = this.runState.getState ? this.runState.getState() : null;
    if (!s || !s.biomeName) return null;
    // Only show while a wave is actively running or boss is fighting.
    if (s.state !== RUN_STATE.WAVE_ACTIVE && s.state !== RUN_STATE.BOSS_FIGHT) return null;
    const progress = s.wave ?? 0;
    const max = s.totalWaves ?? 0;
    return { name: s.biomeName, progress, max };
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.fx.setSize(w, h);
  }
}
