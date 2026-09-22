/**
 * DayNight — the slow clock of DEADFALL.
 *
 * One normalised day (DAYNIGHT.dayLength seconds) drives every lighting input
 * through keyframed atmosphere presets: sun direction/colour/intensity, sky
 * gradients, hemi/ambient fills, fog tint and camera exposure. Dusk and dawn
 * blend smoothly; night stays dark-but-playable (moonlight + lamps).
 *
 * The clock can be overridden by the dev panel (F6) — that pins the phase so
 * weather/lighting QA doesn't cost eight real minutes per test.
 */
import * as THREE from 'three';
import { DAYNIGHT } from '../config/GameConfig.js';
import { clamp, lerp, smoothstep } from '../core/math.js';

// atmosphere keyframes across the normalised day
const KEYS = [
  { t: 0.0, name: 'DAWN', sun: 0x8a4a2e, sunI: 0.55, sky: [0x30263a, 0x8a4a2e, 0x2a2422], hemiI: 0.42, fog: 0x55404a },
  { t: 0.08, name: 'MORNING', sun: 0xffc48a, sunI: 1.6, sky: [0x3d6390, 0xc9a279, 0x3a3a33], hemiI: 0.8, fog: 0x9a8d84 },
  { t: 0.22, name: 'MIDDAY', sun: 0xfff2dd, sunI: 2.35, sky: [0x2e4a63, 0xbfae90, 0x3a3a33], hemiI: 1.1, fog: 0x9fb0ac },
  { t: 0.38, name: 'AFTERNOON', sun: 0xffe0b0, sunI: 2.1, sky: [0x35577c, 0xc4a684, 0x3a3a33], hemiI: 1.0, fog: 0xa5a394 },
  { t: 0.48, name: 'EVENING', sun: 0xffb070, sunI: 1.5, sky: [0x3a4f76, 0xc08d64, 0x3a352d], hemiI: 0.8, fog: 0x94806e },
  { t: 0.55, name: 'SUNSET', sun: 0xff7a3c, sunI: 0.9, sky: [0x35315a, 0xb05a35, 0x352b26], hemiI: 0.55, fog: 0x7a5a4c },
  { t: 0.62, name: 'DUSK', sun: 0x5a4a7a, sunI: 0.32, sky: [0x191d38, 0x4a3a56, 0x211d20], hemiI: 0.34, fog: 0x3d3548 },
  { t: 0.72, name: 'NIGHT', sun: 0x8aa0c8, sunI: 0.16, sky: [0x0a0e1c, 0x1c2233, 0x12130f], hemiI: 0.2, fog: 0x171a26 },
  { t: 0.94, name: 'LATE NIGHT', sun: 0x8aa0c8, sunI: 0.15, sky: [0x0a0e1c, 0x1a2030, 0x12130f], hemiI: 0.19, fog: 0x161a24 },
  { t: 1.0, name: 'DAWN', sun: 0x8a4a2e, sunI: 0.55, sky: [0x30263a, 0x8a4a2e, 0x2a2422], hemiI: 0.42, fog: 0x55404a },
];

const _cA = new THREE.Color();
const _cB = new THREE.Color();

export class DayNight {
  constructor({ startPhase = DAYNIGHT.startPhase, onPhaseChange = null } = {}) {
    this.t = startPhase;
    this.pinned = false;
    this.phaseName = '';
    this.onPhaseChange = onPhaseChange;
    this.out = {
      sunDir: new THREE.Vector3(-0.52, 0.34, -0.78),
      sunColor: new THREE.Color(),
      sunIntensity: 2.35,
      skyTop: new THREE.Color(),
      skyHorizon: new THREE.Color(),
      skyBottom: new THREE.Color(),
      hemiSky: new THREE.Color(0xa9c4d8),
      hemiGround: new THREE.Color(0x5a5341),
      hemiIntensity: 1.15,
      fogColor: new THREE.Color(),
      exposure: 1.06,
      nightFactor: 0,
      isNight: false,
      phase: 'MORNING',
    };
    this.#apply();
  }

  /** Dev override: pin the clock (F6 panel). */
  setTime(t) {
    this.t = clamp(t, 0, 1) % 1;
    this.pinned = true;
    this.#apply();
  }

  unpin() {
    this.pinned = false;
  }

  #keyframe(t) {
    let i = 0;
    for (let k = 0; k < KEYS.length - 1; k++) {
      if (t >= KEYS[k].t && t <= KEYS[k + 1].t) {
        i = k;
        break;
      }
    }
    const a = KEYS[i];
    const b = KEYS[i + 1] ?? KEYS[KEYS.length - 1];
    const span = Math.max(1e-6, b.t - a.t);
    const k = clamp((t - a.t) / span, 0, 1);
    return { a, b, k };
  }

  #apply() {
    const t = this.t;
    const { a, b, k } = this.#keyframe(t);
    const o = this.out;

    // sun arc: rises at ~0.02, sets at ~0.58; at night the "sun" is the moon
    const daySpan = 0.56;
    const sunUp = (t - 0.02) / daySpan;
    const isDaylight = sunUp > 0 && sunUp < 1;
    const elev = isDaylight ? Math.sin(sunUp * Math.PI) * 1.02 : 0.18;
    const azim = lerp(-2.1, 1.9, clamp(sunUp, 0, 1)) + (isDaylight ? 0 : Math.PI * 0.7);
    o.sunDir.set(Math.cos(azim) * 0.72, Math.max(0.12, elev), Math.sin(azim) * 0.72).normalize();

    o.sunColor.copy(_cA.setHex(a.sun)).lerp(_cB.setHex(b.sun), k);
    o.sunIntensity = lerp(a.sunI, b.sunI, k);
    o.skyTop.copy(_cA.setHex(a.sky[0])).lerp(_cB.setHex(b.sky[0]), k);
    o.skyHorizon.copy(_cA.setHex(a.sky[1])).lerp(_cB.setHex(b.sky[1]), k);
    o.skyBottom.copy(_cA.setHex(a.sky[2])).lerp(_cB.setHex(b.sky[2]), k);
    o.hemiIntensity = lerp(a.hemiI, b.hemiI, k);
    o.hemiSky.copy(o.skyTop).lerp(o.skyHorizon, 0.5);
    o.hemiGround.copy(o.fogColor).multiplyScalar(0.5);
    o.fogColor.copy(_cA.setHex(a.fog)).lerp(_cB.setHex(b.fog), k);
    o.exposure = lerp(1.02, 1.12, 1 - o.nightFactor);

    // night factor: ramps through dusk, holds, releases at dawn
    const duskK = smoothstep(0.55, 0.66, t);
    const dawnK = 1 - smoothstep(0.94, 1.0, t) - smoothstep(0.0, 0.045, t === 0 ? 0.045 : 0);
    const dawnRelease = t < 0.1 ? 1 - smoothstep(0.0, 0.05, t) : t > 0.93 ? smoothstep(0.93, 1.0, t) : 0;
    o.nightFactor = clamp(duskK - dawnRelease, 0, 1);
    o.isNight = DAYNIGHT.isNight(t);

    // hemi ground follows fog/soil tone
    o.hemiGround.copy(_cA.setHex(0x5a5341)).lerp(o.fogColor, 0.4).multiplyScalar(lerp(1, 0.42, o.nightFactor));

    // phase name + change event
    let name = KEYS[0].name;
    for (const key of KEYS) {
      if (t >= key.t) name = key.name;
    }
    if (name !== this.phaseName) {
      this.phaseName = name;
      o.phase = name;
      this.onPhaseChange?.(name, t);
    }
  }

  update(dt) {
    if (!this.pinned) {
      this.t = (this.t + dt / DAYNIGHT.dayLength) % 1;
      this.#apply();
    }
    return this.out;
  }

  /** Real-clock time label for the HUD (hh:mm over the day). */
  clockLabel() {
    // phase 0 == 05:30, one day == 24h
    const hours = (5.5 + this.t * 24) % 24;
    const h = Math.floor(hours);
    const m = Math.floor((hours - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}
