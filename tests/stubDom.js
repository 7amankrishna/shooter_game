/**
 * Minimal in-memory DOM + localStorage so the browser-only modules (UI,
 * procedural textures, save system) can run under `node --test`.
 *
 * Elements track children, classes, dataset and listeners, and serialize a
 * rough innerHTML so tests can assert that things actually rendered. Canvas
 * elements return a no-op 2D context: nothing here touches pixels.
 */

function makeClassList(el) {
  return {
    add: (...cs) => cs.forEach((c) => el._classes.add(c)),
    remove: (...cs) => cs.forEach((c) => el._classes.delete(c)),
    toggle: (c, force) => {
      const on = force === undefined ? !el._classes.has(c) : !!force;
      if (on) el._classes.add(c); else el._classes.delete(c);
      return on;
    },
    contains: (c) => el._classes.has(c),
  };
}

function serialize(el) {
  const cls = el._classes.size ? ` class="${[...el._classes].join(' ')}"` : '';
  const open = `<${el.tagName}${cls}`;
  if (!el._children.length) return `${open}>${el._text ?? ''}</${el.tagName}>`;
  return `${open}>${el._children.map(serialize).join('')}</${el.tagName}>`;
}

function makeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    _classes: new Set(),
    _children: [],
    _text: '',
    _listeners: {},
    style: {},
    dataset: {},
    width: 256,
    height: 256,
    parentNode: null,
    get classList() { return makeClassList(el); },
    get children() { return el._children; },
    get firstChild() { return el._children[0] ?? null; },
    get textContent() {
      return el._children.length ? el._children.map((c) => c.textContent).join('') : el._text;
    },
    set textContent(v) { el._children = []; el._text = String(v ?? ''); },
    get innerHTML() { return el._children.map(serialize).join(''); },
    set innerHTML(v) {
      if (String(v) === '') { el._children = []; el._text = ''; }
      else el._text = String(v); // tests never inject markup
    },
    appendChild(child) {
      if (child && child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = el;
      el._children.push(child);
      return child;
    },
    removeChild(child) {
      const i = el._children.indexOf(child);
      if (i >= 0) el._children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    remove() { if (el.parentNode) el.parentNode.removeChild(el); },
    addEventListener(type, fn) { (el._listeners[type] ??= []).push(fn); },
    removeEventListener(type, fn) {
      el._listeners[type] = (el._listeners[type] ?? []).filter((f) => f !== fn);
    },
    /** Test helper: dispatch a synthetic event. */
    fire(type, ev = {}) { (el._listeners[type] ?? []).forEach((fn) => fn({ target: el, currentTarget: el, ...ev })); },
    setAttribute(k, v) { el.dataset[k] = String(v); },
    getContext: () => ctx2d(),
  };
  return el;
}

function ctx2d() {
  const base = {
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1,
    font: '10px monospace', textAlign: 'left', textBaseline: 'alphabetic',
    filter: 'none', lineCap: 'butt', lineJoin: 'miter',
    globalCompositeOperation: 'source-over',
    getImageData(x, y, w = 256, h = 256) {
      const width = Math.max(w, 256);
      const height = Math.max(h, 256);
      return { data: new Uint8ClampedArray(width * height * 4), width, height };
    },
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createPattern: () => null,
    measureText: () => ({ width: 8 }),
  };
  // Every 2D call is a no-op: the harness only needs the generators to run,
  // not to paint. A proxy keeps us honest when new canvas APIs show up.
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop !== 'string') return undefined;
      return () => undefined;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
}

export function installDomStub() {
  if (globalThis.document) return () => {};

  const doc = {
    createElement: (tag) => makeElement(tag),
    createTextNode: (text) => ({ _text: String(text), textContent: String(text) }),
    getElementById: () => null,
    querySelector: () => null,
    addEventListener() {}, removeEventListener() {},
    body: makeElement('body'),
    documentElement: makeElement('html'),
    pointerLockElement: null,
    exitPointerLock() {},
  };
  globalThis.document = doc;

  if (!globalThis.window) {
    globalThis.window = {
      innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
      addEventListener() {}, removeEventListener() {},
      AudioContext: undefined,
    };
  }

  // A working localStorage: saves/settings tests round-trip through it.
  if (!globalThis.localStorage) {
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
      setItem: (k, v) => { store.set(String(k), String(v)); },
      removeItem: (k) => { store.delete(String(k)); },
      clear: () => store.clear(),
      key: (i) => [...store.keys()][i] ?? null,
      get length() { return store.size; },
    };
  }

  return () => { delete globalThis.document; };
}
