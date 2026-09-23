/**
 * HitDetection — one hitscan path, shared by every gun in the loadout.
 *
 * The ray leaves the *camera* (so the crosshair is honest), marches the
 * collider world (boxes + analytic terrain), and only zombies inside that
 * corridor register — "wall first, flesh second" ordering without a physics
 * engine, which is also why headshots are exact limb-mesh intersections
 * rather than probability rolls.
 */
import * as THREE from 'three';

const _ray = new THREE.Raycaster();

export class HitDetection {
  constructor({ world, zombies }) {
    this.world = world; // World wrapper (.world = ColliderWorld)
    this.col = world.world;
    this.zombies = zombies; // ZombieManager
  }

  /**
   * Resolves one player bullet.
   * @param {object} def weapon definition (damage / headMult / limbMult / hitRange)
   * @returns {{type:'zombie'|'world'|'miss', region?, zombie?, point?, normal?, surface?, distance, damage?}}
   */
  playerShot(origin, dir, def) {
    const maxDistance = def.hitRange;
    const blocked = this.col.raycastWithTerrain(origin, dir, maxDistance, { skipTags: ['fence'] });
    const wallDist = blocked ? blocked.dist : maxDistance;

    // broad+narrow phase against the horde
    _ray.ray.origin.set(origin.x, origin.y, origin.z);
    _ray.ray.direction.set(dir.x, dir.y, dir.z);
    const zHit = this.zombies.raycast(_ray);
    if (zHit && zHit.distance < wallDist + 0.25) {
      const region = zHit.region === 'head' ? 'head' : zHit.region === 'limb' ? 'limb' : 'chest';
      const mult = region === 'head' ? def.headMult : region === 'limb' ? def.limbMult : 1;
      return {
        type: 'zombie',
        zombie: zHit.zombie,
        region,
        point: zHit.point.clone(),
        damage: def.damage * mult,
        distance: zHit.distance,
      };
    }

    if (blocked) {
      return {
        type: 'world',
        point: new THREE.Vector3(blocked.point.x, blocked.point.y, blocked.point.z),
        normal: new THREE.Vector3(blocked.normal.x, blocked.normal.y, blocked.normal.z),
        surface: blocked.surface,
        distance: blocked.dist,
      };
    }
    const far = Math.min(maxDistance, 200);
    return {
      type: 'miss',
      point: new THREE.Vector3(origin.x + dir.x * far, origin.y + dir.y * far, origin.z + dir.z * far),
      distance: far,
    };
  }
}
