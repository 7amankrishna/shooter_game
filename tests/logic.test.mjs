/**
 * Logic tests: math, config invariants, physics, terrain, world layout,
 * zombies, economy, day/night and weather — everything that doesn't need the
 * full Survival loop (sim.test.mjs covers that).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { installDomStub } from './stubDom.js';

installDomStub();

const { makeMaterials } = await import('../src/core/Textures.js');
const {
  WORLD, PLAYER, WEAPONS, WEAPON_ORDER, ZOMBIE_TYPES, ZOMBIES, ECONOMY, TOWERS, DAYNIGHT, WEATHER,
} = await import('../src/config/GameConfig.js');
const { World, chunkLayout, towerForCell } = await import('../src/world/World.js');
const { WorldTerrain, buildChunkGeometry } = await import('../src/physics/Heightfield.js');
const { ColliderWorld } = await import('../src/physics/ColliderWorld.js');
const { makeRng, valueNoise, fbm, angleDelta, clamp, coordsRng } = await import('../src/core/math.js');
const { Zombie } = await import('../src/zombies/Zombie.js');
const { ZombieManager } = await import('../src/zombies/ZombieManager.js');
const { DayNight } = await import('../src/game/DayNight.js');
const { Weather } = await import('../src/game/Weather.js');
const { Economy } = await import('../src/game/Economy.js');
const { Loadout } = await import('../src/weapons/Loadout.js');
const { RainField } = await import('../src/core/RainField.js');

const DT = 1 / 60;

/* ----------------------------------------------------------------- math */

test('math: integer hash noise is deterministic, bounded and seed-stable', () => {
  assert.equal(valueNoise(3.5, -2.25), valueNoise(3.5, -2.25), 'same input, same output');
  for (let i = 0; i < 500; i++) {
    const v = valueNoise(i * 0.37, i * -1.11);
    assert.ok(v >= -1.001 && v <= 1.001, `noise in bounds: ${v}`);
    assert.ok(Number.isFinite(fbm(i * 0.13, i * 0.29, 4)), 'fbm finite');
  }
  const r1 = makeRng(1337);
  const r2 = makeRng(1337);
  for (let i = 0; i < 8; i++) assert.equal(r1(), r2(), 'seeded rng streams match');
  const c1 = coordsRng(99, 4, -6);
  const c2 = coordsRng(99, 4, -6);
  assert.equal(c1(), c2(), 'per-chunk rng is deterministic');
});

test('math: angleDelta wraps to the shortest signed path', () => {
  assert.ok(Math.abs(angleDelta(Math.PI * 1.9, -Math.PI * 1.9)) < 0.7);
  assert.ok(angleDelta(0.5, 0.1) > 0);
  assert.ok(angleDelta(0.1, 0.5) < 0);
  assert.equal(angleDelta(1, 1), 0);
});

/* --------------------------------------------------------------- config */

test('config: three weapons with model, sound and balancing keys', () => {
  assert.deepEqual(WEAPON_ORDER, ['sidearm', 'rifle', 'marksman']);
  for (const key of WEAPON_ORDER) {
    const w = WEAPONS[key];
    assert.ok(w.model, `${key} has a viewmodel`);
    assert.ok(w.sound, `${key} has a sound cue`);
    assert.ok(w.magSize > 0 && w.rpm > 0 && w.damage > 0, `${key} core stats`);
    assert.ok(w.reserveStart <= w.reserveMax, `${key} reserve bounds`);
    assert.ok(w.hipSpread > w.adsSpread, `${key} ADS tightens spread`);
  }
  assert.ok(WEAPONS.marksman.adsFov < 20, 'marksman is scoped');
});

test('config: five zombie types with complete stat blocks', () => {
  const need = ['id', 'label', 'health', 'speed', 'sprintSpeed', 'damage', 'attackRange', 'attackWindup',
    'attackCooldown', 'viewRange', 'fovDeg', 'acquireTime', 'hearing', 'aggression', 'poise',
    'coins', 'weight', 'colors', 'scale'];
  for (const [key, z] of Object.entries(ZOMBIE_TYPES)) {
    for (const k of need) assert.ok(z[k] !== undefined, `${key}.${k}`);
    assert.ok(Array.isArray(z.coins) && z.coins[0] <= z.coins[1], `${key} coin range`);
    assert.ok(z.weight.base > 0 && z.weight.night > 0, `${key} weights positive`);
  }
  assert.equal(Object.keys(ZOMBIE_TYPES).length, 5);
  const nightHeavier = Object.values(ZOMBIE_TYPES).filter((z) => z.weight.night > z.weight.base);
  assert.ok(nightHeavier.length >= 1, 'some types thicken at night');
  for (const k of ['spawnNear', 'spawnFar', 'despawn', 'towerExclusion', 'noiseGunshot']) {
    assert.ok(ZOMBIES[k] > 0, `ZOMBIES.${k}`);
  }
  assert.ok(ZOMBIES.spawnNear > ZOMBIES.towerExclusion, 'spawn annulus starts outside tower zones');
});

test('config: crate loot tables roll valid items with sane chances', () => {
  for (const crate of Object.values(ECONOMY.crates)) {
    assert.ok(crate.cost > 0, `${crate.id} costs something`);
    assert.ok(crate.rolls.length >= 2, `${crate.id} has variety`);
    for (const r of crate.rolls) {
      assert.ok(r.chance > 0 && r.chance <= 1, `${crate.id}.${r.item} chance`);
      assert.ok(r.amount[0] <= r.amount[1], `${crate.id}.${r.item} amount range`);
    }
  }
  assert.ok(ECONOMY.crates.basic.cost < ECONOMY.crates.premium.cost, 'premium costs more');
});

/* ---------------------------------------------------------------- world */

test('terrain: heights are pure, bounded and pads actually flatten', () => {
  const t = new WorldTerrain({ seed: 20260917 });
  for (const [x, z] of [[0, 0], [120, -80], [-333, 512], [77, 77]]) {
    assert.equal(t.heightAt(x, z), t.heightAt(x, z), 'pure');
    assert.ok(Number.isFinite(t.heightAt(x, z)), 'finite');
    const b = t.biomeAt(x, z);
    for (const k of ['forest', 'field', 'rocky', 'dead']) {
      assert.ok(b[k] >= 0 && b[k] <= 1, `biome channel ${k} in [0,1]`);
    }
  }
  // the spawn clearing is actually flat
  const h0 = t.heightAt(0, 0);
  for (let r = 1; r <= 6; r += 1) {
    assert.ok(Math.abs(t.heightAt(r, 0) - h0) < 0.35, `clearing flat at r=${r}`);
  }
});

test('terrain: chunk geometry has no NaN heights, normals or colours', () => {
  const t = new WorldTerrain({ seed: 20260917 });
  for (const [cx, cz] of [[0, 0], [2, -3], [-4, 1]]) {
    const geo = buildChunkGeometry(THREE, t, cx, cz, WORLD.chunkSize, WORLD.chunkSegments);
    for (const attr of ['position', 'normal', 'color']) {
      const a = geo.attributes[attr].array;
      for (let i = 0; i < a.length; i++) {
        assert.ok(Number.isFinite(a[i]), `${attr}[${i}] finite at chunk ${cx},${cz}`);
      }
    }
    geo.dispose();
  }
});

test('colliders: ray hits boxes, skips tags, terrain blocks, owners clean up', () => {
  const col = new ColliderWorld({ terrain: () => 0 });
  col.addBox(0, 1, -5, 2, 2, 2, 'crate', { owner: 'test:1' });
  col.addBox(0, 1, -6, 2, 2, 2, 'fence', { owner: 'test:2' });
  const hit = col.raycast({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 50, {});
  assert.ok(hit && hit.dist > 3 && hit.dist < 5, 'box hit at expected range');
  const skipped = col.raycast({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 50, { skipTags: ['fence'] });
  assert.equal(skipped.box.tag, 'crate', 'fence skipped, crate hit');
  col.removeByOwner('test:1');
  col.removeByOwner('test:2');
  const gone = col.raycast({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 50, {});
  assert.equal(gone, null, 'owner removal cleans the grid');
});

test('colliders: moveBody lands on tops, steps ledges, never launches', () => {
  const col = new ColliderWorld({ terrain: (x, z) => Math.sin(x * 0.05) * 2 });
  // a steppable crate (top at 0.5, under the 0.62 step height) and, behind
  // it, an unclimbable wall
  col.addBox(0, 0.25, -10, 4, 0.5, 4, 'crate', { owner: 't:1' });
  col.addBox(0, 3, -16, 6, 6, 1, 'wall', { owner: 't:2' });
  const pos = new THREE.Vector3(0, 5, 0);
  const vel = new THREE.Vector3(0, 0, 0);
  let grounded = false;
  let hitWall = false;
  let onCrate = false;
  for (let i = 0; i < 300; i++) {
    vel.y += WORLD.gravity * DT;
    vel.z = -4; // walk onto the crate, across it, then into the wall
    const r = col.moveBody(pos, vel, DT, { radius: 0.4, height: 1.8, stepHeight: 0.62, grounded, snapDown: PLAYER.snapDown, climbRate: PLAYER.slopeClimbRate });
    grounded = r.grounded;
    if (r.grounded) vel.y = 0;
    if (r.hitWall) hitWall = true;
    if (r.grounded && pos.z > -12.2 && pos.z < -7.8 && Math.abs(pos.y - 0.5) < 0.15) onCrate = true;
    assert.ok(Number.isFinite(pos.x + pos.y + pos.z), `frame ${i}: position finite`);
    assert.ok(pos.y < 12, `frame ${i}: no launch (y=${pos.y})`);
  }
  assert.ok(grounded, 'settled');
  assert.ok(onCrate, 'walked up and over the low crate (step-up, not a teleport)');
  assert.ok(hitWall, 'the tall wall actually blocked the walk');
  assert.ok(pos.z > -15.4, `wall stopped the body at z=${pos.z.toFixed(2)} (wall face at -15.5)`);
});

test('world: chunk layout and towers are deterministic and towers avoid roads', () => {
  for (const [cx, cz] of [[0, 0], [3, -7], [-12, 5]]) {
    const a = chunkLayout(20260917, cx, cz);
    const b = chunkLayout(20260917, cx, cz);
    assert.deepEqual(a, b, `layout ${cx},${cz} deterministic`);
    assert.deepEqual(chunkLayout(999, cx, cz), chunkLayout(999, cx, cz), 'other seed deterministic');
  }
  // several tower cells produce towers; none sits on the road
  let found = 0;
  for (let tx = -3; tx <= 3; tx++) {
    for (let tz = -3; tz <= 3; tz++) {
      const t = towerForCell(20260917, tx, tz);
      if (!t) continue;
      found++;
      const roadZ = 55 * Math.sin(0.006 * t.x) + 22 * Math.sin(0.0173 * t.x + 2.1);
      assert.ok(Math.abs(t.z - roadZ) > 14, `tower ${tx},${tz} clear of the road`);
    }
  }
  assert.ok(found >= 3, `expected several towers in a 7×7 cell grid, got ${found}`);
});

test('world: every material a streamed chunk uses exists in the library', async () => {
  // A missing key does not throw: new THREE.Mesh(geo, undefined) quietly uses
  // three.js' default white unlit material (the white trees/grass bug). Build
  // through a strict view of the library so an unknown key fails here.
  const library = makeMaterials();
  const strict = new Proxy(library, {
    get(target, key) {
      if (typeof key === 'string' && !(key in target)) throw new Error(`material "${key}" is not defined in makeMaterials()`);
      return target[key];
    },
  });
  const world = new World({ materials: strict, seed: 20260917 });
  await world.build();
  assert.ok(world.towers.size > 0, 'the starting window includes a watchtower (lamp material)');
  const meshes = new Set();
  world.group.traverse((o) => { if (o.isMesh) meshes.add(o.name); });
  assert.ok(meshes.has('organic') && meshes.has('grass'), 'vegetation and grass meshes were built');
  world.dispose();
});

test('textures: every material map wraps a drawable image, never another texture', () => {
  // getTexture() used to wrap the already-built bloodsplat CanvasTexture in a
  // second CanvasTexture; WebGL rejected its upload (texSubImage2D overload).
  let maps = 0;
  for (const [name, material] of Object.entries(makeMaterials())) {
    if (!material.map) continue;
    maps++;
    assert.ok(material.map.image && !material.map.image.isTexture, `${name}.map.image should be a canvas, not a Texture`);
  }
  assert.ok(maps >= 10, `expected the textured materials to be checked, got ${maps}`);
});

/* -------------------------------------------------------------- zombies */

test('zombies: damage regions stagger, kill and pay out through the manager', () => {
  const world = { world: new ColliderWorld({ terrain: () => 0 }), ground: () => 0, terrain: { slopeAt: () => 0 } };
  const kills = [];
  const mgr = new ZombieManager({ world, onZombieKilled: (z, info) => kills.push({ z, info }), seed: 42 });
  const z = mgr.spawnOne({ position: { x: 0, y: 0, z: 0 } }, null, { at: { x: 0, y: 0, z: 0 }, type: 'walker' });
  assert.ok(z, 'spawned');
  const r1 = mgr.damageZombie(z, 10, 'limb', new THREE.Vector3(0, 0.6, 0), { x: 0, y: 0, z: -1 });
  assert.equal(r1.killed, false, '10 damage does not kill a walker');
  assert.equal(kills.length, 0, 'no kill yet');
  const r2 = mgr.damageZombie(z, 500, 'head', new THREE.Vector3(0, 1.5, 0), { x: 0, y: 0, z: -1 });
  assert.equal(r2.killed, true, 'headshot kills');
  assert.equal(kills.length, 1);
  assert.equal(kills[0].info.headshot, true, 'headshot flagged');
  assert.equal(kills[0].info.type, 'walker');
  const r3 = mgr.damageZombie(z, 50, 'chest');
  assert.equal(r3.killed, false, 'dead zombies take no further damage');
});

test('zombies: corpse lingers then recycles to the pool', () => {
  const world = { world: new ColliderWorld({ terrain: () => 0 }), ground: () => 0, terrain: { slopeAt: () => 0 }, nearestTower: () => null };
  const mgr = new ZombieManager({ world, seed: 42 });
  const z = mgr.spawnOne({ position: { x: 0, y: 0, z: 0 } }, null, { at: { x: 0, y: 0, z: 0 }, type: 'crawler' });
  assert.ok(z, 'spawned');
  z.kill({ x: 0, z: 1 });
  assert.ok(!z.alive && z.active, 'corpse present');
  const player = { position: { x: 0, y: 0, z: 0 }, crouching: false, inTower: false };
  for (let f = 0; f < Math.ceil((ZOMBIES.corpseTTL + 3) * 60); f++) {
    mgr.update(DT, { player, night: false, weatherFog: 1, cameraForward: { x: 0, z: 1 } });
  }
  assert.ok(!z.active || z.alive, 'corpse released after TTL (parked or pool-reused)');
});

/* ------------------------------------------------- day/night and weather */

test('dayNight: one day cycles phases and night is dark but defined', () => {
  const dn = new DayNight({ startPhase: 0 });
  const phases = [];
  let night = false;
  for (let f = 0; f < 60 * DAYNIGHT.dayLength + 10; f++) {
    const o = dn.update(DT);
    if (o.isNight) night = true;
    if (phases[phases.length - 1] !== o.phase) phases.push(o.phase);
    assert.ok(o.nightFactor >= 0 && o.nightFactor <= 1, 'nightFactor in range');
    assert.ok(o.sunIntensity > 0.05, 'moonlight keeps night defined');
    assert.ok(o.exposure > 0.2, 'exposure stays in a renderable range');
  }
  assert.ok(night, 'night happens');
  assert.ok(phases.includes('NIGHT'), `phases seen: ${phases.join(',')}`);
  assert.match(dn.clockLabel(), /^\d{2}:\d{2}$/, 'clock label format');
});

test('weather: transitions stay in family and outputs blend continuously', () => {
  const w = new Weather({ seed: 7 });
  const states = Object.keys(WEATHER.states);
  for (const from of states) {
    const row = WEATHER.chances[from];
    const sum = Object.values(row).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 0.02, `${from} row sums to ~1 (${sum.toFixed(2)})`);
    for (const to of Object.keys(row)) assert.ok(states.includes(to), `${from}→${to} valid`);
  }
  let prevFar = null;
  for (let f = 0; f < 60 * 400; f++) {
    const o = w.update(DT, { nightFactor: 0.3 });
    assert.ok(Number.isFinite(o.fogFar + o.dim + o.rain), 'outputs finite');
    if (prevFar !== null) assert.ok(Math.abs(o.fogFar - prevFar) < 30, 'fog blends, never snaps');
    prevFar = o.fogFar;
  }
  w.setState('STORM');
  for (let f = 0; f < 60 * WEATHER.transitionTime + 5; f++) w.update(DT, {});
  assert.equal(Math.round(w.out.rain), 1, 'pinned storm rains');
});

/* --------------------------------------------------------------- economy */

test('economy: buys gate on coins, drops land, loot rolls stay in the tables', () => {
  const col = new ColliderWorld({ terrain: () => 0 });
  const world = {
    world: col, ground: () => 0, terrain: { slopeAt: () => 0 },
    probeCylinder: () => true, nearestTower: () => null,
  };
  // Economy uses world.world.probeCylinder + world.nearestTower
  world.world = col;
  const loot = [];
  const eco = new Economy({ materials: makeMaterials(), world, onLoot: (i, a) => loot.push([i, a]), seed: 11 });
  eco.coins = 50;
  assert.equal(eco.buy('basic').ok, false, 'too poor');
  eco.coins = 500;
  const r = eco.buy('weapon');
  assert.equal(r.ok, true);
  assert.ok(eco.coins < 500, 'coins spent');
  assert.equal(eco.buy('basic').ok, true, 'second concurrent drop allowed');
  for (let f = 0; f < 60 * 30; f++) eco.update(DT, { x: 0, y: 0, z: 0 });
  const drop = eco.drops.find((d) => d.landed);
  assert.ok(drop, 'crate landed');
  const grants = eco.openCrate(eco.crateNear({ x: drop.x, y: 0, z: drop.z }));
  assert.ok(grants.length >= 1, 'crate yields loot');
  const valid = new Set(Object.values(ECONOMY.crates).flatMap((c) => c.rolls.map((r2) => r2.item)));
  for (const [item] of loot) assert.ok(valid.has(item), `loot item ${item} is from a table`);
  eco.dispose();
});

/* --------------------------------------------------------------- weapons */

test('loadout: switching cancels reloads and ammo routes to the right pool', () => {
  const audio = { play: () => {} };
  const fx = { muzzleFlash: () => {}, eject: () => {}, tracer: () => {} };
  const lo = new Loadout({ audio, fx, materials: makeMaterials(), kick: () => {} });
  assert.equal(lo.currentKey, 'rifle');
  lo.current.state.mag = 0;
  lo.startReload();
  assert.ok(lo.current.state.reloading, 'reloading');
  assert.equal(lo.selectSlot(1), true, 'switch accepted');
  assert.equal(lo.current.state.reloading, false, 'switch cancelled the reload');
  const before = lo.weapons.rifle.state.reserve;
  lo.addAmmo('ammo', 40);
  assert.equal(lo.weapons.rifle.state.reserve, before + 40, 'ammo feeds the rifle');
  const mBefore = lo.weapons.marksman.state.reserve;
  lo.addAmmo('ammoBig', 20);
  assert.equal(lo.weapons.marksman.state.reserve, mBefore + 20, 'heavy ammo feeds the marksman');
  const ser = lo.serialize();
  lo.reset();
  lo.restore(ser);
  assert.equal(lo.weapons.rifle.state.reserve, before + 40, 'serialize/restore round-trips');
});

test('loadout: respects reserve caps', () => {
  const audio = { play: () => {} };
  const fx = { muzzleFlash: () => {}, eject: () => {}, tracer: () => {} };
  const lo = new Loadout({ audio, fx, materials: makeMaterials(), kick: () => {} });
  lo.addAmmo('ammo', 10000);
  assert.ok(lo.weapons.rifle.state.reserve <= lo.weapons.rifle.def.reserveMax, 'rifle capped');
  assert.ok(lo.weapons.sidearm.state.reserve <= lo.weapons.sidearm.def.reserveMax, 'sidearm capped');
});

/* ---------------------------------------------------------------- rain */

test('rainField: intensity scales the draw range and drops stay finite', async () => {
  const rain = new RainField({ seed: 5 });
  const cam = { x: 10, y: 2, z: -7 };
  const steps = [
    [0, 0], [0.5, 0.1], [1, 0.5], [0.8, 2.0], // intensity, dt
  ];
  for (const [intensity, dt] of steps) {
    for (let f = 0; f < 300; f++) rain.update(dt, cam, intensity, { x: 0.4, z: -0.2 });
    const want = intensity > 0.03 ? Math.round(Math.min(1, intensity) * 900) : 0;
    assert.equal(rain.visibleCount, want, `draw range tracks intensity ${intensity}`);
    assert.equal(rain.mesh.visible, want > 0);
    const a = rain.posAttr.array;
    for (let i = 0; i < want * 6; i++) assert.ok(Number.isFinite(a[i]), `vertex ${i} finite`);
    // streaks slant with the wind, not straight down
    if (want > 0) assert.ok(Math.abs(a[3] - a[0]) > 1e-4, 'wind slants the streak');
  }
  // the camera can run; drops wrap back into the field box
  for (let f = 0; f < 600; f++) rain.update(1 / 60, { x: cam.x + f * 0.2, y: cam.y, z: cam.z }, 1, { x: 1, z: 0 });
  for (let i = 0; i < rain.count; i++) {
    assert.ok(Math.abs(rain.px[i] - (cam.x + 599 * 0.2)) <= 34 * 1.4 + 1, `drop ${i} wrapped with the camera`);
  }
  rain.dispose();
});

/* -------------------------------------------------------------- towers */

test('towers: config keeps the safe zone honest', () => {
  assert.ok(TOWERS.enterRadius > 2, 'generous enter radius');
  assert.ok(TOWERS.regenPerSecond > 0 && TOWERS.regenPerSecond <= 8, 'regen is slow, not god-mode');
  assert.ok(TOWERS.transitionTime < 2, 'climb transition is brisk');
});
