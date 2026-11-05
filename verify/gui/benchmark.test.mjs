// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkFilename, validateBenchmark, parseViewport } from './support/benchmark.mjs';

test('viewport requirements are bounded logical dimensions, not executable setup', () => {
  assert.deepEqual(parseViewport('1979x1171'), { width: 1979, height: 1171 });
  for (const value of ['1x1', '0x1171', '1979x0', '20000x20000', '1979x1171;command', '1979.5x1171'])
    assert.throws(() => parseViewport(value));
});

const environment = { width: 1280, height: 800, dpr: 2, hidden: false };
function report() {
  return { immage: 'gui-benchmark', version: 9, seconds: 65,
    viewport: { width: 1800, height: 1200, dpr: 2, draftScale: .625 },
    webviewTiming: { backgrounded: false }, configuration: [{ id: 'screenScale', value: 'true' }],
    samples: ['exposure drag', 'zoom 100%', 'zoom fit'].map(label => ({ label, width: 1000, height: 750, total: 20 })) };
}
test('report filenames cannot select arbitrary files or traverse the profile', () => {
  assert.equal(benchmarkFilename('gui-2026-11-02T12-30-45.json'), 'gui-2026-11-02T12-30-45.json');
  for (const value of ['../gui-2026-11-02T12-30-45.json', '/tmp/report.json', 'engine.log', '..\\report.json', null])
    assert.throws(() => benchmarkFilename(value));
});
test('different frame geometries are valid; a screen-scale report must confirm both setting and effective scale', () => {
  const r = report(); r.samples[1].width = 1800;
  validateBenchmark(r, environment, environment, true);
  r.configuration[0].value = 'false';
  assert.throws(() => validateBenchmark(r, environment, environment, true));
  r.viewport.draftScale = 1;
  validateBenchmark(r, environment, environment, false);
  r.viewport.draftScale = .625;
  assert.throws(() => validateBenchmark(r, environment, environment, false));
});
test('backgrounding and changed viewport or DPR reject a comparison', () => {
  for (const change of [{ width: 1200 }, { height: 900 }, { dpr: 1 }, { hidden: true }])
    assert.throws(() => validateBenchmark(report(), environment, { ...environment, ...change }));
  const r = report(); r.webviewTiming.backgrounded = true;
  assert.throws(() => validateBenchmark(r, environment, environment));
  r.webviewTiming = null;
  assert.throws(() => validateBenchmark(r, environment, environment));
});
test('empty, incomplete and invalid measurements cannot count as a benchmark pass', () => {
  for (const mutate of [r => r.samples = [], r => r.samples.pop(), r => r.samples[0].total = NaN,
    r => r.samples[0].width = 0, r => r.viewport.dpr = 1, r => r.version = 8]) {
    const r = report(); mutate(r);
    assert.throws(() => validateBenchmark(r, environment, environment));
  }
});
