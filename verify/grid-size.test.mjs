// SPDX-License-Identifier: GPL-3.0-or-later
// Engine-free tests of the grid's thumbnail size (Preferences.tsx
// clampGridSize / loadGridSize, Toolbar.tsx GridZoomBar's log-scale slider)
// and Performance > Memory's thumbnail threads (library.ts loadThumbThreads,
// storeThumbThreads)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../app/package.json', import.meta.url));
const { transformSync } = await import(require.resolve('rolldown/experimental'));
// Preferences.tsx and Toolbar.tsx pull in most of the app, so the code under
// test is cut out of them by its markers and compiled on its own
const stub = 'data:text/javascript,' + encodeURIComponent('export const invoke=async(c)=>c==="settings_all"?{}:null,listen=async()=>()=>{}');
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@tauri-apps/api/core' || spec === '@tauri-apps/api/event') return { url: stub, shortCircuit: true };
    if (spec === './immich' && ctx.parentURL?.endsWith('/library.ts')) return { url: 'data:text/javascript,export const fetchImmichThumb=async()=>null;', shortCircuit: true };
    if (spec.startsWith('./') || spec.startsWith('../')) for (const ext of ['.ts', '.tsx']) {
      const url = new URL(spec + ext, ctx.parentURL);
      if (existsSync(url)) return next(url.href, ctx);
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (!url.startsWith('file:') || !/\.tsx?$/.test(url)) return next(url, ctx);
    const path = fileURLToPath(url);
    return { format: 'module', source: transformSync(path, readFileSync(path, 'utf8'), { jsx: { runtime: 'automatic' } }).code, shortCircuit: true };
  },
});
const src = new URL('../app/src/', import.meta.url);
function cut(file, from, to) {
  const text = readFileSync(new URL(file, src), 'utf8');
  const a = text.indexOf(from);
  assert.ok(a >= 0, `${file}: ${from} not found`);
  const b = text.indexOf(to, a);
  assert.ok(b >= 0, `${file}: ${to} not found`);
  return text.slice(a, b);
}
globalThis.window = globalThis;
globalThis.addEventListener ??= () => {};
const store = new Map();
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k),
  get length() { return store.size; }, key: i => [...store.keys()][i] ?? null };
const { settings, ready } = await import('../app/src/settings.ts');
await ready;
const prefs = cut('Preferences.tsx', 'const GRID_SIZE_KEY', '// Lightroom');
const bar_ = cut('Toolbar.tsx', 'export function GridZoomBar', '// the bar under the filmstrip');
// elements as plain {type, props} objects, so no React is needed
const head = `import { settings } from "${new URL('settings.ts', src).href}";\n` +
  'const React = { createElement: (type, props, ...c) => ({ type, props: { ...props, children: c.length < 2 ? c[0] : c } }) };\n';
const build = (name, code) => {
  const file = fileURLToPath(new URL(`${name}.tsx`, src));
  const out = transformSync(file, head + code, { jsx: { runtime: 'classic' } }).code;
  return import('data:text/javascript;base64,' + Buffer.from(out).toString('base64'));
};
const P = await build('prefs-cut', prefs);
const { GridZoomBar } = await build('toolbar-cut', bar_);
const L = await import('../app/src/library.ts');

const KEY = 'immage.gridSize';
const withValue = (key, v) => { if (v === null) settings.remove(key); else settings.set(key, v); };

test('the grid size is 120 to 400, 200 by default', () => {
  assert.equal(P.GRID_SIZE_MIN, 120);
  assert.equal(P.GRID_SIZE_MAX, 400);
  assert.equal(P.GRID_SIZE_DEFAULT, 200);
  for (const [v, want] of [[50, 120], [119.9, 120], [120, 120], [256.5, 256.5], [400, 400], [401, 400], [1e9, 400]])
    assert.equal(P.clampGridSize(v), want, String(v));
});

test('a stored grid size loads clamped; nothing or junk loads the default', () => {
  withValue(KEY, null);
  assert.equal(P.loadGridSize(), 200);
  // the old six steps (120 to 400) and any size a pinch settled on still load
  for (const v of ['120', '160', '200', '260', '330', '400', '237.25']) { withValue(KEY, v); assert.equal(P.loadGridSize(), Number(v), v); }
  withValue(KEY, '90'); assert.equal(P.loadGridSize(), 120);
  withValue(KEY, '1000'); assert.equal(P.loadGridSize(), 400);
  for (const v of ['', 'big', '0', '-5', 'NaN']) { withValue(KEY, v); assert.equal(P.loadGridSize(), 200, JSON.stringify(v)); }
  P.storeGridSize(333.5);
  assert.equal(P.loadGridSize(), 333.5);
  withValue(KEY, null);
});

// the slider element's props and its label, from the component's own tree
function bar(size) {
  const calls = [];
  const tree = GridZoomBar({ size, min: 120, max: 400, standard: 200, onSize: v => calls.push(v) });
  const kids = [].concat(tree.props.children);
  return { tree, input: kids.find(k => k.type === 'input'), label: kids.find(k => k.type === 'span'), calls };
}

test('the zoom slider maps 0..1000 to 120..400 evenly in ratio', () => {
  assert.equal(bar(120).input.props.value, 0);
  assert.equal(bar(400).input.props.value, 1000);
  // the default sits where the ratio puts it, not at the middle
  const mid = bar(200).input.props.value;
  assert.equal(mid, Math.round(1000 * Math.log(200 / 120) / Math.log(400 / 120)));
  assert.ok(mid > 400 && mid < 500, String(mid));
  // the geometric middle of the range is the slider's middle
  assert.equal(bar(Math.sqrt(120 * 400)).input.props.value, 500);
  // dragging back gives the size the position stands for, and round trips
  const { input, calls } = bar(200);
  for (const pos of [0, 1, 250, 500, 999, 1000]) {
    input.props.onChange({ target: { value: String(pos) } });
    assert.ok(Math.abs(calls.at(-1) - 120 * (400 / 120) ** (pos / 1000)) < 1e-9, String(pos));
  }
  assert.equal(calls[0], 120);
  assert.ok(Math.abs(calls.at(-1) - 400) < 1e-9);
  for (const size of [120, 150, 200, 275.5, 400])
    assert.ok(Math.abs(bar(size).input.props.value - 1000 * Math.log(size / 120) / Math.log(400 / 120)) <= 0.5, String(size));
});

test('the zoom label is the size against the default; double-click returns to it', () => {
  assert.equal(bar(200).label.props.children, '100%');
  assert.equal(bar(120).label.props.children, '60%');
  assert.equal(bar(400).label.props.children, '200%');
  assert.equal(bar(250).label.props.children, '125%');
  const { tree, calls } = bar(333);
  tree.props.onDoubleClick();
  assert.deepEqual(calls, [200]);
});

test('thumbnail threads: 1, 2, 3, 4, 6 or 8, two by default', () => {
  assert.deepEqual(L.THUMB_THREADS, [1, 2, 3, 4, 6, 8]);
  assert.equal(L.THUMB_THREADS_DEFAULT, 2);
  const key = 'immage.thumbThreads';
  withValue(key, null);
  assert.equal(L.loadThumbThreads(), 2);
  for (const n of L.THUMB_THREADS) { withValue(key, String(n)); assert.equal(L.loadThumbThreads(), n); }
  // outside the choices (5, 7, 0, 9, junk): the default
  for (const v of ['0', '5', '7', '9', '16', '-1', 'x', '']) { withValue(key, v); assert.equal(L.loadThumbThreads(), 2, JSON.stringify(v)); }
  withValue(key, null);
});

test('the Linux pinch (pinch.rs) sends ctrl wheel events at the rate the viewer and grid zoom by', () => {
  const rust = readFileSync(new URL('../app/src-tauri/src/pinch.rs', import.meta.url), 'utf8');
  const rate = Number(/const CTRL_WHEEL_RATE: f64 = ([0-9.]+);/.exec(rust)?.[1]);
  assert.ok(rate > 0, 'CTRL_WHEEL_RATE found');
  for (const file of ['App.tsx', 'Filmstrip.tsx']) {
    const text = readFileSync(new URL(file, src), 'utf8');
    if (/ctrlKey \? 0\.006/.test(text) || text.includes(`exp(-delta * ${rate}`) || text.includes(`* ${rate}`)) return;
  }
  assert.fail(`no wheel handler scales by exp(-deltaY * ${rate}) for ctrl`);
});
