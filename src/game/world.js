// World — owns the scene graph, camera, ECS, and the per-frame orchestration.
// The scaffold renders a placeholder singularity (core + accretion disk + starfield)
// so the build is visibly alive. Gameplay systems are layered in SPRINT-02+.

import {
  Scene, PerspectiveCamera, Group, Color,
  IcosahedronGeometry, TorusGeometry, BufferGeometry, Float32BufferAttribute,
  Mesh, Points, MeshBasicMaterial, PointsMaterial,
  PointLight, AmbientLight, AdditiveBlending,
} from 'three';
import { ECS } from '../engine/ecs.js';
import { createPostFX } from '../render/postfx.js';
import { createAccretionDiskMaterial } from '../shaders/disk.js';

export class World {
  constructor({ renderer, input, cap }) {
    this.renderer = renderer;
    this.input = input;
    this.cap = cap;
    this.ecs = new ECS();
    this.scene = new Scene();
    this.scene.background = new Color(0x02030a);
    this.camera = new PerspectiveCamera(60, 1, 0.1, 2000);
    this.camera.position.set(0, 14, 26);
    this.camera.lookAt(0, 0, 0);
    this._firstFrameCbs = [];
    this._framed = false;
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
  }

  _starfield(count, radius) {
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const r = radius * (0.6 + Math.random() * 0.4);
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
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
    this.ecs.run(dt);
  }

  render(/* alpha */) {
    this.fx.render();
    if (!this._framed) {
      this._framed = true;
      this._firstFrameCbs.forEach((cb) => cb());
    }
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.fx.setSize(w, h);
  }
}
