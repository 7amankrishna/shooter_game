/**
 * Heightfield — the infinite, analytic world terrain.
 *
 * `heightAt`/`normalAt`/`biomeAt` are pure functions of (x, z, seed): the same
 * input always yields the same height, on both sides of a chunk border, which
 * is what keeps streamed terrain seamless without stitching. Structures and
 * towers register *flattening pads* into a spatial grid so props sit flush on
 * the ground; the pads are deterministic from the world layout, so a pad is
 * always present before its chunk's terrain is ever sampled for rendering.
 *
 * Biomes (forest / field / rocky / deadland) drive amplitude, ground colour and
 * vegetation in the chunk generator, so regions read differently as you travel.
 */
import { fbm, smoothstep, clamp, makeRng } from '../core/math.js';
import { WORLD } from '../config/GameConfig.js';

/** A winding supply road through the world — orientation + fast travel lane. */
export function roadCenterZ(x) {
  return 55 * Math.sin(x * 0.006) + 22 * Math.sin(x * 0.0173 + 2.1);
}

export function roadWeight(x, z) {
  const d = Math.abs(z - roadCenterZ(x));
  return 1 - smoothstep(4.5, 12, d);
}

export function isRoad(x, z) {
  return roadWeight(x, z) > 0.62;
}

/**
 * Spatial registry of terrain-flattening pads. Registering into every grid
 * cell an expanded pad touches means a border vertex sees a neighbour chunk's
 * pad without any cross-chunk bookkeeping.
 */
export class FlattenerGrid {
  constructor(cell = WORLD.chunkSize) {
    this.cell = cell;
    this.map = new Map();
  }

  #cellsFor(f) {
    const pad = f.pad ?? 4;
    const x0 = Math.floor((f.x - f.w / 2 - pad * 2) / this.cell);
    const x1 = Math.floor((f.x + f.w / 2 + pad * 2) / this.cell);
    const z0 = Math.floor((f.z - f.d / 2 - pad * 2) / this.cell);
    const z1 = Math.floor((f.z + f.d / 2 + pad * 2) / this.cell);
    const out = [];
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) out.push(cx * 8192 + cz);
    }
    return out;
  }

  add(f) {
    for (const k of this.#cellsFor(f)) {
      let arr = this.map.get(k);
      if (!arr) this.map.set(k, (arr = []));
      arr.push(f);
    }
    return f;
  }

  removeSet(set) {
    for (const [k, arr] of this.map) {
      const next = arr.filter((f) => !set.has(f));
      if (next.length !== arr.length) this.map.set(k, next);
    }
  }

  /** Strongest pad weight at (x, z): { level, weight } */
  sample(x, z) {
    const k = Math.floor(x / this.cell) * 8192 + Math.floor(z / this.cell);
    const arr = this.map.get(k);
    if (!arr) return EMPTY;
    let level = null;
    let weight = 0;
    for (const f of arr) {
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
    return weight > 0 ? { level, weight } : EMPTY;
  }
}

const EMPTY = { level: null, weight: 0 };

export class WorldTerrain {
  constructor({ seed = WORLD.seed } = {}) {
    this.seed = seed;
    const rng = makeRng(seed ^ 0x5f3759df);
    // per-seed character: amplitude, roughness, ridge strength
    this.amp = 4.4 + rng() * 2.2;
    this.rough = 0.9 + rng() * 0.5;
    this.ridgeAmp = 7.5 + rng() * 5;
    this.o1 = rng() * 40;
    this.o2 = rng() * 40;
    this.flats = new FlattenerGrid();
    // the spawn camp sits on level ground whatever the seed rolls
    this.spawnLevel = this.#raw(0, 0);
  }

  /** Biome weights at (x, z): forest, rocky, dead, field (field = remainder). */
  biomeAt(x, z) {
    // three independent channels so every blend (and pure open field) exists
    const nf = fbm(x * 0.0015 + this.o1, z * 0.0015 - this.o1, 2);
    const nr = fbm(x * 0.0019 - this.o2, z * 0.0019 + this.o2, 2);
    const nd = fbm(x * 0.0013 + this.o2, z * 0.0013 - this.o2, 2);
    const forest = clamp((nf - 0.02) / 0.26, 0, 1);
    const rocky = clamp((nr - 0.08) / 0.2, 0, 1);
    const dead = clamp((nd - 0.1) / 0.2, 0, 1);
    const field = 0.34; // baseline — open ground wherever the others fade out
    const total = forest + rocky + dead + field;
    return {
      forest: forest / total,
      rocky: rocky / total,
      dead: dead / total,
      field: field / total,
    };
  }

  #raw(x, z) {
    const base = fbm(x * 0.0085 + this.o2, z * 0.0085 - this.o1, 4) * this.amp;
    const hills = fbm(x * 0.028 - this.o1, z * 0.028 + this.o2, 3) * 3.4;
    const detail = fbm(x * 0.055, z * 0.055, 2) * 0.5 * this.rough;
    const b = this.biomeAt(x, z);
    let h = base + hills + detail;
    // rocky ridges: inverted-noise ridges, only where the biome wants them
    const r = 1 - Math.abs(fbm(x * 0.022 - this.o1, z * 0.022 + this.o2, 3));
    h += r * r * (this.ridgeAmp + 6) * b.rocky;
    // deadland: flatter, sunken, eerie
    h = h * (1 - 0.35 * b.dead) - 0.6 * b.dead;
    return h;
  }

  heightAt(x, z) {
    let h = this.#raw(x, z);
    // supply road: damped corridor so it stays traversable but not flat
    const rw = roadWeight(x, z);
    if (rw > 0) h *= 1 - 0.86 * rw;
    // spawn clearing
    const cw = 1 - smoothstep(WORLD.spawnClearing * 0.72, WORLD.spawnClearing * 1.3, Math.hypot(x, z));
    if (cw > 0) h = h * (1 - cw) + this.spawnLevel * cw;
    // structure pads (deterministic, registered by the chunk layout)
    const f = this.flats.sample(x, z);
    if (f.weight > 0) h = h * (1 - f.weight) + f.level * f.weight;
    return h;
  }

  normalAt(x, z, out = { x: 0, y: 1, z: 0 }) {
    const e = 1.1;
    const nx = this.heightAt(x - e, z) - this.heightAt(x + e, z);
    const nz = this.heightAt(x, z - e) - this.heightAt(x, z + e);
    const len = Math.hypot(nx, 2 * e, nz) || 1;
    out.x = nx / len;
    out.y = (2 * e) / len;
    out.z = nz / len;
    return out;
  }

  /** Ground steepness 0..1 at a point (1 = 45°+). */
  slopeAt(x, z) {
    const n = this.normalAt(x, z, _n);
    return 1 - n.y;
  }
}

const _n = { x: 0, y: 1, z: 0 };

/**
 * Terrain mesh for one chunk.
 *
 * A height grid with a one-cell border is sampled once; heights, normals and
 * colours all derive from that grid. Because border samples come from the same
 * analytic function the neighbour chunk uses, normals match exactly across
 * chunk seams — no stitching, no visible transitions.
 */
export function buildChunkGeometry(THREE, terrain, cx, cz, size, segments) {
  const geo = new THREE.PlaneGeometry(size, size, segments, segments);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const ox = cx * size + size / 2;
  const oz = cz * size + size / 2;
  const step = size / segments;
  // (segments+3)² grid: one extra cell of border on every side
  const N = segments + 3;
  const heights = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = ox - size / 2 + (i - 1) * step;
      const z = oz - size / 2 + (j - 1) * step;
      heights[j * N + i] = terrain.heightAt(x, z);
    }
  }
  const colors = new Float32Array(pos.count * 3);
  const normals = new Float32Array(pos.count * 3);
  const cGrass = [0.3, 0.35, 0.22];
  const cGrassDry = [0.42, 0.39, 0.24];
  const cRock = [0.42, 0.41, 0.38];
  const cDead = [0.34, 0.31, 0.25];
  const cRoad = [0.36, 0.35, 0.33];
  // PlaneGeometry vertex order: row-major from -x,-z
  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i);
    const vz = pos.getZ(i);
    const gx = Math.round((vx + size / 2) / step + 1);
    const gz = Math.round((vz + size / 2) / step + 1);
    const h = heights[gz * N + gx];
    pos.setY(i, Number.isFinite(h) ? h : terrain.heightAt(vx + ox, vz + oz));
    const hl = heights[gz * N + gx - 1];
    const hr = heights[gz * N + gx + 1];
    const hd = heights[(gz - 1) * N + gx];
    const hu = heights[(gz + 1) * N + gx];
    const nx = (hl - hr) / (2 * step);
    const nz2 = (hd - hu) / (2 * step);
    const len = Math.hypot(nx, 1, nz2) || 1;
    normals[i * 3] = nx / len;
    normals[i * 3 + 1] = 1 / len;
    normals[i * 3 + 2] = nz2 / len;
    const slope = 1 - 1 / len;
    const x = vx + ox;
    const z = vz + oz;
    const b = terrain.biomeAt(x, z);
    let col;
    if (isRoad(x, z)) col = cRoad;
    else if (slope > 0.34 || b.rocky > 0.55) col = cRock;
    else if (b.dead > 0.45) col = cDead;
    else {
      const t = b.forest;
      col = [
        cGrass[0] * (1 - t * 0.5),
        cGrass[1] * (1 - t * 0.4) + t * 0.04,
        cGrass[2] * (1 - t * 0.3),
      ];
      void cGrassDry;
    }
    const n2 = (fbm(x * 0.11, z * 0.11, 2) + 1) * 0.5;
    const shade = 0.82 + n2 * 0.3 - slope * 0.08;
    colors[i * 3] = col[0] * shade;
    colors[i * 3 + 1] = col[1] * shade;
    colors[i * 3 + 2] = col[2] * shade;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.translate(ox, 0, oz);
  return geo;
}
