// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { easeZoom, ZOOM_EASE } from '../app/src/zoom.ts';

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
