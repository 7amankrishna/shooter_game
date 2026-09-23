/**
 * Economy — coins, the crate market and the airdrops it sells.
 *
 * Buying a crate doesn't spawn loot at your feet: a drop is scheduled, the
 * crate falls from the sky a short walk away under a canopy, lands with a
 * thud that every zombie within earshot investigates, and only opens for an
 * E interaction. Contents roll per-tier loot tables — the loop is:
 * kill → coins → risk a drop → the drop makes noise → more trouble.
 */
import * as THREE from 'three';
import { ECONOMY } from '../config/GameConfig.js';
import { clamp, makeRng, rand } from '../core/math.js';
import { boxGeo, cylGeo, paint, place, mergeGeos } from '../core/Geo.js';

const TAU = Math.PI * 2;

let SHARED = null;
/** Crate/beacon materials + geometries, shared across every drop. */
function shared(materials) {
  if (SHARED) return SHARED;
  SHARED = {
    beaconMat: new THREE.MeshBasicMaterial({
      color: 0xff5a3c,
      transparent: true,
      opacity: 0.28,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    }),
    canopyMat: new THREE.MeshLambertMaterial({ color: 0x8a2f28, flatShading: true, side: THREE.DoubleSide }),
    beaconGeo: new THREE.CylinderGeometry(0.55, 0.85, 26, 8, 1, true),
    canopyGeo: new THREE.ConeGeometry(1.9, 1.5, 8, 1, true),
  };
  // airdrop crate: olive box, darker lid, strap cylinders — merged, one draw
  const parts = [
    paint(boxGeo(1.25, 0.95, 1.05, { uvScale: 1.4 }), [0.36, 0.34, 0.24]),
    place(paint(boxGeo(1.35, 0.18, 1.15, { uvScale: 1.4 }), [0.27, 0.26, 0.18]), { pos: [0, 0.56, 0] }),
    place(paint(cylGeo(0.055, 0.055, 1.08, 6), [0.16, 0.15, 0.12]), { pos: [-0.3, 0.0, 0], rot: [Math.PI / 2, 0, 0] }),
    place(paint(cylGeo(0.055, 0.055, 1.08, 6), [0.16, 0.15, 0.12]), { pos: [0.3, 0.0, 0], rot: [Math.PI / 2, 0, 0] }),
  ];
  SHARED.crateGeo = mergeGeos(parts);
  return SHARED;
}

export class Economy {
  constructor({
    materials,
    world,
    fx = null,
    audio = null,
    onLoot = () => {},
    onDropLanded = () => {},
    onDropIncoming = () => {},
    seed = 20260917,
  } = {}) {
    this.materials = materials;
    this.world = world;
    this.fx = fx;
    this.audio = audio;
    this.onLoot = onLoot;
    this.onDropLanded = onDropLanded;
    this.onDropIncoming = onDropIncoming;
    this.rng = makeRng(seed ^ 0x51ce77);
    this.coins = ECONOMY.startingCoins;
    this.group = new THREE.Group();
    this.group.name = 'economy';
    this.drops = []; // {id, tier, mesh, canopy, beacon, state, x,y,z, fallFrom, fallT, landed}
    this.incoming = []; // {tier, delay}
    this.nextId = 1;
    this.beaconPulse = 0;
    shared(materials);
  }

  canBuy(tierId) {
    const crate = ECONOMY.crates[tierId];
    if (!crate) return { ok: false, reason: 'UNKNOWN' };
    if (this.coins < crate.cost) return { ok: false, reason: 'COINS' };
    if (this.drops.length + this.incoming.length >= 3) return { ok: false, reason: 'BUSY' };
    return { ok: true, crate };
  }

  buy(tierId) {
    const check = this.canBuy(tierId);
    if (!check.ok) return check;
    this.coins -= check.crate.cost;
    this.incoming.push({ tier: tierId, delay: rand(this.rng, 7, 11) });
    this.onDropIncoming?.(check.crate);
    return { ok: true, crate: check.crate };
  }

  #dropPosition(playerPos) {
    for (let i = 0; i < 12; i++) {
      const a = this.rng() * TAU;
      const d = rand(this.rng, 22, 40);
      const x = playerPos.x + Math.cos(a) * d;
      const z = playerPos.z + Math.sin(a) * d;
      const y = this.world.ground(x, z);
      if (!Number.isFinite(y)) continue;
      if (this.world.terrain.slopeAt(x, z) > 0.5) continue;
      if (!this.world.world.probeCylinder(x, y, z, 1.1, 1.6)) continue;
      const tower = this.world.nearestTower({ x, y, z });
      if (tower && tower.dist < 18) continue;
      return { x, y, z };
    }
    return { x: playerPos.x, y: this.world.ground(playerPos.x, playerPos.z), z: playerPos.z };
  }

  /** Build the crate visuals: box + canopy + beacon column. */
  #spawnDrop(tierId, playerPos) {
    const crate = ECONOMY.crates[tierId];
    const spot = this.#dropPosition(playerPos);
    const g = new THREE.Group();
    g.position.set(spot.x, spot.y + 68, spot.z);
    // the crate itself: merged olive supply box
    const mesh = new THREE.Mesh(SHARED.crateGeo, this.materials.merged);
    mesh.position.set(0, 0.5, 0);
    mesh.castShadow = true;
    g.add(mesh);
    const canopy = new THREE.Mesh(SHARED.canopyGeo, SHARED.canopyMat);
    canopy.position.y = 3.2;
    g.add(canopy);
    const beacon = new THREE.Mesh(SHARED.beaconGeo, SHARED.beaconMat);
    beacon.position.y = 13.4;
    beacon.visible = false;
    g.add(beacon);
    this.group.add(g);
    const drop = {
      id: this.nextId++,
      tier: crate.id,
      label: crate.label,
      group: g,
      mesh,
      canopy,
      beacon,
      state: 'FALLING',
      x: spot.x,
      y: spot.y,
      z: spot.z,
      fallFrom: spot.y + 68,
      fallT: 0,
      landed: false,
    };
    this.drops.push(drop);
    return drop;
  }

  /** E-interaction: open a landed crate at the player's feet. */
  crateNear(pos, radius = 3.4) {
    let best = null;
    let bestD2 = radius * radius;
    for (const d of this.drops) {
      if (!d.landed) continue;
      const dx = d.x - pos.x;
      const dz = d.z - pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = d;
      }
    }
    return best;
  }

  openCrate(drop) {
    if (!drop || drop.opened) return [];
    drop.opened = true;
    const crate = ECONOMY.crates[drop.tier];
    const grants = [];
    for (const roll of crate.rolls) {
      if (this.rng() > roll.chance) continue;
      const amount = Math.round(rand(this.rng, roll.amount[0], roll.amount[1]));
      grants.push({ item: roll.item, amount });
      this.onLoot(roll.item, amount);
    }
    // visual: remove canopy + beacon, crate stays as scenery
    drop.canopy.visible = false;
    drop.beacon.visible = false;
    if (this.fx) {
      this.fx.debris({ x: drop.x, y: drop.y + 0.8, z: drop.z }, [0.5, 0.42, 0.3], 10);
    }
    return grants;
  }

  update(dt, playerPos) {
    // ---- scheduled drops
    for (let i = this.incoming.length - 1; i >= 0; i--) {
      const inc = this.incoming[i];
      inc.delay -= dt;
      if (inc.delay <= 0) {
        this.incoming.splice(i, 1);
        this.#spawnDrop(inc.tier, playerPos);
      }
    }

    this.beaconPulse = (this.beaconPulse + dt * 2.4) % TAU;
    const pulse = 0.75 + Math.sin(this.beaconPulse) * 0.25;

    for (const d of this.drops) {
      if (!d.landed) {
        // canopy descent: fast then braking
        d.fallT += dt;
        const k = clamp(d.fallT / 9, 0, 1);
        const ease = k * k * (3 - 2 * k);
        d.group.position.y = d.fallFrom + (d.y - d.fallFrom) * ease;
        d.canopy.rotation.y += dt * 0.6;
        d.canopy.position.y = 3.2 + Math.sin(d.fallT * 2) * 0.1;
        if (k >= 1) {
          d.landed = true;
          d.state = 'LANDED';
          d.group.position.y = d.y;
          d.canopy.visible = false;
          d.beacon.visible = true;
          if (this.fx) {
            this.fx.debris({ x: d.x, y: d.y + 0.3, z: d.z }, [0.55, 0.5, 0.4], 16);
            this.fx.footstep({ x: d.x, y: d.y, z: d.z });
          }
          // the thud carries — zombies come looking
          this.onDropLanded?.(d);
        }
      } else if (!d.opened) {
        d.beacon.material.opacity = 0.22 * pulse + 0.12;
      }
    }
  }

  /** HUD marker targets: landed, unopened crates. */
  activeDrops() {
    return this.drops.filter((d) => d.landed && !d.opened);
  }

  addCoins(amount) {
    this.coins = Math.max(0, Math.round(this.coins + amount));
  }

  serialize() {
    return { coins: this.coins };
  }

  restore(data) {
    if (data && typeof data.coins === 'number') this.coins = data.coins;
  }

  clear() {
    for (const d of this.drops) this.group.remove(d.group);
    this.drops.length = 0;
    this.incoming.length = 0;
  }

  dispose() {
    this.clear();
    // shared assets are intentionally not disposed (module-lifetime)
  }
}
