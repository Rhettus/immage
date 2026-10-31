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
  anchors = new Map();
  postMessage(value, transfer) { this.messages.push(structuredClone(value, { transfer })); }
  finish() {
    const { id, task, validationIds } = this.messages.shift();
    if (validationIds?.length) {
      validationIds.forEach((id, i) => {
        const key = ['pixels', 'other', 'actual'][i];
        if (!this.anchors.has(id)) this.anchors.set(id, task[key]);
        task[key] = this.anchors.get(id);
      });
      for (const id of this.anchors.keys()) if (!validationIds.includes(id)) this.anchors.delete(id);
    }
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
test('clipping and CPU interpolation kernels preserve pixel semantics', () => {
  assert.deepEqual([...runPixelTask({ ...task, kind: 'clipping', show: { low: true, high: true } })], [0,64,255,255,255,0,0,255]);
  assert.deepEqual([...runPixelTask({ ...task, kind: 'mix', other: new Uint8ClampedArray([20,40,60,128,235,180,80,128]), mix: .5 })], [10,30,50,128,245,190,90,128]);
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
test('validation matches full-frame interpolation error', async () => {
  const { mixDetailPixels, predictionError } = await import('../app/src/cachedDetail.ts');
  const a = new Uint8ClampedArray(4096 * 4), b = a.slice(), actual = a.slice();
  for (let i=0;i<a.length;i++) {
    a[i] = (i * 71) % 256; b[i] = (i * 13 + 55) % 256; actual[i] = (i * 37) % 256;
  }
  for (const mix of [-1, -.5, 0, .5, 1, 1.5, 2]) {
    const task = { kind: 'validation', pixels: a, other: b, actual, mix, width: 64, height: 64 };
    const expected = predictionError(mixDetailPixels(a, b, mix), actual);
    assert.deepEqual(runPixelTask(task), expected);
    const worker = new FakeWorker(), pool = new PixelWorker(() => worker);
    let result;
    pool.submit('validation', task, value => { result = value; });
    const sent = worker.messages[0].task;
    for (const key of ['pixels', 'other', 'actual']) assert.equal(sent[key].length, a.length);
    worker.finish();
    assert.deepEqual(result, expected);
    assert.equal(a.length, 4096 * 4);
    pool.dispose();
    const fallback = new PixelWorker(() => { throw Error('unavailable'); });
    fallback.submit('validation', task, value => assert.deepEqual(value, expected));
    fallback.dispose();
  }
});
test('direct validation preserves clamping, ties to even, alpha exclusion and invalid input', async () => {
  const { mixedPredictionError, mixDetailPixels, predictionError } = await import('../app/src/cachedDetail.ts');
  const a = new Uint8ClampedArray([0, 1, 2, 0, 255, 254, 253, 255]);
  const b = new Uint8ClampedArray([1, 2, 3, 255, 254, 253, 252, 0]);
  for (const mix of [.5, -10, 10]) {
    assert.deepEqual(mixedPredictionError(a, b, a, mix), predictionError(mixDetailPixels(a, b, mix), a));
  }
  assert.deepEqual(mixedPredictionError(a, b, new Uint8ClampedArray(), .5), {mean:Infinity,p95:Infinity});
});
test('validation reuses two anchors, bounds retained frames and falls back with original buffers', () => {
  const worker = new FakeWorker(), pool = new PixelWorker(() => worker);
  const frames = Array.from({length: 8}, (_, i) => new Uint8ClampedArray(64).fill(i * 30));
  for (let i=0;i<frames.length-2;i++) {
    const task = {kind:'validation', pixels:frames[i], other:frames[i+1], actual:frames[i+2], mix:.5, width:4,height:4};
    pool.submit('validation', task, result => assert.deepEqual(result, runPixelTask(task)));
    const sent = worker.messages[0].task;
    assert.equal(sent.pixels.length, i ? 0 : 64);
    assert.equal(sent.other.length, i ? 0 : 64);
    assert.equal(sent.actual.length, 64);
    worker.finish();
    assert.equal(worker.anchors.size, 3);
  }
  const task = {kind:'validation', pixels:frames[6], other:frames[7], actual:frames[0], mix:.5, width:4,height:4};
  let result;
  pool.submit('validation', task, value => { result = value; });
  assert.equal(worker.messages[0].task.pixels.length, 0);
  worker.onerror({preventDefault(){}});
  assert.deepEqual(result, runPixelTask(task));
  for (const frame of frames) assert.equal(frame.length, 64);
  pool.dispose();
});
test('real worker resolves retained validation buffers and evicts unused anchors', async () => {
  const replies = [];
  globalThis.self = {postMessage: value => replies.push(value)};
  await import('../app/src/pixel.worker.ts');
  const first = {kind:'validation', pixels, other:pixels.slice(), actual:pixels.slice(), mix:.5,width:2,height:1};
  const send = (task, validationIds) => self.onmessage({data:{id:replies.length,task,validationIds}});
  send(first, [1,2,3]);
  const next = {...first, pixels:new Uint8ClampedArray(), other:new Uint8ClampedArray(), actual:pixels.slice()};
  send(next, [2,3,4]);
  assert.deepEqual(replies[1].result, runPixelTask(first));
  const replacement = {...first, pixels:new Uint8ClampedArray(pixels.length).fill(255), other:pixels.slice(), actual:pixels.slice()};
  const expected = runPixelTask(replacement);
  send(replacement, [1,5,6]); // id 1 was evicted, so this must use the new pixels
  assert.deepEqual(replies[2].result, expected);
  delete globalThis.self;
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
  sharp.next(); // a GPU estimate changes sharp pixels, not the base underneath
  worker.finish();
  assert.equal(shown.length, 1);
  const gpuSource = sharp.capture();
  queue.submit('clipSharp', {...task, kind: 'clipping', show: {low: true, high: true}}, result => {
    if (sharp.matches(gpuSource)) shown.push(result);
  });
  sharp.next(); // GPU -> CPU fallback, with unchanged dimensions and settings
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
  generation.next(); // a photo/crop/GPU transition retires even undelivered inputs
  t.mock.timers.tick(100);
  assert.equal(worker.messages.length, 0);
  assert.equal(shown.length, 1);
  cadence.cancel(); queue.dispose();
});
