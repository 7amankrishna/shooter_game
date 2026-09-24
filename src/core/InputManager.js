/**
 * InputManager — keyboard + mouse with a pointer-lock *and* a graceful fallback.
 *
 * Mouse look normally uses the Pointer Lock API. The game is also playable from
 * an embedded preview pane where pointer lock may be blocked, so when the lock
 * is refused we fall back to: raw mouse deltas while the cursor is in the middle
 * of the view + an "edge assist" turn rate when it is pushed against a border,
 * plus Alt+Arrow keys as a pure-keyboard look mode. Nobody gets stuck on a
 * browser policy.
 */
import { clamp } from './math.js';

const KEYS = {
  KeyW: 'forward', ArrowUp: 'forward',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  Space: 'jump',
  ShiftLeft: 'sprint', ShiftRight: 'sprint',
  KeyC: 'crouch', ControlLeft: 'crouch', ControlRight: 'crouch',
  KeyR: 'reload',
  KeyF: 'focus',
  Digit1: 'slot1', Digit2: 'slot2', Digit3: 'slot3', Digit4: 'slot4',
  KeyE: 'interact',
  KeyB: 'buymenu',
};

export class InputManager {
  constructor({ element, onLockChange, onUnlock }) {
    this.element = element;
    this.onLockChange = onLockChange;
    this.onUnlock = onUnlock;
    this.keys = new Set();
    this.look = { x: 0, y: 0 };
    this.mouse = { fire: false, ads: false };
    this.pressed = new Set();
    this.locked = false;
    this.lockSupported = typeof document !== 'undefined' && 'pointerLockElement' in document;
    this.edgeAssist = true;
    this.sensitivity = 1;
    this.pointer = { x: 0.5, y: 0.5 };
    this.lastMove = -10;
    this.wheel = 0;
    this._bound = new Map();
  }

  attach() {
    if (typeof window === 'undefined') return;
    const add = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      this._bound.set([target, type, fn], { target, type, fn, opts });
    };
    add(window, 'keydown', this._onKeyDown, { passive: false });
    add(window, 'keyup', this._onKeyUp);
    add(window, 'blur', this._onBlur);
    add(window, 'mousemove', this._onMouseMove);
    add(window, 'mousedown', this._onMouseDown);
    add(window, 'mouseup', this._onMouseUp);
    add(window, 'contextmenu', (e) => e.preventDefault());
    add(window, 'wheel', this._onWheel, { passive: true });
    add(document, 'pointerlockchange', this._onLockChange);
    add(document, 'pointerlockerror', this._onLockError);
  }

  detach() {
    for (const { target, type, fn, opts } of this._bound.values()) target.removeEventListener(type, fn, opts);
    this._bound.clear();
  }

  _onKeyDown = (e) => {
    if (e.repeat) return;
    const action = KEYS[e.code];
    if (action) {
      this.keys.add(action);
      this.pressed.add(action);
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    }
    if (e.code === 'Escape') {
      this.pressed.add('pause');
    }
    if (e.code === 'F3') this.pressed.add('debug');
    if (e.code === 'F6') {
      this.pressed.add('admin');
      e.preventDefault();
    }
    if (e.code === 'KeyM') this.pressed.add('mute');
    if (e.code === 'AltLeft' || e.code === 'AltRight') this.keys.add('alt');
  };

  _onKeyUp = (e) => {
    const action = KEYS[e.code];
    if (action) this.keys.delete(action);
    if (e.code === 'AltLeft' || e.code === 'AltRight') this.keys.delete('alt');
  };

  _onBlur = () => {
    this.keys.clear();
    this.mouse.fire = false;
    this.mouse.ads = false;
  };

  _onMouseMove = (e) => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.lastMove = now;
    if (this.locked) {
      this.look.x += e.movementX || 0;
      this.look.y += e.movementY || 0;
    } else {
      const w = window.innerWidth || 1;
      const h = window.innerHeight || 1;
      this.pointer.x = clamp(e.clientX / w, 0, 1);
      this.pointer.y = clamp(e.clientY / h, 0, 1);
      this.look.x += e.movementX || 0;
      this.look.y += e.movementY || 0;
    }
  };

  _onMouseDown = (e) => {
    if (e.button === 0) {
      this.mouse.fire = true;
      this.pressed.add('fire');
    }
    if (e.button === 2) this.mouse.ads = true;
    this.pressed.add('mousedown');
  };

  _onMouseUp = (e) => {
    if (e.button === 0) this.mouse.fire = false;
    if (e.button === 2) this.mouse.ads = false;
  };

  _onWheel = (e) => {
    this.wheel += Math.sign(e.deltaY);
  };

  _onLockChange = () => {
    const wasLocked = this.locked;
    this.locked = document.pointerLockElement === this.element;
    this.onLockChange?.(this.locked, { wasLocked });
    // A rejected request is not an unlock. Only pause after a lock that was
    // actually active is lost (important on Vercel/embedded previews where
    // pointer lock is commonly denied and the mouse fallback is valid).
    if (!this.locked && wasLocked) this.onUnlock?.();
  };

  _onLockError = () => {
    const wasLocked = this.locked;
    this.locked = false;
    this.lockDenied = true;
    this.onLockChange?.(false, { wasLocked, denied: true });
    if (wasLocked) this.onUnlock?.();
  };

  requestLock() {
    if (!this.lockSupported) {
      this.lockDenied = true;
      return false;
    }
    this.lockDenied = false;
    const denied = () => {
      // Keep the run alive. InputManager.sample() deliberately supports mouse
      // movement, edge assist and Alt+Arrow look without pointer lock.
      this.lockDenied = true;
    };
    try {
      const p = this.element.requestPointerLock({ unadjustedMovement: true });
      if (p?.catch) {
        p.catch(() => {
          // A few browsers reject the options overload even though the legacy
          // request is allowed. Try the legacy form before falling back.
          try {
            const fallback = this.element.requestPointerLock();
            if (fallback?.catch) fallback.catch(denied);
          } catch {
            denied();
          }
        });
      }
      return true;
    } catch {
      try {
        const p = this.element.requestPointerLock();
        if (p?.catch) p.catch(denied);
        return true;
      } catch {
        denied();
        return false;
      }
    }
  }

  exitLock() {
    if (!this.lockSupported) return;
    try {
      document.exitPointerLock?.();
    } catch { /* noop */ }
  }

  /**
   * Consumes the accumulated look delta — call exactly once per frame.
   * @param dt seconds (used by the edge-assist fallback)
   */
  sample(dt) {
    const alt = this.keys.has('alt');
    let lookX = this.look.x;
    let lookY = this.look.y;
    this.look.x = 0;
    this.look.y = 0;

    // unlocked fallbacks: edge assist + Alt+arrows
    if (!this.locked) {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const active = now - this.lastMove < 1.4;
      if (this.edgeAssist && active) {
        const margin = 0.24;
        const ex = this.pointer.x > 1 - margin ? (this.pointer.x - (1 - margin)) / margin : this.pointer.x < margin ? -(margin - this.pointer.x) / margin : 0;
        const ey = this.pointer.y > 1 - margin ? (this.pointer.y - (1 - margin)) / margin : this.pointer.y < margin ? -(margin - this.pointer.y) / margin : 0;
        const rate = 300 * dt;
        lookX += ex * rate;
        lookY += ey * rate;
      }
      if (alt) {
        const rate = 220 * dt;
        if (this.keys.has('left')) lookX -= rate;
        if (this.keys.has('right')) lookX += rate;
        if (this.keys.has('forward')) lookY -= rate * 0.6;
        if (this.keys.has('back')) lookY += rate * 0.6;
      }
    }
    const sens = this.sensitivity * (this.locked ? 1 : 0.85);
    const arrowLook = alt && !this.locked;
    const wheel = this.wheel;
    const state = {
      lookDelta: { x: lookX * sens, y: lookY * sens },
      forward: this.keys.has('forward') && !arrowLook,
      back: this.keys.has('back') && !arrowLook,
      left: this.keys.has('left') && !arrowLook,
      right: this.keys.has('right') && !arrowLook,
      jump: this.keys.has('jump'),
      sprinting: this.keys.has('sprint'),
      crouch: this.keys.has('crouch'),
      fire: this.mouse.fire,
      ads: this.mouse.ads,
      firePressed: this.pressed.has('fire'),
      reloadPressed: this.pressed.has('reload'),
      pausePressed: this.pressed.has('pause'),
      debugPressed: this.pressed.has('debug'),
      mutePressed: this.pressed.has('mute'),
      slot1Pressed: this.pressed.has('slot1'),
      slot2Pressed: this.pressed.has('slot2'),
      slot3Pressed: this.pressed.has('slot3'),
      slot4Pressed: this.pressed.has('slot4'),
      interactPressed: this.pressed.has('interact'),
      buymenuPressed: this.pressed.has('buymenu'),
      adminPressed: this.pressed.has('admin'),
      wheel,
      autoReload: true,
      locked: this.locked,
      moveLen: this.keys.has('forward') || this.keys.has('back') || this.keys.has('left') || this.keys.has('right') ? 1 : 0,
    };
    this.pressed.clear();
    this.wheel = 0;
    return state;
  }
}
