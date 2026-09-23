/**
 * LODInstances — hand-rolled distance LOD + frustum/distance culling for props.
 *
 * `THREE.LOD` cannot be instanced, and an arena like this is mostly repeated
 * clutter, so instead each prop family keeps two `InstancedMesh` sets (a
 * detailed one and a cheap one). Every cull pass we bucket instances by distance
 * to the camera and rewrite the two instance buffers; anything past the far
 * range (or outside the camera frustum, for `cullByFrustum` families) is simply
 * not written, which also keeps the shadow pass honest.
 *
 * The pass is throttled and only re-runs when the camera has moved enough, so
 * steady-state cost is effectively zero.
 */
import * as THREE from 'three';

export class PropFamily {
  constructor({ name, nearGeo, farGeo, material, nearRange = 26, farRange = 70, cullRange = 120, shadow = true, count = 0 }) {
    this.name = name;
    this.count = count;
    this.matrices = [];
    this.nearMesh = new THREE.InstancedMesh(nearGeo, material, Math.max(1, count));
    this.farMesh = farGeo && farGeo !== nearGeo ? new THREE.InstancedMesh(farGeo, material, Math.max(1, count)) : null;
    this.nearRange = nearRange;
    this.farRange = farRange;
    this.cullRange = cullRange;
    this.shadow = shadow;
    this.nearMesh.castShadow = shadow;
    this.nearMesh.receiveShadow = true;
    if (this.farMesh) {
      this.farMesh.castShadow = false;
      this.farMesh.receiveShadow = true;
    }
    this.nearMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (this.farMesh) this.farMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.nearMesh.frustumCulled = false; // we cull per instance ourselves
    if (this.farMesh) this.farMesh.frustumCulled = false;
    this.group = new THREE.Group();
    this.group.add(this.nearMesh);
    if (this.farMesh) this.group.add(this.farMesh);
    this._lastNear = -1;
    this._lastFar = -1;
    this.stats = { near: 0, far: 0, culled: 0 };
    this.empty = new THREE.Matrix4().makeScale(0, 0, 0);
  }

  add(matrix) {
    this.matrices.push(matrix.clone());
    this.count = this.matrices.length;
    if (this.nearMesh.count < this.count) this.nearMesh.count = this.count;
    if (this.farMesh && this.farMesh.instanceMatrix.count < this.count) {
      // InstancedMesh capacity is fixed at construction; grow by reallocating.
      const grown = new THREE.InstancedMesh(this.farMesh.geometry, this.farMesh.material, this.count);
      grown.castShadow = false;
      grown.receiveShadow = true;
      grown.frustumCulled = false;
      grown.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.remove(this.farMesh);
      this.farMesh = grown;
      this.group.add(grown);
    }
    return this;
  }

  finalize() {
    this.nearMesh.count = this.count;
    if (this.farMesh) this.farMesh.count = this.count;
    for (let i = 0; i < this.count; i++) {
      this.nearMesh.setMatrixAt(i, this.matrices[i]);
      if (this.farMesh) this.farMesh.setMatrixAt(i, this.matrices[i]);
    }
    this.nearMesh.instanceMatrix.needsUpdate = true;
    if (this.farMesh) this.farMesh.instanceMatrix.needsUpdate = true;
    return this;
  }

  /** @param {THREE.Vector3} camPos @param {number} sqNear @param {number} sqFar @param {number} sqCull */
  update(camPos, frustum) {
    const near = [];
    const far = [];
    let culled = 0;
    for (let i = 0; i < this.count; i++) {
      const m = this.matrices[i];
      const px = m.elements[12];
      const py = m.elements[13];
      const pz = m.elements[14];
      const dx = px - camPos.x;
      const dy = py - camPos.y;
      const dz = pz - camPos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > this._sq(this.cullRange)) {
        culled++;
        continue;
      }
      if (frustum && !frustum.containsPoint(_tmpVec.set(px, py, pz)) && d2 > this._sq(12)) {
        // cheap point-frustum test for spread-out props; near props always draw
        culled++;
        continue;
      }
      if (d2 <= this._sq(this.nearRange)) near.push(i);
      else if (this.farMesh && d2 <= this._sq(this.farRange)) far.push(i);
      else near.push(i); // beyond far LOD but inside cull range: keep detailed (rare)
    }
    this.applyBuckets(near, far, culled);
  }

  applyBuckets(near, far, culled) {
    if (near.length === this._lastNear && far.length === this._lastFar) {
      this.stats.near = near.length;
      this.stats.far = far.length;
      this.stats.culled = culled;
      return;
    }
    this._lastNear = near.length;
    this._lastFar = far.length;
    const M = this.matrices;
    let i = 0;
    for (; i < near.length; i++) this.nearMesh.setMatrixAt(i, M[near[i]]);
    for (; i < this.count; i++) this.nearMesh.setMatrixAt(i, this.empty);
    this.nearMesh.instanceMatrix.needsUpdate = true;
    if (this.farMesh) {
      let j = 0;
      for (; j < far.length; j++) this.farMesh.setMatrixAt(j, M[far[j]]);
      for (; j < this.count; j++) this.farMesh.setMatrixAt(j, this.empty);
      this.farMesh.instanceMatrix.needsUpdate = true;
    }
    this.stats.near = near.length;
    this.stats.far = far.length;
    this.stats.culled = culled;
  }

  _sq(r) {
    return r * r;
  }
}

const _tmpVec = new THREE.Vector3();

/** Container for every instanced prop family so the culler can iterate once. */
export class PropSystem {
  constructor() {
    this.families = [];
  }

  create(opts) {
    const fam = new PropFamily(opts);
    this.families.push(fam);
    return fam;
  }

  finalize() {
    for (const f of this.families) f.finalize();
    return this;
  }

  update(camPos, frustum) {
    let near = 0;
    let far = 0;
    let culled = 0;
    for (const f of this.families) {
      f.update(camPos, frustum);
      near += f.stats.near;
      far += f.stats.far;
      culled += f.stats.culled;
    }
    return { near, far, culled };
  }
}

/**
 * CellCuller — group-level visibility for the large, non-instanced structures
 * (buildings, docks, shells). Each cell owns a Group; a group is hidden when it
 * is fully outside the frustum or beyond the draw distance, which removes whole
 * buildings from the scene graph traversal instead of one mesh at a time.
 */
export class CellCuller {
  constructor(cell = 24) {
    this.cell = cell;
    this.cells = new Map();
    this.stats = { visible: 0, total: 0 };
  }

  key(x, z) {
    return `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`;
  }

  add(x, z, object) {
    const k = this.key(x, z);
    let entry = this.cells.get(k);
    if (!entry) {
      entry = { group: new THREE.Group(), center: new THREE.Vector3(), radius: 0, objects: [] };
      this.cells.set(k, entry);
    }
    entry.group.add(object);
    entry.objects.push(object);
    object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object);
    const c = box.getCenter(new THREE.Vector3());
    const s = box.getSize(new THREE.Vector3());
    entry.center.copy(c);
    entry.radius = Math.max(8, s.length() * 0.5);
    return entry;
  }

  /** Detaches one object (chunk streaming) and drops the cell when empty. */
  remove(object) {
    for (const [k, entry] of this.cells) {
      const i = entry.objects.indexOf(object);
      if (i < 0) continue;
      entry.objects.splice(i, 1);
      entry.group.remove(object);
      if (!entry.objects.length) {
        entry.group.removeFromParent();
        this.cells.delete(k);
      }
      this.stats.total = this.cells.size;
      return true;
    }
    return false;
  }

  attachTo(parent) {
    for (const entry of this.cells.values()) parent.add(entry.group);
    this.stats.total = this.cells.size;
    return this;
  }

  update(frustum, camPos, farRange) {
    let visible = 0;
    const far2 = farRange * farRange;
    for (const entry of this.cells.values()) {
      const inView = frustum.intersectsSphere(_sphere.set(entry.center, entry.radius));
      const d = entry.center.distanceToSquared(camPos);
      // draw when in frustum and within budget, but never hide the immediate
      // surroundings — popping geometry right next to the player reads badly.
      const on = (inView && d < far2) || d < 32 * 32;
      if (entry.group.visible !== on) entry.group.visible = on;
      if (on) visible++;
    }
    this.stats.visible = visible;
    return this.stats;
  }
}

const _sphere = new THREE.Sphere();
