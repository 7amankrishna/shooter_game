/**
 * Menu — main menu, settings, controls, credits, pause and loading screens.
 *
 * Screens are declarative (one builder per screen) so the flow
 * MENU → LOADING → PLAY ⇄ PAUSE → (death) → MENU stays keyboard navigable.
 * Settings persist to localStorage and are applied live by main.js.
 */
import { clamp } from '../core/math.js';

const CONTROLS = [
  ['W / ↑', 'Move forward'],
  ['S / ↓', 'Move backward'],
  ['A / ←', 'Strafe left'],
  ['D / →', 'Strafe right'],
  ['Mouse', 'Look / aim'],
  ['Left Mouse', 'Fire (hold for full-auto)'],
  ['Right Mouse', 'Aim down sights'],
  ['R', 'Reload'],
  ['1 / 2 / 3', 'Weapons (wheel also switches)'],
  ['Shift', 'Sprint — loud, costs stamina'],
  ['Space', 'Jump'],
  ['C / Ctrl', 'Crouch — quieter, slower'],
  ['E', 'Interact — towers, caches, crates'],
  ['B', 'Buy menu (spend coins on supply drops)'],
  ['Esc', 'Pause'],
  ['F3', 'Perf overlay'],
  ['F6', 'Dev panel (time / weather)'],
  ['M', 'Mute audio'],
  ['Alt + Arrows', 'Turn with the keyboard (if mouse capture is blocked)'],
];

const CREDITS = [
  ['BLACKLINE: DEADFALL', 'A survival-horror prototype'],
  ['', ''],
  ['Engine', 'three.js — every asset procedural, nothing loaded'],
  ['Audio', 'WebAudio synthesis — guns, weather and the dead'],
  ['World', 'Infinite deterministic chunk streaming'],
  ['', ''],
  ['Built on', 'the BLACKLINE // ARENA 1v1 prototype'],
];

const SETTINGS_KEY = 'deadfall.settings';

export const DEFAULT_SETTINGS = {
  sensitivity: 1,
  fov: 76,
  invertY: false,
  screenShake: true,
  volumeMaster: 0.9,
  volumeSfx: 0.9,
  volumeMusic: 0.55,
  quality: 'high',
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch { /* storage blocked */ }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch { /* storage blocked */ }
}

export class Menu {
  constructor({ root, handlers = {}, settings = { ...DEFAULT_SETTINGS } }) {
    this.root = root;
    this.h = handlers;
    this.settings = settings;
    this.current = null;
    this.screens = {};
    this.#build();
    this.show('main');
  }

  #el(tag, cls, parent, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  #btn(label, cls, onClick, hint) {
    const b = this.#el('button', `btn ${cls ?? ''}`.trim());
    this.#el('span', '', b, label);
    if (hint) this.#el('span', 'k', b, hint);
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  #screen(name, cls = '') {
    const s = this.#el('div', `screen ${cls}`.trim(), this.root);
    s.dataset.screen = name;
    this.screens[name] = s;
    return s;
  }

  #build() {
    this.root.innerHTML = '';
    this.root.className = 'menu-root';

    /* ------------------------------------------------------- main menu */
    const main = this.#screen('main');
    const titleWrap = this.#el('div', 'title-wrap', main);
    this.#el('div', 'title-eyebrow', titleWrap, 'BLACKLINE');
    this.#el('h1', 'title', titleWrap, 'DEADFALL');
    this.#el('div', 'title-sub', titleWrap, 'THE OUTBREAK IS PROCEDURAL. YOUR DEATH IS PERMANENT.');
    const nav = this.#el('div', 'menu-nav', main);
    nav.appendChild(this.#btn('NEW RUN', 'primary', () => this.h.onPlay?.()));
    this.continueBtn = this.#btn('CONTINUE', '', () => this.h.onContinue?.());
    nav.appendChild(this.continueBtn);
    nav.appendChild(this.#btn('SETTINGS', '', () => this.show('settings')));
    nav.appendChild(this.#btn('CONTROLS', '', () => this.show('controls')));
    nav.appendChild(this.#btn('CREDITS', '', () => this.show('credits')));
    if (typeof window !== 'undefined' && window.quitAllowed) {
      nav.appendChild(this.#btn('EXIT', '', () => this.h.onExit?.()));
    }
    this.#el('div', 'menu-foot', main, 'A PROCEDURAL SURVIVAL PROTOTYPE · MOUSE + KEYBOARD');

    /* --------------------------------------------------------- settings */
    const settings = this.#screen('settings');
    this.#el('h2', 'screen-title', settings, 'SETTINGS');
    const body = this.#el('div', 'settings-grid', settings);
    this.#slider(body, 'MOUSE SENSITIVITY', 'sensitivity', 0.2, 3, 0.05);
    this.#slider(body, 'FIELD OF VIEW', 'fov', 60, 100, 1, (v) => `${v}°`);
    this.#slider(body, 'MASTER VOLUME', 'volumeMaster', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`);
    this.#slider(body, 'EFFECTS VOLUME', 'volumeSfx', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`);
    this.#slider(body, 'MUSIC VOLUME', 'volumeMusic', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`);
    this.#toggle(body, 'INVERT Y AXIS', 'invertY');
    this.#toggle(body, 'SCREEN SHAKE', 'screenShake');
    this.#choice(body, 'QUALITY PRESET', 'quality', [
      ['low', 'LOW'], ['medium', 'MEDIUM'], ['high', 'HIGH'],
    ]);
    settings.appendChild(this.#btn('BACK', 'back', () => this.show('main')));

    /* --------------------------------------------------------- controls */
    const controls = this.#screen('controls');
    this.#el('h2', 'screen-title', controls, 'CONTROLS');
    const list = this.#el('div', 'controls-list', controls);
    for (const [k, v] of CONTROLS) {
      const row = this.#el('div', 'controls-row', list);
      this.#el('span', 'controls-key', row, k);
      this.#el('span', 'controls-desc', row, v);
    }
    controls.appendChild(this.#btn('BACK', 'back', () => this.show('main')));

    /* ---------------------------------------------------------- credits */
    const credits = this.#screen('credits');
    this.#el('h2', 'screen-title', credits, 'CREDITS');
    const credList = this.#el('div', 'credits-list', credits);
    for (const [k, v] of CREDITS) {
      const row = this.#el('div', 'credits-row', credList);
      this.#el('span', 'credits-k', row, k);
      this.#el('span', 'credits-v', row, v);
    }
    credits.appendChild(this.#btn('BACK', 'back', () => this.show('main')));

    /* ----------------------------------------------------------- pause */
    const pause = this.#screen('pause', 'overlay-screen');
    this.#el('h2', 'screen-title', pause, 'PAUSED');
    const pnav = this.#el('div', 'menu-nav', pause);
    pnav.appendChild(this.#btn('RESUME', 'primary', () => this.h.onResume?.()));
    pnav.appendChild(this.#btn('RESTART RUN', '', () => this.h.onRestart?.()));
    pnav.appendChild(this.#btn('QUIT TO MENU', '', () => this.h.onQuit?.()));

    /* --------------------------------------------------------- loading */
    const loading = this.#screen('loading', 'overlay-screen');
    this.#el('div', 'title-eyebrow', loading, 'BLACKLINE');
    this.#el('h2', 'screen-title', loading, 'GENERATING THE DEAD ZONE');
    this.loadLabel = this.#el('div', 'load-label', loading, 'carving terrain…');
    const barWrap = this.#el('div', 'load-bar', loading);
    this.loadFill = this.#el('div', 'load-fill', barWrap);
  }

  /* -------------------------------------------------------- settings UI */

  #slider(parent, label, key, min, max, step, fmt = (v) => v.toFixed(2).replace(/\.?0+$/, '')) {
    const row = this.#el('div', 'settings-row', parent);
    this.#el('span', 'settings-label', row, label);
    const right = this.#el('div', 'settings-right', row);
    const out = this.#el('span', 'settings-value', right, fmt(this.settings[key]));
    const input = this.#el('input', 'settings-slider', right);
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(this.settings[key]);
    input.dataset.key = key;
    input.addEventListener('input', () => {
      const v = clamp(parseFloat(input.value), min, max);
      this.settings[key] = v;
      out.textContent = fmt(v);
      this.h.onSettingsChange?.({ ...this.settings });
      saveSettings(this.settings);
    });
    return input;
  }

  #toggle(parent, label, key) {
    const row = this.#el('div', 'settings-row', parent);
    this.#el('span', 'settings-label', row, label);
    const right = this.#el('div', 'settings-right', row);
    const btn = this.#btn(this.settings[key] ? 'ON' : 'OFF', 'toggle', () => {
      this.settings[key] = !this.settings[key];
      btn.firstChild.textContent = this.settings[key] ? 'ON' : 'OFF';
      this.h.onSettingsChange?.({ ...this.settings });
      saveSettings(this.settings);
    });
    right.appendChild(btn);
    return btn;
  }

  #choice(parent, label, key, options) {
    const row = this.#el('div', 'settings-row', parent);
    this.#el('span', 'settings-label', row, label);
    const right = this.#el('div', 'settings-right', row);
    const group = this.#el('div', 'choice-group', right);
    for (const [value, name] of options) {
      const b = this.#btn(name, `choice${this.settings[key] === value ? ' active' : ''}`, () => {
        this.settings[key] = value;
        for (const el of group.children) el.classList.remove('active');
        b.classList.add('active');
        this.h.onSettingsChange?.({ ...this.settings });
        saveSettings(this.settings);
      });
      group.appendChild(b);
    }
  }

  /* ------------------------------------------------------------- flow */

  show(name) {
    for (const k of Object.keys(this.screens)) {
      this.screens[k].classList.toggle('active', k === name);
    }
    this.current = name;
  }

  setContinueVisible(visible) {
    this.continueBtn.style.display = visible ? '' : 'none';
  }

  setLoadingProgress(p, label) {
    if (this.loadFill) this.loadFill.style.width = `${clamp(p, 0, 1) * 100}%`;
    if (label && this.loadLabel) this.loadLabel.textContent = label;
  }

  hideAll() {
    this.show('__none__');
  }
}
