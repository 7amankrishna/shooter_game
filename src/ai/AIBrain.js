/**
 * AIBrain — perception + tactical state machine for the combat machine.
 *
 * Cycle (as specified):  Detect → Aim → Fire → Evaluate → Move → Take Cover
 *                        → Reposition → Attack
 *
 * Design rules that keep it a *fight* instead of an aimbot:
 *  - it has a virtual reticle that physically slews toward you (aim rate) and
 *    settles in bursts, so it must "get on you" before it can shoot well;
 *  - reaction delay before returning fire, per-shot recoil climb, magazine,
 *    reload time, and a deliberate miss roll all live here, not in the HUD;
 *  - difficulty is bought with *decisions*: cover quality, reposition cadence,
 *    flanking, movement prediction and search rigour — not with perfect aim.
 */
import * as THREE from 'three';
import { AI } from '../config/GameConfig.js';
import { DEG, clamp, damp, lerp, rand, randInt, angleDelta } from '../core/math.js';

const STRAFE_DIRS = [1, -1];

export class AIBrain {
  constructor({ machine, env, cfg, audio = null, fx = null, rng = Math.random }) {
    this.machine = machine;
    this.env = env;
    this.audio = audio;
    this.fx = fx;
    this.rng = rng;
    this.configure(cfg);

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.prevPos = new THREE.Vector3();
    this.yaw = 0;
    this.grounded = true;
    this.health = AI.health;

    this.aimPoint = new THREE.Vector3();
    this.aimError = new THREE.Vector3();
    /** Accumulated muzzle climb for the current AI burst — reset between bursts. */
    this.recoilClimb = 0;
    this.peeking = false;
    this.lastKnown = new THREE.Vector3();
    this.lastKnownTime = -99;
    this.seeTimer = 0;
    this.awareness = 0;
    this.state = 'PATROL';
    this.stateTime = 0;
    this.log = [];
    this.noiseEvents = [];
    this.hitMeshRay = new THREE.Raycaster();
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._eye = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this.reset();
  }

  configure(cfg) {
    this.cfg = cfg;
    this.mag = cfg.magSize;
    this.reserve = 999;
  }

  reset(spawn = { x: 0, y: 0, z: -40 }) {
    this.pos.set(spawn.x, spawn.y, spawn.z);
    this.pos.y = this.env.ground(spawn.x, spawn.z);
    this.prevPos.copy(this.pos);
    this.vel.set(0, 0, 0);
    this.machine.spawnAt(this.pos.x, this.pos.y, this.pos.z, 0);
    // It knows an intruder is inside the perimeter, so its opening search line
    // runs toward the middle of the arena. Without this the patrol graph can
    // carry it *away* from the player and a match can fail to ever start.
    this.lastKnown.set(0, this.env.ground(0, 0), 0);
    this.lastKnownTime = -2;
    // face the middle of the arena rather than an arbitrary axis
    this.yaw = Math.atan2(-this.pos.x, -this.pos.z);
    this.health = AI.health;
    this.maxHealth = AI.health;
    this.alive = true;
    this.mag = this.cfg.magSize;
    this.reloading = false;
    this.reloadT = 0;
    this.awareness = 0;
    this.state = 'PATROL';
    this.stateTime = 0;
    this.time = 0;
    this.path = null;
    this.pathIndex = 0;
    this.pathAge = 0;
    this.moveTarget = null;
    this.cover = null;
    this.crouch = 0;
    this.strafeDir = 1;
    this.strafeT = 0;
    this.recoilClimb = 0;
    this.peeking = false;
    this.aimTarget = new THREE.Vector3();
    this.reactionT = rand(this.rng, ...this.cfg.reaction);
    this.burstShots = 0;
    this.burstGapT = 0;
    this.fireT = rand(this.rng, 0.2, 0.6);
    this.evaluateT = 0;
    this.repositionT = rand(this.rng, 2, this.cfg.repositionInterval);
    this.exposureT = 0;
    this.searchT = 0;
    this.searchNodes = [];
    this.stuckT = 0;
    this.lastDamageAt = -99;
    this.timeSeen = 0;
    this.aimSlew = 3.2 + this.cfg.aimErrorDeg * -0.2;
    this.aimYaw = this.yaw;
    this.aimPitch = 0;
    this.intentFire = false;
    this.jumpT = 0;
    this.suppressed = 0;
    this.flankT = 0;
    this.noiseEvents.length = 0;
    this.log.length = 0;
    this.machine.setVisor('patrol');
    this.transition('PATROL');
    // never spawn into an idle standstill — it has a route to walk at t=0
    this.pickPatrolTarget();
  }

  /**
   * The gun's aim pivot: a *smoothed* chest point, independent of the walk
   * animation and of the instant ledge step-ups the collider sweep performs.
   * Aiming off the raw physics y made every slope and crate the machine walked
   * over punch 0.5-1 m of vertical error into an otherwise good shot, which
   * read as "the AI is random", not "the AI isskilled".
   */
  aimPivot(out = new THREE.Vector3()) {
    const y = (Number.isFinite(this.smoothY) ? this.smoothY : this.pos.y) + AI.aimHeightChest;
    out.set(this.pos.x, y, this.pos.z);
    const cp = Math.cos(this.aimPitch);
    out.x += Math.sin(this.aimYaw) * cp * 0.42;
    out.z += Math.cos(this.aimYaw) * cp * 0.42;
    out.y += Math.sin(this.aimPitch) * 0.42;
    return out;
  }

  /** Point the sensor suite at something (used at spawn and by scripted starts). */
  faceToward(x, z) {
    const yaw = Math.atan2(x - this.pos.x, z - this.pos.z);
    this.yaw = yaw;
    this.aimYaw = yaw;
    this.machine.root.rotation.y = yaw;
    this.machine.updateBounds();
  }

  transition(next, note = '') {
    if (this.state === next) return;
    this.state = next;
    this.stateTime = 0;
    this.log.push(`${next}${note ? ` (${note})` : ''}`);
    if (this.log.length > 40) this.log.shift();
  }

  /* -------------------------------------------------------------- senses */

  /** Player gunfire / sprinting footsteps register as sound, LOS not required. */
  notifyNoise(point, kind = 'gunshot') {
    if (!this.alive) return;
    const d = this.pos.distanceTo(point);
    // Rifle shots carry far beyond footfalls — this is what makes "you fired,
    // now you are being hunted" true across the long lanes of the arena.
    const radius = this.cfg.hearingRadius * (kind === 'gunshot' ? 1.75 : kind === 'step' ? 0.32 : 0.6);
    if (d > radius) return;
    const strength = clamp(1 - d / radius, 0, 1);
    const spread = clamp(d * 0.16, 0, 9);
    this._tmp.copy(point);
    this._tmp.x += rand(this.rng, -spread, spread);
    this._tmp.z += rand(this.rng, -spread, spread);
    this.lastKnown.copy(this._tmp);
    this.lastKnownTime = this.time;
    this.awareness = Math.min(1.35, Math.max(this.awareness, 0.45 + strength * 0.55));
    if (this.state === 'PATROL') this.transition('INVESTIGATE', 'noise');
    else if (this.state === 'SEARCH' && strength > 0.6) this.transition('INVESTIGATE', 'noise');
    if (this.state === 'INVESTIGATE') this.pathToLastKnown();
  }

  /**
   * The player landed a hit — react like a fighter, not a damage sponging
   * target. Health itself is owned by `AIMachine.applyDamage`.
   */
  notifyDamage({ amount = 0, headshot = false, killed = false } = {}) {
    if (!this.alive) return;
    this.lastDamageAt = this.time;
    this.suppressed = Math.min(1, this.suppressed + (headshot ? 0.95 : clamp(amount / 45, 0.15, 0.7)));
    this.health = this.machine.health;
    if (killed) {
      this.alive = false;
      this.transition('DEAD');
      return;
    }
    this.machine.setVisor(this.awareness > 0.8 ? 'engage' : 'search');
    // "quickly reacts when hit": on HARD it instantly breaks the player's aim
    if (this.cfg.coverChance > 0.7 && this.state !== 'IN_COVER' && this.rng() < 0.75) {
      this.seekCover('shot');
    } else if (this.rng() < this.cfg.coverChance * 0.6) {
      this.strafeT = 0; // snap to a new strafe line
    }
  }

  perceive(dt, player) {
    const to = this._tmp.copy(player.position).sub(this.pos);
    const dist = to.length();
    to.normalize();
    const fwd = { x: Math.sin(this.yaw), z: Math.cos(this.yaw) };
    const facingDot = fwd.x * to.x + fwd.z * to.z;
    const inFov = facingDot > Math.cos((this.cfg.fovDeg / 2) * DEG);
    const eye = this._eye.set(this.pos.x, this.pos.y + AI.eyeHeight, this.pos.z);
    const target = this._look.set(player.position.x, player.position.y + 1.15, player.position.z);
    let visible = false;
    if (dist < this.cfg.viewRange) {
      // point-blank awareness: you cannot sneak past a machine's microphones
      const needFov = dist > 6;
      if (!needFov || inFov) visible = this.env.world.hasLineOfSight(eye, target);
    }
    if (visible) {
      this.awareness = Math.min(1.35, this.awareness + dt / Math.max(0.02, this.cfg.acquireTime));
      this.lastKnown.copy(player.position);
      this.lastKnownTime = this.time;
      this.timeSeen += dt;
      this.playerVisible = true;
      this.playerVisibleDist = dist;
    } else {
      this.awareness = Math.max(0, this.awareness - dt / Math.max(0.2, this.cfg.loseTime));
      this.playerVisible = false;
      this.playerVisibleDist = dist;
    }
    this.dist = dist;
    this.dirToPlayer = this.dirToPlayer || new THREE.Vector3();
    this.dirToPlayer.set(to.x, 0, to.z).normalize();
    return { visible, dist };
  }

  /* ------------------------------------------------------------- tactics */

  evaluate(dt, player) {
    this.evaluateT -= dt;
    if (this.evaluateT > 0) return;
    this.evaluateT = 0.28;

    if (this.state === 'DEAD') return;

    const engaged = this.awareness >= 1;
    const knowsRoughly = this.time - this.lastKnownTime < 8 && this.awareness > 0.3;
    const hpFrac = this.health / this.maxHealth;

    if (engaged) {
      if (hpFrac <= this.cfg.retreatHealthFrac && this.cfg.retreatHealthFrac > 0 && this.rng() < 0.5) {
        this.transition('RETREAT', 'low hp');
        this.pickRetreatSpot();
        return;
      }
      if (this.mag <= 0 || (this.mag <= 5 && this.rng() < 0.7)) {
        if (this.coverChanceRoll() && this.seekCover('reload')) return;
        this.transition('RELOAD', 'dry');
        this.startReload();
        return;
      }
      // "Do not let the AI stand in one place and continuously shoot" — but only
      // break contact because you made it uncomfortable (suppression / damage /
      // a dry mag), not on a stopwatch. Otherwise it hides more than it fights.
      const pressured = this.suppressed > 0.25 || this.health / this.maxHealth < 0.72 || this.mag <= 6;
      if (
        this.repositionT <= 0 ||
        this.suppressed > 0.55 ||
        (this.exposureT > this.cfg.exposureBudget && pressured)
      ) {
        this.repositionT = this.cfg.repositionInterval * rand(this.rng, 0.7, 1.3);
        this.exposureT = 0;
        const wantFlank = this.rng() < this.cfg.flankChance && this.dist > 9;
        if (wantFlank) {
          this.transition('FLANK', 'angle');
          this.pickFlankSpot(player);
        } else if (this.coverChanceRoll() && this.seekCover('reposition')) {
          /* becomes IN_COVER */
        } else {
          this.transition('REPOSITION', 'reset');
          this.pickRepositionSpot();
        }
        this.suppressed *= 0.4;
      }
      return;
    }

    const inCombat = COMBAT_STATES.has(this.state);
    // Leaving combat needs a real margin: an AI that strobes between ENGAGE and
    // INVESTIGATE every second reads as a bug, and it also cancels its own bursts.
    if (inCombat) {
      if (this.awareness < 0.5 && this.time - this.timeSeen > this.cfg.loseTime) {
        this.transition('SEARCH', 'lost');
        this.beginSearch();
      }
      return;
    }
    if (knowsRoughly) {
      if (this.state !== 'INVESTIGATE' && this.state !== 'SEARCH') this.transition('INVESTIGATE', 'contact');
      return;
    }
    if (this.state === 'SEARCH' && this.stateTime > 9) this.transition('PATROL', 'give up');
    if (this.state === 'PATROL' && this.stateTime > 12) this.pickPatrolTarget();
  }

  coverChanceRoll() {
    return this.rng() < this.cfg.coverChance;
  }

  seekCover(reason) {
    const c = this.env.coverFor(this.pos.x, this.pos.z, this.pos.x + this.dirToPlayer.x * 20, this.pos.z + this.dirToPlayer.z * 20, {
      minRange: this.cfg.coverRange[0],
      maxRange: this.cfg.coverRange[1],
      needHard: this.cfg.coverChance > 0.4,
    });
    if (!c) return false;
    this.cover = c;
    this.transition('IN_COVER', reason);
    this.setPath({ x: c.x, y: c.y, z: c.z });
    this.coverTimer = rand(this.rng, 0.4, 1.3);
    this.peeking = false;
    return true;
  }

  pickRepositionSpot() {
    const side = STRAFE_DIRS[Math.floor(this.rng() * 2)];
    const perp = { x: -this.dirToPlayer.z * side, z: this.dirToPlayer.x * side };
    const dist = rand(this.rng, 10, 22);
    const tx = this.pos.x + perp.x * dist + this.dirToPlayer.x * rand(this.rng, -6, 6);
    const tz = this.pos.z + perp.z * dist + this.dirToPlayer.z * rand(this.rng, -6, 6);
    const cell = this.env.nav.nearestWalkable(tx, tz, 9);
    if (cell < 0) {
      this.transition('ENGAGE');
      return;
    }
    const p = this.env.nav.toPos(cell);
    this.setPath({ x: p.x, y: this.env.ground(p.x, p.z), z: p.z });
  }

  pickFlankSpot(player) {
    const side = this.rng() < 0.5 ? 1 : -1;
    const pf = { x: Math.sin(player.yaw), z: Math.cos(player.yaw) };
    const perp = { x: -pf.z * side, z: pf.x * side };
    const behind = { x: -pf.x, z: -pf.z };
    const dist = rand(this.rng, 14, 26);
    const tx = player.position.x + perp.x * dist * 0.85 + behind.x * dist * 0.7;
    const tz = player.position.z + perp.z * dist * 0.85 + behind.z * dist * 0.7;
    const cell = this.env.nav.nearestWalkable(tx, tz, 12);
    this.flankT = 6.5;
    if (cell < 0) {
      this.pickRepositionSpot();
      return;
    }
    const p = this.env.nav.toPos(cell);
    this.setPath({ x: p.x, y: this.env.ground(p.x, p.z), z: p.z });
  }

  pickRetreatSpot() {
    const away = { x: -this.dirToPlayer.x, z: -this.dirToPlayer.z };
    const dist = rand(this.rng, 16, 30);
    const cell = this.env.nav.nearestWalkable(this.pos.x + away.x * dist, this.pos.z + away.z * dist, 10);
    if (cell >= 0) {
      const p = this.env.nav.toPos(cell);
      this.setPath({ x: p.x, y: this.env.ground(p.x, p.z), z: p.z });
    }
  }

  beginSearch() {
    this.searchT = 0;
    this.searchNodes = [];
    const count = 1 + Math.round(this.cfg.searchIntensity * 2);
    for (let i = 0; i < count; i++) {
      const cell = this.env.nav.randomWalkableNear(this.lastKnown.x, this.lastKnown.z, 5, 20, this.rng);
      if (cell >= 0) {
        const p = this.env.nav.toPos(cell);
        this.searchNodes.push(p);
      }
    }
    this.setPath({ x: this.lastKnown.x, y: this.env.ground(this.lastKnown.x, this.lastKnown.z), z: this.lastKnown.z });
  }

  /**
   * Re-issue a route to the last confirmed/heard player position. Returns false
   * when the machine is already standing on top of it, which is what turns
   * INVESTIGATE into a sweep instead of a frozen statue.
   */
  pathToLastKnown(minDist = 2) {
    const dx = this.lastKnown.x - this.pos.x;
    const dz = this.lastKnown.z - this.pos.z;
    if (Math.hypot(dx, dz) < minDist) return false;
    this.setPath({ x: this.lastKnown.x, y: this.env.ground(this.lastKnown.x, this.lastKnown.z), z: this.lastKnown.z });
    return true;
  }

  pickPatrolTarget() {
    const nodes = this.env.patrolNodes;
    if (!nodes || !nodes.length) return;
    let best = null;
    for (let i = 0; i < 6; i++) {
      const n = nodes[Math.floor(this.rng() * nodes.length)];
      const d = Math.hypot(n.x - this.pos.x, n.z - this.pos.z);
      if (d > 12 && (!best || d > best.d)) best = { n, d };
    }
    const target = best ? best.n : nodes[Math.floor(this.rng() * nodes.length)];
    this.setPath({ x: target.x, y: this.env.ground(target.x, target.z), z: target.z });
  }

  setPath(to) {
    const path = this.env.pathTo(this.pos, to);
    if (!path || path.length === 0) {
      this.path = [{ x: to.x, y: to.y, z: to.z }];
    } else {
      this.path = path.map((p) => ({ x: p.x, y: this.env.ground(p.x, p.z), z: p.z }));
      this.path[this.path.length - 1] = { x: to.x, y: to.y, z: to.z };
    }
    this.pathIndex = 0;
    this.pathAge = 0;
    this.moveTarget = to;
  }

  startReload() {
    if (this.reloading) return;
    this.reloading = true;
    this.reloadT = 0;
    this.transition('RELOAD', 'tactical');
    this.audio?.play('bolt', { pos: this.pos, gain: 0.5 });
  }

  /* --------------------------------------------------------------- firing */

  /**
   * Reticle + trigger control. Called every tick; returns whether a round left
   * the barrel this tick, and the caller pulls the actual shot with `nextShot()`.
   */
  gunnery(dt, player) {
    const cfg = this.cfg;
    const engaged = this.state === 'ENGAGE' || this.state === 'IN_COVER' || this.state === 'REPOSITION' || this.state === 'FLANK' || this.state === 'RELOAD';
    const canSee = this.playerVisible;

    // ---- reticle slew: the gun has to physically come onto the target
    const wantHead = canSee && this.dist < 26 && this.health > 40 && (cfg.key === 'HARD' ? this.rng() < 0.55 : this.rng() < 0.15);
    this.preferredRegion = wantHead ? 'head' : 'chest';
    const lead = clamp(this.dist / 330, 0.02, 0.32) * cfg.prediction;
    const predicted = this._tmp.copy(player.position).addScaledVector(player.velocity ?? ZERO, lead).addScaledVector(UP, 1.15);
    if (!canSee && this.time - this.lastKnownTime < 3.5) predicted.copy(this.lastKnown).add(UP2);
    if (!this.aimTarget) this.aimTarget = new THREE.Vector3();
    // Track quality is a skill stat: how fast the sight keeps up with a strafing
    // target. A slow chase is what makes EASY miss a motionless-ish player, and
    // HARD's near-instant tracking (plus its velocity lead) is what makes it
    // punish sloppy peeks — the difference is *reading*, not a bigger gun.
    const trackRate = 4 + clamp(cfg.minFireAccuracy, 0, 1) * 26;
    this.aimTarget.lerp(predicted, 1 - Math.exp(-trackRate * dt));

    const pivot = this.aimPivot(this._tmp2);
    const dx = this.aimTarget.x - pivot.x;
    const dz = this.aimTarget.z - pivot.z;
    const dy = this.aimTarget.y - pivot.y;
    const targetYaw = Math.atan2(dx, dz);
    const targetPitch = Math.atan2(dy, Math.hypot(dx, dz));
    // Gun handling scales with the same stat that governs trigger discipline:
    // a better machine gets its sight onto you faster, which is what buys it
    // accuracy — it is not given a bigger numbers-stat on the bullet.
    const aimRate = engaged ? 8 + clamp(cfg.minFireAccuracy, 0, 1) * 34 : 3.4;
    this.aimYaw = this.aimYaw + angleDelta(targetYaw, this.aimYaw) * (1 - Math.exp(-aimRate * dt));
    this.aimPitch = damp(this.aimPitch, clamp(targetPitch, -1.1, 1.1), aimRate * 0.8, dt);

    // ---- grouping error: resampled per burst, so shots cluster like a human's
    const aimLag = Math.abs(angleDelta(targetYaw, this.aimYaw)) * RAD_LOCAL + Math.abs(this.aimPitch - targetPitch) * RAD_LOCAL;
    if (this.burstShots <= 0 && this.burstGapT <= 0) {
      const resample = this.rng() < 0.85;
      if (resample) {
        const moving = (player.velocity?.length?.() ?? 0) > 2.2 ? cfg.trackingErrorDeg : 0;
        const rangeK = clamp(this.dist / 34, 0.4, 2.6);
        // Own movement and firing before the gun has settled both widen the
        // group — this is the lever that makes HARD *choose* better shots
        // rather than simply hit harder.
        // The physical slew lag is already in aimYaw/aimPitch when the round
        // leaves, so it is not charged twice here — this term is pure grouping.
        const err = (cfg.aimErrorDeg + moving) * rangeK;
        const a = this.rng() * Math.PI * 2;
        const r = Math.sqrt(this.rng()) * err * DEG;
        this.aimError.set(Math.cos(a) * r, Math.sin(a) * r, 0);
        this.burstShots = randInt(this.rng, cfg.burstShots[0], cfg.burstShots[1]);
      }
    }

    // ---- trigger discipline
    this.intentFire = false;
    if (!this.alive || this.reloading || this.mag <= 0) return;
    if (!canSee && this.state !== 'IN_COVER') { this.fireT = Math.max(this.fireT, 0.25); return; }
    if (this.dist > cfg.fireRange) return;
    if (this.state === 'IN_COVER' && !this.peeking) return;
    if (this.reactionT > 0) {
      this.reactionT -= dt;
      return;
    }
    // settle check: it will not yank the trigger while the gun is still moving
    const settleTol = lerp(9, 2.0, clamp(cfg.minFireAccuracy, 0, 1));
    if (aimLag > settleTol && this.burstShots <= 0) return;

    this.fireT -= dt;
    if (this.fireT > 0) return;
    if (this.burstShots > 0) {
      this.burstShots--;
      this.intentFire = true;
      this.fireT = rand(this.rng, ...cfg.burstGap);
      this.recoilClimb = Math.min(2.4, this.recoilClimb + 0.36);
      if (this.burstShots <= 0) {
        this.fireT = rand(this.rng, ...cfg.burstPause);
        this.burstGapT = this.fireT;
        this.recoilClimb *= 0.25;
      }
    } else {
      this.fireT = rand(this.rng, ...cfg.burstPause) * 0.6;
      this.burstShots = randInt(this.rng, cfg.burstShots[0], cfg.burstShots[1]);
    }
  }

  /** Pulls a trigger press. Returns {origin, dir} or null (dry / reloading). */
  consumeShot() {
    if (!this.intentFire || this.reloading || this.mag <= 0) return null;
    this.mag--;
    this.intentFire = false;
    if (this.mag <= 0) {
      this.audio?.play('dryFire', { pos: this.pos, gain: 0.4 });
      this.startReload();
      return null;
    }
    if (this.rng() < this.cfg.intentionalMiss) {
      // deliberate throw: the fairness valve that keeps bursts survivable
      const a = this.rng() * Math.PI * 2;
      this.aimError.x += Math.cos(a) * 0.06;
      this.aimError.y += Math.sin(a) * 0.06;
    }
    // The round leaves along the gun's *actual* current facing (aimYaw/aimPitch,
    // which slew toward the target), not along the target itself. That is what
    // makes "fire while sidestepping" and "snap onto a new angle" cost real
    // accuracy, and it is why the machine visibly misses when you break rhythm.
    const pivot = this.aimPivot(new THREE.Vector3());
    const fxOrigin = this.machine.muzzlePoint(new THREE.Vector3());
    const yaw = this.aimYaw + this.aimError.x + rand(this.rng, -1, 1) * this.recoilClimb * DEG * 0.6;
    const pitch = clamp(this.aimPitch - this.aimError.y - this.recoilClimb * DEG * 0.35, -1.3, 1.3);
    const dir = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).normalize();
    this.audio?.play('shotAI', { pos: fxOrigin, gain: 1, pitch: 0.95 + this.rng() * 0.1 });
    this.fx?.muzzleFlash(fxOrigin, dir);
    this.fx?.tracer(fxOrigin, fxOrigin.clone().addScaledVector(dir, 90), { color: [1, 0.7, 0.35] });
    this.firingAnim = 0.08;
    return { origin: pivot, dir };
  }

  /* ------------------------------------------------------------- movement */

  steer(dt, desired, speed) {
    if (!desired) return 0;
    const dx = desired.x - this.pos.x;
    const dz = desired.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.35) return 0;
    const yaw = Math.atan2(dx, dz);
    const k = clamp(dist / 3, 0, 1);
    this.vel.x = damp(this.vel.x, Math.sin(yaw) * speed * k, 12, dt);
    this.vel.z = damp(this.vel.z, Math.cos(yaw) * speed * k, 12, dt);
    return dist;
  }

  followPath(dt, speed) {
    if (!this.path || !this.path.length) return 0;
    this.pathAge += dt;
    let wp = this.path[Math.min(this.pathIndex, this.path.length - 1)];
    const d = this.steer(dt, wp, speed);
    if (d < 1.35) {
      this.pathIndex++;
      if (this.pathIndex >= this.path.length) {
        this.path = null;
        this.moveTarget = null;
        return 0;
      }
    }
    if (this.pathAge > 5.5 && this.state !== 'ENGAGE') {
      // re-plan periodically in case geometry moved under it
      if (this.moveTarget) this.setPath(this.moveTarget);
      this.pathAge = 0;
    }
    return d;
  }

  move(dt, player) {
    const cfg = this.cfg;
    let speed = 0;
    let sprint = false;
    let strafeInput = 0;

    switch (this.state) {
      case 'PATROL': {
        if (!this.path) this.pickPatrolTarget();
        speed = this.followPath(dt, cfg.moveSpeed * 0.72);
        // slow sweep: it is still hunting, not strolling
        this.yaw = damp(this.yaw, this.headingOrLookaround(dt) + Math.sin(this.stateTime * 0.5) * 0.45, 4, dt);
        break;
      }
      case 'INVESTIGATE':
      case 'SEARCH': {
        if (!this.path && !this.pathToLastKnown()) {
          // It is standing where it last heard/saw you: sweep the area instead
          // of idling, then hand off to SEARCH (multi-node) or back to PATROL.
          this.searchT += dt;
          this.yaw += dt * 1.15;
          if (this.state === 'INVESTIGATE' && this.searchT > 1.4) {
            this.beginSearch();
            this.transition('SEARCH', 'sweep');
          } else if (this.state === 'SEARCH' && this.searchNodes.length) {
            const n = this.searchNodes.shift();
            this.setPath({ x: n.x, y: this.env.ground(n.x, n.z), z: n.z });
          } else if (this.state === 'SEARCH') {
            this.transition('PATROL', 'nothing');
            this.pickPatrolTarget();
          }
        }
        const arrive = this.followPath(dt, cfg.moveSpeed * (this.dist > 18 ? 1.25 : 1));
        speed = arrive;
        sprint = arrive > 12;
        // Sensor discipline while hunting: the optic stays biased toward the last
        // confirmed contact (with a sweep around that bearing, so it still checks
        // corners) instead of blindly following the path it is walking. Without
        // this the narrow-FOV presets can walk face-first past the player and
        // never re-acquire, which reads as broken rather than as easy.
        const heading = this.moveTarget ? Math.atan2(this.moveTarget.x - this.pos.x, this.moveTarget.z - this.pos.z) : this.yaw;
        const lastKnownDist = Math.hypot(this.lastKnown.x - this.pos.x, this.lastKnown.z - this.pos.z);
        const huntFresh = this.time - this.lastKnownTime < 12 && lastKnownDist > 2.5;
        let wantYaw;
        if (huntFresh) {
          const threatYaw = Math.atan2(this.lastKnown.x - this.pos.x, this.lastKnown.z - this.pos.z);
          wantYaw = heading + angleDelta(threatYaw, heading) * 0.72 + Math.sin(this.stateTime * 0.9) * 0.2;
        } else if (this.moveTarget) {
          wantYaw = heading + Math.sin(this.stateTime * 0.75) * 0.55;
        } else {
          wantYaw = this.yaw + Math.sin(this.stateTime * 0.8) * 1.4;
        }
        this.yaw = damp(this.yaw, wantYaw, this.state === 'SEARCH' ? 2.6 : 4.2, dt);
        if (this.state === 'SEARCH') {
          this.searchT += dt;
          if (!this.path) {
            if (this.searchNodes.length) {
              const n = this.searchNodes.shift();
              this.setPath({ x: n.x, y: this.env.ground(n.x, n.z), z: n.z });
            } else if (this.searchT > 3.5) {
              this.transition('PATROL', 'nothing');
              this.pickPatrolTarget();
            }
          }
        }
        break;
      }
      case 'ENGAGE': {
        // orbit / press / back off, but always relative to the player bearing
        this.strafeT -= dt;
        if (this.strafeT <= 0) {
          this.strafeT = rand(this.rng, 1.4, 3.1);
          this.strafeDir = STRAFE_DIRS[Math.floor(this.rng() * 2)];
        }
        const [minR, maxR] = cfg.preferredRange;
        let radial = 0;
        if (this.dist < minR) radial = -1;
        else if (this.dist > maxR) radial = 1;
        radial *= this.cfg.aggression;
        const perp = { x: -this.dirToPlayer.z * this.strafeDir, z: this.dirToPlayer.x * this.strafeDir };
        const desiredSpeed = cfg.moveSpeed * (0.72 + this.cfg.aggression * 0.35);
        const tvx = perp.x * desiredSpeed * 0.85 + this.dirToPlayer.x * radial * desiredSpeed;
        const tvz = perp.z * desiredSpeed * 0.85 + this.dirToPlayer.z * radial * desiredSpeed;
        this.vel.x = damp(this.vel.x, tvx, 8, dt);
        this.vel.z = damp(this.vel.z, tvz, 8, dt);
        speed = Math.hypot(this.vel.x, this.vel.z);
        strafeInput = this.strafeDir;
        this.yaw = damp(this.yaw, this.aimYaw, 9, dt);
        if (!this.path && this.stuckT > 0.9) this.pickRepositionSpot();
        break;
      }
      case 'REPOSITION':
      case 'FLANK': {
        const remain = this.followPath(dt, this.state === 'FLANK' ? cfg.sprintSpeed : cfg.moveSpeed * 1.12);
        speed = remain;
        sprint = this.state === 'FLANK' && remain > 6;
        // keeps the gun swept roughly towards the last known position
        const wantYaw = Math.atan2(this.lastKnown.x - this.pos.x, this.lastKnown.z - this.pos.z);
        this.yaw = damp(this.yaw, this.playerVisible ? this.aimYaw : wantYaw, 5.5, dt);
        if (this.state === 'FLANK') {
          this.flankT -= dt;
          if (this.flankT <= 0 || !this.path) this.transition('ENGAGE', 'flank done');
        } else if (!this.path) {
          this.transition('ENGAGE', 'set');
          this.reactionT = Math.min(this.reactionT, rand(this.rng, cfg.reaction[0] * 0.4, cfg.reaction[1] * 0.7));
        }
        break;
      }
      case 'IN_COVER': {
        const remain = this.followPath(dt, cfg.moveSpeed);
        speed = Math.max(0, remain) * 0.85;
        if (remain < 1.7) {
          // arrived: reload in safety, then alternate peek shots and hiding
          // top up in safety, but only when the mag is actually low — an AI that
          // reloads after every single shot spends the whole match behind a wall
          if (this.mag <= Math.max(1, Math.floor(cfg.magSize * 0.34)) && !this.reloading) this.startReload();
          const wantYaw = Math.atan2(this.lastKnown.x - this.pos.x, this.lastKnown.z - this.pos.z);
          this.yaw = damp(this.yaw, wantYaw, 5.5, dt);
          this.coverTimer -= dt;
          if (this.coverTimer <= 0) {
            if (this.peeking) {
              this.peeking = false;
              this.coverTimer = rand(this.rng, 0.9, 2.2);
            } else if (this.reloading) {
              this.coverTimer = 0.5; // stay down until the magazine is in
            } else {
              this.peeking = true;
              this.coverTimer = rand(this.rng, 0.55, 1.25);
              this.transition('ENGAGE', 'peek');
              this.reactionT = Math.min(this.reactionT, rand(this.rng, cfg.reaction[0] * 0.45, cfg.reaction[1] * 0.75));
            }
          }
          this.crouch = this.peeking ? 0 : 1;
        } else if (this.path == null) {
          this.transition('ENGAGE', 'cover gone');
        }
        break;
      }
      case 'RELOAD': {
        // keep some movement while the magazine is out — a stationary gun is a dead gun
        const drift = this.playerVisible ? 0.55 : 0.9;
        this.strafeT -= dt;
        if (this.strafeT <= 0) {
          this.strafeT = rand(this.rng, 1.1, 2.2);
          this.strafeDir = STRAFE_DIRS[Math.floor(this.rng() * 2)];
        }
        const perp = { x: -this.dirToPlayer.z * this.strafeDir, z: this.dirToPlayer.x * this.strafeDir };
        this.vel.x = damp(this.vel.x, perp.x * cfg.moveSpeed * drift, 6, dt);
        this.vel.z = damp(this.vel.z, perp.z * cfg.moveSpeed * drift, 6, dt);
        speed = Math.hypot(this.vel.x, this.vel.z);
        this.yaw = damp(this.yaw, this.playerVisible ? this.aimYaw : Math.atan2(this.lastKnown.x - this.pos.x, this.lastKnown.z - this.pos.z), 6, dt);
        break;
      }
      case 'RETREAT': {
        const remain = this.followPath(dt, cfg.sprintSpeed);
        speed = remain;
        sprint = true;
        this.yaw = damp(this.yaw, Math.atan2(this.lastKnown.x - this.pos.x, this.lastKnown.z - this.pos.z), 4, dt);
        if (!this.path) {
          this.transition('RELOAD', 'breather');
          this.seekCover('retreat');
        }
        break;
      }
      case 'DEAD':
        speed = 0;
        break;
      default:
        speed = 0;
    }

    // ---- reload progress
    if (this.reloading) {
      this.reloadT += dt;
      if (this.reloadT >= this.cfg.reloadTime) {
        this.reloading = false;
        this.mag = this.cfg.magSize;
        this.burstShots = 0;
        this.audio?.play('magIn', { pos: this.pos, gain: 0.6 });
        if (this.state === 'RELOAD') this.transition(this.awareness >= 1 ? 'ENGAGE' : 'SEARCH', 'reloaded');
      }
    } else if (this.mag <= 0) {
      this.startReload();
    }

    // ---- vertical smoothing for the aim/eye pivot (see aimPivot)
    this.smoothY = this.smoothY === undefined ? this.pos.y : damp(this.smoothY, this.pos.y, 10, dt);
    if (Math.abs(this.smoothY - this.pos.y) > 2.5) this.smoothY = this.pos.y; // teleport/respawn

    // ---- integrate + collide
    if (!Number.isFinite(this.pos.x + this.pos.y + this.pos.z) || !Number.isFinite(this.vel.x + this.vel.y + this.vel.z)) {
      // never let a NaN become permanent: put the machine back on the ground
      const fx = Number.isFinite(this.lastKnown.x) ? this.lastKnown.x : 0;
      const fz = Number.isFinite(this.lastKnown.z) ? this.lastKnown.z : 0;
      this.pos.set(fx, this.env.ground(fx, fz), fz);
      this.prevPos.copy(this.pos);
      this.vel.set(0, 0, 0);
      this.path = null;
      this.stuckT = 0;
      return;
    }
    this.vel.y -= 24 * dt;
    this.prevPos.copy(this.pos);
    const move = this.env.world.moveBody(this.pos, this.vel, dt, {
      radius: AI.radius,
      height: AI.height,
      stepHeight: AI.stepHeight,
    });
    if (move.grounded) {
      this.grounded = true;
      this.vel.y = 0;
    }
    if (this.jumpT > 0) this.jumpT -= dt;
    if (move.hitWall) {
      this.stuckT += dt;
      if (this.stuckT > 0.75 && speed > 0.4) {
        this.stuckT = 0;
        this.strafeDir *= -1;
        this.strafeT = 1.6;
        if (this.grounded && this.cfg.jumpChance > 0 && this.rng() < this.cfg.jumpChance * 3) {
          this.vel.y = 6.2;
          this.jumpT = 0.6;
          this.grounded = false;
        }
        if (this.state !== 'ENGAGE' && this.moveTarget) this.setPath(this.moveTarget);
        else this.path = null;
      }
    } else if (speed > 0.6) {
      this.stuckT = Math.max(0, this.stuckT - dt * 1.6);
    }
    // bleed off any velocity that the world rejected
    const actual = this._tmp.copy(this.pos).sub(this.prevPos).multiplyScalar(1 / Math.max(dt, 1e-4));
    actual.y = 0;
    this.velocity = this.velocity ?? new THREE.Vector3();
    this.velocity.copy(actual);
    const planarSpeed = Math.hypot(actual.x, actual.z);

    // ---- footstep audio + dust, and sprint noise the player can hear
    const stepInfo = this.machine.update(dt, {
      speed: planarSpeed,
      aimYaw: this.aimYaw,
      aimPitch: this.aimPitch,
      crouch: this.crouch,
      strafe: strafeInput,
      firing: (this.firingAnim ?? 0) > 0,
      grounded: this.grounded,
      moveYaw: this.yaw,
    });
    this.firingAnim = Math.max(0, (this.firingAnim ?? 0) - dt);
    if (stepInfo.footstep) {
      const ear = this.pos.clone().add(UP);
      this.audio?.play('step', { pos: ear, gain: 0.5 + (sprint ? 0.35 : 0), pitch: 0.9 + this.rng() * 0.25 });
      this.fx?.footstep(this.pos, { dust: true });
      if (sprint) this.noiseEmit?.(this.pos, 'step');
    }

    // timers that always run
    this.burstGapT = Math.max(0, (this.burstGapT ?? 0) - dt);
    this.crouch = damp(this.crouch, this.state === 'IN_COVER' ? this.crouch : this.state === 'ENGAGE' && this.cfg.aggression > 0.7 ? 0.15 : 0, 6, dt);
    this.exposureT += this.playerVisible ? dt : 0;
    this.repositionT -= dt;
    this.suppressed = Math.max(0, this.suppressed - dt * 0.35);
    this.awareness = clamp(this.awareness, 0, 1.35);
    this.machine.setVisor(this.state === 'DEAD' ? 'dead' : this.state === 'IN_COVER' ? 'cover' : this.reloading ? 'reload' : this.awareness >= 1 ? 'engage' : this.awareness > 0.3 ? 'search' : 'patrol');
    this.machine.updateBounds();
    this.machine.root.position.copy(this.pos);
  }

  headingOrLookaround(dt) {
    if (this.path && this.pathIndex < this.path.length) {
      const wp = this.path[this.pathIndex];
      return Math.atan2(wp.x - this.pos.x, wp.z - this.pos.z);
    }
    return this.yaw + Math.sin(this.stateTime * 0.9) * 0.55;
  }

  /* ------------------------------------------------------------------ tick */

  update(dt, ctx) {
    if (!this.alive) {
      this.machine.update(dt, { speed: 0 });
      this.machine.root.position.copy(this.pos);
      this.machine.updateBounds();
      return;
    }
    this.time = (this.time ?? 0) + dt;
    this.stateTime += dt;
    const player = ctx.player;
    this.perceive(dt, player);
    this.evaluate(dt, player);
    if (this.state === 'PATROL' || this.state === 'INVESTIGATE' || this.state === 'SEARCH') {
      if (this.awareness >= 1) {
        this.transition('ENGAGE', 'spotted');
        this.reactionT = rand(this.rng, ...this.cfg.reaction);
        this.audio?.play('spot', { pos: this.pos, gain: clamp(1 - this.dist / 60, 0.15, 1) });
      }
    } else if (this.state === 'ENGAGE' || this.state === 'IN_COVER' || this.state === 'REPOSITION' || this.state === 'FLANK' || this.state === 'RELOAD' || this.state === 'RETREAT') {
      // Commit to a maneuver for a beat: re-entering ENGAGE the instant it sees
      // you again would cancel its own flank/reposition and look like twitching.
      const commit = this.state === 'FLANK' || this.state === 'REPOSITION' ? 1.25 : 0;
      if (this.awareness >= 0.85 && this.stateTime > commit) this.transition('ENGAGE', 'contact');
    }
    this.gunnery(dt, player);
    this.move(dt, player);
  }

  get statusLabel() {
    return {
      PATROL: 'PATROLLING',
      INVESTIGATE: 'INVESTIGATING',
      SEARCH: 'SEARCHING',
      ENGAGE: 'ENGAGED',
      IN_COVER: 'IN COVER',
      REPOSITION: 'REPOSITIONING',
      FLANK: 'FLANKING',
      RELOAD: 'RELOADING',
      RETREAT: 'BREAKING CONTACT',
      DEAD: 'DESTROYED',
    }[this.state] ?? this.state;
  }
}

const COMBAT_STATES = new Set(['ENGAGE', 'IN_COVER', 'REPOSITION', 'FLANK', 'RELOAD', 'RETREAT']);

const UP = new THREE.Vector3(0, 1.2, 0);
const UP2 = new THREE.Vector3(0, 1.05, 0);
const ZERO = new THREE.Vector3(0, 0, 0);
const RAD_LOCAL = 180 / Math.PI;
