// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { settledFitView } from '../app/src/fitPreview.ts';

test('settled detail budget is independent of viewer orientation and size', () => {
  for (const profile of ['quality', 'balanced']) {
    const wide = settledFitView({width: 1992, height: 1326}, profile, 1);
    const tall = settledFitView({width: 900, height: 1600}, profile, 1);
    assert.deepEqual(wide, {width: 3072, height: 3072});
    assert.deepEqual(tall, wide);
    // A portrait photo must get the same processing long edge as a landscape.
    for (const [w, h] of [[5496, 3672], [3672, 5496]]) {
      const scale = Math.min(1, wide.width / w, wide.height / h);
      assert.equal(Math.round(Math.max(w, h) * scale), 3072);
    }
  }
});

test('Performance retains viewer dimensions and fractional-scale preference', () => {
  const view = {width: 1992, height: 1326};
  assert.deepEqual(settledFitView(view, 'performance', 1), view);
  assert.deepEqual(settledFitView(view, 'performance', 0.625), {width: 1245, height: 829});
  assert.deepEqual(settledFitView(view, 'balanced', 0.625), {width: 1920, height: 1920});
  assert.deepEqual(settledFitView(view, 'quality', 0.625), {width: 1920, height: 1920});
});

test('a minimized Performance viewer still requests valid dimensions', () => {
  assert.deepEqual(settledFitView({width: -20, height: 0}, 'performance', 1), {width: 1, height: 1});
});

// Full-size drafts share the view builder with settled frames in App.
test('full-size drag drafts keep the previous viewer-sized budget in every profile', () => {
  const view = {width: 1992, height: 1326};
  for (const profile of ['quality', 'balanced', 'performance']) {
    assert.deepEqual(settledFitView(view, profile, 1, false), view);
    assert.deepEqual(settledFitView(view, profile, 0.625, false), {width: 1245, height: 829});
  }
});
