/**
 * Minimal DOM/canvas stub so the browser-only asset generators can run in Node.
 * The simulation harness needs `document.createElement('canvas')` to exist
 * because every texture is procedurally painted; nothing here touches pixels.
 */
export function installDomStub() {
  if (globalThis.document) return () => {};
  const base = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    globalAlpha: 1,
    font: '10px monospace',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    filter: 'none',
    lineCap: 'butt',
    lineJoin: 'miter',
    globalCompositeOperation: 'source-over',
    canvas: null,
    getImageData(x, y, w = 256, h = 256) {
      const width = Math.max(w, 256);
      const height = Math.max(h, 256);
      return { data: new Uint8ClampedArray(width * height * 4), width, height };
    },
    createLinearGradient() {
      return { addColorStop() {} };
    },
    createRadialGradient() {
      return { addColorStop() {} };
    },
    createPattern() {
      return null;
    },
    measureText() {
      return { width: 8 };
    },
  };
  // Every 2D call is a no-op: the harness only needs the generators to run,
  // not to paint. A proxy keeps us honest when new canvas APIs show up.
  const ctx = new Proxy(base, {
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

  const doc = {
    createElement(tag) {
      return {
        tagName: tag,
        width: 256,
        height: 256,
        style: {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        getContext: () => ctx,
        addEventListener() {},
        removeEventListener() {},
        appendChild() {},
        removeChild() {},
        setAttribute() {},
      };
    },
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {},
    body: { classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} },
    documentElement: { style: {} },
    pointerLockElement: null,
    exitPointerLock() {},
  };
  globalThis.document = doc;
  if (!globalThis.window) {
    globalThis.window = {
      innerWidth: 1280,
      innerHeight: 720,
      devicePixelRatio: 1,
      addEventListener() {},
      removeEventListener() {},
      AudioContext: undefined,
    };
  }
  if (!globalThis.localStorage) globalThis.localStorage = { getItem: () => null, setItem() {} };
  return () => {
    delete globalThis.document;
  };
}
