/**
 * Structures — deterministic parametric buildings for the streamed world.
 *
 * Every builder is pure: given a position, a ground level and the chunk's RNG
 * it returns merged geometry + collider specs + a terrain-flattening pad. The
 * chunk generator owns the results, which is what makes chunk load/unload
 * symmetric (remove colliders + pads with the chunk, no dangling state).
 *
 * Design constraint: structures are placed inside the central zone of a chunk
 * and their flattening pads never reach a chunk border, so terrain seams and
 * cross-chunk pad bookkeeping are impossible by construction.
 */
import * as THREE from 'three';
import { boxGeo, boxAt, cylGeo, mergeGeos, paint, place } from '../core/Geo.js';
import { clamp, rand, smoothstep } from '../core/math.js';
import { TOWERS } from '../config/GameConfig.js';

const shade = (hex, k) => new THREE.Color(hex).multiplyScalar(k);

/* ------------------------------------------------------------- watchtower */

/**
 * Steel watchtower: the safe rest point. Platform high enough that the dead
 * cannot reach you, railings so you cannot fall off, a lamp that reads from a
 * distance at night, and a ladder side that is the E-interaction point.
 */
export function buildWatchtower(x, z, baseY, mats) {
  const h = TOWERS.platformHeight;
  const half = TOWERS.platformHalf;
  const geos = [];
  const colliders = [];
  const legOff = half - 0.5;

  // legs
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const lx = x + sx * legOff;
      const lz = z + sz * legOff;
      geos.push(place(boxGeo(0.3, h, 0.3, { uvScale: 1.6 }), { pos: [lx, baseY + h / 2, lz] }));
      colliders.push({ x: lx, y: baseY + h / 2, z: lz, sx: 0.34, sy: h, sz: 0.34, tag: 'structure', walkable: false });
    }
  }
  // cross braces (visual only)
  for (const sz of [-1, 1]) {
    for (const lvl of [0, 1]) {
      const y0 = baseY + 0.8 + lvl * (h / 2);
      geos.push(place(boxGeo(0.12, 0.12, Math.hypot(legOff * 2, h / 2) , { uvScale: 1 }), {
        pos: [x, y0 + h / 4, z + sz * legOff],
        rot: [Math.atan2(h / 2, legOff * 2), 0, 0],
      }));
      geos.push(place(boxGeo(Math.hypot(legOff * 2, h / 2), 0.12, 0.12, { uvScale: 1 }), {
        pos: [x, y0 + h / 4, z + sz * legOff],
        rot: [0, 0, Math.atan2(h / 2, legOff * 2)],
      }));
    }
  }
  // platform (walkable top)
  geos.push(place(paint(boxGeo(half * 2 + 0.6, 0.26, half * 2 + 0.6, { uvScale: 2.4 }), shade(0x6d5c44, 1)), { pos: [x, baseY + h, z] }));
  colliders.push({ x, y: baseY + h, z, sx: half * 2 + 0.6, sy: 0.26, sz: half * 2 + 0.6, tag: 'deck', walkable: true, surface: 'wood' });
  // plank lines
  for (let i = -half + 0.5; i < half; i += 0.72) {
    geos.push(place(boxGeo(0.07, 0.05, half * 2 + 0.4, { uvScale: 1 }), { pos: [x + i, baseY + h + 0.16, z] }));
  }
  // railings: enclose the platform (no falling, no zombies)
  const railY = baseY + h + 0.75;
  for (const [nx, nz, w, d] of [
    [0, -1, half * 2 + 0.6, 0.14],
    [0, 1, half * 2 + 0.6, 0.14],
    [-1, 0, 0.14, half * 2 + 0.6],
    [1, 0, 0.14, half * 2 + 0.6],
  ]) {
    const rx = x + nx * (half + 0.25);
    const rz = z + nz * (half + 0.25);
    geos.push(place(boxGeo(w, 1.0, d, { uvScale: 1.4 }), { pos: [rx, railY, rz] }));
    colliders.push({ x: rx, y: railY, z: rz, sx: w, sy: 1.0, sz: d, tag: 'parapet', walkable: false });
  }
  // roof on posts
  const roofY = baseY + h + 2.3;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      geos.push(place(cylGeo(0.07, 0.07, 2.3, 5, { uvScale: 1.4 }), { pos: [x + sx * legOff, roofY - 1.15, z + sz * legOff] }));
    }
  }
  geos.push(place(paint(boxGeo(half * 2 + 1.4, 0.16, half * 2 + 1.4, { uvScale: 2.6 }), shade(0x5d5148, 1)), { pos: [x, roofY, z] }));
  // lamp: emissive box under the platform lip — reads at night
  const lampGeo = place(boxGeo(0.24, 0.18, 0.24, { uvScale: 1 }), { pos: [x, baseY + h - 0.28, z - half - 0.1] });
  geos.push(lampGeo);

  // ladder (visual) on the south side
  const ladderBase = { x, z: z - half - 0.45 };
  geos.push(place(boxGeo(0.5, h + 0.4, 0.08, { uvScale: 1.2 }), { pos: [x, baseY + (h + 0.4) / 2, z - half - 0.32] }));
  for (let y = 0.5; y < h + 0.3; y += 0.42) {
    geos.push(place(boxGeo(0.46, 0.05, 0.06, { uvScale: 1 }), { pos: [x, baseY + y, z - half - 0.42] }));
  }

  return {
    geos,
    colliders,
    lamp: { x, y: baseY + h - 0.28, z: z - half - 0.1 },
    tower: {
      x,
      z,
      baseY,
      topY: baseY + h + 0.13,
      ladder: { x: ladderBase.x, z: ladderBase.z, y: baseY },
      stand: { x, z: z + 0.6 },
    },
    pad: { x, z, w: half * 2 + 5, d: half * 2 + 5, y: baseY, pad: 4 },
  };
}

/* ------------------------------------------------------------------ ruins */

/**
 * Abandoned building shell: four walls with punched doors/windows and a ragged
 * ruin top, a floor slab, an apron and scattered rubble. Enterable — the loot
 * spot inside is what makes exploring them worth the risk.
 */
export function buildRuin(x, z, baseY, rng, mats) {
  const w = rand(rng, 8, 14);
  const d = rand(rng, 7, 12);
  const h = rand(rng, 3.0, 5.6);
  const ruin = rand(rng, 0.25, 0.85);
  const door = ['n', 's', 'e', 'w'][Math.floor(rng() * 4)];
  const wallT = 0.42;
  const geos = [];
  const colliders = [];

  const segments = (length, height, holes) => {
    const half = length / 2;
    const segs = [];
    const clean = holes
      .map((hh) => {
        const hw = Math.min(hh.w / 2, half - 0.1);
        return { at: clamp(hh.at, -half + hw, half - hw), w: hw * 2, bottom: clamp(hh.bottom, 0, height), top: clamp(hh.top, 0, height + 2) };
      })
      .sort((a, b) => a.at - b.at);
    let cursor = -half;
    for (const hh of clean) {
      const from = hh.at - hh.w / 2;
      const to = hh.at + hh.w / 2;
      if (from > cursor + 0.05) segs.push({ at: (cursor + from) / 2, along: from - cursor, bottom: 0, top: height });
      if (hh.bottom > 0.05) segs.push({ at: hh.at, along: hh.w, bottom: 0, top: hh.bottom });
      if (height - hh.top > 0.05) segs.push({ at: hh.at, along: hh.w, bottom: hh.top, top: height });
      cursor = Math.max(cursor, to);
    }
    if (cursor < half - 0.05) segs.push({ at: (cursor + half) / 2, along: half - cursor, bottom: 0, top: height });
    return segs.filter((s) => s.along > 0.08 && s.top - s.bottom > 0.08);
  };

  const sides = [
    { name: 'n', alongX: true, fixed: z - d / 2 },
    { name: 's', alongX: true, fixed: z + d / 2 },
    { name: 'w', alongX: false, fixed: x - w / 2 },
    { name: 'e', alongX: false, fixed: x + w / 2 },
  ];
  for (const side of sides) {
    const length = side.alongX ? w : d;
    const holes = [];
    if (door === side.name) holes.push({ at: rand(rng, -length * 0.2, length * 0.2), w: 2.4, bottom: 0, top: 2.3 });
    const cols = Math.max(1, Math.floor(length / 4.5));
    for (let i = 0; i < cols; i++) {
      if (rng() < 0.3) continue;
      const at = -length / 2 + (i + 0.5) * (length / cols);
      if (holes.some((hh) => Math.abs(hh.at - at) < 2.2)) continue;
      holes.push({ at, w: 1.4, bottom: 1.3, top: 2.5 });
    }
    if (ruin > 0.3) {
      const notch = Math.max(2, Math.floor(length / 3.2));
      for (let i = 0; i < notch; i++) {
        const at = -length / 2 + (i + 0.5) * (length / notch) + rand(rng, -0.4, 0.4);
        const keep = h * (1 - ruin * rand(rng, 0.25, 0.9));
        if (h - keep < 0.5) continue;
        holes.push({ at, w: rand(rng, 1.1, 2.4), bottom: keep, top: h + 2 });
      }
    }
    for (const s of segments(length, h, holes)) {
      const sx = side.alongX ? s.along : wallT;
      const sz = side.alongX ? wallT : s.along;
      const wx = side.alongX ? x + s.at : side.fixed;
      const wz = side.alongX ? side.fixed : z + s.at;
      const g = paint(boxGeo(sx, s.top - s.bottom, sz, { uvScale: 2.6 }), shade(0xb5ab9a, 0.62 + (s.top / h) * 0.4));
      geos.push(place(g, { pos: [wx, baseY + (s.bottom + s.top) / 2, wz] }));
      colliders.push({ x: wx, y: baseY + (s.bottom + s.top) / 2, z: wz, sx, sy: s.top - s.bottom, sz, tag: 'structure', surface: 'concrete' });
    }
  }
  // floor slab
  geos.push(place(paint(boxGeo(w, 0.22, d, { uvScale: 3 }), shade(0x8d867a, 0.95)), { pos: [x, baseY + 0.06, z] }));
  colliders.push({ x, y: baseY + 0.06, z, sx: w, sy: 0.22, sz: d, tag: 'floor', walkable: true, surface: 'concrete' });
  // apron
  geos.push(place(paint(boxGeo(w + 2.4, 0.6, d + 2.4, { uvScale: 3 }), shade(0x84796c, 0.9)), { pos: [x, baseY - 0.28, z] }));
  // roof remnant on intact shells
  if (ruin < 0.45 && rng() < 0.6) {
    geos.push(place(paint(boxGeo(w + 0.6, 0.3, d + 0.6, { uvScale: 3 }), shade(0x6f6a62, 1)), { pos: [x, baseY + h + 0.15, z] }));
    colliders.push({ x, y: baseY + h + 0.15, z, sx: w + 0.6, sy: 0.3, sz: d + 0.6, tag: 'roof', walkable: true, surface: 'concrete' });
  }
  // rubble ring
  for (let i = 0; i < 9; i++) {
    const a = rng() * Math.PI * 2;
    const r = Math.max(w, d) * 0.62 + rng() * 2.5;
    const rx = x + Math.cos(a) * r;
    const rz = z + Math.sin(a) * r;
    const s = rand(rng, 0.4, 1.3);
    geos.push(place(paint(boxGeo(s * 1.6, s * 0.6, s * 1.3, { uvScale: 1.4 }), shade(0x9b948a, 0.85)), {
      pos: [rx, baseY + s * 0.22, rz],
      rot: [0, rng() * 1.5, 0],
    }));
    if (s > 0.8) colliders.push({ x: rx, y: baseY + s * 0.24, z: rz, sx: s * 1.5, sy: s * 0.6, sz: s * 1.2, tag: 'rubble', surface: 'concrete', cover: true });
  }
  return {
    geos,
    colliders,
    pad: { x, z, w: w + 4, d: d + 4, y: baseY, pad: 4.5 },
    loot: { x: x + rand(rng, -1, 1), z: z + rand(rng, -1, 1), kind: rng() < 0.5 ? 'ammo' : 'medkit' },
  };
}

/* ------------------------------------------------------- supply cache */

/** A pallet of crates left behind — the E-to-open loot container of the world. */
export function buildSupplyCache(x, z, baseY, rng) {
  const geos = [];
  const colliders = [];
  geos.push(place(paint(boxGeo(2.6, 0.16, 2.2, { uvScale: 2 }), shade(0x7a6042, 1)), { pos: [x, baseY + 0.08, z] }));
  const n = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const s = rand(rng, 0.8, 1.25);
    const cx = x + rand(rng, -0.7, 0.7);
    const cz = z + rand(rng, -0.55, 0.55);
    const cy = baseY + 0.16 + s * 0.5 + (i >= 2 ? 1.0 : 0);
    geos.push(place(paint(boxGeo(s * 1.1, s, s * 1.1, { uvScale: 1.2 }), shade(0x8a6d48, 0.85 + rng() * 0.3)), {
      pos: [cx, cy, cz],
      rot: [0, rand(rng, -0.3, 0.3), 0],
    }));
    colliders.push({ x: cx, y: cy, z: cz, sx: s * 1.1, sy: s, sz: s * 1.1, tag: 'crate', surface: 'wood', cover: true });
  }
  if (rng() < 0.5) {
    geos.push(place(cylGeo(0.33, 0.33, 0.92, 10, { uvScale: 1.2 }), { pos: [x + rand(rng, -1.4, 1.4), baseY + 0.46, z + rand(rng, -1.2, 1.2)] }));
  }
  return {
    geos,
    colliders,
    pad: { x, z, w: 5, d: 5, y: baseY, pad: 3 },
    cache: { x, z, y: baseY, loot: rng() < 0.34 ? 'rich' : 'standard' },
  };
}

/* ------------------------------------------------------------------ wreck */

export function buildWreck(x, z, baseY, rng) {
  const ry = rand(rng, 0, Math.PI * 2);
  const geos = [];
  const parts = [
    boxAt(4.3, 1.0, 2.0, 0, 0.85, 0, 0, { uvScale: 1.4 }),
    boxAt(2.1, 0.8, 1.86, -0.2, 1.6, 0, 0, { uvScale: 1.2 }),
    boxAt(4.5, 0.3, 2.1, 0, 0.32, 0, 0, { uvScale: 1.4 }),
    boxAt(1.0, 0.5, 2.14, 2.1, 0.95, 0, 0, { uvScale: 1.2 }),
  ];
  for (const wx of [-1.5, 1.5]) {
    for (const wz of [-0.92, 0.92]) parts.push(boxAt(0.42, 0.86, 0.86, wx, 0.43, wz, 0, { uvScale: 1 }));
  }
  const merged = mergeGeos(parts);
  paint(merged, shade(0x7d7a72, 0.8 + rng() * 0.3));
  merged.applyMatrix4(new THREE.Matrix4().makeRotationY(ry));
  merged.applyMatrix4(new THREE.Matrix4().makeTranslation(x, baseY, z));
  geos.push(merged);
  const cos = Math.abs(Math.cos(ry));
  const sin = Math.abs(Math.sin(ry));
  return {
    geos,
    colliders: [{ x, y: baseY + 0.95, z, sx: 4.5 * cos + 2.1 * sin, sy: 1.9, sz: 4.5 * sin + 2.1 * cos, tag: 'wreck', surface: 'metal', cover: true }],
    pad: { x, z, w: 6, d: 6, y: baseY, pad: 2.5 },
  };
}

/* ------------------------------------------------------------- spawn camp */

/** The player's starting camp: a fire ring, a lean-to, sandbags, starter kit. */
export function buildCamp(x, z, baseY) {
  const geos = [];
  const colliders = [];
  // fire ring
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    geos.push(place(paint(boxGeo(0.4, 0.3, 0.34, { uvScale: 1 }), shade(0x74706a, 1)), {
      pos: [x + Math.cos(a) * 0.85, baseY + 0.14, z + Math.sin(a) * 0.85],
      rot: [0, a, 0],
    }));
  }
  const coals = place(boxGeo(0.8, 0.14, 0.8, { uvScale: 1 }), { pos: [x, baseY + 0.07, z] });
  paint(coals, new THREE.Color(0x2a1408));
  geos.push(coals);
  // logs around the fire
  for (const [ox, oz, ry] of [[-1.8, 0.6, 0.4], [1.7, -0.7, -0.3]]) {
    geos.push(place(cylGeo(0.14, 0.16, 1.7, 6, { uvScale: 1.4 }), { pos: [x + ox, baseY + 0.16, z + oz], rot: [0, ry, Math.PI / 2] }));
  }
  // lean-to shelter
  const sx = x + 5;
  const sz = z + 2;
  geos.push(place(paint(boxGeo(3.2, 0.16, 2.8, { uvScale: 2 }), shade(0x6d5c44, 1)), { pos: [sx, baseY + 1.5, sz], rot: [-0.5, 0, 0] }));
  colliders.push({ x: sx, y: baseY + 1.0, z: sz, sx: 3.0, sy: 1.7, sz: 2.6, tag: 'structure', walkable: false, surface: 'wood' });
  for (const px of [sx - 1.4, sx + 1.4]) {
    geos.push(place(cylGeo(0.09, 0.11, 2.2, 5, { uvScale: 1.2 }), { pos: [px, baseY + 1.1, sz + 1.2] }));
  }
  // sandbag arc
  for (let i = -2; i <= 2; i++) {
    const bx = x - 4 + i * 0.75;
    const bz = z + 3.5 + Math.abs(i) * 0.28;
    geos.push(place(paint(boxGeo(0.66, 0.3, 0.42, { uvScale: 0.9 }), shade(0x9a8f6e, 0.9 + Math.sin(i) * 0.08)), { pos: [bx, baseY + 0.15, bz] }));
    if (Math.abs(i) < 2) colliders.push({ x: bx, y: baseY + 0.3, z: bz, sx: 0.7, sy: 0.6, sz: 0.46, tag: 'cover', surface: 'sand', cover: true });
  }
  return { geos, colliders };
}

/* ---------------------------------------------------------------- fences */

/** A run of chain-link fence in open field — blocks bodies, not bullets. */
export function buildFenceRun(x0, z0, x1, z1, baseYfn) {
  const geos = [];
  const colliders = [];
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  const count = Math.max(1, Math.floor(len / 3));
  const ry = Math.atan2(dx, dz) - Math.PI / 2;
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    const x = x0 + dx * t;
    const z = z0 + dz * t;
    const y = baseYfn(x, z);
    geos.push(place(paint(boxGeo(3.0, 1.9, 0.06, { uvScale: 2.6 }), shade(0xa9b0b4, 1)), { pos: [x, y + 0.95, z], rot: [0, ry, 0] }));
    if (i % 2 === 0) geos.push(place(cylGeo(0.07, 0.07, 2.2, 5, { uvScale: 1 }), { pos: [x, y + 1.1, z] }));
    colliders.push({
      x, y: y + 0.95, z,
      sx: Math.abs(Math.cos(ry)) * 3 + 0.1,
      sy: 1.9,
      sz: Math.abs(Math.sin(ry)) * 3 + 0.1,
      tag: 'fence', walkable: false,
    });
  }
  return { geos, colliders };
}
