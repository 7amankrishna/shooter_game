/**
 * UI tests: HUD render + snapshot wiring, Menu screens + settings persistence,
 * and the stylesheet invariant (every class the JS adds exists in styles.css).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDomStub } from './stubDom.js';

installDomStub();

const here = dirname(fileURLToPath(import.meta.url));

const { HUD } = await import('../src/ui/HUD.js');
const { Menu, loadSettings, saveSettings, DEFAULT_SETTINGS } = await import('../src/ui/Menu.js');

function uiRoot() {
  return document.createElement('div');
}

function snap(extra = {}) {
  return {
    health: 72, maxHealth: 100, stamina: 0.8, ads: 0.2, weapon: 'rifle',
    weaponName: 'AK-01', mag: 17, reserve: 84, magSize: 30, reloading: false, reloadEta: 0,
    slots: [{ name: 'P-92', key: '1', active: false }, { name: 'AK-01', key: '2', active: true }, { name: 'M-700', key: '3', active: false }],
    coins: 135, kills: 4, clock: '17:42', phase: 'DUSK', weather: 'RAIN',
    threat: 'WALKER', threatDist: 18, threatBearing: 170, compassYaw: 3.1,
    prompt: 'E — CLIMB TOWER', inTower: false, markers: [],
    ...extra,
  };
}

test('HUD: builds, syncs full snapshots and feedback cues without throwing', () => {
  const root = uiRoot();
  const hud = new HUD({ root });
  hud.update(snap());
  hud.update(snap({ health: 30, mag: 0, reloading: true, weather: 'STORM' }), true);
  hud.update(snap({ inTower: true, prompt: 'E — DESCEND' }));
  hud.prompt('E — CLIMB TOWER');
  hud.notify('+25 HEALTH');
  hud.notify('+18 COINS');
  hud.banner('NIGHT FALLS');
  hud.hitmarker(false);
  hud.hitmarker(true);
  hud.damage(0.6);
  hud.setBuyMenu(true, [{ tier: 'basic', cost: 60, eta: 4 }], 135);
  hud.setBuyMenu(false, [], 135);
  hud.setAdminPanel(true, { time: 0.8, weather: 'RAIN', difficulty: 3.2 });
  hud.setAdminPanel(false, {});
  assert.ok(root.innerHTML.length > 500, 'HUD actually rendered DOM');
});

test('HUD: death screen round-trips', () => {
  const root = uiRoot();
  const hud = new HUD({ root });
  hud.update(snap());
  hud.showDeath({ time: 412, kills: 9, coins: 240, distance: 731, shots: 120, hits: 61, difficulty: 4.2, cause: 'RUNNER' });
  hud.hideDeath();
  hud.hideOverlays();
});

test('Menu: every screen shows, resume visibility and loading progress', () => {
  const handlers = { onPlay: () => {}, onContinue: () => {}, onResume: () => {}, onRestart: () => {}, onQuit: () => {}, onExit: () => {}, onSettingsChange: () => {} };
  const root = uiRoot();
  const menu = new Menu({ root, handlers, settings: { ...DEFAULT_SETTINGS } });
  for (const name of ['main', 'settings', 'controls', 'credits', 'pause', 'loading']) {
    menu.show(name);
  }
  menu.setContinueVisible(true);
  menu.setContinueVisible(false);
  menu.setLoadingProgress(0.5, 'PAINTING THE WORLD');
  menu.setLoadingProgress(1);
  menu.hideAll();
  assert.ok(root.innerHTML.length > 500, 'menu rendered DOM');
});

test('Menu: settings persist through localStorage and merge onto defaults', () => {
  localStorage.clear();
  const loaded0 = loadSettings();
  assert.deepEqual(loaded0, DEFAULT_SETTINGS, 'cold load falls back to defaults');
  const mod = { ...DEFAULT_SETTINGS, sensitivity: 1.7, volumeMaster: 0.2, quality: 'low' };
  saveSettings(mod);
  const loaded = loadSettings();
  assert.equal(loaded.sensitivity, 1.7);
  assert.equal(loaded.volumeMaster, 0.2);
  assert.equal(loaded.quality, 'low');
  // partial/garbage saves merge onto defaults instead of breaking
  localStorage.setItem('deadfall.settings', JSON.stringify({ sensitivity: 0.4, bogus: 1 }));
  const merged = loadSettings();
  assert.equal(merged.sensitivity, 0.4);
  assert.equal(merged.volumeMaster, DEFAULT_SETTINGS.volumeMaster);
  localStorage.clear();
});

test('styles: every class the UI adds is defined in the stylesheet', () => {
  const css = readFileSync(join(here, '..', 'src', 'ui', 'styles.css'), 'utf8');
  const defined = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
  const used = new Set();
  for (const f of ['HUD.js', 'Menu.js']) {
    const src = readFileSync(join(here, '..', 'src', 'ui', f), 'utf8');
    for (const m of src.matchAll(/classList\.(?:add|toggle|remove)\(\s*'([\w-]+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/className\s*=\s*'([\w -]+)'/g)) m[1].split(/\s+/).filter(Boolean).forEach((c) => used.add(c));
    for (const m of src.matchAll(/class="([^"]+)"/g)) m[1].split(/\s+/).filter(Boolean).forEach((c) => used.add(c));
    // #el('tag', 'cls'...) and #el('tag', `template ${x}`...) — 2nd arg is the class list
    for (const m of src.matchAll(/#el\(\s*'[^']*'\s*,\s*'([^']*)'/g)) m[1].split(/\s+/).filter(Boolean).forEach((c) => used.add(c));
    for (const m of src.matchAll(/#el\(\s*'[^']*'\s*,\s*`([^`]*)`/g)) {
      m[1].replace(/\$\{[^}]*\}/g, ' ').split(/[\s`]+/).filter(Boolean).forEach((c) => used.add(c));
    }
    // #btn('id', label, hint, cls) / #screen('name', cls) style helpers pass classes too
    for (const m of src.matchAll(/#btn\(\s*'[^']*'\s*,\s*'[^']*'\s*(?:,\s*'[^']*'\s*)?,\s*'([^']*)'/g)) m[1].split(/\s+/).filter(Boolean).forEach((c) => used.add(c));
  }
  const ids = new Set([...css.matchAll(/#([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
  // `ch-${side}`-style templates leave a prefix token; their concrete
  // expansions are checked explicitly below.
  const dynamic = [...used].filter((c) => c.endsWith('-'));
  for (const c of dynamic) used.delete(c);
  const missing = [...used].filter((c) => !defined.has(c) && !ids.has(c) && c !== 'on' && c !== 'hidden' && c !== 'is');
  assert.deepEqual(missing, [], `unstyled UI classes: ${missing.join(', ')}`);
  // crosshair arms + hitmarker wings exist for every generated side
  for (const side of ['n', 's', 'e', 'w']) assert.ok(defined.has(`ch-${side}`), `crosshair arm .ch-${side}`);
  for (const side of ['a', 'b', 'c', 'd']) assert.ok(defined.has(`hm-${side}`), `hitmarker wing .hm-${side}`);
  assert.ok(css.includes('#gl'), 'canvas is styled');
  assert.ok(css.includes('#ui'), 'hud root is styled');
  assert.ok(/\.screen\s*{/.test(css), 'menu screens are positioned');
  assert.ok(css.includes('backdrop-filter') || css.includes('rgba'), 'menus sit on a legible scrim');
});
