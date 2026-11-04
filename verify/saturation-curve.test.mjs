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


const { MODULE_CHOICES, MASK_MODULE_CHOICES, modules, localMaps, SATCURVE_IDS, SATCURVE_NEUTRAL, satPointValues,
        satPointsOf, choiceShows, choiceCovers, choiceOn } = await import('../app/src/manifest.ts');
const choice = MODULE_CHOICES.find(c => c.id === 'saturation');
const map = modules.find(m => m.op === 'satcurvergb');
const balance = modules.find(m => m.op === 'colorbalancergb' && m.controls.includes('saturation'));

test('the saturation curve replaces the Saturation slider and counts as an edit of the tool', () => {
  assert.deepEqual(choice.options.map(o => o.op), ['agx', 'colorbalancergb', 'satcurvergb']);
  assert.equal(choiceShows('saturation', {mod_saturation:2}), false);
  assert.equal(choiceShows('saturation', {mod_saturation:1}), true);
  for (const id of SATCURVE_IDS) {
    assert.ok(choiceCovers(choice).includes(id));
    assert.equal(choiceShows(id, {mod_saturation:2}), true);
    assert.equal(choiceShows(id, {mod_saturation:0}), false);
  }
});

test('only one module carries Saturation, on sigmoid too', () => {
  for (const tm_mode of [0, 1]) {
    assert.equal(choiceOn(balance, {mod_saturation:2, tm_mode}), false);
    assert.equal(choiceOn(map, {mod_saturation:2, tm_mode}), true);
    assert.equal(choiceOn(map, {mod_saturation:1, tm_mode}), false);
  }
  // a photo on sigmoid, which has no saturation, keeps color balance rgb's
  assert.equal(choiceOn(balance, {mod_saturation:0, tm_mode:0}), true);
  assert.equal(choiceOn(balance, {mod_saturation:0, tm_mode:1}), false);
});

test('both curves round trip, and unused nodes are zeroed as darktable leaves them', () => {
  assert.equal(map.enabled(SATCURVE_NEUTRAL), false);
  const edited = {...SATCURVE_NEUTRAL, ...satPointValues([[0, .62], [.45, .66], [1, .42]], 0),
                  ...satPointValues([[0, .5], [.4, .58], [1, .48]], 1)};
  assert.equal(map.enabled(edited), true);
  const params = map.write(edited, {}, {});
  assert.equal(params['channel[0].curve_num_nodes'], 3);
  assert.equal(params['channel[0].curve[1].x'], .45);
  assert.equal(params['channel[0].curve[1].y'], .66);
  assert.equal(params['channel[1].curve[2].y'], .48);
  assert.equal(params['channel[0].curve[3].x'], 0);
  assert.equal(params['channel[0].curve[3].y'], 0);
  assert.ok(map.fields.every(f => f in params));
  const read = map.read(params, {}, {});
  for (const id of SATCURVE_IDS) assert.equal(read[id], edited[id], id);
  assert.equal(read.mod_saturation, 2);
  assert.deepEqual(satPointsOf(read, 0), [[0, .62], [.45, .66], [1, .42]]);
  // darktable's own default curve reads as no edit
  const flat = {'channel[0].curve_num_nodes':2, 'channel[0].curve[0].x':0, 'channel[0].curve[0].y':.5,
                'channel[0].curve[1].x':1, 'channel[0].curve[1].y':.5,
                'channel[1].curve_num_nodes':2, 'channel[1].curve[0].x':0, 'channel[1].curve[0].y':.5,
                'channel[1].curve[1].x':1, 'channel[1].curve[1].y':.5};
  assert.equal(map.enabled(map.read(flat, {}, {})), false);
});

test('masks offer color balance rgb or the curve, and a mask on the curve leaves its shared Saturation at 0', async () => {
  const { neutralLocal } = await import('../app/src/masks.ts');
  const c = MASK_MODULE_CHOICES.find(x => x.id === 'saturation');
  assert.deepEqual(c.options.map(o => o.op), ['colorbalancergb', 'satcurvergb']);
  assert.equal(c.options.find(o => o.preferred).value, 1);
  const local = localMaps.find(m => m.op === 'satcurvergb');
  const shared = localMaps.find(m => m.op === 'colorbalancergb' && m.controls.includes('l_saturation'));
  const values = {...neutralLocal(), mod_saturation:2, l_saturation:40, ...satPointValues([[0, .7], [1, .5]], 0)};
  assert.equal(local.enabled(neutralLocal()), false);
  assert.equal(local.enabled(values), true);
  assert.equal(choiceOn(local, values), true);
  assert.equal(choiceOn(local, {...values, mod_saturation:1}), false);
  assert.equal(shared.write(values, {}, {}).saturation_global, 0);
  assert.equal(shared.write({...values, mod_saturation:1}, {}, {}).saturation_global, .4);
  assert.equal(local.read(local.write(values, {}, {}), {}, {}).sc_p0y, .7);
});
