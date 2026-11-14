// SPDX-License-Identifier: GPL-3.0-or-later
// A panel's eye (Session.peek): held, the photo renders with that panel's
// controls at their defaults and the other panels' edits kept; the sliders'
// values and the sidecar stay as edited; let go, the edit is back
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
const { Session } = await import('../app/src/session.ts');
const { panels } = await import('../app/src/manifest.ts');
const { peekIds } = await import('../app/src/panelValues.ts');
const { startEngine, stopEngine, request } = await import('./shim.mjs');
const view = () => ({ width:64,height:64 });
const panel = id => panels.find(p => p.id === id);
const wait = ms => new Promise(r => setTimeout(r, ms));

test('a panel\'s eye leaves out module choices and what the Before view keeps', () => {
  const basic = peekIds(panel('basic'));
  assert(basic.includes('exposure') && basic.includes('vibrance'));
  assert(!basic.includes('tm_mode') && !basic.includes('exp_comp'));
  assert(!basic.some(id => id.startsWith('mod_')));
  assert(peekIds(panel('effects')).includes('vig_cx'), 'the vignette center goes with Effects');
  assert(peekIds(panel('transform')).includes('tf_upright'), 'Upright goes with Transform');
  assert(peekIds(panel('tonecurve')).some(id => id.startsWith('tc_')), 'the point curve goes with Tone Curve');
});

test('peeking a panel renders it at its defaults, keeps the rest, and saves nothing', {timeout:120000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'immage-peek-'));
  const path = join(dir, 'photo.jpg');
  copyFileSync(join(root,'app/sample/stairs-to-mountain.jpg'), path);
  startEngine(join(root,'build/bin/darktable-engine'), join(dir,'runtime'), null);
  try {
    const { imgid } = await request({cmd:'open',path});
    let failure;
    const s = await Session.open(path, imgid, view, () => {}, e => { failure=e; });
    await s.settled(); assert.equal(failure, undefined);
    s.endBaseline();
    const pixels = async name => { const rgba=join(dir,name+'.rgba'); await request({cmd:'render',width:64,height:64,rgba}); return readFileSync(rgba); };
    const save = async () => { await s.settled(); await wait(800); await s.settled(); };

    s.setMany([['vig_amount',-60],['exposure',1],['vibrance',40]]); await save();
    // the first time every module is sent again, as the Before view does,
    // this JPEG renders slightly differently from the edit before it (the
    // Before view shows the same here); the comparisons start after it
    s.showBefore(() => false); await save(); s.showBefore(null); await save();
    const edited = await pixels('edited');
    const sidecar = readFileSync(path+'.xmp','utf8');

    const ids = peekIds(panel('basic'));
    s.peek(new Set(ids)); await save();
    const peeked = await pixels('peeked');
    assert.notDeepEqual(peeked, edited);
    assert.equal(s.values.exposure, 1, 'the sliders keep their values');
    assert.equal(s.values.vibrance, 40);
    assert.equal(readFileSync(path+'.xmp','utf8'), sidecar, 'nothing of the peek is saved');

    s.peek(null); await save();
    assert.deepEqual(await pixels('released'), edited, 'let go, the edit is back');

    // the peek is Basic's sliders really at their defaults, the vignette kept
    s.setMany(ids.map(id => [id, s.neutral[id]])); await save();
    assert.deepEqual(await pixels('basic-neutral'), peeked);
    assert.equal(s.values.vig_amount, -60);
    await s.close();
    assert.match(readFileSync(path+'.xmp','utf8'), /exposure/);
  } finally { await stopEngine(); rmSync(dir,{recursive:true,force:true}); }
});
