/**
 * AIMachine — the single opponent. It is the only fully modelled character in
 * the game (the player only ever sees their own arms), because the player has
 * to read its pose, its gun and which limb a bullet connected with.
 *
 * Every limb is its own mesh tagged `userData.region`, which is what makes
 * body-part hit detection exact instead of an approximation: the hitscan
 * literally raycasts these meshes.
 */
import * as THREE from 'three';
import { AI } from '../config/GameConfig.js';
import { createRifle } from '../weapons/RifleModel.js';
import { clamp, damp } from '../core/math.js';

const _UP = new THREE.Vector3(0, 0.04, 0);

const REGION_COLOR = {
  head: 0xff9c3c,
  chest: 0xffe9c9,
  lower: 0xdfe6ea,
  arm: 0xa8d8ff,
  leg: 0xa8d8ff,
};

export class AIMachine {
  constructor({ fx = null, audio = null } = {}) {
    this.fx = fx;
    this.audio = audio;
    this.root = new THREE.Group();
    this.root.name = 'ai-machine';
    this.health = AI.health;
    this.maxHealth = AI.health;
    this.alive = true;
    this.deathT = -1;
    this.hitFlash = 0;
    this.stride = 0;
    this.aimYaw = 0;
    this.aimPitch = 0;
    this.crouch = 0;
    this.damageStack = 0;

    const armour = new THREE.MeshStandardMaterial({ color: 0x4b5158, roughness: 0.44, metalness: 0.86 });
    const plate = new THREE.MeshStandardMaterial({ color: 0x6c737b, roughness: 0.5, metalness: 0.8 });
    const trim = new THREE.MeshStandardMaterial({ color: 0xc7642a, roughness: 0.5, metalness: 0.55 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x22262b, roughness: 0.62, metalness: 0.7 });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.95, metalness: 0.1 });
    this.visorMat = new THREE.MeshStandardMaterial({ color: 0x120a06, emissive: 0xff7a1a, emissiveIntensity: 1.4, roughness: 0.25, metalness: 0.4 });
    this.coreMat = new THREE.MeshStandardMaterial({ color: 0x101418, emissive: 0x2b6cff, emissiveIntensity: 0.9, roughness: 0.4, metalness: 0.3 });
    this.materials = [armour, plate, trim, dark, rubber];
    for (const m of this.materials) {
      m.userData.baseEmissive = m.emissive ? m.emissive.getHex() : 0x000000;
      m.userData.baseEmissiveIntensity = m.emissiveIntensity ?? 1;
    }
    this.visorMat.userData.baseIntensity = this.visorMat.emissiveIntensity;
    this.coreMat.userData.baseIntensity = this.coreMat.emissiveIntensity;
    this.armour = armour;
    this.plate = plate;

    const box = (w, h, d, mat, parent, x = 0, y = 0, z = 0, region = null) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.receiveShadow = true;
      if (region) {
        m.userData.region = region;
        m.userData.baseColor = mat === armour || mat === plate ? mat.color.getHex() : null;
      }
      parent.add(m);
      return m;
    };
    const cyl = (r1, r2, h, seg, mat, parent, x = 0, y = 0, z = 0, region = null) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, h, seg), mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      if (region) m.userData.region = region;
      parent.add(m);
      return m;
    };

    // ------------------------------------------------------------- skeleton
    this.hips = new THREE.Group();
    this.hips.position.y = 0.86;
    this.root.add(this.hips);

    this.pelvis = box(0.4, 0.22, 0.28, dark, this.hips, 0, -0.05, 0, 'lower');
    box(0.34, 0.06, 0.24, trim, this.hips, 0, 0.08, 0);

    this.torso = new THREE.Group();
    this.torso.position.y = 0.06;
    this.hips.add(this.torso);
    this.abdomen = box(0.36, 0.24, 0.26, armour, this.torso, 0, 0.12, 0, 'lower');
    this.chestMesh = box(0.46, 0.4, 0.32, plate, this.torso, 0, 0.44, 0, 'chest');
    box(0.5, 0.1, 0.34, armour, this.torso, 0, 0.66, 0); // collar / upper plate
    this.chestCore = box(0.1, 0.1, 0.03, this.coreMat, this.torso, 0, 0.46, -0.17);
    // back unit (power cell) — also counts as chest
    const back = box(0.3, 0.34, 0.16, dark, this.torso, 0, 0.46, 0.22, 'chest');
    cyl(0.055, 0.055, 0.3, 8, armour, this.torso, -0.09, 0.44, 0.31).rotation.x = Math.PI / 2;
    cyl(0.055, 0.055, 0.3, 8, armour, this.torso, 0.09, 0.44, 0.31).rotation.x = Math.PI / 2;
    box(0.14, 0.04, 0.06, trim, this.torso, 0, 0.68, 0.2);

    // head on a short neck: sensor bar + antenna + jaw guard
    this.neck = new THREE.Group();
    this.neck.position.set(0, 0.74, 0);
    this.torso.add(this.neck);
    cyl(0.07, 0.08, 0.08, 8, dark, this.neck, 0, 0.02, 0);
    this.head = new THREE.Group();
    this.head.position.y = 0.14;
    this.neck.add(this.head);
    this.headMesh = box(0.28, 0.26, 0.3, armour, this.head, 0, 0, 0, 'head');
    box(0.3, 0.07, 0.06, dark, this.head, 0, -0.1, -0.14); // jaw guard
    this.visor = box(0.24, 0.075, 0.03, this.visorMat, this.head, 0, 0.035, -0.16);
    this.visor.userData.region = 'head';
    box(0.06, 0.06, 0.14, dark, this.head, -0.15, 0.02, 0.02); // side sensor pods
    box(0.06, 0.06, 0.14, dark, this.head, 0.15, 0.02, 0.02);
    const ant = cyl(0.008, 0.008, 0.24, 5, trim, this.head, 0.1, 0.2, 0.06);
    ant.rotation.z = -0.25;

    // -------------------------------------------------------------- arms/gun
    const makeArm = (side) => {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.26, 0.6, 0);
      this.torso.add(shoulder);
      box(0.14, 0.12, 0.2, plate, shoulder, side * 0.02, 0.02, 0, 'arm');
      const upper = new THREE.Group();
      shoulder.add(upper);
      cyl(0.058, 0.05, 0.3, 7, armour, upper, 0, -0.16, 0, 'arm');
      const elbow = new THREE.Group();
      elbow.position.y = -0.31;
      upper.add(elbow);
      cyl(0.05, 0.045, 0.28, 7, armour, elbow, 0, -0.14, 0, 'arm');
      const hand = box(0.08, 0.1, 0.1, dark, elbow, 0, -0.3, -0.02);
      return { shoulder, upper, elbow, hand };
    };
    this.armR = makeArm(1);
    this.armL = makeArm(-1);

    // weapon is held by the right arm so it swings with the aim pose
    this.gun = createRifle({
      viewmodel: false,
      body: new THREE.MeshStandardMaterial({ color: 0x2c2f34, roughness: 0.5, metalness: 0.8 }),
      grip: dark,
      metal: new THREE.MeshStandardMaterial({ color: 0x1a1d21, roughness: 0.4, metalness: 0.9 }),
    });
    this.gun.scale.setScalar(0.94);
    this.armR.elbow.add(this.gun);
    this.gun.position.set(-0.02, -0.3, -0.12);
    this.gun.rotation.set(Math.PI / 2 - 0.12, 0, Math.PI);
    this.muzzle = new THREE.Object3D();
    this.gun.userData.muzzle.add(this.muzzle);
    this.muzzle.position.set(0, 0.02, -0.12);

    // --------------------------------------------------------------- legs
    const makeLeg = (side) => {
      const hip = new THREE.Group();
      hip.position.set(side * 0.13, -0.06, 0);
      this.hips.add(hip);
      cyl(0.082, 0.072, 0.4, 7, armour, hip, 0, -0.2, 0, 'leg');
      const knee = new THREE.Group();
      knee.position.y = -0.42;
      hip.add(knee);
      box(0.13, 0.11, 0.13, plate, knee, 0, 0.0, -0.01);
      cyl(0.068, 0.058, 0.38, 7, armour, knee, 0, -0.2, 0, 'leg');
      const foot = box(0.13, 0.08, 0.28, dark, knee, 0, -0.4, -0.05);
      return { hip, knee, foot };
    };
    this.legL = makeLeg(-1);
    this.legR = makeLeg(1);

    // hit registry: everything the player can shoot
    this.hitMeshes = [];
    this.root.traverse((o) => {
      if (o.isMesh && o.userData.region) {
        o.userData.hitColor = REGION_COLOR[o.userData.region] ?? 0xffffff;
        this.hitMeshes.push(o);
      }
    });
    this.raycaster = new THREE.Raycaster();
    this.raycaster.far = 400;
    this.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.5);
    this._tmp = new THREE.Vector3();
  }

  spawnAt(x, y, z, yaw = 0) {
    this.root.position.set(x, y, z);
    this.root.rotation.y = yaw;
    this.hips.rotation.y = 0;
    this.torso.rotation.y = 0;
    this.alive = true;
    this.deathT = -1;
    this.health = this.maxHealth;
    this.hitFlash = 0;
    this.root.visible = true;
    this.root.scale.set(1, 1, 1);
    for (const m of this.materials) {
      if (!m.emissive) continue;
      m.emissive.setHex(m.userData?.baseEmissive ?? 0x000000);
      m.emissiveIntensity = m.userData?.baseEmissiveIntensity ?? m.emissiveIntensity;
    }
    this.setVisor('patrol');
    this.updateBounds();
    this.root.updateMatrixWorld(true);
  }

  setVisor(state) {
    const map = {
      patrol: { c: 0xff7a1a, i: 0.9 },
      search: { c: 0xffd23c, i: 1.5 },
      engage: { c: 0xff2f2f, i: 2.6 },
      cover: { c: 0x35a0ff, i: 1.4 },
      reload: { c: 0x9d5cff, i: 1.6 },
      dead: { c: 0x1a0e08, i: 0.15 },
    };
    const v = map[state] ?? map.patrol;
    this.visorMat.color.setHex(state === 'dead' ? 0x0a0a0a : 0x120a06);
    this.visorMat.emissive.setHex(v.c);
    this.visorMat.emissiveIntensity = v.i;
  }

  get aliveFlag() {
    return this.alive;
  }

  position() {
    return this.root.position;
  }

  /** Point the player should be hit-scanned against / the AI aims at. */
  chestPoint(out = new THREE.Vector3()) {
    return this.chestMesh.getWorldPosition(out);
  }

  eyePoint(out = new THREE.Vector3()) {
    return this.head.getWorldPosition(out).add(_UP.set(0, 0.04, 0));
  }

  aimPoint(region, out = new THREE.Vector3()) {
    if (region === 'head') return this.head.getWorldPosition(out);
    if (region === 'leg') return out.copy(this.root.position).setY(this.root.position.y + 0.42);
    if (region === 'arm') return out.copy(this.root.position).setY(this.root.position.y + 1.1);
    if (region === 'lower') return out.copy(this.root.position).setY(this.root.position.y + 0.92);
    return this.chestPoint(out);
  }

  muzzlePoint(out = new THREE.Vector3()) {
    return this.muzzle.getWorldPosition(out);
  }

  /** Ground-relative feet height, used by the movement code. */
  get feetY() {
    return this.root.position.y;
  }

  updateBounds() {
    const p = this.root.position;
    this.boundingSphere.center.set(p.x, p.y + 0.95, p.z);
    this.boundingSphere.radius = 1.45;
  }

  /**
   * Procedural animation. No clips: legs step from the velocity, the upper body
   * independently tracks the aim vector (so the machine can strafe while still
   * swinging its gun onto you), and crouching bends the knees for cover.
   */
  update(dt, opts = {}) {
    const { speed = 0, aimYaw = this.aimYaw, aimPitch = this.aimPitch, crouch = 0, strafe = 0, moveYaw = null, firing = false, grounded = true } = opts;
    this.aimYaw = damp(this.aimYaw, aimYaw, 14, dt);
    this.aimPitch = damp(this.aimPitch, aimPitch, 12, dt);
    this.crouch = damp(this.crouch, crouch, 10, dt);
    this.hitFlash = Math.max(0, this.hitFlash - dt * 3.4);

    if (!this.alive) {
      this.#updateDeath(dt);
      this.updateBounds();
      return { footstep: false };
    }

    // ---- locomotion
    const cadence = clamp(speed / 2.6, 0, 2.4);
    this.stride += dt * (2.6 + cadence * 3.4);
    const swing = Math.sin(this.stride * 2) * clamp(cadence, 0, 1) * 0.62;
    const lift = Math.max(0, Math.sin(this.stride * 2)) * clamp(cadence, 0, 1) * 0.1;
    this.legL.hip.rotation.x = swing;
    this.legR.hip.rotation.x = -swing;
    this.legL.knee.rotation.x = -Math.max(0, -swing) * 1.3 - clamp(cadence, 0, 1) * 0.16;
    this.legR.knee.rotation.x = -Math.max(0, swing) * 1.3 - clamp(cadence, 0, 1) * 0.16;
    const crouchBend = this.crouch;
    this.hips.position.y = 0.86 - crouchBend * 0.26 - lift * 0.04;
    this.legL.hip.rotation.x += crouchBend * 0.55;
    this.legR.hip.rotation.x += crouchBend * 0.55;
    this.legL.knee.rotation.x -= crouchBend * 1.05;
    this.legR.knee.rotation.x -= crouchBend * 1.05;
    this.pelvis.rotation.x = crouchBend * 0.2;

    // upper body yaw is relative to the facing (hips) so it can over-rotate
    const facing = moveYaw ?? this.root.rotation.y;
    this.hips.rotation.y = damp(this.hips.rotation.y, wrapAngle(facing - this.root.rotation.y), 8, dt);
    this.torso.rotation.y = wrapAngle(this.aimYaw - this.root.rotation.y - this.hips.rotation.y);
    this.torso.rotation.x = damp(this.torso.rotation.x, -this.aimPitch * 0.55 + crouchBend * 0.24, 9, dt);
    this.torso.rotation.z = damp(this.torso.rotation.z, strafe * 0.1, 6, dt);
    this.head.rotation.y = clamp(wrapAngle(this.aimYaw - (this.root.rotation.y + this.hips.rotation.y + this.torso.rotation.y)), -0.7, 0.7);
    this.head.rotation.x = clamp(-this.aimPitch * 0.8, -0.6, 0.6);

    // arms: right on the pistol grip, left under the handguard
    const pitch = this.aimPitch;
    this.armR.shoulder.rotation.set(-Math.PI / 2 + pitch * 0.9 + 0.24, 0.16, -0.18);
    this.armR.elbow.rotation.x = 0.42 - pitch * 0.3;
    this.armL.shoulder.rotation.set(-Math.PI / 2 + pitch * 0.85 + 0.1, -0.42, 0.32);
    this.armL.elbow.rotation.x = 0.86 - pitch * 0.25;
    const fireKick = firing ? 0.06 : 0;
    this.recoil = damp(this.recoil ?? 0, fireKick, 22, dt);
    this.gun.position.z = -0.12 + this.recoil * 0.6;
    this.gun.rotation.x = Math.PI / 2 - 0.12 - this.recoil * 0.5;
    this.armR.elbow.rotation.x += this.recoil * 0.35;

    // subtle idle bob so it never looks frozen
    this.torso.position.y = 0.06 + Math.sin(this.stride * 1.1) * 0.008 + (grounded ? 0 : -0.02);

    // damage flash: the whole chassis briefly burns hot, then cools
    const flash = this.hitFlash;
    for (const m of this.materials) {
      if (!m.emissive) continue;
      if (flash > 0.02) {
        m.emissive.setHex(0xff4a26);
        m.emissiveIntensity = flash * 1.7;
      } else {
        m.emissive.setHex(m.userData.baseEmissive);
        m.emissiveIntensity = m.userData.baseEmissiveIntensity;
      }
    }
    const breathe = 1 + Math.sin((this.stride ?? 0) * 0.9) * 0.16;
    this.coreMat.emissiveIntensity = this.coreMat.userData.baseIntensity * breathe * (1 + flash * 2);
    this.visorMat.emissiveIntensity = this.visorMat.userData.baseIntensity * breathe * (1 + flash * 1.4);

    this.updateBounds();
    let footstep = false;
    const phase = Math.floor(this.stride * 2 / Math.PI);
    if (phase !== this._lastPhase && cadence > 0.16) {
      this._lastPhase = phase;
      footstep = true;
    }
    this.root.updateMatrixWorld(false);
    return { footstep, speed };
  }

  #updateDeath(dt) {
    this.deathT += dt;
    const t = clamp(this.deathT / 1.1, 0, 1);
    const e = 1 - Math.pow(1 - t, 2.4);
    this.root.rotation.x = -e * 1.5; // topples backwards
    this.root.position.y += Math.max(0, 0.28 - e * 0.3) * 0.02;
    this.hips.rotation.x = e * 0.5;
    this.torso.rotation.z = e * 0.4;
    this.legL.hip.rotation.x = 0.6 + e * 0.5;
    this.legR.hip.rotation.x = -0.3 - e * 0.4;
    this.armL.shoulder.rotation.z = 0.8 + e * 0.6;
    this.armR.shoulder.rotation.x = -0.4 - e * 0.5;
    if (this.fx && this.deathT < 1.6 && Math.random() < dt * 6) {
      const p = this.root.position;
      this.fx.smoke.spawn({
        x: p.x + (Math.random() - 0.5) * 0.5, y: p.y + 0.6, z: p.z + (Math.random() - 0.5) * 0.5,
        vx: (Math.random() - 0.5) * 0.5, vy: 1.2 + Math.random(), vz: (Math.random() - 0.5) * 0.5,
        life: 1.6 + Math.random(), size: 0.5, color: [0.3, 0.3, 0.32], alpha: 0.55,
      });
    }
    if (this.deathT > 0.2 && this.deathT < 0.5 && !this._burstDone) {
      this._burstDone = true;
      this.fx?.deathBurst(this.root.position);
    }
  }

  /** Registers damage; returns { killed, headshot } so callers can score it. */
  applyDamage(amount, region = 'chest', point = null) {
    if (!this.alive) return { killed: false, headshot: false };
    this.health = Math.max(0, this.health - amount);
    this.hitFlash = 1;
    this.damageStack += amount;
    if (point && this.fx) this.fx.hitSpot(point, { x: 0, y: 0.4, z: 1 }, { headshot: region === 'head' });
    if (this.fx) {
      const p = this.aimPoint(region, new THREE.Vector3());
      this.fx.hitSpot(p, { x: 0, y: 1, z: 0 }, { headshot: region === 'head' });
    }
    const killed = this.health <= 0;
    if (killed) this.kill();
    return { killed, headshot: region === 'head' };
  }

  kill() {
    if (!this.alive) return;
    this.alive = false;
    this.deathT = 0;
    this._burstDone = false;
    this.setVisor('dead');
    this.root.rotation.x = 0;
  }

  /**
   * Exact body-part hit test. Only runs when the shot ray is near the machine's
   * bounding sphere, so a miss down a road costs a single sphere test.
   */
  raycastRegion(raycaster, maxDistance) {
    this.raycaster.set(raycaster.ray.origin, raycaster.ray.direction);
    this.raycaster.near = 0;
    this.raycaster.far = maxDistance;
    const hits = this.raycaster.intersectObjects(this.hitMeshes, false);
    if (!hits.length) return null;
    const h = hits[0];
    return { region: h.object.userData.region ?? 'chest', point: h.point, distance: h.distance, normal: h.face ? h.face.normal.clone() : new THREE.Vector3(0, 1, 0), mesh: h.object };
  }

  dispose() {
    this.root.clear();
  }
}

export function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
