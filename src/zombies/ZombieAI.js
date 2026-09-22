/**
 * ZombieAI — perception + state machine for one of the infected.
 *
 * States: IDLE → WANDER → INVESTIGATE (heard something) → CHASE (sees you) →
 * ATTACK → SEARCH (lost you) → back to WANDER. STAGGER is an overlay any state
 * can fall into when a hit breaks the stride.
 *
 * They do NOT magically know where you are: sight needs distance + FOV + real
 * line-of-sight and takes `acquireTime` to lock; hearing arrives as noise
 * events (gunshots, sprinting feet, screams) with position error. Night halves
 * their sight and sharpens their hearing.
 */
import * as THREE from 'three';
import { DEG, clamp, damp, angleDelta, rand } from '../core/math.js';
import { ZOMBIES } from '../config/GameConfig.js';

export const ZSTATE = {
  IDLE: 'IDLE',
  WANDER: 'WANDER',
  INVESTIGATE: 'INVESTIGATE',
  CHASE: 'CHASE',
  ATTACK: 'ATTACK',
  SEARCH: 'SEARCH',
  DEAD: 'DEAD',
};

const _eye = new THREE.Vector3();
const _target = new THREE.Vector3();

export class ZombieAI {
  constructor(zombie, { rng = Math.random } = {}) {
    this.z = zombie;
    this.rng = rng;
    this.state = ZSTATE.IDLE;
    this.reset();
  }

  reset() {
    this.state = ZSTATE.IDLE;
    this.stateTime = 0;
    this.awareness = 0;
    this.playerVisible = false;
    this.dist = Infinity;
    this.lastKnown = new THREE.Vector3();
    this.hasLastKnown = false;
    this.wanderTarget = null;
    this.investigatePoint = null;
    this.stuckT = 0;
    this.sidestepT = 0;
    this.attackCd = 0;
    this.screamed = false;
    this.towerPatience = 0;
    this.thinkT = Math.random() * 0.12; // stagger the 8 Hz think ticks
    this.moanT = rand(this.rng, 4, 14);
  }

  transition(next) {
    if (this.state === next) return;
    this.state = next;
    this.stateTime = 0;
  }

  /** A noise reached this zombie (hearing already range-checked by the manager). */
  hear(point, strength) {
    if (!this.z.alive) return;
    // position error grows with distance — they shamble toward the *sound*
    this.investigatePoint = this.investigatePoint ?? new THREE.Vector3();
    this.investigatePoint.copy(point);
    const spread = clamp(this.dist * 0.12, 0, 10) * (1 - strength * 0.5);
    this.investigatePoint.x += rand(this.rng, -spread, spread);
    this.investigatePoint.z += rand(this.rng, -spread, spread);
    this.awareness = Math.max(this.awareness, 0.3 + strength * 0.4);
    if (this.state === ZSTATE.IDLE || this.state === ZSTATE.WANDER || this.state === ZSTATE.SEARCH) {
      this.transition(ZSTATE.INVESTIGATE);
    }
  }

  /** Called once when awareness locks — the screamer's whole identity. */
  onAcquired(ctx) {
    if (this.z.typeKey === 'screamer' && !this.screamed) {
      this.screamed = true;
      this.z.startScream();
      ctx.manager.screamAlert(this.z.pos, this.z.type);
    }
  }

  perceive(ctx) {
    const z = this.z;
    const player = ctx.player;
    const toX = player.position.x - z.pos.x;
    const toZ = player.position.z - z.pos.z;
    this.dist = Math.hypot(toX, toZ);
    const night = ctx.night ? ZOMBIES.nightViewMul : 1;
    const range = z.type.viewRange * night * (player.crouching ? 0.8 : 1) * (ctx.weatherFog ?? 1);
    let visible = false;
    if (this.dist < range && !player.inTower) {
      // wide FOV; inside 4 m they sense you regardless (breathing, movement)
      const needFov = this.dist > 4;
      if (!needFov) visible = true;
      else {
        const fwdX = Math.sin(z.yaw);
        const fwdZ = Math.cos(z.yaw);
        const facing = (fwdX * toX + fwdZ * toZ) / (this.dist || 1);
        if (facing > Math.cos((z.type.fovDeg / 2) * DEG)) {
          _eye.set(z.pos.x, z.pos.y + (z.crawler ? 0.5 : 1.5), z.pos.z);
          _target.set(player.position.x, player.position.y + 1.1, player.position.z);
          visible = ctx.col.hasLineOfSight(_eye, _target);
        }
      }
    }
    this.playerVisible = visible;
    if (visible) {
      const fast = clamp(this.dist < 12 ? 2.2 : 1, 1, 2.2);
      this.awareness = Math.min(1.35, this.awareness + (ctx.dt * fast) / Math.max(0.05, z.type.acquireTime));
      this.lastKnown.set(player.position.x, player.position.y, player.position.z);
      this.hasLastKnown = true;
    } else {
      this.awareness = Math.max(0, this.awareness - ctx.dt / 3.2);
    }
  }

  think(ctx) {
    const z = this.z;
    const player = ctx.player;
    const inRange = this.dist < z.type.attackRange + 0.4;

    // ---- universal transitions
    if (this.awareness >= 1 && this.state !== ZSTATE.CHASE && this.state !== ZSTATE.ATTACK) {
      this.transition(ZSTATE.CHASE);
      this.onAcquired(ctx);
      return;
    }
    if (this.state === ZSTATE.CHASE || this.state === ZSTATE.ATTACK) {
      if (player.inTower) {
        // the prey is up a tower: mill at the base, lose interest eventually
        this.towerPatience += 0.12;
        if (inRange || this.dist < 6) {
          this.transition(ZSTATE.ATTACK); // clawing at the legs (harmless up top)
          return;
        }
        if (this.towerPatience > 26) {
          this.awareness = 0;
          this.towerPatience = 0;
          this.transition(ZSTATE.WANDER);
          return;
        }
      } else if (inRange && this.playerVisible) {
        this.transition(ZSTATE.ATTACK);
        return;
      } else if (this.dist > z.type.attackRange + 1.5) {
        this.transition(ZSTATE.CHASE);
      }
      if (!this.playerVisible && this.awareness < 0.4) {
        this.transition(ZSTATE.SEARCH);
        return;
      }
      return;
    }
    if (this.state === ZSTATE.ATTACK) {
      if (!inRange && this.dist > z.type.attackRange + 0.8) this.transition(ZSTATE.CHASE);
      return;
    }
    if (this.state === ZSTATE.INVESTIGATE) {
      const p = this.investigatePoint;
      if (!p || Math.hypot(p.x - z.pos.x, p.z - z.pos.z) < 2.2 || this.stateTime > 26) {
        this.transition(ZSTATE.SEARCH);
      }
      return;
    }
    if (this.state === ZSTATE.SEARCH) {
      if (this.stateTime > 10) this.transition(ZSTATE.WANDER);
      return;
    }
    if (this.state === ZSTATE.WANDER) {
      if (this.stateTime > 14 || !this.wanderTarget) this.#pickWander(ctx);
      return;
    }
    if (this.state === ZSTATE.IDLE && this.stateTime > rand(this.rng, 2, 6)) {
      this.transition(ZSTATE.WANDER);
      this.#pickWander(ctx);
    }
  }

  #pickWander(ctx) {
    const z = this.z;
    const a = this.rng() * Math.PI * 2;
    const r = rand(this.rng, 6, 26);
    const x = z.pos.x + Math.cos(a) * r;
    const zz = z.pos.z + Math.sin(a) * r;
    const ground = ctx.world.ground(x, zz);
    this.wanderTarget = { x, z: zz, y: ground };
  }

  /** Desired movement direction for the current state (unit-ish vector). */
  steer(ctx) {
    const z = this.z;
    const player = ctx.player;
    let tx = null;
    let tz = null;
    let speed = 0;
    switch (this.state) {
      case ZSTATE.WANDER:
        if (this.wanderTarget) {
          tx = this.wanderTarget.x;
          tz = this.wanderTarget.z;
          speed = z.type.speed * 0.45;
          if (Math.hypot(tx - z.pos.x, tz - z.pos.z) < 1.5) this.wanderTarget = null;
        }
        break;
      case ZSTATE.INVESTIGATE:
        if (this.investigatePoint) {
          tx = this.investigatePoint.x;
          tz = this.investigatePoint.z;
          speed = z.type.speed * 0.8;
          if (Math.hypot(tx - z.pos.x, tz - z.pos.z) < 2) this.investigatePoint = null;
        }
        break;
      case ZSTATE.CHASE: {
        // aim at the player (or last known), with a personal lateral offset so
        // a pack fans out instead of queueing on the same line
        const px = this.playerVisible || !this.hasLastKnown ? player.position.x : this.lastKnown.x;
        const pz = this.playerVisible || !this.hasLastKnown ? player.position.z : this.lastKnown.z;
        if (player.inTower && ctx.tower) {
          tx = ctx.tower.ladder.x;
          tz = ctx.tower.ladder.z;
        } else {
          const dx = px - z.pos.x;
          const dz = pz - z.pos.z;
          const d = Math.hypot(dx, dz) || 1;
          tx = px + (-dz / d) * z.personality.lateral;
          tz = pz + (dx / d) * z.personality.lateral;
        }
        speed = (this.dist > 14 ? z.type.sprintSpeed : z.type.speed) * z.personality.speedMul;
        break;
      }
      case ZSTATE.ATTACK:
        speed = 0;
        break;
      case ZSTATE.SEARCH:
        if (this.hasLastKnown) {
          tx = this.lastKnown.x;
          tz = this.lastKnown.z;
          speed = z.type.speed * 0.6;
          if (Math.hypot(tx - z.pos.x, tz - z.pos.z) < 2) this.hasLastKnown = false;
        }
        break;
      default:
        speed = 0;
    }
    if (tx === null || speed <= 0) return null;
    const dx = tx - z.pos.x;
    const dz = tz - z.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) return null;
    return { x: dx / d, z: dz / d, speed };
  }

  update(dt, ctx) {
    const z = this.z;
    if (!z.alive) {
      this.state = ZSTATE.DEAD;
      return;
    }
    this.stateTime += dt;
    this.attackCd = Math.max(0, this.attackCd - dt);
    this.perceive(ctx);

    // staggered decisions (~8 Hz) — a zombie does not need 60 thoughts a second
    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT = 0.12;
      this.think({ ...ctx, dt: 0.12 });
    }

    // ---- attack resolution
    if (this.state === ZSTATE.ATTACK) {
      const player = ctx.player;
      // face the player
      const wantYaw = Math.atan2(player.position.x - z.pos.x, player.position.z - z.pos.z);
      z.yaw += angleDelta(wantYaw, z.yaw) * (1 - Math.exp(-8 * dt));
      if (z.attackT < 0 && this.attackCd <= 0 && this.dist < z.type.attackRange + 0.5) {
        z.startAttack();
        this.attackCd = z.type.attackWindup + 0.35 + z.type.attackCooldown;
        ctx.manager.zombieAttackStarted(z);
      }
      // the strike lands at windup end
      if (z.attackT >= z.type.attackWindup && !this._struck) {
        this._struck = true;
        const inArc = this.dist < z.type.attackRange + 0.5 &&
          Math.abs(angleDelta(Math.atan2(player.position.x - z.pos.x, player.position.z - z.pos.z), z.yaw)) < 0.9;
        if (inArc && !player.inTower) ctx.manager.zombieStrike(z);
      }
      if (z.attackT < 0) this._struck = false;
      if (this.dist > z.type.attackRange + 1.2 && z.attackT < 0) this.transition(ZSTATE.CHASE);
    } else {
      this._struck = false;
    }

    // ---- stagger overrides movement
    if (z.staggerT > 0) {
      z.vel.x = damp(z.vel.x, 0, 6, dt);
      z.vel.z = damp(z.vel.z, 0, 6, dt);
      return;
    }

    // ---- steering
    const want = this.steer(ctx);
    if (want) {
      // sidestep while stuck: pick a perpendicular escape for a moment
      if (this.sidestepT > 0) {
        this.sidestepT -= dt;
        const px = -want.z;
        const pz = want.x;
        z.vel.x = damp(z.vel.x, px * want.speed, 8, dt);
        z.vel.z = damp(z.vel.z, pz * want.speed, 8, dt);
      } else {
        z.vel.x = damp(z.vel.x, want.x * want.speed, 7, dt);
        z.vel.z = damp(z.vel.z, want.z * want.speed, 7, dt);
      }
      const wantYaw = Math.atan2(z.vel.x, z.vel.z);
      if (Math.hypot(z.vel.x, z.vel.z) > 0.25) {
        z.yaw += angleDelta(wantYaw, z.yaw) * (1 - Math.exp(-6 * dt));
      }
    } else {
      z.vel.x = damp(z.vel.x, 0, 8, dt);
      z.vel.z = damp(z.vel.z, 0, 8, dt);
    }
  }
}
