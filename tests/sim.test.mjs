/**
 * Headless integration test: the whole survival loop, no renderer.
 *
 * This is what stands in for "I played it": build the streamed world, walk for
 * minutes of game time, get chased, shoot back, earn coins, order an airdrop,
 * climb a tower, die, restart and resume from the save — asserting on the
 * loops that make the game a game.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { installDomStub } from './stubDom.js';

installDomStub();

const { Engine } = await import('../src/core/Engine.js');
const { Survival } = await import('../src/game/Survival.js');
const { NullAudio } = await import('../src/core/AudioEngine.js');
const { ZSTATE } = await import('../src/zombies/ZombieAI.js');
const { ZOMBIES } = await import('../src/config/GameConfig.js');

const DT = 1 / 60;

/* ------------------------------------------------------------- harness */

class FakeInput {
  constructor() {
    this.frame = {};
    this.adminCommand = null;
  }
  sample() {
    const f = this.frame;
    this.frame = {};
    return {
      lookDelta: { x: f.lookX ?? 0, y: f.lookY ?? 0 },
      forward: !!f.forward, back: false, left: false, right: false,
      jump: !!f.jump, sprinting: !!f.sprint, crouch: false,
      fire: !!f.fire, ads: false, firePressed: !!f.firePressed,
      reloadPressed: false, pausePressed: false, debugPressed: false, mutePressed: false,
      slot1Pressed: false, slot2Pressed: false, slot3Pressed: false, slot4Pressed: false,
      interactPressed: !!f.interact, buymenuPressed: false, adminPressed: false,
      wheel: 0, autoReload: true, locked: false, moveLen: f.forward || f.back || f.left || f.right ? 1 : 0,
    };
  }
  requestLock() {}
  exitLock() {}
}

class FakeHUD {
  constructor() {
    this.snaps = 0;
    this.notes = [];
    this.banners = [];
    this.prompts = new Set();
    this.hitmarkers = 0;
    this.damages = 0;
    this.deathStats = null;
    this.buyMenuStates = [];
    this.last = null;
  }
  update(s) { this.snaps++; this.last = s; }
  prompt(t) { this.prompts.add(t); }
  notify(t) { this.notes.push(t); }
  banner(t) { this.banners.push(t); }
  hitmarker() { this.hitmarkers++; }
  damage() { this.damages++; }
  setBuyMenu(open, crates, coins) { this.buyMenuStates.push({ open, coins }); }
  setAdminPanel() {}
  showDeath(stats) { this.deathStats = stats; }
  hideDeath() {}
  hideOverlays() {}
}

function makeEngine() {
  const engine = new Engine({ canvas: null, onFrame: null });
  // headless: stub the renderer-facing surface, keep the scene graph real
  engine.renderer = {
    toneMappingExposure: 1,
    shadowMap: { needsUpdate: false, autoUpdate: false },
    info: { render: { calls: 0, triangles: 0 } },
  };
  engine.applyEnvironment = () => {};
  engine.updateShadowCamera = () => {};
  engine.updateWorldCulling = () => ({ cells: { visible: 0 }, casters: 0 });
  engine.scene = new THREE.Scene();
  engine.vmScene = new THREE.Scene();
  engine.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 400);
  return engine;
}

async function makeGame(seed = 20260917) {
  const engine = makeEngine();
  const hud = new FakeHUD();
  const input = new FakeInput();
  const game = new Survival({ engine, input, audio: new NullAudio(), hud, seed, settings: {} });
  await game.init(() => {});
  return { game, hud, input, engine };
}

/* ---------------------------------------------------------------- tests */

test('survival: render loop is safe while async init is still loading', () => {
  const game = new Survival({ engine: {}, input: new FakeInput(), audio: new NullAudio(), hud: new FakeHUD() });
  assert.doesNotThrow(() => game.update(DT));
  assert.equal(game.state, 'loading');
});

test('survival: boots into menu, starts, and the world is standing', async () => {
  const { game, hud } = await makeGame();
  assert.equal(game.state, 'menu');
  game.start();
  assert.equal(game.state, 'playing');
  game.update(DT);
  assert.ok(hud.snaps > 0, 'HUD receives snapshots');
  assert.ok(Number.isFinite(game.player.position.x + game.player.position.y + game.player.position.z));
  assert.ok(game.world.chunks.size > 20, `streamed chunks: ${game.world.chunks.size}`);
});

test('survival: walking stays grounded and zombies ramp with difficulty', async () => {
  const { game } = await makeGame();
  game.start();
  for (let f = 0; f < 60 * 75; f++) {
    game.input.frame.forward = f % 900 < 640;
    game.update(DT);
    const p = game.player.position;
    assert.ok(Number.isFinite(p.x + p.y + p.z), `frame ${f}: finite position`);
    assert.ok(p.y < 40, `frame ${f}: no launch (y=${p.y.toFixed(1)})`);
  }
  assert.ok(game.player.distanceTravelled > 120, `travelled ${game.player.distanceTravelled.toFixed(0)}m`);
  assert.ok(game.difficulty > 1.5, `difficulty ramped to ${game.difficulty.toFixed(2)}`);
  assert.ok(game.zombies.stats.spawned > 0, `zombies spawned: ${game.zombies.stats.spawned}`);
  assert.ok(game.zombies.aliveCount() <= ZOMBIES.maxActive, 'population capped');
});

test('survival: combat pipeline — shots hit, kills pay, corpses recycle', async () => {
  const { game, hud } = await makeGame();
  game.start();
  const p = game.player.position;
  const gy = game.world.ground(p.x, p.z + 8);
  const z = game.zombies.spawnOne(game.player, { x: 0, z: 1 }, { at: { x: p.x, y: gy, z: p.z + 8 }, type: 'walker' });
  z.yaw = Math.PI; // facing the player (player faces +z)
  const coins0 = game.economy.coins;
  // aim: keep pitch tracking the walker's chest — it approaches over lower
  // ground, so a flat eye-level shot sails over its head
  const aimAtZombie = () => {
    const eyeY = p.y + 1.62;
    const targetY = z.pos.y + 1.15;
    const dx = z.pos.x - p.x;
    const dz = z.pos.z - p.z;
    game.player.yaw = Math.atan2(-dx, -dz); // forward = (−sin, −cos)
    game.player.pitch = Math.atan2(targetY - eyeY, Math.hypot(dx, dz));
  };
  for (let f = 0; f < 240; f++) {
    aimAtZombie();
    game.input.frame.fire = true;
    game.update(DT);
  }
  assert.ok(game.shotsFired > 5, `shots fired: ${game.shotsFired}`);
  assert.ok(game.shotsHit >= 1, `shots hit: ${game.shotsHit}`);
  assert.ok(hud.hitmarkers >= 1, 'hitmarker feedback fired');
  assert.ok(!z.alive, 'walker died');
  assert.ok(game.economy.coins > coins0, `coins earned: ${game.economy.coins - coins0}`);
  assert.ok(game.kills === 1, 'kill counted');
  // corpse recycles (keep the player alive so the run can't end and freeze updates)
  for (let f = 0; f < (ZOMBIES.corpseTTL + 10) * 60; f++) {
    game.player.health = 100;
    game.update(DT);
  }
  assert.equal(game.state, 'playing', 'run survived the wait');
  // the corpse released back to the pool — either still parked (!active) or
  // already reused by the spawn director for a fresh zombie (alive again)
  assert.ok(!z.active || z.alive, `corpse recycled (active=${z.active} alive=${z.alive})`);
});

test('survival: gunshots are heard — nearby zombies investigate', async () => {
  const { game } = await makeGame();
  game.start();
  const p = game.player.position;
  const gy = game.world.ground(p.x + 40, p.z);
  const z = game.zombies.spawnOne(game.player, { x: 1, z: 0 }, { at: { x: p.x + 40, y: gy, z: p.z }, type: 'walker' });
  assert.equal(z.ai.state, 'IDLE');
  // fire a few rounds (noise radius 105m covers 40m)
  for (let f = 0; f < 10; f++) {
    game.input.frame.fire = true;
    game.update(DT);
  }
  assert.ok([ZSTATE.INVESTIGATE, ZSTATE.CHASE, ZSTATE.SEARCH].includes(z.ai.state),
    `gunshot pulled the walker in (state=${z.ai.state})`);
});

test('survival: airdrop — buy, land, beacon, E-open, loot applied', async () => {
  const { game, hud } = await makeGame();
  game.start();
  game.economy.coins = 400;
  const result = game.economy.buy('medical');
  assert.equal(result.ok, true);
  for (let f = 0; f < 60 * 26; f++) game.update(DT);
  const drop = game.economy.drops.find((d) => d.landed);
  assert.ok(drop, 'crate landed');
  assert.ok(drop.beacon.visible, 'beacon lit');
  // stand on the crate and press E
  game.player.position.set(drop.x, drop.y, drop.z);
  game.input.frame.interact = true;
  const ammo0 = game.loadout.weapons.rifle.state.reserve;
  const hp0 = game.player.health;
  game.update(DT);
  assert.ok(drop.opened, 'crate opened via E');
  assert.ok(hud.notes.some((n) => /HEALTH|AMMO|COINS/.test(n)), 'loot notifications shown');
  assert.ok(game.player.health > hp0 || game.loadout.weapons.rifle.state.reserve > ammo0, 'loot actually applied');
});

test('survival: towers are safe zones — E enters, weapons lock, E exits', async () => {
  const { game, hud } = await makeGame();
  game.start();
  // teleport next to the nearest tower
  const near = game.world.nearestTower(game.player.position);
  assert.ok(near, 'a tower is loaded near spawn');
  const t = near.tower;
  game.player.position.set(t.ladder.x, game.world.ground(t.ladder.x, t.ladder.z), t.ladder.z);
  game.update(DT);
  assert.ok([...hud.prompts].some((p) => /CLIMB/i.test(p)), `climb prompt: ${[...hud.prompts].join(' | ')}`);
  game.input.frame.interact = true;
  game.update(DT);
  assert.ok(game.player.inTower || game.player.towerTransition, 'climb started');
  // finish the transition
  for (let f = 0; f < 90; f++) game.update(DT);
  assert.ok(game.player.inTower, 'player is up the tower');
  // firing is blocked while inside
  const fired0 = game.shotsFired;
  for (let f = 0; f < 30; f++) {
    game.input.frame.fire = true;
    game.update(DT);
  }
  assert.equal(game.shotsFired, fired0, 'weapons disabled in the safe zone');
  // regen ticks
  game.player.health = 50;
  for (let f = 0; f < 60 * 3; f++) game.update(DT);
  assert.ok(game.player.health > 50, `regen in tower: ${game.player.health.toFixed(1)}`);
  // exit
  game.input.frame.interact = true;
  game.update(DT);
  for (let f = 0; f < 90; f++) game.update(DT);
  assert.equal(game.player.inTower, false, 'back on the ground');
});

test('survival: death ends the run with stats; restart resets the world', async () => {
  const { game, hud } = await makeGame();
  game.start();
  game.player.takeDamage(999, null);
  game.update(DT);
  assert.equal(game.state, 'dead');
  assert.ok(hud.deathStats, 'death screen data');
  assert.ok(hud.deathStats.kills === 0);
  game.requestRestart();
  game.start();
  assert.equal(game.state, 'playing');
  assert.equal(game.player.health, game.player.maxHealth, 'health restored');
  assert.equal(game.economy.coins, 0, 'coins reset');
  assert.equal(game.kills, 0, 'kills reset');
  assert.ok(Math.abs(game.player.position.x) < 1 && Math.abs(game.player.position.z) < 1, 'back at spawn');
});

test('survival: save + continue restores the run', async () => {
  const { game } = await makeGame(555);
  game.start();
  // make the run distinctive
  game.economy.coins = 123;
  game.player.distanceTravelled = 50;
  game.player.position.set(20, game.world.ground(20, 30), 30);
  game.saveNow();
  assert.ok(game.hasSave(), 'save written');
  // new instance "continue"
  const engine2 = makeEngine();
  const hud2 = new FakeHUD();
  const input2 = new FakeInput();
  const game2 = new Survival({ engine: engine2, input: input2, audio: new NullAudio(), hud: hud2, seed: 555, settings: {} });
  await game2.init(() => {});
  assert.ok(game2.hasSave());
  assert.ok(game2.continueRun(), 'continue succeeds');
  assert.equal(game2.economy.coins, 123, 'coins restored');
  assert.ok(Math.abs(game2.player.position.x - 20) < 0.01, 'position restored');
  localStorage.removeItem('deadfall.save');
  localStorage.removeItem('deadfall.settings');
});

test('survival: performance smoke — 60 sim-seconds stay well under real-time', async () => {
  const { game } = await makeGame();
  game.start();
  game.zombies.difficulty = 8; // busy world
  const t0 = performance.now();
  for (let f = 0; f < 60 * 60; f++) {
    game.input.frame.forward = f % 300 < 200;
    game.update(DT);
  }
  const ms = performance.now() - t0;
  assert.ok(ms < 20000, `60 game-seconds took ${ms.toFixed(0)}ms of wall time`);
});
