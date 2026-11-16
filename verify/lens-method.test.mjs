// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require=createRequire(new URL('../app/package.json',import.meta.url));
const reactPath=require.resolve('react');
const {transformSync}=await import(require.resolve('rolldown/experimental'));
registerHooks({
  resolve(spec,ctx,next){
    if(spec==='@tauri-apps/api/core')return {url:'data:text/javascript,export async function invoke(){return {};}',shortCircuit:true};
    if(spec==='react')return next(reactPath,ctx);
    if(spec.startsWith('./')||spec.startsWith('../'))for(const ext of ['.ts','.tsx']){
      const url=new URL(spec+ext,ctx.parentURL);if(existsSync(url))return next(url.href,ctx);
    }
    return next(spec,ctx);
  },
  load(url,ctx,next){
    if(!url.startsWith('file:')||!/\.tsx?$/.test(url))return next(url,ctx);
    const path=fileURLToPath(url),out=transformSync(path,readFileSync(path,'utf8'),{jsx:{runtime:'automatic'}});
    if(out.errors?.length)throw Error(JSON.stringify(out.errors));
    return {format:'module',source:out.code,shortCircuit:true};
  },
});

globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.addEventListener ??= () => {};
const M = await import('../app/src/manifest.ts');
const { simpleShows } = await import('../app/src/advancedEdits.ts');
const map = M.mapsFor('lens')[0];
const ctx = { sensorWidth: 1, sensorHeight: 1, orientation: 0, camera: 0 };

test('Simple reads the lens method and writes it back as read', () => {
  const read = map.read({ modify_flags: 7, lens_pick: 0, method: 1, has_been_set: 1 }, {}, ctx);
  assert.equal(read.lens_method, 1);
  const w = map.write({ lens_ca: 1, lens_pick: 0, lens_method: 1 }, {}, ctx);
  assert.equal(w.method, 1);
  assert.equal(w.lens_pick, 0);
});

test('choosing embedded metadata puts a database lens pick back to Auto', () => {
  const w = map.write({ lens_ca: 1, lens_pick: 1234, lens_method: 0 }, {}, ctx);
  assert.equal(w.method, 0);
  assert.equal(w.lens_pick, 0);
});

test('a write without a method leaves the method alone', () => {
  assert.equal('method' in map.write({ lens_ca: 0, lens_pick: 5 }, {}, ctx), false);
});

test('the method control lists the two methods, and a third only when set', () => {
  const c = M.controlById.get('lens_method');
  assert.deepEqual(c.optionsFor(ctx, 1).map(o => o[1]), [0, 1]);
  assert.deepEqual(c.optionsFor(ctx, 2).map(o => o[1]), [0, 1, 2]);
  assert.equal(c.format(2), 'Manual vignette only');
});

test('Simple shows the first lens instance, so the badge leaves it to the method control', () => {
  assert.equal(simpleShows({ op: 'lens', priority: 0, name: '', hand_edited: false }), true);
});

const unset = { modify_flags: 7, lens_pick: 0, method: 0, has_been_set: 0, lens_lensfun: 1 };
const method = (p, defaults) => map.read(p, defaults, ctx).lens_method;

test('an untouched module with a Lensfun profile prefers Lensfun, as the neutral and as the first write', () => {
  assert.equal(method(unset, unset), 1);
  assert.equal(map.write({ lens_ca: 1, lens_pick: 0, lens_method: 1 }, unset, ctx).method, 1);
});

test('without a Lensfun profile the untouched module stays on embedded', () => {
  const none = { ...unset, lens_lensfun: 0 };
  assert.equal(method(none, none), 0);
});

test('a module already set keeps its stored method, and an unset enabled one shows what it renders', () => {
  assert.equal(method({ ...unset, has_been_set: 1 }, unset), 0);
  assert.equal(method({ ...unset, has_been_set: 1, method: 1 }, unset), 1);
  assert.equal(method({ ...unset }, { ...unset }), 0);
});

test('a photo without embedded data keeps Lensfun', () => {
  const lf = { ...unset, method: 1 };
  assert.equal(method(lf, lf), 1);
});
