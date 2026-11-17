// SPDX-License-Identifier: GPL-3.0-or-later
// curveFn (app/src/tonecurve.ts), the drawn curve of Advanced mode's tone
// curve and rgb curve cards: darktable's three interpolations, no engine
import test from 'node:test';
import assert from 'node:assert/strict';

const { curveFn } = await import('../app/src/tonecurve.ts');
const S = [[0, 0], [0.25, 0.15], [0.5, 0.5], [0.75, 0.85], [1, 1]];
const STEEP = [[0, 0], [0.4, 0.05], [0.45, 0.9], [1, 1]];

for (const type of [0, 1, 2]) {
  test(`type ${type} passes through its nodes`, () => {
    const f = curveFn(type, S);
    for (const [x, y] of S) assert.ok(Math.abs(f(x) - y) < 1e-5, `f(${x}) = ${f(x)}, want ${y}`);
  });
  test(`type ${type} keeps identity points on the diagonal`, () => {
    const f = curveFn(type, [[0, 0], [0.3, 0.3], [0.7, 0.7], [1, 1]]);
    for (let x = 0; x <= 1; x += 0.05) assert.ok(Math.abs(f(x) - x) < 1e-5, `f(${x}) = ${f(x)}`);
  });
  test(`type ${type} output stays within 0..1`, () => {
    const f = curveFn(type, STEEP);
    for (let x = -0.2; x <= 1.2; x += 0.01) assert.ok(f(x) >= 0 && f(x) <= 1, `f(${x}) = ${f(x)}`);
  });
}

test('monotone hermite does not overshoot or dip', () => {
  const f = curveFn(2, STEEP);
  let last = 0;
  for (let x = 0; x <= 1; x += 0.005) { const y = f(x); assert.ok(y >= last - 1e-6, `dips at ${x}`); last = y; }
});

test('the cubic spline overshoots where the monotone one does not', () => {
  const raw = (type) => { const f = curveFn(type, [[0, 0], [0.4, 0.05], [0.45, 0.5], [1, 0.5]]); return Math.max(...Array.from({ length: 201 }, (_, i) => f(i / 200))); };
  assert.ok(raw(0) > 0.5 + 1e-3 || raw(1) > 0.5 + 1e-3);
  assert.ok(raw(2) <= 0.5 + 1e-6);
});

test('two nodes are a straight line in every type', () => {
  for (const type of [0, 1, 2]) assert.ok(Math.abs(curveFn(type, [[0, 0.2], [1, 0.8]])(0.5) - 0.5) < 1e-6);
});

// CurveDataSample (curve_tools.c) fills the table outside the end nodes
// with their y, so the drawn curve must not extrapolate there
test('the curve holds its end values outside the end nodes', () => {
  const pts = [[0.2, 0.1], [0.5, 0.6], [0.8, 0.7]];
  for (const type of [0, 1, 2]) {
    const f = curveFn(type, pts);
    assert.equal(f(0), 0.1, `type ${type} below the first node`);
    assert.equal(f(1), 0.7, `type ${type} above the last node`);
  }
});
