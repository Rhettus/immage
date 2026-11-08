// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { mkdtempSync, copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../app/package.json', import.meta.url));
const { transformSync } = await import(require.resolve('rolldown/experimental'));
const shim = new URL('./shim.mjs', import.meta.url).href;
registerHooks({
  load(url, ctx, next) {
    if (!url.startsWith('file:') || !/\.tsx?$/.test(url)) return next(url, ctx);
    const path = fileURLToPath(url);
    return { format: 'module', source: transformSync(path, readFileSync(path, 'utf8'), { jsx: { runtime: 'automatic' } }).code, shortCircuit: true };
  },
  resolve(spec, ctx, next) {
    if (spec.startsWith('@tauri-apps/') || spec === '@immporter/api') return next(shim, ctx);
    if (/^\.\.?\//.test(spec) && !/\.[cm]?[jt]sx?$/.test(spec))
      for (const ext of ['.ts', '.tsx']) {
        const u = new URL(spec + ext, ctx.parentURL);
        if (existsSync(fileURLToPath(u))) return next(u.href, ctx);
      }
    return next(spec, ctx);
  },
});
process.env.OMP_NUM_THREADS = '2';
globalThis.window = globalThis;
const store = new Map();
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k,v) => store.set(k,String(v)), removeItem: k => store.delete(k) };
globalThis.addEventListener ??= () => {};
globalThis.requestAnimationFrame = f => setTimeout(() => f(performance.now()), 0);
globalThis.cancelAnimationFrame = clearTimeout;
const { Session, colorProfiles } = await import('../app/src/session.ts');
const { COPY_GROUPS } = await import('../app/src/CopySettings.tsx');
const { startEngine, stopEngine, request } = await import('./shim.mjs');

test('Negative color profiles pass through Session, Copy Settings, Reset and sidecar reopening', {timeout:60000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'immage-color-session-'));
  const photo = join(dir, 'negative.jpg');
  copyFileSync(join(root, 'app/sample/stairs-to-mountain.jpg'), photo);
  startEngine(join(root, 'build/bin/darktable-engine'), join(dir, 'runtime'));
  const errors = [];
  const open = async () => {
    const s = await Session.open(photo, null, () => ({width:64,height:64}), () => {}, e => errors.push(e), true);
    await s.settled();
    assert.deepEqual(errors, []);
    return s;
  };
  try {
    let s = await open();
    s.endBaseline();
    const defaults = [s.neutral.neg_input_profile, s.neutral.neg_working_profile];
    const menu = await colorProfiles();
    assert(menu.input.some(([,v]) => v === 3));
    assert(menu.working.some(([,v]) => v === 4));
    const copy = COPY_GROUPS.find(g => g.id === 'negative');
    assert(copy.ids.includes('neg_input_profile') && copy.ids.includes('neg_working_profile'));
    s.setMany([['neg_input_profile',3], ['neg_working_profile',4], ['neg_on',1]]);
    await s.settled();
    assert.deepEqual(errors, []);
    const native = (await request({cmd:'get',modules:{colorin:['input_profile','working_profile']}})).modules.colorin.params;
    assert.deepEqual(native, {input_profile:3,working_profile:4});
    await s.close();
    s = await open();
    assert.equal(s.values.neg_input_profile,3);
    assert.equal(s.values.neg_working_profile,4);
    const beforeReset = {...s.values};
    s.resetModules();
    s.setMany(Object.entries(s.neutral));
    await s.settled();
    const reset = (await request({cmd:'get',modules:{colorin:['input_profile','working_profile']}})).modules.colorin;
    assert.deepEqual(reset.params,reset.defaults);
    assert.deepEqual(errors, []);
    // Mirror App.restore after Reset all: restore control values, then each
    // native state captured before reset. Neutral writes must not replace it.
    s.setMany(Object.entries(beforeReset));
    for (const key of s.touched) {
      const h = s.history.find(h => `${h.op}#${h.priority}` === key);
      if (h) s.setModuleState(h, {restore:'opened'});
    }
    await s.settled();
    assert.equal(s.values.neg_on,1,'Undo Reset all restores conversion');
    assert.equal(s.values.neg_input_profile,3,'Undo Reset all restores input profile');
    assert.equal(s.values.neg_working_profile,4,'Undo Reset all restores working profile');
    assert.deepEqual(errors, []);
    await s.close();
  } finally {
    await stopEngine();
    rmSync(dir,{recursive:true,force:true});
  }
});
