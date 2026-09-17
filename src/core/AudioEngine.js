/**
 * AudioEngine — procedural, positional sound.
 *
 * Nothing is sampled: gunshots, reloads, impacts and ambience are synthesised
 * from noise + oscillator + filter graphs, which keeps the build tiny and lets
 * every cue be parameterised (distance, direction, material, intensity).
 *
 * Spatialisation uses a pooled set of PannerNodes (HRTF where available) so a
 * burst to the player's left really does arrive from the left. The whole engine
 * degrades to a no-op when WebAudio is blocked or missing, so gameplay never
 * depends on audio — `NullAudio` is used by the headless simulation tests.
 */
import { AUDIO } from '../config/GameConfig.js';

const NOISE_CACHE = new Map();

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.enabled = true;
    this.volumes = { master: AUDIO.master, sfx: 0.9, ambient: 0.55, music: 0.5 };
    this.panners = [];
    this.listener = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: -1, ux: 0, uy: 1, uz: 0 };
    this.loops = {};
    this.budget = { time: -1, count: 0 };
  }

  /** Must be called from a user gesture (the menu's PLAY click does this). */
  async init() {
    if (this.ctx || this.failed) return this.ready;
    const AC = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
    if (!AC) {
      this.failed = true;
      return false;
    }
    try {
      this.ctx = new AC({ latencyHint: 'interactive' });
    } catch {
      this.failed = true;
      return false;
    }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volumes.master;
    this.limiter = ctx.createDynamicsCompressor();
    try {
      this.limiter.threshold.value = -13;
      this.limiter.knee.value = 22;
      this.limiter.ratio.value = 12;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.22;
    } catch { /* older implementations expose read-only params */ }

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this.volumes.sfx;
    this.ambientBus = ctx.createGain();
    this.ambientBus.gain.value = this.volumes.ambient;
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.volumes.music;

    // A short procedurally generated impulse response gives the yard its
    // concrete slap without shipping a reverb asset.
    this.reverbInput = ctx.createGain();
    this.reverbInput.gain.value = 0.32;
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.makeImpulse(ctx, 1.9, 2.7);
    this.reverbInput.connect(this.reverb).connect(this.limiter);

    this.sfxBus.connect(this.limiter);
    this.ambientBus.connect(this.limiter);
    this.musicBus.connect(this.limiter);
    this.limiter.connect(this.master);
    this.master.connect(ctx.destination);

    for (let i = 0; i < AUDIO.pannerPool; i++) this.panners.push({ node: this.#makePanner(ctx), busy: 0 });

    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch { /* resume again on the next gesture */ }
    }
    this.ready = true;
    this.loop('wind', true, { gain: 0.4 });
    this.loop('drone', true, { gain: 0.14 });
    return true;
  }

  #makePanner(ctx) {
    const p = ctx.createPanner();
    try {
      p.panningModel = 'HRTF';
    } catch { /* ignore */ }
    p.distanceModel = 'inverse';
    p.refDistance = AUDIO.refDistance;
    p.maxDistance = AUDIO.maxDistance;
    p.rolloffFactor = AUDIO.rolloff;
    p.connect(this.sfxBus);
    return p;
  }

  makeImpulse(ctx, seconds, decay) {
    const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (1 - t * 0.15);
      }
    }
    return buf;
  }

  /** Cached white/brown/pink noise buffer. Shared across all SFX. */
  noise(ctx, seconds, kind = 'white') {
    const key = `${kind}${Math.round(seconds * 100)}`;
    if (NOISE_CACHE.has(key)) return NOISE_CACHE.get(key);
    const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      if (kind === 'brown') {
        last = (last + 0.02 * white) / 1.02;
        d[i] = last * 3.4;
      } else if (kind === 'pink') {
        last = last * 0.72 + white * 0.28;
        d[i] = last * 1.7;
      } else {
        d[i] = white;
      }
    }
    NOISE_CACHE.set(key, buf);
    return buf;
  }

  get currentTime() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  setListener(pos, forward, up) {
    const l = this.listener;
    l.x = pos.x; l.y = pos.y; l.z = pos.z;
    l.fx = forward.x; l.fy = forward.y; l.fz = forward.z;
    l.ux = up.x; l.uy = up.y; l.uz = up.z;
    if (!this.ctx) return;
    const lp = this.ctx.listener;
    const t = this.ctx.currentTime;
    if (lp.positionX) {
      lp.positionX.setTargetAtTime(l.x, t, 0.02);
      lp.positionY.setTargetAtTime(l.y, t, 0.02);
      lp.positionZ.setTargetAtTime(l.z, t, 0.02);
      lp.forwardX.setTargetAtTime(l.fx, t, 0.02);
      lp.forwardY.setTargetAtTime(l.fy, t, 0.02);
      lp.forwardZ.setTargetAtTime(l.fz, t, 0.02);
      lp.upX.setTargetAtTime(l.ux, t, 0.02);
      lp.upY.setTargetAtTime(l.uy, t, 0.02);
      lp.upZ.setTargetAtTime(l.uz, t, 0.02);
    } else if (lp.setPosition) {
      lp.setPosition(l.x, l.y, l.z);
      lp.setOrientation(l.fx, l.fy, l.fz, l.ux, l.uy, l.uz);
    }
  }

  setVolume(kind, value) {
    this.volumes[kind] = value;
    if (!this.ctx) return;
    const node = { master: this.master, sfx: this.sfxBus, ambient: this.ambientBus, music: this.musicBus }[kind];
    if (node) node.gain.value = value;
  }

  setMuted(muted) {
    this.enabled = !muted;
    if (this.master) this.master.gain.value = muted ? 0 : this.volumes.master;
  }

  #acquirePanner(pos, vel) {
    const now = this.ctx.currentTime;
    let best = null;
    for (const p of this.panners) if (!best || p.busy < best.busy) best = p;
    best.busy = now + 0.45;
    const n = best.node;
    if (n.positionX) {
      n.positionX.setTargetAtTime(pos.x, now, 0.01);
      n.positionY.setTargetAtTime(pos.y, now, 0.01);
      n.positionZ.setTargetAtTime(pos.z, now, 0.01);
      if (vel && n.velocityX) {
        n.velocityX.setTargetAtTime(vel.x, now, 0.05);
        n.velocityY.setTargetAtTime(vel.y, now, 0.05);
        n.velocityZ.setTargetAtTime(vel.z, now, 0.05);
      }
    } else if (n.setPosition) {
      n.setPosition(pos.x, pos.y, pos.z);
      if (vel && n.setVelocity) n.setVelocity(vel.x, vel.y, vel.z);
    }
    return n;
  }

  /**
   * Plays a named cue; passing `pos` (world space) makes it positional.
   * A per-frame budget keeps a close-quarters firefight from overloading the
   * audio thread when many impacts land in the same tick.
   */
  play(name, { pos = null, vel = null, gain = 1, pitch = 1, when = 0, send = 1 } = {}) {
    if (!this.ready || !this.enabled || !this.ctx) return;
    const cue = CUES[name];
    if (!cue) return;
    const now = this.ctx.currentTime + when;
    const bucket = Math.floor(now * 10);
    if (bucket !== this.budget.time) {
      this.budget.time = bucket;
      this.budget.count = 0;
    }
    if (++this.budget.count > 20) return;
    let dist = 0;
    if (pos) {
      const l = this.listener;
      dist = Math.hypot(pos.x - l.x, pos.y - l.y, pos.z - l.z);
      if (dist > 220) return;
      if (dist > AUDIO.farFallback) gain *= Math.max(0.12, 1 - (dist - AUDIO.farFallback) / 240);
    }
    const out = pos ? this.#acquirePanner(pos, vel) : this.sfxBus;
    try {
      cue(this, out, now, gain, pitch, dist, send);
    } catch { /* audio must never break a frame */ }
  }

  loop(name, on, params = {}) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const existing = this.loops[name];
    if (!on) {
      if (existing) {
        const g = existing.gain;
        g.gain.setTargetAtTime(0, ctx.currentTime, 0.2);
        setTimeout(() => {
          try { existing.stop(); } catch { /* already torn down */ }
        }, 800);
        delete this.loops[name];
      }
      return;
    }
    if (existing) {
      existing.gain.gain.setTargetAtTime(params.gain ?? 0.3, ctx.currentTime, 0.25);
      if (existing.detune && params.pitch) existing.detune.setTargetAtTime((params.pitch - 1) * 900, ctx.currentTime, 0.25);
      return;
    }
    const made = LOOPS[name]?.(this, ctx);
    if (!made) return;
    const g = ctx.createGain();
    g.gain.value = 0;
    made.node.connect(g);
    g.connect(made.bus ?? this.ambientBus);
    g.gain.setTargetAtTime(params.gain ?? 0.3, ctx.currentTime, 0.5);
    const sources = made.sources ?? [made.node];
    this.loops[name] = {
      gain: g,
      detune: made.detune,
      stop: () => {
        for (const s of sources) {
          try { s.stop?.(); s.disconnect?.(); } catch { /* noop */ }
        }
        try { g.disconnect(); } catch { /* noop */ }
      },
    };
  }

  /** Swells while the machine has eyes on the player. */
  setTension(value) {
    if (!this.ready) return;
    if (!this.loops.tension) this.loop('tension', true, { gain: 0.0001 });
    this.loops.tension.gain.gain.setTargetAtTime(0.015 + value * 0.2, this.ctx.currentTime, 0.5);
  }

  /** Actuator hum of the machine, driven by distance + whether it is moving. */
  setMachineProximity(distance, moving) {
    if (!this.ready) return;
    if (distance >= 46) {
      this.loop('servo', false);
      return;
    }
    const k = 1 - distance / 46;
    this.loop('servo', true, { gain: 0.04 + k * 0.26 * (moving ? 1.4 : 1), pitch: 0.95 + (moving ? 0.22 : 0) });
  }

  dispose() {
    for (const k of Object.keys(this.loops)) this.loop(k, false);
    this.ctx?.close?.();
    this.ctx = null;
    this.ready = false;
  }
}

/* ------------------------------------------------------------- primitives */

function burst(a, out, now, { dur = 0.2, type = 'highpass', freq = 900, q = 0.8, gain = 1, kind = 'white', rate = 1 }) {
  const ctx = a.ctx;
  const src = ctx.createBufferSource();
  src.buffer = a.noise(ctx, Math.min(2, Math.max(0.08, dur * 1.6)), kind);
  src.playbackRate.value = rate;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, now);
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.linearRampToValueAtTime(gain, now + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0008, now + dur);
  src.connect(f);
  f.connect(g);
  g.connect(out);
  src.start(now);
  src.stop(now + dur * 1.5);
  return { filter: f, gain: g, src };
}

function tone(a, out, now, { freq = 200, end = null, dur = 0.12, gain = 0.3, type = 'sine' }) {
  const ctx = a.ctx;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, now);
  if (end && end !== freq) o.frequency.exponentialRampToValueAtTime(Math.max(20, end), now + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.linearRampToValueAtTime(gain, now + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0008, now + dur);
  o.connect(g);
  g.connect(out);
  o.start(now);
  o.stop(now + dur + 0.04);
  return { osc: o, gain: g };
}

const CUES = {
  /** Player rifle: crack + body thump + yard reverb tail. */
  shotPlayer(a, out, now, gain, pitch, dist, send) {
    const g = burst(a, out, now, { dur: 0.16, type: 'bandpass', freq: 1750 * pitch, q: 0.7, gain: 0.8 * gain });
    g.filter.frequency.exponentialRampToValueAtTime(430, now + 0.15);
    tone(a, out, now, { freq: 152 * pitch, end: 46, dur: 0.16, gain: 0.5 * gain, type: 'sine' });
    burst(a, a.reverbInput, now, { dur: 0.5, type: 'lowpass', freq: 1500, gain: 0.36 * gain * send, kind: 'pink' });
  },
  /** Someone else's weapon: duller, more low-mid, longer tail. */
  shotAI(a, out, now, gain, pitch) {
    burst(a, out, now, { dur: 0.2, type: 'bandpass', freq: 950 * pitch, q: 0.9, gain: 0.62 * gain, kind: 'pink' });
    tone(a, out, now, { freq: 120 * pitch, end: 42, dur: 0.2, gain: 0.44 * gain, type: 'triangle' });
    burst(a, a.reverbInput, now, { dur: 0.7, type: 'lowpass', freq: 900, gain: 0.42 * gain, kind: 'pink' });
  },
  dryFire(a, out, now, gain) {
    burst(a, out, now, { dur: 0.05, type: 'highpass', freq: 3800, gain: 0.3 * gain });
    tone(a, out, now, { freq: 1500, end: 700, dur: 0.04, gain: 0.14 * gain, type: 'square' });
  },
  magOut(a, out, now, gain) {
    burst(a, out, now, { dur: 0.09, type: 'bandpass', freq: 2100, q: 2.4, gain: 0.26 * gain });
    tone(a, out, now, { freq: 320, end: 180, dur: 0.1, gain: 0.16 * gain, type: 'square' });
  },
  magIn(a, out, now, gain) {
    burst(a, out, now + 0.02, { dur: 0.1, type: 'bandpass', freq: 1300, q: 3, gain: 0.3 * gain });
    tone(a, out, now + 0.02, { freq: 220, end: 120, dur: 0.12, gain: 0.22 * gain, type: 'square' });
  },
  bolt(a, out, now, gain) {
    burst(a, out, now, { dur: 0.07, type: 'highpass', freq: 2600, gain: 0.26 * gain });
    tone(a, out, now, { freq: 800, end: 340, dur: 0.06, gain: 0.16 * gain, type: 'sawtooth' });
  },
  hit(a, out, now, gain) {
    tone(a, out, now, { freq: 1180, end: 1580, dur: 0.07, gain: 0.26 * gain, type: 'triangle' });
    burst(a, out, now, { dur: 0.05, type: 'highpass', freq: 4200, gain: 0.12 * gain });
  },
  headshot(a, out, now, gain) {
    tone(a, out, now, { freq: 1560, end: 2400, dur: 0.14, gain: 0.3 * gain });
    tone(a, out, now + 0.06, { freq: 2340, end: 3120, dur: 0.16, gain: 0.2 * gain });
  },
  impactConcrete(a, out, now, gain) {
    burst(a, out, now, { dur: 0.13, type: 'bandpass', freq: 2500, q: 1.4, gain: 0.26 * gain, kind: 'pink' });
    tone(a, out, now, { freq: 260, end: 90, dur: 0.09, gain: 0.14 * gain, type: 'triangle' });
  },
  impactMetal(a, out, now, gain) {
    tone(a, out, now, { freq: 2400, end: 1250, dur: 0.2, gain: 0.18 * gain, type: 'square' });
    burst(a, out, now, { dur: 0.1, type: 'highpass', freq: 3200, gain: 0.2 * gain });
  },
  impactWood(a, out, now, gain) {
    burst(a, out, now, { dur: 0.11, type: 'bandpass', freq: 720, q: 1.6, gain: 0.26 * gain, kind: 'brown' });
  },
  impactFlesh(a, out, now, gain) {
    burst(a, out, now, { dur: 0.09, type: 'lowpass', freq: 620, gain: 0.26 * gain, kind: 'brown' });
    tone(a, out, now, { freq: 150, end: 70, dur: 0.1, gain: 0.16 * gain });
  },
  step(a, out, now, gain) {
    burst(a, out, now, { dur: 0.075, type: 'bandpass', freq: 380 + Math.random() * 280, q: 1.1, gain: 0.18 * gain, kind: 'brown' });
  },
  land(a, out, now, gain) {
    burst(a, out, now, { dur: 0.16, type: 'lowpass', freq: 420, gain: 0.3 * gain, kind: 'brown' });
  },
  hurt(a, out, now, gain) {
    tone(a, out, now, { freq: 300, end: 110, dur: 0.22, gain: 0.26 * gain, type: 'sawtooth' });
    burst(a, out, now, { dur: 0.18, type: 'lowpass', freq: 900, gain: 0.18 * gain, kind: 'pink' });
  },
  servo(a, out, now, gain) {
    tone(a, out, now, { freq: 430, end: 900, dur: 0.22, gain: 0.12 * gain, type: 'sawtooth' });
  },
  spot(a, out, now, gain) {
    tone(a, out, now, { freq: 620, end: 470, dur: 0.18, gain: 0.16 * gain, type: 'square' });
  },
  kill(a, out, now, gain) {
    tone(a, out, now, { freq: 520, end: 130, dur: 0.5, gain: 0.26 * gain, type: 'sawtooth' });
    burst(a, out, now, { dur: 0.55, type: 'lowpass', freq: 1200, gain: 0.26 * gain, kind: 'brown' });
    tone(a, out, now + 0.16, { freq: 1320, end: 1760, dur: 0.4, gain: 0.14 * gain });
  },
  ui(a, out, now, gain) {
    tone(a, out, now, { freq: 900, end: 1320, dur: 0.07, gain: 0.12 * gain });
  },
  uiBack(a, out, now, gain) {
    tone(a, out, now, { freq: 700, end: 420, dur: 0.09, gain: 0.11 * gain });
  },
  shell(a, out, now, gain) {
    burst(a, out, now, { dur: 0.06, type: 'bandpass', freq: 5200, q: 3, gain: 0.08 * gain });
  },
};

/* ------------------------------------------------------------------ loops */

const LOOPS = {
  wind(a, ctx) {
    const src = ctx.createBufferSource();
    src.buffer = a.noise(ctx, 4, 'brown');
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    lp.Q.value = 0.7;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 90;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 240;
    lfo.connect(lfoGain);
    lfoGain.connect(lp.frequency);
    src.connect(lp);
    lp.connect(hp);
    src.start();
    lfo.start();
    return { node: hp, sources: [src, lfo] };
  },
  drone(a, ctx) {
    const src = ctx.createBufferSource();
    src.buffer = a.noise(ctx, 3, 'pink');
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 140;
    f.Q.value = 1.6;
    src.connect(f);
    src.start();
    return { node: f, sources: [src] };
  },
  tension(a, ctx) {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 55;
    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = 82.5;
    const mix = ctx.createGain();
    mix.gain.value = 0.5;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 260;
    osc.connect(mix);
    osc2.connect(mix);
    mix.connect(f);
    osc.start();
    osc2.start();
    return { node: f, sources: [osc, osc2], detune: osc.frequency };
  },
  servo(a, ctx) {
    const src = ctx.createBufferSource();
    src.buffer = a.noise(ctx, 2, 'white');
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 720;
    f.Q.value = 7;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 132;
    const og = ctx.createGain();
    og.gain.value = 0.35;
    osc.connect(og);
    og.connect(f);
    src.connect(f);
    src.start();
    osc.start();
    return { node: f, sources: [src, osc], detune: osc.frequency };
  },
};

/** Sink used by the headless simulation harness (and when audio is blocked). */
export class NullAudio {
  async init() { return false; }
  play() {}
  loop() {}
  setListener() {}
  setTension() {}
  setMachineProximity() {}
  setVolume() {}
  setMuted() {}
  dispose() {}
  get ready() { return false; }
  get listener() { return { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: -1 }; }
}
