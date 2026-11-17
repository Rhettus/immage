// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { easeZoom, ZOOM_EASE } from '../app/src/zoom.ts';
import { wheelZoom } from '../app/src/culling.ts';

test('lightbox easing matches the editor trajectory and snap in both directions', () => {
  for (const [start,target] of [[.2,1],[1,.2],[.05,1],[1,.05]]) {
    let actual=start, expected=start, frames=0;
    do {
      expected += (target-expected)*ZOOM_EASE;
      if (Math.abs(target-expected)<target*.002) expected=target;
      actual=easeZoom(actual,target);
      assert.equal(actual,expected);
      assert.ok(++frames<30);
    } while (actual!==target);
  }
});

test('lightbox wheel zoom follows editor scale, 100% detent, cap and Fit stop', () => {
  assert.ok(Math.abs(wheelZoom(1, -50, false, .25) - Math.exp(.04)) < 1e-12);
  assert.ok(Math.abs(wheelZoom(1, -50, true, .25) - Math.exp(.3)) < 1e-12);
  assert.equal(wheelZoom(.99, -50, false, .2), 1); // do not skip across 100%
  assert.equal(wheelZoom(.251, 50, false, .25), null); // return to Fit
  assert.equal(wheelZoom(3.9, -50, false, .2), 4); // maximum detail
  assert.equal(wheelZoom(1, -500, false, .25), wheelZoom(1, -50, false, .25)); // cap acceleration
});
