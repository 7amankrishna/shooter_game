/**
 * Weapon — the complete AK-01 system: magazine state, firing cadence, bloom,
 * recoil, ADS blending, reload timeline and first-person animation.
 *
 * The class owns *gun logic*; the hitscan resolution lives in
 * `game/HitDetection.js`, so the weapon only ever reports "a shot left the
 * muzzle along this vector".
 */
import * as THREE from 'three';
import { PLAYER } from '../config/GameConfig.js';
import { createRifle, createSidearm, createMarksman, createArms, createMuzzleFlash } from './RifleModel.js';
import { DEG, clamp, damp, lerp, rand, fbm } from '../core/math.js';
import { getTexture } from '../core/Textures.js';

const ADS_BLEND = 15; // spring rate for hip -> sights

export class Weapon {
  /**
   * @param {object} def  one of GameConfig.WEAPONS.* — the weapon IS its data:
   *                      magazine, cadence, spread, recoil, reload timeline.
   */
  constructor({ def, audio, fx, materials, kick }) {
    this.def = def;
    this.audio = audio;
    this.fx = fx;
    this.kick = kick; // callback: kick(pitchDeg, yawDeg, rollDeg)
    this.state = {
      mag: def.magSize,
      reserve: def.reserveStart,
      reloading: false,
      reloadT: 0,
      reloadDuration: def.reloadTime,
      cooldown: 0,
      bloom: 0,
      adsT: 0,
      adsHeld: false,
      sprinting: false,
      lastShotTime: -10,
      shotsSinceHit: 0,
      jam: 0,
    };
    this.stats = { fired: 0 };
    this.group = new THREE.Group();
    this.#build(materials);
  }

  #build(materials) {
    const gunMat = new THREE.MeshStandardMaterial({ color: 0x2f3237, roughness: 0.5, metalness: 0.8 });
    const furniture = new THREE.MeshStandardMaterial({ color: 0x50402f, roughness: 0.72, metalness: 0.1 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1c1f23, roughness: 0.4, metalness: 0.9 });
    const modelArgs = { viewmodel: true, body: gunMat, grip: furniture, metal: dark };
    this.rifle =
      this.def.model === 'sidearm' ? createSidearm(modelArgs) :
      this.def.model === 'marksman' ? createMarksman(modelArgs) :
      createRifle(modelArgs);
    this.arms = createArms();
    this.viewRoot = new THREE.Group();
    this.viewRoot.add(this.rifle);
    this.viewRoot.add(this.arms);
    this.group.add(this.viewRoot);

    this.muzzle = this.rifle.userData.muzzle;
    this.flash = createMuzzleFlash({ map: typeof document !== 'undefined' ? getTexture('dot') : null });
    this.muzzle.add(this.flash);
    this.mag = this.rifle.userData.mag;
    this.bolt = this.rifle.userData.bolt;
    this.dot = this.rifle.userData.dot;

    // pose anchors come from the model factory (sight line differs per weapon)
    const p = this.rifle.userData.poses;
    this.hipPos = new THREE.Vector3(...p.hipPos);
    this.hipRot = new THREE.Euler(...p.hipRot);
    this.adsPos = new THREE.Vector3(...p.adsPos);
    this.adsRot = new THREE.Euler(...p.adsRot);
    this.sprintPos = new THREE.Vector3(...p.sprintPos);
    this.sprintRot = new THREE.Euler(...p.sprintRot);

    this.basePos = this.hipPos.clone();
    this.baseRot = this.hipRot.clone();
    this.anim = { recoilPos: new THREE.Vector3(), recoilRot: new THREE.Vector3(), shake: 0, boltT: 0, magDrop: 0, dip: 0 };
  }

  reset() {
    Object.assign(this.state, {
      mag: this.def.magSize,
      reserve: this.def.reserveStart,
      reloading: false,
      reloadT: 0,
      cooldown: 0,
      bloom: 0,
      adsT: 0,
      sprinting: false,
    });
    this.stats.fired = 0;
    this.anim.recoilPos.set(0, 0, 0);
    this.anim.recoilRot.set(0, 0, 0);
  }

  get ammoLabel() {
    const s = this.state;
    if (s.mag > 0) return `${s.mag} / ${s.reserve}`;
    return s.reserve > 0 ? 'RELOAD' : 'NO AMMO';
  }

  /** HUD hint: the magazine is dry and the trigger was pulled. */
  get needsReload() {
    return this.state.mag === 0;
  }

  get canFire() {
    const s = this.state;
    return !s.reloading && s.cooldown <= 0 && s.mag > 0 && s.jam <= 0;
  }

  get isEmpty() {
    return this.state.mag === 0;
  }

  get spreadDeg() {
    const s = this.state;
    const base = lerp(this.def.hipSpread, this.def.adsSpread, s.adsT);
    return base + s.bloom * (1 - s.adsT * 0.62);
  }

  /**
   * Trigger handling. Returns:
   *   null            → nothing (cooldown / reloading)
   *   { empty: true }  → click, caller should prompt for reload
   *   { origin, dir }  → a shot to resolve
   */
  tryFire(now, camera, moveFactor = 0) {
    const s = this.state;
    if (s.reloading || s.cooldown > 0) return null;
    const interval = 60 / this.def.rpm;
    if (s.mag <= 0) {
      s.cooldown = this.def.emptyClickDelay;
      this.audio.play('dryFire', { gain: 0.9 });
      return { empty: true };
    }
    s.mag--;
    s.cooldown = interval;
    s.firedAt = now;
    this.stats.fired++;
    // recoil + bloom: ADS tightens the group, sprinting ruins it
    const adsK = 1 - s.adsT * 0.55;
    const shotsInBurst = clamp(this._burst ?? (this._burst = 0), 0, 12);
    this._burst = shotsInBurst + 1;
    const bloomAdd = this.def.spreadBloomPerShot * (1 + shotsInBurst * 0.12) * adsK;
    s.bloom = Math.min(6.5, s.bloom + bloomAdd);
    const up = (this.def.recoilKickUp + rand(Math.random, -0.12, 0.16)) * adsK * (1 + moveFactor * 0.25);
    const side = rand(Math.random, -1, 1) * this.def.recoilKickSide * adsK;
    if (this.kick) this.kick(up, side, rand(Math.random, -0.25, 0.25) * adsK);
    this.anim.recoilPos.z += 0.055 + s.adsT * -0.01;
    this.anim.recoilPos.y += 0.012;
    this.anim.recoilRot.x -= (0.1 + shotsInBurst * 0.004) * adsK;
    this.anim.recoilRot.z += rand(Math.random, -0.03, 0.03);
    this.anim.boltT = 1;
    this.flashT = 0.045;
    this.flashRoll = rand(Math.random, 0, Math.PI * 2);

    // The viewmodel rig lives in its own scene (rendered after a depth clear so
    // it can never clip a wall), which means the muzzle transform is a
    // *camera-space* offset. Convert it through the eye camera to get the world
    // point that the flash, tracer and shells should start from.
    camera.updateWorldMatrix(true, false);
    const origin = this.muzzle.getWorldPosition(new THREE.Vector3()).applyMatrix4(camera.matrixWorld);
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    // right/up basis for spread
    const right = new THREE.Vector3().crossVectors(dir, camera.up).normalize();
    const upv = new THREE.Vector3().crossVectors(right, dir).normalize();
    const spread = this.spreadDeg * DEG;
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * spread;
    dir.addScaledVector(right, Math.cos(a) * r).addScaledVector(upv, Math.sin(a) * r).normalize();

    this.audio.play(this.def.sound, { gain: 1, pitch: 0.97 + Math.random() * 0.06 });
    this.fx.muzzleFlash(origin, dir);
    this.fx.eject(origin.clone().addScaledVector(right, -0.12).addScaledVector(upv, -0.05), dir, right);
    this.audio.play('shell', { gain: 0.5, when: 0.05 });
    this.fx.tracer(origin, origin.clone().addScaledVector(dir, 120), { color: [1, 0.82, 0.45] });

    if (s.mag === 0) {
      this.audio.play('bolt', { gain: 0.7, when: 0.08 });
      this.holdOpen = true;
    }
    return { origin, dir };
  }

  onShotResolved(hit) {
    this._burst = hit ? 0 : this._burst;
  }

  startReload(force = false) {
    const s = this.state;
    if (s.reloading) return false;
    if (!force && s.mag === this.def.magSize) return false;
    if (s.reserve <= 0 && !force) return false;
    if (s.reserve <= 0) return false;
    s.reloading = true;
    s.reloadT = 0;
    s.tactical = s.mag > 0 && !force;
    s.reloadDuration = s.tactical ? this.def.tacticalReloadTime : this.def.reloadTime;
    this.audio.play('magOut', { gain: 0.9 });
    this.audio.play('bolt', { gain: 0.6, when: s.tactical ? 0.1 : 0.02 });
    this._magInDone = false;
    return true;
  }

  #finishReload() {
    const s = this.state;
    const need = this.def.magSize - s.mag;
    const take = Math.min(need, s.reserve);
    s.mag += take;
    s.reserve -= take;
    s.reloading = false;
    s.bloom *= 0.3;
    this.holdOpen = false;
    this._burst = 0;
    if (!this._magInDone) this.audio.play('magIn', { gain: 0.9 });
    this.audio.play('bolt', { gain: 0.95, when: 0.2 });
  }

  /**
   * @param dt
   * @param state {moving, sprinting, grounded, adsWanted, moveSpeed, lookVel, pitch}
   */
  update(dt, state) {
    const s = this.state;
    s.cooldown = Math.max(0, s.cooldown - dt);
    if (s.cooldown <= 0) this._burst = 0;
    s.bloom = Math.max(0, s.bloom - this.def.spreadRecoveryPerSecond * dt);
    s.adsT = damp(s.adsT, state.adsWanted && !s.sprinting && !s.reloading ? 1 : 0, ADS_BLEND, dt);
    s.sprinting = state.sprinting;

    if (s.reloading) {
      s.reloadT += dt;
      const t = s.reloadT / s.reloadDuration;
      if (t >= 1) this.#finishReload();
      if (!this._magInDone && t > 0.62) {
        this._magInDone = true;
        this.audio.play('magIn', { gain: 0.32, pitch: 0.94 });
      }
    } else {
      this._magInDone = false;
    }

    // ---- procedural sway + bob (scaled down hard by ADS so aiming stays crisp)
    const swayAmt = (1 - s.adsT * 0.72) * (s.sprinting ? 1.5 : 1);
    this.time = (this.time ?? 0) + dt;
    const tt = this.time;
    const swayX = fbm(tt * 0.6, 3.1, 2) * 0.014 * swayAmt;
    const swayY = fbm(tt * 0.55, 9.4, 2) * 0.011 * swayAmt;
    const bobT = state.moving ? tt * PLAYER.bobFrequency * (s.sprinting ? 1.25 : 1) : 0;
    const bobAmp = (state.moving ? PLAYER.bobAmount : 0) * (s.sprinting ? 1.7 : 1) * (1 - s.adsT * 0.7);
    const bobX = Math.sin(bobT) * bobAmp * 0.5;
    const bobY = Math.abs(Math.cos(bobT)) * bobAmp * 0.42;

    // ---- recoil spring back to rest
    const a = this.anim;
    a.recoilPos.multiplyScalar(Math.exp(-14 * dt));
    a.recoilRot.multiplyScalar(Math.exp(-11 * dt));
    a.shake = damp(a.shake, 0, 8, dt);
    a.boltT = Math.max(0, a.boltT - dt * 16);
    a.dip = damp(a.dip, state.grounded ? 0 : 0.06, 7, dt);
    if (this.flashT > 0) this.flashT -= dt;

    // ---- reload pose timeline (mag drops out, gun tilts down, roll back up)
    const rl = s.reloading ? Math.sin(clamp(s.reloadT / s.reloadDuration, 0, 1) * Math.PI) : 0;
    const magDrop = s.reloading ? clamp((s.reloadT / s.reloadDuration) * 3, 0, 1) * (1 - clamp((s.reloadT / s.reloadDuration - 0.55) * 3.2, 0, 1)) : 0;
    this.mag.position.y = -0.05 - magDrop * 0.16;
    this.mag.position.z = -0.04 + magDrop * 0.02;
    this.mag.rotation.x = -0.16 * magDrop + (s.reloading ? 0.1 * rl : 0);
    this.mag.visible = magDrop < 0.995;
    this.bolt.position.z = a.boltT * 0.05;
    if (this.holdOpen && !s.reloading) this.bolt.position.z = 0.045;

    // ---- blend hip / ADS / sprint
    const adsT = s.adsT;
    const sprintT = s.sprinting ? 1 : 0;
    this.sprintT = damp(this.sprintT ?? 0, sprintT, 9, dt);
    const pos = new THREE.Vector3().lerpVectors(this.hipPos, this.adsPos, adsT);
    if (this.sprintT > 0.001) pos.lerp(this.sprintPos, this.sprintT);
    pos.x += swayX + bobX;
    pos.y += swayY + bobY - a.dip;
    pos.add(a.recoilPos);
    pos.y -= rl * 0.14;
    this.viewRoot.position.copy(pos);

    const rot = new THREE.Euler(
      lerp(this.hipRot.x, this.adsRot.x, adsT) + a.recoilRot.x + rl * 0.5 - bobY * 0.6 + state.pitch * 0.02,
      lerp(this.hipRot.y, this.adsRot.y, adsT) + swayX * 2.2,
      lerp(this.hipRot.z, this.adsRot.z, adsT) + a.recoilRot.z + rl * 0.35,
    );
    if (this.sprintT > 0.001) {
      rot.x = lerp(rot.x, this.sprintRot.x, this.sprintT);
      rot.y = lerp(rot.y, this.sprintRot.y, this.sprintT);
      rot.z = lerp(rot.z, this.sprintRot.z, this.sprintT);
    }
    this.viewRoot.rotation.copy(rot);

    // optic visibility: hide until the cheek is on the stock
    if (this.dot) {
      this.dot.visible = adsT > 0.55;
      if (this.rifle.userData.emitter) this.rifle.userData.emitter.material.color.setRGB(1, 0.28 + 0.1 * Math.sin(tt * 6), 0.28);
    }

    // muzzle flash decay
    const fl = Math.max(0, this.flashT / 0.045);
    this.flash.visible = fl > 0.01;
    if (this.flash.visible) {
      const sc = 0.24 + fl * 0.34;
      this.flash.userData.sprite.scale.set(sc, sc, sc);
      this.flash.userData.star.scale.set(sc * 1.9, sc * 0.5, 1);
      this.flash.userData.star.rotation.z = this.flashRoll;
      this.flash.userData.light.intensity = fl * 4.4;
      for (const m of this.flash.userData.materials) m.opacity = fl;
    }
    return { adsT, flash: fl };
  }
}
