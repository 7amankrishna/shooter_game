/**
 * HitDetection — one hitscan path shared by both combatants.
 *
 * Player shots: the ray leaves the *camera* (so the crosshair is honest), the
 * world is ray-marched through boxes **and** analytic terrain, and only if the
 * machine's meshes are inside that corridor does a body region register. That
 * is what makes "wall first, armour second" ordering correct without a physics
 * engine, and why headshots are exact rather than a radius test.
 */
import * as THREE from 'three';
import { BODY, WEAPON } from '../config/GameConfig.js';

const v3 = (p) => (p && p.isVector3 ? p.clone() : new THREE.Vector3(p?.x ?? 0, p?.y ?? 0, p?.z ?? 0));

export class HitDetection {
  constructor({ env, machine }) {
    this.env = env;
    this.machine = machine;
    this.ray = new THREE.Raycaster();
    this._sphere = new THREE.Sphere();
    this._v = new THREE.Vector3();
    this._closest = new THREE.Vector3();
  }

  /** Closest distance from a ray to a vertical segment (capsule) — player body. */
  rayVsCapsule(origin, dir, center, halfHeight, radius, maxDist) {
    // project the capsule centre onto the ray
    const ox = center.x - origin.x;
    const oy = center.y - origin.y;
    const oz = center.z - origin.z;
    const t = ox * dir.x + oy * dir.y + oz * dir.z;
    if (t < 0 || t > maxDist) return { hit: false, dist: Infinity };
    const px = origin.x + dir.x * t;
    const py = origin.y + dir.y * t;
    const pz = origin.z + dir.z * t;
    const dy = py - center.y;
    const flat = Math.hypot(px - center.x, pz - center.z);
    const withinHeight = Math.abs(dy) <= halfHeight;
    const dist = withinHeight ? flat : Math.hypot(flat, Math.abs(dy) - halfHeight);
    return { hit: dist <= radius, dist, point: this._v.set(px, py, pz), t };
  }

  /**
   * Resolves one player bullet.
   * @returns {{type:'hit'|'graze'|'world'|'miss', region?, point?, surface?, distance}}
   */
  playerShot(origin, dir, maxDistance = WEAPON.hitRange) {
    const world = this.env.world;
    const blocked = world.raycastWithTerrain(origin, dir, maxDistance, { skipTags: ['fence', 'debris', 'trigger'] });
    const wallDist = blocked ? blocked.dist : maxDistance;

    if (this.machine.alive) {
      this._sphere.copy(this.machine.boundingSphere);
      this.ray.set(new THREE.Vector3(origin.x, origin.y, origin.z), new THREE.Vector3(dir.x, dir.y, dir.z));
      const sph = this.ray.ray.intersectSphere(this._sphere, new THREE.Vector3());
      const sphereDist = sph ? this.ray.ray.origin.distanceTo(sph) : Infinity;
      if (sphereDist < wallDist + 0.5) {
        const hit = this.machine.raycastRegion(this.ray, wallDist);
        if (hit) {
          const region = BODY[hit.region] ? hit.region : 'chest';
          const def = BODY[region];
          return {
            type: 'hit',
            region,
            label: def.label,
            damage: def.damage,
            points: def.points,
            point: v3(hit.point),
            distance: hit.distance,
            normal: v3(hit.normal),
            surface: 'armour',
          };
        }
        // near miss on armour plating still counts as a graze — this is what
        // rewards tracking shots without pretending they connected.
        const c = this.machine.chestPoint(this._closest);
        const dx = c.x - origin.x;
        const dz = c.z - origin.z;
        const dy = c.y - origin.y;
        const along = dx * dir.x + dy * dir.y + dz * dir.z;
        if (along > 0 && along < wallDist) {
          const perp = Math.hypot(
            dx - dir.x * along,
            dy - dir.y * along,
            dz - dir.z * along,
          );
          if (perp < 0.52) {
            const p = new THREE.Vector3(origin.x + dir.x * along, origin.y + dir.y * along, origin.z + dir.z * along);
            return {
              type: 'graze',
              region: 'graze',
              label: BODY.graze.label,
              damage: BODY.graze.damage,
              points: BODY.graze.points,
              point: p,
              distance: along,
              normal: { x: dir.x, y: dir.y, z: dir.z },
            };
          }
        }
      }
    }

    if (blocked) {
      return {
        type: 'world',
        point: v3(blocked.point),
        normal: v3(blocked.normal),
        surface: blocked.surface,
        distance: blocked.dist,
      };
    }
    const far = Math.min(maxDistance, 180);
    return {
      type: 'miss',
      point: new THREE.Vector3(origin.x + dir.x * far, origin.y + dir.y * far, origin.z + dir.z * far),
      distance: far,
    };
  }

  /** Resolves one machine bullet against the player's capsule + the world. */
  aiShot(origin, dir, player, damage, maxDistance = 220) {
    const world = this.env.world;
    const blocked = world.raycastWithTerrain(origin, dir, maxDistance, { skipTags: ['fence', 'debris', 'trigger'] });
    const wallDist = blocked ? blocked.dist : maxDistance;
    const center = this._v.set(player.position.x, player.position.y + 0.92, player.position.z);
    const cap = this.rayVsCapsule(origin, dir, center, player.crouching ? 0.5 : 0.78, 0.36, wallDist);
    if (cap.hit) {
      return {
        type: 'hit',
        damage,
        point: new THREE.Vector3(
          origin.x + dir.x * cap.t,
          origin.y + dir.y * cap.t,
          origin.z + dir.z * cap.t,
        ),
      };
    }
    if (blocked) {
      return { type: 'world', point: v3(blocked.point), normal: v3(blocked.normal), surface: blocked.surface, distance: blocked.dist };
    }
    return { type: 'miss' };
  }
}
