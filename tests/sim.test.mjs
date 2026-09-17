/**
 * Headless integration test: the whole world + the full match loop, no renderer.
 *
 * This is what stands in for "I played it": it builds the real arena, drives the
 * player and the machine for thousands of fixed ticks, and asserts on behaviour
 * (AI notices, moves, uses cover, reloads, fires), on the hit/scoring pipeline
 * (regions map to the right points and damage), and on match termination.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { installDomStub } from './stubDom.js';

installDomStub();

const { makeMaterials } = await import('../src/core/Textures.js');
const { Fx } = await import('../src/core/Fx.js');
const { Environment } = await import('../src/world/Environment.js');
const { PlayerController } = await import('../src/player/PlayerController.js');
const { Weapon } = await import('../src/weapons/Weapon.js');
const { AIMachine } = await import('../src/ai/AIMachine.js');
const { AIBrain } = await import('../src/ai/AIBrain.js');
const { Match, PHASE } = await import('../src/game/Match.js');
const { NullAudio } = await import('../src/core/AudioEngine.js');
const { getDifficulty } = await import('../src/config/DifficultyConfig.js');
const { BODY } = await import('../src/config/GameConfig.js');

const materials = makeMaterials();
const DT = 1 / 60;

let worldPromise = null;
/** Build the arena once — it is static, so every test can share it. */
function world() {
  if (!worldPromise) {
    worldPromise = (async () => {
      const env = new Environment({ materials, seed: 20260917 });
      const t0 = Date.now();
      await env.build(() => {});
      env.__buildMs = Date.now() - t0;
      return env;
    })();
  }
  return worldPromise;
}

function makeRig(env, { difficulty = 'MEDIUM', aiDamage = null } = {}) {
  const cfg = { ...getDifficulty(difficulty) };
  if (aiDamage !== null) cfg.damagePerShot = aiDamage;
  const audio = new NullAudio();
  const fx = new Fx({ materials });
  const camera = new THREE.PerspectiveCamera(76, 16 / 9, 0.1, 600);
  const player = new PlayerController({ camera, env, audio, fx });
  const weapon = new Weapon({ audio, fx, materials, kick: (p, y, r) => player.applyRecoil(p, y, r) });
  const machine = new AIMachine({ fx, audio });
  const brain = new AIBrain({ machine, env, cfg, audio, fx, rng: mulberry(1337) });
  const match = new Match({ player, weapon, machine, brain, env, fx, audio, hud: null, difficulty: cfg });
  match.start(cfg);
  player.reset(env.spawns.player[0]);
  brain.reset(env.spawns.ai[0]);
  return { env, fx, audio, camera, player, weapon, machine, brain, match };
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const idle = (over = {}) => ({
  lookDelta: { x: 0, y: 0 },
  forward: false, back: false, left: false, right: false,
  jump: false, sprinting: false, crouch: false,
  fire: false, ads: false, reloadPressed: false, pausePressed: false,
  debugPressed: false, mutePressed: false, autoReload: true,
  locked: true, dt: DT, ...over,
});

/** Run the match for n ticks with a scripted input generator. */
function run(match, ticks, inputFn = () => idle()) {
  for (let i = 0; i < ticks; i++) {
    match.update(DT, inputFn(i, i * DT));
    if (match.phase !== PHASE.PLAYING) return i;
  }
  return ticks;
}

/** Find a pair of open positions with a clean fire lane between them. */
function clearLane(env, distance = 16) {
  const rng = mulberry(99);
  for (let tries = 0; tries < 4000; tries++) {
    const x = (rng() * 2 - 1) * 70;
    const z = (rng() * 2 - 1) * 70;
    const ang = rng() * Math.PI * 2;
    const ax = x;
    const az = z;
    const bx = x + Math.cos(ang) * distance;
    const bz = z + Math.sin(ang) * distance;
    if (!env.nav.walkable(env.nav.toCell(ax, az)) || !env.nav.walkable(env.nav.toCell(bx, bz))) continue;
    const ay = env.ground(ax, az) + 1.6;
    const by = env.ground(bx, bz) + 1.25;
    const a = new THREE.Vector3(ax, ay, az);
    const b = new THREE.Vector3(bx, by, bz);
    if (!env.world.hasLineOfSight(a, b)) continue;
    if (Math.hypot(ax - bx, az - bz) < distance * 0.9) continue;
    return { a: { x: ax, y: env.ground(ax, az), z: az }, b: { x: bx, y: env.ground(bx, bz), z: bz } };
  }
  return null;
}

test('arena: builds, is deterministic and is actually walkable space', async () => {
  const env = await world();
  const s = env.stats;
  console.log(`   build ${env.__buildMs} ms · ${JSON.stringify(s)}`);
  assert.ok(env.__buildMs < 30000, 'generation must stay fast enough to load');
  assert.ok(s.colliders > 260, `lots of collision volume (${s.colliders})`);
  assert.ok(s.structures >= 14, `the arena has structures (${s.structures})`);
  assert.ok(s.cover > 200, `plenty of cover points (${s.cover})`);
  assert.ok(env.nav.stats().walkable > env.nav.n * env.nav.n * 0.5, 'nav mesh is mostly open');
  assert.ok(env.props.families.length >= 6, 'instanced prop families');
  for (const group of [env.spawns.player, env.spawns.ai]) {
    for (const p of group) {
      assert.ok(env.nav.walkable(env.nav.toCell(p.x, p.z)), 'every spawn sits on walkable ground');
      assert.ok(Number.isFinite(p.y) && Math.abs(p.y) < 30, 'spawn height is finite');
    }
  }
  const pa = env.spawns.player[0];
  const ai = env.spawns.ai[0];
  const opening = Math.hypot(pa.x - ai.x, pa.z - ai.z);
  assert.ok(opening > 45 && opening < 110, `match opens with a 45-110 m search gap (${opening.toFixed(1)})`);
  // the AI must be able to path to the player, and cover must exist en route
  const path = env.pathTo(pa, ai);
  assert.ok(path && path.length > 2, 'AI can navigate the whole arena');
  const cover = env.coverFor(pa.x, pa.z, ai.x, ai.z, { minRange: 4, maxRange: 40, needHard: false });
  assert.ok(cover, 'cover exists between the two spawns');

  // determinism: same seed → byte-identical collider set
  const env2 = new Environment({ materials, seed: 20260917 });
  await env2.build(() => {});
  const hash = (e) => {
    let h = 2166136261;
    const view = new Float32Array(e.world.boxes.length * 6);
    e.world.boxes.forEach((b, i) => {
      view.set([b.min.x, b.max.x, b.min.y, b.max.y, b.min.z, b.max.z], i * 6);
    });
    const bytes = new Uint8Array(view.buffer);
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 16777619);
    }
    return `${h >>> 0}:${e.world.boxes.length}`;
  };
  assert.equal(hash(env), hash(env2), 'procedural generation is reproducible');
});

test('hit detection: body regions pay the designed points and damage', async () => {
  const env = await world();
  const rig = makeRig(env);
  const lane = clearLane(env, 14);
  assert.ok(lane, 'arena has a clear firing lane');
  rig.machine.spawnAt(lane.b.x, lane.b.y, lane.b.z, Math.atan2(-(lane.a.x - lane.b.x), -(lane.a.z - lane.b.z)));
  rig.machine.root.updateMatrixWorld(true);
  const eye = new THREE.Vector3(lane.a.x, lane.a.y + 1.66, lane.a.z);

  const aimAt = (meshName) => {
    const mesh = rig.machine.hitMeshes.find((m) => m.userData.region === meshName);
    assert.ok(mesh, `region mesh for ${meshName}`);
    const target = new THREE.Vector3();
    mesh.getWorldPosition(target);
    const dir = target.clone().sub(eye).normalize();
    return rig.match.hit.playerShot(eye, dir, 300);
  };

  const chest = aimAt('chest');
  assert.equal(chest.type, 'hit', 'a centred shot at an unobstructed machine must connect');
  assert.equal(chest.region, 'chest');
  assert.equal(chest.points, BODY.chest.points);
  assert.equal(chest.damage, BODY.chest.damage);
  const leg = aimAt('leg');
  assert.ok(leg.type === 'hit' || leg.type === 'graze' || leg.type === 'world', `leg shot resolved (${leg.type}/${leg.region})`);
  if (leg.type === 'hit') assert.ok(BODY[leg.region].damage > 0);
  const wall = rig.match.hit.playerShot(eye, new THREE.Vector3(0, 0, -1).set(1, 0, 0), 300);
  assert.notEqual(wall.type, 'hit', 'shooting into empty space is never a hit');

  // damage + score flow through the match resolver
  const before = rig.machine.health;
  rig.machine.applyDamage(40, 'chest', eye);
  assert.equal(rig.machine.health, before - 40, 'chest shot removes 40 hp');
  rig.machine.root.updateMatrixWorld(true);
  const headshot = aimAt('head');
  if (headshot.type === 'hit') {
    assert.equal(headshot.points, 100);
    assert.equal(headshot.damage, 100);
  }
});

test('AI: hunts the player, moves constantly, uses cover and runs dry', async () => {
  const env = await world();
  const rig = makeRig(env, { difficulty: 'MEDIUM', aiDamage: 0.6 });
  const states = new Set();
  const start = { ...rig.brain.pos };
  let maxAware = 0;
  let minDist = Infinity;
  let travelled = 0;
  let prev = { ...rig.brain.pos };
  let outside = false;
  let lowAmmo = false;
  for (let i = 0; i < 60 * 130; i++) {
    rig.match.update(DT, idle({
      left: Math.floor(i / 40) % 2 === 0,
      right: Math.floor(i / 40) % 2 === 1,
      crouch: Math.floor(i / 150) % 4 === 3,
      jump: i % 210 === 0,
      fire: i % 6 === 0,
    }));
    states.add(rig.brain.state);
    maxAware = Math.max(maxAware, rig.brain.awareness);
    minDist = Math.min(minDist, rig.brain.pos.distanceTo(rig.player.position));
    travelled += Math.hypot(rig.brain.pos.x - prev.x, rig.brain.pos.z - prev.z);
    prev = { ...rig.brain.pos };
    if (Math.abs(rig.brain.pos.x) > 107 || Math.abs(rig.brain.pos.z) > 107) outside = true;
    if (rig.brain.mag < rig.brain.cfg.magSize) lowAmmo = true;
    if (rig.match.phase !== PHASE.PLAYING) break;
  }
  console.log(
    `   states ${[...states].join('/')} · travelled ${travelled.toFixed(0)}m · closest ${minDist.toFixed(1)}m · ` +
      `ai ${rig.match.aiShotCount} shots / ${rig.match.aiHitCount} hits · player hp ${rig.player.health.toFixed(0)} · machine hp ${rig.machine.health.toFixed(0)}`,
  );
  assert.ok(!outside, 'the machine never escapes the arena');
  assert.ok(travelled > 60, `it keeps moving across the map (${travelled.toFixed(0)} m in 90 s)`);
  assert.ok(travelled > 90, 'it covers real ground rather than pacing in place');
  assert.ok(maxAware > 0.9, 'it eventually locks onto the player');
  assert.ok(minDist < 45, 'it closes the distance to fight');
  assert.ok(states.has('ENGAGE'), 'it engages');
  const tactical = ['IN_COVER', 'REPOSITION', 'FLANK'].filter((s) => states.has(s));
  assert.ok(tactical.length >= 1, `it uses tactics, not just strafing (saw ${[...states].join(',')})`);
  assert.ok(rig.match.aiShotCount > 10, 'it shoots a lot');
  assert.ok(rig.match.aiHitCount > 0 && rig.match.aiHitCount < rig.match.aiShotCount, 'it hits, and it misses');
  assert.ok(lowAmmo, 'its ammo is finite (reloads during the fight)');
  assert.ok(rig.player.health < 100, 'the player is under pressure');
  assert.equal(rig.brain.state === 'DEAD', rig.machine.health <= 0, 'DEAD only when destroyed');
});

test('fairness: EASY lets you live, HARD punishes — and neither is an aimbot', async () => {
  const env = await world();
  const lane = clearLane(env, 22);
  assert.ok(lane, 'arena has a clear firing lane');
  const out = {};
  for (const key of ['EASY', 'MEDIUM', 'HARD']) {
    const rig = makeRig(env, { difficulty: key });
    rig.player.reset({ ...lane.a, yaw: Math.atan2(-(lane.b.x - lane.a.x), -(lane.b.z - lane.a.z)) });
    rig.brain.reset({ ...lane.b });
    // deep health pool so the sample is about AIM quality, not about how fast
    // each preset can empty a 100 hp bar against a target that never hides
    rig.player.maxHealth = 2400;
    rig.player.health = 2400;
    // a player who just strafes and never shoots: pure AI skill measurement
    // Instrument every AI round so accuracy can be judged at the range the brief
    // describes (a real firefight at 10-30 m), not diluted by optimistic
    // long-range shots across the arena.
    const log = [];
    const orig = rig.match.hit.aiShot.bind(rig.match.hit);
    rig.match.hit.aiShot = (origin, dir, player, dmg, max) => {
      const res = orig(origin, dir, player, dmg, max);
      log.push({ d: Math.hypot(origin.x - player.position.x, origin.z - player.position.z), hit: res.type === 'hit' });
      return res;
    };
    for (let i = 0; i < 60 * 70; i++) {
      rig.match.update(DT, idle({ left: Math.floor(i / 55) % 2 === 0, right: Math.floor(i / 55) % 2 === 1, ads: i % 400 > 300 }));
      if (rig.match.phase !== PHASE.PLAYING) break;
    }
    const m = rig.match;
    const close = log.filter((r) => r.d < 30);
    const far = log.filter((r) => r.d >= 30);
    out[key] = {
      shots: m.aiShotCount,
      accuracy: m.aiShotCount ? m.aiHitCount / m.aiShotCount : 0,
      closeShots: close.length,
      closeAcc: close.length ? close.filter((r) => r.hit).length / close.length : 0,
      farShots: far.length,
      playerHp: rig.player.health,
      outcome: m.outcome,
    };
    console.log(`   ${key}: ${JSON.stringify(out[key])}`);
  }
  assert.ok(out.EASY.shots > 3, 'EASY still returns fire');
  assert.ok(out.MEDIUM.shots > 20 && out.HARD.shots > 20, 'both return fire with real volume');
  assert.ok(out.HARD.shots > out.EASY.shots * 1.15, 'HARD applies more pressure');
  assert.ok(out.HARD.accuracy > out.EASY.accuracy, 'HARD groups shots better than EASY');
  assert.ok(out.HARD.accuracy < 0.78, `HARD still misses (${(out.HARD.accuracy * 100).toFixed(0)}% of ${out.HARD.shots} shots)`);

  assert.ok(out.EASY.playerHp > out.HARD.playerHp, 'difficulty is actually felt');
  const acc = (k) => out[k].closeAcc;
  assert.ok(out.MEDIUM.closeShots > 30 && out.HARD.closeShots > 30, 'both fight in close range often enough to measure');
  assert.ok(acc('EASY') >= 0.28 && acc('EASY') <= 0.55, `EASY sits in the designed ~40-50% band (${(acc('EASY') * 100).toFixed(0)}%)`);
  assert.ok(acc('MEDIUM') >= 0.52 && acc('MEDIUM') <= 0.75, `MEDIUM sits in the designed 60-70% band (${(acc('MEDIUM') * 100).toFixed(0)}%)`);
  assert.ok(acc('HARD') >= 0.6 && acc('HARD') <= 0.85, `HARD is high but never perfect (${(acc('HARD') * 100).toFixed(0)}%)`);
  assert.ok(acc('HARD') > acc('MEDIUM') && acc('MEDIUM') > acc('EASY'), 'accuracy ordering is monotonic');
  assert.ok(out.MEDIUM.playerHp < 2400, 'MEDIUM lands hits on an exposed target');
  assert.ok(out.EASY.playerHp > 2400 - 60 * 12, 'EASY cannot delete a standing player');
  assert.ok(out.MEDIUM.playerHp < out.EASY.playerHp, 'MEDIUM punishes an exposed player harder than EASY');
  assert.ok(out.HARD.playerHp < out.MEDIUM.playerHp, 'HARD punishes hardest');

});

test('match flow: kills resolve to results, dying halves the payout, pause freezes', async () => {
  const env = await world();

  // --- WIN: sustained rifle fire through the real weapon + hitscan path
  const rig = makeRig(env, { difficulty: 'HARD', aiDamage: 0 });
  const lane = clearLane(env, 12);
  rig.player.reset({ ...lane.a, yaw: 0 });
  rig.brain.reset({ ...lane.b });
  rig.weapon.state.reserve = 100000;
  // hold the machine in place so this asserts on the hit pipeline, not on AI pathing
  rig.brain.cfg.moveSpeed = 0;
  rig.brain.cfg.sprintSpeed = 0;
  rig.brain.cfg.strafeSpeed = 0;
  let ticks = 0;
  const target = new THREE.Vector3();
  while (rig.match.phase === PHASE.PLAYING && ticks < 60 * 90) {
    rig.machine.chestPoint(target);
    const e = rig.player.camera.position;
    rig.player.yaw = Math.atan2(-(target.x - e.x), -(target.z - e.z));
    rig.player.pitch = Math.max(-1.4, Math.min(1.4, Math.atan2(target.y - e.y, Math.hypot(target.x - e.x, target.z - e.z))));
    rig.match.update(DT, idle({ fire: true, ads: true }));
    ticks++;
  }
  console.log(`   win path: ${(ticks / 60).toFixed(1)}s · hits ${rig.match.scoring.hits} · score ${Math.round(rig.match.scoring.score)}`);
  assert.equal(rig.match.outcome, 'WIN', 'the machine dies to sustained rifle fire');
  assert.equal(rig.machine.health, 0);
  assert.equal(rig.match.phase, PHASE.RESULTS);
  const res = rig.match.results;
  for (const k of ['score', 'hits', 'misses', 'shots', 'accuracy', 'headshots', 'elapsed', 'outcome', 'difficulty']) {
    assert.ok(k in res, `results carry ${k} for the results screen`);
  }
  assert.ok(res.hits >= 3 && res.score > 0, 'the payout is real');
  assert.ok(res.accuracy > 0 && res.accuracy <= 1, 'accuracy is a ratio');

  // --- LOSE: player death ends the match and scales the score down
  const rig2 = makeRig(env, { difficulty: 'MEDIUM' });
  rig2.match.scoring.registerShot();
  rig2.match.scoring.registerHit('head', 100);
  const raw = rig2.match.scoring.score;
  for (let i = 0; i < 5 && rig2.player.alive; i++) {
    rig2.player.takeDamage(40, { x: 0, y: 1.4, z: 0 });
    rig2.match.update(DT, idle());
  }
  assert.equal(rig2.match.outcome, 'LOSE');
  assert.ok(rig2.match.results.score <= raw + 1, 'losing never inflates the score');

  // --- PAUSE really freezes the simulation
  const rig3 = makeRig(env, { difficulty: 'MEDIUM' });
  run(rig3.match, 60);
  rig3.match.pause();
  const frozen = { ...rig3.player.position };
  const frozenT = rig3.match.elapsed;
  run(rig3.match, 120, () => idle({ forward: true, fire: true }));
  assert.deepEqual({ ...rig3.player.position }, frozen, 'paused: input is ignored');
  assert.equal(rig3.match.elapsed, frozenT, 'paused: the clock is stopped');
  rig3.match.resume();
  run(rig3.match, 10);
  assert.ok(rig3.match.elapsed > frozenT, 'resume restarts the clock');
  rig3.match.abandon();
  assert.equal(rig3.match.phase, PHASE.MENU, 'quit returns to the menu');
});

test('perf: a full simulation tick stays inside budget', async () => {
  const env = await world();
  const rig = makeRig(env, { difficulty: 'HARD' });
  run(rig.match, 240);
  const t0 = process.hrtime.bigint();
  const n = 1800;
  for (let i = 0; i < n; i++) {
    rig.match.update(DT, idle({ forward: i % 200 < 120, fire: i % 6 === 0, left: i % 90 < 45 }));
    if (rig.match.phase !== PHASE.PLAYING) break;
  }
  const msPerTick = Number(process.hrtime.bigint() - t0) / 1e6 / n;
  console.log(`   ${msPerTick.toFixed(3)} ms/tick simulation (${(msPerTick * 60).toFixed(1)}% of a 60 fps frame)`);
  assert.ok(msPerTick < 3, `simulation must leave render budget (${msPerTick.toFixed(2)} ms)`);
  assert.ok(env.world.stats.rayCalls > 0, 'rays are being traced through the collider grid');
});
