// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { click, reveal, inspect, openTool } from '../support/controls.mjs';
import { panel, expandSections, textButton, choose, Blocked, openMaskGroup } from '../support/scenario.mjs';
import { until } from '../support/webdriver.mjs';
import { settledPhoto } from './smoke.mjs';

async function preferences(t, tab) {
  await click(t, 'button[data-tour="prefs"]');
  await textButton(t, '.prefs-tabs', tab);
}
export async function nativeReset(t) {
  await preferences(t, 'Modules'); await textButton(t, '.prefs', 'Custom');
  const global = 'button[aria-controls="module-prefs-global"]';
  if (!await t.driver.observe(s => document.querySelector(s)?.getAttribute('aria-expanded') === 'true', global)) await click(t, global);
  const selector = 'select[aria-label="Global Contrast"]';
  const menu = await reveal(t, selector), alternative = menu.options.find(o => o.label.includes('color balance'));
  assert(alternative, 'native alternative Contrast available');
  await choose(t, selector, alternative.value); await textButton(t, '.prefs-foot', 'Done');
  await panel(t, 'basic');
  const moduleChoice=()=>t.driver.observe(()=>JSON.parse(document.querySelector('.window').dataset.moduleChoices).mod_contrast);
  assert.equal(await moduleChoice(),Number(alternative.value),'native choice applied');
  const r = await reveal(t, '[data-control-id="contrast"] input[type=range]');
  await t.driver.drag({ x:r.x, y:r.y }, { x:r.x + r.bounds.width * .1, y:r.y });
  const edited = await settledPhoto(t); await t.evidence('native-edited');
  await click(t, 'button[aria-label="reset all"]');
  await settledPhoto(t); assert.equal(await moduleChoice(),Number(alternative.value),'Reset All preserves selected backend');
  const log=await t.engineLog();assert(/"cmd":"module_state"[^\n]*"reset":true/.test(log),'Reset All requests native parameter reset');
  await t.evidence('native-reset');
  await click(t, 'button.tool[title^="undo ("]');
  await settledPhoto(t, p => p.hash === edited.hash); await t.evidence('native-undo');
  // Source observation only: serialized sidecar of this run's copied fixture.
  const sidecars = await t.sidecars();
  assert(sidecars.some(s => s.includes('colorbalancergb')), 'native settings persisted in isolated sidecar');
  t.measure({ name:'b1d7c4c', sidecarCount:sidecars.length });
}
export async function curves(t) {
  const p = await panel(t, 'tonecurve');
  await textButton(t, `${p} .tabs`, 'Point');
  for (const channel of ['RGB','R','G','B']) {
    await textButton(t, `${p} .channels`, channel);
    const graph = await reveal(t, `${p} svg.curve`);
    const from = { x:graph.x, y:graph.y }, to = { x:graph.x, y:graph.y - graph.bounds.height * .12 };
    await t.driver.drag(from,to); const frame=await settledPhoto(t);
    const path = await t.driver.observe(s => document.querySelector(`${s} svg.curve`)?.outerHTML, p);
    assert(path?.includes('circle'), 'curve exposes editable nodes');
    t.measure({ name:channel, photoHash:frame.hash, graph:path }); await t.evidence(`curve-${channel}`);
  }
  await textButton(t, `${p} .tabs`, 'Parametric'); await expandSections(t,p);
  await t.evidence('parametric');
}
export async function wheels(t) {
  const p=await panel(t,'colorgrading');
  for (const mode of ['3-Way','Global','Sliders']) {
    await textButton(t,`${p} .tabs`,mode);
    const count=await t.driver.observe(s => document.querySelectorAll(`${s} .wheel`).length,p);
    if(mode==='Sliders') { assert.equal(count,0); await t.evidence('grading-sliders'); continue; }
    assert(count>0);
    for(let i=1;i<=count;i++) {
      // Wheel cells may be nested in rows: use a stable title as observation.
      const point=await t.driver.observe((s,i)=>{ const e=document.querySelectorAll(`${s} .wheel`)[i-1],r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width}; },p,i);
      const before=await settledPhoto(t);
      await t.driver.drag(point,{x:point.x+point.width*.2,y:point.y-point.width*.1});
      await settledPhoto(t,q=>q.hash!==before.hash); await t.evidence(`${mode}-${i}`);
      await t.driver.point(point.x,point.y,2); await settledPhoto(t,q=>q.hash===before.hash);
    }
  }
}
export async function equalizer(t) {
  await preferences(t,'Modules'); await textButton(t,'.prefs','Custom');
  const fold='button[aria-controls="module-prefs-global"]';
  if(!await t.driver.observe(s=>document.querySelector(s)?.getAttribute('aria-expanded')==='true',fold)) await click(t,fold);
  const selector='select[aria-label="Global Contrast"]', menu=await reveal(t,selector);
  const option=menu.options.find(o=>o.label.includes('equalizer')); assert(option);
  await choose(t,selector,option.value); await textButton(t,'.prefs-foot','Done'); await panel(t,'basic');
  const channel='select[aria-label="Equalizer channel"]', options=(await reveal(t,channel)).options;
  for(const o of options) {
    await choose(t,channel,o.value);
    for(let band=1;band<=6;band++) {
      const selector=`.equalizer-graph circle:nth-of-type(${band})`, p=await reveal(t,selector);
      const before=await t.driver.observe(s=>document.querySelector(s)?.getAttribute('aria-valuenow'),selector);
      await t.driver.point(p.x,p.y); await t.driver.keys('\uE013');
      await until(()=>t.driver.observe((s,v)=>document.querySelector(s)?.getAttribute('aria-valuenow')!==v,selector,before),'equalizer keyboard change');
      await t.evidence(`equalizer-${o.value}-${band}`);
      await t.driver.keys('\uE011');
    }
  }
  await textButton(t,'.equalizer-heading','Reset'); await settledPhoto(t);
}
export async function masks(t) {
  await openTool(t,'masks');
  for(const name of ['Linear Gradient','Radial Gradient','Brush','Luminance Range','Color Range','Parametric']) {
    const baseline=await settledPhoto(t);
    await click(t,'.create-mask'); await textButton(t,'.shape-menu-list',name);
    // a parametric mask has no shape, so no drawing layer to reach
    if(name!=='Parametric') { const photo=await reveal(t,'svg.mask-svg');
      await t.driver.drag({x:photo.x-photo.bounds.width*.15,y:photo.y},{x:photo.x+photo.bounds.width*.15,y:photo.y+photo.bounds.height*.12}); }
    await until(()=>t.driver.observe(()=>document.querySelectorAll('.mask-list > li').length>0),'created mask');
    // Open the Tone group through its heading, only if it is closed: the
    // heading toggles, and a later mask can find it already open.
    await openMaskGroup(t,'Tone');
    const s=await reveal(t,'[data-control-id="l_exposure"] input[type=range]');
    await t.driver.drag({x:s.x,y:s.y},{x:s.x+s.bounds.width*.12,y:s.y});
    const changed=await settledPhoto(t,p=>p.hash!==baseline.hash);
    t.measure({name,photoHash:changed.hash}); await t.evidence(`mask-${name.replaceAll(' ','-')}`);
    await click(t,'.mask-list > li.on .mask-del');
    await until(()=>t.driver.observe(()=>!document.querySelector('.mask-list > li')),'mask deleted');
    await settledPhoto(t,p=>p.hash===baseline.hash);
  }
}
export async function heal(t) {
  await openTool(t,'heal');
  for(const mode of ['Heal','Clone']) {
    await textButton(t,'.heal-mode',mode);
    const canvas=await reveal(t,'svg.spot-svg');
    await t.driver.point(canvas.x,canvas.y);
    await until(()=>t.driver.observe(()=>!!document.querySelector('.spot-sel')),'spot created');
    for(const id of ['spot_size','spot_feather','spot_opacity']) {
      const s=await reveal(t,`[data-control-id="${id}"] input[type=range]`);
      await t.driver.drag({x:s.x,y:s.y},{x:s.x+s.bounds.width*.05,y:s.y});
    }
    await settledPhoto(t); await t.evidence(mode);
    await textButton(t,'.heal-actions','Delete spot');
    await until(()=>t.driver.observe(()=>!document.querySelector('.spot-sel')),'spot deleted');
  }
}
export async function negative(t) {
  if(t.fixture.name!=='negative') throw new Blocked('Use --fixture negative for conversion tests');
  const baseline=await settledPhoto(t);
  await prepareNegative(t);
  await settledPhoto(t,p=>p.hash!==baseline.hash); await t.evidence('converted');
  await textButton(t,'.negative','Turn Off Conversion'); await settledPhoto(t,p=>p.hash===baseline.hash);
}
export async function zones(t) {
  await openTool(t,'zones');
  const columns=await t.driver.observe(()=>document.querySelectorAll('.zone-col').length); assert(columns>=10);
  for(let i=1;i<=columns;i++) {
    await click(t,`.zone-col:nth-of-type(${i})`);
    await until(()=>t.driver.observe(()=>!!document.querySelector('.zone-name')),'zone selected');
    await t.evidence(`zone-${i}`);
  }
}

export async function prepareNegative(t) {
  await openTool(t,'negative');
  if(await t.driver.observe(()=>!!document.querySelector('.neg-warn'))) await textButton(t,'.neg-warn','Continue');
  await textButton(t,'.negative','Pick Film Border');
  const c=await reveal(t,'.zone-object-box'); await t.driver.point(c.bounds.x+c.bounds.width*.02,c.bounds.y+c.bounds.height*.02);
  await until(()=>t.driver.observe(()=>!!document.querySelector('.neg-swatch')),'negative converted');
}
