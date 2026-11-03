// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { click, reveal, inspect, openTool } from '../support/controls.mjs';
import { panel, expandSections, textButton, choose, Blocked, openMaskGroup } from '../support/scenario.mjs';
import { until } from '../support/webdriver.mjs';
import { settledPhoto, settledReset } from './smoke.mjs';

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
// The point curve has no sliders: its points (the hidden tonecurve-points
// panel) are edited only on this graph, so this case stands in for
// per-value control cases. Graph units: x 0..1 left to right, y 0..1 bottom
// to top.
const CURVE_MAX_NODES = 20; // MAX_NODES in app/src/tonecurve.ts
export async function curves(t) {
  // Reset All clears the New Photos preset by design: reset first, so the
  // closing Reset All can reproduce the baseline (as history does)
  const opened = await settledPhoto(t);
  await click(t, 'button[aria-label="reset all"]');
  try { await settledPhoto(t, q => q.hash !== opened.hash); } catch {}
  const baseline = await settledPhoto(t);
  const p = await panel(t, 'tonecurve');
  await textButton(t, `${p} .tabs`, 'Point');
  const svg = `${p} svg.point-curve`;
  const nodes = () => t.driver.observe(s => [...document.querySelectorAll(`${s} circle.pt`)]
    .map(c => [+c.getAttribute('cx') / 260, 1 - +c.getAttribute('cy') / 260]), svg);
  const count = n => until(async () => (await nodes()).length === n, `curve has ${n} points`, 5000);
  const at = async (x, y) => { const g = await reveal(t, svg);
    return { x: g.bounds.x + x * g.bounds.width, y: g.bounds.y + (1 - y) * g.bounds.height }; };
  const hashes = new Set();
  for (const channel of ['RGB','R','G','B']) {
    await textButton(t, `${p} .channels`, channel);
    await count(2);
    // drag from the middle: a click there adds a point, the drag lifts it
    await t.driver.drag(await at(.5, .5), await at(.5, .62)); await count(3);
    const edited = await settledPhoto(t, q => q.hash !== baseline.hash);
    hashes.add(edited.hash);
    const [, mid] = await nodes();
    t.measure({ name:channel, photoHash:edited.hash, point:mid }); await t.evidence(`curve-${channel}`);
    // a double-click on an inner point removes it
    const m = await at(...mid); await t.driver.point(m.x, m.y, 2); await count(2);
    await settledReset(t, baseline, edited, `${channel}-remove`);
  }
  assert.equal(hashes.size, 4, 'RGB and each color channel change the photo differently');

  await textButton(t, `${p} .channels`, 'RGB');
  // the end points move but stay: lift the black point, then drag it past the
  // graph's corner, where it clamps back to (0, 0)
  await t.driver.drag(await at(.01, .01), await at(.01, .2));
  const lifted = await settledPhoto(t, q => q.hash !== baseline.hash);
  assert.equal((await nodes()).length, 2, 'an end point is moved, not removed');
  await t.evidence('black-point-lifted');
  const corner = await at(.01, .2), g = await reveal(t, svg);
  await t.driver.drag(corner, { x: g.bounds.x - 20, y: g.bounds.y + g.bounds.height + 20 });
  await until(async () => { const [[x, y]] = await nodes(); return x === 0 && y === 0; }, 'black point back at its corner', 5000);
  await settledReset(t, baseline, lifted, 'black-point-corner');

  // fill the graph to its limit, alternating heights so each click lands
  // clear of its neighbors' hit radius
  const inner = CURVE_MAX_NODES - 2;
  for (let i = 1; i <= inner; i++) {
    const c = await at(i / (inner + 1), i % 2 ? .4 : .6);
    await t.driver.point(c.x, c.y); await count(2 + i);
  }
  const full = await settledPhoto(t, q => q.hash !== baseline.hash); await t.evidence('max-points');
  const gap = await at(.5, .9); await t.driver.point(gap.x, gap.y);
  await new Promise(r => setTimeout(r, 500));
  assert.equal((await nodes()).length, CURVE_MAX_NODES, `no point past the ${CURVE_MAX_NODES}-point limit`);
  // dragging an inner point well off the graph removes it
  const [, second] = await nodes(), s0 = await at(...second);
  await t.driver.drag(s0, { x: s0.x, y: g.bounds.y + g.bounds.height * 1.4 }); await count(CURVE_MAX_NODES - 1);
  t.measure({ name:'max-points', photoHash:full.hash, limit:CURVE_MAX_NODES });

  await click(t, 'button[aria-label="reset all"]'); await count(2);
  await settledReset(t, baseline, full, 'reset-all');
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
      const edited=await settledPhoto(t,q=>q.hash!==before.hash); await t.evidence(`${mode}-${i}`);
      await t.driver.point(point.x,point.y,2); await settledReset(t,before,edited,`${mode}-${i}-reset`);
    }
  }
}
export async function equalizer(t) {
  await preferences(t,'Modules'); await textButton(t,'.prefs','Custom');
  const fold='button[aria-controls="module-prefs-global"]';
  if(!await t.driver.observe(s=>document.querySelector(s)?.getAttribute('aria-expanded')==='true',fold)) await click(t,fold);
  const selector='select[aria-label="Global Contrast"]', menu=await reveal(t,selector);
  const option=menu.options.find(o=>o.label.includes('equalizer')); assert(option);
  // a folded section's body is unmounted: open them all to reach the graph
  await choose(t,selector,option.value); await textButton(t,'.prefs-foot','Done'); await expandSections(t,await panel(t,'basic'));
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
  // the Zone System works on black and white: convert first, back to color after
  await openTool(t,'adjust'); await textButton(t,await panel(t,'basic'),'B&W'); await settledPhoto(t);
  await openTool(t,'zones');
  await until(()=>t.driver.observe(()=>document.querySelectorAll('.zone-col').length>=10),'zone columns');
  const columns=await t.driver.observe(()=>document.querySelectorAll('.zone-col').length);
  for(let i=1;i<=columns;i++) {
    await click(t,`.zone-col:nth-of-type(${i})`);
    await until(()=>t.driver.observe(()=>!!document.querySelector('.zone-name')),'zone selected');
    await t.evidence(`zone-${i}`);
  }
  await openTool(t,'adjust'); await textButton(t,await panel(t,'basic'),'Color'); await settledPhoto(t);
}

export async function prepareNegative(t) {
  await openTool(t,'negative');
  if(await t.driver.observe(()=>!!document.querySelector('.neg-warn'))) await textButton(t,'.neg-warn','Continue');
  await textButton(t,'.negative','Pick Film Border');
  const c=await reveal(t,'.zone-object-box'); await t.driver.point(c.bounds.x+c.bounds.width*.02,c.bounds.y+c.bounds.height*.02);
  await until(()=>t.driver.observe(()=>!!document.querySelector('.neg-swatch')),'negative converted');
}
