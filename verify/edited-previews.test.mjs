// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditedPreviews } from '../app/src/editedPreviews.ts';

const entry = (imgid, over = {}) => ({ imgid, path: `/p/${imgid}.ORF`, filename: `${imgid}.ORF`, version: 0, edited: true, ...over });

// fake timers and a controllable renderer
function rig(over = {}) {
  const state = { idle: true, size: 3000, timers: [], fetched: [], gates: [] };
  const q = createEditedPreviews();
  q.configure({
    fetch: (e, size) => new Promise((resolve) => { state.fetched.push([e.imgid, size]); state.gates.push(resolve); }),
    idle: () => state.idle,
    loadSize: () => state.size,
    kind: (f) => (f.endsWith('.ORF') ? 'RAW' : 'JPEG'),
    setTimer: (fn) => { state.timers.push(fn); return state.timers.length; },
    clearTimer: (h) => { state.timers[h - 1] = null; },
    ...over,
  });
  const tick = () => { const fns = state.timers.filter(Boolean); state.timers = []; fns.forEach((f) => f()); };
  const finish = async () => { state.gates.shift()(); await new Promise((r) => setImmediate(r)); };
  return { q, state, tick, finish };
}

test('renders an edited RAW at the stored size, one at a time, in order', async () => {
  const { q, state, finish } = rig();
  q.schedule(entry(1)); q.schedule(entry(2));
  assert.deepEqual(state.fetched, [[1, 3000]]);
  assert.equal(q.running(), 1);
  assert.deepEqual(q.pending(), [2]);
  await finish();
  assert.deepEqual(state.fetched, [[1, 3000], [2, 3000]]);
});

test('scheduling the same photo again coalesces to one pending job', () => {
  const { q, state } = rig({ idle: () => false });
  q.schedule(entry(1)); q.schedule(entry(2)); q.schedule(entry(1, { version: 5 }));
  assert.deepEqual(q.pending(), [2, 1]);
  assert.equal(state.fetched.length, 0);
});

test('reopening a photo drops its pending job; a running one finishes', async () => {
  const { q, state, finish } = rig();
  q.schedule(entry(1)); q.schedule(entry(2)); q.schedule(entry(3));
  q.cancel(3);
  assert.deepEqual(q.pending(), [2]);
  q.cancel(1);
  await finish();
  assert.equal(q.running(), 2);
  assert.equal(state.fetched.length, 2);
});

test('clear empties the queue and stops the recheck timer', () => {
  const { q, state, tick } = rig({ idle: () => false });
  q.schedule(entry(1));
  assert.equal(state.timers.filter(Boolean).length, 1);
  q.clear();
  assert.deepEqual(q.pending(), []);
  tick();
  assert.equal(state.fetched.length, 0);
});

test('culling opening clears the queue and blocks new jobs while open', () => {
  const { q, state } = rig({ idle: () => false });
  q.schedule(entry(1));
  q.culling(true, false);
  assert.deepEqual(q.pending(), []);
  q.schedule(entry(2));
  assert.deepEqual(q.pending(), []);
  q.culling(false, false);
  q.schedule(entry(2));
  assert.deepEqual(q.pending(), [2]);
  assert.equal(state.fetched.length, 0);
});

test('a job started before a clear finishes without starting what was dropped', async () => {
  const { q, state, finish } = rig();
  q.schedule(entry(1)); q.schedule(entry(2));
  q.clear();
  await finish();
  assert.equal(q.running(), null);
  assert.equal(state.fetched.length, 1);
});

test('no stored size, camera previews, a non-RAW or an unedited photo make no job', () => {
  let r = rig({ loadSize: () => 0 });
  r.q.schedule(entry(1));
  assert.deepEqual(r.q.pending(), []); assert.equal(r.state.fetched.length, 0);
  r = rig();
  r.q.culling(false, true);
  r.q.schedule(entry(1));
  assert.equal(r.state.fetched.length, 0);
  r = rig();
  r.q.schedule(entry(1, { filename: '1.JPG' }));
  r.q.schedule(entry(2, { edited: false }));
  assert.equal(r.state.fetched.length, 0); assert.deepEqual(r.q.pending(), []);
});

test('waits while thumbnails load, then runs when idle', () => {
  const { q, state, tick } = rig({ idle: () => state.idle });
  state.idle = false;
  q.schedule(entry(1));
  assert.equal(state.fetched.length, 0);
  tick();
  assert.equal(state.fetched.length, 0);
  state.idle = true;
  tick();
  assert.deepEqual(state.fetched, [[1, 3000]]);
});

test('a failed render is dropped and the next job runs', async () => {
  const state = { calls: [] };
  const q = createEditedPreviews();
  q.configure({
    fetch: (e) => { state.calls.push(e.imgid); return e.imgid === 1 ? Promise.reject(new Error('x')) : new Promise(() => {}); },
    idle: () => true, loadSize: () => 100, kind: () => 'RAW', setTimer: () => 1, clearTimer: () => {},
  });
  q.schedule(entry(1)); q.schedule(entry(2));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(state.calls, [1, 2]);
});

test('a held queue waits for release, and an open that never paints times out', () => {
  const { q, state, tick } = rig();
  q.hold();
  q.schedule(entry(1));
  assert.equal(state.fetched.length, 0);
  q.release();
  assert.deepEqual(state.fetched, [[1, 3000]]);
  const r = rig();
  r.q.hold();
  r.q.schedule(entry(2));
  // the recheck and the hold's time limit both fire; the limit releases it
  r.tick();
  assert.deepEqual(r.state.fetched, [[2, 3000]]);
  assert.equal(r.state.timers.filter(Boolean).length, 0);
});
