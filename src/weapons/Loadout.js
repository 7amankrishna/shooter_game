/**
 * Loadout — the player's three weapons and the switching between them.
 *
 * Slots 1/2/3 (and the mouse wheel) swap weapons through a lower → raise
 * timeline (`def.switchTime`); firing, reloading and ADS are blocked while the
 * swap is in motion. Each weapon keeps its own magazine + reserve; ammo
 * pickups route to the right pool.
 */
import * as THREE from 'three';
import { WEAPONS, WEAPON_ORDER } from '../config/GameConfig.js';
import { Weapon } from './Weapon.js';
import { clamp } from '../core/math.js';

export class Loadout {
  constructor({ audio, fx, materials, kick }) {
    this.audio = audio;
    this.weapons = {};
    for (const key of WEAPON_ORDER) {
      this.weapons[key] = new Weapon({ def: WEAPONS[key], audio, fx, materials, kick });
    }
    this.order = WEAPON_ORDER;
    this.currentKey = 'rifle';
    this.switching = null; // { from, to, t, half }
    this.group = new THREE.Group();
    this.group.name = 'loadout';
    for (const key of WEAPON_ORDER) this.group.add(this.weapons[key].group);
    this.#setVisibility();
  }

  get current() {
    return this.weapons[this.currentKey];
  }

  #setVisibility() {
    for (const key of this.order) {
      this.weapons[key].group.visible = key === this.currentKey;
    }
  }

  select(key) {
    if (!this.weapons[key] || key === this.currentKey || this.switching) return false;
    const from = this.current;
    const to = this.weapons[key];
    if (from.state.reloading) {
      from.state.reloading = false; // switching cancels the reload
      from.state.reloadT = 0;
    }
    this.currentKey = key;
    this.switching = { from, to, t: 0, half: false };
    this.#setVisibility();
    this.audio.play('weaponSwitch', { gain: 0.6 });
    return true;
  }

  selectSlot(slot) {
    const key = this.order.find((k) => WEAPONS[k].slot === slot);
    return key ? this.select(key) : false;
  }

  scroll(dir) {
    const i = this.order.indexOf(this.currentKey);
    const next = this.order[(i + dir + this.order.length) % this.order.length];
    return this.select(next);
  }

  get switchingActive() {
    return !!this.switching;
  }

  /** Ammo routing: 'ammo' → rifle/sidearm reserve, 'ammoBig' → marksman. */
  addAmmo(item, amount) {
    if (item === 'ammoBig') {
      const w = this.weapons.marksman;
      w.state.reserve = Math.min(w.def.reserveMax, w.state.reserve + amount);
      return { weapon: 'marksman', amount };
    }
    if (item === 'ammo') {
      // splits toward the rifle first, overflow to the sidearm
      const rifle = this.weapons.rifle;
      const side = this.weapons.sidearm;
      let left = amount;
      const rifleRoom = rifle.def.reserveMax - rifle.state.reserve;
      const toRifle = Math.min(left, Math.max(0, rifleRoom));
      rifle.state.reserve += toRifle;
      left -= toRifle;
      const sideRoom = side.def.reserveMax - side.state.reserve;
      const toSide = Math.min(left, Math.max(0, sideRoom));
      side.state.reserve += toSide;
      return { weapon: toRifle >= toSide ? 'rifle' : 'sidearm', amount: toRifle + toSide };
    }
    return null;
  }

  reset() {
    for (const key of this.order) this.weapons[key].reset();
    this.currentKey = 'rifle';
    this.switching = null;
    this.#setVisibility();
  }

  serialize() {
    const out = {};
    for (const key of this.order) {
      out[key] = { mag: this.weapons[key].state.mag, reserve: this.weapons[key].state.reserve };
    }
    return { current: this.currentKey, ammo: out };
  }

  restore(data) {
    if (!data?.ammo) return;
    for (const key of this.order) {
      const a = data.ammo[key];
      if (a) {
        this.weapons[key].state.mag = clamp(a.mag | 0, 0, this.weapons[key].def.magSize);
        this.weapons[key].state.reserve = clamp(a.reserve | 0, 0, this.weapons[key].def.reserveMax);
      }
    }
    if (data.current && this.weapons[data.current]) {
      this.currentKey = data.current;
      this.#setVisibility();
    }
  }

  update(dt, state) {
    // ---- switch timeline: lower old (first half), raise new (second half)
    if (this.switching) {
      const sw = this.switching;
      sw.t += dt;
      const total = sw.to.def.switchTime;
      const k = clamp(sw.t / total, 0, 1);
      if (!sw.half) {
        // lowering phase: the outgoing weapon dips and rolls
        const lower = clamp(sw.t / (total * 0.5), 0, 1);
        sw.from.viewRoot.position.y = sw.from.hipPos.y - lower * 0.22;
        sw.from.viewRoot.rotation.x = sw.from.hipRot.x + lower * 0.55;
        if (lower >= 1) sw.half = true;
      } else {
        const raise = clamp((sw.t - total * 0.5) / (total * 0.5), 0, 1);
        const e = 1 - Math.pow(1 - raise, 2);
        sw.to.viewRoot.position.y = sw.to.hipPos.y - (1 - e) * 0.22;
        sw.to.viewRoot.rotation.x = sw.to.hipRot.x + (1 - e) * 0.55;
      }
      if (k >= 1) {
        // snap both rigs back to their anchors
        sw.from.viewRoot.position.copy(sw.from.hipPos);
        sw.from.viewRoot.rotation.copy(sw.from.hipRot);
        sw.to.viewRoot.position.copy(sw.to.hipPos);
        sw.to.viewRoot.rotation.copy(sw.to.hipRot);
        this.switching = null;
      }
      // the incoming weapon still animates (sway) via its own update below
    }
    return this.current.update(dt, state);
  }

  tryFire(now, camera, moveFactor = 0) {
    if (this.switching) return null;
    return this.current.tryFire(now, camera, moveFactor);
  }

  startReload(force = false) {
    if (this.switching) return false;
    return this.current.startReload(force);
  }

  dispose() {
    for (const key of this.order) this.group.remove(this.weapons[key].group);
  }
}
