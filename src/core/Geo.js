/**
 * Geo — merged-geometry helpers.
 *
 * The whole environment is authored as boxes/cylinders, then merged into one
 * BufferGeometry per structure. That keeps the scene at a few hundred draw
 * calls instead of a few thousand, and lets every prop share one texture set
 * (UVs are scaled by world size, so tiling stays consistent at any box size).
 */
import * as THREE from 'three';

const FACE_SIZE = [
  // [u axis size index, v axis size index] into [w, h, d] for +x,-x,+y,-y,+z,-z
  [2, 1],
  [2, 1],
  [0, 2],
  [0, 2],
  [0, 1],
  [0, 1],
];

/**
 * Creates a non-indexed box geometry with world-space UV tiling + vertex colour.
 */
export function boxGeo(w, h, d, { uvScale = 2, color = null } = {}) {
  const geo = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    const face = Math.floor(i / 6);
    const [us, vs] = FACE_SIZE[face];
    const dims = [w, h, d];
    uv.setXY(i, (uv.getX(i) * dims[us]) / uvScale, (uv.getY(i) * dims[vs]) / uvScale);
  }
  if (color) paint(geo, color);
  else geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(uv.count * 3).fill(1), 3));
  return geo;
}

export function cylGeo(rTop, rBottom, h, seg = 10, { uvScale = 2, color = null } = {}) {
  const geo = new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1, false).toNonIndexed();
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, (uv.getX(i) * Math.max(rBottom * 2, 0.2)) / uvScale, (uv.getY(i) * h) / uvScale);
  }
  if (color) paint(geo, color);
  else geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(pos.count * 3).fill(1), 3));
  return geo;
}

/** Applies a flat tint to the colour attribute (multiplies the material map). */
export function paint(geo, color, jitter = 0) {
  const c = new THREE.Color(color);
  const count = geo.attributes.position.count;
  const arr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const j = jitter ? 1 + (Math.random() - 0.5) * jitter : 1;
    arr[i * 3] = c.r * j;
    arr[i * 3 + 1] = c.g * j;
    arr[i * 3 + 2] = c.b * j;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Multiplies colour per-face by height so merged walls read with grime at the base. */
export function paintHeight(geo, low, high, pivotY = 0, span = 3) {
  const pos = geo.attributes.position;
  const a = new THREE.Color(low);
  const b = new THREE.Color(high);
  const arr = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.max(0, (pos.getY(i) - pivotY) / span));
    c.copy(a).lerp(b, t);
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Transforms a geometry in place (used to place parts before merging). */
export function place(geo, { pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1] } = {}) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ'));
  m.compose(new THREE.Vector3(...pos), q, new THREE.Vector3(...scale));
  geo.applyMatrix4(m);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/** Merges geometries that all carry position/normal/uv/color attributes. */
export function mergeGeos(list) {
  const geos = list.filter(Boolean);
  if (!geos.length) return new THREE.BufferGeometry();
  if (geos.length === 1) return geos[0];
  let total = 0;
  for (const g of geos) {
    if (!g.index) {
      total += g.attributes.position.count;
      continue;
    }
    const nn = g.toNonIndexed();
    g.dispose?.();
    // swap in the de-indexed copy
    const idx = geos.indexOf(g);
    geos[idx] = nn;
    total += nn.attributes.position.count;
  }
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const color = new Float32Array(total * 3);
  let offset = 0;
  for (const g of geos) {
    if (!g.attributes.color) paint(g, 0xffffff);
    const p = g.attributes.position.array;
    const n = g.attributes.normal.array;
    const u = g.attributes.uv.array;
    const c = g.attributes.color.array;
    const count = g.attributes.position.count;
    position.set(p, offset * 3);
    normal.set(n, offset * 3);
    color.set(c, offset * 3);
    uv.set(u, offset * 2);
    offset += count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('color', new THREE.BufferAttribute(color, 3));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/** Rotated box helper: geometry already baked at the right world position. */
export function boxAt(w, h, d, x, y, z, ry = 0, opts = {}) {
  return place(boxGeo(w, h, d, opts), { pos: [x, y, z], rot: [0, ry, 0] });
}
