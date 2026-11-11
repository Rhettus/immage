// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { click, reveal, inspect, openTool } from '../support/controls.mjs';
import { panel, expandSections, textButton, choose, Blocked, openMaskGroup, openStep } from '../support/scenario.mjs';
import { until, pause } from '../support/webdriver.mjs';
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
// a sampled frame's mean chroma (channel spread) and mean level
const tones = p => { let c = 0, l = 0; const n = p.rgba.length / 4;
  for (let i = 0; i < p.rgba.length; i += 4) { const [r, g, b] = [p.rgba[i], p.rgba[i + 1], p.rgba[i + 2]];
    c += Math.max(r, g, b) - Math.min(r, g, b); l += (r + g + b) / 3; }
  return { chroma: c / n, level: l / n }; };
export async function saturationCurve(t) {
  const baseline = await settledPhoto(t);
  await preferences(t, 'Modules'); await textButton(t, '.prefs', 'Custom');
  const fold = 'button[aria-controls="module-prefs-global"]';
  if (!await t.driver.observe(s => document.querySelector(s)?.getAttribute('aria-expanded') === 'true', fold)) await click(t, fold);
  const selector = 'select[aria-label="Global Saturation"]', menu = await reveal(t, selector);
  const option = menu.options.find(o => o.label.includes('saturation curve')); assert(option, 'saturation curve offered');
  await choose(t, selector, option.value); await textButton(t, '.prefs-foot', 'Done');
  const p = await panel(t, 'basic'); await expandSections(t, p);
  const svg = `${p} .saturation-curve svg.point-curve`;
  await reveal(t, svg);
  assert(!await t.driver.observe(s => !!document.querySelector(`${s} [data-control-id="saturation"]`), p),
    'the curve replaces the Saturation slider');
  const nodes = () => t.driver.observe(s => [...document.querySelectorAll(`${s} circle.pt`)]
    .map(c => [+c.getAttribute('cx') / 260, 1 - +c.getAttribute('cy') / 260]), svg);
  const count = n => until(async () => (await nodes()).length === n, `curve has ${n} points`, 5000);
  const at = async (x, y) => { const g = await reveal(t, svg);
    return { x: g.bounds.x + x * g.bounds.width, y: g.bounds.y + (1 - y) * g.bounds.height }; };
  const base = tones(baseline);
  for (const [value, name, metric] of [[0, 'Saturation', 'chroma'], [1, 'Brilliance', 'level']]) {
    await choose(t, 'select[aria-label="Saturation curve channel"]', value);
    await count(2);
    // lift the muted end: more saturation, or brighter colors, across the photo
    await t.driver.drag(await at(.01, .5), await at(.01, .8));
    const lifted = await settledPhoto(t, q => q.hash !== baseline.hash);
    assert.equal((await nodes()).length, 2, `${name}: an end point is moved, not removed`);
    const after = tones(lifted);
    t.measure({ name, photoHash: lifted.hash, before: base, after });
    assert(after[metric] > base[metric], `${name}: lifting the curve raises the photo's ${metric} (${base[metric]} -> ${after[metric]})`);
    await t.evidence(`satcurve-${name}`);
    // a drag from the middle adds a point; a double-click removes it
    await t.driver.drag(await at(.5, .5), await at(.5, .35)); await count(3);
    const [, mid] = await nodes(), m = await at(...mid);
    await settledPhoto(t, q => q.hash !== lifted.hash);
    await t.driver.point(m.x, m.y, 2); await count(2);
    await textButton(t, `${p} .saturation-curve .equalizer-heading`, 'Reset');
    await count(2);
    await settledReset(t, baseline, lifted, `${name}-reset`);
  }
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
// the steps of the Negative panel (GuidedSteps.tsx): the ones after the
// border are locked until it is picked, then open; Next and Back walk them
const stepState = t => t.driver.observe(() => Object.fromEntries([...document.querySelectorAll('.negative .step')]
  .map(e => [e.dataset.step, { open: e.classList.contains('open'), locked: e.classList.contains('locked') }])));
export async function negative(t) {
  if(t.fixture.name!=='negative') throw new Blocked('Use --fixture negative for conversion tests');
  const baseline=await settledPhoto(t);
  // before the border: only Profiles and Border can open
  const b=await reveal(t,'button[data-tour="negative"]');
  if(!b.active){
    await click(t,'button[data-tour="negative"]');
    const warned=await until(()=>t.driver.observe(()=>document.querySelector('.neg-warn')?'warn':document.querySelector('button[data-tour="negative"]:is(.on,.active)')?'open':''),'negative warning or tool',10000).catch(()=>'');
    // the dialog can render a frame after the button turns active
    if(warned==='warn'||await until(()=>t.driver.observe(()=>!!document.querySelector('.neg-warn')),'negative warning',3000).then(()=>true,()=>false)) await textButton(t,'.neg-warn','Continue');
  }
  await openTool(t,'negative');
  await until(()=>t.driver.observe(()=>!!document.querySelector('.negative .step')),'negative steps');
  let steps=await stepState(t);
  for(const id of ['base','color','tone','export']) assert(steps[id]?.locked,`${id} locked before the border is picked`);
  assert(await t.driver.observe(()=>document.querySelector('.negative .step[data-step="base"] .step-sum').textContent.includes('pick the film border first')),'lock note shown');
  await click(t,'.negative .step[data-step="base"] > .step-head');
  steps=await stepState(t);
  assert(!steps.base.open,'a locked step does not open');
  await prepareNegative(t);
  await settledPhoto(t,p=>p.hash!==baseline.hash); await t.evidence('converted');
  steps=await stepState(t);
  for(const id of ['base','color','tone','export']) assert(!steps[id].locked,`${id} unlocked after the border`);
  // a folded step opens by its heading, Next and Back walk the steps
  await openStep(t,'.negative','profiles');
  await textButton(t,'.negative .step.open','Next');
  await until(async()=>(await stepState(t)).border.open,'Next opens Border & Photo Area');
  await textButton(t,'.negative .step.open','Next');
  await until(async()=>(await stepState(t)).base.open,'Next opens Film Base');
  await textButton(t,'.negative .step.open','Back');
  await until(async()=>(await stepState(t)).border.open,'Back returns to Border & Photo Area');
  await openStep(t,'.negative','export');
  await textButton(t,'.positive-foot','Turn Off Conversion'); await settledPhoto(t,p=>p.hash===baseline.hash);
  steps=await stepState(t);
  assert(steps.base.locked,'steps lock again once the conversion is off');
}
// the Film Simulation panel: on, a preset, a stock and a paper by their
// preview tiles, the steps, then off again to the
// photo as it was. needs the data pack already installed: the case does not
// download it
// spektrafilm's stock hash, as spektrafilm.ts stockHash() has it
const stockHash=(stock)=>{
  let h=5381n;
  for(const b of new TextEncoder().encode(stock)) h=(((h<<5n)+h)^BigInt(b))&0xffffffffffffffffn;
  return Number((h^(h>>32n))&0xffffffffn)||1;
};
export async function film(t) {
  const baseline=await settledPhoto(t);
  await openTool(t,'film');
  await until(()=>t.driver.observe(()=>!!document.querySelector('.panel.film button, .panel.film select')),'film panel');
  if(await t.driver.observe(()=>[...document.querySelectorAll('.panel.film button')].some(b=>/Download Film Data|Try Again/.test(b.textContent))))
    throw new Blocked('Install the spektrafilm data pack first (Film Simulation, Download Film Data)');
  await textButton(t,'.panel.film','Turn On Film Simulation');
  const on=await settledPhoto(t,p=>p.hash!==baseline.hash); await t.evidence('simulated');
  const open=()=>t.driver.observe(()=>document.querySelector('.panel.film .step.open')?.dataset.step);
  const tiles=step=>`.panel.film .step[data-step="${step}"] .tile`;
  // the stock step is open first, with a tile selected
  await openStep(t,'.panel.film','stock');
  await until(()=>t.driver.observe(s=>!!document.querySelector(s),`${tiles('stock')}.on`),'a film tile selected');
  // the preset sets the film too
  await choose(t,'.panel.film [data-action="film-preset"]','film|portrait');
  await until(()=>t.driver.observe(s=>!!document.querySelector(s),
    `${tiles('stock')}.on[data-tile="film:${stockHash('kodak_portra_400')}"]`),'film|portrait selects the Kodak Portra 400 tile');
  await settledPhoto(t,p=>p.hash!==on.hash); await t.evidence('preset');
  // another film, by its tile
  const other=await t.driver.observe(s=>document.querySelector(`${s}:not(.on)`)?.dataset.tile,tiles('stock'));
  assert(other,'another film tile');
  await click(t,`${tiles('stock')}[data-tile=${JSON.stringify(other)}]`);
  await until(()=>t.driver.observe((s,k)=>!!document.querySelector(`${s}.on[data-tile=${JSON.stringify(k)}]`),tiles('stock'),other),'film tile chosen');
  await settledPhoto(t); await t.evidence('film-tile');
  // Next opens Paper (a negative film prints): a paper tile, then scanning
  await textButton(t,'.panel.film .step.open','Next');
  await until(async()=>await open()==='paper','Next opens Paper');
  const paper=await t.driver.observe(s=>[...document.querySelectorAll(`${s}:not(.on)`)].map(e=>e.dataset.tile).find(k=>!/:(0|-1)$/.test(k)),tiles('paper'));
  assert(paper,'a paper tile');
  await click(t,`${tiles('paper')}[data-tile=${JSON.stringify(paper)}]`);
  await until(()=>t.driver.observe((s,k)=>!!document.querySelector(`${s}.on[data-tile=${JSON.stringify(k)}]`),tiles('paper'),paper),'paper tile chosen');
  await settledPhoto(t); await t.evidence('paper-tile');
  const hasColor=()=>t.driver.observe(()=>!!document.querySelector('.panel.film .step[data-step="color"]'));
  assert(await hasColor(),'Color step listed while printing');
  await click(t,`${tiles('paper')}[data-tile$=":-1"]`);
  await until(async()=>!await hasColor(),'Color step hidden when scanning');
  // Back returns to Stock, a folded step opens by its heading
  await textButton(t,'.panel.film .step.open','Back');
  await until(async()=>await open()==='stock','Back returns to Stock');
  await pause(600); // the Stock step finishes folding, so Grain's heading stops moving
  await openStep(t,'.panel.film','grain');
  assert.equal(await open(),'grain','a folded step opens by its heading');
  await textButton(t,'.positive-foot','Turn Off Film Simulation'); await settledPhoto(t,p=>p.hash===baseline.hash);
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
  // the tool opens only after its warning is confirmed, so answer that first
  const b=await reveal(t,'button[data-tour="negative"]');
  if(!b.active){
    await click(t,'button[data-tour="negative"]');
    const warned=await until(()=>t.driver.observe(()=>document.querySelector('.neg-warn')?'warn':document.querySelector('button[data-tour="negative"]:is(.on,.active)')?'open':''),'negative warning or tool',10000).catch(()=>'');
    // the dialog can render a frame after the button turns active
    if(warned==='warn'||await until(()=>t.driver.observe(()=>!!document.querySelector('.neg-warn')),'negative warning',3000).then(()=>true,()=>false)) await textButton(t,'.neg-warn','Continue');
  }
  await openTool(t,'negative');
  await openStep(t,'.negative','border');
  await textButton(t,'.negative','Pick Film Border');
  const c=await reveal(t,'.zone-object-box'); await t.driver.point(c.bounds.x+c.bounds.width*.02,c.bounds.y+c.bounds.height*.02);
  await until(()=>t.driver.observe(()=>!!document.querySelector('.neg-swatch')),'negative converted');
}

// the Print panel: soft proof and gamut warning against a made-up narrow
// printer profile (support/icc.mjs, which run.mjs puts in the engine's
// profiles), S turning the proof off and on, the proof staying on in
// Adjustments, and the page laid out in the viewer: orientation, margins,
// size and place, with the photo rendered inside the printable area.
// prints nothing: Print and Save PDF open native dialogs or a real printer,
// and verify/print.py checks the PDF the engine writes
const PRINT_PROFILE = 'immage-test-narrow.icc';
const chromaOf = p => { let c = 0; for (let i = 0; i < p.rgba.length; i += 4)
  c += Math.max(p.rgba[i], p.rgba[i + 1], p.rgba[i + 2]) - Math.min(p.rgba[i], p.rgba[i + 1], p.rgba[i + 2]);
  return c / (p.rgba.length / 4); };
const cyanOf = p => { let n = 0; for (let i = 0; i < p.rgba.length; i += 4)
  if (p.rgba[i] < 40 && p.rgba[i + 1] > 200 && p.rgba[i + 2] > 200) n++; return n; };
// the page in the viewer, and the photo's rectangle on it, in CSS pixels
const pageView = t => t.driver.observe(() => {
  const box = s => { const r = document.querySelector(s)?.getBoundingClientRect(); return r && { x: r.x, y: r.y, w: r.width, h: r.height }; };
  const sheet = box('.viewer .print-sheet');
  return sheet ? { sheet, area: box('.viewer .print-area'), photo: box('.viewer .after-pane canvas.layer.sharp'),
                   size: document.querySelector('.panel.print .print-size')?.textContent ?? '' } : null; });
const inside = (a, b, slack = 3) => a.x >= b.x - slack && a.y >= b.y - slack
  && a.x + a.w <= b.x + b.w + slack && a.y + a.h <= b.y + b.h + slack;
export async function print(t) {
  await openTool(t, 'print');
  await until(async () => !!(await pageView(t)), 'the page in the viewer', 20000);
  // the photo as the page shows it, before any proof
  const baseline = await settledPhoto(t);
  const profileMenu = '.panel.print select[data-action="print-profile"]';
  await until(() => t.driver.observe(s => [...(document.querySelector(s)?.options ?? [])]
    .some(o => o.value.endsWith('/immage-test-narrow.icc') || o.value.endsWith('\\immage-test-narrow.icc')), profileMenu),
    'the seeded printer profile listed', 20000);
  const printers = '.panel.print select[data-action="print-printer"]';
  await until(() => t.driver.observe(s => !!document.querySelector(s)?.querySelector('option[value=""]'), printers), 'Save as PDF offered');
  await choose(t, printers, '');
  const file = await t.driver.observe((s, name) => [...document.querySelector(s).options]
    .find(o => o.value.endsWith(name))?.value, profileMenu, PRINT_PROFILE);
  await choose(t, profileMenu, file);
  await until(() => t.driver.observe(() => !document.querySelector('input[data-action="print-softproof"]')?.disabled), 'Soft Proof enabled');
  { const v = await pageView(t);
    assert(v.area && v.photo && inside(v.photo, v.area), `the photo inside the printable area: ${JSON.stringify(v)}`); }
  await t.evidence('print-panel');

  // soft proof: the photo as the narrow printer prints it, duller, with the badge
  await click(t, 'input[data-action="print-softproof"]');
  const proofed = await settledPhoto(t, p => p.hash !== baseline.hash);
  assert(chromaOf(proofed) < chromaOf(baseline), `proof pulls color in: ${chromaOf(baseline)} -> ${chromaOf(proofed)}`);
  assert(!await t.driver.observe(() => !!document.querySelector('[data-proof-badge]')),
         'no badge in the Print panel, which already names the profile');
  await t.evidence('soft-proof');
  // gamut warning: what the printer can't reach painted cyan
  await click(t, 'input[data-action="print-gamut"]');
  const gamut = await settledPhoto(t, p => p.hash !== proofed.hash);
  assert(cyanOf(gamut) > cyanOf(proofed), `gamut warning paints cyan: ${cyanOf(proofed)} -> ${cyanOf(gamut)}`);
  await t.evidence('gamut-warning');
  await click(t, 'input[data-action="print-gamut"]');
  await settledPhoto(t, p => p.hash === proofed.hash);

  // S turns it off, to the photo as it was, and on again
  await t.driver.keys('s');
  await settledPhoto(t, p => p.hash === baseline.hash);
  await t.driver.keys('s');
  await settledPhoto(t, p => p.hash === proofed.hash);
  // the proof stays on in another panel, with the badge naming the profile
  await openTool(t, 'adjust');
  assert(await t.driver.observe(() => /Immage test narrow printer/.test(document.querySelector('[data-proof-badge]')?.textContent ?? '')),
         'proof kept in Adjustments, the badge naming the profile');
  await openTool(t, 'print');

  // layout: the page turns, a margin and the size change the photo's print size, a place is chosen
  const page = async () => { const v = await pageView(t); return v && { width: v.sheet.w, height: v.sheet.h, size: v.size }; };
  await textButton(t, '.panel.print', 'Portrait');
  await until(async () => { const p = await page(); return p && p.height > p.width; }, 'a portrait page');
  await textButton(t, '.panel.print', 'Landscape');
  await until(async () => { const p = await page(); return p && p.width > p.height; }, 'a landscape page');
  await textButton(t, '.panel.print', 'mm');
  const before = (await page()).size;
  await click(t, '.panel.print input[data-margin="left"]');
  await t.driver.chord('', 'a'); await t.driver.keys('6', '0');
  await until(async () => (await page()).size !== before, 'a wider left margin changes the print size');
  await textButton(t, '.panel.print', 'Custom');
  await until(() => t.driver.observe(() => !!document.querySelector('.panel.print input[data-margin="size"]')), 'the long edge field');
  await click(t, '.viewer .print-align button:nth-child(1)');
  await until(() => t.driver.observe(() => document.querySelector('.viewer .print-align button:nth-child(1)')?.classList.contains('on')),
              'top left chosen');
  await settledPhoto(t);
  await until(async () => { const v = await pageView(t);
    return v?.area && v.photo && inside(v.photo, v.area) && Math.abs(v.photo.x - v.area.x) <= 3 && Math.abs(v.photo.y - v.area.y) <= 3; },
    'the photo at the top left of the printable area');
  assert(await t.driver.observe(() => /Save PDF/.test(document.querySelector('button[data-action="print-go"]')?.textContent ?? '')
    && !document.querySelector('button[data-action="print-go"]').disabled), 'Save PDF ready');
  await t.evidence('layout');

  // off from the panel: the photo unproofed again, at its new place and size
  const placed = await settledPhoto(t);
  await click(t, 'input[data-action="print-softproof"]');
  await settledPhoto(t, p => p.hash !== placed.hash);
  // leaving the panel puts the photo back over the whole viewer
  await openTool(t, 'adjust');
  await until(async () => !(await pageView(t)), 'the page gone in Adjustments');

  // Cells layout: the selected photos on a grid, filenames under them, a custom size and border
  await click(t, 'button[title^="grid view"]'); await t.driver.chord('\uE009', 'a');
  await openTool(t, 'print');
  await click(t, 'button[data-action="print-layout-cells"]');
  // choosing Cells leaves the grid, which would cover the sheet; the selection stays
  const cells = () => t.driver.observe(() => { const e = document.querySelector('.viewer .print-sheet[data-print-cells]');
    return e ? { grid: e.dataset.printCells, cells: e.querySelectorAll('.print-cell:not(.empty)').length,
                 labels: [...e.querySelectorAll('.print-label')].map(l => l.textContent) } : null; });
  await until(async () => (await cells())?.cells >= 2, 'the selected photos placed in cells');
  const sheet1 = await cells();
  assert(sheet1.labels.length === sheet1.cells && sheet1.labels.every(Boolean), `a filename under every photo: ${JSON.stringify(sheet1)}`);
  assert(await t.driver.observe(() => { const e = document.querySelector('.viewer .after-pane');
    return !e || getComputedStyle(e).visibility === 'hidden'; }),
    'the edit pane is hidden while the Cells layout shows');
  await t.evidence('cells');
  // soft proof reaches the cells: their pixels change with it on, and come back off
  const cellSum = () => t.driver.observe(() => { const c = document.querySelector('.viewer .print-cell canvas');
    if (!c) return 0; const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 0; i < d.length; i += 4) n += d[i] * 3 + d[i + 1] * 5 + d[i + 2]; return n; });
  await until(async () => (await cellSum()) > 0, 'a cell thumbnail drawn', 30000);
  const cellBefore = await cellSum();
  await click(t, 'input[data-action="print-softproof"]');
  await until(async () => (await cellSum()) !== cellBefore, 'the cells soft proofed');
  await t.evidence('cells-proofed');
  await click(t, 'input[data-action="print-softproof"]');
  await until(async () => (await cellSum()) === cellBefore, 'the cells unproofed again');
  await click(t, 'input[data-action="print-names"]');
  await until(async () => (await cells())?.labels.length === 0, 'filenames off');
  await click(t, 'input[data-action="print-names"]');
  await until(async () => (await cells())?.labels.length === sheet1.cells, 'filenames on again');
  await click(t, 'button[data-action="print-cells-custom"]');
  await until(async () => (await cells())?.cells >= 2, 'a custom cell count keeps the photos');
  assert(await t.driver.observe(() => /photos? on \d+ pages?/.test(document.querySelector('.panel.print [data-print-cells]')?.textContent ?? '')),
    'the panel counts photos and pages');
  assert(await t.driver.observe(() => /Save PDF/.test(document.querySelector('button[data-action="print-go"]')?.textContent ?? '')
    && !document.querySelector('button[data-action="print-go"]').disabled), 'Save PDF ready for the sheet');
  await t.evidence('cells-custom');
  await click(t, 'button[data-action="print-layout-single"]');
  await until(async () => !(await cells()), 'the Cells sheet gone in Single Photo');
}
