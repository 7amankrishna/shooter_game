/**
 * Unit tests for the pure gameplay logic (no renderer, no DOM).
 * Run with: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { Scoring } from '../src/game/Scoring.js';
import { ColliderWorld } from '../src/physics/ColliderWorld.js';
import { NavGrid } from '../src/world/NavGrid.js';
import { createTerrain, buildTerrainGeometry } from '../src/physics/Heightfield.js';
import { BODY, SCORING as SCORE_CFG } from '../src/config/GameConfig.js';
import { DIFFICULTIES, DIFFICULTY_ORDER } from '../src/config/DifficultyConfig.js';
import { angleDelta, clamp } from '../src/core/math.js';

void THREE;

test('scoring: headshots outrank body hits and combo tiers apply', () => {
  const s = new Scoring();
  s.registerShot();
  const chest = s.registerHit('chest', BODY.chest.points);
  assert.equal(chest.points, 50, 'first hit has no multiplier');
  for (let i = 0; i < 3; i++) {
    s.registerShot();
    s.registerHit('chest', BODY.chest.points);
  }
  assert.ok(s.multiplier >= 1.5, 'streak of 4 should raise the multiplier');
  s.registerShot();
  const head = s.registerHit('head', BODY.head.points);
  assert.ok(head.points > 100, 'headshot during a combo must beat a bare headshot');
  assert.equal(s.headshots, 1);
});

test('scoring: a miss keeps the combo only inside the grace window', () => {
  const s = new Scoring();
  s.registerHit('chest', 50);
  s.registerHit('chest', 50);
  assert.equal(s.streak, 2);
  s.registerMiss();
  s.update(SCORE_CFG.comboGrace * 0.5);
  assert.equal(s.streak, 2, 'still alive inside the grace window');
  s.registerHit('leg', 20);
  assert.equal(s.streak, 3, 'the hit inside the window extends the streak');
  s.registerMiss();
  s.update(SCORE_CFG.comboGrace + 0.1);
  assert.equal(s.streak, 0, 'expired grace resets the combo');
  assert.equal(s.multiplier, 1);
});

test('scoring: accuracy bonus is monotonic and requires volume', () => {
  const s = new Scoring();
  for (let i = 0; i < 4; i++) {
    s.registerShot();
    s.registerHit('chest', 50);
  }
  assert.equal(s.accuracyBonusAwarded, 0, 'below the minimum shot count');
  for (let i = 0; i < 10; i++) {
    s.registerShot();
    s.registerHit('chest', 50);
  }
  assert.ok(s.accuracyBonusAwarded >= 1, 'perfect accuracy past the threshold pays out');
  const before = s.score;
  s.registerHit('chest', 50);
  assert.ok(s.score > before);
});

test('scoring: kill payout + summary shape for the results screen', () => {
  const s = new Scoring();
  s.registerShot();
  s.registerHit('head', 100);
  const kill = s.applyKill({ headshotKill: true, elapsedSeconds: 60 });
  assert.ok(kill.points >= SCORE_CFG.killBonus + SCORE_CFG.headshotKillBonus);
  const sum = s.summary(60, 'WIN');
  for (const k of ['score', 'hits', 'misses', 'accuracy', 'headshots', 'elapsed']) assert.ok(k in sum, k);
  assert.equal(sum.outcome, 'WIN');
});

test('colliders: ray hits, misses and respects tag skipping', () => {
  const world = new ColliderWorld({ halfSize: 50, terrain: () => 0 });
  world.addBox(0, 1, -10, 4, 2, 0.5, 'structure');
  world.addBox(0, 1, -5, 2, 2, 0.2, 'fence');
  const origin = { x: 0, y: 1, z: 0 };
  const hit = world.raycast(origin, { x: 0, y: 0, z: -1 }, 40);
  assert.ok(hit, 'first blocker is the fence');
  assert.ok(Math.abs(hit.dist - 4.9) < 0.01, `fence distance ${hit.dist}`);
  const wall = world.raycast(origin, { x: 0, y: 0, z: -1 }, 40, { skipTags: ['fence'] });
  assert.ok(wall, 'skipping the fence exposes the wall');
  assert.ok(Math.abs(wall.dist - 9.75) < 0.01, `wall distance ${wall.dist}`);
  assert.equal(wall.surface, 'concrete');
  const through = world.raycast(origin, { x: 0, y: 0, z: -1 }, 40, { skipTags: ['fence', 'structure'] });
  assert.equal(through, null, 'skipping both tags lets bullets pass');
  assert.ok(Math.abs(wall.normal.z - 1) < 1e-6, 'impact normal faces the shooter');
  const miss = world.raycast(origin, { x: 1, y: 0, z: 0 }, 40);
  assert.equal(miss, null);
  assert.ok(world.hasLineOfSight({ x: 0, y: 4.5, z: 0 }, { x: 0, y: 4.5, z: -30 }), 'over the wall is clear');
  assert.equal(world.hasLineOfSight({ x: 0, y: 1, z: -2 }, { x: 0, y: 1, z: -20 }), false, 'wall blocks sight');
});

test('colliders: terrain blocks both shots and sight lines', () => {
  const world = new ColliderWorld({ halfSize: 60, terrain: (x, z) => (Math.abs(x) < 6 && z < -10 ? 4 : 0) });
  const shot = world.raycastWithTerrain({ x: 0, y: 1.6, z: 0 }, { x: 0, y: 0, z: -1 }, 60);
  assert.ok(shot, 'ridge should stop a flat shot');
  assert.equal(shot.box, null, 'and it should register as a terrain hit');
  assert.ok(shot.dist > 9 && shot.dist < 12, `terrain hit distance ${shot.dist}`);
});

test('colliders: body sweep lands on box tops, steps up ledges and slides on walls', () => {
  const opts = { radius: 0.4, height: 1.8, stepHeight: 0.62 };
  const world = new ColliderWorld({ halfSize: 40, terrain: () => 0 });
  world.addBox(0, 0.25, -3, 3, 0.5, 3, 'crate');
  const pos = { x: 0, y: 0, z: 0 };
  world.moveBody(pos, { x: 0, y: 0, z: -4 }, 0.25, opts);
  world.moveBody(pos, { x: 0, y: 0, z: -4 }, 0.25, opts);
  assert.ok(pos.y >= 0.49 && pos.y <= 0.51, `stepped up onto the crate (y=${pos.y})`);

  world.addBox(0, 1.5, -9, 3, 3, 1, 'wall');
  // the caller owns gravity (as PlayerController does), so feed it here
  let vy = 0;
  for (let i = 0; i < 60; i++) {
    vy -= 24 * 0.05;
    const r = world.moveBody(pos, { x: 0, y: vy, z: -4 }, 0.05, opts);
    if (r.grounded) { vy = 0; }
  }
  // wall face is z=-8.5, body radius 0.4 → it must stop ~one radius short
  assert.ok(pos.z <= -7.85 && pos.z >= -8.15, `stopped one radius off the wall (z=${pos.z})`);
  assert.ok(Math.abs(pos.y) < 0.05, `walked off the crate back to the ground (y=${pos.y})`);

  // pressing diagonally into a long wall must keep the lateral component (slide)
  world.addBox(0, 1.5, -20, 60, 3, 1, 'structure');
  const slide = { x: 0, y: 0, z: -18.4 };
  let sy = 0;
  for (let i = 0; i < 40; i++) {
    sy -= 24 * 0.05;
    if (world.moveBody(slide, { x: 3.5, y: sy, z: -2 }, 0.05, opts).grounded) sy = 0;
  }
  assert.ok(slide.x > 5, `wall sliding kept lateral motion (x=${slide.x})`);
  assert.ok(slide.z > -19.2 && slide.z < -18.9, `and never passed through (z=${slide.z})`);

  // a ledge taller than stepHeight is a wall, not a stair
  const ledge = new ColliderWorld({ halfSize: 40, terrain: () => 0 });
  ledge.addBox(0, 1, -3, 6, 2, 4, 'crate');
  const p2 = { x: 0, y: 0, z: 0 };
  let gy = 0;
  for (let i = 0; i < 40; i++) {
    gy -= 24 * 0.05;
    if (ledge.moveBody(p2, { x: 0, y: gy, z: -4 }, 0.05, opts).grounded) gy = 0;
  }
  assert.equal(p2.y, 0, 'no teleporting up a 2 m box');
  assert.ok(p2.z > -0.75 && p2.z < -0.5, `blocked at the leading edge (z=${p2.z})`);
});

test('navmesh: paths around a blocking structure and marks it non-walkable', () => {
  const world = new ColliderWorld({ halfSize: 30, terrain: () => 0 });
  world.addBox(0, 1, 0, 24, 2, 3, 'structure'); // a wall across the middle
  const nav = new NavGrid({ world, halfSize: 28, cell: 1, agentRadius: 0.5, agentHeight: 1.8 }).bake();
  const st = nav.stats();
  assert.ok(st.walkable > st.cells * 0.7, `${st.walkable}/${st.cells} cells walkable`);
  assert.ok(st.walkable < st.cells - 40, 'the wall removed cells');
  const from = nav.toCell(-10, -8);
  const to = nav.toCell(-10, 8);
  assert.ok(nav.walkable(from) && nav.walkable(to));
  const path = nav.findPath(from, to);
  assert.ok(path && path.length > 3, 'must find a way around the wall');
  for (const p of path) {
    const cell = nav.toCell(p.x, p.z);
    assert.equal(nav.blocked[cell], 0, 'path stays on walkable cells');
  }
});

test('terrain: height function is pure, bounded and flattens building pads', () => {
  const h1 = createTerrain([]);
  const h2 = createTerrain([]);
  for (const [x, z] of [[0, 0], [-41.3, 12.7], [88, -77], [-5, -95]]) {
    assert.equal(h1(x, z), h2(x, z), 'deterministic');
    assert.ok(Number.isFinite(h1(x, z)));
    assert.ok(Math.abs(h1(x, z)) < 40);
  }
  const withPad = createTerrain([{ x: 20, z: 20, w: 20, d: 20, y: 1.5, pad: 2 }]);
  assert.ok(Math.abs(withPad(20, 20) - 1.5) < 0.02, 'pad centre sits exactly at the level');
  const geo = buildTerrainGeometry(THREE, withPad);
  assert.ok(geo.attributes.position.count > 1000);
  assert.ok(geo.attributes.color.count === geo.attributes.position.count);
  geo.dispose();
});

test('difficulty presets: three tiers, monotonic skill, none of them an aimbot', () => {
  assert.deepEqual(DIFFICULTY_ORDER, ['EASY', 'MEDIUM', 'HARD']);
  const [e, m, h] = DIFFICULTY_ORDER.map((k) => DIFFICULTIES[k]);
  assert.ok(e.reaction[0] > m.reaction[0] && m.reaction[0] > h.reaction[0], 'reaction time improves');
  assert.ok(e.aimErrorDeg > m.aimErrorDeg && m.aimErrorDeg > h.aimErrorDeg, 'grouping tightens');
  assert.ok(h.coverChance > m.coverChance && m.coverChance > e.coverChance, 'cover use scales');
  assert.ok(h.flankChance > e.flankChance, 'flanking scales');
  // the HARD fairness contract from the design brief
  assert.ok(h.reaction[1] >= 0.2, 'still has a reaction delay');
  assert.ok(h.aimErrorDeg > 0.4, 'still misses');
  assert.ok(h.intentionalMiss > 0, 'still throws shots');
  assert.ok(h.magSize > 0 && h.reloadTime > 1.5, 'limited ammo + reload time');
  assert.ok(h.moveSpeed < 6.5, 'human-like movement speed');
});

test('math helpers: angle wrapping and clamps', () => {
  assert.ok(Math.abs(angleDelta(0.1, Math.PI * 2 + 0.1)) < 1e-9);
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-5, 0, 3), 0);
});
