/**
 * ZombieManager — owns the pool, the spawn director and the horde's ears.
 *
 * Spawning is diegetic: the population target comes from the difficulty curve
 * (distance travelled, time survived, kills, region, time-of-day) and zombies
 * physically walk in from OUTSIDE view — never inside the player, a tower
 * exclusion zone, a collider, or the camera frustum within fog range. Kills
 * recycle bodies back to the pool after the corpse lingers.
 *
 * Noise routing: anything loud (gunshots, crates, screams) calls notifyNoise();
 * zombies within earshot get investigate intents with position error.
 */
import * as THREE from 'three';
import { ZOMBIE_TYPES, ZOMBIES, WORLD } from '../config/GameConfig.js';
import { Zombie } from './Zombie.js';
import { ZombieAI, ZSTATE } from './ZombieAI.js';
import { clamp, makeRng, rand } from '../core/math.js';

const TAU = Math.PI * 2;

const _v = new THREE.Vector3();

export class ZombieManager {
  constructor({
    world,
    fx = null,
    audio = null,
    onPlayerDamage = () => {},
    onZombieKilled = () => {},
    seed = WORLD.seed,
  } = {}) {
    this.world = world;
    this.col = world.world; // ColliderWorld (moveBody / probes / LOS)
    this.fx = fx;
    this.audio = audio;
    this.onPlayerDamage = onPlayerDamage;
    this.onZombieKilled = onZombieKilled;
    this.rng = makeRng(seed ^ 0x9e3779b9);
    this.group = new THREE.Group();
    this.group.name = 'zombies';
    this.pool = [];
    this.active = [];
    this.corpses = [];
    this.stats = { spawned: 0, killed: 0, active: 0 };
    this.difficulty = 1;
    this.spawnAccum = 0;
    this.screamCd = 0;
    this._nightEyes = false;
    this._noiseQueue = [];
    this._osRng = makeRng(seed ^ 0x1234abcd);
  }

  #acquire(typeKey) {
    for (const z of this.pool) {
      if (!z.active && z.typeKey === typeKey) {
        z.despawn();
        return z;
      }
    }
    if (this.pool.length >= ZOMBIES.maxActive) return null;
    const z = new Zombie(typeKey, { fx: this.fx, audio: this.audio });
    this.pool.push(z);
    this.group.add(z.root);
    return z;
  }

  #spawnWeights(night, difficulty) {
    const w = {};
    for (const [key, t] of Object.entries(ZOMBIE_TYPES)) {
      let weight = night ? t.weight.night : t.weight.base;
      if (t.id === 'runner') weight *= 0.9 + difficulty * 0.06;
      if (t.id === 'brute') weight *= 0.5 + Math.max(0, difficulty - 2.5) * 0.22;
      if (t.id === 'screamer') weight *= 0.7 + Math.max(0, difficulty - 3) * 0.18;
      w[key] = weight;
    }
    return w;
  }

  #pickType(night, difficulty) {
    const w = this.#spawnWeights(night, difficulty);
    let total = 0;
    for (const k in w) total += w[k];
    let r = this.rng() * total;
    for (const [k, v] of Object.entries(w)) {
      r -= v;
      if (r <= 0) return k;
    }
    return 'walker';
  }

  /**
   * Valid spawn position: outside the view cone (or beyond fog), on walkable
   * ground, clear of colliders and tower exclusion zones.
   */
  #findSpawn(player, cameraForward) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const angle = this.rng() * TAU;
      const dist = rand(this.rng, ZOMBIES.spawnNear, ZOMBIES.spawnFar);
      const x = player.position.x + Math.cos(angle) * dist;
      const z = player.position.z + Math.sin(angle) * dist;
      // not in the camera's forward cone when close (fog hides the far ones)
      if (dist < ZOMBIES.spawnFar * 0.8 && cameraForward) {
        const dx = x - player.position.x;
        const dz = z - player.position.z;
        const d = Math.hypot(dx, dz) || 1;
        const facing = (cameraForward.x * dx + cameraForward.z * dz) / d;
        if (facing > 0.45) continue; // within ~63° of view direction — reroll
      }
      const y = this.world.ground(x, z);
      if (!Number.isFinite(y)) continue;
      if (this.world.terrain.slopeAt(x, z) > 0.85) continue;
      if (!this.col.probeCylinder(x, y, z, 0.45, 1.7)) continue;
      // tower exclusion: zombies don't materialise at the safe zones
      const t = this.world.nearestTower({ x, y, z });
      if (t && t.dist < ZOMBIES.towerExclusion) continue;
      return { x, y, z };
    }
    return null;
  }

  spawnOne(player, cameraForward, opts = {}) {
    const typeKey = opts.type ?? this.#pickType(opts.night ?? false, this.difficulty);
    const z = this.#acquire(typeKey);
    if (!z) return null;
    const spot = opts.at ?? this.#findSpawn(player, cameraForward);
    if (!spot) return null;
    const hpScale = opts.hpScale ?? Math.min(ZOMBIES.hpScaleMax, 1 + (this.difficulty - 1) * ZOMBIES.hpScalePerLevel);
    z.spawnAt(spot.x, spot.y, spot.z, this.rng() * TAU, hpScale);
    if (!z.ai) z.ai = new ZombieAI(z, { rng: makeRng((this.rng() * 0xffffffff) >>> 0) });
    z.ai.reset();
    this.active.push(z);
    this.stats.spawned++;
    return z;
  }

  spawnHorde(player, cameraForward, count, opts = {}) {
    // a coherent group: one angle, spread out along the arc
    const angle = opts.angle ?? this.rng() * TAU;
    let spawned = 0;
    for (let i = 0; i < count; i++) {
      const dist = rand(this.rng, ZOMBIES.spawnNear, ZOMBIES.spawnNear + 30);
      const a = angle + rand(this.rng, -0.5, 0.5);
      const x = player.position.x + Math.cos(a) * dist;
      const z = player.position.z + Math.sin(a) * dist;
      const y = this.world.ground(x, z);
      if (!Number.isFinite(y)) continue;
      const zz = this.spawnOne(player, cameraForward, { ...opts, at: { x, y, z } });
      if (zz) spawned++;
    }
    return spawned;
  }

  notifyNoise(pos, radius, strength = 1) {
    this._noiseQueue.push({ x: pos.x, y: pos.y, z: pos.z, radius, strength });
  }

  /** Route a queued noise to one zombie's ears (its hearing sharpens range). */
  #deliverNoise(z, n) {
    const dx = z.pos.x - n.x;
    const dz = z.pos.z - n.z;
    const radius = n.radius * (z.type.hearing ?? 1);
    const d2 = dx * dx + dz * dz;
    if (d2 >= radius * radius) return;
    const dist = Math.sqrt(d2);
    const falloff = 1 - dist / radius;
    if (falloff > 0.1) z.ai.hear({ x: n.x, y: n.y, z: n.z }, falloff * n.strength);
  }

  screamAlert(pos, type) {
    this.notifyNoise(pos, ZOMBIES.noiseScream, 0.9);
    if (this.audio) this.audio.play('zombieScream', { pos, volume: 0.9 });
  }

  zombieAttackStarted(z) {
    if (this.audio && this.aiNear(z)) this.audio.play('zombieAttack', { pos: z.pos, volume: 0.75 });
  }

  zombieStrike(z) {
    // the blow lands — the host (Survival) applies screen shake/damage feedback
    const dmg = z.type.damage * rand(this.rng, 0.85, 1.15);
    this.onPlayerDamage(dmg, z.aimPoint('chest', _v), z.typeKey);
  }

  /**
   * Hit-detection entry point: route damage to a zombie's body region,
   * fire the kill reward, and report stagger for hit reactions.
   */
  damageZombie(zombie, amount, region, point, dir) {
    if (!zombie.alive) return { killed: false, staggered: false };
    const res = zombie.applyDamage(amount, region, point, dir);
    if (res.killed) {
      this.stats.killed++;
      this.onZombieKilled(zombie, {
        region,
        headshot: region === 'head',
        pos: zombie.pos,
        type: zombie.typeKey,
      });
    }
    return res;
  }

  aiNear(z) {
    return z.pos.distanceToSquared(this._lastPlayerPos ?? z.pos) < 70 * 70;
  }

  /** Difficulty 1..10: distance travelled + time survived + kills + night. */
  updateDifficulty({ distance, elapsed, kills, night }) {
    const d = 1 + distance / ZOMBIES.difficultyDistScale + elapsed / ZOMBIES.difficultyTimeScale +
      kills * ZOMBIES.difficultyKillScale;
    this.difficulty = clamp(d * (night ? 1.12 : 1), 1, 10);
    return this.difficulty;
  }

  targetPopulation(night) {
    const base = ZOMBIES.basePopulation + this.difficulty * ZOMBIES.populationPerDifficulty;
    const surge = night ? ZOMBIES.nightPopulation : 1;
    return clamp(Math.round(base * surge), ZOMBIES.minPopulation, ZOMBIES.maxActive);
  }

  aliveCount() {
    let n = 0;
    for (const z of this.active) if (z.alive) n++;
    return n;
  }

  update(dt, ctx) {
    // ctx: { player (PlayerController), night, weatherFog, cameraForward, inTower, tower }
    const player = ctx.player;
    this._lastPlayerPos = player.position;
    this.screamCd = Math.max(0, this.screamCd - dt);

    // ---- route queued noise events (gunshots etc.) to ears
    for (const n of this._noiseQueue) {
      for (const z of this.active) {
        if (z.alive) this.#deliverNoise(z, n);
      }
    }
    this._noiseQueue.length = 0;

    // ---- spawn director (keeps population at the difficulty curve)
    const alive = this.aliveCount();
    const target = this.targetPopulation(ctx.night);
    if (alive < target) {
      this.spawnAccum += dt;
      const interval = clamp(2.4 - this.difficulty * 0.16, 0.5, 2.4);
      while (this.spawnAccum > interval && this.aliveCount() < target) {
        this.spawnAccum -= interval;
        this.spawnOne(player, ctx.cameraForward, { night: ctx.night });
      }
    } else {
      this.spawnAccum = Math.min(this.spawnAccum, 0.5);
    }

    // ---- update actives
    const despawnDist2 = ZOMBIES.despawn * ZOMBIES.despawn;
    const animDist2 = 90 * 90;
    let footstepped = null;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const z = this.active[i];
      const dx = z.pos.x - player.position.x;
      const dz = z.pos.z - player.position.z;
      const d2 = dx * dx + dz * dz;

      // despawn: dead-and-sunk, or alive but hopelessly far behind
      if (!z.active) {
        this.active.splice(i, 1);
        continue;
      }
      if (z.alive && d2 > despawnDist2) {
        z.despawn();
        this.active.splice(i, 1);
        continue;
      }

      const aiCtx = {
        player,
        world: this.world,
        col: this.col,
        night: ctx.night,
        weatherFog: ctx.weatherFog,
        tower: ctx.tower,
        manager: this,
        dt,
      };

      if (z.alive) {
        z.ai.update(dt, aiCtx);
        // gravity + collision through the same moveBody the player uses
        z.vel.y += WORLD.gravity * dt;
        const res = this.col.moveBody(z.pos, z.vel, dt, {
          radius: z.type.radius,
          height: z.crawler ? 0.8 : 1.5,
          stepHeight: 0.65,
          grounded: true,
          snapDown: true,
          climbRate: 1.6,
        });
        if (res.grounded) z.vel.y = 0;
        // stuck detection → sidestep order
        const planarSpeed = Math.hypot(z.vel.x, z.vel.z);
        const wants = z.ai.steer(aiCtx);
        if (wants && planarSpeed < wants.speed * 0.3 && z.staggerT <= 0) {
          z.ai.stuckT += dt;
          if (z.ai.stuckT > 0.5) {
            z.ai.sidestepT = 0.5 + this.rng() * 0.5;
            z.ai.stuckT = 0;
          }
        } else {
          z.ai.stuckT = Math.max(0, z.ai.stuckT - dt * 2);
        }
        // ambient moans, spatialised
        if (d2 < 85 * 85) {
          z.ai.moanT -= dt;
          if (z.ai.moanT <= 0) {
            z.ai.moanT = rand(this.rng, 5, 16) * (z.ai.state === ZSTATE.CHASE ? 0.4 : 1);
            if (this.audio) this.audio.play('zombieMoan', { pos: z.pos, volume: 0.5, rate: z.personality.moanPitch });
          }
        }
      }

      const anim = z.update(dt, {
        speed: Math.hypot(z.vel.x, z.vel.z),
        animFar: d2 > animDist2,
      });
      if (anim.footstep && d2 < 30 * 30 && this.audio) {
        this.audio.play('zombieStep', { pos: z.pos, volume: clamp(1 - Math.sqrt(d2) / 30, 0, 1) * 0.5 });
      }
      if (!z.alive && z.active && this.audio && z.corpseT === 0) {
        // death vocal right as the body drops
        this.audio.play('zombieDeath', { pos: z.pos, volume: 0.8, rate: z.personality.moanPitch });
      }
    }

    // ---- separation pass: bodies push apart so the horde reads as a horde
    const n = this.active.length;
    for (let i = 0; i < n; i++) {
      const a = this.active[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < n; j++) {
        const b = this.active[j];
        if (!b.alive) continue;
        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        const rr = a.type.radius + b.type.radius;
        const d2 = dx * dx + dz * dz;
        if (d2 < rr * rr && d2 > 1e-6) {
          const d = Math.sqrt(d2);
          const push = ((rr - d) / d) * 0.5;
          a.pos.x -= dx * push;
          a.pos.z -= dz * push;
          b.pos.x += dx * push;
          b.pos.z += dz * push;
        }
      }
    }

    // ---- night eye glow
    const nightEyes = ctx.night;
    if (nightEyes !== this._nightEyes) {
      this._nightEyes = nightEyes;
      for (const z of this.pool) {
        z.eyeMat.color.set(nightEyes ? 0xff2211 : ZOMBIE_TYPES[z.typeKey].colors.eyes);
      }
    }

    this.stats.active = this.active.length;
  }

  /** Raycast the horde: nearest body-part hit. */
  raycast(ray) {
    let best = null;
    for (const z of this.active) {
      if (!z.alive) continue;
      // broad phase against the bounding sphere
      if (!ray.ray.intersectsSphere(z.boundingSphere)) continue;
      const hit = z.raycastRegion(ray);
      if (hit && (!best || hit.distance < best.distance)) {
        best = { ...hit, zombie: z };
      }
    }
    return best;
  }

  /** Spatial query for HUD compass / threat proximity. */
  nearestAlive(pos) {
    let best = null;
    let bestD2 = Infinity;
    for (const z of this.active) {
      if (!z.alive) continue;
      const d2 = (z.pos.x - pos.x) ** 2 + (z.pos.z - pos.z) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = z;
      }
    }
    return best ? { zombie: best, dist: Math.sqrt(bestD2) } : null;
  }

  clear() {
    for (const z of this.active) z.despawn();
    this.active.length = 0;
    this._noiseQueue.length = 0;
    this.stats.active = 0;
  }

  dispose() {
    this.clear();
    for (const z of this.pool) {
      this.group.remove(z.root);
      z.root.traverse((o) => {
        if (o.isMesh) o.geometry.dispose();
      });
      for (const m of z.mats) m.dispose();
      z.eyeMat.dispose();
    }
    this.pool.length = 0;
  }
}
