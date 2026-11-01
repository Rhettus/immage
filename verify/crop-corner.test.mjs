// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require = createRequire(new URL('../app/package.json', import.meta.url));
const {transformSync} = await import(require.resolve('rolldown/experimental'));
const source = readFileSync(new URL('../app/src/CropTool.tsx', import.meta.url), 'utf8');
const {code} = transformSync('crop.ts', source.slice(source.indexOf('function constrain(')));
const constrain = new Function(`${code}; return constrain;`)();

test('every locked corner shrinks on the first single-axis inward pull', () => {
  const start = {l: 0, t: 0, r: 1, b: 1};
  for (const handle of ['nw', 'ne', 'sw', 'se']) {
    for (const axis of ['x', 'y']) {
      const requested = {...start};
      const side = axis === 'x' ? (handle.includes('w') ? 'l' : 'r')
        : (handle.includes('n') ? 't' : 'b');
      requested[side] += ['l', 't'].includes(side) ? 0.1 : -0.1;
      const result = constrain(handle, requested, start, 1.5, {w: 900, h: 600});
      assert.ok(Math.abs((result.r - result.l) - 0.9) < 1e-9);
      assert.ok(Math.abs((result.b - result.t) - 0.9) < 1e-9);
      assert.equal(handle.includes('w') ? result.r : result.l, handle.includes('w') ? 1 : 0);
      assert.equal(handle.includes('n') ? result.b : result.t, handle.includes('n') ? 1 : 0);
    }
  }
});


test('portrait edge drags preserve the ratio and opposite edge on a tiny inward pull', () => {
  const start = {l: 0, t: 0, r: 1, b: 1};
  const frame = {w: 600, h: 900};
  for (const [handle, side, delta] of [['n', 't', 0.001], ['s', 'b', -0.001],
    ['w', 'l', 0.001], ['e', 'r', -0.001]]) {
    const result = constrain(handle, {...start, [side]: start[side] + delta}, start, 2 / 3, frame);
    assert.ok(Math.abs((result.r - result.l) * frame.w / ((result.b - result.t) * frame.h) - 2 / 3) < 1e-9);
    assert.ok(Math.abs(result[side] - (start[side] + delta)) < 1e-9);
    const opposite = {n: 'b', s: 't', w: 'r', e: 'l'}[handle];
    assert.equal(result[opposite], start[opposite]);
  }
});
