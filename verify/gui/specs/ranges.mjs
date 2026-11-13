// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { inspect, click, reveal, rangeSelector, openTool } from '../support/controls.mjs';
import { Blocked, panel, expandSections, textButton, choose, openStep } from '../support/scenario.mjs';
import { until } from '../support/webdriver.mjs';
import { settledPhoto, settledReset } from './smoke.mjs';

export async function locateControl(t, definition) {
  const { panel: id, section, control } = definition;
  if (control.rawOnly && !t.fixture.raw) throw new Blocked(`${control.id} requires an approved RAW fixture`);
  let p;
  if (definition.scope === 'local') {
    await openTool(t, 'masks');
    if (!await t.driver.observe(() => !!document.querySelector('.mask-list li.on'))) {
      await click(t,'.create-mask'); await textButton(t,'.shape-menu-list','Radial Gradient');
      const svg=await reveal(t,'svg.mask-svg');
      await t.driver.drag({x:svg.x-svg.bounds.width*.1,y:svg.y-svg.bounds.height*.1},{x:svg.x+svg.bounds.width*.1,y:svg.y+svg.bounds.height*.1});
    }
    await until(() => t.driver.observe(() => !!document.querySelector('.mask-list li.on')
      && !!document.querySelector('[data-mask-group="Presence"]')), 'selected mask adjustments mounted');
    const group = /^l_(temp|tint)$/.test(control.id) ? 'White Balance'
      : /^(ce_|l_(exposure|contrast|fulcrum|highlights|shadows|whites|blacks)$)/.test(control.id) ? 'Tone'
      : control.id.startsWith('l_hsl') ? 'HSL' : control.id.startsWith('l_cg') ? 'Color Grading'
      : /^l_(sharpness|usm|noise|defringe)/.test(control.id) ? 'Detail' : 'Presence';
    const heading=`[data-mask-group=${JSON.stringify(group)}]`;
    // a new mask folds its settings card as it opens, moving the groups up
    // under a click aimed a moment before: click until the group is open
    await until(async()=>{
      const state=await t.driver.observe(s=>{const h=document.querySelector(s);return h&&{open:!h.querySelector('.chevron:not(.open)')};},heading);
      if(!state)return false;
      if(state.open)return true;
      await click(t,heading); return false;
    },`${group} group open`);
    p='.masks-panel';
    if (group === 'HSL') {
      const tab = control.id.startsWith('l_hsl_sat_') ? 'Saturation'
        : control.id.startsWith('l_hsl_lum_') ? 'Luminance' : 'Hue';
      await textButton(t, `${p} .segmented.tabs`, tab);
    }
    if (group === 'Color Grading') await textButton(t, `${p} .segmented.tabs`, 'Sliders');
  } else if (id === 'negative') {
    if (t.fixture.name !== 'negative') throw new Blocked('Negative controls require --fixture negative');
    const { prepareNegative } = await import('./workflows.mjs'); await prepareNegative(t); p='.negative';
  } else {
    // the B&W Mix panel shows only in B&W treatment
    await openTool(t, 'adjust');
    if (id === 'bw') { await textButton(t, await panel(t, 'basic'), 'B&W'); await settledPhoto(t); }
    p = await panel(t, id);
  }
  // the Region and Split Point sliders are the Parametric curve's, and
  // their sections mount folded when it is chosen: choose it first
  if (id === 'tonecurve') await textButton(t, `${p} .tabs`, 'Parametric');
  await expandSections(t, p);
  if (id === 'hsl') await textButton(t, `${p} .tabs`, section);
  if (id === 'colorgrading') await textButton(t, `${p} .tabs`, 'Sliders');
  const selector = `${p} [data-control-id=${JSON.stringify(control.id)}]`;
  // advanced controls (Clarity's and Texture's coarse bands, Whites' Highlight
  // Brilliance, Negative and Film's) are not mounted until the panel's
  // Advanced toggle is on; the toggle is remembered, so restoreAdvanced puts it back
  // Negative's controls sit in steps (GuidedSteps.tsx), one open at a time:
  // open the unlocked steps in turn until the control mounts
  if ((id === 'negative' || id === 'film') && !await t.driver.observe(s => !!document.querySelector(s), selector)) {
    const ids = await t.driver.observe(c => [...document.querySelectorAll(`.${c} .step:not(.locked)`)].map(e => e.dataset.step), id);
    for (const step of ids) {
      await openStep(t, p, step);
      if (await t.driver.observe(s => !!document.querySelector(s), selector)) break;
    }
  }
  if (!await t.driver.observe(s => !!document.querySelector(s), selector)) {
    const toggle = definition.scope === 'local' ? '.masks-panel .panel-title.adj-title [data-advanced-toggle]'
      : `${p} > .panel-title [data-advanced-toggle]`;
    // no toggle: the module or treatment that has this control is not chosen
    if (await t.driver.observe(s => document.querySelector(s)?.getAttribute('aria-pressed') === 'false', toggle)) {
      (t.advancedOn ??= []).push(toggle);
      await click(t, toggle);
      await until(() => t.driver.observe(s => !!document.querySelector(s), selector), `${control.id} Advanced on`).catch(() => {});
    }
  }
  if (!await t.driver.observe(s => !!document.querySelector(s), selector))
    throw new Blocked(`${control.id} needs its module, treatment or graph branch; run the matching module/graph case`);
  return selector;
}
// turn back off the Advanced toggles a case switched on
export async function restoreAdvanced(t) {
  const on = t.advancedOn ?? []; t.advancedOn = [];
  for (const toggle of on.reverse())
    if (await t.driver.observe(s => document.querySelector(s)?.getAttribute('aria-pressed') === 'true', toggle)) {
      await click(t, toggle);
      await until(() => t.driver.observe(s => document.querySelector(s)?.getAttribute('aria-pressed') === 'false', toggle), 'Advanced off');
    }
}
// a control owned by one option of a module choice (contrast equalizer,
// contrast & texture, diffuse or sharpen) shows only while that module is
// chosen: choose it in Preferences first, and put the choice back after
async function withTemporaryMask(t, run) {
  await openTool(t, 'masks');
  const previousCount = await t.driver.observe(() => document.querySelectorAll('.mask-list li').length);
  await click(t, '.create-mask'); await textButton(t, '.shape-menu-list', 'Radial Gradient');
  const svg = await reveal(t, 'svg.mask-svg');
  await t.driver.drag({ x: svg.x - svg.bounds.width * .1, y: svg.y - svg.bounds.height * .1 },
                      { x: svg.x + svg.bounds.width * .1, y: svg.y + svg.bounds.height * .1 });
  const name = await until(() => t.driver.observe(count => {
    const rows = [...document.querySelectorAll('.mask-list li')];
    return rows.length > count ? document.querySelector('.mask-list li.on .name')?.textContent : false;
  }, previousCount), 'temporary mask selected');
  const baseline = await settledPhoto(t);
  let value, failure;
  try { value = await run(); } catch (e) { failure = e; }
  try {
    const selected = await t.driver.observe(() => document.querySelector('.mask-list li.on .name')?.textContent);
    if (selected === name) {
      // the row's × shows only on hover, and an advanced control opened in
      // run() can scroll the row out of view: bring it back and hover it
      const row = await reveal(t, '.mask-list li.on .name');
      await t.driver.point(row.x, row.y, 2);
      await click(t, '.mask-list li.on .mask-del');
      await until(() => t.driver.observe((n) => document.querySelectorAll('.mask-list li').length === n, previousCount),
                  'temporary mask removed');
      await settledReset(t, baseline, null, 'temporary-mask-cleanup');
    }
  } catch (e) { failure ??= e; }
  if (failure) throw failure;
  return value;
}

async function withModule(t, definition, run) {
  const m = definition.module;
  if (!m) return run();
  const { chooseModule } = await import('./modules.mjs');
  const scope = m.scope ?? 'global';
  const scoped = () => scope === 'masks' && definition.scope === 'local' ? withTemporaryMask(t, run) : run();
  const previous = await chooseModule(t, scope, m.label, m.value);
  if (String(previous) === String(m.value)) return scoped();
  try { return await scoped(); }
  finally { await chooseModule(t, scope, m.label, previous); }
}
const withAdvanced = async (t, run) => { try { return await run(); } finally { await restoreAdvanced(t); } };
export const rangeContract = (t, definition) => withModule(t, definition, () => withAdvanced(t, () =>
  /^ce_\d_\d$/.test(definition.control.id) ? equalizerBand(t, definition) : rangeBody(t, definition)));
export const choiceContract = (t, definition) => withModule(t, definition, () => withAdvanced(t, () => choiceBody(t, definition)));
const prerequisiteFor = id => {
  if (/^vig_(midpoint|roundness|feather)$/.test(id)) return 'vig_amount';
  if (id === 'grain_size') return 'grain_amount';
  if (/^(l_)?detail_(texture|clarity)_(detail_level|halo_control|noise_bias)$/.test(id)) return id.replace(/_(detail_level|halo_control|noise_bias)$/, '_gain_coarse');
  if (id === 'tc_split1') return 'tc_shadows';
  if (id === 'tc_split2') return 'tc_lights';
  if (id === 'tc_split3') return 'tc_highlights';
  const hue=/^(l_)?cg_(shadows|midtones|highlights|global)_hue$/.exec(id);
  if(hue)return `${hue[1]||''}cg_${hue[2]}_sat`;
  if (/^(l_)?sharp_(radius|sensitivity)$/.test(id)) return `${id.startsWith('l_')?'l_':''}sharp_amount`;
  if (/^(l_)?usm_(radius|threshold)$/.test(id)) return `${id.startsWith('l_')?'l_':''}usm_amount`;
  if (/^(l_)?nr_detail$/.test(id)) return `${id.startsWith('l_')?'l_':''}nr_luminance`;
  if (id === 'defringe_radius') return 'defringe_amount';
  if (id === 'whites_brilliance') return 'whites';
  if (/^(hp_strength|hp_threshold)$/.test(id)) return 'hp_enable';
  if (id === 'lens_ca') return 'lens_profile';
  return null;
};
async function editRangeValue(t, input, value, name) {
  const container=input.replace(/\sinput\[type=range\]$/,'');
  const field=await reveal(t,`${container} .value`);
  await t.driver.point(field.x,field.y,2);
  await until(()=>t.driver.observe(s=>!!document.querySelector(`${s} .value-edit`),container),`${name} value editor`);
  await t.driver.keys(...String(value)); await t.driver.keys('\uE007');
  const current=await reveal(t,input);
  await until(async()=>Math.abs(+(await t.driver.observe(inspect,input)).value-value)<=(+current.step||.001),`${name} numeric edit`);
}
async function prepareEffectPrerequisite(t, definition) {
  const id=definition.control.id==='sharp_masking'
    ? await t.driver.observe(() => ['usm_amount','sharp_amount'].find(id =>
      document.querySelector(`[data-control-id="${id}"] input[type=range]`)))
    : prerequisiteFor(definition.control.id);
  if(!id) return null;
  const root=definition.scope==='local'?'.masks-panel':await panel(t,definition.panel);
  const selector=`${root} [data-control-id=${JSON.stringify(id)}]`;
  const checkbox=await t.driver.observe(s=>!!document.querySelector(`${s} input[type=checkbox]`),selector);
  if(checkbox){
    const input=`${selector} input[type=checkbox]`, initial=await reveal(t,input), baseline=await settledPhoto(t);
    const restore=async(enabled)=>{if(!initial.checked&&(await t.driver.observe(inspect,input)).checked){await click(t,input);await until(async()=>!(await t.driver.observe(inspect,input)).checked,`${id} restored`);if(enabled)await settledReset(t,baseline,enabled,`${id}-restore`);}};
    try{
      if(!initial.checked){await click(t,input);await until(async()=>!!(await t.driver.observe(inspect,input)).checked,`${id} effect enabled`);}
      const enabled=await settledPhoto(t);
      return {id,baseline,enabled,restore:async()=>restore(enabled)};
    }catch(e){try{await restore(null);}catch(cleanup){e.cleanupError=cleanup.message;}throw e;}
  }
  const input=`${selector} input[type=range]`, initial=await reveal(t,input), value=+initial.value;
  const baseline=await settledPhoto(t), target=+initial.min+(+initial.max-+initial.min)*.75;
  const restore=async(enabled)=>{
    const current=await reveal(t,input);
    if(Math.abs(+current.value-value)>(+current.step||.001)){
      await editRangeValue(t,input,value,`${id} restore`);
      if(enabled)await settledReset(t,baseline,enabled,`${id}-restore`);
    }
  };
  try{
    if(Math.abs(value-target)>=(+initial.step||.001)){
      await editRangeValue(t,input,target,`${id} effect prerequisite`);
    }
    const enabled=await settledPhoto(t);
    const activationExpected=value===0||value<=+initial.min+(+initial.step||.001);
    return {id,baseline,enabled,activationExpected,activationChanged:enabled.hash!==baseline.hash,restore:async()=>restore(enabled)};
  }catch(e){try{await restore(null);}catch(cleanup){e.cleanupError=cleanup.message;}throw e;}
}
async function rangeBody(t, definition) {
  const container = await locateControl(t, definition), selector = `${container} input[type=range]`;
  let s = await reveal(t, selector);
  if (s.disabled) throw new Blocked(`Disabled ${definition.control.id}: fixture/module prerequisite`);
  const label = await reveal(t, `${container} label`);
  await t.driver.point(label.x, label.y, 2);
  const vignetteSecondary = /^vig_(midpoint|roundness|feather)$/.test(definition.control.id);
  let prerequisite=null;
  let primaryFailure;
  try {
  prerequisite=await prepareEffectPrerequisite(t,definition);
  if(prerequisite?.activationExpected)assert(prerequisite.activationChanged,`${prerequisite.id} activates rendered effect`);
  if(vignetteSecondary){const amount=await reveal(t,`${await panel(t,'effects')} [data-control-id="vig_amount"] input[type=range]`);assert(Math.abs(+amount.value)>0,'vignette secondary control requires nonzero Amount');}
  const baseline = await settledPhoto(t);
  s = await reveal(t, selector); const neutral = +s.value;
  const at = v => ({ x: s.bounds.x + 8 + (s.bounds.width - 16) * (v - s.min) / (s.max - s.min), y: s.y });
  let renderedChanged = false;
  // Coarse sliders still need an actual edit: 8% can be less than one step.
  const dragDistance = Math.max(s.step || .001, (s.max - s.min) * .08);
  for (const sign of [-1, 1]) {
    const target = Math.min(s.max, Math.max(s.min, neutral + sign * dragDistance));
    if (Math.abs(target - neutral) < (s.step || .001)) continue;
    await t.driver.drag(at(+(await t.driver.observe(inspect, selector)).value), at(target));
    const changed = await until(async () => { const c = await t.driver.observe(inspect, selector); return Math.abs(+c.value - neutral) >= (s.step || .001) && c; }, 'pointer range change');
    const photo = await settledPhoto(t);
    if (photo.hash !== baseline.hash) renderedChanged = true;
    t.measure({ name: `drag-${sign}`, value: changed.value, displayed: changed.displayed, photoChanged: photo.hash !== baseline.hash, css: changed.css });
    await t.evidence(`drag-${sign}`);
  }
  const stateOnly=definition.control.id==='lens_ca'&&!t.fixture.raw;
  // A secondary effect can have no quantized output at small settings. Probe
  // the full supported range before deciding this fixture shows no effect.
  if (!renderedChanged && !stateOnly) for (const [name, endpoint] of [['minimum', +s.min], ['maximum', +s.max]]) {
    s = await reveal(t, selector);
    await t.driver.drag(at(+s.value), at(endpoint));
    const changed = await until(async () => {
      const c = await t.driver.observe(inspect, selector);
      // a pointer lands within a pixel or two of the track end: on a 360 degree
      // range that is a couple of steps, so allow one percent of the range
      return Math.abs(+c.value - endpoint) <= Math.max(s.step || .001, (s.max - s.min) * .01) && c;
    }, `pointer range ${name}`);
    const photo = await settledPhoto(t);
    renderedChanged ||= photo.hash !== baseline.hash;
    t.measure({ name: `endpoint-${name}`, value: changed.value, displayed: changed.displayed,
      photoChanged: photo.hash !== baseline.hash, css: changed.css });
    await t.evidence(`endpoint-${name}`);
  }
  if(!stateOnly)assert(renderedChanged,`${definition.control.id} changes rendered pixels with its effect enabled`);
  else t.measure({name:'render-effect',status:'unverified',reason:'configured JPEG does not guarantee a matched lens profile for chromatic-aberration rendering'});
  // Native keyboard range limits and step, including nonlinear position ranges.
  await click(t, selector); await t.driver.keys('\uE011'); // Home
  // a mapped track (Temp's Kelvin) may land within a step of its end
  await until(async () => Math.abs(+(await t.driver.observe(inspect, selector)).value - s.min) <= (s.step || .001), 'Home minimum');
  const home = +(await t.driver.observe(inspect, selector)).value;
  await t.driver.keys('\uE014');
  // read once the key has moved it: an immediate read can race the update
  const step = await until(async () => { const v = +(await t.driver.observe(inspect, selector)).value; return v !== home && { v }; }, 'ArrowRight moves')
    .then(r => r.v, async () => +(await t.driver.observe(inspect, selector)).value);
  assert(Math.abs(step - Math.min(s.max, s.min + s.step)) < Math.max(1e-6, s.step / 100),
    `ArrowRight follows declared track step: ${home} -> ${step}, expected ${Math.min(s.max, s.min + s.step)}`);
  await t.driver.keys('\uE010');
  await until(async () => Math.abs(+(await t.driver.observe(inspect, selector)).value - s.max) <= (s.step || .001), 'End maximum')
    .catch(async e => { const c = await t.driver.observe(inspect, selector);
      throw Error(`End maximum: track ${c.value} (shows ${c.displayed}), expected ${s.max}; ${e.message}`); });
  await t.evidence('keyboard-limits');
  // Typed maximum clamping and Escape cancellation observe track position for
  // nonlinear sliders rather than comparing track positions with display units.
  const edit = async text => {
    const v = await reveal(t, `${container} .value`); await t.driver.point(v.x, v.y, 2);
    await until(() => t.driver.observe(s => !!document.querySelector(`${s} .value-edit`), container), 'value editor');
    await t.driver.keys(...String(text));
  };
  const min = definition.control.min, max = definition.control.max;
  await edit(min - Math.max(1, Math.abs(min) * 2)); await t.driver.keys('\uE007');
  await until(async () => Math.abs(+(await t.driver.observe(inspect, selector)).value - s.min) <= s.step, 'typed minimum clamp');
  await edit(max + Math.max(1, Math.abs(max) * 2)); await t.driver.keys('\uE007');
  await until(async () => Math.abs(+(await t.driver.observe(inspect, selector)).value - s.max) <= s.step, 'typed maximum clamp');
  await edit(definition.control.min); await t.driver.keys('\uE00C'); // Escape
  await until(async () => Math.abs(+(await t.driver.observe(inspect, selector)).value - s.max) <= s.step, 'Escape preserves previous value');
  const reset = await reveal(t, `${container} label`); await t.driver.point(reset.x, reset.y, 2);
  await until(async () => Math.abs(+(await t.driver.observe(inspect, selector)).value - neutral) <= s.step, 'double-click reset');
  await settledReset(t, baseline, null, 'reset'); await t.evidence('reset');
  } catch(e) {
    primaryFailure=e; throw e;
  } finally {
    try { await prerequisite?.restore(); }
    catch(cleanup) { if(primaryFailure) primaryFailure.cleanupError=cleanup.message; else throw cleanup; }
  }
}

async function equalizerBand(t, definition) {
  const [, channel, band] = /^ce_(\d)_(\d)$/.exec(definition.control.id);
  let root;
  if (definition.scope === 'local') {
    await openTool(t, 'masks');
    root = '.masks-panel';
    const heading = `[data-mask-group=${JSON.stringify('Tone')}]`;
    await until(async () => {
      if (!await t.driver.observe(s => !!document.querySelector(`${s} .chevron:not(.open)`), heading)) return true;
      await click(t, heading); return false;
    }, 'Tone group open');
  } else {
    await openTool(t, 'adjust');
    root = await panel(t, 'basic');
    await expandSections(t, root);
  }
  const menu = `${root} select[aria-label="Equalizer channel"]`;
  await choose(t, menu, channel);
  const selector = `${root} .equalizer-graph circle[role="slider"]:nth-of-type(${+band + 1})`;
  const point = await reveal(t, selector);
  const disabled = await t.driver.observe(s => document.querySelector(s)?.getAttribute('aria-disabled') === 'true', selector);
  if (disabled) throw new Blocked(`${definition.control.id} needs the matching contrast equalizer module`);
  const value = () => t.driver.observe(s => {
    const raw = document.querySelector(s)?.getAttribute('aria-valuenow');
    return raw === null || raw === undefined ? null : Number(raw);
  }, selector);
  const initial = await value();
  assert(Number.isFinite(initial), `${definition.control.id} exposes its current graph value`);
  const neutral = Number(channel) < 3 ? .5 : 0;
  assert(Math.abs(initial - neutral) < .001, `${definition.control.id} begins at its neutral value`);
  const baseline = await settledPhoto(t);
  const key = initial <= .99 ? '\uE013' : '\uE015';
  const reverse = initial <= .99 ? '\uE015' : '\uE013';
  await t.driver.point(point.x, point.y); await t.driver.keys('\uE011'); // pointer focuses; Home removes its coordinate quantization
  await until(async () => Math.abs(await value() - neutral) < .001, 'equalizer graph neutral restored');
  await settledReset(t, baseline, null, 'graph-focus-home');
  await t.driver.keys(key);
  const changed = await until(async () => { const v = await value(); return Math.abs(v - initial) >= .009 && v; }, 'equalizer graph keyboard change');
  const frame = await settledPhoto(t);
  t.measure({ name: `equalizer-${channel}-${band}`, initial, value: changed, photoChanged: frame.hash !== baseline.hash });
  await t.evidence(`equalizer-${channel}-${band}`);
  await t.driver.keys(reverse);
  await until(async () => Math.abs(await value() - neutral) < .001, 'equalizer graph value restored');
  await settledReset(t, baseline, frame, 'equalizer-reset');
}

async function choiceBody(t, definition) {
  const container = await locateControl(t, definition);
  // LensPicker is a searchable menu, not a segmented choice or a native
  // select. Exercise one available lens and restore Auto, matching the
  // dedicated raw workflow's value contract without requiring a camera RAW.
  if (definition.control.id === 'lens_pick') {
    const button = `${container} .lens-button`, options = '.lens-list button[role="option"]';
    const profile = `${container.replace(/ \[data-control-id="lens_pick"\]$/, '')} [data-control-id="lens_profile"] input[type=checkbox]`;
    const profileInitial = await reveal(t, profile);
    if (!profileInitial.checked) {
      await click(t, profile);
      await until(async () => (await t.driver.observe(inspect, profile)).checked, 'enable lens corrections for the LensPicker');
    }
    const initial = (await t.driver.observe(inspect, button)).text;
    await click(t, button);
    await until(() => t.driver.observe(s => !!document.querySelector(s), '.lens-menu'), 'lens picker opens');
    const names = await t.driver.observe(s => [...document.querySelectorAll(s)].map(b => b.textContent.trim()), options);
    const selected = names.find(n => /^Auto/.test(n)), candidate = names.find(n => !/^Auto/.test(n));
    assert(selected && candidate, `LensPicker offers Auto and a lens: ${names.length} options`);
    await textButton(t, '.lens-list', candidate);
    await until(async () => (await t.driver.observe(inspect, button)).text === candidate, 'lens choice is displayed');
    await t.evidence('lens-choice');
    await click(t, button);
    await until(() => t.driver.observe(s => !!document.querySelector(s), '.lens-menu'), 'lens picker reopens');
    await textButton(t, '.lens-list', selected);
    await until(async () => (await t.driver.observe(inspect, button)).text === initial, 'initial lens choice restored');
    if (!profileInitial.checked) {
      await click(t, profile);
      await until(async () => !(await t.driver.observe(inspect, profile)).checked, 'restore lens corrections state');
    }
    return;
  }
  const select = await t.driver.observe(s => !!document.querySelector(`${s} select`), container);
  if (select) {
    const { choose } = await import('../support/scenario.mjs');
    const initial = await reveal(t, `${container} select`);
    // AgX's select appends two commands after its real profile options. They
    // open Load/Delete flows rather than selecting a control value; dynamic
    // user profiles remain eligible choices.
    const commands = definition.control.id === 'profile' ? new Set(['-1', '-2']) : new Set();
    for (const option of initial.options.filter(o => !o.disabled && !commands.has(o.value))) {
      await choose(t, `${container} select`, option.value); await settledPhoto(t); await t.evidence(`option-${option.value}`);
      t.measure({ name: option.label, value: (await t.driver.observe(inspect, `${container} select`)).value });
    }
    await choose(t, `${container} select`, initial.value);
  } else {
    const checkbox = await t.driver.observe(s => !!document.querySelector(`${s} input[type=checkbox]`), container);
    if (checkbox) {
      const selector = `${container} input[type=checkbox]`, initial = await reveal(t, selector);
      for (let i = 0; i < 2; i++) {
        await click(t, selector);
        const want = i ? initial.checked : !initial.checked;
        await until(async () => (await t.driver.observe(inspect, selector)).checked === want, `toggle ${i} checked ${want}`);
        await settledPhoto(t); await t.evidence(`toggle-${i}`);
      }
    } else {
      const count = await t.driver.observe(s => document.querySelectorAll(`${s} button`).length, container);
      assert(count > 0, 'choice must expose buttons');
      const active = await t.driver.observe(s => [...document.querySelectorAll(`${s} button`)].findIndex(b =>
        b.classList.contains('active') || b.classList.contains('on')), container);
      assert(active >= 0, 'segmented choice exposes its selected option');
      for (let i = 1; i <= count; i++) {
        const selector = `${container} button:nth-of-type(${i})`;
        await click(t, selector);
        await until(async () => (await t.driver.observe(inspect, selector))?.active, 'choice publishes selected style');
        await settledPhoto(t); await t.evidence(`choice-${i}`);
      }
      const selector = `${container} button:nth-of-type(${active + 1})`;
      if (!(await t.driver.observe(inspect, selector))?.active) {
        await click(t, selector);
        await until(async () => (await t.driver.observe(inspect, selector))?.active, 'initial segmented choice restored');
        await settledPhoto(t);
      }
    }
  }
}
