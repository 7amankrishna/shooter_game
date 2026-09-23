/**
 * Zombie — the procedural body + animation of the infected.
 *
 * Every limb is its own mesh tagged `userData.region` (head / chest / limb),
 * which makes body-part hit detection exact: the hitscan literally raycasts
 * these meshes, so a headshot is a headshot and a leg shot slows nothing but
 * pays less. Five archetypes share this one rig — differences are scale,
 * colours, poise and the crawler's ground-hugging pose.
 *
 * Animation is procedural: a lurching stride drives the limbs, the attack is a
 * windup→swipe arc, hits stagger, death topples and the corpse lingers before
 * sinking away. Nothing is keyframed, so any speed/pose blend is continuous.
 */
import * as THREE from 'three';
import { ZOMBIE_TYPES, ZOMBIES } from '../config/GameConfig.js';
import { clamp, damp, lerp, rand } from '../core/math.js';

export class Zombie {
  constructor(typeKey, { fx = null, audio = null } = {}) {
    this.type = ZOMBIE_TYPES[typeKey] ?? ZOMBIE_TYPES.walker;
    this.typeKey = this.type.id;
    this.fx = fx;
    this.audio = audio;
    this.maxHealth = this.type.health;
    this.health = this.type.health;
    this.alive = false;
    this.active = false;
    this.root = new THREE.Group();
    this.root.name = `zombie_${this.typeKey}`;
    this.root.visible = false;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.stride = 0;
    this.hitFlash = 0;
    this.attackT = -1;
    this.screamT = -1;
    this.staggerT = 0;
    this.deathT = -1;
    this.corpseT = 0;
    this.sinkT = -1;
    this.bloodColor = [0.45, 0.05, 0.06];
    this.#build();
    this.raycaster = new THREE.Raycaster();
    this.raycaster.far = 400;
    this.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.4);
    this._tmp = new THREE.Vector3();
  }

  #build() {
    const t = this.type;
    const skinMat = new THREE.MeshLambertMaterial({ color: t.colors.skin, flatShading: true });
    const clothMat = new THREE.MeshLambertMaterial({ color: t.colors.cloth, flatShading: true });
    const darkMat = new THREE.MeshLambertMaterial({ color: 0x1e1a16, flatShading: true });
    this.eyeMat = new THREE.MeshBasicMaterial({ color: t.colors.eyes });
    this.mats = [skinMat, clothMat, darkMat];
    this.skinMat = skinMat;

    const box = (w, h, d, mat, parent, x, y, z, region = null) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      if (region) m.userData.region = region;
      parent.add(m);
      return m;
    };
    const cyl = (r1, r2, h, seg, mat, parent, x, y, z, region = null) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, h, seg), mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      if (region) m.userData.region = region;
      parent.add(m);
      return m;
    };

    // ---- torso on hips
    this.hips = new THREE.Group();
    this.hips.position.y = 0.88;
    this.root.add(this.hips);
    box(0.38, 0.2, 0.26, darkMat, this.hips, 0, -0.04, 0, 'chest');
    this.torso = new THREE.Group();
    this.torso.position.y = 0.05;
    this.hips.add(this.torso);
    this.chestMesh = box(0.44, 0.44, 0.3, clothMat, this.torso, 0, 0.26, 0, 'chest');
    box(0.4, 0.24, 0.27, skinMat, this.torso, 0, 0.03, 0, 'chest');
    // ragged shoulder pad / torn cloth detail
    box(0.5, 0.1, 0.32, clothMat, this.torso, 0, 0.46, 0, 'chest');
    // gore patch
    box(0.16, 0.12, 0.02, darkMat, this.torso, 0.1, 0.2, -0.155);

    // ---- head + jaw + eyes
    this.neck = new THREE.Group();
    this.neck.position.set(0, 0.52, 0);
    this.torso.add(this.neck);
    this.head = new THREE.Group();
    this.head.position.y = 0.16;
    this.neck.add(this.head);
    this.headMesh = box(0.26, 0.28, 0.27, skinMat, this.head, 0, 0, 0, 'head');
    this.jaw = box(0.2, 0.09, 0.2, skinMat, this.head, 0, -0.15, -0.03, 'head');
    this.eyeL = box(0.045, 0.03, 0.02, this.eyeMat, this.head, -0.06, 0.04, -0.135, 'head');
    this.eyeR = box(0.045, 0.03, 0.02, this.eyeMat, this.head, 0.06, 0.04, -0.135, 'head');
    // scraggly hair tuft
    box(0.18, 0.06, 0.16, darkMat, this.head, 0, 0.15, 0.02);

    // ---- arms (raised, grasping)
    const makeArm = (side) => {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.26, 0.42, 0);
      this.torso.add(shoulder);
      box(0.13, 0.12, 0.16, clothMat, shoulder, 0, 0, 0, 'limb');
      const upper = new THREE.Group();
      shoulder.add(upper);
      cyl(0.055, 0.05, 0.3, 6, skinMat, upper, 0, -0.16, 0, 'limb');
      const elbow = new THREE.Group();
      elbow.position.y = -0.32;
      upper.add(elbow);
      cyl(0.048, 0.042, 0.28, 6, skinMat, elbow, 0, -0.15, 0, 'limb');
      const hand = box(0.09, 0.12, 0.09, skinMat, elbow, 0, -0.32, 0, 'limb');
      // fingers
      for (let i = 0; i < 3; i++) box(0.02, 0.07, 0.02, skinMat, elbow, -0.025 + i * 0.025, -0.4, -0.02, 'limb');
      return { shoulder, upper, elbow, hand };
    };
    this.armR = makeArm(1);
    this.armL = makeArm(-1);

    // ---- legs
    const makeLeg = (side) => {
      const hip = new THREE.Group();
      hip.position.set(side * 0.12, -0.08, 0);
      this.hips.add(hip);
      cyl(0.075, 0.065, 0.42, 6, clothMat, hip, 0, -0.22, 0, 'limb');
      const knee = new THREE.Group();
      knee.position.y = -0.44;
      hip.add(knee);
      cyl(0.062, 0.05, 0.4, 6, clothMat, knee, 0, -0.21, 0, 'limb');
      box(0.12, 0.08, 0.24, darkMat, knee, 0, -0.44, -0.04);
      return { hip, knee };
    };
    this.legL = makeLeg(-1);
    this.legR = makeLeg(1);

    // scale + crawler rig adjustments
    const s = this.type.scale;
    this.root.scale.setScalar(s);
    this.crawler = this.typeKey === 'crawler';
    if (this.crawler) {
      this.hips.position.y = 0.42;
      this.torso.rotation.x = 1.05;
      this.legL.hip.rotation.x = -0.25;
      this.legR.hip.rotation.x = -0.25;
    } else {
      // permanent hunch — the classic silhouette
      this.torso.rotation.x = 0.22 + Math.random() * 0.12;
    }

    // hit registry
    this.hitMeshes = [];
    this.root.traverse((o) => {
      if (o.isMesh && o.userData.region) this.hitMeshes.push(o);
    });
  }

  spawnAt(x, y, z, yaw, hpScale = 1) {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.maxHealth = Math.round(this.type.health * hpScale);
    this.health = this.maxHealth;
    this.alive = true;
    this.active = true;
    this.attackT = -1;
    this.screamT = -1;
    this.staggerT = 0;
    this.deathT = -1;
    this.corpseT = 0;
    this.sinkT = -1;
    this.hitFlash = 0;
    this.stride = Math.random() * 10;
    this.root.visible = true;
    this.root.rotation.set(0, yaw, 0);
    this.root.position.copy(this.pos);
    this.root.scale.setScalar(this.type.scale);
    this.personality = {
      speedMul: 0.9 + Math.random() * 0.22,
      moanPitch: 0.8 + Math.random() * 0.5,
      lateral: (Math.random() - 0.5) * 2.4,
    };
    this.updateBounds();
    this.root.updateMatrixWorld(true);
  }

  despawn() {
    this.active = false;
    this.alive = false;
    this.root.visible = false;
  }

  updateBounds() {
    const s = this.type.scale;
    this.boundingSphere.center.set(this.pos.x, this.pos.y + 0.9 * s, this.pos.z);
    this.boundingSphere.radius = 1.15 * s + (this.crawler ? 0 : 0.25);
  }

  aimPoint(region, out = new THREE.Vector3()) {
    const s = this.type.scale;
    if (region === 'head') return out.set(this.pos.x, this.pos.y + (this.crawler ? 0.62 : 1.52) * s, this.pos.z);
    return out.set(this.pos.x, this.pos.y + (this.crawler ? 0.35 : 1.0) * s, this.pos.z);
  }

  /**
   * Registers damage. Returns { killed, staggered }.
   * Poise: big hits and headshots break the stride; brutes shrug off rifle rounds.
   */
  applyDamage(amount, region = 'chest', point = null, dir = null) {
    if (!this.alive) return { killed: false, staggered: false };
    this.health -= amount;
    this.hitFlash = 1;
    // knock impulse
    if (dir) {
      this.vel.x += dir.x * Math.min(2.4, amount * 0.045);
      this.vel.z += dir.z * Math.min(2.4, amount * 0.045);
    }
    const staggerDamage = amount + (region === 'head' ? 14 : 0);
    let staggered = false;
    if (staggerDamage >= this.type.poise && this.staggerT <= 0) {
      this.staggerT = clamp(0.28 + staggerDamage * 0.004, 0.28, 0.75);
      staggered = true;
    }
    if (point && this.fx) {
      this.fx.bloodSpray(point, dir, { heavy: region === 'head' });
    }
    if (this.health <= 0) {
      this.kill(dir);
      return { killed: true, staggered: true };
    }
    return { killed: false, staggered };
  }

  kill(dir = null) {
    if (!this.alive) return;
    this.alive = false;
    this.deathT = 0;
    this.corpseT = 0;
    this.attackT = -1;
    // topple away from the shot
    this.deathYaw = dir ? Math.atan2(dir.x, dir.z) : this.yaw + Math.PI;
    if (this.fx) {
      this.fx.bloodBurst(this.aimPoint('chest', this._tmp), 14);
      this.fx.bloodDecal(this.pos.x, this.pos.z, this.pos.y);
    }
  }

  startAttack() {
    if (this.attackT < 0) this.attackT = 0;
  }

  startScream() {
    if (this.screamT < 0) this.screamT = 0;
  }

  /**
   * Procedural animation. opts: { speed, animT (0..1 attack phase), attackWindup }
   */
  update(dt, opts = {}) {
    const { speed = 0, grounded = true, animFar = false } = opts;
    if (!this.active) return { footstep: false };
    this.hitFlash = Math.max(0, this.hitFlash - dt * 3.2);

    if (!this.alive) {
      this.#updateDeath(dt);
      this.updateBounds();
      return { footstep: false };
    }

    // ---- stagger
    if (this.staggerT > 0) this.staggerT -= dt;

    // ---- scream (screamer)
    if (this.screamT >= 0) {
      this.screamT += dt;
      if (this.screamT > 1.4) this.screamT = -1;
    }

    // ---- attack phase
    if (this.attackT >= 0) {
      this.attackT += dt;
      const cycle = this.type.attackWindup + 0.35;
      if (this.attackT > cycle) this.attackT = -1;
    }

    if (animFar) {
      // beyond animation distance: keep the transform honest, skip the pose
      this.root.position.copy(this.pos);
      this.root.rotation.y = this.yaw;
      this.updateBounds();
      return { footstep: false };
    }

    // ---- locomotion: lurching stride
    const cadence = clamp(speed / (this.type.sprintSpeed || this.type.speed), 0, 1.2);
    this.stride += dt * (2.2 + cadence * 5.2) * (this.crawler ? 1.5 : 1);
    const swing = Math.sin(this.stride * 2) * clamp(cadence, 0, 1);
    const lift = Math.max(0, Math.sin(this.stride * 2)) * clamp(cadence, 0, 1) * 0.09;
    const hurt = this.staggerT > 0 ? clamp(this.staggerT * 2.5, 0, 1) : 0;

    if (this.crawler) {
      // dragging crawl: arms alternate, torso rocks
      this.armR.shoulder.rotation.x = -0.9 + swing * 0.75;
      this.armL.shoulder.rotation.x = -0.9 - swing * 0.75;
      this.armR.elbow.rotation.x = -0.5 - Math.max(0, swing) * 0.5;
      this.armL.elbow.rotation.x = -0.5 - Math.max(0, -swing) * 0.5;
      this.torso.rotation.z = swing * 0.14;
      this.torso.rotation.x = 1.05 + Math.sin(this.stride * 2) * 0.05;
      this.hips.position.y = 0.42 + Math.abs(swing) * 0.05;
      this.legL.knee.rotation.x = -0.2;
      this.legR.knee.rotation.x = -0.2;
    } else {
      this.legL.hip.rotation.x = swing * 0.62 - hurt * 0.35;
      this.legR.hip.rotation.x = -swing * 0.62 - hurt * 0.35;
      this.legL.knee.rotation.x = -Math.max(0, -swing) * 1.15 - 0.12;
      this.legR.knee.rotation.x = -Math.max(0, swing) * 1.15 - 0.12;
      // asymmetric lurch: the whole body rolls with the stride
      this.hips.rotation.z = Math.sin(this.stride) * 0.08 * cadence + hurt * 0.22;
      this.hips.position.y = 0.88 + lift - (this.staggerT > 0 ? 0.12 : 0);
      this.torso.rotation.z = -this.hips.rotation.z * 0.6;
      this.torso.rotation.x = 0.24 + Math.sin(this.stride * 2 + 1) * 0.04 + hurt * 0.5;
      // arms: reaching forward, bobbing with the stride
      const reach = 1.15 + Math.sin(this.stride * 2) * 0.1;
      this.armR.shoulder.rotation.set(-reach + hurt * 0.8, 0.15, -0.15 - Math.sin(this.stride) * 0.06);
      this.armL.shoulder.rotation.set(-reach - Math.sin(this.stride) * 0.12, -0.2, 0.2);
      this.armR.elbow.rotation.x = -0.55;
      this.armL.elbow.rotation.x = -0.7;
      // head: fixed on the target, slight tilt for the creep factor
      this.head.rotation.z = 0.12 + Math.sin(this.stride * 0.5) * 0.06;
    }

    // ---- attack windup/swipe overlays the walk
    if (this.attackT >= 0) {
      const t = this.attackT;
      const w = this.type.attackWindup;
      const k = t < w ? t / w : 1 - clamp((t - w) / 0.35, 0, 1); // rise then fall
      const arm = this.crawler ? 0.6 : 1;
      this.armR.shoulder.rotation.x = lerp(this.armR.shoulder.rotation.x, -2.4, k * 0.9);
      this.armR.shoulder.rotation.z = lerp(this.armR.shoulder.rotation.z, -0.7 * arm, k);
      this.armL.shoulder.rotation.x = lerp(this.armL.shoulder.rotation.x, -2.2, k * 0.8);
      this.torso.rotation.x = lerp(this.torso.rotation.x, this.crawler ? 1.25 : 0.55, k * 0.6);
    }

    // ---- scream: head back, jaw wide
    if (this.screamT >= 0) {
      const k = Math.sin(clamp(this.screamT / 1.4, 0, 1) * Math.PI);
      this.neck.rotation.x = -0.65 * k;
      this.jaw.position.y = -0.15 - k * 0.06;
      this.jaw.scale.y = 1 + k * 1.6;
    } else {
      this.neck.rotation.x = damp(this.neck.rotation.x, 0, 8, dt);
      this.jaw.position.y = damp(this.jaw.position.y, -0.15, 8, dt);
      this.jaw.scale.y = damp(this.jaw.scale.y, 1, 8, dt);
    }

    // ---- hurt flash
    if (this.hitFlash > 0.02) {
      this.skinMat.emissive = this.skinMat.emissive ?? new THREE.Color();
      this.skinMat.emissive.setRGB(0.45 * this.hitFlash, 0.02, 0.02);
    } else if (this.skinMat.emissive) {
      this.skinMat.emissive.setRGB(0, 0, 0);
    }

    this.root.position.copy(this.pos);
    this.root.rotation.y = this.yaw;
    this.root.rotation.z = 0;
    this.updateBounds();
    this.root.updateMatrixWorld(false);

    // footstep phase for audio
    let footstep = false;
    const phase = Math.floor(this.stride * 2 / Math.PI);
    if (phase !== this._lastPhase && cadence > 0.14) {
      this._lastPhase = phase;
      footstep = true;
    }
    return { footstep, speed };
  }

  #updateDeath(dt) {
    if (this.sinkT >= 0) {
      // corpse sinking away after its time is up
      this.sinkT += dt;
      const k = clamp(this.sinkT / 1.6, 0, 1);
      this.root.position.y = this.pos.y - k * 1.4;
      if (k >= 1) this.despawn();
      return;
    }
    this.deathT += dt;
    this.corpseT += dt;
    // topple (ease-out) around the axis away from the killing shot
    const t = clamp(this.deathT / 0.9, 0, 1);
    const e = 1 - Math.pow(1 - t, 2.2);
    const fall = this.crawler ? 0.4 : Math.PI / 2 * 0.96;
    this.root.rotation.x = 0;
    this.torso.rotation.x = lerp(this.torso.rotation.x, this.crawler ? 1.2 : 0.7, e * 0.4);
    this.hips.rotation.z = e * 0.3;
    // rotate the root over: fall direction encoded in yaw offset
    this.root.rotation.z = e * fall * Math.cos(this.deathYaw - this.yaw);
    this.root.rotation.x = e * fall * Math.sin(this.deathYaw - this.yaw) * 0.6;
    this.hips.position.y = (this.crawler ? 0.42 : 0.88) - e * 0.55;
    this.armR.shoulder.rotation.x = lerp(this.armR.shoulder.rotation.x, -0.3, e * 0.5);
    this.armL.shoulder.rotation.x = lerp(this.armL.shoulder.rotation.x, -0.2, e * 0.5);
    this.legL.hip.rotation.x = lerp(this.legL.hip.rotation.x, 0.3, e * 0.5);
    this.legR.hip.rotation.x = lerp(this.legR.hip.rotation.x, -0.2, e * 0.5);
    if (this.corpseT > ZOMBIES.corpseTTL) this.sinkT = 0;
  }

  /** Exact body-part hit test against this zombie's limb meshes. */
  raycastRegion(ray) {
    this.raycaster.set(ray.ray.origin, ray.ray.direction);
    this.raycaster.near = 0;
    this.raycaster.far = 400;
    const hits = this.raycaster.intersectObjects(this.hitMeshes, false);
    if (!hits.length) return null;
    const h = hits[0];
    return {
      region: h.object.userData.region ?? 'chest',
      point: h.point,
      distance: h.distance,
      mesh: h.object,
    };
  }
}
