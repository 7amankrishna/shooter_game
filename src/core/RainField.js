/**
 * RainField — pooled rain streaks that follow the camera.
 *
 * One LineSegments draw call: every drop is a short segment whose length and
 * slant come from its fall velocity (gravity + wind shear), so a storm reads
 * as driving rain and a drizzle as near-vertical mist. Intensity scales the
 * draw range instead of the vertex count — hidden drops cost nothing, and no
 * buffer is ever reallocated at runtime.
 *
 * The field is a fixed-size box around the camera; drops that fall out the
 * bottom (or drift out the sides in a wind) wrap back in with a fresh random
 * offset, which keeps the density uniform however far the player runs.
 */
import * as THREE from 'three';
import { clamp, makeRng } from './math.js';

const COUNT = 900; // max drops — storms reveal all of them
const BOX = 34; // field half-extent in XZ around the camera
const TOP = 16; // spawn height above the camera
const BOTTOM = -6; // recycle height below the camera
const FALL = 21; // terminal velocity, m/s

export class RainField {
  constructor({ seed = 1337 } = {}) {
    const rng = makeRng(seed);
    this.count = COUNT;
    this.box = BOX;

    // per-drop state: position (x,y,z), speed jitter, length jitter
    this.px = new Float32Array(COUNT);
    this.py = new Float32Array(COUNT);
    this.pz = new Float32Array(COUNT);
    this.spd = new Float32Array(COUNT);
    this.len = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) this.#respawn(i, rng, 0, 0, 0, true);

    const positions = new Float32Array(COUNT * 2 * 3);
    this.geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(positions, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.posAttr);

    this.mat = new THREE.LineBasicMaterial({
      color: 0x9fb2c8,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
      fog: true,
    });
    this.mesh = new THREE.LineSegments(this.geo, this.mat);
    this.mesh.frustumCulled = false; // the field is rebuilt around the camera
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
    this.visibleCount = 0;
    this._rng = rng;
    this._wind = { x: 0, z: 0 };
  }

  attach(scene) { scene.add(this.mesh); }

  /** Respawn drop i somewhere in the field box (full depth, or the top band). */
  #respawn(i, rng, cx, cy, cz, anywhere = false) {
    this.px[i] = cx + (rng() * 2 - 1) * BOX;
    this.pz[i] = cz + (rng() * 2 - 1) * BOX;
    this.py[i] = anywhere
      ? cy + BOTTOM + rng() * (TOP - BOTTOM)
      : cy + TOP * (0.65 + rng() * 0.35);
    this.spd[i] = FALL * (0.75 + rng() * 0.5);
    this.len[i] = 0.75 + rng() * 0.6;
  }

  /**
   * @param {number} dt
   * @param {{x:number,y:number,z:number}} camPos camera position
   * @param {number} intensity 0..1 (weather rain amount)
   * @param {{x:number,z:number}} wind horizontal wind (m/s-ish, from Weather)
   */
  update(dt, camPos, intensity, wind) {
    const want = intensity > 0.03 ? Math.round(clamp(intensity, 0, 1) * COUNT) : 0;
    if (want !== this.visibleCount) {
      this.visibleCount = want;
      this.geo.setDrawRange(0, want * 2);
    }
    this.mesh.visible = want > 0;
    if (!want) return;

    this.mat.opacity = 0.2 + clamp(intensity, 0, 1) * 0.18;
    const wx = wind?.x ?? 0;
    const wz = wind?.z ?? 0;
    // smooth wind changes so gusts don't snap the streaks
    this._wind.x += (wx - this._wind.x) * Math.min(1, dt * 2.5);
    this._wind.z += (wz - this._wind.z) * Math.min(1, dt * 2.5);

    const rng = this._rng;
    const arr = this.posAttr.array;
    const cx = camPos.x;
    const cy = camPos.y;
    const cz = camPos.z;
    for (let i = 0; i < want; i++) {
      let x = this.px[i];
      let y = this.py[i];
      let z = this.pz[i];
      const v = this.spd[i];
      y -= v * dt;
      x += this._wind.x * dt * v * 0.05;
      z += this._wind.z * dt * v * 0.05;

      // wrap: out the bottom, or drifted out the sides
      if (y < cy + BOTTOM || Math.abs(x - cx) > BOX * 1.4 || Math.abs(z - cz) > BOX * 1.4) {
        this.#respawn(i, rng, cx, cy, cz);
        x = this.px[i]; y = this.py[i]; z = this.pz[i];
      } else {
        this.px[i] = x; this.py[i] = y; this.pz[i] = z;
      }

      // the streak: velocity * a short exposure, slanted by wind
      const k = v * 0.075 * this.len[i];
      const j = i * 6;
      arr[j] = x;
      arr[j + 1] = y;
      arr[j + 2] = z;
      arr[j + 3] = x - this._wind.x * 0.05 * k;
      arr[j + 4] = y + k;
      arr[j + 5] = z - this._wind.z * 0.05 * k;
    }
    this.posAttr.needsUpdate = true;
    this.posAttr.clearUpdateRanges();
    this.posAttr.addUpdateRange(0, want * 6);
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}
