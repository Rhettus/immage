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
