import test from 'node:test';
import assert from 'node:assert/strict';
import { SecondaryClickGuard } from '../app/src/secondaryClick.ts';

test('a synthesized primary-looking click after a secondary pointer gesture is ignored', () => {
  const guard = new SecondaryClickGuard();
  assert.equal(guard.pointerDown(2), true);
  assert.equal(guard.click(1), true);
  guard.contextMenu();
  assert.equal(guard.pointerDown(0), false);
  assert.equal(guard.click(1), false, 'the next primary click still selects normally');
});

test('context menu before the synthesized click keeps the gesture suppressed', () => {
  const guard = new SecondaryClickGuard();
  guard.contextMenu(2);
  assert.equal(guard.click(1), true);
  assert.equal(guard.click(0), false, 'a later keyboard click is not poisoned');
});

test('keyboard-generated clicks remain usable without pointer input', () => {
  const guard = new SecondaryClickGuard();
  guard.contextMenu(0);
  assert.equal(guard.click(0), false);
  assert.equal(guard.pointerDown(0), false);
  assert.equal(guard.click(1), false, 'the next primary pointer click remains usable');
});
