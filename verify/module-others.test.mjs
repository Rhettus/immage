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
const { Session } = await import('../app/src/session.ts');
const { MODULE_CHOICES } = await import('../app/src/manifest.ts');
// adjustedModules reads only values, neutral, usedModules, openedModule and sharedHolder
const adjusted = (state, control) => Session.prototype.adjustedModules.call(
  { values: {}, neutral: {}, usedModules: {}, openedModule: {}, sharedHolder: {}, ...state }, control).sort();
const clarity = MODULE_CHOICES.find(c => c.id === 'clarity');
const own = clarity.options.find(o => o.controls.length);
const other = clarity.options.find(o => o !== own).value;

test('modules the photo opened with are marked while the opened module is shown', () => {
  const state = { values: { mod_contrast: 0 }, usedModules: { mod_contrast: [0, 1] }, openedModule: { mod_contrast: 0 } };
  assert.deepEqual(adjusted(state, 'mod_contrast'), [0, 1]);
  assert.deepEqual(adjusted({ ...state, values: { mod_contrast: 1 } }, 'mod_contrast'), []);
});
test('a module whose own sliders are edited stays marked, shown or not', () => {
  const id = own.controls[0];
  const state = { values: { mod_clarity: own.value, [id]: 0.5 }, neutral: { [id]: 0 } };
  assert.deepEqual(adjusted(state, 'mod_clarity'), [own.value]);
  assert.deepEqual(adjusted({ ...state, values: { ...state.values, mod_clarity: other } }, 'mod_clarity'), [own.value]);
  assert.deepEqual(adjusted({ ...state, values: { ...state.values, [id]: 0, mod_clarity: other } }, 'mod_clarity'), []);
});
test('a shared slider is marked on the module showing it, or the one that held it under the equalizer', () => {
  const state = { values: { mod_contrast: 0, contrast: 0.3 }, neutral: { contrast: 0 } };
  assert.deepEqual(adjusted(state, 'mod_contrast'), [0]);
  assert.deepEqual(adjusted({ ...state, values: { mod_contrast: 1, contrast: 0.3 } }, 'mod_contrast'), [1]);
  const under = { ...state, values: { mod_contrast: 2, contrast: 0.3 } };
  assert.deepEqual(adjusted(under, 'mod_contrast'), [0]);
  assert.deepEqual(adjusted({ ...under, sharedHolder: { mod_contrast: 1 } }, 'mod_contrast'), [1]);
  assert.deepEqual(adjusted({ ...under, values: { mod_contrast: 2, contrast: 0 } }, 'mod_contrast'), []);
});
test('AgX and the equalizer both adjusted are both marked', () => {
  const eq = MODULE_CHOICES.find(c => c.id === 'contrast').options.find(o => o.value === 2).controls[0];
  const state = { values: { mod_contrast: 2, contrast: 0.3, [eq]: 0.9 }, neutral: { contrast: 0, [eq]: 0.5 } };
  assert.deepEqual(adjusted(state, 'mod_contrast'), [0, 2]);
});
