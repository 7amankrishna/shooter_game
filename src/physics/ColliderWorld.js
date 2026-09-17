/**
 * ColliderWorld — a tiny, purpose-built physics broadphase.
 *
 * A general-purpose physics engine would be wasteful for an arena that is 95%
 * axis-aligned boxes, so we keep a flat list of AABBs in a uniform grid and
 * expose only the queries the game actually needs:
 *   1. `raycast()`        — bullets, line of sight, debris
 *   2. `moveBody()`       — vertical-cylinder sweep with wall sliding + step-up
 *   3. `groundHeightAt()` — terrain *plus* roofs/crates so props are walkable
 *
 * Hot paths allocate nothing but the result object and use a Set of already
 * tested box ids, which keeps a 100 m ray down to a few hundred slab tests.
 */
import { rayAABB } from '../core/math.js';

const CELL = 6;

export class ColliderWorld {
  constructor({ halfSize = 120, terrain = () => 0 } = {}) {
    this.half = halfSize;
    this.terrain = terrain;
    this.boxes = [];
    this.grid = new Map();
    this.stats = { rayCalls: 0, boxTests: 0 };
  }

  key(cx, cz) {
    return cx * 8192 + cz;
  }

  /** Adds an axis-aligned box from a centre + size. Returns the collider. */
  addBox(cx, cy, cz, sx, sy, sz, tag = 'solid', opts = {}) {
    const box = {
      id: this.boxes.length,
      min: { x: cx - sx / 2, y: cy - sy / 2, z: cz - sz / 2 },
      max: { x: cx + sx / 2, y: cy + sy / 2, z: cz + sz / 2 },
      center: { x: cx, y: cy, z: cz },
      size: { x: sx, y: sy, z: sz },
      tag,
      walkable: opts.walkable !== false,
      cover: !!opts.cover,
      surface: opts.surface || 'concrete',
      owner: opts.owner || null,
    };
    this.boxes.push(box);
    const x0 = Math.floor(box.min.x / CELL);
    const x1 = Math.floor(box.max.x / CELL);
    const z0 = Math.floor(box.min.z / CELL);
    const z1 = Math.floor(box.max.z / CELL);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gz = z0; gz <= z1; gz++) {
        const k = this.key(gx, gz);
        let arr = this.grid.get(k);
        if (!arr) this.grid.set(k, (arr = []));
        if (!arr.includes(box.id)) arr.push(box.id);
      }
    }
    return box;
  }

  /** Convenience: bake an AABB collider from a (merged) mesh's bounds. */
  addBoxFromObject(object3D, tag = 'solid', opts = {}) {
    object3D.updateMatrixWorld(true);
    if (!object3D.geometry.boundingBox) object3D.geometry.computeBoundingBox();
    const b = object3D.geometry.boundingBox.clone().applyMatrix4(object3D.matrixWorld);
    return this.addBox(
      (b.min.x + b.max.x) / 2,
      (b.min.y + b.max.y) / 2,
      (b.min.z + b.max.z) / 2,
      b.max.x - b.min.x,
      b.max.y - b.min.y,
      b.max.z - b.min.z,
      tag,
      opts,
    );
  }

  /** Ids of boxes whose XZ footprint overlaps a rectangle. */
  boxIdsInXZ(minX, maxX, minZ, maxZ) {
    const out = [];
    const x0 = Math.floor(minX / CELL);
    const x1 = Math.floor(maxX / CELL);
    const z0 = Math.floor(minZ / CELL);
    const z1 = Math.floor(maxZ / CELL);
    const seen = new Set();
    for (let gx = x0; gx <= x1; gx++) {
      for (let gz = z0; gz <= z1; gz++) {
        const arr = this.grid.get(this.key(gx, gz));
        if (!arr) continue;
        for (const id of arr) {
          if (seen.has(id)) continue;
          seen.add(id);
          out.push(id);
        }
      }
    }
    return out;
  }

  queryXZ(minX, maxX, minZ, maxZ, filter) {
    const out = [];
    for (const id of this.boxIdsInXZ(minX, maxX, minZ, maxZ)) {
      const b = this.boxes[id];
      if (b.max.x < minX || b.min.x > maxX || b.max.z < minZ || b.min.z > maxZ) continue;
      if (filter && !filter(b)) continue;
      out.push(b);
    }
    return out;
  }

  /**
   * Closest solid hit along a ray. Grid cells are visited with an Amanatides &
   * Woo DDA walk so long rays never touch irrelevant geometry.
   */
  raycast(origin, dir, maxDist = 200, { skipTags, stepOnly = false } = {}) {
    this.stats.rayCalls++;
    const skip = skipTags ? new Set(skipTags) : null;
    let best = null;
    const checked = new Set();

    const testBox = (b) => {
      if (skip && skip.has(b.tag)) return;
      if (stepOnly && b.tag !== 'trigger') return;
      this.stats.boxTests++;
      const d = rayAABB(origin, dir, b.min, b.max, maxDist);
      if (d < 0) return;
      if (best && d >= best.dist) return;
      best = {
        dist: d,
        box: b,
        point: { x: origin.x + dir.x * d, y: origin.y + dir.y * d, z: origin.z + dir.z * d },
        normal: hitNormal(b, origin, dir, d),
        surface: b.surface,
      };
    };

    // DDA over the coarse grid.
    let cx = Math.floor(origin.x / CELL);
    let cz = Math.floor(origin.z / CELL);
    const stepX = dir.x > 0 ? 1 : -1;
    const stepZ = dir.z > 0 ? 1 : -1;
    const invX = dir.x !== 0 ? Math.abs(CELL / dir.x) : Infinity;
    const invZ = dir.z !== 0 ? Math.abs(CELL / dir.z) : Infinity;
    const xDist = (cx + (dir.x > 0 ? 1 : 0)) * CELL - origin.x;
    const zDist = (cz + (dir.z > 0 ? 1 : 0)) * CELL - origin.z;
    let tMaxX = dir.x !== 0 ? Math.abs(xDist / dir.x) : Infinity;
    let tMaxZ = dir.z !== 0 ? Math.abs(zDist / dir.z) : Infinity;

    // Distance along the ray at which the *current* cell exits.
    let cellExit = 0;
    let guard = 0;
    while (guard++ < 4096) {
      const arr = this.grid.get(this.key(cx, cz));
      if (arr) for (const id of arr) {
        if (checked.has(id)) continue;
        checked.add(id);
        testBox(this.boxes[id]);
      }
      if (best && best.dist <= cellExit) break;
      if (tMaxX < tMaxZ) {
        cellExit = tMaxX;
        cx += stepX;
        tMaxX += invX;
      } else {
        cellExit = tMaxZ;
        cz += stepZ;
        tMaxZ += invZ;
      }
      if (Math.min(tMaxX, tMaxZ) > maxDist) break;
    }
    return best;
  }

  /**
   * Raycast that also respects the analytic terrain, so a ridge really does
   * block a shot or a line of sight even though the ground is not a box.
   * Returns the nearest of { box hit, terrain hit }.
   */
  raycastWithTerrain(origin, dir, maxDist = 200, { skipTags = ['fence', 'debris', 'trigger'] } = {}) {
    const boxHit = this.raycast(origin, dir, maxDist, { skipTags });
    const limit = boxHit ? Math.min(maxDist, boxHit.dist) : maxDist;
    const step = 1.0;
    let terrain = null;
    for (let t = step; t < limit; t += step) {
      const x = origin.x + dir.x * t;
      const y = origin.y + dir.y * t;
      const z = origin.z + dir.z * t;
      const g = this.terrain(x, z);
      if (y < g) {
        // bisect back to the exact point where the ray dipped under the surface
        let lo = Math.max(0, t - step);
        let hi = t;
        for (let k = 0; k < 8; k++) {
          const mid = (lo + hi) / 2;
          const mx = origin.x + dir.x * mid;
          const mz = origin.z + dir.z * mid;
          const my = origin.y + dir.y * mid;
          if (my < this.terrain(mx, mz)) hi = mid;
          else lo = mid;
        }
        t = hi;
        const x2 = origin.x + dir.x * t;
        const y2 = origin.y + dir.y * t;
        const z2 = origin.z + dir.z * t;
        const e = 0.75;
        const nx = this.terrain(x2 - e, z2) - this.terrain(x2 + e, z2);
        const nz = this.terrain(x2, z2 - e) - this.terrain(x2, z2 + e);
        const len = Math.hypot(nx, 2 * e, nz) || 1;
        terrain = {
          dist: t,
          point: { x: x2, y: this.terrain(x2, z2), z: z2 },
          normal: { x: nx / len, y: (2 * e) / len, z: nz / len },
          box: null,
          surface: 'ground',
        };
        break;
      }
    }
    if (terrain && (!boxHit || terrain.dist < boxHit.dist)) return terrain;
    return boxHit;
  }

  /** Line of sight between two points, honouring terrain occlusion. */
  hasLineOfSight(a, b, { skipTags = ['fence', 'debris', 'trigger'], useTerrain = true } = {}) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-4) return true;
    const dir = { x: dx / dist, y: dy / dist, z: dz / dist };
    const hit = useTerrain
      ? this.raycastWithTerrain(a, dir, dist - 0.03, { skipTags })
      : this.raycast(a, dir, dist - 0.03, { skipTags });
    return !hit;
  }


  /** Ground elevation: terrain plus any walkable box top below `refY`. */
  groundHeightAt(x, z, refY = Infinity) {
    let h = this.terrain(x, z);
    const ids = this.boxIdsInXZ(x - 0.2, x + 0.2, z - 0.2, z + 0.2);
    for (const id of ids) {
      const b = this.boxes[id];
      if (!b.walkable || b.tag === 'trigger') continue;
      if (x < b.min.x - 0.12 || x > b.max.x + 0.12 || z < b.min.z - 0.12 || z > b.max.z + 0.12) continue;
      if (b.max.y <= refY + 1e-3 && b.max.y > h) h = b.max.y;
    }
    return h;
  }

  /** Underside of the first box above a point (head clearance / crouching). */
  ceilingHeightAt(x, z, y) {
    let best = Infinity;
    const ids = this.boxIdsInXZ(x - 0.3, x + 0.3, z - 0.3, z + 0.3);
    for (const id of ids) {
      const b = this.boxes[id];
      if (b.tag === 'trigger' || b.walkable === false && b.tag === 'glass') continue;
      if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) continue;
      if (b.min.y >= y - 0.02 && b.min.y < best) best = b.min.y;
    }
    return best;
  }

  /**
   * Boxes that block a vertical cylinder standing at (x, z) with feet at y.
   * Returns { blocked, stepTop } where stepTop is a climbable ledge height.
   */
  probeCylinder(x, z, feetY, height, radius, stepHeight) {
    let blocked = false;
    let stepTop = -Infinity;
    const ids = this.boxIdsInXZ(x - radius, x + radius, z - radius, z + radius);
    for (const id of ids) {
      const b = this.boxes[id];
      if (b.tag === 'trigger') continue;
      if (x + radius <= b.min.x || x - radius >= b.max.x || z + radius <= b.min.z || z - radius >= b.max.z) continue;
      const top = b.max.y;
      const bottom = b.min.y;
      if (top <= feetY + 0.03) continue; // under the feet: it is floor
      if (bottom >= feetY + height) continue; // above the head
      if (top - feetY <= stepHeight) {
        if (top > stepTop) stepTop = top;
        continue;
      }
      blocked = true;
    }
    return { blocked, stepTop };
  }

  /**
   * Sweeps a vertical-cylinder body through the world.
   * `pos` is mutated in place; the return value carries the resolved Y and flags.
   */
  moveBody(pos, vel, dt, { radius = 0.4, height = 1.8, stepHeight = 0.62 } = {}) {
    const out = { y: pos.y, grounded: false, landed: false, hitWall: false, stepped: false, hitCeiling: false };
    const feet = pos.y;

    // ---- horizontal (with wall sliding) --------------------------------
    const cand = { x: pos.x + vel.x * dt, z: pos.z + vel.z * dt };
    let res = this.probeCylinder(cand.x, cand.z, feet, height, radius, stepHeight);
    if (res.blocked) {
      // try each axis on its own for sliding along walls
      const onlyX = this.probeCylinder(cand.x, pos.z, feet, height, radius, stepHeight);
      const onlyZ = this.probeCylinder(pos.x, cand.z, feet, height, radius, stepHeight);
      if (!onlyX.blocked) {
        pos.x = cand.x;
        res = onlyX;
        out.hitWall = true;
      } else if (!onlyZ.blocked) {
        pos.z = cand.z;
        res = onlyZ;
        out.hitWall = true;
      } else {
        out.hitWall = true;
        res = { blocked: true, stepTop: -Infinity };
      }
    } else {
      pos.x = cand.x;
      pos.z = cand.z;
    }
    if (res.stepTop > feet + 0.001) out.y = res.stepTop;
    if (res.stepTop > -Infinity) out.stepped = true;

    // clamp to arena
    if (Math.abs(pos.x) > this.half) pos.x = Math.sign(pos.x) * this.half;
    if (Math.abs(pos.z) > this.half) pos.z = Math.sign(pos.z) * this.half;

    // ---- vertical ---------------------------------------------------------
    const support = this.groundHeightAt(pos.x, pos.z, feet + Math.max(stepHeight, 0.02) + 0.001);
    const nextY = out.y + vel.y * dt;
    if (vel.y <= 0) {
      if (nextY <= support + 1e-4) {
        out.landed = out.y - support > 0.14;
        out.y = support;
        out.grounded = true;
      }
    } else {
      const ceil = this.ceilingHeightAt(pos.x, pos.z, out.y + height);
      if (out.y + height + vel.y * dt > ceil) {
        out.y = Math.max(support, ceil - height - 0.02);
        out.hitCeiling = true;
      }
    }
    // keep from sinking through terrain when stationary
    const hardFloor = this.groundHeightAt(pos.x, pos.z, pos.y + 0.05);
    if (out.y < hardFloor) {
      out.y = hardFloor;
      out.grounded = true;
    }
    pos.y = out.y;
    return out;
  }
}

/** Which axis of the box did the ray enter through? → impact normal. */
function hitNormal(b, origin, dir, d) {
  const px = origin.x + dir.x * d;
  const py = origin.y + dir.y * d;
  const pz = origin.z + dir.z * d;
  const eps = 1e-3;
  if (Math.abs(px - b.min.x) < eps) return { x: -1, y: 0, z: 0 };
  if (Math.abs(px - b.max.x) < eps) return { x: 1, y: 0, z: 0 };
  if (Math.abs(pz - b.min.z) < eps) return { x: 0, y: 0, z: -1 };
  if (Math.abs(pz - b.max.z) < eps) return { x: 0, y: 0, z: 1 };
  if (Math.abs(py - b.min.y) < eps) return { x: 0, y: -1, z: 0 };
  if (Math.abs(py - b.max.y) < eps) return { x: 0, y: 1, z: 0 };
  // fell through: derive from direction
  const ax = Math.abs(dir.x);
  const ay = Math.abs(dir.y);
  const az = Math.abs(dir.z);
  if (ax >= ay && ax >= az) return { x: -Math.sign(dir.x), y: 0, z: 0 };
  if (ay >= ax && ay >= az) return { x: 0, y: -Math.sign(dir.y), z: 0 };
  return { x: 0, y: 0, z: -Math.sign(dir.z) };
}
