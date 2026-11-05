// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';

export function parseViewport(value) {
  const match = /^(\d{3,5})x(\d{3,5})$/.exec(value);
  assert(match, 'viewport must be WIDTHxHEIGHT in logical pixels');
  const width = Number(match[1]), height = Number(match[2]);
  assert(width >= 320 && height >= 240 && width <= 16384 && height <= 16384, 'viewport dimensions out of range');
  return { width, height };
}

export function benchmarkFilename(filename) {
  assert(typeof filename === 'string' && /^gui-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/.test(filename), 'expected a GUI benchmark filename');
  return filename;
}

export function validateBenchmark(report, before, after, screenDrafts = null) {
  assert.equal(report.immage, 'gui-benchmark');
  assert.equal(report.version, 9, 'review validation when benchmark schema changes');
  assert.deepEqual(after, before, 'viewport, DPR and visibility must remain unchanged');
  assert.equal(before.hidden, false, 'app must be visible');
  assert.equal(report.webviewTiming?.backgrounded, false, 'benchmark must remain visible');
  assert.equal(report.viewport?.dpr, before.dpr, 'report DPR must match observed DPR');
  assert(Number.isFinite(report.viewport.width) && report.viewport.width > 0);
  assert(Number.isFinite(report.viewport.height) && report.viewport.height > 0);
  assert(Number.isFinite(report.seconds) && report.seconds > 0);
  assert(Array.isArray(report.samples) && report.samples.length > 0, 'benchmark must contain frames');
  for (const sample of report.samples) {
    assert(Number.isFinite(sample.width) && sample.width > 0 && Number.isFinite(sample.height) && sample.height > 0, 'invalid frame dimensions');
    assert(Number.isFinite(sample.total) && sample.total >= 0, 'invalid frame timing');
  }
  for (const label of ['exposure drag', 'zoom 100%', 'zoom fit'])
    assert(report.samples.some(s => s.label === label), `missing benchmark phase: ${label}`);
  if (screenDrafts !== null) {
    assert.equal(report.configuration?.find(o => o.id === 'screenScale')?.value, String(screenDrafts), 'report must confirm requested screen-scale option');
    const scale = report.viewport.draftScale;
    assert(Number.isFinite(scale) && scale > 0 && (screenDrafts ? scale < 1 : scale === 1), 'unexpected effective draft scale');
  }
}
