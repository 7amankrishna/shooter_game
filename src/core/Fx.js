/**
 * Fx — pooled, GPU-cheap visual effects.
 *
 * Everything (sparks, smoke, dust, coolant/blood puffs, bullet holes, shell
 * casings, tracers) is drawn from a fixed pool: one `Points` draw call per
 * particle field, one `LineSegments` call for all tracers, one `InstancedMesh`
 * for decals and casings. Zero geometry is created or destroyed at runtime, so
 * a sustained firefight produces no GC spikes and a bounded frame cost.
 */
import * as THREE from 'three';
import { FX } from '../config/GameConfig.js';
import { getTexture } from './Textures.js';
import { clamp, rand } from './math.js';

const PARTICLE_VS = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vAlpha = aAlpha;
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (260.0 / max(0.001, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const PARTICLE_FS = /* glsl */ `
  uniform sampler2D uMap;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec4 tex = texture2D(uMap, gl_PointCoord);
    float a = tex.a * vAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor * tex.rgb, a);
  }
`;

/** A single-draw-call particle field with per-particle size/colour/alpha. */
export class ParticleField {
  constructor({ capacity, blending = THREE.AdditiveBlending, gravity = -9, drag = 1.4, sizeGrow = 0, map = 'spark', baseSize = 0.16 }) {
    this.capacity = capacity;
    this.gravity = gravity;
    this.drag = drag;
    this.sizeGrow = sizeGrow;
    this.cursor = 0;
    this.count = 0;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.bounce = new Float32Array(capacity);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    this.geo = geo;

    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: getTexture(map) } },
      vertexShader: PARTICLE_VS,
      fragmentShader: PARTICLE_FS,
      transparent: true,
      depthWrite: false,
      blending,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this.points.name = 'particles';
  }

  spawn({ x, y, z, vx = 0, vy = 0, vz = 0, life = 0.5, size = 0.16, color = [1, 1, 1], alpha = 1, bounce = 0 }) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.col[i3] = color[0]; this.col[i3 + 1] = color[1]; this.col[i3 + 2] = color[2];
    this.size[i] = size;
    this.alpha[i] = alpha;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.bounce[i] = bounce;
    this.count = Math.min(this.count + 1, this.capacity);
  }

  update(dt, world, camPos, activeRadius = FX.simulateRadius) {
    const { pos, vel, life, alpha, size, capacity, maxLife, bounce } = this;
    let maxIndex = 0;
    let live = 0;
    for (let i = 0; i < capacity; i++) {
      if (life[i] <= 0) {
        if (alpha[i] !== 0) alpha[i] = 0;
        continue;
      }
      live++;
      const i3 = i * 3;
      // skip simulation for particles far from the camera (they fade out anyway)
      const dx = pos[i3] - camPos.x;
      const dz = pos[i3 + 2] - camPos.z;
      if (dx * dx + dz * dz > activeRadius * activeRadius) continue;
      life[i] -= dt;
      const t = Math.max(0, life[i] / Math.max(1e-4, maxLife[i]));
      const dragK = Math.max(0, 1 - this.drag * dt);
      vel[i3] *= dragK;
      vel[i3 + 1] = vel[i3 + 1] * dragK + this.gravity * dt;
      vel[i3 + 2] *= dragK;
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;
      if (this.sizeGrow) size[i] += this.sizeGrow * dt;
      alpha[i] = t * t;
      // cheap ground stop
      if (vel[i3 + 1] < 0 && world) {
        const g = world.groundHeightAt(pos[i3], pos[i3 + 2], pos[i3 + 1] + 0.4);
        if (pos[i3 + 1] < g) {
          pos[i3 + 1] = g + 0.02;
          if (bounce[i] > 0) {
            vel[i3 + 1] = -vel[i3 + 1] * this.bounce;
            vel[i3] *= 0.5;
            vel[i3 + 2] *= 0.5;
          } else {
            life[i] = Math.min(life[i], 0.12);
            vel[i3] = 0; vel[i3 + 1] = 0; vel[i3 + 2] = 0;
          }
        }
      }
      maxIndex = i + 1;
    }
    this.count = live;
    this.geo.setDrawRange(0, maxIndex);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
    this.alpha.fill(0);
    this.count = 0;
    this.geo.setDrawRange(0, 0);
  }
}

/**
 * All tracers in a single LineSegments draw call.
 *
 * Each tracer is a fixed-length bright segment that travels from muzzle to
 * impact over the real flight time, then fades. Positions and vertex colours
 * are written into pre-allocated buffers, so a full-auto burst costs one draw
 * call and no allocation.
 */
export class TracerField {
  constructor(max = FX.maxTracers) {
    this.max = max;
    this.cursor = 0;
    this.positions = new Float32Array(max * 6);
    this.colors = new Float32Array(max * 6);
    this.from = new Float32Array(max * 3);
    this.to = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.duration = new Float32Array(max);
    this.tail = new Float32Array(max);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, max * 2);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    this.geo = geo;
    this.lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 4;
    this.lines.name = 'tracers';
  }

  spawn(from, to, { speed = 900, color = [1, 0.86, 0.5] } = {}) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    const i3 = i * 3;
    this.from[i3] = from.x; this.from[i3 + 1] = from.y; this.from[i3 + 2] = from.z;
    this.to[i3] = to.x; this.to[i3 + 1] = to.y; this.to[i3 + 2] = to.z;
    this.col[i3] = color[0]; this.col[i3 + 1] = color[1]; this.col[i3 + 2] = color[2];
    const dist = Math.max(1, Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z));
    this.duration[i] = clamp(dist / speed, 0.02, 0.6);
    this.life[i] = this.duration[i] + 0.12; // small fade-out tail
    this.tail[i] = clamp(14 / dist, 0.12, 0.85);
  }

  update(dt) {
    const { life, duration, colors, positions, from, to, col, tail, max } = this;
    for (let i = 0; i < max; i++) {
      const o6 = i * 6;
      if (life[i] <= 0) {
        if (colors[o6] !== 0) {
          for (let k = 0; k < 6; k++) colors[o6 + k] = 0;
        }
        continue;
      }
      life[i] -= dt;
      const total = duration[i] + 0.12;
      const elapsed = total - life[i];
      const t = clamp(elapsed / duration[i], 0, 1);
      const fade = life[i] < 0.12 ? life[i] / 0.12 : 1;
      const t0 = Math.max(0, t - tail[i]);
      const i3 = i * 3;
      positions[o6] = from[i3] + (to[i3] - from[i3]) * t0;
      positions[o6 + 1] = from[i3 + 1] + (to[i3 + 1] - from[i3 + 1]) * t0;
      positions[o6 + 2] = from[i3 + 2] + (to[i3 + 2] - from[i3 + 2]) * t0;
      positions[o6 + 3] = from[i3] + (to[i3] - from[i3]) * t;
      positions[o6 + 4] = from[i3 + 1] + (to[i3 + 1] - from[i3 + 1]) * t;
      positions[o6 + 5] = from[i3 + 2] + (to[i3 + 2] - from[i3 + 2]) * t;
      colors[o6] = col[i3] * 0.1 * fade;
      colors[o6 + 1] = col[i3 + 1] * 0.1 * fade;
      colors[o6 + 2] = col[i3 + 2] * 0.1 * fade;
      colors[o6 + 3] = col[i3] * fade;
      colors[o6 + 4] = col[i3 + 1] * fade;
      colors[o6 + 5] = col[i3 + 2] * fade;
      void elapsed;
    }
    this.geo.attributes.color.needsUpdate = true;
    this.geo.attributes.position.needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
    this.colors.fill(0);
    this.geo.attributes.color.needsUpdate = true;
  }
}

/** Pooled bullet-hole decals + shell casings with 3-vertex "physics". */
export class DecalPool {
  constructor(max = FX.maxDecals, material) {
    this.max = max;
    this.cursor = 0;
    this.age = new Float32Array(max);
    const geo = new THREE.PlaneGeometry(0.22, 0.22);
    this.mesh = new THREE.InstancedMesh(geo, material, max);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'decals';
    this.empty = new THREE.Matrix4().makeScale(0.0001, 0.0001, 0.0001);
    for (let i = 0; i < max; i++) this.mesh.setMatrixAt(i, this.empty);
    this.mesh.instanceMatrix.needsUpdate = true;
    this._m = new THREE.Matrix4();
    this._up = new THREE.Vector3(0, 1, 0);
    this._look = new THREE.Vector3();
    this._pos = new THREE.Vector3();
  }

  spawn(point, normal, rng = Math.random) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    this._pos.set(point.x + normal.x * 0.015, point.y + normal.y * 0.015, point.z + normal.z * 0.015);
    this._look.set(point.x + normal.x, point.y + normal.y, point.z + normal.z);
    this._m.lookAt(this._pos, this._look, Math.abs(normal.y) > 0.9 ? new THREE.Vector3(0, 0, 1) : this._up);
    const s = 0.6 + rng() * 0.8;
    this._m.scale(new THREE.Vector3(s, s, s));
    this._m.setPosition(this._pos);
    this.mesh.setMatrixAt(i, this._m);
    this.age[i] = 1;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt) {
    let dirty = false;
    for (let i = 0; i < this.max; i++) {
      if (this.age[i] <= 0) continue;
      this.age[i] -= dt / 26;
      if (this.age[i] <= 0) {
        this.age[i] = 0;
        this.mesh.setMatrixAt(i, this.empty);
        dirty = true;
      }
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear() {
    for (let i = 0; i < this.max; i++) this.mesh.setMatrixAt(i, this.empty);
    this.age.fill(0);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

export class ShellPool {
  constructor(max = FX.maxShells, material) {
    this.max = max;
    this.cursor = 0;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.rot = new Float32Array(max * 3);
    this.spin = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    const geo = new THREE.CylinderGeometry(0.011, 0.013, 0.055, 5);
    geo.rotateZ(Math.PI / 2);
    this.mesh = new THREE.InstancedMesh(geo, material, max);
    this.mesh.castShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'shells';
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._v = new THREE.Vector3();
    this.empty = new THREE.Matrix4().makeScale(0.0001, 0.0001, 0.0001);
    for (let i = 0; i < max; i++) this.mesh.setMatrixAt(i, this.empty);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  spawn(origin, dir, right, rng = Math.random) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    const i3 = i * 3;
    this.pos[i3] = origin.x; this.pos[i3 + 1] = origin.y; this.pos[i3 + 2] = origin.z;
    const eject = 2.2 + rng() * 1.4;
    this.vel[i3] = right.x * eject + dir.x * 1.2 + (rng() - 0.5);
    this.vel[i3 + 1] = 2.4 + rng() * 1.2;
    this.vel[i3 + 2] = right.z * eject + dir.z * 1.2 + (rng() - 0.5);
    this.rot[i3] = rng() * 6.28; this.rot[i3 + 1] = rng() * 6.28; this.rot[i3 + 2] = rng() * 6.28;
    this.spin[i3] = (rng() - 0.5) * 22; this.spin[i3 + 1] = (rng() - 0.5) * 22; this.spin[i3 + 2] = (rng() - 0.5) * 22;
    this.life[i] = 2.6;
  }

  update(dt, world, onBounce) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      const i3 = i * 3;
      this.life[i] -= dt;
      this.vel[i3 + 1] -= 22 * dt;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      this.rot[i3] += this.spin[i3] * dt;
      this.rot[i3 + 1] += this.spin[i3 + 1] * dt;
      this.rot[i3 + 2] += this.spin[i3 + 2] * dt;
      const g = world ? world.groundHeightAt(this.pos[i3], this.pos[i3 + 2], this.pos[i3 + 1] + 0.2) : 0;
      if (this.pos[i3 + 1] < g) {
        this.pos[i3 + 1] = g;
        if (this.vel[i3 + 1] < -1) {
          onBounce?.(this.pos[i3], this.pos[i3 + 1], this.pos[i3 + 2]);
          this.vel[i3 + 1] = -this.vel[i3 + 1] * 0.32;
          this.vel[i3] *= 0.55;
          this.vel[i3 + 2] *= 0.55;
          this.spin[i3] *= 0.4;
          this.spin[i3 + 1] *= 0.4;
        } else {
          this.vel[i3] = this.vel[i3 + 1] = this.vel[i3 + 2] = 0;
          this.life[i] = Math.min(this.life[i], 0.6);
        }
      }
      if (this.life[i] <= 0) {
        this.mesh.setMatrixAt(i, this.empty);
      } else {
        this._e.set(this.rot[i3], this.rot[i3 + 1], this.rot[i3 + 2]);
        this._q.setFromEuler(this._e);
        const fade = clamp(this.life[i] / 0.6, 0.05, 1);
        this._v.set(this.pos[i3], this.pos[i3 + 1] + 0.012, this.pos[i3 + 2]);
        this._m.compose(this._v, this._q, new THREE.Vector3(fade, fade, fade));
        this.mesh.setMatrixAt(i, this._m);
      }
      this.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  clear() {
    this.life.fill(0);
    for (let i = 0; i < this.max; i++) this.mesh.setMatrixAt(i, this.empty);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/**
 * Facade the rest of the game talks to. Keeps the effect vocabulary in one
 * place so weapon/AI code never touches buffers directly.
 */
export class Fx {
  constructor({ materials }) {
    this.rng = Math.random;
    this.sparks = new ParticleField({ capacity: 620, blending: THREE.AdditiveBlending, gravity: -14, drag: 1.9, map: 'spark', baseSize: 0.13 });
    this.smoke = new ParticleField({ capacity: 420, blending: THREE.NormalBlending, gravity: 1.4, drag: 0.9, sizeGrow: 0.55, map: 'dot', baseSize: 0.4 });
    this.fluid = new ParticleField({ capacity: 320, blending: THREE.NormalBlending, gravity: -20, drag: 0.6, map: 'dot', baseSize: 0.1 });
    this.tracers = new TracerField(FX.maxTracers);
    this.decals = new DecalPool(FX.maxDecals, materials.decal);
    this.shells = new ShellPool(FX.maxShells, materials.brass ?? new THREE.MeshLambertMaterial({ color: 0xb08d4a }));
    this.group = new THREE.Group();
    this.group.name = 'fx';
    this.group.add(this.sparks.points, this.smoke.points, this.fluid.points, this.tracers.lines, this.decals.mesh, this.shells.mesh);
    this.world = null;
  }

  attach(scene) {
    scene.add(this.group);
  }

  setWorld(world) {
    this.world = world;
  }

  update(dt, camPos) {
    this.sparks.update(dt, this.world, camPos);
    this.smoke.update(dt, this.world, camPos);
    this.fluid.update(dt, this.world, camPos, 26);
    this.tracers.update(dt);
    this.decals.update(dt);
    this.shells.update(dt, this.world, (x, y, z) => this.playShellBounce?.(x, y, z));
  }

  clear() {
    this.sparks.clear();
    this.smoke.clear();
    this.fluid.clear();
    this.tracers.clear();
    this.decals.clear();
    this.shells.clear();
  }

  /* ----------------------------------------------------------- emitters */

  muzzleFlash(pos, dir) {
    const n = 5;
    for (let i = 0; i < n; i++) {
      const s = 0.6 + Math.random() * 2.4;
      this.sparks.spawn({
        x: pos.x, y: pos.y, z: pos.z,
        vx: dir.x * s + (Math.random() - 0.5) * 1.6,
        vy: dir.y * s + (Math.random() - 0.5) * 1.6,
        vz: dir.z * s + (Math.random() - 0.5) * 1.6,
        life: 0.05 + Math.random() * 0.08,
        size: 0.1 + Math.random() * 0.16,
        color: [1, 0.82 + Math.random() * 0.15, 0.42],
      });
    }
    this.smoke.spawn({
      x: pos.x, y: pos.y, z: pos.z,
      vx: dir.x * 1.6, vy: 0.5, vz: dir.z * 1.6,
      life: 0.7, size: 0.22, color: [0.6, 0.6, 0.62], alpha: 0.4,
    });
  }

  impact(point, normal, surface = 'concrete') {
    const warm = surface === 'metal' ? [1, 0.75, 0.35] : surface === 'sand' ? [1, 0.86, 0.6] : [1, 0.9, 0.7];
    const count = surface === 'metal' ? 9 : 6;
    for (let i = 0; i < count; i++) {
      const spread = 3.2;
      this.sparks.spawn({
        x: point.x + normal.x * 0.03, y: point.y + normal.y * 0.03, z: point.z + normal.z * 0.03,
        vx: (normal.x + (Math.random() - 0.5)) * spread,
        vy: (normal.y + Math.random() * 0.7) * spread,
        vz: (normal.z + (Math.random() - 0.5)) * spread,
        life: 0.16 + Math.random() * 0.3,
        size: 0.06 + Math.random() * 0.09,
        color: warm,
        bounce: 0.3,
      });
    }
    for (let i = 0; i < 4; i++) {
      this.smoke.spawn({
        x: point.x, y: point.y, z: point.z,
        vx: normal.x * 1.4 + (Math.random() - 0.5), vy: 0.8 + Math.random(), vz: normal.z * 1.4 + (Math.random() - 0.5),
        life: 0.45 + Math.random() * 0.5, size: 0.2, color: [0.66, 0.63, 0.58], alpha: 0.5,
      });
    }
    this.decals.spawn(point, normal, Math.random);
  }

  /** Restrained hit feedback for the machine: coolant mist + sparks, no gore. */
  hitSpot(point, normal, { headshot = false } = {}) {
    const sparks = headshot ? 14 : 8;
    for (let i = 0; i < sparks; i++) {
      this.sparks.spawn({
        x: point.x, y: point.y, z: point.z,
        vx: (Math.random() - 0.5) * 4.4 + normal.x, vy: Math.random() * 3.2, vz: (Math.random() - 0.5) * 4.4 + normal.z,
        life: 0.18 + Math.random() * 0.24, size: 0.07 + Math.random() * 0.1,
        color: headshot ? [1, 0.95, 0.6] : [1, 0.7, 0.35],
      });
    }
    // Coolant, not blood: the target is a machine, and the brief asks for
    // restrained hit feedback with no gore. Short-lived, bright, few.
    for (let i = 0; i < (headshot ? 9 : 5); i++) {
      this.fluid.spawn({
        x: point.x, y: point.y, z: point.z,
        vx: (Math.random() - 0.5) * 2.6, vy: 0.6 + Math.random() * 1.6, vz: (Math.random() - 0.5) * 2.6,
        life: 0.18 + Math.random() * 0.26, size: 0.04 + Math.random() * 0.06,
        color: headshot ? [1, 0.9, 0.6] : [1, 0.66, 0.3], alpha: 0.7, bounce: 0.1,
      });
    }
    for (let i = 0; i < 2; i++) {
      this.smoke.spawn({
        x: point.x, y: point.y, z: point.z,
        vx: normal.x * 0.5, vy: 0.5, vz: normal.z * 0.5,
        life: 0.4, size: 0.14, color: [0.75, 0.72, 0.66], alpha: 0.3,
      });
    }
  }

  tracer(from, to, { color, speed } = {}) {
    this.tracers.spawn(from, to, { color: color ?? [1, 0.84, 0.5], speed: speed ?? 1100 });
  }

  eject(origin, dir, right) {
    this.shells.spawn(origin, dir, right, Math.random);
  }

  footstep(pos, { dust = true } = {}) {
    if (!dust) return;
    for (let i = 0; i < 3; i++) {
      this.smoke.spawn({
        x: pos.x + (Math.random() - 0.5) * 0.3, y: pos.y + 0.05, z: pos.z + (Math.random() - 0.5) * 0.3,
        vx: (Math.random() - 0.5) * 0.6, vy: 0.25, vz: (Math.random() - 0.5) * 0.6,
        life: 0.4 + Math.random() * 0.3, size: 0.16, color: [0.62, 0.58, 0.5], alpha: 0.35,
      });
    }
  }

  debris(pos, color = [0.5, 0.48, 0.44], count = 8) {
    for (let i = 0; i < count; i++) {
      this.sparks.spawn({
        x: pos.x, y: pos.y, z: pos.z,
        vx: (Math.random() - 0.5) * 3, vy: 1 + Math.random() * 2.4, vz: (Math.random() - 0.5) * 3,
        life: 0.5 + Math.random() * 0.6, size: 0.05 + Math.random() * 0.06, color, bounce: 0.25,
      });
    }
  }

  deathBurst(pos) {
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1 + Math.random() * 6;
      this.sparks.spawn({
        x: pos.x, y: pos.y + 1, z: pos.z,
        vx: Math.cos(a) * sp, vy: 1 + Math.random() * 5, vz: Math.sin(a) * sp,
        life: 0.3 + Math.random() * 0.7, size: 0.08 + Math.random() * 0.14,
        color: [1, 0.6 + Math.random() * 0.3, 0.25], bounce: 0.2,
      });
    }
    for (let i = 0; i < 16; i++) {
      this.smoke.spawn({
        x: pos.x + (Math.random() - 0.5), y: pos.y + 0.8 + Math.random(), z: pos.z + (Math.random() - 0.5),
        vx: (Math.random() - 0.5) * 1.6, vy: 1.1 + Math.random() * 1.2, vz: (Math.random() - 0.5) * 1.6,
        life: 1.4 + Math.random(), size: 0.6, color: [0.35, 0.34, 0.33], alpha: 0.7,
      });
    }
  }
}
