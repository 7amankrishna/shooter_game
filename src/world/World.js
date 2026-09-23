/**
 * World — the infinite, chunk-streamed procedural world.
 *
 * The world is a grid of 48 m chunks. Around the player we keep a 7x7 window
 * resident: terrain mesh, merged vegetation/structures, colliders, pickups and
 * tower records stream in and out with the window. Everything inside a chunk is
 * derived deterministically from (seed, chunk coords), so revisiting an area
 * rebuilds it exactly — and the whole thing is seamless because the terrain
 * function is analytic and shared by mesh, physics and AI.
 *
 * Streaming is budgeted: at most one chunk is generated per frame while
 * playing (the initial burst happens behind the loading screen), and unload
 * lags one ring behind load so borders never thrash.
 *
 * Placement invariant: structures are placed inside the central zone of their
 * chunk and their flattening pads never reach a chunk border, so pads are
 * always owned by exactly one chunk — no cross-chunk bookkeeping is possible.
 */
import * as THREE from 'three';
import { WORLD } from '../config/GameConfig.js';
import { WorldTerrain, buildChunkGeometry, isRoad, roadCenterZ } from '../physics/Heightfield.js';
import { ColliderWorld } from '../physics/ColliderWorld.js';
import { CellCuller } from './LODInstances.js';
import { buildWatchtower, buildRuin, buildSupplyCache, buildWreck, buildCamp, buildFenceRun } from './Structures.js';
import { boxGeo, cylGeo, mergeGeos, paint, place } from '../core/Geo.js';
import { coordsRng, makeRng, hashCoords, rand, clamp } from '../core/math.js';

const SIZE = WORLD.chunkSize;
const VIEW = WORLD.viewChunks;

/* --------------------------------------------------- deterministic layout */

/** Tower position for a tower-grid cell, or null. Deterministic from coords. */
export function towerForCell(seed, tx, tz) {
  const rng = coordsRng(seed ^ 0x71a2b3c4, tx, tz);
  const cellMinX = tx * WORLD.towerGrid;
  const cellMinZ = tz * WORLD.towerGrid;
  for (let attempt = 0; attempt < 10; attempt++) {
    const x = cellMinX + 34 + rng() * (WORLD.towerGrid - 68);
    const z = cellMinZ + 34 + rng() * (WORLD.towerGrid - 68);
    // never let the tower pad (±~10 m) cross a chunk border (multiples of 48)
    const bx = ((x % SIZE) + SIZE) % SIZE;
    const bz = ((z % SIZE) + SIZE) % SIZE;
    if (bx < 14 || bx > SIZE - 14 || bz < 14 || bz > SIZE - 14) continue;
    // and never on the supply road
    if (Math.abs(z - roadCenterZ(x)) < 16) continue;
    return { x, z, tx, tz };
  }
  return null;
}

/**
 * The deterministic content plan for one chunk. Pure + cached, so any system
 * can ask "what is at chunk (cx,cz)?" before it loads.
 */
export function chunkLayout(seed, cx, cz) {
  const rng = coordsRng(seed ^ 0x9e3779b9, cx, cz);
  const layout = { cx, cz, x: cx * SIZE + SIZE / 2, z: cz * SIZE + SIZE / 2, ruins: [], caches: [], wrecks: [], tower: null, pickups: [] };

  // towers whose position falls inside this chunk
  const txSet = new Set([Math.floor((cx * SIZE + 2) / WORLD.towerGrid), Math.floor((cx * SIZE + SIZE - 2) / WORLD.towerGrid)]);
  const tzSet = new Set([Math.floor((cz * SIZE + 2) / WORLD.towerGrid), Math.floor((cz * SIZE + SIZE - 2) / WORLD.towerGrid)]);
  for (const tx of txSet) {
    for (const tz of tzSet) {
      const t = towerForCell(seed, tx, tz);
      if (t && t.x >= cx * SIZE && t.x < cx * SIZE + SIZE && t.z >= cz * SIZE && t.z < cz * SIZE + SIZE) {
        layout.tower = t;
      }
    }
  }

  // structures live in the chunk's central zone so pads never reach a border
  const jx = () => layout.x + rand(rng, -8, 8);
  const jz = () => layout.z + rand(rng, -8, 8);
  const awayFromOrigin = (x, z, d = 46) => Math.hypot(x, z) > d;

  if (rng() < 0.34) {
    const x = jx();
    const z = jz();
    if (awayFromOrigin(x, z) && Math.abs(z - roadCenterZ(x)) > 12) layout.ruins.push({ x, z, seed: Math.floor(rng() * 1e9) });
  }
  if (rng() < 0.3) {
    const nearRuin = layout.ruins.length > 0 && rng() < 0.5;
    const base = nearRuin ? layout.ruins[0] : { x: jx(), z: jz() };
    const a = rng() * Math.PI * 2;
    const x = base.x + Math.cos(a) * (nearRuin ? rand(rng, 12, 16) : 0);
    const z = base.z + Math.sin(a) * (nearRuin ? rand(rng, 12, 16) : 0);
    if (awayFromOrigin(x, z, 40)) layout.caches.push({ x, z, seed: Math.floor(rng() * 1e9) });
  }
  const wreckCount = rng() < 0.22 ? 1 + (rng() < 0.3 ? 1 : 0) : 0;
  for (let i = 0; i < wreckCount; i++) {
    const x = jx();
    const z = jz();
    if (Math.abs(z - roadCenterZ(x)) < 7) continue; // wrecks like the roadside
    layout.wrecks.push({ x, z, seed: Math.floor(rng() * 1e9) });
  }

  // scatter pickups (deterministic spots, collected-state keyed by index)
  const nPickups = rng() < 0.62 ? 1 + (rng() < 0.4 ? 1 : 0) : 0;
  for (let i = 0; i < nPickups; i++) {
    const x = cx * SIZE + 4 + rng() * (SIZE - 8);
    const z = cz * SIZE + 4 + rng() * (SIZE - 8);
    if (!awayFromOrigin(x, z, 34)) continue;
    const roll = rng();
    const kind = roll < 0.42 ? 'ammo' : roll < 0.62 ? 'bandage' : roll < 0.74 ? 'medkit' : 'coins';
    layout.pickups.push({ key: `${cx},${cz}:${i}`, x, z, kind });
  }
  // ruins always hide one pickup inside
  layout.ruins.forEach((r, i) => {
    layout.pickups.push({ key: `${cx},${cz}:r${i}`, x: r.x, z: r.z, kind: rng() < 0.5 ? 'ammo' : rng() < 0.7 ? 'medkit' : 'coins' });
  });
  return layout;
}

/* ----------------------------------------------------------- pickup meshes */

const PICKUP_BUILDERS = {
  medkit(mat) {
    const g = new THREE.Group();
    const box = new THREE.Mesh(boxGeo(0.36, 0.16, 0.26), mat.case);
    const cross1 = new THREE.Mesh(boxGeo(0.16, 0.02, 0.05), mat.red);
    cross1.position.set(0, 0.09, 0);
    const cross2 = new THREE.Mesh(boxGeo(0.05, 0.02, 0.16), mat.red);
    cross2.position.set(0, 0.09, 0);
    g.add(box, cross1, cross2);
    return g;
  },
  bandage(mat) {
    const g = new THREE.Group();
    const roll = new THREE.Mesh(cylGeo(0.09, 0.09, 0.16, 10), mat.white);
    roll.rotation.z = Math.PI / 2;
    const pin = new THREE.Mesh(cylGeo(0.045, 0.045, 0.18, 8), mat.red);
    pin.rotation.z = Math.PI / 2;
    g.add(roll, pin);
    return g;
  },
  ammo(mat) {
    const g = new THREE.Group();
    const box = new THREE.Mesh(boxGeo(0.34, 0.2, 0.22), mat.olive);
    const stripe = new THREE.Mesh(boxGeo(0.36, 0.05, 0.24), mat.yellow);
    stripe.position.y = 0.04;
    g.add(box, stripe);
    return g;
  },
  coins(mat) {
    const g = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const c = new THREE.Mesh(cylGeo(0.09, 0.09, 0.025, 12), mat.gold);
      c.position.set((i - 1) * 0.05, i * 0.03, (i % 2) * 0.05);
      g.add(c);
    }
    return g;
  },
};

/* ---------------------------------------------------------------- the world */

export class World {
  constructor({ materials, seed = WORLD.seed } = {}) {
    this.materials = materials;
    this.seed = seed;
    this.terrain = new WorldTerrain({ seed });
    this.world = new ColliderWorld({ terrain: (x, z) => this.terrain.heightAt(x, z) });
    this.group = new THREE.Group();
    this.group.name = 'world';
    this.culler = new CellCuller(SIZE);
    this.chunks = new Map();
    this.layoutCache = new Map();
    this.pickups = new Map(); // key -> active pickup record
    this.collected = new Set();
    this.openedCaches = new Set();
    this.towers = new Map(); // `${tx},${tz}` -> tower record
    this.buildQueue = [];
    this.quality = 1; // prop/grass density scale
    this.stats = { chunks: 0, generated: 0, pickups: 0, towers: 0 };
    this._time = 0;
    this.pickupMats = null;
    this._organicGeos = null;
    this._grassTemplate = null;
  }

  #pickupMaterials() {
    if (!this.pickupMats) {
      this.pickupMats = {
        case: new THREE.MeshStandardMaterial({ color: 0xdcd6c8, roughness: 0.6 }),
        red: new THREE.MeshStandardMaterial({ color: 0xb3242a, emissive: 0x40060a, roughness: 0.5 }),
        white: new THREE.MeshStandardMaterial({ color: 0xe8e2d4, roughness: 0.8 }),
        olive: new THREE.MeshStandardMaterial({ color: 0x5c6142, roughness: 0.8 }),
        yellow: new THREE.MeshStandardMaterial({ color: 0xc9a437, roughness: 0.6 }),
        gold: new THREE.MeshStandardMaterial({ color: 0xd8a934, emissive: 0x33230a, metalness: 0.7, roughness: 0.35 }),
      };
    }
    return this.pickupMats;
  }

  layoutFor(cx, cz) {
    const key = `${cx},${cz}`;
    let l = this.layoutCache.get(key);
    if (!l) {
      l = chunkLayout(this.seed, cx, cz);
      if (this.layoutCache.size > 700) this.layoutCache.clear(); // bounded
      this.layoutCache.set(key, l);
    }
    return l;
  }

  /** Footstep surface from the terrain itself (biome + road). */
  surfaceAt(x, z) {
    if (this.terrain.isRoad?.(x, z) > 0.62) return 'rock';
    const b = this.terrain.biomeAt(x, z);
    if (b.rocky > 0.55) return 'rock';
    if (b.dead > 0.45 || b.field > 0.55) return 'dirt';
    return 'grass';
  }

  ground(x, z) {
    return this.world.groundHeightAt(x, z, Infinity);
  }

  heightAt(x, z) {
    return this.terrain.heightAt(x, z);
  }

  /* ------------------------------------------------------------- streaming */

  /** Initial burst — builds the whole starting window, yielding to paint UI. */
  async build(onProgress = () => {}) {
    const R = VIEW + 1;
    const total = (R * 2 + 1) ** 2;
    let done = 0;
    for (let r = 0; r <= R; r++) {
      for (let cx = -r; cx <= r; cx++) {
        for (let cz = -r; cz <= r; cz++) {
          if (Math.max(Math.abs(cx), Math.abs(cz)) !== r) continue;
          this.#buildChunk(cx, cz);
          done++;
        }
      }
      onProgress(`SURVEYING SECTOR · ${Math.round((done / total) * 100)}%`, done / total);
      await new Promise((res) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(res) : setTimeout(res, 0)));
    }
    this.culler.attachTo(this.group);
    return this;
  }

  /** Per-frame streaming: enqueue missing chunks (nearest first), build ≤1. */
  update(px, pz, dt) {
    this._time += dt;
    const ccx = Math.floor(px / SIZE);
    const ccz = Math.floor(pz / SIZE);
    let missing = 0;
    for (let dx = -VIEW; dx <= VIEW; dx++) {
      for (let dz = -VIEW; dz <= VIEW; dz++) {
        const k = `${ccx + dx},${ccz + dz}`;
        if (!this.chunks.has(k)) {
          missing++;
          if (!this.buildQueue.some((q) => q.k === k)) {
            this.buildQueue.push({ k, cx: ccx + dx, cz: ccz + dz, d: dx * dx + dz * dz });
          }
        }
      }
    }
    if (missing) this.buildQueue.sort((a, b) => a.d - b.d);
    let built = 0;
    while (this.buildQueue.length && built < WORLD.chunksPerFrame) {
      const job = this.buildQueue.shift();
      if (this.chunks.has(job.k)) continue;
      this.#buildChunk(job.cx, job.cz);
      built++;
    }
    // unload beyond the window (+1 ring hysteresis so borders never thrash)
    for (const [k, chunk] of this.chunks) {
      if (Math.max(Math.abs(chunk.cx - ccx), Math.abs(chunk.cz - ccz)) > VIEW + 1) this.#unloadChunk(k);
    }
    // animate nearby pickups (bob + spin) — only those worth seeing
    const t = this._time;
    for (const p of this.pickups.values()) {
      const dx = p.x - px;
      const dz = p.z - pz;
      if (dx * dx + dz * dz > 2600) continue;
      p.mesh.position.y = p.baseY + 0.42 + Math.sin(t * 2.2 + p.phase) * 0.07;
      p.mesh.rotation.y = t * 0.9 + p.phase;
    }
  }

  /* ---------------------------------------------------------- chunk build */

  #buildChunk(cx, cz) {
    const key = `${cx},${cz}`;
    if (this.chunks.has(key)) return;
    const M = this.materials;
    const layout = this.layoutFor(cx, cz);
    const chunkGroup = new THREE.Group();
    chunkGroup.name = `chunk_${key}`;
    const owner = `chunk:${key}`;
    const pads = [];
    const builtGeos = [];
    const organicGeos = [];
    const grassGeos = [];
    let towerRecord = null;

    // ---- terrain
    const terrainGeo = buildChunkGeometry(THREE, this.terrain, cx, cz, SIZE, WORLD.chunkSegments);
    const terrainMesh = new THREE.Mesh(terrainGeo, M.ground);
    terrainMesh.receiveShadow = true;
    terrainMesh.name = 'terrain';
    chunkGroup.add(terrainMesh);

    // ---- structures first: their colliders + pads go live BEFORE vegetation
    // samples the world, so trees and grass never grow through a building.
    // Pad level = pre-pad height at each structure centre.
    const prep = (s) => {
      s.baseY = this.terrain.heightAt(s.x, s.z);
      return s;
    };
    const addColliders = (list) => {
      for (const c of list) {
        this.world.addBox(c.x, c.y, c.z, c.sx, c.sy, c.sz, c.tag, {
          walkable: c.walkable ?? true,
          cover: !!c.cover,
          surface: c.surface ?? 'concrete',
          owner,
        });
      }
    };
    if (layout.tower) {
      const t = layout.tower;
      const built = buildWatchtower(t.x, t.z, this.terrain.heightAt(t.x, t.z), M);
      builtGeos.push(...built.geos);
      addColliders(built.colliders);
      pads.push(built.pad);
      const lamp = new THREE.Mesh(boxGeo(0.24, 0.18, 0.24), M.lamp);
      lamp.position.set(built.lamp.x, built.lamp.y, built.lamp.z);
      chunkGroup.add(lamp);
      towerRecord = { ...built.tower, key: `${t.tx},${t.tz}` };
      this.towers.set(towerRecord.key, towerRecord);
    }
    for (const r of layout.ruins) {
      prep(r);
      const rng = makeRng((r.seed >>> 0) || 1);
      const built = buildRuin(r.x, r.z, r.baseY, rng, M);
      builtGeos.push(...built.geos);
      addColliders(built.colliders);
      pads.push(built.pad);
    }
    for (const c of layout.caches) {
      prep(c);
      const rng = makeRng((c.seed >>> 0) || 1);
      const built = buildSupplyCache(c.x, c.z, c.baseY, rng);
      builtGeos.push(...built.geos);
      addColliders(built.colliders);
      pads.push(built.pad);
      c.cache = built.cache;
      c.key = `cache:${key}`;
    }
    for (const w of layout.wrecks) {
      prep(w);
      const rng = makeRng((w.seed >>> 0) || 1);
      const built = buildWreck(w.x, w.z, w.baseY, rng);
      builtGeos.push(...built.geos);
      addColliders(built.colliders);
      pads.push(built.pad);
    }
    // the spawn camp lives at the origin chunk
    if (cx === 0 && cz === 0) {
      const camp = buildCamp(2, 2, this.terrain.heightAt(2, 2));
      builtGeos.push(...camp.geos);
      addColliders(camp.colliders);
    }
    for (const p of pads) this.terrain.flats.add(p);

    // ---- vegetation & scatter (queries the live collider world)
    const vegColliders = [];
    this.#buildVegetation(cx, cz, organicGeos, grassGeos, builtGeos, vegColliders);
    addColliders(vegColliders);

    // ---- merge + mount
    const geometries = [terrainGeo];
    if (builtGeos.length) {
      const mesh = new THREE.Mesh(mergeGeos(builtGeos), M.merged);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = 'built';
      chunkGroup.add(mesh);
      geometries.push(mesh.geometry);
    }
    if (organicGeos.length) {
      const mesh = new THREE.Mesh(mergeGeos(organicGeos), M.organic);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = 'organic';
      chunkGroup.add(mesh);
      geometries.push(mesh.geometry);
    }
    if (grassGeos.length) {
      const mesh = new THREE.Mesh(mergeGeos(grassGeos), M.grass);
      mesh.name = 'grass';
      chunkGroup.add(mesh);
      geometries.push(mesh.geometry);
    }

    // ---- pickups
    const pickupRecords = [];
    for (const p of layout.pickups) {
      if (this.collected.has(p.key)) continue;
      const y = this.terrain.heightAt(p.x, p.z);
      const mesh = PICKUP_BUILDERS[p.kind](this.#pickupMaterials());
      mesh.position.set(p.x, y + 0.42, p.z);
      chunkGroup.add(mesh);
      const rec = { ...p, baseY: y, mesh, phase: (hashCoords(p.x, p.z, 7) % 628) / 100 };
      this.pickups.set(p.key, rec);
      pickupRecords.push(rec);
    }

    this.group.add(chunkGroup);
    this.culler.add(cx * SIZE + SIZE / 2, cz * SIZE + SIZE / 2, chunkGroup);
    this.chunks.set(key, {
      key,
      cx,
      cz,
      group: chunkGroup,
      owner,
      pads,
      pickups: pickupRecords,
      caches: layout.caches,
      towerKey: towerRecord?.key ?? null,
      geometries,
    });
    this.stats.chunks = this.chunks.size;
    this.stats.generated++;
    this.stats.pickups = this.pickups.size;
    this.stats.towers = this.towers.size;
  }

  #buildVegetation(cx, cz, organicGeos, grassGeos, builtGeos, colliders) {
    const rng = coordsRng(this.seed ^ 0x2545f491, cx, cz);
    const q = this.quality;
    const trees = this.#treeGeos();
    const x0 = cx * SIZE;
    const z0 = cz * SIZE;
    const slopeAt = (x, z) => {
      const e = 1.2;
      const gx = (this.terrain.heightAt(x + e, z) - this.terrain.heightAt(x - e, z)) / (2 * e);
      const gz = (this.terrain.heightAt(x, z + e) - this.terrain.heightAt(x, z - e)) / (2 * e);
      return Math.hypot(gx, gz);
    };
    const freeOf = (x, z, r) => {
      if (isRoad(x, z)) return false;
      const boxes = this.world.queryXZ(x - r, x + r, z - r, z + r, (b) =>
        ['structure', 'floor', 'deck', 'crate', 'wreck', 'rock', 'tree', 'rubble'].includes(b.tag));
      return boxes.length === 0;
    };

    // ---- trees — density from biome, variety from scale + rotation + species
    const treeTarget = Math.round((6 + rng() * 10) * q);
    for (let i = 0; i < treeTarget; i++) {
      const x = x0 + rng() * SIZE;
      const z = z0 + rng() * SIZE;
      const b = this.terrain.biomeAt(x, z);
      const pTree = b.forest * 0.85 + b.field * 0.16 + b.dead * 0.3 + b.rocky * 0.1;
      if (rng() > pTree) continue;
      if (slopeAt(x, z) > 0.65) continue;
      if (!freeOf(x, z, 2.6)) continue;
      if (Math.hypot(x, z) < WORLD.spawnClearing * 0.8) continue;
      const y = this.terrain.heightAt(x, z);
      const dead = b.dead > 0.45 && rng() < 0.7;
      const s = rand(rng, 0.75, 1.5) * (dead ? 0.9 : 1);
      const geo = dead ? trees.dead : rng() < 0.3 ? trees.pine : trees.round;
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rng() * Math.PI * 2, 0)),
        new THREE.Vector3(s, s * rand(rng, 0.9, 1.2), s),
      );
      organicGeos.push(geo.clone().applyMatrix4(m));
      colliders.push({ x, y: y + 2.2, z, sx: 0.6, sy: 4.4, sz: 0.6, tag: 'tree', walkable: false, surface: 'wood' });
    }
    // ---- bushes
    const bushTarget = Math.round((4 + rng() * 8) * q);
    for (let i = 0; i < bushTarget; i++) {
      const x = x0 + rng() * SIZE;
      const z = z0 + rng() * SIZE;
      const b = this.terrain.biomeAt(x, z);
      if (rng() > b.forest * 0.7 + b.field * 0.3 + b.dead * 0.25) continue;
      if (!freeOf(x, z, 1.2)) continue;
      const y = this.terrain.heightAt(x, z);
      const s = rand(rng, 0.5, 1.1);
      const g = this.#bushGeo(b.dead > 0.4, rng);
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(x, y + s * 0.3, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rng() * Math.PI * 2, 0)),
        new THREE.Vector3(s, s * 0.8, s),
      );
      organicGeos.push(g.clone().applyMatrix4(m));
    }
    // ---- rocks
    const rockTarget = Math.round((3 + rng() * 9) * q);
    for (let i = 0; i < rockTarget; i++) {
      const x = x0 + rng() * SIZE;
      const z = z0 + rng() * SIZE;
      const b = this.terrain.biomeAt(x, z);
      if (rng() > b.rocky * 1.2 + b.field * 0.12 + b.forest * 0.18) continue;
      if (!freeOf(x, z, 1.4)) continue;
      const y = this.terrain.heightAt(x, z);
      const s = rand(rng, 0.5, 2.0);
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(x, y + s * 0.32, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rng() * 0.3 - 0.15, rng() * Math.PI * 2, rng() * 0.3 - 0.15)),
        new THREE.Vector3(s, s * rand(rng, 0.7, 1.1), s),
      );
      organicGeos.push(this.#rockGeo().clone().applyMatrix4(m));
      if (s > 0.9) colliders.push({ x, y: y + s * 0.35, z, sx: s * 1.5, sy: s * 0.9, sz: s * 1.5, tag: 'rock', surface: 'rock', cover: s > 1.2 });
    }
    // ---- grass tufts — crossed alpha-tested quads, one merged mesh per chunk
    const tuftTarget = Math.round(90 * q);
    const template = this.#grassTemplate();
    const tufts = [];
    for (let i = 0; i < tuftTarget; i++) {
      const x = x0 + rng() * SIZE;
      const z = z0 + rng() * SIZE;
      const b = this.terrain.biomeAt(x, z);
      if (rng() > b.field * 1.1 + b.forest * 0.5 + b.dead * 0.45) continue;
      if (slopeAt(x, z) > 0.5) continue;
      if (!freeOf(x, z, 0.6)) continue;
      tufts.push({ x, y: this.terrain.heightAt(x, z), z, s: rand(rng, 0.6, 1.35), dead: b.dead > 0.4, r: rng() * Math.PI });
    }
    if (tufts.length) grassGeos.push(this.#grassGeometry(tufts, template));
    // ---- fences in open field (facade material → builtGeos)
    if (rng() < 0.22) {
      const fx = x0 + rand(rng, 8, SIZE - 8);
      const fz = z0 + rand(rng, 8, SIZE - 8);
      if (this.terrain.biomeAt(fx, fz).field > 0.45 && Math.hypot(fx, fz) > 40) {
        const horiz = rng() < 0.5;
        const len = rand(rng, 8, 18);
        const built = buildFenceRun(
          horiz ? fx - len / 2 : fx, horiz ? fz : fz - len / 2,
          horiz ? fx + len / 2 : fx, horiz ? fz : fz + len / 2,
          (x, z) => this.terrain.heightAt(x, z),
        );
        builtGeos.push(...built.geos);
        colliders.push(...built.colliders);
      }
    }
  }

  #grassTemplate() {
    if (this._grassTemplate) return this._grassTemplate;
    // two crossed quads, tinted dark at the base like real grass
    const quad = (ry) => {
      const g = new THREE.PlaneGeometry(0.5, 0.55, 1, 1);
      g.translate(0, 0.26, 0);
      g.rotateY(ry);
      paint(g, new THREE.Color(0xffffff));
      const col = g.attributes.color;
      for (let i = 0; i < col.count; i++) {
        const y = g.attributes.position.getY(i);
        const t = clamp(y / 0.55, 0, 1);
        col.setXYZ(i, 0.45 + t * 0.55, 0.55 + t * 0.45, 0.4 + t * 0.4);
      }
      return g;
    };
    this._grassTemplate = mergeGeos([quad(0), quad(Math.PI / 2), quad(-Math.PI / 3)]);
    return this._grassTemplate;
  }

  #grassGeometry(tufts, template) {
    const geos = [];
    for (const t of tufts) {
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(t.x, t.y, t.z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, t.r, 0)),
        new THREE.Vector3(t.s, t.s * (t.dead ? 0.7 : 1), t.s),
      );
      const g = template.clone().applyMatrix4(m);
      if (t.dead) {
        const col = g.attributes.color;
        for (let i = 0; i < col.count; i++) col.setXYZ(i, col.getX(i) * 0.75, col.getY(i) * 0.68, col.getZ(i) * 0.6);
      }
      geos.push(g);
    }
    return mergeGeos(geos);
  }

  #treeGeos() {
    if (this._organicGeos) return this._organicGeos;
    const round = mergeGeos([
      place(cylGeo(0.22, 0.34, 3.6, 7, { uvScale: 2 }), { pos: [0, 1.8, 0] }),
      place(paint(new THREE.IcosahedronGeometry(1.55, 1), new THREE.Color(0x445230)), { pos: [0, 4.1, 0] }),
      place(paint(new THREE.IcosahedronGeometry(1.05, 1), new THREE.Color(0x53633a)), { pos: [0.5, 3.4, 0.3] }),
      place(paint(new THREE.IcosahedronGeometry(0.9, 1), new THREE.Color(0x4a5a34)), { pos: [-0.5, 3.6, -0.3] }),
    ]);
    const pine = mergeGeos([
      place(cylGeo(0.18, 0.3, 3.2, 7, { uvScale: 2 }), { pos: [0, 1.6, 0] }),
      place(paint(new THREE.ConeGeometry(1.5, 2.6, 8), new THREE.Color(0x39482c)), { pos: [0, 3.4, 0] }),
      place(paint(new THREE.ConeGeometry(1.1, 2.2, 8), new THREE.Color(0x41522f)), { pos: [0, 4.6, 0] }),
      place(paint(new THREE.ConeGeometry(0.7, 1.6, 8), new THREE.Color(0x4a5a34)), { pos: [0, 5.7, 0] }),
    ]);
    const dead = mergeGeos([
      place(paint(cylGeo(0.16, 0.3, 3.8, 6, { uvScale: 2 }), new THREE.Color(0x5d564c)), { pos: [0, 1.9, 0] }),
      place(paint(boxGeo(0.1, 1.6, 0.1), new THREE.Color(0x554e44)), { pos: [0.35, 3.1, 0], rot: [0, 0, 0.7] }),
      place(paint(boxGeo(0.09, 1.3, 0.09), new THREE.Color(0x554e44)), { pos: [-0.3, 2.8, 0.2], rot: [0.2, 0, -0.8] }),
      place(paint(boxGeo(0.08, 1.0, 0.08), new THREE.Color(0x4e4840)), { pos: [0.05, 3.8, -0.25], rot: [-0.5, 0, 0.2] }),
    ]);
    this._organicGeos = { round, pine, dead };
    return this._organicGeos;
  }

  #rockGeo() {
    if (this._rockGeoCache) return this._rockGeoCache;
    const g = new THREE.IcosahedronGeometry(1, 1);
    const pos = g.attributes.position;
    const rng = makeRng(9917);
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(
        i,
        pos.getX(i) * (0.8 + rng() * 0.4),
        pos.getY(i) * (0.55 + rng() * 0.3),
        pos.getZ(i) * (0.8 + rng() * 0.4),
      );
    }
    g.computeVertexNormals();
    paint(g, new THREE.Color(0x84837a));
    this._rockGeoCache = g;
    return g;
  }

  #bushGeo(dead, rng) {
    const c = dead ? 0x6e6353 : 0x4c5c36;
    const g = new THREE.IcosahedronGeometry(0.8, 1);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(i, pos.getX(i) * (0.85 + rng() * 0.3), pos.getY(i) * (0.7 + rng() * 0.2), pos.getZ(i) * (0.85 + rng() * 0.3));
    }
    g.computeVertexNormals();
    paint(g, new THREE.Color(c));
    return g;
  }

  #unloadChunk(key) {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    this.world.removeByOwner(chunk.owner);
    this.terrain.flats.removeSet(new Set(chunk.pads));
    for (const p of chunk.pickups) {
      this.pickups.delete(p.key);
      p.mesh.removeFromParent();
    }
    if (chunk.towerKey) this.towers.delete(chunk.towerKey);
    chunk.group.removeFromParent();
    for (const g of chunk.geometries) g.dispose();
    this.culler.remove(chunk.group);
    this.chunks.delete(key);
    this.stats.chunks = this.chunks.size;
    this.stats.pickups = this.pickups.size;
    this.stats.towers = this.towers.size;
  }

  /* ------------------------------------------------------------ interactions */

  /** Proximity pickup collection. Returns collected pickup records. */
  collectPickups(pos, radius = 1.9) {
    const out = [];
    for (const p of this.pickups.values()) {
      const dx = p.x - pos.x;
      const dz = p.z - pos.z;
      if (dx * dx + dz * dz > radius * radius) continue;
      if (Math.abs(p.baseY - pos.y) > 2.6) continue;
      this.collected.add(p.key);
      p.mesh.removeFromParent();
      this.pickups.delete(p.key);
      out.push(p);
      this.stats.pickups = this.pickups.size;
    }
    return out;
  }

  /** Nearest supply cache within `radius` of pos (E interaction), or null. */
  cacheNear(pos, radius = 3.2) {
    let best = null;
    let bestD = radius * radius;
    for (const chunk of this.chunks.values()) {
      for (const c of chunk.caches) {
        const dx = c.x - pos.x;
        const dz = c.z - pos.z;
        const d = dx * dx + dz * dz;
        if (d < bestD && Math.abs(c.baseY - pos.y) < 3) {
          best = c;
          bestD = d;
        }
      }
    }
    return best;
  }

  markCacheOpened(cache) {
    this.openedCaches.add(cache.key);
  }

  /** Nearest loaded tower (for interaction prompts + compass). */
  nearestTower(pos) {
    let best = null;
    let bestD = Infinity;
    for (const t of this.towers.values()) {
      const d = (t.x - pos.x) ** 2 + (t.z - pos.z) ** 2;
      if (d < bestD) {
        best = t;
        bestD = d;
      }
    }
    return best ? { tower: best, dist: Math.sqrt(bestD) } : null;
  }

  towerList() {
    return [...this.towers.values()];
  }

  serializePickups() {
    return [...this.collected];
  }

  restorePickups(keys) {
    this.collected = new Set(keys ?? []);
  }

  dispose() {
    for (const key of [...this.chunks.keys()]) this.#unloadChunk(key);
    this.group.removeFromParent();
  }
}
