/**
 * Survival — the run orchestrator. Everything the player does meets here:
 * the shot that rings out (noise), the horde that hears it (AI), the kill
 * that pays (economy), the crate that drops (noise again), the night that
 * falls (difficulty). If a system doesn't feed another system, it doesn't
 * belong in DEADFALL.
 *
 * States: 'loading' → 'playing' ⇄ 'paused' → 'dead' → (restart) 'playing'.
 * The menu layer (main.js + Menu) drives start/pause; Survival never touches
 * the DOM directly — everything visual goes through the HUD facade.
 */
import * as THREE from 'three';
import {
  WORLD, PLAYER, WEAPONS, ZOMBIE_TYPES, ZOMBIES, ECONOMY, EVENTS, TOWERS, DAYNIGHT,
} from '../config/GameConfig.js';
import { World } from '../world/World.js';
import { PlayerController } from '../player/PlayerController.js';
import { Loadout } from '../weapons/Loadout.js';
import { ZombieManager } from '../zombies/ZombieManager.js';
import { HitDetection } from './HitDetection.js';
import { Economy } from './Economy.js';
import { DayNight } from './DayNight.js';
import { Weather } from './Weather.js';
import { Fx } from '../core/Fx.js';
import { RainField } from '../core/RainField.js';
import { makeMaterials } from '../core/Textures.js';
import { clamp, formatTime, rand } from '../core/math.js';

const SAVE_KEY = 'deadfall.save';
const AUTOSAVE_INTERVAL = 20;
const INTERACT_PRIORITY = ['crate', 'cache', 'tower'];

export class Survival {
  constructor({ engine, input, audio, hud, seed = WORLD.seed, settings = {} }) {
    this.engine = engine;
    this.input = input;
    this.audio = audio;
    this.hud = hud;
    this.seed = seed;
    this.settings = settings;
    this.state = 'loading';
    this.elapsed = 0;
    this.kills = 0;
    this.killsByType = {};
    this.headshots = 0;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.coinsEarned = 0;
    this.difficulty = 1;
    this.buyMenuOpen = false;
    this.adminOpen = false;
    this._saveT = 0;
    this._diffT = 0;
    this._eventT = rand(Math.random, EVENTS.interval[0], EVENTS.interval[1]);
    this._heartT = 0;
    this._musicCooldown = 0;
    this._flash = 0;
    this._lastMusicLayer = null;
    this._tmpV = new THREE.Vector3();
    this._atm = {}; // combined atmosphere handed to engine.applyEnvironment
    this._eventLog = [];
  }

  /* ------------------------------------------------------------ lifecycle */

  async init(onProgress = () => {}) {
    const engine = this.engine;
    this.materials = makeMaterials();
    this.fx = new Fx({ materials: this.materials });
    this.world = new World({ materials: this.materials, seed: this.seed });
    await this.world.build(onProgress);

    engine.scene.add(this.world.group);
    this.fx.attach(engine.scene);

    this.dayNight = new DayNight({
      startPhase: DAYNIGHT.startPhase,
      onPhaseChange: (name) => {
        if (this.state === 'playing') this.hud.banner(name, 2.2);
      },
    });
    this.weather = new Weather({
      seed: this.seed,
      onLightning: ({ distanceKm }) => this.#lightning(distanceKm),
      onStateChange: (name) => {
        if (this.state === 'playing') this.hud.notify(`WEATHER: ${name}`);
      },
    });

    const env = {
      world: this.world.world,
      terrain: this.world.terrain,
      ground: (x, z) => this.world.ground(x, z),
      surfaceAt: (x, z) => this.world.surfaceAt(x, z),
    };
    this.player = new PlayerController({ camera: engine.camera, env, audio: this.audio, fx: this.fx });
    this.loadout = new Loadout({
      audio: this.audio,
      fx: this.fx,
      materials: this.materials,
      kick: (p, y, r) => this.player.applyRecoil(p, y, r),
    });
    engine.vmScene.add(this.loadout.group);

    this.zombies = new ZombieManager({
      world: this.world,
      fx: this.fx,
      audio: this.audio,
      onPlayerDamage: (dmg, fromPos, typeKey) => this.#playerStruck(dmg, fromPos, typeKey),
      onZombieKilled: (z, info) => this.#zombieKilled(z, info),
      seed: this.seed,
    });
    engine.scene.add(this.zombies.group);

    this.hitDetection = new HitDetection({ world: this.world, zombies: this.zombies });

    this.economy = new Economy({
      materials: this.materials,
      world: this.world,
      fx: this.fx,
      audio: this.audio,
      onLoot: (item, amount) => this.#grantLoot(item, amount),
      onDropLanded: (drop) => {
        this.audio.play('crateLand', { pos: { x: drop.x, y: drop.y, z: drop.z }, gain: 1 });
        this.zombies.notifyNoise({ x: drop.x, y: drop.y, z: drop.z }, ZOMBIES.noiseCrateLand, 1);
        this.hud.notify('SUPPLY DROP LANDED — FOLLOW THE BEACON');
      },
      onDropIncoming: (crate) => {
        this.audio.play('crateIncoming', { gain: 0.8 });
        this.hud.notify(`${crate.label} INBOUND`);
      },
      seed: this.seed,
    });
    engine.scene.add(this.economy.group);

    this.rain = new RainField({ seed: this.seed });
    this.rain.attach(engine.scene);

    this.#applyAtmosphere(0);
    this.player.reset({ x: 0, z: 0, yaw: Math.PI });
    this.state = 'menu';
    this.#hudSnapshot(true);
    return this;
  }

  start() {
    if (this.state === 'playing') return;
    // fresh run (a restart clears the save — death is death)
    if (this._pendingRestart) {
      this.#resetRun();
      this._pendingRestart = false;
    }
    this.state = 'playing';
    this.hud.banner('SURVIVE', 2.4);
    this.#hudSnapshot(true);
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.#save();
  }

  resume() {
    if (this.state === 'paused') this.state = 'playing';
  }

  /** Escape closes overlays first (buy menu / dev panel); returns 'closed'. */
  escapeAction() {
    if (this.buyMenuOpen) {
      this.buyMenuOpen = false;
      this.hud.setBuyMenu(false, ECONOMY.crates, this.economy.coins);
      this.audio.play('uiBack', { gain: 0.7 });
      return 'closed';
    }
    if (this.adminOpen) {
      this.adminOpen = false;
      this.hud.setAdminPanel(false);
      return 'closed';
    }
    return null;
  }

  requestRestart() {
    this._pendingRestart = true;
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch { /* storage may be blocked */ }
  }

  #resetRun() {
    this.elapsed = 0;
    this.kills = 0;
    this.killsByType = {};
    this.headshots = 0;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.coinsEarned = 0;
    this.difficulty = 1;
    this.zombies.clear();
    this.economy.clear();
    this.economy.coins = ECONOMY.startingCoins;
    this.dayNight.t = DAYNIGHT.startPhase;
    this.dayNight.unpin();
    this.loadout.reset();
    this.player.reset({ x: 0, z: 0, yaw: Math.PI });
    this.world.restorePickups(null);
    this._eventT = rand(Math.random, EVENTS.interval[0], EVENTS.interval[1]);
    this._eventLog.length = 0;
  }

  /* ------------------------------------------------------------- the loop */

  update(dt) {
    const input = this.input.sample(dt);
    this.inp = input;
    this.inputState = input;

    if (this.state === 'loading') {
      // init() is async because the initial chunk window is built over several
      // frames. The render loop can already be alive by then, so never touch
      // fx/player/world fields until init() has finished wiring them.
      return;
    }
    if (this.state !== 'playing') {
      // paused/dead: world keeps breathing behind the overlay (no sim)
      this.fx?.update(dt, this.engine.camera.position);
      if (this.player && this.loadout && this.zombies) this.#hudSnapshot();
      return;
    }

    this.elapsed += dt;
    this._musicCooldown = Math.max(0, this._musicCooldown - dt);

    // ---- menu overlays that still let the world run
    this.#updateBuyMenuInput();
    this.#updateAdminInput();

    // ---- player (look → move) — towers freeze movement but keep look
    const player = this.player;
    const weaponState = this.loadout.current?.state;
    const adsT = weaponState?.adsT ?? 0;
    const canControl = !player.inTower && !this.buyMenuOpen;
    player.look(input.lookDelta.x, input.lookDelta.y, adsT, player._sprinting ?? false);
    player.screenShake = this.settings.screenShake !== false;

    const move = player.update(dt, {
      forward: canControl && input.forward,
      back: canControl && input.back,
      left: canControl && input.left,
      right: canControl && input.right,
      jump: canControl && input.jump,
      crouch: canControl && input.crouch,
      sprinting: canControl && input.sprinting,
      moveLen: canControl ? input.moveLen : 0,
      adsT,
      lookScale: this.settings.sensitivity ?? 1,
      invertY: !!this.settings.invertY,
      onStep: (pos, loud) => this.#footstepNoise(pos, loud),
      onFallDamage: (dmg) => {
        this.hud.damage(0.6);
        this.hud.notify(`-${Math.round(dmg)} HEALTH`);
      },
    });
    player._sprinting = move.sprinting;

    // ---- weapons (fire / reload / switch / ADS)
    this.#updateWeapons(dt, move);

    // ---- world streaming + pickups
    this.world.update(player.position.x, player.position.z, dt);

    // ---- zombies (AI, movement, animation, spawning)
    const atmos = this.#applyAtmosphere(dt);
    this.zombies.updateDifficulty({
      distance: player.distanceTravelled,
      elapsed: this.elapsed,
      kills: this.kills,
      night: atmos.isNight,
    });
    this.difficulty = this.zombies.difficulty;
    this.zombies.update(dt, {
      player,
      night: atmos.isNight,
      weatherFog: clamp(atmos.fogFar / 250, 0.3, 1),
      cameraForward: player.forwardVec,
      inTower: player.inTower,
      tower: this.#currentTower()?.tower,
    });

    // ---- economy (airdrops in flight, beacons)
    this.economy.update(dt, player.position);

    // ---- interactions: E (crates > caches > towers)
    this.#updateInteractions();

    // ---- world events
    this.#updateEvents(dt, atmos.isNight);

    // ---- tower safety: regen + weapons disabled inside
    if (player.inTower) {
      const healed = player.heal(TOWERS.regenPerSecond * dt);
      if (healed > 0 && Math.floor(this.elapsed * 4) % 4 === 0) {
        // subtle periodic cue, not a heal spam
      }
    }

    // ---- audio director (music layer + weather + heartbeat)
    this.#updateAudioDirector(dt, atmos);

    // ---- fx + rendering helpers
    this.fx.update(dt, this.engine.camera.position);
    this.engine.updateShadowCamera(player.position, dt);

    // ---- difficulty + autosave cadence
    this._diffT += dt;
    if (this._diffT > 1) this._diffT = 0;
    this._saveT += dt;
    if (this._saveT > AUTOSAVE_INTERVAL) {
      this._saveT = 0;
      this.#save();
    }

    // ---- death check
    if (!player.alive && this.state === 'playing') {
      this.#die();
    }

    this.#hudSnapshot();
  }

  /* --------------------------------------------------------------- weapons */

  #updateWeapons(dt, move) {
    const input = this.inp;
    const lo = this.loadout;
    const weapon = lo.current;
    const blocked = this.player.inTower || this.buyMenuOpen || this.adminOpen;

    // switching: 1/2/3 + wheel
    if (!blocked) {
      if (input.slot1Pressed) lo.selectSlot(1);
      else if (input.slot2Pressed) lo.selectSlot(2);
      else if (input.slot3Pressed) lo.selectSlot(3);
      if (input.wheel) lo.scroll(Math.sign(input.wheel));
    }

    const adsWanted = !blocked && input.ads;
    lo.update(dt, {
      moving: move.moveSpeed > 0.6,
      sprinting: move.sprinting,
      grounded: move.grounded,
      adsWanted,
      moveSpeed: move.moveSpeed,
      lookVel: 0,
      pitch: move.pitch,
    });

    // trigger: auto = held, semi = fresh press
    if (!blocked) {
      const wantFire = weapon.def.auto ? input.fire : input.firePressed;
      if (wantFire) {
        const shot = lo.tryFire(this.elapsed, this.engine.camera, move.moveSpeed / 8);
        if (shot && !shot.empty) this.#resolveShot(shot);
        else if (shot?.empty) this.hud.notify('RELOAD [R]');
      }
    }
    if (input.reloadPressed && !blocked) lo.startReload();
  }

  #resolveShot(shot) {
    this.shotsFired++;
    // the gunshot is the loudest thing in the world — everything hears it
    this.zombies.notifyNoise(shot.origin, ZOMBIES.noiseGunshot, 1);
    const hit = this.hitDetection.playerShot(shot.origin, shot.dir, this.loadout.current.def);
    const w = this.loadout.current;
    if (hit.type === 'zombie') {
      this.shotsHit++;
      w.onShotResolved(true);
      const res = this.zombies.damageZombie(hit.zombie, hit.damage, hit.region, hit.point, shot.dir);
      this.audio.play(hit.region === 'head' ? 'headshot' : 'hitFlesh', { gain: 0.8 });
      this.hud.hitmarker(hit.region === 'head');
      if (res.killed && hit.region === 'head') this.headshots++;
    } else {
      w.onShotResolved(false);
      if (hit.type === 'world') {
        this.fx.impact(hit.point, hit.normal, hit.surface ?? 'concrete');
        this.audio.play(`impact${(hit.surface ?? 'concrete').replace(/^./, (c) => c.toUpperCase())}`, {
          pos: hit.point, gain: 0.7,
        });
      }
    }
  }

  /* ------------------------------------------------------------ zombie→player */

  #playerStruck(dmg, fromPos, typeKey) {
    const player = this.player;
    if (!player.alive || player.inTower) return;
    const before = player.health;
    player.takeDamage(dmg, fromPos);
    const applied = before - player.health;
    if (applied > 0) {
      this.hud.damage(clamp(applied / 45, 0.35, 1));
      this.audio.play('hurt', { gain: clamp(applied / 30, 0.4, 1) });
      const label = ZOMBIE_TYPES[typeKey]?.label ?? 'ZOMBIE';
      this.hud.notify(`${label} HIT YOU  -${Math.round(applied)}`);
    }
  }

  #zombieKilled(z, info) {
    this.kills++;
    this.killsByType[z.typeKey] = (this.killsByType[z.typeKey] ?? 0) + 1;
    // coin reward: type roll × night bonus × headshot bonus
    const [lo, hi] = z.type.coins;
    let coins = Math.round(rand(Math.random, lo, hi));
    if (this.dayNight.out.isNight) coins = Math.round(coins * ECONOMY.nightCoinBonus);
    if (info.headshot) coins = Math.round(coins * ECONOMY.headshotCoinBonus);
    this.economy.addCoins(coins);
    this.coinsEarned += coins;
    this.hud.notify(`+${coins} COINS${info.headshot ? ' — HEADSHOT' : ''}`);
    this.audio.play('kill', { gain: 0.5 });
  }

  #footstepNoise(pos, loud) {
    const radius = loud >= 1 ? ZOMBIES.noiseSprintStep : ZOMBIES.noiseWalkStep;
    this.zombies.notifyNoise(pos, radius, loud);
  }

  /* ------------------------------------------------------------- loot/pickups */

  #grantLoot(item, amount) {
    const player = this.player;
    switch (item) {
      case 'ammo':
      case 'ammoBig': {
        const r = this.loadout.addAmmo(item, amount);
        if (r) this.hud.notify(`+${r.amount} ${r.weapon === 'marksman' ? 'RIFLE (HEAVY)' : 'AMMO'}`);
        this.audio.play('pickupAmmo', { gain: 0.8 });
        break;
      }
      case 'medkit':
      case 'bandage': {
        const heal = item === 'medkit' ? ECONOMY.medkitHeal : ECONOMY.bandageHeal;
        const healed = player.heal(heal);
        this.hud.notify(`+${Math.round(healed)} HEALTH`);
        this.audio.play('pickupHealth', { gain: 0.9 });
        break;
      }
      case 'coins':
        this.economy.addCoins(amount);
        this.hud.notify(`+${amount} COINS`);
        this.audio.play('pickupCoin', { gain: 0.9 });
        break;
      default:
        break;
    }
  }

  #collectPickups() {
    const got = this.world.collectPickups(this.player.position);
    for (const p of got) {
      let item = p.kind;
      if (p.kind === 'coins') {
        const amount = Math.round(rand(Math.random, ECONOMY.coinPickup[0], ECONOMY.coinPickup[1]));
        this.economy.addCoins(amount);
        this.coinsEarned += amount;
        this.hud.notify(`+${amount} COINS`);
        this.audio.play('pickupCoin', { gain: 0.8 });
        continue;
      }
      if (p.kind === 'ammo') {
        const amount = Math.round(rand(Math.random, ECONOMY.ammoPickup[0], ECONOMY.ammoPickup[1]));
        this.loadout.addAmmo('ammo', amount);
        this.hud.notify(`+${amount} AMMO`);
        this.audio.play('pickupAmmo', { gain: 0.7 });
        continue;
      }
      const heal = p.kind === 'medkit' ? ECONOMY.medkitHeal : ECONOMY.bandageHeal;
      const healed = this.player.heal(heal);
      this.hud.notify(`+${Math.round(healed)} HEALTH`);
      this.audio.play('pickupHealth', { gain: 0.8 });
      void item;
    }
  }

  /* ------------------------------------------------------------ interactions */

  #currentTower() {
    return this.world.nearestTower(this.player.position);
  }

  #interactTarget() {
    const pos = this.player.position;
    const crate = this.economy.crateNear(pos);
    if (crate) return { kind: 'crate', target: crate, prompt: `E — OPEN ${crate.label}` };
    const cache = this.world.cacheNear(pos);
    if (cache && !this.world.openedCaches.has(cache.key)) return { kind: 'cache', target: cache, prompt: 'E — SEARCH CACHE' };
    if (!this.player.inTower) {
      const t = this.#currentTower();
      if (t && t.dist < TOWERS.enterRadius && !this.player.towerTransition) {
        return { kind: 'tower', target: t, prompt: 'E — CLIMB TOWER' };
      }
    } else if (!this.player.towerTransition) {
      return { kind: 'towerExit', target: null, prompt: 'E — DESCEND' };
    }
    return null;
  }

  #updateInteractions() {
    const target = this.#interactTarget();
    this._interact = target;
    this.hud.prompt(target ? target.prompt : '');
    if (target && this.inp.interactPressed) {
      switch (target.kind) {
        case 'crate': {
          const grants = this.economy.openCrate(target.target);
          this.audio.play('crateOpen', { pos: { x: target.target.x, y: target.target.y, z: target.target.z }, gain: 0.9 });
          this.hud.notify(grants.length ? 'CRATE OPENED' : 'CRATE EMPTY');
          break;
        }
        case 'cache': {
          this.world.markCacheOpened(target.target.key);
          // caches hold a modest, useful scatter
          const roll = Math.random();
          if (roll < 0.4) this.#grantLoot('ammo', Math.round(rand(Math.random, 30, 60)));
          else if (roll < 0.7) this.#grantLoot('bandage', 1);
          else if (roll < 0.9) this.#grantLoot('coins', Math.round(rand(Math.random, 14, 34)));
          else this.#grantLoot('ammoBig', Math.round(rand(Math.random, 10, 22)));
          this.audio.play('crateOpen', { pos: { x: target.target.x, y: target.target.y, z: target.target.z }, gain: 0.7 });
          break;
        }
        case 'tower':
          this.#enterTower(target.target.tower);
          break;
        case 'towerExit':
          this.#exitTower();
          break;
        default:
          break;
      }
    }
    // pickups are passive (walk over them)
    this.#collectPickups();
  }

  #enterTower(tower) {
    const player = this.player;
    const stand = tower.stand;
    const top = this._tmpV.set(stand.x, tower.topY, stand.z);
    player.inTower = true;
    this.audio.play('towerClank', { pos: top, gain: 0.9 });
    this.zombies.notifyNoise({ x: stand.x, y: tower.baseY, z: stand.z }, ZOMBIES.noiseTowerClank, 0.8);
    player.startTowerTransition(player.position.clone(), top, () => {
      this.hud.notify('SAFE ZONE — WEAPONS DISABLED');
    });
  }

  #exitTower() {
    const player = this.player;
    const t = this.#currentTower();
    const base = t?.tower;
    const exitPos = this._tmpV.set(
      (base?.ladder.x ?? player.position.x) + 1.6,
      base ? this.world.ground(base.ladder.x + 1.6, base.ladder.z + 1.6) : player.position.y,
      (base?.ladder.z ?? player.position.z) + 1.6,
    );
    player.inTower = false;
    this.audio.play('towerClank', { gain: 0.7 });
    player.startTowerTransition(player.position.clone(), exitPos.clone(), () => {});
  }

  /* ----------------------------------------------------------------- events */

  #updateEvents(dt, night) {
    this._eventT -= dt;
    if (this._eventT > 0) return;
    this._eventT = rand(Math.random, EVENTS.interval[0], EVENTS.interval[1]);
    // pick weighted
    const w = EVENTS.weights;
    let r = Math.random() * (w.horde + w.surge + w.signal + w.elite);
    let ev = 'horde';
    if ((r -= w.horde) <= 0) ev = 'horde';
    else if ((r -= w.surge) <= 0) ev = 'surge';
    else if ((r -= w.signal) <= 0) ev = 'signal';
    else ev = 'elite';

    switch (ev) {
      case 'horde': {
        const size = Math.round(rand(Math.random, EVENTS.hordeSize[0], EVENTS.hordeSize[1]) * (night ? 1.25 : 1));
        const n = this.zombies.spawnHorde(this.player, this.player.forwardVec, size, { night });
        this.hud.banner('HORDE INCOMING', 2.6);
        this.audio.play('radioStatic', { gain: 0.5 });
        this._eventLog.push({ t: this.elapsed, ev, n });
        break;
      }
      case 'surge': {
        // a restless night pushes the population beyond the curve for a while
        this._surgeT = 45;
        this.hud.banner('THE DEAD GROW RESTLESS', 2.6);
        this._eventLog.push({ t: this.elapsed, ev });
        break;
      }
      case 'signal': {
        // free supply drop — the beacon draws zombies too
        this.economy.incoming.push({ tier: Math.random() < 0.3 ? 'medical' : 'basic', delay: rand(Math.random, 8, 12) });
        this.audio.play('radioStatic', { gain: 0.7 });
        this.hud.notify('SUPPLY SIGNAL DETECTED');
        this._eventLog.push({ t: this.elapsed, ev });
        break;
      }
      case 'elite': {
        // a screamer and its escorts — kill it before it calls the county
        const n = this.zombies.spawnHorde(this.player, this.player.forwardVec,
          Math.round(rand(Math.random, EVENTS.eliteGuard[0], EVENTS.eliteGuard[1])), { night, type: 'runner' });
        this.zombies.spawnOne(this.player, this.player.forwardVec, { night, type: 'screamer' });
        this.hud.banner('SCREAMER SPOTTED', 2.6);
        this._eventLog.push({ t: this.elapsed, ev, n });
        break;
      }
      default:
        break;
    }
  }

  /* ------------------------------------------------------- atmosphere/audio */

  #applyAtmosphere(dt) {
    const day = this.dayNight.update(dt);
    const weather = this.weather.update(dt, { nightFactor: day.nightFactor });
    // rain streaks follow the camera; wind direction drifts slowly so
    // storms read as gusting instead of a fixed slant
    const windMag = weather.wind ?? 0;
    const windAng = this.elapsed * 0.031;
    this.rain?.update(dt, this.engine.camera.position, weather.rain, {
      x: Math.sin(windAng) * windMag,
      z: Math.cos(windAng * 0.83) * windMag,
    });

    const surgeK = this._surgeT > 0 ? (this._surgeT -= dt, 1) : 0;
    this._surge = surgeK;
    const fogColor = this.weather.fogColor(day.fogColor, this._atmColor ?? new THREE.Color());
    this._atmColor = fogColor;
    this._flash = Math.max(0, this._flash - dt * 3.2);
    const atm = this._atm;
    atm.sunDir = day.sunDir;
    atm.sunColor = day.sunColor;
    atm.sunIntensity = day.sunIntensity;
    atm.skyTop = day.skyTop;
    atm.skyHorizon = day.skyHorizon;
    atm.skyBottom = day.skyBottom;
    atm.hemiSky = day.hemiSky;
    atm.hemiGround = day.hemiGround;
    atm.hemiIntensity = day.hemiIntensity;
    atm.fogColor = fogColor;
    atm.fogNear = weather.fogNear;
    atm.fogFar = weather.fogFar;
    atm.exposure = day.exposure;
    atm.dim = weather.dim;
    atm.flash = this._flash;
    this.engine.applyEnvironment(atm);
    return { ...day, isNight: day.isNight || false, fogFar: weather.fogFar, rain: weather.rain };
  }

  #lightning(distanceKm) {
    this._flash = 1;
    const delay = distanceKm / 0.343; // thunder travels at the speed of sound
    this.audio.play('thunder', { gain: clamp(1.2 - distanceKm * 0.15, 0.3, 1), when: delay });
  }

  #updateAudioDirector(dt, atmos) {
    const threat = this.zombies.nearestAlive(this.player.position);
    const chasing = threat && threat.zombie.ai.state === 'CHASE' && threat.dist < 60;
    const critical = this.player.health < PLAYER.health * 0.3;

    // music layer with a cooldown so it doesn't flicker between states
    let layer = 'explore';
    if (atmos.isNight) layer = 'night';
    if (chasing) layer = 'chase';
    else if (threat && threat.dist < 34) layer = 'tension';
    if (layer !== this._lastMusicLayer && this._musicCooldown <= 0) {
      this._lastMusicLayer = layer;
      this._musicCooldown = 8; // give each layer room to breathe
      this.audio.setMusicLayer(layer, chasing ? 1 : 0.6);
    } else if (layer === this._lastMusicLayer) {
      this.audio.setMusicLayer(layer, chasing ? clamp(1 - (threat?.dist ?? 99) / 60, 0.4, 1) : 0.55);
    }

    this.audio.setWeatherAudio({ wind: this.weather.out.wind, rain: this.weather.out.rain });
    this.audio.setTension(chasing ? clamp(1 - threat.dist / 60, 0.2, 1) : 0);

    // heartbeat when close to death
    if (critical) {
      this._heartT -= dt;
      if (this._heartT <= 0) {
        this._heartT = 0.9;
        this.audio.play('heartbeat', { gain: 0.8 });
      }
    }
  }

  /* ---------------------------------------------------------- buy + admin UI */

  #updateBuyMenuInput() {
    const input = this.inp;
    if (input.buymenuPressed) {
      this.buyMenuOpen = !this.buyMenuOpen;
      this.hud.setBuyMenu(this.buyMenuOpen, ECONOMY.crates, this.economy.coins);
      this.audio.play(this.buyMenuOpen ? 'ui' : 'uiBack', { gain: 0.8 });
    }
    if (this.buyMenuOpen) {
      // while the menu is up, 1–4 pick crates instead of weapons
      const order = ['basic', 'medical', 'weapon', 'premium'];
      if (input.slot1Pressed) this.#buy(order[0]);
      else if (input.slot2Pressed) this.#buy(order[1]);
      else if (input.slot3Pressed) this.#buy(order[2]);
      else if (input.slot4Pressed) this.#buy(order[3]);
    }
  }

  #buy(tierId) {
    const result = this.economy.buy(tierId);
    if (result.ok) {
      this.audio.play('buy', { gain: 0.9 });
      this.hud.setBuyMenu(true, ECONOMY.crates, this.economy.coins);
    } else {
      this.audio.play('buyFail', { gain: 0.9 });
      this.hud.notify(result.reason === 'COINS' ? 'NOT ENOUGH COINS' : 'DROP SYSTEMS BUSY');
    }
  }

  #updateAdminInput() {
    const input = this.inp;
    if (input.adminPressed) {
      this.adminOpen = !this.adminOpen;
      this.hud.setAdminPanel(this.adminOpen, {
        time: this.dayNight.t,
        weather: this.weather.out.state,
        difficulty: this.difficulty,
      });
      // the panel's slider needs a real cursor
      if (this.adminOpen) this.input.exitLock?.();
      else if (this.state === 'playing') this.input.requestLock?.();
    }
    if (this.adminOpen && this.input.adminCommand) {
      const cmd = this.input.adminCommand;
      if (cmd.time !== undefined) this.dayNight.setTime(cmd.time);
      if (cmd.weather) this.weather.setState(cmd.weather);
      if (cmd.unpin) {
        this.dayNight.unpin();
        this.weather.unpin();
      }
      this.input.adminCommand = null;
      this.hud.setAdminPanel(true, {
        time: this.dayNight.t,
        weather: this.weather.out.state,
        difficulty: this.difficulty,
      });
    }
  }

  /* ------------------------------------------------------------- death/save */

  #die() {
    this.state = 'dead';
    this.hud.showDeath(this.#stats());
    this.#save();
  }

  #stats() {
    return {
      time: formatTime(this.elapsed),
      kills: this.kills,
      killsByType: { ...this.killsByType },
      headshots: this.headshots,
      coinsEarned: this.coinsEarned,
      accuracy: this.shotsFired ? Math.round((this.shotsHit / this.shotsFired) * 100) : 0,
      distance: Math.round(this.player.distanceTravelled),
      difficulty: this.difficulty.toFixed(1),
    };
  }

  /** Public wrapper so tests (and a future "save & quit" button) can force a snapshot. */
  saveNow() { this.#save(); }

  #save() {
    try {
      const data = {
        version: 2,
        coins: this.economy.coins,
        loadout: this.loadout.serialize(),
        health: this.player.health,
        pos: { x: this.player.position.x, y: this.player.position.y, z: this.player.position.z },
        yaw: this.player.yaw,
        dayT: this.dayNight.t,
        elapsed: this.elapsed,
        kills: this.kills,
        killsByType: this.killsByType,
        headshots: this.headshots,
        shotsFired: this.shotsFired,
        shotsHit: this.shotsHit,
        coinsEarned: this.coinsEarned,
        distance: this.player.distanceTravelled,
        collected: [...this.world.collected],
        openedCaches: [...this.world.openedCaches],
      };
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    } catch { /* private mode etc. — the run simply won't persist */ }
  }

  #loadSave() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      const d = JSON.parse(raw);
      if (d.version !== 2) return false;
      this.economy.restore({ coins: d.coins });
      this.loadout.restore(d.loadout);
      this.player.reset({ x: d.pos.x, y: d.pos.y, z: d.pos.z, yaw: d.yaw });
      this.player.health = clamp(d.health ?? PLAYER.health, 1, PLAYER.health);
      this.dayNight.t = d.dayT ?? DAYNIGHT.startPhase;
      this.elapsed = d.elapsed ?? 0;
      this.kills = d.kills ?? 0;
      this.killsByType = d.killsByType ?? {};
      this.headshots = d.headshots ?? 0;
      this.shotsFired = d.shotsFired ?? 0;
      this.shotsHit = d.shotsHit ?? 0;
      this.coinsEarned = d.coinsEarned ?? 0;
      this.world.restorePickups(d.collected ?? []);
      for (const key of d.openedCaches ?? []) this.world.markCacheOpened(key);
      return true;
    } catch {
      return false;
    }
  }

  /** Menu hook: continue from the autosave if one exists. */
  hasSave() {
    try {
      return !!localStorage.getItem(SAVE_KEY);
    } catch {
      return false;
    }
  }

  continueRun() {
    if (this.hasSave() && this.#loadSave()) {
      this.state = 'playing';
      this.hud.banner('RUN RESUMED', 2);
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------- HUD */

  #hudSnapshot(force = false) {
    if (!this.hud) return;
    const player = this.player;
    const weapon = this.loadout.current;
    const threat = this.zombies?.nearestAlive?.(player.position) ?? null;
    this.hud.update(
      {
        state: this.state,
        health: Math.round(player.health),
        maxHealth: player.maxHealth,
        stamina: Math.round(player.stamina),
        ammoLabel: weapon?.ammoLabel ?? '',
        weaponName: weapon?.def.name ?? '',
        weaponSlots: this.loadout.order.map((k) => ({
          key: WEAPONS[k].slot,
          name: WEAPONS[k].name.split(' ')[0],
          active: k === this.loadout.currentKey,
          mag: this.loadout.weapons[k].state.mag,
        })),
        coins: this.economy.coins,
        clock: this.dayNight.clockLabel(),
        phase: this.dayNight.phaseName,
        isNight: this.dayNight.out.isNight,
        weather: this.weather.out.state,
        difficulty: this.difficulty,
        kills: this.kills,
        prompt: this._interact?.prompt ?? '',
        buyMenuOpen: this.buyMenuOpen,
        adminOpen: this.adminOpen,
        inTower: player.inTower,
        threatDist: threat?.dist ?? null,
        threatBearing: threat
          ? Math.atan2(threat.zombie.pos.x - player.position.x, threat.zombie.pos.z - player.position.z) * 180 / Math.PI
          : null,
        crates: this.economy.activeDrops().map((d) => ({
          x: d.x, z: d.z, y: d.y, label: d.label,
        })),
        compassYaw: player.yaw,
      },
      force,
    );
  }

  /* -------------------------------------------------------------- debugging */

  devSpawnHorde(count = 8, type = null) {
    return this.zombies.spawnHorde(this.player, this.player.forwardVec, count, { type, night: this.dayNight.out.isNight });
  }

  dispose() {
    this.engine.scene.remove(this.world.group, this.zombies.group, this.economy.group, this.fx.group);
    this.engine.vmScene.remove(this.loadout.group);
    this.rain?.dispose();
    this.zombies.dispose();
    this.economy.dispose();
    this.world.dispose();
  }
}
