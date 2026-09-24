/**
 * Boot test: runs the real src/main.js (menu → PLAY → loading → frame loop)
 * on the headless DOM, pumping requestAnimationFrame by hand.
 *
 * The other suites drive Survival directly with stub audio and engine, so
 * main.js's wiring had no coverage. A bad audio call in its frame loop threw
 * on every frame after PLAY; engine.render() never ran and the player got
 * the HUD over a black screen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { installDomStub } from './stubDom.js';

// main.js imports its stylesheet (Vite bundles it); load .css as an empty module.
register('data:text/javascript,' + encodeURIComponent(
  "export async function resolve(s, c, next) { return s.endsWith('.css') ? { url: 'data:text/javascript,', shortCircuit: true } : next(s, c); }",
));

installDomStub();

// index.html's mount points. No WebGL in Node: three.js throws, Engine.init
// falls back to its no-op renderer, and render() calls are still counted.
const canvas = document.createElement('canvas');
canvas.getContext = () => null;
const mounts = { gl: canvas, ui: document.createElement('div'), screens: document.createElement('div') };
document.getElementById = (id) => mounts[id] ?? null;

// Hand-driven animation frames. A throw is recorded rather than propagated,
// the way a browser reports an error in a rAF callback and keeps going.
let queued = [];
const frameErrors = [];
globalThis.requestAnimationFrame = (cb) => queued.push(cb);
globalThis.cancelAnimationFrame = () => {};

async function pump(frames, until = () => false) {
  for (let i = 0; i < frames && !until(); i++) {
    const due = queued;
    queued = [];
    for (const cb of due) {
      try {
        cb(performance.now());
      } catch (error) {
        frameErrors.push(error);
      }
    }
    await new Promise((resolve) => setImmediate(resolve)); // let async startup continue
  }
}

// Spy on the real classes main.js is about to instantiate.
const { Engine } = await import('../src/core/Engine.js');
const { AudioEngine } = await import('../src/core/AudioEngine.js');
const { Survival } = await import('../src/game/Survival.js');
let renders = 0;
let game = null;
let audio = null;
function spy(proto, name, onCall) {
  const original = proto[name];
  proto[name] = function (...args) {
    onCall(this);
    return original.apply(this, args);
  };
}
spy(Engine.prototype, 'render', () => { renders++; });
spy(Survival.prototype, 'init', (self) => { game = self; });
spy(AudioEngine.prototype, 'setListener', (self) => { audio = self; });

function* walk(el) {
  for (const child of el.children ?? []) {
    yield child;
    yield* walk(child);
  }
}
const findButton = (root, label) => [...walk(root)].find((el) => el.tagName === 'BUTTON' && el.textContent === label);
const activeScreen = (root) => [...walk(root)].find((el) => el.dataset?.screen && el.classList.contains('active'));

test('boot: PLAY reaches a live frame loop that renders every frame', async () => {
  const realError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.map(String).join(' '));
  try {
    await import('../src/main.js');
    await pump(3);
    assert.equal(renders, 0, 'nothing renders before a run exists');

    const play = findButton(mounts.screens, 'PLAY');
    assert.ok(play, 'main menu shows PLAY');
    play.fire('click');
    await pump(300, () => game?.state === 'playing');
    assert.equal(game?.state, 'playing', `PLAY started the run (console.error: ${logged.join(' | ') || 'none'})`);
    assert.equal(activeScreen(mounts.screens), undefined, 'menu screens are hidden once the run starts');

    const rendersAtStart = renders;
    await pump(30);
    assert.deepEqual(frameErrors.map((e) => e?.stack ?? String(e)), [], 'no frame throws during boot, loading or play');
    assert.equal(renders - rendersAtStart, 30, 'every frame after PLAY reaches engine.render()');
    assert.equal(game.state, 'playing', 'the run is still live');

    // Spatial audio: the listener follows the camera with a finite, orthonormal pose.
    const l = audio?.listener;
    assert.ok(l, 'the frame loop updates the audio listener');
    const cam = game.engine.camera.position;
    const close = (a, b) => Math.abs(a - b) < 1e-6;
    assert.ok(close(l.x, cam.x) && close(l.y, cam.y) && close(l.z, cam.z), 'listener sits at the camera');
    assert.ok(close(Math.hypot(l.fx, l.fy, l.fz), 1), 'listener forward is a unit vector');
    assert.ok(close(Math.hypot(l.ux, l.uy, l.uz), 1), 'listener up is a unit vector');
    assert.ok(close(l.fx * l.ux + l.fy * l.uy + l.fz * l.uz, 0), 'listener forward is perpendicular to up');

    // Node has no WebGL, so the expected fallback notice is the only error.
    assert.deepEqual(logged.filter((m) => !/WebGL/.test(m)), [], 'no unexpected console errors');
  } finally {
    console.error = realError;
  }
});
