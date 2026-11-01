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

const { MODULE_CHOICES, modules, EQ_IDS, choiceShows, choiceCovers } = await import('../app/src/manifest.ts');
const choice = MODULE_CHOICES.find(c => c.id === 'contrast');
const map = modules.find(m => m.op === 'atrous');
test('equalizer selection replaces only global contrast and participates in saved choice detection', () => {
  assert.ok(choice.options.some(o => o.value === 2 && o.op === 'atrous'));
  assert.equal(choiceShows('contrast', {mod_contrast:2}), false);
  assert.equal(choiceShows('contrast', {mod_contrast:0}), true);
  assert.equal(choiceShows('l_contrast', {mod_contrast:2}), true);
  for (const id of EQ_IDS) {
    assert.ok(choiceCovers(choice).includes(id));
    assert.equal(choiceShows(id, {mod_contrast:2}), true);
    assert.equal(choiceShows(id, {mod_contrast:0}), false);
  }
});
test('native channel parameters round trip, including zero noise thresholds', () => {
  const neutral = Object.fromEntries(EQ_IDS.map((id,i) => [id, i < 18 ? .5 : 0]));
  assert.equal(map.enabled(neutral), false);
  const edited = {...neutral, ce_0_2:.8, ce_4_5:.15};
  assert.equal(map.enabled(edited), true);
  const params = map.write(edited, {}, {});
  assert.equal(params['y[0][2]'], .8);
  assert.equal(params['y[4][5]'], .15);
  const read = map.read(params, {}, {});
  for (const id of EQ_IDS) assert.equal(read[id], edited[id]);
  assert.equal(read.mod_contrast, 2);
});

test('mask choices support local modules and remain independent of global preferences', async () => {
  const { MASK_MODULE_CHOICES, localMaps, preferredChoice } = await import('../app/src/manifest.ts');
  const { loadModuleChoice, storeModuleChoice, storeModuleMode } = await import('../app/src/moduleChoice.ts');
  const storage = new Map();
  globalThis.localStorage = {getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v)};
  try {
    assert.deepEqual(MASK_MODULE_CHOICES.map(c => c.id),
      ['contrast', 'tone_regions', 'clarity', 'texture', 'sharpening', 'defringe']);
    assert.deepEqual(MASK_MODULE_CHOICES[0].options.map(o => o.op), ['colorbalancergb', 'atrous']);
    for (const c of MASK_MODULE_CHOICES) for (const o of c.options) {
      assert.ok(localMaps.some(m => m.op === o.op), o.op);
    }
    storeModuleMode('custom');
    storeModuleChoice('contrast', 0);
    storeModuleChoice('contrast', 2, 'masks');
    assert.equal(loadModuleChoice('contrast'), 0);
    assert.equal(loadModuleChoice('contrast', 'masks'), 2);
    storeModuleChoice('clarity', 1);
    assert.equal(loadModuleChoice('clarity', 'masks'), 0);
    storeModuleMode('default');
    for (const c of MASK_MODULE_CHOICES) {
      assert.equal(loadModuleChoice(c.id, 'masks'), preferredChoice(c));
    }
    storeModuleMode('custom');
    assert.equal(loadModuleChoice('contrast', 'masks'), 2);
  } finally { delete globalThis.localStorage; }
});

test('masked equalizer round trips independently and shared texture follows the mask choice', async () => {
  const { localMaps, choiceOn } = await import('../app/src/manifest.ts');
  const { neutralLocal } = await import('../app/src/masks.ts');
  const { planMerge } = await import('../app/src/localMerge.ts');
  const localEq = localMaps.find(m => m.op === 'atrous');
  const values = {...neutralLocal(), mod_contrast:2, mod_texture:0, l_texture:30, ce_0_2:.731, ce_4_5:.129};
  assert.equal(localEq.enabled(neutralLocal()), false);
  assert.equal(localEq.enabled(values), true);
  assert.equal(choiceOn(localEq, values), true);
  assert.equal(choiceOn(localEq, {mod_contrast:0}), false);
  const params = localEq.write(values, {}, {});
  assert.equal(localEq.read(params, {}, {}).ce_0_2, .731);
  assert.equal(localEq.read(params, {}, {}).ce_4_5, .129);
  const mask = {name:'mask 1', shapes:[{type:'ellipse', x:.5, y:.5, rx:.4, ry:.4, angle:0, feather:.1}],
    invert:false, values};
  const plan = planMerge([mask], {mod_contrast:0, mod_texture:1}, false, {sensorWidth:1200, sensorHeight:800});
  assert.ok(plan.shared.some(m => m.op === 'diffuse'));
  assert.ok(!plan.shared.some(m => m.op === 'contrastntexture#texture'));
});
