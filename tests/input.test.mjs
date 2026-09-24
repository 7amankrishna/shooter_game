/** Pointer-lock behavior is optional: denied locks must not pause a run. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDomStub } from './stubDom.js';

installDomStub();
const { InputManager } = await import('../src/core/InputManager.js');

test('input: a denied pointer lock keeps the fallback controls available', async () => {
  const element = {
    requestPointerLock: () => Promise.reject(new Error('permission denied')),
  };
  const lockEvents = [];
  let unlocks = 0;
  const input = new InputManager({
    element,
    onLockChange: (locked, details) => lockEvents.push({ locked, details }),
    onUnlock: () => { unlocks += 1; },
  });

  assert.equal(input.requestLock(), true, 'the request is attempted');
  // Flush both the options-overload rejection and the legacy retry.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(input.locked, false);
  assert.equal(input.lockDenied, true);
  assert.equal(lockEvents.length, 0, 'a denied request is not reported as an unlock');
  assert.equal(unlocks, 0, 'a denied request does not trigger pause/unlock handling');
});

test('input: losing an active pointer lock still reports a real unlock', () => {
  const element = { requestPointerLock: () => {} };
  const events = [];
  let unlocks = 0;
  const input = new InputManager({
    element,
    onLockChange: (locked, details) => events.push({ locked, details }),
    onUnlock: () => { unlocks += 1; },
  });

  document.pointerLockElement = element;
  input._onLockChange();
  document.pointerLockElement = null;
  input._onLockChange();

  assert.equal(events.length, 2);
  assert.equal(events[0].locked, true);
  assert.equal(events[1].locked, false);
  assert.equal(events[1].details.wasLocked, true);
  assert.equal(unlocks, 1);
});
