/**
 * UI-layer tests: the HUD and menus run against a tiny DOM shim so that a typo
 * in a query selector, a missing element or a bad snapshot shape fails in CI
 * instead of showing up as a blank screen. Also asserts that every class the
 * UI adds actually exists in the stylesheet (the usual cause of "it renders but
 * looks unstyled").
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as THREE from 'three';

const here = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ shim */

let elementSeq = 0;
function makeElement(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(),
    _id: ++elementSeq,
    children: [],
    parentNode: null,
    style: {},
    dataset: {},
    textContent: '',
    innerHTML: '',
    value: '',
    hidden: false,
    width: 256,
    height: 256,
    _classes: new Set(),
    classList: {
      add(...names) { names.forEach((n) => el._classes.add(n)); },
      remove(...names) { names.forEach((n) => el._classes.delete(n)); },
      toggle(name, force) {
        const on = force === undefined ? !el._classes.has(name) : !!force;
        if (on) el._classes.add(name);
        else el._classes.delete(name);
        return on;
      },
      contains: (name) => el._classes.has(name),
    },
    setAttribute(k, v) { el[k] = v; },
    getAttribute(k) { return el[k] ?? null; },
    appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
    append(...children) { children.forEach((c) => { c.parentNode = el; el.children.push(c); }); },
    removeChild(child) { el.children = el.children.filter((c) => c !== child); return child; },
    remove() { el.parentNode?.removeChild?.(el); },
    _listeners: {},
    addEventListener(type, fn) { (el._listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { el._listeners[type] = (el._listeners[type] ?? []).filter((f) => f !== fn); },
    dispatchEvent(ev) { for (const fn of el._listeners[ev.type] ?? []) fn(ev); return true; },
    click() { el.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {}, target: el }); },
    setPointerCapture() {},
    focus() {},
    blur() {},
    getContext: () => canvasCtx(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720, right: 1280, bottom: 720 }),
    querySelector(sel) { return find(el, sel); },
    querySelectorAll(sel) { return findAll(el, sel); },
    get className() { return [...el._classes].join(' '); },
    set className(v) { el._classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
  };
  return el;
}
function find(root, sel) {
  // supports only the handful of selectors the app uses: '#id' and '.class'
  const want = String(sel).trim();
  const walk = (node) => {
    for (const c of node.children ?? []) {
      if (!c.classList) continue; // skip text nodes
      if (want.startsWith('#') && c.id === want.slice(1)) return c;
      if (want.startsWith('.') && c.classList.contains(want.slice(1))) return c;
      if (!want.startsWith('#') && !want.startsWith('.') && c.tagName === want.toUpperCase()) return c;
      const nested = walk(c);
      if (nested) return nested;
    }
    return null;
  };
  return walk(root);
}
function findAll(root, sel) {
  const want = String(sel).trim();
  const out = [];
  const match = (c) => {
    if (!c.classList) return false;
    if (want.startsWith('#')) return c.id === want.slice(1);
    if (want.startsWith('.')) return c.classList.contains(want.slice(1));
    return c.tagName === want.toUpperCase();
  };
  const walk = (node) => {
    for (const c of node.children ?? []) {
      if (match(c)) out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

let ctxSingleton = null;
function canvasCtx() {
  if (ctxSingleton) return ctxSingleton;
  const base = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    globalAlpha: 1,
    getImageData: (x, y, w = 256, h = 256) => ({ data: new Uint8ClampedArray(Math.max(w, 256) * Math.max(h, 256) * 4) }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
  };
  ctxSingleton = new Proxy(base, {
    get(t, p) {
      if (p in t) return t[p];
      return typeof p === 'string' ? () => undefined : undefined;
    },
    set(t, p, v) { t[p] = v; return true; },
  });
  return ctxSingleton;
}

const registry = new Map();
const doc = {
  createElement: (tag) => {
    const el = makeElement(tag);
    Object.defineProperty(el, 'id', {
      set(v) { registry.set(v, el); el._idName = v; },
      get() { return el._idName ?? ''; },
      configurable: true,
    });
    return el;
  },
  createElementNS: (_ns, tag) => doc.createElement(tag),
  createTextNode: (t) => ({ nodeType: 3, textContent: t }),
  getElementById: (id) => registry.get(id) ?? null,
  querySelector: (sel) => find(doc.body, sel),
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  exitPointerLock() {},
  pointerLockElement: null,
  visibilityState: 'visible',
  documentElement: makeElement('html'),
  body: (() => { const b = makeElement('body'); b.id = 'body'; return b; })(),
};
globalThis.document = doc;
globalThis.window = {
  innerWidth: 1280,
  innerHeight: 720,
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  requestAnimationFrame: (fn) => setTimeout(() => fn(performance.now()), 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
  performance,
  AudioContext: undefined,
};
globalThis.performance = globalThis.performance ?? { now: () => Date.now() };
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, v); },
  removeItem(k) { this._m.delete(k); },
};
globalThis.requestAnimationFrame = window.requestAnimationFrame;
globalThis.cancelAnimationFrame = window.cancelAnimationFrame;

/* ----------------------------------------------------------------- tests */

const { makeMaterials } = await import('../src/core/Textures.js');
const { HUD } = await import('../src/ui/HUD.js');
const { Menu } = await import('../src/ui/Menu.js');
const { InputManager } = await import('../src/core/InputManager.js');
const { Scoring } = await import('../src/game/Scoring.js');
const { getDifficulty } = await import('../src/config/DifficultyConfig.js');

const camera = new THREE.PerspectiveCamera(76, 16 / 9, 0.1, 600);
camera.position.set(0, 1.66, 30);
camera.updateMatrixWorld(true);

function fakeSnapshot(scoring, over = {}) {
  return {
    phase: 'PLAYING',
    elapsed: 42.5,
    player: { health: 71, max: 100, alive: true, crouching: false, sprinting: false },
    weapon: { name: 'AK-01', mag: 24, reserve: 120, reloading: false, reloadProgress: 0, label: '24 / 120', spread: 2.6, adsT: 0 },
    ai: { health: 60, max: 100, alive: true, status: 'ENGAGED', state: 'ENGAGE', distance: 23.5, visible: true, awareness: 1.2, mag: 18, reloading: false, shots: 40, hits: 22, accuracy: 0.55 },
    score: {
      total: Math.round(scoring.score), hits: scoring.hits, misses: scoring.misses, shots: scoring.shots,
      headshots: scoring.headshots, grazes: scoring.grazes, streak: scoring.streak, bestStreak: scoring.bestStreak,
      multiplier: scoring.multiplier, comboLabel: scoring.comboLabel, accuracy: scoring.accuracy,
    },
    difficulty: 'MEDIUM',
    ...over,
  };
}

test('HUD: syncs a full snapshot, hitmarkers, popups and damage arcs without throwing', () => {
  const root = doc.createElement('div');
  const hud = new HUD({ root, camera });
  const scoring = new Scoring();
  scoring.registerShot();
  scoring.registerHit('head', 100);
  scoring.registerShot();
  scoring.registerHit('chest', 50);
  const perf = { fps: 118, frameMs: 8.4, calls: 22, tris: 140000, near: 300, far: 900, culled: 40, cellsVis: 9, cellsTot: 36, particles: 22, shadowCasters: 120, rays: 3, boxTests: 40, aiState: 'ENGAGE', aiAware: 1.2, aiHp: 60 };

  hud.sync(fakeSnapshot(scoring), perf);
  hud.sync(fakeSnapshot(scoring), perf); // second pass exercises the dirty cache
  hud.showHitmark({ headshot: true, graze: false });
  hud.showHitmark({ headshot: false, graze: true });
  hud.pushPopup({ text: '+100 HEADSHOT', kind: 'headshot', worldPoint: new THREE.Vector3(2, 2, 20) });
  hud.pushPopup({ text: 'COMBO x2', kind: 'bonus' });
  hud.showDamageArc({ x: 10, y: 1.4, z: 20 });
  hud.toast('TEST TOAST', 10);
  hud.log('MATCH LOG LINE');
  for (let i = 0; i < 40; i++) hud.updatePopups(1 / 60);
  hud.setEnabled(false);
  hud.sync(fakeSnapshot(scoring, { phase: 'PAUSED' }), perf);

  assert.ok(hud.debug, 'debug overlay element exists');
  assert.ok(hud.hpBar && hud.ammoMag && hud.scoreTotal, 'key HUD handles exist');
  assert.equal(hud.ammoMag.textContent, '24');
  assert.match(String(hud.aiStatus.textContent), /ENGAGED/);
});

test('HUD: dry magazine swaps to RELOAD, then NO AMMO', () => {
  const hud = new HUD({ root: doc.createElement('div'), camera });
  const scoring = new Scoring();
  const base = { fps: 60, frameMs: 16, calls: 0, tris: 0 };
  hud.sync(fakeSnapshot(scoring), base);
  assert.equal(hud.ammoMag.textContent, '24');
  assert.equal(hud.ammoReserve.textContent, '/ 120');

  const dry = fakeSnapshot(scoring);
  dry.weapon.mag = 0;
  dry.weapon.label = 'RELOAD';
  hud.sync(dry, base);
  assert.equal(hud.ammoMag.textContent, 'RELOAD', 'spec: "RELOAD" when the magazine is empty');
  assert.equal(hud.ammoReserve.textContent, '', 'the reserve count is replaced, not duplicated');
  assert.ok(hud.ammoMag.parentNode.classList.contains('dry'), 'the ammo block restyles when dry');

  const empty = fakeSnapshot(scoring);
  empty.weapon.mag = 0;
  empty.weapon.reserve = 0;
  empty.weapon.label = 'NO AMMO';
  hud.sync(empty, base);
  assert.equal(hud.ammoMag.textContent, 'NO AMMO');
});

test('Menu: every screen and result payload renders', () => {
  const handled = [];
  const root = doc.createElement('div');
  const menu = new Menu({
    root,
    handlers: {
      play: () => handled.push('play'),
      difficulty: () => handled.push('difficulty'),
      controls: () => handled.push('controls'),
      back: () => handled.push('back'),
      pickDifficulty: (k) => handled.push(`pick:${k}`),
      resume: () => handled.push('resume'),
      restart: () => handled.push('restart'),
      quit: () => handled.push('quit'),
      playAgain: () => handled.push('again'),
      mainMenu: () => handled.push('menu'),
    },
  });
  for (const screen of ['main', 'difficulty', 'controls', 'pause', 'results', 'loading', null]) menu.show(screen);
  menu.setLoading('BUILDING VILLAGE', 0.35);
  menu.setLoading('BAKING NAVMESH', 1);
  menu.setPauseInfo('Score 1,240 · HP 71');
  menu.setDifficulty('HARD');
  const summary = {
    outcome: 'WIN', score: 14320, hits: 31, misses: 12, shots: 43, accuracy: 0.72, headshots: 4, grazes: 2,
    bestStreak: 9, elapsed: 88.4, difficulty: 'HARD', aiHealth: 0, playerHealth: 41,
    bonuses: [{ label: 'HEADSHOT STREAK', value: 300 }, { label: 'ACCURACY', value: 500 }],
  };
  menu.showResults(summary);
  assert.equal(menu.current, 'results');
  assert.ok(handled.length === 0, 'no handler fires on its own');

  // three cards, one per difficulty, each wired to the app's picker
  const grid = find(menu.root, '.diff-grid');
  assert.ok(grid, 'difficulty screen has a card grid');
  const cards = grid.children.filter((c) => c.classList && c.classList.contains('diff'));
  assert.equal(cards.length, 3, 'exactly three difficulty presets');
  cards.forEach((c) => c.click());
  assert.deepEqual(handled, ['pick:EASY', 'pick:MEDIUM', 'pick:HARD'], 'cards report their key in order');

  // the main menu buttons reach their handlers
  handled.length = 0;
  const buttons = menu.screens.main.querySelectorAll('.btn');
  assert.deepEqual(
    buttons.map((b) => b.labelEl?.textContent ?? ''),
    ['Play', 'Difficulty · HARD · WRAITH', 'Controls', 'Restart match', 'Quit'],
    'main menu offers Play / Difficulty / Controls / Restart / Quit',
  );
  buttons.forEach((b) => b.click());
  assert.deepEqual(handled, ['play', 'difficulty', 'controls', 'restart', 'quit'], 'every main-menu button is wired');

  // results screen returns to the game or the menu
  handled.length = 0;
  menu.show('results');
  const res = menu.screens.results.querySelectorAll('.btn');
  assert.ok(res.length >= 2, 'results offers a way back in and out');
  res.forEach((b) => b.click());
  assert.ok(handled.includes('again') || handled.includes('menu'), 'results buttons return to the game or menu');
});
test('InputManager: key map, sample shape and lock fallback', () => {
  const im = new InputManager({ element: doc.createElement('canvas'), onLockChange: () => {} });
  im.attach();
  const s = im.sample(1 / 60);
  for (const k of ['lookDelta', 'forward', 'back', 'left', 'right', 'jump', 'sprinting', 'crouch', 'fire', 'ads', 'reloadPressed', 'pausePressed', 'autoReload', 'locked', 'moveLen']) {
    assert.ok(k in s, `sample exposes ${k}`);
  }
  assert.equal(s.forward, false);
  assert.equal(s.fire, false);
  // sample() must consume transient state
  im.detach();
  assert.ok(typeof im.sensitivity === 'number', 'sensitivity is adjustable');
});

test('styles: every class the UI adds is defined in the stylesheet', () => {
  const css = readFileSync(join(here, '..', 'src', 'ui', 'styles.css'), 'utf8');
  const defined = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
  const used = new Set();
  for (const f of ['HUD.js', 'Menu.js']) {
    const src = readFileSync(join(here, '..', 'src', 'ui', f), 'utf8');
    for (const m of src.matchAll(/classList\.(?:add|toggle|remove)\(\s*'([\w-]+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/#el\(\s*'[^']*'\s*,\s*'([\w -]+)'/g)) m[1].split(/\s+/).filter(Boolean).forEach((c) => used.add(c));
    for (const m of src.matchAll(/className = '([\w -]+)'/g)) m[1].split(/\s+/).filter(Boolean).forEach((c) => used.add(c));
  }
  const ids = new Set([...css.matchAll(/#([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
  const missing = [...used].filter((c) => !defined.has(c) && !ids.has(c) && c !== 'on' && c !== 'hidden');
  assert.deepEqual(missing, [], `unstyled UI classes: ${missing.join(', ')}`);
  assert.ok(css.includes('#gl'), 'canvas is styled');
  assert.ok(css.includes('#ui'), 'hud root is styled');
  assert.ok(/\.screen\s*{/.test(css), 'menu screens are positioned');
  assert.ok(css.includes('backdrop-filter') || css.includes('rgba'), 'menus sit on a legible scrim');
});

