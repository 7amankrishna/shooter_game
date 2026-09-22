/**
 * ColliderWorld — a tiny, purpose-built physics broadphase.
 *
 * A general-purpose physics engine would be wasteful for a world that is 95%
 * axis-aligned boxes, so we keep a flat list of AABBs in a uniform grid and
 * expose only the queries the game actually needs:
 *   1. `raycast()`        — bullets, line of sight, debris
 *   2. `moveBody()`       — vertical-cylinder sweep with wall sliding + steps
 *   3. `groundHeightAt()` — terrain *plus* roofs/crates so props are walkable
 *
 * moveBody() implements proper slope physics (the fix for the old
 * "launch into the air on higher terrain" bug):
 *   • the ground can never teleport a body upward by more than a step height,
 *     and never faster than `slopeClimbRate` — so climbing a hill is a smooth
 *     ramp instead of a vertical snap;
 *   • ground that rises faster than a body can climb is treated as a wall
 *     (wall-slide, axis separated), which is exactly what a cliff face is;
 *   • walking downhill glues the body to the ground within `snapDown`, so
 *     slopes never turn into a chain of little hops;
 *   • gravity is never accumulated while grounded — vertical velocity resets
 *     on contact, so nothing floats, hovers or stores up launch energy.
 *
 * Boxes are owned (usually by a chunk key) so streamed chunks can remove their
 * colliders without touching anyone else's.
 */
import { rayAABB } from '../core/math.js';

const CELL = 6;

export class ColliderWorld {
  constructor({ halfSize = Infinity, terrain = () => 0 } = {}) {
    this.half = halfSize;
    this.terrain = terrain;
    this.boxes = [];
    this.grid = new Map();
    this.freeIds = [];
    this.byOwner = new Map();
    this.stats = { rayCalls: 0, boxTests: 0 };
  }

  key(cx, cz) {
    return cx * 8192 + cz;
  }

  /** Adds an axis-aligned box from a centre + size. Returns the collider. */
  addBox(cx, cy, cz, sx, sy, sz, tag = 'solid', opts = {}) {
    const id = this.freeIds.length ? this.freeIds.pop() : this.boxes.length;
    const box = {
      id,
      min: { x: cx - sx / 2, y: cy - sy / 2, z: cz - sz / 2 },
      max: { x: cx + sx / 2, y: cy + sy / 2, z: cz + sz / 2 },
      center: { x: cx, y: cy, z: cz },
      size: { x: sx, y: sy, z: sz },
      tag,
      dead: false,
      walkable: opts.walkable !== false,
      cover: !!opts.cover,
      surface: opts.surface || 'concrete',
      owner: opts.owner || null,
    };
    this.boxes[id] = box;
    if (box.owner) {
      let arr = this.byOwner.get(box.owner);
      if (!arr) this.byOwner.set(box.owner, (arr = []));
      arr.push(box);
    }
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

  /** Removes every collider registered with `owner` (chunk streaming). */
  removeByOwner(owner) {
    const list = this.byOwner.get(owner);
    if (!list || !list.length) return 0;
    for (const box of list) {
      box.dead = true;
      const x0 = Math.floor(box.min.x / CELL);
      const x1 = Math.floor(box.max.x / CELL);
      const z0 = Math.floor(box.min.z / CELL);
      const z1 = Math.floor(box.max.z / CELL);
      for (let gx = x0; gx <= x1; gx++) {
        for (let gz = z0; gz <= z1; gz++) {
          const arr = this.grid.get(this.key(gx, gz));
          if (!arr) continue;
          const i = arr.indexOf(box.id);
          if (i >= 0) arr.splice(i, 1);
        }
      }
      this.boxes[box.id] = null;
      this.freeIds.push(box.id);
    }
    this.byOwner.delete(owner);
    return list.length;
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
      if (!b || b.dead) continue;
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
  raycast(origin, dir, maxDist = 200, { skipTags } = {}) {
    this.stats.rayCalls++;
    const skip = skipTags ? new Set(skipTags) : null;
    let best = null;
    const checked = new Set();

    const testBox = (b) => {
      if (skip && skip.has(b.tag)) return;
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
      if (arr) {
        for (const id of arr) {
          if (checked.has(id)) continue;
          checked.add(id);
          const b = this.boxes[id];
          if (b && !b.dead) testBox(b);
        }
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
      if (!b || b.dead || !b.walkable || b.tag === 'trigger') continue;
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
      if (!b || b.dead || b.tag === 'trigger' || (b.walkable === false && b.tag === 'glass')) continue;
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
      if (!b || b.dead || b.tag === 'trigger') continue;
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
   * True when a body with feet at `y` cannot stand at (x, z): either a box
   * blocks the cylinder, or the ground there rises more than a step above the
   * feet — a cliff or over-steep slope, which is exactly a wall.
   */
  #blockedAt(x, z, y, height, radius, stepHeight) {
    const res = this.probeCylinder(x, z, y, height, radius, stepHeight);
    if (res.blocked) return true;
    const g = this.groundHeightAt(x, z, y + stepHeight + 0.001);
    return g > y + stepHeight + 0.03;
  }

  /**
   * Sweeps a vertical-cylinder body through the world.
   * `pos` is mutated in place; the return value carries the resolved Y and flags.
   *
   * opts: radius, height, stepHeight, grounded (previous contact state),
   * snapDown (downhill glue distance), climbRate (max upward ground correction
   * per second — the anti-launch clamp).
   */
  moveBody(pos, vel, dt, { radius = 0.4, height = 1.8, stepHeight = 0.62, grounded = false, snapDown = 0.85, climbRate = 9 } = {}) {
    const out = { y: pos.y, grounded: false, landed: false, hitWall: false, stepped: false, hitCeiling: false, fellFrom: 0 };
    const feet = pos.y;
    const climbClamp = Math.max(stepHeight, climbRate * dt);

    // ---- horizontal (wall sliding, axis separated) ----------------------
    const nx = pos.x + vel.x * dt;
    const nz = pos.z + vel.z * dt;
    if (!this.#blockedAt(nx, nz, feet, height, radius, stepHeight)) {
      pos.x = nx;
      pos.z = nz;
    } else if (!this.#blockedAt(nx, pos.z, feet, height, radius, stepHeight)) {
      pos.x = nx;
      out.hitWall = true;
    } else if (!this.#blockedAt(pos.x, nz, feet, height, radius, stepHeight)) {
      pos.z = nz;
      out.hitWall = true;
    } else {
      out.hitWall = true;
    }

    // ---- vertical ---------------------------------------------------------
    // Support = terrain + walkable box tops reachable within a step above the
    // feet. Anything higher was already rejected as a wall above.
    let y = feet;
    const support = this.groundHeightAt(pos.x, pos.z, feet + stepHeight + 0.001);
    const nextY = y + vel.y * dt;

    if (vel.y <= 0) {
      if (nextY <= support + 1e-4) {
        // contact: landing or walking up a slope/step
        out.landed = feet - support < -0.12 || support - feet > 0.12;
        y = support;
        out.grounded = true;
      } else if (grounded && nextY - support <= snapDown) {
        // walking downhill: stay glued to the ground within the snap distance
        y = support;
        out.grounded = true;
        out.landed = support < feet - 0.2;
      } else {
        y = nextY;
        out.grounded = false;
      }
    } else {
      // rising (jump): ballistic until the head touches a ceiling
      y = nextY;
      const ceil = this.ceilingHeightAt(pos.x, pos.z, y);
      if (y + height > ceil) {
        y = Math.max(support, ceil - height - 0.02);
        out.hitCeiling = true;
      }
    }

    // ---- anti-launch clamp ------------------------------------------------
    // The ground may lift the body at most `climbClamp` per frame. A slope that
    // demands more simply runs ahead of the body, and next frame the ground is
    // above feet+step → treated as a wall. No vertical velocity is ever stored
    // by ground contact, so nothing can accumulate into a launch.
    if (y > feet + climbClamp) {
      y = feet + climbClamp;
      out.grounded = true;
    }

    // ---- safety: never end up buried under the terrain --------------------
    const floor = this.terrain(pos.x, pos.z);
    if (y < floor - 0.02) {
      y = floor;
      out.grounded = true;
    }
    if (Number.isFinite(this.half)) {
      const lim = this.half;
      if (Math.abs(pos.x) > lim) pos.x = Math.sign(pos.x) * lim;
      if (Math.abs(pos.z) > lim) pos.z = Math.sign(pos.z) * lim;
    }
    out.y = y;
    pos.y = y;
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
