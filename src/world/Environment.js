/**
 * Environment — the single "Abandoned Supply Quarter" arena.
 *
 * Everything is authored from parametric specs, so the map is data rather than
 * hand-placed geometry: buildings, container stacks, ruins, an elevated
 * concrete overlook, roads, fences and scatter props each register their own
 * colliders, terrain flattening pads and cover points as they are built.
 *
 * Range bands (design intent):
 *   close   — village alleys + building interiors (west)
 *   medium  — the main road, depot apron, container lanes (east/centre)
 *   long    — overlook deck vs. the northern ruins and the dry riverbed
 */
import * as THREE from 'three';
import { WORLD, RENDER } from '../config/GameConfig.js';
import { ColliderWorld } from '../physics/ColliderWorld.js';
import { NavGrid } from './NavGrid.js';
import { createTerrain, buildTerrainGeometry, ROADS } from '../physics/Heightfield.js';
import { PropSystem, CellCuller } from './LODInstances.js';
import { boxGeo, boxAt, cylGeo, mergeGeos, paint, place } from '../core/Geo.js';
import { makeRng, clamp, rand, pick } from '../core/math.js';

const HALF = WORLD.bounds;

/* ------------------------------------------------------------------ layout */

const BUILDINGS = [
  // --- the village (west): alleys, interiors, brutal close range ---
  { x: -58, z: 8, w: 17, d: 12, h: 6.6, floors: 2, door: 'e', shade: 0.98 },
  { x: -34, z: 4, w: 12, d: 10, h: 4.2, door: 'n', ruin: 0.45, shade: 0.9 },
  { x: -59, z: 34, w: 14, d: 12, h: 5.6, door: 'e', floors: 2, shade: 1.02 },
  { x: -33, z: 34, w: 10, d: 9, h: 3.4, ruin: 0.9, shade: 0.82 },
  { x: -82, z: 20, w: 11, d: 18, h: 5.0, door: 'e', shade: 0.94 },
  // --- depot (east): long warehouse shell with a wide loading bay ---
  { x: 52, z: 20, w: 34, d: 18, h: 8.2, door: 'w', doorWidth: 6.5, wide: true, shade: 1.05 },
  { x: 82, z: -8, w: 14, d: 12, h: 5.6, door: 's', shade: 0.97 },
  // --- northern ruins: shattered shells, mid range ---
  { x: -20, z: -46, w: 14, d: 10, h: 3.0, ruin: 1, shade: 0.78 },
  { x: 6, z: -60, w: 11, d: 13, h: 4.6, door: 's', shade: 0.88 },
  { x: -46, z: -26, w: 9, d: 9, h: 2.6, ruin: 1, shade: 0.74 },
  { x: 40, z: -44, w: 12, d: 9, h: 3.6, ruin: 0.7, shade: 0.84 },
  // --- south strip: shops facing the main road ---
  { x: -6, z: 64, w: 18, d: 11, h: 5.2, door: 'n', shade: 1.0 },
  { x: 36, z: 66, w: 12, d: 10, h: 4.6, door: 'w', shade: 0.95 },
  { x: -50, z: 68, w: 14, d: 10, h: 4.0, ruin: 0.6, shade: 0.86 },
];

const CONTAINER_TINTS = [0xb1502f, 0x4e737c, 0x6f7a41];

/** [x, z, alongX, stackHeight, tintIndex] */
const CONTAINERS = [
  [30, 44, true, 2, 0], [44, 44, true, 1, 1], [30, 52, true, 1, 2],
  [58, 44, true, 2, 1], [72, 44, true, 1, 0], [44, 52, true, 2, 2],
  [72, 56, false, 1, 0], [86, 26, false, 2, 1], [86, 10, false, 1, 2],
  [26, -30, false, 2, 0], [26, -46, false, 1, 1], [10, -32, true, 1, 2],
  [-14, 22, false, 1, 0], [6, 26, true, 2, 1], [6, 34, true, 1, 2],
  [-72, -52, true, 1, 0], [-88, 46, false, 2, 1],
];

const WRECKS = [[-2, 8, 0.4], [10, -22, 1.9], [-46, 52, 2.7], [66, 6, 0.9], [-18, -18, 4.1], [48, 60, 2.2]];

/** low concrete walls / sandbag lines that shape the fire lanes */
const BARRICADES = [
  { type: 'wall', x: 2, z: -6, len: 9, alongX: true },
  { type: 'wall', x: -14, z: -8, len: 7, alongX: false },
  { type: 'sandbag', x: 24, z: 2, len: 6, alongX: true },
  { type: 'sandbag', x: -6, z: 20, len: 5, alongX: false },
  { type: 'sandbag', x: 44, z: 62, len: 7, alongX: true },
  { type: 'wall', x: -34, z: 20, len: 8, alongX: true },
  { type: 'wall', x: 60, z: -20, len: 10, alongX: false },
  { type: 'sandbag', x: 12, z: 44, len: 6, alongX: false },
  { type: 'wall', x: -62, z: -44, len: 8, alongX: true },
  { type: 'sandbag', x: 78, z: 40, len: 5, alongX: true },
  { type: 'wall', x: -28, z: -66, len: 9, alongX: true },
  { type: 'sandbag', x: 26, z: -62, len: 6, alongX: false },
  { type: 'sandbag', x: 54, z: 74, len: 6, alongX: true },
];

/** Elevated concrete overlook: the long-range perch with one stair approach. */
const OVERLOOK = { x: 58, z: 80, w: 22, d: 15, h: 3.2 };

/* ------------------------------------------------------------- utilities */

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Compose an instance matrix (position, yaw, uniform scale, optional tilt). */
function mat4(x, y, z, ry = 0, s = 1, rx = 0, rz = 0) {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  _v.set(x, y, z);
  _s.set(s, s, s);
  return new THREE.Matrix4().compose(_v.clone(), _q.clone(), _s.clone());
}

function shadeColor(hex, k) {
  return new THREE.Color(hex).multiplyScalar(k);
}

function translate(geo, x, y, z) {
  geo.translate(x, y, z);
  geo.computeBoundingBox();
  return geo;
}

function jitterSphere(geo, rng, amount) {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(
      i,
      pos.getX(i) + (rng() - 0.5) * amount,
      pos.getY(i) * rand(rng, 0.62, 0.92) + (rng() - 0.5) * amount,
      pos.getZ(i) + (rng() - 0.5) * amount,
    );
  }
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

function nextFrame() {
  return new Promise((r) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => r()) : setTimeout(r, 0)));
}

/* ------------------------------------------------------------------- class */

export class Environment {
  constructor({ materials, seed = 20260917 } = {}) {
    this.materials = materials;
    this.rng = makeRng(seed);
    this.group = new THREE.Group();
    this.group.name = 'environment';
    this.coverPoints = [];
    this.hearths = []; // overwatch spots the AI likes to patrol between
    this.spawns = { player: [], ai: [] };
    this.world = new ColliderWorld({ halfSize: HALF - 4 });
    this.props = new PropSystem();
    this.culler = new CellCuller(30);
    this.stats = { structures: 0, colliders: 0, cover: 0, drawCalls: 0 };
    this.terrain = createTerrain([]);
  }

  /**
   * Full generation pipeline. `onProgress(label, 0..1)` lets the loading
   * screen paint between phases — each phase yields a frame.
   */
  async build(onProgress = () => {}) {
    const step = async (label, p, fn) => {
      onProgress(label, p);
      await nextFrame();
      fn();
    };
    await step('SURVEYING TERRAIN', 0.06, () => this.#prepareTerrain());
    await step('RAISING STRUCTURES', 0.18, () => this.#buildBuildings());
    await step('POSITIONING CONTAINERS', 0.34, () => this.#buildDepot());
    await step('PAVING ROADS', 0.46, () => this.#buildGroundAndRoads());
    await step('SCATTERING COVER', 0.6, () => this.#buildProps());
    await step('TRIMMING VEGETATION', 0.72, () => this.#buildVegetation());
    await step('BAKING NAV MESH', 0.82, () => this.#bakeNav());
    await step('MAPPING COVER POINTS', 0.93, () => this.#buildCoverPoints());
    onProgress('READY', 1);
    return this;
  }

  /* ------------------------------------------------------- phase: terrain */

  #prepareTerrain() {
    const raw = createTerrain([]);
    const pads = [];
    for (const b of BUILDINGS) pads.push({ x: b.x, z: b.z, w: b.w, d: b.d, y: raw(b.x, b.z), pad: 3 });
    pads.push({
      x: OVERLOOK.x, z: OVERLOOK.z, w: OVERLOOK.w + 10, d: OVERLOOK.d + 10,
      y: raw(OVERLOOK.x, OVERLOOK.z), pad: 2,
    });
    // level the central yard so the alleys and roads read as usable ground
    pads.push({ x: 0, z: 4, w: 96, d: 96, y: clamp(raw(0, 4), -1.2, 1.2), pad: 6 });
    this.flatteners = pads;
    this.terrain = createTerrain(pads);
    this.world.terrain = this.terrain;
  }

  /* -------------------------------------------- phase: buildings (village) */

  /**
   * Splits one wall run into solid segments around rectangular openings.
   * `holes` entries: { at, w, bottom, top } measured along the wall.
   */
  #wallSegments(length, height, holes = []) {
    const half = length / 2;
    const segs = [];
    const clean = holes
      .map((h) => {
        const hw = Math.min(h.w / 2, half - 0.1);
        return { at: clamp(h.at, -half + hw, half - hw), w: hw * 2, bottom: clamp(h.bottom, 0, height), top: clamp(h.top, 0, height + 2) };
      })
      .sort((a, b) => a.at - b.at);
    let cursor = -half;
    for (const h of clean) {
      const from = h.at - h.w / 2;
      const to = h.at + h.w / 2;
      if (from > cursor + 0.05) segs.push({ at: (cursor + from) / 2, along: from - cursor, bottom: 0, top: height });
      if (h.bottom > 0.05) segs.push({ at: h.at, along: h.w, bottom: 0, top: h.bottom });
      if (height - h.top > 0.05) segs.push({ at: h.at, along: h.w, bottom: h.top, top: height });
      cursor = Math.max(cursor, to);
    }
    if (cursor < half - 0.05) segs.push({ at: (cursor + half) / 2, along: half - cursor, bottom: 0, top: height });
    return segs.filter((s) => s.along > 0.08 && s.top - s.bottom > 0.08);
  }

  #buildBuildings() {
    const rng = this.rng;
    const wall = 0.4;
    BUILDINGS.forEach((spec, bi) => {
      const base = this.terrain(spec.x, spec.z);
      const { w, d, h } = spec;
      const ruin = spec.ruin ?? 0;
      const doorWidth = spec.doorWidth ?? 2.6;
      const geos = [];
      const colliders = [];
      const addSolid = (x, y, z, sx, sy, sz, tag, opts = {}) => {
        colliders.push({ pos: [x, y, z], size: [sx, sy, sz], tag, opts });
      };

      const sides = [
        { name: 'n', alongX: true, fixed: spec.z - d / 2 },
        { name: 's', alongX: true, fixed: spec.z + d / 2 },
        { name: 'w', alongX: false, fixed: spec.x - w / 2 },
        { name: 'e', alongX: false, fixed: spec.x + w / 2 },
      ];

      for (const side of sides) {
        const length = side.alongX ? w : d;
        const holes = [];
        if (spec.door === side.name) {
          holes.push({ at: rand(rng, -length * 0.2, length * 0.2), w: doorWidth, bottom: 0, top: 2.4 });
        }
        if (spec.wide && side.name === 'e') holes.push({ at: 8, w: 4.4, bottom: 0, top: 4.6 });
        // punched windows on the taller shells
        const rows = h > 5.4 ? 2 : 1;
        const cols = Math.max(1, Math.floor(length / 5));
        for (let r = 0; r < rows; r++) {
          for (let i = 0; i < cols; i++) {
            if (rng() < 0.34) continue;
            const at = -length / 2 + (i + 0.5) * (length / cols);
            if (holes.some((hh) => Math.abs(hh.at - at) < 2.3)) continue;
            const y0 = 1.4 + r * 2.7;
            if (y0 + 1.3 > h - 0.2) continue;
            holes.push({ at, w: 1.5, bottom: y0, top: y0 + 1.3 });
          }
        }
        // ruin: ragged top edge carved as notches
        if (ruin > 0.25) {
          const notch = Math.max(2, Math.floor(length / 3.4));
          for (let i = 0; i < notch; i++) {
            const at = -length / 2 + (i + 0.5) * (length / notch) + rand(rng, -0.5, 0.5);
            const keep = h * (1 - ruin * rand(rng, 0.3, 0.95));
            if (h - keep < 0.5) continue;
            holes.push({ at, w: rand(rng, 1.2, 2.6), bottom: keep, top: h + 2 });
          }
        }
        for (const s of this.#wallSegments(length, h, holes)) {
          const sx = side.alongX ? s.along : wall;
          const sz = side.alongX ? wall : s.along;
          const wx = side.alongX ? spec.x + s.at : side.fixed;
          const wz = side.alongX ? side.fixed : spec.z + s.at;
          const g = boxAt(sx, s.top - s.bottom, sz, 0, 0, 0, 0, { uvScale: 2.6 });
          paint(g, shadeColor(0xbdb4a6, 0.68 + (s.top / h) * 0.4));
          geos.push(translate(g, wx, base + (s.bottom + s.top) / 2, wz));
          addSolid(wx, base + (s.bottom + s.top) / 2, wz, sx, s.top - s.bottom, sz, 'structure');
        }
      }

      // ---- ground slab (walkable floor)
      const floor = boxAt(w, 0.24, d, 0, 0.12, 0, 0, { uvScale: 3 });
      paint(floor, shadeColor(0x968f83, 0.95));
      geos.push(translate(floor, spec.x, base, spec.z));
      addSolid(spec.x, base + 0.12, spec.z, w, 0.24, d, 'floor');

      // ---- mezzanine + stairs for the two-storey shells
      if (spec.floors === 2) {
        const mezzY = base + Math.round(h * 0.52);
        const mezzD = d * 0.55;
        const mz = spec.z - d / 2 + mezzD / 2 + wall;
        const mg = boxAt(w - wall * 2, 0.28, mezzD, 0, 0, 0, 0, { uvScale: 3 });
        paint(mg, shadeColor(0x968f83, 1));
        geos.push(translate(mg, spec.x, mezzY, mz));
        addSolid(spec.x, mezzY, mz, w - 0.8, 0.28, mezzD, 'floor');
        const steps = Math.max(5, Math.round((mezzY - base) / 0.42));
        const rise = (mezzY - base) / steps;
        for (let i = 0; i < steps; i++) {
          const topH = rise * (i + 1);
          const sx = spec.x + w / 2 - wall - 1.2;
          const sz = spec.z + d / 2 - wall - 1.0 - i * 1.15;
          const sg = boxAt(1.8, topH, 1.16, 0, 0, 0, 0, { uvScale: 2 });
          paint(sg, shadeColor(0xa29a8e, 0.9));
          geos.push(translate(sg, sx, base + topH / 2, sz));
          addSolid(sx, base + topH / 2, sz, 1.8, topH, 1.16, 'stairs');
        }
      }

      // ---- roof on intact shells (blocks overhead fire into rooms)
      if (ruin < 0.4) {
        const rg = boxAt(w + 0.8, 0.34, d + 0.8, 0, 0, 0, 0, { uvScale: 3 });
        paint(rg, shadeColor(0x75706a, 1));
        geos.push(translate(rg, spec.x, base + h + 0.17, spec.z));
        addSolid(spec.x, base + h + 0.17, spec.z, w + 0.8, 0.34, d + 0.8, 'roof');
        if (h >= 5) {
          for (const [ox, oz, pw, pd] of [[0, -d / 2 - 0.2, w + 0.8, 0.36], [0, d / 2 + 0.2, w + 0.8, 0.36], [-w / 2 - 0.2, 0, 0.36, d + 0.8], [w / 2 + 0.2, 0, 0.36, d + 0.8]]) {
            const pg = boxAt(pw, 0.9, pd, 0, 0, 0, 0, { uvScale: 2 });
            paint(pg, shadeColor(0xafa89c, 1));
            geos.push(translate(pg, spec.x + ox, base + h + 0.78, spec.z + oz));
            addSolid(spec.x + ox, base + h + 0.78, spec.z + oz, pw, 0.9, pd, 'parapet', { walkable: false, cover: true });
          }
        }
      }

      // ---- foundation apron: hides the terrain seam and gives a firing step
      const ap = boxAt(w + 2.6, 0.7, d + 2.6, 0, -0.33, 0, 0, { uvScale: 3 });
      paint(ap, shadeColor(0x847e74, 0.92));
      geos.push(translate(ap, spec.x, base + 0.02, spec.z));
      addSolid(spec.x, base - 0.33, spec.z, w + 2.6, 0.7, d + 2.6, 'apron');

      const mesh = new THREE.Mesh(mergeGeos(geos), this.materials.merged);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `building_${bi}`;
      this.culler.add(spec.x, spec.z, mesh);
      this.stats.structures++;

      for (const c of colliders) {
        this.world.addBox(c.pos[0], c.pos[1], c.pos[2], c.size[0], c.size[1], c.size[2], c.tag, {
          walkable: c.opts.walkable ?? c.tag !== 'parapet',
          cover: !!c.opts.cover,
          surface: 'concrete',
        });
        this.stats.colliders++;
      }
    });
  }

  /* -------------------------------------------------------- phase: depot */

  #buildDepot() {
    const M = this.materials;
    // near LOD carries corrugation ribs + door ends, far LOD is a single box
    const makeNear = () => {
      const parts = [boxGeo(12.2, 2.62, 2.44, { uvScale: 2.4 })];
      for (let i = -5.6; i <= 5.6; i += 0.7) {
        parts.push(boxAt(0.12, 2.5, 0.12, i, 0, 1.2, 0, { uvScale: 1 }));
        parts.push(boxAt(0.12, 2.5, 0.12, i, 0, -1.2, 0, { uvScale: 1 }));
      }
      parts.push(boxAt(12.24, 0.16, 2.48, 0, 1.35, 0, 0, { uvScale: 2 }));
      parts.push(boxAt(12.24, 0.16, 2.48, 0, -1.35, 0, 0, { uvScale: 2 }));
      parts.push(boxAt(0.3, 2.62, 2.46, 6.0, 0, 0, 0, { uvScale: 1 }));
      parts.push(boxAt(0.3, 2.62, 2.46, -6.0, 0, 0, 0, { uvScale: 1 }));
      return mergeGeos(parts);
    };
    const farGeo = boxGeo(12.2, 2.62, 2.44, { uvScale: 2.4 });
    const fams = CONTAINER_TINTS.map((tint, i) => {
      const material = M.corrugated.clone();
      material.color = new THREE.Color(tint);
      return this.props.create({
        name: `containers${i}`,
        nearGeo: makeNear(),
        farGeo,
        material,
        nearRange: RENDER.lodNearRange,
        farRange: 96,
        cullRange: RENDER.instanceFarRange + 24,
        count: 12,
      });
    });

    for (const [x, z, alongX, stack, tint] of CONTAINERS) {
      const fam = fams[tint % fams.length];
      for (let s = 0; s < stack; s++) {
        const y = this.terrain(x, z) + 1.35 + s * 2.68;
        fam.add(mat4(x, y, z, alongX ? 0 : Math.PI / 2, 1));
        this.world.addBox(x, y, z, alongX ? 12.2 : 2.44, 2.62, alongX ? 2.44 : 12.2, 'container', {
          cover: true,
          surface: 'metal',
          walkable: s === stack - 1, // you can climb the top of a stack
        });
        this.stats.colliders++;
      }
    }
  }

  /* ---------------------------------------------------- phase: ground/roads */

  #buildGroundAndRoads() {
    const ground = new THREE.Mesh(buildTerrainGeometry(THREE, this.terrain), this.materials.ground);
    ground.receiveShadow = true;
    ground.name = 'terrain';
    this.group.add(ground);

    const roadGeos = [];
    for (const r of ROADS) {
      const len = Math.hypot(r.b.x - r.a.x, r.b.z - r.a.z);
      const steps = Math.max(6, Math.round(len / 4));
      const nx = (r.b.z - r.a.z) / len;
      const nz = -(r.b.x - r.a.x) / len;
      const hw = r.width / 2;
      for (let i = 0; i < steps; i++) {
        const t0 = i / steps;
        const t1 = (i + 1) / steps;
        const ax = r.a.x + (r.b.x - r.a.x) * t0;
        const az = r.a.z + (r.b.z - r.a.z) * t0;
        const bx = r.a.x + (r.b.x - r.a.x) * t1;
        const bz = r.a.z + (r.b.z - r.a.z) * t1;
        const deck = makeQuad(
          [ax + nx * hw, az + nz * hw], [bx + nx * hw, bz + nz * hw],
          [bx - nx * hw, bz - nz * hw], [ax - nx * hw, az - nz * hw],
          this.terrain, 0.1,
        );
        paint(deck, shadeColor(0x9a9ea3, 1));
        roadGeos.push(deck);
        if (i % 2 === 0) {
          const dash = makeQuad(
            [ax + nx * 0.7, az + nz * 0.7], [bx - nx * 0.7, bz - nz * 0.7],
            [bx - nx * 0.22, bz - nz * 0.22], [ax + nx * 0.22, az + nz * 0.22],
            this.terrain, 0.16,
          );
          paint(dash, 0xbdb68a);
          roadGeos.push(dash);
        }
      }
    }
    const road = new THREE.Mesh(mergeGeos(roadGeos), this.materials.road);
    road.receiveShadow = true;
    road.name = 'roads';
    this.group.add(road);

    // perimeter berm: unambiguous arena edge + a lip you can shoot over
    const bermGeos = [];
    const seg = 12;
    for (let side = 0; side < 4; side++) {
      for (let j = -HALF; j < HALF; j += seg) {
        const x = side === 0 ? j : side === 2 ? j : side === 1 ? HALF - 1 : -HALF + 1;
        const z = side === 0 ? -HALF + 1 : side === 2 ? HALF - 1 : j;
        const y = this.terrain(x, z);
        const g = boxAt(side % 2 === 0 ? seg + 0.4 : 1.4, 2.8, side % 2 === 0 ? 1.4 : seg + 0.4, 0, 0, 0, 0, { uvScale: 2.4 });
        paint(g, shadeColor(0xa9a49a, 0.95));
        bermGeos.push(translate(g, x, y + 1.4, z));
        this.world.addBox(x, y + 1.4, z, side % 2 === 0 ? seg : 1.4, 2.8, side % 2 === 0 ? 1.4 : seg, 'berm', { walkable: false });
        this.stats.colliders++;
      }
    }
    const berm = new THREE.Mesh(mergeGeos(bermGeos), this.materials.merged);
    berm.castShadow = true;
    berm.receiveShadow = true;
    this.group.add(berm);
  }

  /* ------------------------------------------------------ phase: small props */

  #addInstanceProp(family, x, y, z, ry, size, { tag, height, collider = true, cover = false, surface = 'wood' } = {}) {
    family.add(mat4(x, y, z, ry, 1));
    if (collider) this.world.addBox(x, y, z, size.x, height ?? size.y, size.z, tag, { cover, surface });
    this.stats.colliders++;
  }

  #buildProps() {
    const M = this.materials;
    const rng = this.rng;

    // ---- crates: near LOD has corner bracing, far LOD is a plain box
    const crateNear = mergeGeos([
      boxGeo(1.15, 1.05, 1.15, { uvScale: 1.1 }),
      boxAt(1.2, 0.12, 0.14, 0, 0.36, 0.53, 0, { uvScale: 1 }),
      boxAt(1.2, 0.12, 0.14, 0, -0.36, 0.53, 0, { uvScale: 1 }),
      boxAt(1.2, 0.12, 0.14, 0, 0.36, -0.53, 0, { uvScale: 1 }),
      boxAt(0.14, 1.06, 0.14, 0.5, 0, 0.5, 0, { uvScale: 1 }),
      boxAt(0.14, 1.06, 0.14, -0.5, 0, -0.5, 0, { uvScale: 1 }),
      boxAt(0.14, 1.06, 0.14, 0.5, 0, -0.5, 0, { uvScale: 1 }),
      boxAt(0.14, 1.06, 0.14, -0.5, 0, 0.5, 0, { uvScale: 1 }),
    ]);
    const crateFar = boxGeo(1.15, 1.05, 1.15, { uvScale: 1.1 });
    const crates = this.props.create({ name: 'crates', nearGeo: crateNear, farGeo: crateFar, material: M.wood, nearRange: 22, farRange: 55, cullRange: 96, count: 240 });

    const clusters = [
      [-46, 14, 9], [-24, 10, 7], [-52, 30, 8], [-30, 44, 6], [36, 34, 12], [62, 34, 10],
      [70, -20, 7], [8, -44, 6], [-8, 44, 7], [30, 66, 6], [-70, -30, 6], [46, -12, 8],
      [84, 52, 5], [-84, 44, 5], [16, 60, 6], [-14, -66, 5],
    ];
    for (const [cx0, cz0, count] of clusters) {
      for (let i = 0; i < count; i++) {
        const x = cx0 + rand(rng, -5, 5);
        const z = cz0 + rand(rng, -5, 5);
        const ry = rand(rng, -0.4, 0.4);
        const y = this.terrain(x, z);
        const size = rand(rng, 0.95, 1.3);
        crates.add(mat4(x, y + size * 0.52, z, ry, size));
        this.world.addBox(x, y + size * 0.52, z, size * 1.15, size * 1.05, size * 1.15, 'crate', { cover: true, surface: 'wood' });
        this.stats.colliders++;
        if (rng() < 0.32) {
          const s2 = size * rand(rng, 0.7, 0.92);
          crates.add(mat4(x + rand(rng, -0.1, 0.1), y + size * 1.02 + s2 * 0.52, z + rand(rng, -0.1, 0.1), ry + 0.5, s2));
          this.world.addBox(x, y + size * 1.02 + s2 * 0.52, z, s2 * 1.1, s2 * 1.04, s2 * 1.1, 'crate', { cover: true, surface: 'wood' });
        }
      }
    }

    // ---- barrels
    const barrelNear = mergeGeos([
      cylGeo(0.33, 0.33, 0.92, 12, { uvScale: 1.2 }),
      cylGeo(0.36, 0.36, 0.07, 12, { uvScale: 1.2 }),
    ]);
    const barrels = this.props.create({
      name: 'barrels', nearGeo: barrelNear, farGeo: cylGeo(0.33, 0.33, 0.92, 6, { uvScale: 1.2 }),
      material: M.rust, nearRange: 18, farRange: 46, cullRange: 82, count: 110,
    });
    for (const [cx0, cz0, count] of clusters) {
      for (let i = 0; i < Math.max(2, Math.round(count / 3)); i++) {
        const x = cx0 + rand(rng, -7, 7);
        const z = cz0 + rand(rng, -7, 7);
        const y = this.terrain(x, z);
        const tipped = rng() < 0.16;
        barrels.add(mat4(x, y + (tipped ? 0.34 : 0.46), z, rand(rng, 0, 6.28), 1, tipped ? Math.PI / 2 : 0));
        this.world.addBox(x, y + 0.46, z, 0.68, 0.92, 0.68, 'barrel', { surface: 'metal' });
      }
    }

    // ---- jersey barriers + sandbag lines (designated cover)
    const wallNear = mergeGeos([
      boxGeo(3.6, 1.15, 0.7, { uvScale: 2.2 }),
      boxAt(3.7, 0.16, 0.86, 0, 0.6, 0, 0, { uvScale: 2 }),
      boxAt(0.5, 1.3, 0.86, -1.6, 0.07, 0, 0, { uvScale: 2 }),
      boxAt(0.5, 1.3, 0.86, 1.6, 0.07, 0, 0, { uvScale: 2 }),
    ]);
    const walls = this.props.create({
      name: 'barriers', nearGeo: wallNear, farGeo: boxGeo(3.6, 1.15, 0.7, { uvScale: 2.2 }),
      material: M.concrete, nearRange: 24, farRange: 62, cullRange: 106, count: 80,
    });
    const sandNear = mergeGeos(sandbagStack(makeRng(7)));
    const sands = this.props.create({
      name: 'sandbags', nearGeo: sandNear, farGeo: boxGeo(3.4, 0.95, 1.0, { uvScale: 1.6 }),
      material: M.sandbag, nearRange: 20, farRange: 50, cullRange: 90, count: 80,
    });
    for (const b of BARRICADES) {
      const spacing = b.type === 'wall' ? 3.7 : 3.45;
      const count = Math.max(1, Math.round(b.len / spacing));
      for (let i = 0; i < count; i++) {
        const off = (i - (count - 1) / 2) * spacing;
        const x = b.x + (b.alongX ? off : 0);
        const z = b.z + (b.alongX ? 0 : off);
        const y = this.terrain(x, z);
        const ry = b.alongX ? 0 : Math.PI / 2;
        if (b.type === 'wall') {
          walls.add(mat4(x, y + 0.58, z, ry, 1));
          this.world.addBox(x, y + 0.58, z, b.alongX ? 3.6 : 0.74, 1.16, b.alongX ? 0.74 : 3.6, 'cover', { cover: true, surface: 'concrete' });
        } else {
          sands.add(mat4(x, y + 0.47, z, ry, 1));
          this.world.addBox(x, y + 0.47, z, b.alongX ? 3.4 : 1.02, 0.94, b.alongX ? 1.02 : 3.4, 'cover', { cover: true, surface: 'sand' });
        }
        this.stats.colliders++;
      }
    }

    // ---- wrecks: unique merged meshes, great mid-lane cover
    for (const [x, z, ry] of WRECKS) {
      const y = this.terrain(x, z);
      const parts = [
        boxAt(4.3, 1.0, 2.0, 0, 0.85, 0, 0, { uvScale: 1.4 }),
        boxAt(2.1, 0.8, 1.86, -0.2, 1.6, 0, 0, { uvScale: 1.2 }),
        boxAt(4.5, 0.3, 2.1, 0, 0.32, 0, 0, { uvScale: 1.4 }),
        boxAt(1.0, 0.5, 2.14, 2.1, 0.95, 0, 0, { uvScale: 1.2 }),
      ];
      for (const wx of [-1.5, 1.5]) for (const wz of [-0.92, 0.92]) parts.push(boxAt(0.42, 0.86, 0.86, wx, 0.43, wz, 0, { uvScale: 1 }));
      const mesh = new THREE.Mesh(mergeGeos(parts), M.wreck);
      mesh.position.set(x, y, z);
      mesh.rotation.y = ry;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.culler.add(x, z, mesh);
      const cos = Math.abs(Math.cos(ry));
      const sin = Math.abs(Math.sin(ry));
      this.world.addBox(x, y + 0.95, z, 4.5 * cos + 2.1 * sin, 1.9, 4.5 * sin + 2.1 * cos, 'wreck', { cover: true, surface: 'metal' });
      this.stats.colliders++;
    }

    this.#buildOverlook();

    // ---- power poles + drooping lines along the roads
    const poleNear = mergeGeos([
      cylGeo(0.13, 0.2, 8.4, 7, { uvScale: 2.2 }),
      boxAt(2.5, 0.17, 0.17, 0, 3.8, 0, 0, { uvScale: 1 }),
      boxAt(0.22, 0.55, 0.22, 0, 4.2, 0, 0, { uvScale: 1 }),
    ]);
    const poles = this.props.create({
      name: 'poles', nearGeo: poleNear, farGeo: cylGeo(0.16, 0.19, 8.4, 4, { uvScale: 2.2 }),
      material: M.bark, nearRange: 30, farRange: 84, cullRange: 140, count: 40,
    });
    const polePts = [];
    for (let i = -96; i <= 96; i += 24) {
      polePts.push({ x: i, z: -21.5 });
      polePts.push({ x: 24.5, z: i });
    }
    for (const p of polePts) {
      const y = this.terrain(p.x, p.z);
      poles.add(mat4(p.x, y + 4.2, p.z, 0, 1));
      this.world.addBox(p.x, y + 4.2, p.z, 0.44, 8.4, 0.44, 'pole', { walkable: false });
    }
    const linePts = [];
    for (const axis of [0, 1]) {
      for (let i = axis; i < polePts.length - 2; i += 2) {
        const a = polePts[i];
        const b = polePts[i + 2];
        if (Math.hypot(b.x - a.x, b.z - a.z) > 30) continue;
        const ya = this.terrain(a.x, a.z) + 7.8;
        const yb = this.terrain(b.x, b.z) + 7.8;
        for (const off of [-0.85, 0.85]) {
          const mx = (a.x + b.x) / 2;
          const mz = (a.z + b.z) / 2 + off;
          linePts.push(new THREE.Vector3(a.x, ya, a.z + off), new THREE.Vector3(mx, (ya + yb) / 2 - 1.5, mz), new THREE.Vector3(mx, (ya + yb) / 2 - 1.5, mz), new THREE.Vector3(b.x, yb, b.z + off));
        }
      }
    }
    if (linePts.length) {
      const lines = new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(linePts),
        new THREE.LineBasicMaterial({ color: 0x22252a, transparent: true, opacity: 0.9 }),
      );
      lines.name = 'powerlines';
      this.group.add(lines);
    }

    // ---- chain-link fences: block movement, do NOT block bullets or sight
    const fencePanel = mergeGeos([
      boxGeo(3.0, 2.1, 0.08, { uvScale: 3 }),
      boxAt(3.05, 0.12, 0.14, 0, 1.02, 0, 0, { uvScale: 1 }),
      boxAt(3.05, 0.12, 0.14, 0, -1.02, 0, 0, { uvScale: 1 }),
    ]);
    const fence = this.props.create({
      name: 'fences', nearGeo: fencePanel, farGeo: boxGeo(3.0, 2.1, 0.05, { uvScale: 3 }),
      material: M.chainlink, nearRange: 28, farRange: 74, cullRange: 116, count: 260, shadow: false,
    });
    const fencePost = cylGeo(0.08, 0.08, 2.3, 6, { uvScale: 1 });
    const posts = this.props.create({
      name: 'fenceposts', nearGeo: fencePost, farGeo: fencePost, material: M.metalDark,
      nearRange: 40, farRange: 300, cullRange: 300, count: 150, shadow: false,
    });
    const fenceRuns = [
      { x0: 22, z0: 34, x1: 92, z1: 34, skip: [[58, 66]] },
      { x0: 22, z0: 62, x1: 92, z1: 62, skip: [[44, 52]] },
      { x0: 22, z0: 34, x1: 22, z1: 62 },
      { x0: 92, z0: 34, x1: 92, z1: 62 },
      { x0: -86, z0: -4, x1: -36, z1: -4, skip: [-1e9, -1e9] },
      { x0: -36, z0: -4, x1: -36, z1: 18 },
      { x0: -70, z0: 56, x1: -70, z1: 80 },
      { x0: 34, z0: -70, x1: 74, z1: -70, skip: [[50, 58]] },
    ];
    for (const run of fenceRuns) {
      const dx = run.x1 - run.x0;
      const dz = run.z1 - run.z0;
      const len = Math.hypot(dx, dz);
      const count = Math.max(1, Math.floor(len / 3));
      const ry = Math.atan2(dx, dz) - Math.PI / 2;
      for (let i = 0; i < count; i++) {
        const t = (i + 0.5) / count;
        const x = run.x0 + dx * t;
        const z = run.z0 + dz * t;
        if (run.skip && Array.isArray(run.skip[0]) === false && x > run.skip[0] && x < run.skip[1]) continue;
        if (run.skip && Array.isArray(run.skip[0])) {
          let skip = false;
          for (const [s0, s1] of run.skip) if (x > s0 && x < s1) skip = true;
          if (skip) continue;
        }
        const y = this.terrain(x, z);
        fence.add(mat4(x, y + 1.05, z, ry, 1));
        if (i % 2 === 0) posts.add(mat4(x, y + 1.12, z, 0, 1));
        this.world.addBox(x, y + 1.05, z, Math.abs(Math.cos(ry)) * 3 + 0.08, 2.1, Math.abs(Math.sin(ry)) * 3 + 0.08, 'fence', { walkable: false });
      }
    }
  }

  #buildOverlook() {
    const { x, z, w, d, h } = OVERLOOK;
    const y0 = this.terrain(x, z);
    const geos = [];
    const colliders = [];
    geos.push(translate(boxAt(w, 0.44, d, 0, 0, 0, 0, { uvScale: 3.2 }), x, y0 + h, z));
    colliders.push({ pos: [x, y0 + h, z], size: [w, 0.44, d], tag: 'deck' });
    for (const px of [x - w / 2 + 1.1, x + w / 2 - 1.1]) {
      for (const pz of [z - d / 2 + 1.1, z + d / 2 - 1.1]) {
        geos.push(translate(boxAt(1.1, h, 1.1, 0, 0, 0, 0, { uvScale: 2 }), px, y0 + h / 2, pz));
        colliders.push({ pos: [px, y0 + h / 2, pz], size: [1.1, h, 1.1], tag: 'pillar' });
      }
    }
    for (const [ox, oz, pw, pd] of [[0, -d / 2 + 0.25, w, 0.5], [0, d / 2 - 0.25, w, 0.5], [w / 2 - 0.25, 0, 0.5, d]]) {
      geos.push(translate(boxAt(pw, 0.95, pd, 0, 0, 0, 0, { uvScale: 2 }), x + ox, y0 + h + 0.7, z + oz));
      colliders.push({ pos: [x + ox, y0 + h + 0.7, z + oz], size: [pw, 0.95, pd], tag: 'parapet', cover: true });
    }
    const steps = Math.max(4, Math.ceil(h / 0.4));
    for (let i = 0; i < steps; i++) {
      const topH = ((i + 1) / steps) * h;
      const sx = x - w / 2 - (steps - i) * 1.4 + 0.7;
      const sz = z - 2.2;
      geos.push(translate(boxAt(1.45, topH + 0.3, 3.6, 0, 0, 0, 0, { uvScale: 2 }), sx, y0 + (topH + 0.3) / 2 - 0.3, sz));
      colliders.push({ pos: [sx, y0 + (topH + 0.3) / 2 - 0.3, sz], size: [1.45, topH + 0.3, 3.6], tag: 'stairs' });
    }
    for (let i = 0; i < 3; i++) {
      const px = x - w / 2 + 3.4 + i * 1.8;
      const pz = z - d / 2 + 1.5;
      geos.push(translate(boxAt(1.7, 0.52, 0.95, 0, 0, 0, 0, { uvScale: 1.4 }), px, y0 + h + 0.48, pz));
      colliders.push({ pos: [px, y0 + h + 0.48, pz], size: [1.7, 0.52, 0.95], tag: 'cover', cover: true });
    }
    const mesh = new THREE.Mesh(mergeGeos(geos), this.materials.merged);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'overlook';
    this.culler.add(x, z, mesh);
    for (const c of colliders) {
      this.world.addBox(c.pos[0], c.pos[1], c.pos[2], c.size[0], c.size[1], c.size[2], c.tag, {
        walkable: c.tag !== 'parapet',
        cover: !!c.cover,
        surface: 'concrete',
      });
      this.stats.colliders++;
    }
    this.hearths.push({ x: x - 3, z: z + 3, role: 'overwatch' }, { x: x + 5, z: z - 3, role: 'overwatch' });
  }

  /* --------------------------------------------------- phase: vegetation */

  #buildVegetation() {
    const M = this.materials;
    const rng = this.rng;
    const freeSpot = (x, z, clearance = 3.2) => {
      if (Math.abs(x) > HALF - 12 || Math.abs(z) > HALF - 12) return false;
      for (const id of this.world.boxIdsInXZ(x - clearance, x + clearance, z - clearance, z + clearance)) {
        const b = this.world.boxes[id];
        if (b.tag === 'fence' || b.tag === 'pole' || b.tag === 'debris') continue;
        if (x > b.min.x - clearance && x < b.max.x + clearance && z > b.min.z - clearance && z < b.max.z + clearance) return false;
      }
      return true;
    };

    // trees: detailed crown vs. 4-sided spike for the far LOD
    const trunk = cylGeo(0.3, 0.5, 4.8, 7, { uvScale: 2.2 });
    paint(trunk, shadeColor(0x6b5540, 1));
    const crown1 = place(cylGeo(0.02, 3.0, 4.6, 8, { uvScale: 3 }), { pos: [0, 4.3, 0] });
    paint(crown1, shadeColor(0x4d6039, 1));
    const crown2 = place(cylGeo(0.02, 2.0, 3.2, 7, { uvScale: 3 }), { pos: [0, 6.4, 0] });
    paint(crown2, shadeColor(0x59703f, 1));
    const treeNear = mergeGeos([trunk, crown1, crown2]);
    const treeFar = mergeGeos([
      cylGeo(0.34, 0.46, 4.6, 4, { uvScale: 2.2 }),
      place(cylGeo(0.02, 2.7, 7.2, 4, { uvScale: 3 }), { pos: [0, 5.6, 0] }),
    ]);
    const trees = this.props.create({ name: 'trees', nearGeo: treeNear, farGeo: treeFar, material: M.foliage, nearRange: 34, farRange: 92, cullRange: 155, count: 130 });
    const spots = [...scatter(rng, 34, freeSpot, 30, 106), ...scatter(rng, 14, (x, z) => freeSpot(x, z) && z > 36 && x < -14, 0, 1e9)];
    for (const p of spots) {
      const y = this.terrain(p.x, p.z);
      const s = rand(rng, 0.8, 1.4);
      trees.add(mat4(p.x, y + 2.4 * s, p.z, rand(rng, 0, 6.28), s));
      this.world.addBox(p.x, y + 2.4, p.z, 0.85, 4.8, 0.85, 'tree', { walkable: false });
      this.stats.colliders++;
    }

    // rocks
    const rockNear = paint(jitterSphere(new THREE.IcosahedronGeometry(1, 1), rng, 0.22), shadeColor(0x82837a, 1));
    const rockFar = paint(jitterSphere(new THREE.IcosahedronGeometry(1, 0), rng, 0.16), shadeColor(0x82837a, 1));
    const rocks = this.props.create({ name: 'rocks', nearGeo: rockNear, farGeo: rockFar, material: M.rock, nearRange: 24, farRange: 64, cullRange: 116, count: 130 });
    for (const p of scatter(rng, 66, (x, z) => freeSpot(x, z, 1.6) || Math.hypot(x, z) > 88, 10, 1e9)) {
      const s = rand(rng, 0.55, 1.9);
      const y = this.terrain(p.x, p.z);
      rocks.add(mat4(p.x, y + s * 0.5, p.z, rand(rng, 0, 6.28), s, 0, rand(rng, -0.18, 0.18)));
      this.world.addBox(p.x, y + s * 0.5, p.z, s * 1.7, s * 1.1, s * 1.7, 'rock', { cover: s > 1.15, surface: 'rock' });
    }

    // rubble around the ruins
    const rubbleGeos = [];
    for (const b of BUILDINGS.filter((bb) => (bb.ruin ?? 0) > 0.3)) {
      const y = this.terrain(b.x, b.z);
      for (let i = 0; i < 8; i++) {
        const x = b.x + rand(rng, -b.w, b.w);
        const z = b.z + rand(rng, -b.d, b.d);
        if (Math.hypot(x - b.x, z - b.z) < Math.max(b.w, b.d) * 0.45) continue;
        const gy = this.terrain(x, z);
        const s = rand(rng, 0.5, 1.5);
        rubbleGeos.push(translate(boxAt(s * 1.6, s * 0.7, s * 1.4, 0, 0, 0, rand(rng, -1, 1), { uvScale: 1.6 }), x, gy + s * 0.25, z));
        this.world.addBox(x, gy + s * 0.26, z, s * 1.6, s * 0.62, s * 1.4, 'rubble', { cover: s > 0.95, surface: 'concrete' });
      }
    }
    if (rubbleGeos.length) {
      const mesh = new THREE.Mesh(mergeGeos(rubbleGeos), this.materials.merged);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = 'rubble';
      this.group.add(mesh);
    }

    // ground detail: concrete chunks (visual only, no colliders, near-camera only)
    const chunk = boxGeo(0.5, 0.14, 0.42, { uvScale: 1 });
    const chunks = this.props.create({ name: 'debris', nearGeo: chunk, farGeo: chunk, material: M.merged, nearRange: 18, farRange: 38, cullRange: 52, count: 420, shadow: false });
    for (let i = 0; i < 300; i++) {
      const x = rand(rng, -HALF + 8, HALF - 8);
      const z = rand(rng, -HALF + 8, HALF - 8);
      chunks.add(mat4(x, this.terrain(x, z) + 0.07, z, rand(rng, 0, 6.28), rand(rng, 0.5, 1.9)));
    }
  }

  /* ------------------------------------------------------- phase: AI data */

  #bakeNav() {
    this.nav = new NavGrid({ world: this.world, halfSize: HALF - 4, cell: 1.5, agentRadius: 0.5, agentHeight: 1.78 });
    this.nav.bake();
    const rng = this.rng;
    const nodes = [];
    for (let i = 0; i < this.nav.blocked.length; i++) {
      if (this.nav.blocked[i]) continue;
      const p = this.nav.toPos(i);
      if (Math.hypot(p.x, p.z) > HALF - 12) continue;
      nodes.push(p);
    }
    this.patrolNodes = [];
    for (let i = 0; i < 16; i++) this.patrolNodes.push(pick(rng, nodes));
    for (const hh of this.hearths) {
      const cell = this.nav.nearestWalkable(hh.x, hh.z, 8);
      if (cell >= 0) {
        const p = this.nav.toPos(cell);
        hh.x = p.x;
        hh.z = p.z;
        hh.y = this.nav.height[cell];
        this.patrolNodes.push(p);
      }
    }
    // Spawns: the player starts behind cover with the depot in view; the
    // machine starts 60-80 m away so the match opens with a search phase.
    // Every spawn is then snapped onto the nav mesh (never inside a wall) and
    // turned to face the middle of the arena.
    const rawPlayer = [
      { x: 0, z: 30, yaw: 0 },
      { x: -22, z: 44, yaw: -0.7 },
      { x: 12, z: 14, yaw: 0 },
    ];
    const rawAi = [
      { x: 4, z: -42 },
      { x: 30, z: -34 },
      { x: -30, z: -48 },
    ];
    const snap = (list, radius = 14) =>
      list.map((s) => {
        const direct = this.nav.toCell(s.x, s.z);
        const cell = this.nav.walkable(direct) ? direct : this.nav.nearestWalkable(s.x, s.z, radius);
        if (cell < 0) return { ...s, y: this.ground(s.x, s.z) };
        const p = this.nav.toPos(cell);
        return { ...s, x: p.x, z: p.z, y: this.nav.height[cell] };
      });
    this.spawns.ai = snap(rawAi);
    const cx = this.spawns.ai.reduce((a, s) => a + s.x, 0) / this.spawns.ai.length;
    const cz = this.spawns.ai.reduce((a, s) => a + s.z, 0) / this.spawns.ai.length;
    this.spawns.player = snap(rawPlayer).map((s) => ({
      ...s,
      yaw: Math.atan2(-(cx - s.x), -(cz - s.z)),
    }));
  }

  #buildCoverPoints() {
    const agentR = 0.6;
    let candidates = 0;
    for (const b of this.world.boxes) {
      if (!b.cover) continue;
      candidates++;
      const top = b.max.y;
      // the base level beside this box: asking for the ground *below* the box
      // top is what keeps the box itself from being read as its own floor
      const ground = this.world.groundHeightAt(b.center.x, b.center.z, top - 0.05);
      const above = top - ground;
      if (above < 0.45 || above > 3.6) continue;
      for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const faceX = nx > 0 ? b.max.x : b.min.x;
        const faceZ = nz > 0 ? b.max.z : b.min.z;
        const alongHalf = nx !== 0 ? (b.max.z - b.min.z) / 2 : (b.max.x - b.min.x) / 2;
        const offsets = alongHalf > 2.4 ? [-alongHalf * 0.6, 0, alongHalf * 0.6] : [0];
        for (const off of offsets) {
          const px = nx !== 0 ? faceX + nx * (agentR + 0.4) : b.center.x + off;
          const pz = nz !== 0 ? faceZ + nz * (agentR + 0.4) : b.center.z + off;
          const cell = this.nav.toCell(px, pz);
          if (!this.nav.walkable(cell)) continue;
          const p = this.nav.toPos(cell);
          const gy = this.nav.height[cell];
          // the stand spot has to sit on the same level as the box base,
          // otherwise "cover" would mean jumping off a roof
          if (Math.abs(gy - ground) > 0.9) continue;
          this.coverPoints.push({ x: p.x, z: p.z, y: gy, nx: -nx, nz: -nz, top, hard: above > 0.95, box: b });
        }
      }
    }
    this.stats.cover = this.coverPoints.length;
    this.stats.coverCandidates = candidates;
  }

  /* -------------------------------------------------------------- queries */

  ground(x, z) {
    return this.world.groundHeightAt(x, z, Infinity);
  }

  heightAt(x, z) {
    return this.terrain(x, z);
  }

  /** Best cover spot for an agent at (fromX,fromZ) against a threat. */
  coverFor(fromX, fromZ, threatX, threatZ, { minRange = 5, maxRange = 34, needHard = true } = {}) {
    let best = null;
    for (const c of this.coverPoints) {
      const d = Math.hypot(c.x - fromX, c.z - fromZ);
      if (d < minRange || d > maxRange) continue;
      if (needHard && !c.hard) continue;
      const tdx = threatX - c.x;
      const tdz = threatZ - c.z;
      const tl = Math.hypot(tdx, tdz) || 1;
      const facing = (tdx / tl) * c.nx + (tdz / tl) * c.nz;
      if (facing < 0.4) continue;
      const score = facing * 2.4 - d * 0.05 + (c.hard ? 0.6 : 0) - Math.abs(tl - 15) * 0.02;
      if (!best || score > best.score) best = { c, score };
    }
    return best ? best.c : null;
  }

  pathTo(fromPos, toPos, opts) {
    const a = this.nav.toCell(fromPos.x, fromPos.z);
    const b = this.nav.toCell(toPos.x, toPos.z);
    const raw = this.nav.findPath(a, b, opts);
    if (!raw) return null;
    return this.nav.smoothPath(raw);
  }
}

/* ------------------------------------------------------- local helpers */

function scatter(rng, count, test, min = 0, max = 1e9) {
  const pts = [];
  let guard = 0;
  while (pts.length < count && guard++ < count * 60) {
    const x = rand(rng, -HALF + 8, HALF - 8);
    const z = rand(rng, -HALF + 8, HALF - 8);
    const d = Math.hypot(x, z);
    if (d < min || d > max) continue;
    if (test(x, z)) pts.push({ x, z });
  }
  return pts;
}

/** Sloped ground quad used for road decks. */
function makeQuad(p0, p1, p2, p3, heightFn, lift) {
  const g = new THREE.BufferGeometry();
  const pts = [p0, p1, p2, p0, p2, p3];
  const uvs = [[0, 1], [1, 1], [1, 0], [0, 1], [1, 0], [0, 0]];
  const verts = new Float32Array(18);
  const uvArr = new Float32Array(12);
  for (let i = 0; i < 6; i++) {
    const [px, pz] = pts[i];
    verts[i * 3] = px;
    verts[i * 3 + 1] = heightFn(px, pz) + lift;
    verts[i * 3 + 2] = pz;
    uvArr[i * 2] = uvs[i][0] * 3;
    uvArr[i * 2 + 1] = uvs[i][1] * 0.8;
  }
  g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(18).fill(0), 3));
  g.computeVertexNormals();
  return g;
}

function sandbagStack(rng) {
  const geos = [];
  for (let row = 0; row < 3; row++) {
    const y = 0.16 + row * 0.3;
    const n = row === 1 ? 5 : 6;
    for (let i = 0; i < n; i++) {
      const x = -1.6 + (i + 0.5) * (3.2 / n) + (row % 2 ? 0.22 : 0);
      geos.push(place(boxGeo(0.62, 0.28, 0.95, { uvScale: 0.9 }), { pos: [x, y, rand(rng, -0.06, 0.06)], rot: [0, rand(rng, -0.12, 0.12), 0] }));
    }
  }
  return geos;
}
