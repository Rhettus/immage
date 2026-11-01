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
