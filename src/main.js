/**
 * main.js — boot, wiring and the frame loop for BLACKLINE: DEADFALL.
 *
 * This is the only file that touches the document beyond the UI classes: it
 * owns the lifecycle (menu → load → play ⇄ pause → death → menu) and applies
 * settings live (sensitivity, FOV, volumes, quality, shake). The per-frame
 * ordering lives in Survival.update; main just drives the engine and routes
 * the menu/pause flow around it.
 */
import * as THREE from 'three';
import { RENDER } from './config/GameConfig.js';
import { Engine } from './core/Engine.js';
import { InputManager } from './core/InputManager.js';
import { AudioEngine } from './core/AudioEngine.js';
import { Survival } from './game/Survival.js';
import { HUD } from './ui/HUD.js';
import { Menu, loadSettings, saveSettings } from './ui/Menu.js';
import { clamp } from './core/math.js';
import './ui/styles.css';

const canvas = document.getElementById('gl');
const uiRoot = document.getElementById('ui');
const screenRoot = document.getElementById('screens');

const settings = loadSettings();
const audio = new AudioEngine();
const engine = new Engine({ canvas });
// Keep the menu usable even when a browser refuses to create a WebGL context.
// Engine.init reports the failure through `engine.webglAvailable`; the menu
// can then show a useful message instead of leaving the user with a black page.
engine.init();

const hud = new HUD({ root: uiRoot, camera: engine.camera });
let game = null; // built after the first PLAY (world gen needs the loading screen)
let started = false;
let starting = false;

/* ------------------------------------------------------------- settings */

function applySettings(s) {
  input.sensitivity = clamp(s.sensitivity, 0.1, 4);
  engine.camera.fov = clamp(s.fov, 50, 110);
  engine.camera.updateProjectionMatrix();
  audio.setVolume('master', s.volumeMaster);
  audio.setVolume('sfx', s.volumeSfx);
  audio.setVolume('music', s.volumeMusic);
  if (game) game.settings = { ...s };
  saveSettings(s);
}

/* ------------------------------------------------------------- the menu */

const menu = new Menu({
  root: screenRoot,
  settings,
  handlers: {
    onPlay: () => startRun(true),
    onContinue: () => startRun(false),
    onResume: () => resumePlay(),
    onRestart: () => {
      menu.show('loading');
      menu.setLoadingProgress(0, 'clearing the dead…');
      game?.requestRestart();
      setTimeout(() => {
        hud.hideDeath();
        game?.start();
        menu.hideAll();
        input.requestLock();
        started = true;
      }, 400);
    },
    onQuit: () => toMenu(),
    onExit: () => quitToDesktop(),
    onSettingsChange: applySettings,
  },
});

if (engine.webglAvailable === false) {
  menu.setStartupError('WEBGL UNAVAILABLE — 3D RENDERING IS DISABLED');
}

const input = new InputManager({
  element: canvas,
  onLockChange: (locked, details = {}) => {
    if (!locked && details.wasLocked && started && game?.state === 'playing' && !game.buyMenuOpen && !game.adminOpen) {
      // losing pointer lock mid-run = pause (unless an overlay intentionally took it).
      // A denied initial request is not a pause: the InputManager mouse fallback
      // keeps the run playable in Vercel previews and restrictive browsers.
      pausePlay();
    }
  },
  onUnlock: () => {},
});
input.attach();
applySettings(settings);

function startRun(fresh) {
  if (starting) return;
  starting = true;
  // This call still runs in the PLAY/CONTINUE click gesture. The request made
  // after async world generation below may be rejected by browser activation
  // rules, so acquire it early when possible; gameplay also works without it.
  input.requestLock();
  menu.show('loading');
  menu.setLoadingProgress(0.02, 'carving terrain…');
  const tick = () => new Promise((r) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(r);
    else setTimeout(r, 0);
  });
  (async () => {
    try {
      if (!game) {
        game = new Survival({ engine, input, audio, hud, seed: Date.now() % 2147483647, settings });
        // World.build reports (label, fraction). Keep the progress bar honest
        // instead of multiplying the descriptive label by a number.
        await game.init((label, p) => menu.setLoadingProgress(
          0.05 + (Number.isFinite(p) ? p : 0) * 0.9,
          label || (p < 0.5 ? 'carving terrain…' : 'seeding the dead…'),
        ));
      } else {
        await tick();
      }
      menu.setLoadingProgress(1, 'ready');
      menu.setStartupError('');
      if (fresh) {
        game.requestRestart(); // fresh run clears the save
        game.start();
      } else if (!game.continueRun()) {
        // A stale/corrupt save should never leave the menu hidden with a
        // non-running game behind it. Fall back to a clean run.
        game.start();
      }
      hud.hideDeath();
      menu.hideAll();
      if (!input.locked) input.requestLock();
      started = true;
      starting = false;
    } catch (error) {
      // A failed WebGL/context or world build must never strand the app on a
      // blank screen. Leave the menu visible and give the user an actionable
      // message; the error is still logged for development.
      console.error('BLACKLINE failed to start a run', error);
      try {
        game?.dispose?.();
      } catch (disposeError) {
        console.error('BLACKLINE cleanup after startup failure also failed', disposeError);
      }
      game = null;
      started = false;
      starting = false;
      input.exitLock();
      menu.show('main');
      menu.setStartupError('STARTUP FAILED — RELOAD TO TRY AGAIN');
    }
  })();
}

function pausePlay() {
  if (!game || game.state !== 'playing') return;
  game.pause();
  menu.show('pause');
  input.exitLock();
}

function resumePlay() {
  if (!game) return;
  game.resume();
  menu.hideAll();
  input.requestLock();
}

function toMenu() {
  if (game) {
    game.pause();
    hud.hideOverlays();
  }
  menu.setContinueVisible(game?.hasSave() ?? false);
  menu.show('main');
  started = false;
  input.exitLock();
}

function quitToDesktop() {
  // browsers don't allow real exit; close the tab politely if permitted
  try {
    window.close();
  } catch { /* sandboxed */ }
  toMenu();
}

/* ----------------------------------------------------------- admin wiring */

// the dev panel emits commands through DOM events (sliders/buttons in the HUD)
uiRoot.addEventListener('input', (e) => {
  if (e.target?.dataset?.cmd === 'time' && game) {
    input.adminCommand = { time: parseFloat(e.target.value) };
  }
});
uiRoot.addEventListener('click', (e) => {
  const cmd = e.target?.dataset?.cmd;
  if (!cmd || !game) return;
  if (cmd === 'weather') input.adminCommand = { weather: e.target.dataset.value };
  else if (cmd === 'unpin') input.adminCommand = { unpin: true };
});

/* ------------------------------------------------------------- the loop */

let debugOverlay = false;

// AudioEngine.setListener takes (position, forward, up) vectors, not a camera.
// Handing it the camera threw on every frame (`forward` was undefined), which
// aborted onFrame before it could return true, so after PLAY the world never
// rendered: HUD over a black screen. Scratch vectors keep this allocation-free.
const listenerPos = new THREE.Vector3();
const listenerForward = new THREE.Vector3();
const listenerUp = new THREE.Vector3();

function syncAudioListener(camera) {
  // getWorldDirection refreshes matrixWorld, so position/up read from it are
  // this frame's. The camera's own up axis (not the constant camera.up) keeps
  // HRTF panning right while looking up or down.
  camera.getWorldDirection(listenerForward);
  listenerPos.setFromMatrixPosition(camera.matrixWorld);
  listenerUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
  audio.setListener(listenerPos, listenerForward, listenerUp);
}

engine.onFrame = (dt) => {
  // startRun assigns `game` before its async world build begins. Do not call
  // into the partially constructed Survival instance during that window: its
  // FX/player/world fields are intentionally created by init().
  if (!game || game.state === 'loading') return false;

  // the one true update — Survival samples the input itself and exposes the
  // state as game.inp (sampling twice a frame would eat pressed keys)
  game.update(dt);
  const st = game.inp ?? {};

  if (st.pausePressed) {
    if (game.state === 'playing') {
      if (game.buyMenuOpen || game.adminOpen) {
        game.escapeAction();
      } else {
        pausePlay();
        return false;
      }
    } else if (game.state === 'paused') {
      resumePlay();
      return false;
    }
  }
  if (st.debugPressed) {
    debugOverlay = !debugOverlay;
    engine.debug = debugOverlay;
  }
  if (st.mutePressed) {
    audio.setMuted(!audio.enabled);
  }
  if (game.state === 'dead' && st.interactPressed) {
    menu.show('loading');
    menu.setLoadingProgress(0, 'clearing the dead…');
    game.requestRestart();
    setTimeout(() => {
      hud.hideDeath();
      game.start();
      menu.hideAll();
      input.requestLock();
    }, 400);
    return false;
  }
  if (game.state === 'paused') return false; // frozen overlay frame

  // spatial audio follows the camera
  syncAudioListener(engine.camera);

  // streaming-world culling + LOD
  engine.updateWorldCulling(game.world, engine.camera.position);
  return true; // render
};

engine.start();

// menu shows CONTINUE only when a run exists
menu.setContinueVisible(false);

// clicking the canvas re-captures the pointer after it's lost
canvas.addEventListener('click', () => {
  if (started && game?.state === 'playing' && !input.locked) input.requestLock();
});

window.addEventListener('blur', () => {
  if (started && game?.state === 'playing') pausePlay();
});

// browser gesture → unlock WebAudio
const gesture = () => {
  audio.init();
  window.removeEventListener('pointerdown', gesture);
  window.removeEventListener('keydown', gesture);
};
window.addEventListener('pointerdown', gesture);
window.addEventListener('keydown', gesture);
