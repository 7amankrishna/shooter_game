/**
 * NavGrid — coarse 2.5D navigation mesh baked from the collider world.
 *
 * Each cell stores a walkability flag and a ground height, which lets the AI
 * path across terrain, stairs, loading docks and rooftops with the same code
 * path. A* runs on it with 8-way movement and no corner cutting; the resulting
 * path is then simplified with a line-of-sight "string pull".
 */
import { clamp } from '../core/math.js';

export class NavGrid {
  constructor({ world, halfSize = 112, cell = 1.5, agentRadius = 0.55, agentHeight = 1.7, stepUp = 0.78 }) {
    this.world = world;
    this.cell = cell;
    this.half = halfSize;
    this.agentRadius = agentRadius;
    this.agentHeight = agentHeight;
    this.stepUp = stepUp;
    this.n = Math.ceil((halfSize * 2) / cell);
    this.blocked = new Uint8Array(this.n * this.n);
    this.height = new Float32Array(this.n * this.n);
    this.ready = false;
  }

  toCell(x, z) {
    const cx = Math.floor((x + this.half) / this.cell);
    const cz = Math.floor((z + this.half) / this.cell);
    if (cx < 0 || cz < 0 || cx >= this.n || cz >= this.n) return -1;
    return cz * this.n + cx;
  }

  toPos(i) {
    const cx = i % this.n;
    const cz = Math.floor(i / this.n);
    return { x: cx * this.cell - this.half + this.cell * 0.5, z: cz * this.cell - this.half + this.cell * 0.5 };
  }

  bake() {
    const { n, half, agentRadius, stepUp } = this;
    const terrain = new Float32Array(n * n);
    const top = new Float32Array(n * n);
    // ---- pass 0: raw terrain + the highest static surface per cell
    for (let cz = 0; cz < n; cz++) {
      for (let cx = 0; cx < n; cx++) {
        const i = cz * n + cx;
        const p = this.toPos(i);
        terrain[i] = this.world.terrain(p.x, p.z);
        top[i] = this.world.groundHeightAt(p.x, p.z, Infinity);
      }
    }
    // ---- pass 1: propagate standable heights outwards from the terrain, so
    // stairs give the AI access to the overlook deck while a 2 m wall simply
    // stays a wall (its top is unreachable from the ground next to it).
    const h = this.height;
    h.set(terrain);
    for (let pass = 0; pass < 64; pass++) {
      let changed = 0;
      for (let cz = 0; cz < n; cz++) {
        for (let cx = 0; cx < n; cx++) {
          const i = cz * n + cx;
          const cur = h[i];
          if (top[i] <= cur + 0.001) continue; // already at or above the surface
          if (top[i] > cur + stepUp + 0.72) continue; // needs a neighbour first
          let best = -Infinity;
          for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dz === 0) continue;
              const nx = cx + dx;
              const nz = cz + dz;
              if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
              const nh = h[nz * n + nx];
              if (top[i] > nh + stepUp) continue; // too high a step from there
              if (Math.abs(nh - cur) > stepUp + 0.72) continue;
              if (nh > best) best = nh;
            }
          }
          if (best > -Infinity && top[i] > cur) {
            h[i] = Math.min(top[i], Math.max(cur, best + stepUp));
            if (h[i] > best) changed++;
          }
        }
      }
      if (!changed) break;
    }
    // ---- pass 2: can the agent actually stand at that height?
    for (let cz = 0; cz < n; cz++) {
      for (let cx = 0; cx < n; cx++) {
        const i = cz * n + cx;
        const p = this.toPos(i);
        const ground = h[i];
        const probe = this.world.probeCylinder(p.x, p.z, ground + 0.05, this.agentHeight, agentRadius, 0.05);
        let bad = probe.blocked;
        if (!bad) {
          const ceil = this.world.ceilingHeightAt(p.x, p.z, ground + 0.05);
          if (ceil < ground + this.agentHeight - 0.1) bad = true;
        }
        if (Math.abs(ground - terrain[i]) > 0.02 && top[i] < ground - 0.02) bad = true;
        this.blocked[i] = bad ? 1 : 0;
      }
    }

    // ---- passes 3 + 4 read a frozen snapshot so pruning can never cascade:
    // mutating `blocked` in-place while counting neighbours made a single
    // border cell starve its neighbours, which then starved theirs, and baked
    // an all-solid nav mesh. Read from `src`, write to `blocked`.
    const src = Uint8Array.from(this.blocked);
    const isBlocked = (cx, cz) => cx < 0 || cz < 0 || cx >= n || cz >= n || src[cz * n + cx] === 1;
    for (let cz = 0; cz < n; cz++) {
      for (let cx = 0; cx < n; cx++) {
        const i = cz * n + cx;
        if (src[i]) continue;
        // clearance check: keep the agent out of 1-cell pinches and rubble gaps
        let open = 0;
        let total = 0;
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            if (dx === 0 && dz === 0) continue;
            total++;
            if (!isBlocked(cx + dx, cz + dz)) open++;
          }
        }
        if (open < Math.min(3, total)) this.blocked[i] = 1;
      }
    }
    const src2 = Uint8Array.from(this.blocked);
    const blocked2 = (cx, cz) => cx < 0 || cz < 0 || cx >= n || cz >= n || src2[cz * n + cx] === 1;
    const step = agentRadius * 0.9;
    for (let cz = 0; cz < n; cz++) {
      for (let cx = 0; cx < n; cx++) {
        const i = cz * n + cx;
        if (src2[i]) continue;
        const p = this.toPos(i);
        const g = this.height[i];
        const outside = Math.max(Math.abs(p.x), Math.abs(p.z)) > half - step;
        let reachable = 0;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          if (blocked2(cx + dx, cz + dz)) continue;
          if (Math.abs(this.height[(cz + dz) * n + (cx + dx)] - g) > 0.72) continue;
          if (dx !== 0 && dz !== 0 && (blocked2(cx + dx, cz) || blocked2(cx, cz + dz))) continue; // no corner cutting
          reachable++;
        }
        if (outside || reachable === 0) this.blocked[i] = 1;
      }
    }
    this.ready = true;
    return this;
  }

  walkable(i) {
    return i >= 0 && i < this.blocked.length && this.blocked[i] === 0;
  }

  nearestWalkable(x, z, maxRadius = 8) {
    const start = this.toCell(x, z);
    if (this.walkable(start)) return start;
    const maxCells = Math.ceil(maxRadius / this.cell);
    const cx0 = start % this.n;
    const cz0 = Math.floor(start / this.n);
    let best = -1;
    let bestD = Infinity;
    for (let dz = -maxCells; dz <= maxCells; dz++) {
      for (let dx = -maxCells; dx <= maxCells; dx++) {
        const cx = cx0 + dx;
        const cz = cz0 + dz;
        if (cx < 0 || cz < 0 || cx >= this.n || cz >= this.n) continue;
        const i = cz * this.n + cx;
        if (!this.walkable(i)) continue;
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    return best;
  }

  /** Random walkable cell within an annulus around a point (searching, flanking). */
  randomWalkableNear(x, z, minR, maxR, rng, tries = 24) {
    for (let t = 0; t < tries; t++) {
      const a = rng() * Math.PI * 2;
      const r = minR + rng() * (maxR - minR);
      const i = this.nearestWalkable(x + Math.cos(a) * r, z + Math.sin(a) * r, 5);
      if (i >= 0) return i;
    }
    return -1;
  }

  /**
   * A* with an octile heuristic. `avoid` adds a cost penalty around a point so
   * the AI can route away from known danger instead of walking through it.
   */
  findPath(fromCell, toCell, { maxNodes = 4200, avoid = null } = {}) {
    if (!this.ready || fromCell < 0 || toCell < 0) return null;
    if (!this.walkable(toCell)) toCell = this.nearestWalkable(...Object.values(this.toPos(toCell)), 6);
    if (!this.walkable(fromCell)) fromCell = this.nearestWalkable(...Object.values(this.toPos(fromCell)), 6);
    if (fromCell < 0 || toCell < 0 || !this.walkable(fromCell) || !this.walkable(toCell)) return null;
    if (fromCell === toCell) return [this.toPos(fromCell)];

    const n = this.n;
    const g = new Map();
    const f = new Map();
    const came = new Map();
    const open = [fromCell];
    const closed = new Set();
    const hCost = (i, j) => {
      const a = this.toPos(i);
      const b = this.toPos(j);
      const dx = Math.abs(a.x - b.x) / this.cell;
      const dz = Math.abs(a.z - b.z) / this.cell;
      return Math.max(dx, dz) + 0.414 * Math.min(dx, dz);
    };
    g.set(fromCell, 0);
    f.set(fromCell, hCost(fromCell, toCell));

    let visited = 0;
    while (open.length) {
      // pick lowest f (linear scan is fine at this grid size + node budget)
      let bi = 0;
      let bf = Infinity;
      for (let i = 0; i < open.length; i++) {
        const v = f.get(open[i]) ?? Infinity;
        if (v < bf) {
          bf = v;
          bi = i;
        }
      }
      const current = open.splice(bi, 1)[0];
      if (current === toCell) return this.rebuild(came, toCell);
      closed.add(current);
      if (++visited > maxNodes) break;

      const cx = current % n;
      const cz = Math.floor(current / n);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
        const next = nz * n + nx;
        if (!this.walkable(next) || closed.has(next)) continue;
        if (dx !== 0 && dz !== 0 && (this.blocked[cz * n + nx] || this.blocked[nz * n + cx])) continue;
        const gc = this.height[current];
        const gn = this.height[next];
        const slope = Math.abs(gn - gc);
        if (slope > 0.72) continue;
        const base = (dx !== 0 && dz !== 0 ? 1.414 : 1) + slope * 0.6;
        let penalty = 0;
        if (avoid) {
          const p = this.toPos(next);
          const d = Math.hypot(p.x - avoid.x, p.z - avoid.z);
          if (d < avoid.radius) penalty += (1 - d / avoid.radius) * avoid.weight;
        }
        const tentative = (g.get(current) ?? Infinity) + base + penalty;
        if (tentative < (g.get(next) ?? Infinity)) {
          came.set(next, current);
          g.set(next, tentative);
          f.set(next, tentative + hCost(next, toCell));
          if (!open.includes(next)) open.push(next);
        }
      }
    }
    return null;
  }

  rebuild(came, end) {
    const path = [];
    let cur = end;
    while (cur !== undefined) {
      path.push(this.toPos(cur));
      cur = came.get(cur);
    }
    path.reverse();
    return path;
  }

  /** Line-of-sight string pulling so the AI walks in straight tactical lines. */
  smoothPath(path) {
    if (!path || path.length < 3) return path || [];
    const out = [path[0]];
    let i = 0;
    let guard = 0;
    while (i < path.length - 1 && guard++ < path.length * 2) {
      let far = i + 1;
      for (let j = path.length - 1; j > i + 1; j--) {
        if (this.clearLine(path[i], path[j])) {
          far = j;
          break;
        }
      }
      out.push(path[far]);
      i = far;
    }
    return out;
  }

  /**
   * Straight-line walkability test used by the string pull. Runs entirely on the
   * baked grid, so it can never disagree with what A* is allowed to do.
   */
  clearLine(a, b) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const dist = Math.hypot(dx, dz);
    const samples = Math.max(2, Math.ceil(dist / (this.cell * 0.55)));
    let prev = -1;
    for (let s = 0; s <= samples; s++) {
      const t = s / samples;
      const x = a.x + dx * t;
      const z = a.z + dz * t;
      const cell = this.toCell(x, z);
      if (!this.walkable(cell)) return false;
      if (prev >= 0 && Math.abs(this.height[cell] - this.height[prev]) > 0.72) return false;
      prev = cell;
    }
    return true;
  }

  /** Cell statistics used by the debug overlay. */
  stats() {
    let walk = 0;
    for (let i = 0; i < this.blocked.length; i++) if (!this.blocked[i]) walk++;
    return { cells: this.blocked.length, walkable: walk, cell: this.cell };
  }
}
