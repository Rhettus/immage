// SPDX-License-Identifier: GPL-3.0-or-later
// Engine-free: Start over and ctrl+click compress (truncate) on the undo stack.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pushBatchStep, truncateRedo, UNDO_LIMIT } from '../app/src/undoStack.ts';

const stack = (past, future) => ({ past, future, key: 'exposure', at: 5 });

test('truncate drops redo steps, keeps undo steps and resets the run key', () => {
  const u = stack([{ n: 1 }, { n: 2 }], [{ n: 3, batch: { token: 9, recovery: false } }, { n: 4 }]);
  const dropped = truncateRedo(u);
  assert.deepEqual(dropped.map(s => s.n), [3, 4]);
  assert.deepEqual(u.past.map(s => s.n), [1, 2]);
  assert.deepEqual(u.future, []);
  assert.equal(u.key, '');
});

test('truncate with nothing to redo drops nothing', () => {
  const u = stack([{ n: 1 }], []);
  assert.deepEqual(truncateRedo(u), []);
  assert.equal(u.past.length, 1);
});

test('start over is one undo step carrying its batch and clears redo', () => {
  const u = stack([{ n: 1 }], [{ n: 2, batch: { token: 4, recovery: false } }]);
  const before = { n: 3 };
  const dropped = pushBatchStep(u, before, { token: 7, recovery: false });
  assert.deepEqual(dropped.map(s => s.n), [2]);
  assert.deepEqual(u.future, []);
  assert.equal(u.key, '');
  assert.equal(u.past.at(-1), before);
  assert.deepEqual(before.batch, { token: 7, recovery: false });
});

test('start over past is capped, dropping the oldest step for release', () => {
  const u = stack(Array.from({ length: UNDO_LIMIT }, (_, n) => ({ n })), []);
  const dropped = pushBatchStep(u, { n: 'new' }, { token: 1, recovery: false });
  assert.equal(u.past.length, UNDO_LIMIT);
  assert.deepEqual(dropped, [{ n: 0 }]);
  assert.equal(u.past.at(-1).n, 'new');
});
