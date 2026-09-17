/**
 * main.js — boot, wiring and the frame loop.
 *
 * This is the only file that touches the document beyond the UI classes: it
 * owns the lifecycle (menu → load → play → pause → results) and the single
 * per-frame ordering the game depends on:
 *   input → match (player, weapon, AI, hitscan, score) → feedback → culling →
 *   shadow follow → render.
 */
import * as THREE from 'three';
import { PLAYER, RENDER, FX } from './config/GameConfig.js';
import { getDifficulty, DIFFICULTIES } from './config/DifficultyConfig.js';
import { Engine } from './core/Engine.js';
import { InputManager } from './core/InputManager.js';
import { AudioEngine } from './core/AudioEngine.js';
import { makeMaterials } from './core/Textures.js';
import { Fx } from './core/Fx.js';
import { Environment } from './world/Environment.js';
import { PlayerController } from './player/PlayerController.js';
import { Weapon } from './weapons/Weapon.js';
import { AIMachine } from './ai/AIMachine.js';
import { AIBrain } from './ai/AIBrain.js';
import { Match, PHASE } from './game/Match.js';
import { HUD } from './ui/HUD.js';
import { Menu } from './ui/Menu.js';
import { clamp } from './core/math.js';
import './ui/styles.css';

const canvas = document.getElementById('gl');
const uiRoot = document.getElementById('ui');
const screenRoot = document.getElementById('screens');

let difficultyKey = localStorage.getItem('blackline.difficulty') || 'MEDIUM';
let difficulty = getDifficulty(difficultyKey);

const materials = makeMaterials();
const audio = new AudioEngine();
const engine = new Engine({ canvas });
engine.init();
const fx = new Fx({ materials });

const player = new PlayerController({ camera: engine.camera, env: null, audio, fx });
const weapon = new Weapon({
  audio,
  fx,
  materials,
  kick: (p, y, r) => player.applyRecoil(p, y, r),
});
engine.vmScene.add(weapon.group);

const machine = new AIMachine({ fx, audio });
engine.scene.add(machine.root);

let env = null;
let brain = null;
let match = null;
const hud = new HUD({ root: uiRoot, camera: engine.camera });
const menu = new Menu({
  root: screenRoot,
  handlers: {
    play: () => startMatch(),
    restart: () => startMatch(),
    difficulty: () => menu.show('difficulty'),
    controls: () => menu.show('controls'),
    back: () => menu.show(match && match.phase !== PHASE.MENU ? 'pause' : 'main'),
    resume: () => resumePlay(),
    mainMenu: () => toMenu(),
    quit: () => quitToDesktop(),
    playAgain: () => startMatch(),
    pickDifficulty: (key) => setDifficulty(key),
  },
});

const input = new InputManager({
  element: canvas,
  onLockChange: (locked) => {
    // Losing the lock pauses the match — but a *denied* lock (embedded preview
    // iframes) must not pause the match the instant it starts, because then the
    // fallback mouse capture would be unusable.
    if (locked) return;
    if (input.lockDenied) return;
    if (match && match.phase === PHASE.PLAYING) pausePlay();
  },
});
input.attach();

let state = {
  running: false,
  cullT: 0,
  camAngle: 0,
  audioReady: false,
  booted: false,
  errorCount: 0,
};

/* ------------------------------------------------------------------ boot */

async function boot() {
  menu.show('loading');
  menu.setLoading('INITIALISING RENDERER', 0.02);
  env = new Environment({ materials, seed: 20260917 });
  await env.build((task, p) => menu.setLoading(task, p));
  env.culler.attachTo(env.group);
  engine.scene.add(env.group);
  fx.attach(engine.scene);
  fx.setWorld(env.world);
  player.env = env;
  brain = new AIBrain({ machine, env, cfg: difficulty, audio, fx });
  match = new Match({ player, weapon, machine, brain, env, fx, audio, hud, difficulty });
  wireMatchEvents();
  // The viewmodel camera is a rotation-only copy of the eye at the origin of
  // its own scene: that is what keeps the rifle glued to the screen while the
  // weapon's transforms stay usable as camera-space offsets for FX + hit FX.
  match.onCameraSync = () => {
    engine.vmCamera.quaternion.copy(engine.camera.quaternion);
    engine.vmCamera.position.set(0, 0, 0);
    engine.camera.updateMatrixWorld(true);
    engine.vmScene.updateMatrixWorld(true);
  };
  // park the player somewhere sane so the menu camera has a subject
  const s = env.spawns.player[0];
  player.reset(s);
  state.booted = true;
  toMenu();
}

function wireMatchEvents() {
  match.on('hit', (e) => {
    hud.showHitmark({ headshot: e.headshot, graze: e.graze });
    for (const line of e.lines) {
      hud.pushPopup({ text: line.text, kind: line.kind, worldPoint: e.worldPoint, second: line.kind === 'bonus' });
    }
  });
  match.on('playerDamaged', (e) => {
    hud.showDamageArc(e.from);
    hud.log(`HIT TAKEN  -${Math.round(e.damage)}  HP ${Math.round(e.health)}`);
  });
  match.on('warn', (e) => hud.toast(e.text, 900));
  match.on('log', (e) => hud.log(e.text));
  match.on('results', (summary) => {
    document.body.classList.remove('playing');
    input.exitLock();
    setTimeout(() => menu.showResults(summary), 900);
    hud.log(summary.outcome === 'WIN' ? 'TARGET NEUTRALISED · MATCH OVER' : 'YOU WERE TERMINATED');
  });
}

/* ------------------------------------------------------------- lifecycle */

function setDifficulty(key) {
  difficultyKey = key;
  difficulty = getDifficulty(key);
  localStorage.setItem('blackline.difficulty', key);
  menu.setDifficulty(key);
  if (match) match.setDifficulty(difficulty);
  hud.toast(`DIFFICULTY · ${key} · ${difficulty.title}`, 1400);
  audio.play('ui', { gain: 0.7 });
}

async function ensureAudio() {
  if (state.audioReady) return;
  state.audioReady = true; // one attempt per page; the engine guards its own state
  await audio.init();
}

function startMatch() {
  if (!state.booted || !match) return;
  ensureAudio();
  match.setDifficulty(difficulty);
  match.start(difficulty);
  hud.setEnabled(true);
  menu.hide();
  document.body.classList.add('playing');
  state.running = true;
  input.requestLock();
  if (input.lockDenied) hud.toast('MOUSE CAPTURE BLOCKED · USE ALT+ARROWS OR CLICK THE VIEW', 3200);
  hud.log(`MATCH START · ${difficulty.title} · ${DIFFICULTIES[difficultyKey].tagline ?? ''}`);
  if (!engine.started) {
    engine.started = true;
    engine.start();
  }
}

function pausePlay() {
  if (!match || match.phase !== PHASE.PLAYING) return;
  match.pause();
  document.body.classList.remove('playing');
  input.exitLock();
  const s = match.snapshot();
  menu.setPauseInfo(
    `Score ${Math.round(s.score.total).toLocaleString('en-US')} · HP ${s.player.health} · ` +
      `Machine ${s.ai.health}% ${s.ai.status} · Time ${Math.floor(s.elapsed)}s · ${difficultyKey}`,
  );
  menu.show('pause');
}

function resumePlay() {
  if (!match) return;
  menu.hide();
  document.body.classList.add('playing');
  match.resume();
  input.requestLock();
}

function toMenu() {
  state.running = false;
  document.body.classList.remove('playing');
  input.exitLock();
  if (match) match.abandon();
  hud.setEnabled(false);
  menu.setDifficulty(difficultyKey);
  menu.show('main');
}

function quitToDesktop() {
  toMenu();
  hud.toast('SESSION ENDED · CLOSE THE TAB TO FULLY QUIT', 2600);
  // best effort: browsers only allow this for script-opened windows
  try {
    window.open('', '_self').close();
  } catch { /* ignored */ }
}

/* ------------------------------------------------------------ frame loop */

engine.onFrame = (dt, raw) => {
  if (!state.booted) return false;
  const playing = match && match.phase === PHASE.PLAYING;
  let inputState = null;

  if (playing) {
    inputState = input.sample(dt);
    if (inputState.pausePressed) {
      pausePlay();
      return true;
    }
    if (inputState.mutePressed) audio.setMuted(!audio.enabled);
    match.update(dt, inputState);
    hud.updatePopups(dt);
    const snap = match.snapshot();
    if (!inputState.locked && inputState.moveLen === 0 && !inputState.fire && !inputState.ads) {
      // remind the player once per second that capture is off (embedded preview)
      state.lockNag = (state.lockNag ?? 0) + dt;
      if (state.lockNag > 2.2) {
        state.lockNag = 0;
        hud.toast('CLICK TO CAPTURE MOUSE · ALT+ARROWS TO TURN', 1600);
      }
    } else {
      state.lockNag = 0;
    }
    hud.sync(snap, engine.perf);
    state.perfSnap = snap;
  } else {
    // frozen world; still animate FX so the death/impact effects play out
    input.sample(dt);
    if (match) match.update(dt, IDLE_INPUT);
    hud.updatePopups(dt * 0.35);
    cinematicCamera(dt);
  }

  // ---- render-side bookkeeping
  state.cullT -= dt;
  if (state.cullT <= 0) {
    state.cullT = RENDER.cullInterval;
    const res = engine.updateCulling(env, engine.camera.position, dt);
    engine.perf.near = res.props.near;
    engine.perf.far = res.props.far;
    engine.perf.culled = res.props.culled;
    engine.perf.cellsVis = res.cells.visible;
    engine.perf.cellsTot = res.cells.total;
    engine.perf.shadowCasters = res.casters;
    engine.perf.particles = fx.sparks.count + fx.smoke.count + fx.fluid.count;
    engine.perf.rays = env.world.stats.rayCalls;
    engine.perf.boxTests = env.world.stats.boxTests;
    if (brain) {
      engine.perf.aiState = brain.state;
      engine.perf.aiAware = brain.awareness;
      engine.perf.aiHp = Math.round(machine.health);
    }
  }
  engine.updateShadowCamera(engine.camera.position, dt);
  // viewmodel FOV tightens slightly as the rifle settles onto the sights
  engine.vmCamera.fov = dampNum(engine.vmCamera.fov, 58 - (weapon.state.adsT ?? 0) * 8, 12, dt);
  return true;
};

const IDLE_INPUT = {
  lookDelta: { x: 0, y: 0 },
  forward: false, back: false, left: false, right: false,
  jump: false, sprinting: false, crouch: false,
  fire: false, ads: false, reloadPressed: false, pausePressed: false,
  debugPressed: false, mutePressed: false, autoReload: false,
  locked: false, moveLen: 0, dt: 1 / 60,
};

/** Slow orbit around the depot while the menus are up. */
function cinematicCamera(dt) {
  state.camAngle += dt * 0.045;
  const a = state.camAngle;
  const r = 34;
  const cx = 44 + Math.cos(a) * r;
  const cz = 34 + Math.sin(a) * r;
  const y = (env ? env.ground(cx, cz) : 0) + 6.5 + Math.sin(a * 0.7) * 1.6;
  engine.camera.position.lerp(new THREE.Vector3(cx, y, cz), 1 - Math.exp(-1.6 * dt));
  _lookTarget.set(38, engine.camera.position.y - 2.2, 28);
  engine.camera.lookAt(_lookTarget);
  engine.camera.fov = dampNum(engine.camera.fov, 62, 2, dt);
  engine.camera.updateProjectionMatrix();
  if (machine.root.visible) {
    // keep the machine idling in view so the menu shows what you are up against
    machine.update(dt, { speed: 0.6, aimYaw: a + 2.2, aimPitch: 0, crouch: 0, strafe: 0 });
  }
}

const _lookTarget = new THREE.Vector3();

function dampNum(a, b, k, dt) {
  return a + (b - a) * (1 - Math.exp(-k * dt));
}

function toggleDebug() {
  state.debugOn = !state.debugOn;
  document.getElementById('debug')?.classList.toggle('on', state.debugOn);
}

/* --------------------------------------------------------- global keys */

window.addEventListener('keydown', (e) => {
  if (e.code === 'F3') {
    e.preventDefault();
    toggleDebug();
  }
  if (e.code === 'KeyM' && !menuIsOpen()) audio.setMuted(!audio.enabled);
  if (!menuIsOpen()) return;
  const open = menu.current;
  if (e.code === 'Enter' || e.code === 'NumpadEnter') {
    if (open === 'main' || open === 'results') startMatch();
    else if (open === 'difficulty') menu.show('main');
    else if (open === 'controls') menu.show('main');
  }
  if (open === 'main' && e.code === 'KeyC') menu.show('controls');
  if (open === 'main' && e.code === 'KeyD') menu.show('difficulty');
  if (open === 'main' && e.code === 'KeyQ') quitToDesktop();
  if (open === 'pause') {
    if (e.code === 'Escape') resumePlay();
    if (e.code === 'KeyR') startMatch();
    if (e.code === 'KeyD') menu.show('difficulty');
    if (e.code === 'KeyQ') toMenu();
  }
  if (open === 'difficulty') {
    const map = { Digit1: 'EASY', Digit2: 'MEDIUM', Digit3: 'HARD' };
    if (map[e.code]) {
      setDifficulty(map[e.code]);
      menu.show(match && match.phase !== PHASE.MENU ? 'main' : 'main');
    }
  }
  if (e.code === 'Escape' && (open === 'difficulty' || open === 'controls')) menu.show('main');
});

function menuIsOpen() {
  return !!menu.current && menu.current !== 'hidden';
}

// unlock audio on the first interaction (autoplay policy)
window.addEventListener('pointerdown', () => ensureAudio(), { once: true });
window.addEventListener('keydown', () => ensureAudio(), { once: true });

document.addEventListener('pointerdown', (e) => {
  if (match && match.phase === PHASE.PLAYING && !input.locked && e.button === 0) input.requestLock();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && match && match.phase === PHASE.PLAYING) pausePlay();
});

window.addEventListener('error', (ev) => {
  state.errorCount++;
  if (state.errorCount < 4) hud.toast(`RENDERER NOTICE: ${ev.message}`.slice(0, 120), 4000);
});

/* ---------------------------------------------------------------- start */

boot().catch((err) => {
  console.error(err);
  menu.setLoading('WORLD GENERATION FAILED', 0);
  hud.toast(String(err?.message ?? err).slice(0, 160), 8000);
});

// expose a small handle for debugging in the console
window.BLACKLINE = {
  get env() { return env; },
  get match() { return match; },
  get player() { return player; },
  get ai() { return brain; },
  get engine() { return engine; },
  get fx() { return fx; },
  get weapon() { return weapon; },
  setDifficulty,
  startMatch,
  THREE,
  config: { PLAYER, FX, RENDER },
  clamp,
};
