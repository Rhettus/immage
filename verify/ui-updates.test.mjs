// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../app/package.json', import.meta.url));
const { transformSync } = await import(require.resolve('rolldown/experimental'));
const modulePaths = Object.fromEntries(["react", "lucide-react"].map(name => [name, require.resolve(name)]));
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@tauri-apps/api/core') return { url: 'data:text/javascript,export async function invoke(){}', shortCircuit: true };
    if (spec === 'react' || spec === 'lucide-react') return next(modulePaths[spec], ctx);
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
const { FrameUpdates, Snapshot } = await import('../app/src/uiUpdates.ts');
const { panelValues } = await import('../app/src/panelValues.ts');
const { panels, controlById, choiceShows, MODULE_CHOICES, pointValues } = await import('../app/src/manifest.ts');
function queue() {
  let value = {}, publications = 0, serial = 0;
  const frames = new Map();
  const updates = new FrameUpdates(fn => { value = fn(value); publications++; },
    callback => { frames.set(++serial, callback); return serial; }, id => frames.delete(id));
  return { updates, frames, value: () => value, publications: () => publications,
    frame() { for (const callback of [...frames.values()]) callback(); } };
}
test('high-rate input publishes once per display frame and keeps edits to different controls', () => {
  const q = queue();
  for (let n = 0; n < 100; n++) q.updates.enqueue(old => ({ ...old, exposure: n }));
  q.updates.enqueue(old => ({ ...old, contrast: 12 }));
  assert.equal(q.publications(), 0); assert.equal(q.frames.size, 1);
  q.frame(); assert.equal(q.publications(), 1);
  assert.deepEqual(q.value(), { exposure: 99, contrast: 12 });
  assert.equal(q.frames.size, 0);
});
test('release flushes the final value; discrete updates and photo replacement cannot be overwritten', () => {
  const q = queue();
  q.updates.enqueue(old => ({ ...old, exposure: 2 })); q.updates.flush();
  assert.deepEqual(q.value(), { exposure: 2 }); assert.equal(q.frames.size, 0);
  q.updates.enqueue(old => ({ ...old, exposure: 3 }));
  q.updates.immediate(old => ({ ...old, contrast: 4 }));
  assert.deepEqual(q.value(), { exposure: 3, contrast: 4 });
  q.updates.enqueue(old => ({ ...old, exposure: 5 })); q.updates.immediate(() => ({}));
  q.frame(); assert.deepEqual(q.value(), {});
  q.updates.enqueue(() => ({ exposure: 9 })); q.updates.dispose();
  q.frame(); assert.deepEqual(q.value(), {}); assert.equal(q.frames.size, 0);
});
test('histogram snapshots notify subscribers only, and unsubscribe cleanly', () => {
  const store = new Snapshot(null); let scopes = 0, curves = 0;
  const a = store.subscribe(() => scopes++), b = store.subscribe(() => curves++);
  const histogram = {}; store.set(histogram); store.set(histogram);
  assert.equal(store.get(), histogram); assert.equal(scopes, 1); assert.equal(curves, 1);
  a(); store.set(null); assert.equal(scopes, 1); assert.equal(curves, 2); b();
});
test('panel slices preserve visibility and dependent tracks for every manifest control', () => {
  const values = Object.fromEntries([...controlById].map(([id, c]) => [id, c.neutral ?? (c.min + c.max) / 2]));
  for (const choice of MODULE_CHOICES) for (const option of choice.options) {
    values[choice.control] = option.value;
    for (const panel of panels) {
      const selected = panelValues(panel, values);
      for (const section of panel.sections) for (const c of section.controls) {
        assert.equal(selected[c.id], values[c.id], c.id);
        assert.equal(choiceShows(c.id, selected), choiceShows(c.id, values), c.id);
        if (typeof c.track === 'function') assert.equal(c.track(selected), c.track(values), c.id);
      }
    }
  }
});
test('unrelated edits retain panel identity, while modes and point-curve edits invalidate it', () => {
  const panel = panels.find(p => p.id === 'tonecurve');
  const initial = { tc_mode: 1, ...pointValues([[0, 0], [1, 1]], 'r'), exposure: 0, neg_on: 0 };
  const selected = panelValues(panel, initial);
  assert.equal(panelValues(panel, { ...initial, exposure: 1 }, selected), selected);
  const points = panelValues(panel, { ...initial, ...pointValues([[0, 0], [.5, .7], [1, 1]], 'r') }, selected);
  assert.notEqual(points, selected); assert.equal(points.tc_r_p1y, .7);
  assert.notEqual(panelValues(panel, { ...initial, neg_on: 1 }, selected), selected);
});
