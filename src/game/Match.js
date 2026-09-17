/**
 * Match — the orchestrator: state flow, combat resolution, feedback routing.
 *
 * It is deliberately renderer-agnostic (it takes the camera/player/AI/fx/audio
 * as collaborators), which is what lets `tests/sim.test.mjs` run a complete
 * match — movement, AI decisions, hitscan, scoring, death — headlessly at a
 * fixed timestep, with no canvas or DOM at all.
 */
import * as THREE from 'three';
import { PLAYER, WEAPON, BODY } from '../config/GameConfig.js';
import { Scoring } from './Scoring.js';
import { HitDetection } from './HitDetection.js';
import { clamp } from '../core/math.js';

export const PHASE = {
  MENU: 'MENU',
  LOADING: 'LOADING',
  BRIEFING: 'BRIEFING',
  PLAYING: 'PLAYING',
  PAUSED: 'PAUSED',
  RESULTS: 'RESULTS',
};

export class Match {
  constructor({ player, weapon, machine, brain, env, fx, audio, hud = null, difficulty }) {
    this.player = player;
    this.weapon = weapon;
    this.machine = machine;
    this.brain = brain;
    this.env = env;
    this.fx = fx;
    this.audio = audio;
    this.hud = hud;
    this.difficulty = difficulty;
    this.scoring = new Scoring();
    this.hit = new HitDetection({ env, machine });
    this.phase = PHASE.MENU;
    this.elapsed = 0;
    this.listeners = new Map();
    this.hitCount = 0;
    this.aiHitCount = 0;
    this.aiShotCount = 0;
    this.dryT = 0;
    this._triggerHeld = false;
    this.outcome = null;
    this._scratch = new THREE.Vector3();
    this._aimOrigin = new THREE.Vector3();
    this.results = null;
  }

  on(event, cb) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(cb);
    return this;
  }

  emit(event, payload) {
    const set = this.listeners.get(event);
    if (set) for (const cb of set) cb(payload);
  }

  setDifficulty(cfg) {
    this.difficulty = cfg;
    this.brain.configure(cfg);
    this.brain.machine.setVisor('patrol');
  }

  start(difficultyCfg) {
    if (difficultyCfg) this.setDifficulty(difficultyCfg);
    // Pick a player spawn, then the machine spawn that is furthest from it: the
    // match must always open with the search/detect phase, never a 10 m ambush.
    const players = this.env.spawns.player;
    const spawn = players[Math.floor(Math.random() * players.length)] ?? players[0];
    const aiSpawn = this.env.spawns.ai.reduce(
      (best, cand) => {
        const d = Math.hypot(cand.x - spawn.x, cand.z - spawn.z);
        return !best || d > best.d ? { cand, d } : best;
      },
      null,
    )?.cand ?? this.env.spawns.ai[0];
    this.player.reset(spawn);
    this.weapon.reset();
    this.scoring.reset();
    this.brain.reset(aiSpawn);
    this.brain.faceToward(spawn.x, spawn.z);
    this.machine.health = this.machine.maxHealth;
    this.machine.alive = true;
    this.fx.clear();
    this.elapsed = 0;
    this.outcome = null;
    this.results = null;
    this.hitCount = 0;
    this.aiHitCount = 0;
    this.aiShotCount = 0;
    this.dryT = 0;
    this.phase = PHASE.PLAYING;
    this.emit('phase', this.phase);
    this.emit('log', { text: `MATCH START · ${this.difficulty.title ?? this.difficulty.key}` });
    this.audio?.play('ui', { gain: 0.6 });
  }

  pause() {
    if (this.phase !== PHASE.PLAYING) return;
    this.phase = PHASE.PAUSED;
    this.emit('phase', this.phase);
  }

  resume() {
    if (this.phase !== PHASE.PAUSED) return;
    this.phase = PHASE.PLAYING;
    this.emit('phase', this.phase);
  }

  abandon() {
    this.phase = PHASE.MENU;
    this.emit('phase', this.phase);
  }

  /* ------------------------------------------------------------------ tick */

  /**
   * @param dt seconds
   * @param input snapshot from InputManager (see InputManager.sample())
   */
  update(dt, input) {
    if (this.phase !== PHASE.PLAYING) {
      // keep the world alive visually while menus are up, but run nothing else
      this.fx.update(dt, this.player.camera.position);
      return;
    }
    this.elapsed += dt;

    const weaponState = this.weapon.update(dt, {
      moving: this.player.moveSpeed > 0.6,
      sprinting: input.sprinting,
      grounded: this.player.grounded,
      adsWanted: input.ads,
      moveSpeed: this.player.moveSpeed,
      pitch: this.player.pitch,
    });
    const adsT = weaponState.adsT;

    // ---- player movement + look
    const look = input.lookDelta;
    if (look.x || look.y) this.player.look(look.x, look.y, adsT, input.sprinting);
    this.player.update(dt, {
      forward: input.forward,
      back: input.back,
      left: input.left,
      right: input.right,
      jump: input.jump,
      crouch: input.crouch,
      sprinting: input.sprinting,
      adsT,
      onStep: (pos, intensity) => {
        if (intensity > 0.8) this.brain.notifyNoise(pos, 'step');
      },
    });

    // keep both scene graphs honest before anything reads a world position
    // (muzzle transform, hitscan origin) — the renderer's own update would
    // otherwise lag a frame behind the simulation.
    this.onCameraSync?.();

    // ---- reload / fire
    if (input.reloadPressed) this.weapon.startReload();
    if (input.fire) {
      const shot = this.weapon.tryFire(this.elapsed, this.player.camera, clamp(this.player.moveSpeed / PLAYER.sprintSpeed, 0, 1));
      if (shot && !shot.empty) this.resolvePlayerShot(shot);
      else if (shot?.empty) this.emit('warn', { text: this.weapon.state.reserve > 0 ? 'RELOAD [R]' : 'NO AMMO' });
    }
    // Auto-reload the instant the mag is dry — including while the trigger is
    // held, which is exactly when a player forgets to press R. The short beat
    // lets the bolt-hold-open click read before the reload animation takes over.
    const w = this.weapon.state;
    if (w.mag === 0 && w.reserve > 0 && !w.reloading) {
      this.dryT += dt;
      if (input.autoReload && this.dryT > 0.32) this.weapon.startReload(true);
    } else {
      this.dryT = 0;
    }

    // ---- the machine
    this.brain.update(dt, {
      player: {
        position: this.player.position,
        velocity: this.player.velocity,
        yaw: this.player.yaw,
        crouching: this.player.crouching,
        health: this.player.health,
      },
    });
    const aiShot = this.brain.consumeShot();
    if (aiShot) this.resolveAiShot(aiShot);

    // ---- combo grace window
    this.scoring.update(dt);

    // ---- effects
    this.fx.update(dt, this.player.camera.position);

    // ---- audio listener + proximity layers
    const camPos = this.player.camera.position;
    this.player.camera.getWorldDirection(this._scratch);
    this.audio?.setListener(camPos, this._scratch, this.player.camera.up);
    const d = camPos.distanceTo(this.machine.root.position);
    this.audio?.setMachineProximity(this.machine.alive ? d : 999, (this.brain.velocity?.length?.() ?? 0) > 1.2);
    this.audio?.setTension(this.machine.alive && this.brain.awareness >= 1 ? clamp(1 - d / 40, 0.25, 1) : clamp(this.brain.awareness * 0.5, 0, 0.4));

    // ---- win / loss
    if (!this.machine.alive && this.outcome === null) this.finish('WIN');
    else if (!this.player.alive && this.outcome === null) this.finish('LOSE');

    this.emit('tick', this.snapshot());
  }

  /* --------------------------------------------------------- shot routing */

  resolvePlayerShot({ origin, dir }) {
    // honest aiming: the ray starts at the eye, the FX start at the muzzle
    this.player.camera.getWorldPosition(this._aimOrigin);
    const result = this.hit.playerShot(this._aimOrigin, dir, WEAPON.hitRange);
    this.scoring.registerShot();

    if (result.type === 'hit' || result.type === 'graze') {
      const def = BODY[result.region] ?? BODY.graze;
      const hitPoint = result.point;
      const killed = result.type === 'hit' && this.machine.health - def.damage <= 0;
      const applied = this.machine.applyDamage(result.damage, result.region, hitPoint);
      const event = this.scoring.registerHit(result.region, result.points);
      this.hitCount++;
      this.weapon.onShotResolved(true);
      this.brain.notifyDamage({ amount: result.damage, headshot: result.region === 'head', killed: applied.killed });
      this.audio?.play(result.region === 'head' ? 'headshot' : 'hit', { gain: result.region === 'head' ? 1 : 0.75 });
      if (result.point) {
        this.fx.impact(
          result.point,
          { x: -dir.x, y: Math.abs(dir.y) * 0.4 + 0.4, z: -dir.z },
          'metal',
        );
      }
      this.emit('hit', {
        region: result.region,
        graze: result.type === 'graze',
        headshot: result.region === 'head',
        points: event.points,
        lines: event.lines,
        streak: this.scoring.streak,
        multiplier: this.scoring.multiplier,
        worldPoint: result.point,
        distance: result.distance,
        killed: applied.killed,
      });
      if (applied.killed) {
        const kill = this.scoring.applyKill({ headshotKill: result.region === 'head', elapsedSeconds: this.elapsed });
        for (const line of kill.lines) {
          this.emit('hit', {
            region: 'kill',
            points: 0,
            lines: [line],
            streak: this.scoring.streak,
            multiplier: this.scoring.multiplier,
            worldPoint: result.point,
            killed: true,
          });
        }
        this.audio?.play('kill', { pos: this.machine.root.position, gain: 1 });
        this.emit('log', { text: 'TARGET NEUTRALISED' });
      }
      void killed;
    } else if (result.type === 'world') {
      this.scoring.registerMiss();
      this.weapon.onShotResolved(false);
      const surf = result.surface === 'metal' ? 'impactMetal' : result.surface === 'wood' ? 'impactWood' : 'impactConcrete';
      this.audio?.play(surf, { pos: result.point, gain: 0.7 });
      this.fx.impact(result.point, result.normal, result.surface);
      this.fx.debris(result.point, [0.5, 0.48, 0.44], 5);
      this.emit('miss', { reason: 'wall' });
    } else {
      this.scoring.registerMiss();
      this.weapon.onShotResolved(false);
      this.emit('miss', { reason: 'air' });
    }

    // the machine hears every round you fire
    this.brain.notifyNoise(origin, 'gunshot');
  }

  resolveAiShot({ origin, dir }) {
    this.aiShotCount++;
    const out = this.hit.aiShot(origin, dir, this.player, this.difficulty.damagePerShot, 220);
    if (out.type === 'hit') {
      const before = this.player.health;
      this.player.takeDamage(out.damage, origin);
      this.aiHitCount++;
      const dmg = before - this.player.health;
      this.audio?.play('hurt', { gain: 0.8 });
      this.fx.impact(out.point, { x: -dir.x, y: 0.3, z: -dir.z }, 'concrete');
      this.emit('playerDamaged', {
        damage: dmg,
        health: this.player.health,
        from: { x: origin.x, y: origin.y, z: origin.z },
      });
    } else if (out.type === 'world') {
      this.audio?.play('impactConcrete', { pos: out.point, gain: 0.55 });
      this.fx.impact(out.point, out.normal, out.surface);
    }
  }

  finish(outcome) {
    this.outcome = outcome;
    const summary = this.scoring.summary(this.elapsed, outcome);
    summary.aiHealth = Math.round(this.machine.health);
    summary.playerHealth = Math.round(this.player.health);
    summary.difficulty = this.difficulty.title ?? this.difficulty.key;
    if (outcome === 'LOSE') {
      summary.score = Math.round(summary.score * 0.5); // partial credit for the hits landed
      this.audio?.play('kill', { gain: 0.5 });
    }
    this.results = summary;
    this.phase = PHASE.RESULTS;
    this.emit('results', summary);
    this.emit('phase', this.phase);
    this.emit('log', { text: outcome === 'WIN' ? 'MATCH WON' : 'PLAYER DOWN' });
  }

  snapshot() {
    const s = this.scoring;
    return {
      phase: this.phase,
      elapsed: this.elapsed,
      player: {
        health: Math.max(0, Math.round(this.player.health)),
        max: this.player.maxHealth,
        alive: this.player.alive,
        crouching: this.player.crouching,
        sprinting: this.player.velocity.length() > PLAYER.maxSpeed * 1.05,
      },
      weapon: {
        name: WEAPON.name,
        mag: this.weapon.state.mag,
        reserve: this.weapon.state.reserve,
        reloading: this.weapon.state.reloading,
        reloadProgress: this.weapon.state.reloading ? clamp(this.weapon.state.reloadT / this.weapon.state.reloadDuration, 0, 1) : 0,
        label: this.weapon.ammoLabel,
        spread: this.weapon.spreadDeg,
        adsT: this.weapon.state.adsT ?? 0,
      },
      ai: {
        health: Math.max(0, Math.round(this.machine.health)),
        max: this.machine.maxHealth,
        alive: this.machine.alive,
        status: this.brain.statusLabel,
        state: this.brain.state,
        distance: this.player.camera.position.distanceTo(this.machine.root.position),
        visible: !!this.brain.playerVisible,
        awareness: this.brain.awareness,
        mag: this.brain.mag,
        reloading: this.brain.reloading,
        shots: this.aiShotCount,
        hits: this.aiHitCount,
        accuracy: this.aiShotCount ? this.aiHitCount / this.aiShotCount : 0,
      },
      score: {
        total: Math.round(s.score),
        hits: s.hits,
        misses: s.misses,
        shots: s.shots,
        headshots: s.headshots,
        grazes: s.grazes,
        streak: s.streak,
        bestStreak: s.bestStreak,
        multiplier: s.multiplier,
        comboLabel: s.comboLabel,
        accuracy: s.accuracy,
      },
      difficulty: this.difficulty.key,
    };
  }
}
