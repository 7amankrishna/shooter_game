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
engine.init();

const hud = new HUD({ root: uiRoot, camera: engine.camera });
let game = null; // built after the first PLAY (world gen needs the loading screen)
let started = false;

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

const input = new InputManager({
  element: canvas,
  onLockChange: (locked) => {
    if (!locked && started && game?.state === 'playing' && !game.buyMenuOpen && !game.adminOpen) {
      // losing pointer lock mid-run = pause (unless an overlay intentionally took it)
      pausePlay();
    }
  },
  onUnlock: () => {},
});
input.attach();
applySettings(settings);

function startRun(fresh) {
  menu.show('loading');
  menu.setLoadingProgress(0.02, 'carving terrain…');
  const tick = () => new Promise((r) => requestAnimationFrame(r));
  (async () => {
    if (!game) {
      game = new Survival({ engine, input, audio, hud, seed: Date.now() % 2147483647, settings });
      await game.init((p) => menu.setLoadingProgress(0.05 + p * 0.9, p < 0.5 ? 'carving terrain…' : 'seeding the dead…'));
    } else {
      await tick();
    }
    menu.setLoadingProgress(1, 'ready');
    let ok = true;
    if (fresh) {
      game.requestRestart(); // fresh run clears the save
    } else {
      ok = game.continueRun();
    }
    if (!ok) game.start();
    hud.hideDeath();
    menu.hideAll();
    input.requestLock();
    started = true;
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

engine.onFrame = (dt) => {
  if (!game) return false; // nothing simulated yet — don't even render

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
  audio.setListener(engine.camera);

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
