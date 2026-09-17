/**
 * Heightfield — analytic terrain elevation.
 *
 * `createTerrain()` returns a height function that both the terrain mesh and
 * the physics ground query use, so collision can never disagree with rendering.
 * Structures (buildings, pads, platforms) register *flattening rects* before
 * the mesh is generated, which is why props sit flush on the ground instead of
 * floating over or sinking into the hills.
 */
import { fbm, smoothstep, clamp } from '../core/math.js';
import { WORLD } from '../config/GameConfig.js';

/** Road corridors in metres, arena space. Roads also flatten the terrain. */
export const ROADS = [
  { a: { x: -WORLD.bounds, z: -14 }, b: { x: WORLD.bounds, z: -14 }, width: 11 },
  { a: { x: 18, z: -WORLD.bounds }, b: { x: 18, z: WORLD.bounds }, width: 11 },
  { a: { x: -72, z: 42 }, b: { x: 64, z: 44 }, width: 8 },
  { a: { x: -66, z: -84 }, b: { x: -60, z: 62 }, width: 6 },
  { a: { x: 60, z: -66 }, b: { x: -34, z: 76 }, width: 5.5 },
];

export const HILLS = [
  { x: 66, z: -62, r: 46, h: 13.5 },
  { x: -82, z: 74, r: 40, h: 9.5 },
  { x: 92, z: 74, r: 34, h: 7.5 },
];

const TRENCH = { a: { x: -104, z: 2 }, b: { x: -4, z: -78 }, width: 16, depth: 4.4 };

export function roadWeight(x, z) {
  let w = 0;
  for (const r of ROADS) {
    const dx = r.b.x - r.a.x;
    const dz = r.b.z - r.a.z;
    const len2 = dx * dx + dz * dz;
    const t = clamp(((x - r.a.x) * dx + (z - r.a.z) * dz) / len2, 0, 1);
    const d = Math.hypot(x - (r.a.x + dx * t), z - (r.a.z + dz * t));
    w = Math.max(w, 1 - smoothstep(r.width * 0.5, r.width * 0.5 + 7, d));
  }
  return w;
}

export function isRoad(x, z) {
  return roadWeight(x, z) > 0.62;
}

/**
 * Builds the arena height function.
 * @param {Array<{x:number,z:number,w:number,d:number,y:number,pad?:number}>} flatteners
 */
export function createTerrain(flatteners = []) {
  function flattenLevel(x, z) {
    let level = null;
    let weight = 0;
    for (const f of flatteners) {
      const hw = f.w / 2 + (f.pad ?? 4);
      const hd = f.d / 2 + (f.pad ?? 4);
      const dx = Math.abs(x - f.x);
      const dz = Math.abs(z - f.z);
      if (dx > hw * 2 || dz > hd * 2) continue;
      const tx = 1 - smoothstep(hw, hw * 2, dx);
      const tz = 1 - smoothstep(hd, hd * 2, dz);
      const w = Math.min(tx, tz);
      if (w > weight) {
        weight = w;
        level = f.y;
      }
    }
    return { level, weight };
  }

  return function terrainHeight(x, z) {
    const r = Math.max(Math.abs(x), Math.abs(z));
    const outside = smoothstep(52, 106, r);
    let h = fbm(x * 0.013 + 4.2, z * 0.013 - 2.7, 4) * 3.1 + fbm(x * 0.05, z * 0.05, 2) * 0.5;
    h *= 0.14 + 0.86 * outside;

    for (const hill of HILLS) {
      const d = Math.hypot(x - hill.x, z - hill.z);
      h += hill.h * (1 - smoothstep(hill.r * 0.32, hill.r, d));
    }

    // dry riverbed
    const tdx = TRENCH.b.x - TRENCH.a.x;
    const tdz = TRENCH.b.z - TRENCH.a.z;
    const tt = clamp(((x - TRENCH.a.x) * tdx + (z - TRENCH.a.z) * tdz) / (tdx * tdx + tdz * tdz), 0, 1);
    const tdist = Math.hypot(x - (TRENCH.a.x + tdx * tt), z - (TRENCH.a.z + tdz * tt));
    h -= TRENCH.depth * (1 - smoothstep(TRENCH.width * 0.4, TRENCH.width, tdist));

    // road corridors get flattened towards the local base level
    const rw = roadWeight(x, z);
    if (rw > 0) h *= 1 - 0.94 * rw;

    // structure pads
    if (flatteners.length) {
      const { level, weight } = flattenLevel(x, z);
      if (weight > 0) h = h * (1 - weight) + level * weight;
    }
    return h;
  };
}

/** Terrain render geometry, colour-banded by slope so the ground reads cheaply. */
export function buildTerrainGeometry(THREE, heightFn) {
  const size = WORLD.terrainSize;
  const seg = WORLD.terrainSegments;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const uvArr = new Float32Array(pos.count * 2);
  const cGrass = [0.31, 0.34, 0.23];
  const cDirt = [0.41, 0.35, 0.25];
  const cRock = [0.4, 0.4, 0.38];
  const cSand = [0.52, 0.48, 0.37];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = heightFn(x, z);
    pos.setY(i, h);
    const slope =
      Math.abs(heightFn(x + 2, z) - heightFn(x - 2, z)) + Math.abs(heightFn(x, z + 2) - heightFn(x, z - 2));
    const t = clamp(slope * 0.3, 0, 1);
    const n = (fbm(x * 0.11, z * 0.11, 2) + 1) * 0.5;
    let col;
    if (h < -1.6) col = cSand;
    else if (isRoad(x, z)) col = cDirt;
    else col = t > 0.42 ? cRock : n > 0.56 ? cDirt : cGrass;
    const shade = 0.84 + n * 0.3 - t * 0.08;
    colors[i * 3] = col[0] * shade;
    colors[i * 3 + 1] = col[1] * shade;
    colors[i * 3 + 2] = col[2] * shade;
    uvArr[i * 2] = x / 8;
    uvArr[i * 2 + 1] = z / 8;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
  geo.computeVertexNormals();
  return geo;
}
