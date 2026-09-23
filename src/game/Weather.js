/**
 * Weather — rolling fronts with 10-second blends, fog budgets and lightning.
 *
 * State machine over the six WEATHER.states, driven by a transition matrix
 * that keeps weather "in family" (storms ease into rain, fog lingers). All
 * values are produced as *current* blended outputs so lighting/audio/fog
 * consumers never see a step. Storms emit lightning events with a distance
 * estimate for delayed thunder.
 */
import * as THREE from 'three';
import { WEATHER } from '../config/GameConfig.js';
import { clamp, lerp, makeRng, rand } from '../core/math.js';

export class Weather {
  constructor({ seed = 20260917, onLightning = null, onStateChange = null } = {}) {
    this.rng = makeRng(seed ^ 0x77aa11);
    this.state = 'CLEAR';
    this.prevState = 'CLEAR';
    this.nextState = 'CLEAR';
    this.blend = 1; // 0 = prevState, 1 = nextState(current)
    this.rerollT = rand(this.rng, WEATHER.rerollInterval[0], WEATHER.rerollInterval[1]);
    this.lightningT = 0;
    this.flash = 0; // decaying 0..1 — consumers add it to lighting
    this.onLightning = onLightning;
    this.onStateChange = onStateChange;
    this.pinned = null;
    this.out = {
      fogNear: 90,
      fogFar: 250,
      dim: 1,
      rain: 0,
      cloud: 0.15,
      wind: 0.3,
      state: 'CLEAR',
      storm: false,
    };
    this._fogColor = new THREE.Color();
  }

  #pick() {
    const row = WEATHER.chances[this.state];
    let r = this.rng();
    for (const [k, p] of Object.entries(row)) {
      r -= p;
      if (r <= 0) return k;
    }
    return 'CLEAR';
  }

  /** Dev override (F6): pin one state. */
  setState(name) {
    if (!WEATHER.states[name]) return;
    this.pinned = name;
    this.prevState = this.state;
    this.nextState = name;
    this.blend = 0;
    this.rerollT = 1e9;
  }

  unpin() {
    this.pinned = null;
    this.rerollT = rand(this.rng, WEATHER.rerollInterval[0], WEATHER.rerollInterval[1]);
  }

  #blendOf(a, b, k, key) {
    return lerp(WEATHER.states[a][key], WEATHER.states[b][key], k);
  }

  update(dt, { nightFactor = 0 } = {}) {
    // ---- reroll / transition
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / WEATHER.transitionTime);
      if (this.blend >= 1) {
        this.state = this.nextState;
        this.prevState = this.nextState;
      }
    } else if (!this.pinned) {
      this.rerollT -= dt;
      if (this.rerollT <= 0) {
        const next = this.#pick();
        this.rerollT = rand(this.rng, WEATHER.rerollInterval[0], WEATHER.rerollInterval[1]);
        if (next !== this.state) {
          this.prevState = this.state;
          this.nextState = next;
          this.blend = 0;
          this.onStateChange?.(next);
        }
      }
    }

    const k = this.blend;
    const a = this.prevState;
    const b = this.nextState;
    const o = this.out;
    o.fogNear = this.#blendOf(a, b, k, 'fogNear');
    o.fogFar = this.#blendOf(a, b, k, 'fogFar');
    o.dim = this.#blendOf(a, b, k, 'dim');
    o.rain = this.#blendOf(a, b, k, 'rain');
    o.cloud = this.#blendOf(a, b, k, 'cloud');
    o.state = k > 0.5 ? b : a;
    o.storm = o.state === 'STORM';
    o.wind = 0.25 + o.cloud * 0.5 + (o.storm ? 0.35 : 0);

    // night pulls fog in tighter — the dark does the rest
    o.fogFar = lerp(o.fogFar, o.fogFar * 0.62, nightFactor);
    o.fogNear = lerp(o.fogNear, o.fogNear * 0.7, nightFactor);

    // ---- lightning
    this.flash = Math.max(0, this.flash - dt * 3.4);
    if (o.storm && !this.pinned === false) {
      // (pinned storms still lightning for QA)
    }
    if (o.storm || this.pinned === 'STORM') {
      this.lightningT -= dt;
      if (this.lightningT <= 0) {
        this.lightningT = rand(this.rng, WEATHER.lightningInterval[0], WEATHER.lightningInterval[1]);
        this.flash = 0.8 + this.rng() * 0.4;
        const distanceKm = 0.6 + this.rng() * 5;
        this.onLightning?.({ distanceKm, intensity: this.flash });
      }
    }
    return o;
  }

  /** Fog colour follows the day-night tint, desaturated by cloud cover. */
  fogColor(dayFogColor, out = new THREE.Color()) {
    out.copy(dayFogColor);
    const grey = 0.3 + this.out.cloud * 0.12;
    out.lerp(this._fogColor.setRGB(grey * 0.9, grey * 0.95, grey), clamp(this.out.cloud * 0.55, 0, 0.6));
    return out;
  }
}
