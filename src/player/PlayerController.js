/**
 * PlayerController — first-person movement, look, camera feel.
 *
 * Movement is an acceleration/friction model (not a direct velocity set), which
 * is what makes the start/stop feel weighty but still snappy. The camera is
 * driven by three additive layers so recoil, bob and shake never fight each
 * other:
 *   base pose (yaw/pitch from the mouse)
 *   + recoil (springs back, with a small permanent climb you must fight)
 *   + shake/bob/dip (decaying, ADS-damped)
 */
import * as THREE from 'three';
import { PLAYER, WEAPON, WORLD } from '../config/GameConfig.js';
import { DEG, clamp, damp, lerp, smoothstep } from '../core/math.js';

export class PlayerController {
  constructor({ camera, env, audio, fx }) {
    this.camera = camera;
    this.env = env;
    this.audio = audio;
    this.fx = fx;
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.prevPos = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this.health = PLAYER.health;
    this.maxHealth = PLAYER.health;
    this.alive = true;
    this.crouching = false;
    this.grounded = true;
    this.groundY = 0;
    this.stride = 0;
    this.bobPhase = 0;
    this.recoil = { pitch: 0, yaw: 0, roll: 0 };
    this.recoilPermanent = { pitch: 0 };
    this.shake = 0;
    this.shakeDir = new THREE.Vector2(1, 0);
    this.landingDip = 0;
    this.damageCooldown = 0;
    this.moveSpeed = 0;
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._tmp = new THREE.Vector3();
    this.lastDamageFrom = new THREE.Vector3();
  }

  reset(spawn) {
    // a spawn may legitimately omit y (the terrain decides), but never NaN
    const y = Number.isFinite(spawn.y) ? spawn.y : (this.env ? this.env.ground(spawn.x, spawn.z) : 0);
    this.position.set(spawn.x, y, spawn.z);
    this.lastSpawn = { x: spawn.x, y, z: spawn.z, yaw: spawn.yaw ?? 0 };
    this.prevPos.copy(this.position);
    this.velocity.set(0, 0, 0);
    this.yaw = spawn.yaw ?? 0;
    this.pitch = 0;
    this.roll = 0;
    this.health = PLAYER.health;
    this.alive = true;
    this.crouching = false;
    this.recoil.pitch = this.recoil.yaw = this.recoil.roll = 0;
    this.shake = 0;
    this.landingDip = 0;
  }

  get eyeHeight() {
    return this.crouching ? PLAYER.crouchEyeHeight : PLAYER.eyeHeight;
  }

  get aliveFlag() {
    return this.alive;
  }

  look(dx, dy, adsT, sprinting) {
    const sensScale = lerp(PLAYER.hipSensitivity, PLAYER.adsSensitivity, adsT) * (sprinting ? PLAYER.sprintSensitivity : 1);
    const s = 0.0022 * sensScale;
    this.yaw -= dx * s;
    this.pitch -= dy * s;
    const limit = Math.PI / 2 - 0.02;
    this.pitch = clamp(this.pitch, -limit, limit);
  }

  applyRecoil(pitchDeg, yawDeg, rollDeg = 0) {
    this.recoil.pitch += pitchDeg * DEG * 0.62;
    this.recoil.yaw += yawDeg * DEG * 0.62;
    this.recoil.roll += rollDeg * DEG * 0.4;
    // a fraction of the climb sticks, so full-auto has to be pulled down
    this.pitch = clamp(this.pitch + pitchDeg * DEG * 0.3, -(Math.PI / 2 - 0.02), Math.PI / 2 - 0.02);
    this.shake = Math.min(0.5, this.shake + 0.1);
  }

  addShake(amount) {
    this.shake = Math.min(1.1, this.shake + amount);
  }

  /** @returns {number} remaining health */
  takeDamage(amount, fromPoint) {
    if (!this.alive) return this.health;
    this.health = Math.max(0, this.health - amount);
    this.damageCooldown = 0.4;
    this.addShake(0.22 + clamp(amount / 60, 0, 0.35));
    if (fromPoint) this.lastDamageFrom.set(fromPoint.x, fromPoint.y, fromPoint.z);
    if (this.health <= 0) this.alive = false;
    return this.health;
  }

  heal(amount) {
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  update(dt, input) {
    // One NaN would otherwise propagate through every later transform, so a
    // broken position snaps back to the nearest safe standable spot.
    if (!Number.isFinite(this.position.x + this.position.y + this.position.z)) {
      this.reset(this.lastSpawn ?? { x: 0, y: 0, z: 0 });
      return;
    }
    const adsT = input.adsT ?? 0;
    const sprinting = !!input.sprinting && !this.crouching && adsT < 0.25 && input.moveLen > 0.2;
    const crouch = !!input.crouch;
    this.crouching = crouch;

    // ---- desired movement in yaw space
    let fx = 0;
    let fz = 0;
    if (input.forward) fz += 1;
    if (input.back) fz -= 1;
    if (input.left) fx -= 1;
    if (input.right) fx += 1;
    const len = Math.hypot(fx, fz);
    if (len > 0) {
      fx /= len;
      fz /= len;
    }
    const sinY = Math.sin(this.yaw);
    const cosY = Math.cos(this.yaw);
    const wishX = fx * cosY + fz * sinY;
    const wishZ = -fx * sinY + fz * cosY;

    let maxSpeed = PLAYER.maxSpeed;
    if (sprinting) maxSpeed = PLAYER.sprintSpeed;
    else if (adsT > 0.5) maxSpeed = PLAYER.adsSpeed;
    if (this.crouching) maxSpeed = Math.min(maxSpeed, PLAYER.crouchSpeed);
    if (!this.grounded) maxSpeed *= 1.02;

    const accel = this.grounded ? PLAYER.accelGround : PLAYER.accelAir;
    const targetX = wishX * maxSpeed;
    const targetZ = wishZ * maxSpeed;
    if (len > 0.01) {
      this.velocity.x = this.velocity.x + (targetX - this.velocity.x) * clamp(accel * dt / maxSpeed, 0, 1);
      this.velocity.z = this.velocity.z + (targetZ - this.velocity.z) * clamp(accel * dt / maxSpeed, 0, 1);
    } else if (this.grounded) {
      const k = Math.exp(-PLAYER.brakeGround * dt * 1.6);
      this.velocity.x *= k;
      this.velocity.z *= k;
    } else {
      this.velocity.x *= 0.995;
      this.velocity.z *= 0.995;
    }
    // hard clamp keeps sprint + slope abuse out of the physics
    const planar = Math.hypot(this.velocity.x, this.velocity.z);
    const cap = maxSpeed * 1.35;
    if (planar > cap) {
      this.velocity.x *= cap / planar;
      this.velocity.z *= cap / planar;
    }

    // ---- jump / gravity
    if (input.jump && this.grounded && !this.crouching) {
      this.velocity.y = PLAYER.jumpVelocity;
      this.grounded = false;
      this.audio?.play('step', { gain: 0.35, pitch: 1.35 });
    }
    this.velocity.y += WORLD.gravity * dt;
    if (this.velocity.y < -55) this.velocity.y = -55;

    // ---- collide + resolve
    const height = this.crouching ? PLAYER.crouchHeight : PLAYER.height;
    this.prevPos.copy(this.position);
    const move = this.env.world.moveBody(this.position, this.velocity, dt, {
      radius: PLAYER.radius,
      height,
      stepHeight: PLAYER.stepHeight,
    });
    if (move.grounded) {
      if (!this.grounded) {
        const fall = Math.abs(this.velocity.y);
        this.landingDip = clamp(fall * 0.02, 0.02, PLAYER.landingDip);
        this.addShake(clamp(fall * 0.012, 0, 0.18));
        if (fall > 3) {
          this.audio?.play('land', { gain: clamp(fall / 16, 0.2, 1) });
          this.fx?.footstep(this.position, { dust: fall > 7 });
        }
      }
      this.grounded = true;
      this.velocity.y = 0;
    } else {
      this.grounded = false;
    }
    if (move.hitCeiling) this.velocity.y = Math.min(0, this.velocity.y);

    this.moveSpeed = Math.hypot(this.position.x - this.prevPos.x, this.position.z - this.prevPos.z) / Math.max(dt, 1e-4);
    this.moved = Math.hypot(this.position.x - this.prevPos.x, this.position.z - this.prevPos.z);

    // ---- footsteps (sound + dust); rate follows actual ground speed
    if (this.grounded && this.moveSpeed > 0.7) {
      this.stride += dt * (this.moveSpeed * (sprinting ? 1.05 : 1.28));
      const phase = Math.floor(this.stride / 1.35);
      if (phase !== this._stepPhase) {
        this._stepPhase = phase;
        const surf = this.surfaceUnder();
        this.audio?.play('step', { gain: sprinting ? 0.62 : 0.4, pitch: (surf === 'metal' ? 1.25 : 1) * (0.94 + Math.random() * 0.12) });
        if (Math.random() < 0.55) this.fx?.footstep(this.position, { dust: surf !== 'metal' });
        input.onStep?.(this.position, sprinting ? 1 : 0.45);
      }
    }

    // ---- recoil spring, shake decay
    this.recoil.pitch = damp(this.recoil.pitch, 0, WEAPON.recoilRecovery, dt);
    this.recoil.yaw = damp(this.recoil.yaw, 0, WEAPON.recoilRecovery * 0.85, dt);
    this.recoil.roll = damp(this.recoil.roll, 0, 9, dt);
    this.shake = damp(this.shake, 0, 5.2, dt);
    this.landingDip = damp(this.landingDip, 0, 7, dt);
    this.damageCooldown = Math.max(0, this.damageCooldown - dt);

    // ---- camera pose
    this.bobPhase += dt * (this.moveSpeed / Math.max(0.001, maxSpeed)) * PLAYER.bobFrequency * (sprinting ? 1.2 : 1);
    const bobK = clamp(this.moveSpeed / PLAYER.maxSpeed, 0, 1.6) * (1 - adsT * 0.78) * (this.grounded ? 1 : 0.2);
    const bobY = Math.sin(this.bobPhase * 2) * PLAYER.bobAmount * bobK;
    const bobX = Math.cos(this.bobPhase) * PLAYER.bobAmount * 0.55 * bobK;
    const strafeLean = clamp((this.velocity.x * cosY + this.velocity.z * sinY) / PLAYER.maxSpeed, -1, 1);
    this.roll = damp(this.roll, -strafeLean * 0.022 * (1 - adsT), 6, dt);

    const shakeAmp = this.shake;
    if (shakeAmp > 0.001) {
      this._shakeSeed = (this._shakeSeed ?? 0) + dt * 34;
      this.shakeDir.set(Math.sin(this._shakeSeed * 1.7), Math.cos(this._shakeSeed * 2.3));
    }
    const camPitch = this.pitch + this.recoil.pitch + this.shakeDir.y * shakeAmp * 0.03;
    const camYaw = this.yaw + this.recoil.yaw + this.shakeDir.x * shakeAmp * 0.028;

    this._euler.set(camPitch, camYaw, this.roll + this.recoil.roll + this.shakeDir.x * shakeAmp * 0.02, 'YXZ');
    this.camera.quaternion.setFromEuler(this._euler);
    this.camera.position.set(
      this.position.x + bobX * 0.35,
      this.position.y + this.eyeHeight + bobY - this.landingDip,
      this.position.z + bobY * 0.2,
    );

    // ---- fov: base → ADS/scope zoom, plus a sprint kick
    const targetFov = lerp(PLAYER.baseFov, PLAYER.adsFov, clamp(adsT, 0, 1));
    this.fovTarget = lerp(targetFov, targetFov + PLAYER.sprintFovBoost, sprinting ? 1 : 0);
    this.camera.fov = damp(this.camera.fov, this.fovTarget, 11, dt);
    this.camera.updateProjectionMatrix();

    return {
      adsT,
      sprinting,
      moveSpeed: this.moveSpeed,
      grounded: this.grounded,
      pitch: this.pitch,
    };
  }

  surfaceUnder() {
    const b = this.env.world.queryXZ(this.position.x - 0.2, this.position.x + 0.2, this.position.z - 0.2, this.position.z + 0.2,
      (box) => box.max.y <= this.position.y + 0.2 && box.max.y >= this.position.y - 0.4);
    return b.length ? b[0].surface : 'ground';
  }

  get forwardVec() {
    this.camera.getWorldDirection(this._tmp);
    return this._tmp;
  }

  /** 0..1 used by the audio listener + AI "you are exposed" logic. */
  get exposure() {
    return smoothstep(0, 1, clamp(this.moveSpeed / PLAYER.sprintSpeed, 0, 1));
  }
}

