// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../app/package.json', import.meta.url));
const { transformSync } = await import(require.resolve('rolldown/experimental'));
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@tauri-apps/api/core') return { url: 'data:text/javascript,export async function invoke(){}', shortCircuit: true };
    if (spec.startsWith('./')) for (const ext of ['.ts', '.tsx']) {
      const url = new URL(spec + ext, ctx.parentURL);
      if (existsSync(url)) return next(url.href, ctx);
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (!url.startsWith('file:') || !url.endsWith('.ts')) return next(url, ctx);
    const path = fileURLToPath(url);
    return { format: 'module', source: transformSync(path, readFileSync(path, 'utf8')).code, shortCircuit: true };
  },
});
globalThis.localStorage = { getItem() { return null; } };
const { PixelWorker } = await import('../app/src/pixelWorker.ts');
const { runPixelTask } = await import('../app/src/pixelTasks.ts');
const { computeHistogram } = await import('../app/src/histogram.ts');
const { perf } = await import('../app/src/perf.ts');
const pixels = new Uint8ClampedArray([0, 20, 40, 255, 255, 200, 100, 255]);
const task = { kind: 'histogram', pixels, width: 2, height: 1 };
class FakeWorker {
  messages = [];
  postMessage(value, transfer) { this.messages.push(structuredClone(value, { transfer })); }
  finish() {
    const { id, task } = this.messages.shift();
    this.onmessage({ data: { id, result: runPixelTask(task), workMs: 1 } });
  }
  terminate() { this.terminated = true; }
}
test('worker queue keeps only latest pending frame and never transfers renderer buffers', () => {
  const worker = new FakeWorker(), pool = new PixelWorker(() => worker), shown = [];
  pool.submit('histogram', task, () => shown.push('old'));
  pool.submit('histogram', task, () => shown.push('middle'));
  pool.submit('histogram', task, result => shown.push(result));
  assert.equal(worker.messages.length, 1);
  assert.equal(pixels.length, 8);
  worker.finish();
  assert.deepEqual(shown, []);
  assert.equal(worker.messages.length, 1);
  worker.finish();
  assert.deepEqual(shown, [computeHistogram(pixels, 2, 1)]);
  pool.dispose();
  assert.equal(worker.terminated, true);
});
test('cancel and dispose suppress late results, including a worker event already queued', () => {
  const worker = new FakeWorker(), pool = new PixelWorker(() => worker);
  pool.submit('clip', { ...task, kind: 'clipping', show: { low: true, high: true } }, () => assert.fail('obsolete overlay'));
  pool.cancel('clip'); worker.finish();
  pool.submit('histogram', task, () => assert.fail('closed photo'));
  pool.dispose(); worker.finish();
});
test('worker failure falls back to the newest task and remains usable', () => {
  const worker = new FakeWorker(), pool = new PixelWorker(() => worker), shown = [];
  pool.submit('histogram', task, () => assert.fail('obsolete'));
  pool.submit('histogram', task, result => shown.push(result));
  worker.onerror({ preventDefault() {} });
  assert.equal(pool.threaded, false);
  assert.deepEqual(shown, [computeHistogram(pixels, 2, 1)]);
  pool.submit('histogram', task, result => shown.push(result));
  assert.equal(shown.length, 2);
  pool.dispose();
});
test('clipping kernels preserve pixel semantics', () => {
  assert.deepEqual([...runPixelTask({ ...task, kind: 'clipping', show: { low: true, high: true } })], [0,64,255,255,255,0,0,255]);
  assert.equal(pixels[0], 0);
});
test('frontend metrics record counts and timing distributions by benchmark step', () => {
  perf.resetFrontend(); perf.measuring = true; perf.label = 'exposure drag';
  perf.input(); perf.input(); perf.count('nativeFramesRequested');
  perf.work('pixels.copy', 2); perf.work('pixels.copy', 4);
  perf.reactCommit('app', 'update', 3, 5, 10, 16);
  const report = perf.frontendReport();
  assert.equal(report.byStep[0].counts.sliderInputs, 2);
  assert.equal(report.byStep[0].counts['react.app.update'], 1);
  assert.equal(report.timings['pixels.copy'].total, 6);
  assert.equal(report.timings['react.app.renderToCommit'].p50, 6);
  perf.label = ''; perf.measuring = false;
});
test('an unresponsive worker times out and completes through fallback', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = new FakeWorker(), pool = new PixelWorker(() => worker), shown = [];
  pool.submit('histogram', task, result => shown.push(result));
  t.mock.timers.tick(10000);
  assert.equal(pool.threaded, false);
  assert.deepEqual(shown, [computeHistogram(pixels, 2, 1)]);
  pool.dispose();
});
test('histogram cadence coalesces before copying, flushes release and cancels old photos', async t => {
  const { PixelCadence } = await import('../app/src/pixelWorker.ts');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  const shown = [];
  const cadence = new PixelCadence(value => shown.push(value), () => now);
  cadence.submit(0, true);
  assert.deepEqual(shown, []); // drawing finishes before the copy
  t.mock.timers.tick(1);
  assert.deepEqual(shown, [0]);
  now = 20;
  t.mock.timers.tick(20);
  cadence.submit(20, true);
  now = 79;
  t.mock.timers.tick(59);
  cadence.submit(79, true);
  assert.deepEqual(shown, [0]);
  now = 80;
  t.mock.timers.tick(1);
  assert.deepEqual(shown, [0, 79]);
  now = 81;
  cadence.submit(81, true);
  cadence.flush();
  t.mock.timers.tick(1);
  assert.deepEqual(shown, [0, 79, 81]);
  cadence.submit(82, true);
  cadence.submit(83, false); // exact final frame bypasses drag cadence
  t.mock.timers.tick(1);
  assert.deepEqual(shown, [0, 79, 81, 83]);
  cadence.submit(84, true);
  cadence.cancel();
  t.mock.timers.tick(100);
  assert.deepEqual(shown, [0, 79, 81, 83]);
  cadence.submit(85, true); // new photo starts immediately
  t.mock.timers.tick(1);
  assert.equal(shown.at(-1), 85);
});

test('same-size clipping results expire when their displayed surface changes', async () => {
  const { FrameGeneration } = await import('../app/src/canvasLayers.ts');
  const sharp = new FrameGeneration(), base = new FrameGeneration();
  const worker = new FakeWorker(), queue = new PixelWorker(() => worker);
  const shown = [];
  const source = sharp.capture();
  queue.submit('clipSharp', {...task, kind: 'clipping', show: {low: true, high: true}}, result => {
    if (sharp.matches(source)) shown.push(result);
  });
  sharp.next(); // same-size native replacement, before its clipping job is queued
  worker.finish();
  assert.equal(shown.length, 0);
  const baseSource = base.capture();
  queue.submit('clipBase', {...task, kind: 'clipping', show: {low: true, high: true}}, result => {
    if (base.matches(baseSource)) shown.push(result);
  });
  sharp.next(); // a sharp replacement leaves the base underneath unchanged
  worker.finish();
  assert.equal(shown.length, 1);
  const sharpSource = sharp.capture();
  queue.submit('clipSharp', {...task, kind: 'clipping', show: {low: true, high: true}}, result => {
    if (sharp.matches(sharpSource)) shown.push(result);
  });
  sharp.next(); // another native frame with unchanged dimensions and settings
  worker.finish();
  assert.equal(shown.length, 1);
  queue.dispose();
});

test('histogram results expire before the newer cadence input dispatches', async t => {
  const { FrameGeneration } = await import('../app/src/canvasLayers.ts');
  const { PixelCadence } = await import('../app/src/pixelWorker.ts');
  t.mock.timers.enable({apis: ['setTimeout']});
  const generation = new FrameGeneration(), worker = new FakeWorker();
  const queue = new PixelWorker(() => worker), shown = [];
  let now = 0;
  const cadence = new PixelCadence(({token, input}) => {
    if (!generation.matches(token)) return;
    queue.submit('histogram', input, result => {
      if (generation.matches(token)) shown.push(result);
    });
  }, () => now);
  cadence.submit({token: generation.next(), input: task}, true);
  t.mock.timers.tick(1);
  assert.equal(worker.messages.length, 1);
  now = 10;
  cadence.submit({token: generation.next(), input: {...task, pixels: pixels.slice()}}, true);
  worker.finish(); // still the latest worker job, but no longer the displayed frame
  assert.equal(shown.length, 0);
  now = 80;
  t.mock.timers.tick(80);
  worker.finish();
  assert.equal(shown.length, 1);
  cadence.submit({token: generation.next(), input: task}, true);
  generation.next(); // a photo/crop transition retires even undelivered inputs
  t.mock.timers.tick(100);
  assert.equal(worker.messages.length, 0);
  assert.equal(shown.length, 1);
  cadence.cancel(); queue.dispose();
});
