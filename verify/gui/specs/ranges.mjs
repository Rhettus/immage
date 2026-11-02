// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { inspect, click, reveal, rangeSelector } from '../support/controls.mjs';
import { Blocked, panel, expandSections, textButton } from '../support/scenario.mjs';
import { until } from '../support/webdriver.mjs';
import { settledPhoto } from './smoke.mjs';

export async function locateControl(t, definition) {
  const { panel: id, section, control } = definition;
  if (control.rawOnly && !t.fixture.raw) throw new Blocked(`${control.id} requires an approved RAW fixture`);
  let p;
  if (definition.scope === 'local') {
    await click(t, 'button[data-tour="masks"]');
    if (!await t.driver.observe(() => !!document.querySelector('.mask-list li.on'))) {
      await click(t,'.create-mask'); await textButton(t,'.shape-menu-list','Radial Gradient');
      const svg=await reveal(t,'svg.mask-svg');
      await t.driver.drag({x:svg.x-svg.bounds.width*.1,y:svg.y-svg.bounds.height*.1},{x:svg.x+svg.bounds.width*.1,y:svg.y+svg.bounds.height*.1});
    }
    const group = /^l_(temp|tint)$/.test(control.id) ? 'White Balance'
      : /^(ce_|l_(exposure|contrast|fulcrum|highlights|shadows|whites|blacks)$)/.test(control.id) ? 'Tone'
      : control.id.startsWith('l_hsl') ? 'HSL' : control.id.startsWith('l_cg') ? 'Color Grading'
      : /^l_(sharpness|usm|noise|defringe)/.test(control.id) ? 'Detail' : 'Presence';
    const heading=`[data-mask-group=${JSON.stringify(group)}]`;
    if(await t.driver.observe(s=>!!document.querySelector(`${s} .chevron:not(.open)`),heading)) await click(t,heading);
    p='.masks-panel';
  } else if (id === 'negative') {
    if (t.fixture.name !== 'negative') throw new Blocked('Negative controls require --fixture negative');
    const { prepareNegative } = await import('./workflows.mjs'); await prepareNegative(t); p='.negative';
  } else p = await panel(t, id);
  await expandSections(t, p);
  if (id === 'hsl') await textButton(t, `${p} .tabs`, section);
  if (id === 'colorgrading') await textButton(t, `${p} .tabs`, 'Sliders');
  const selector = `${p} [data-control-id=${JSON.stringify(control.id)}]`;
  if (!await t.driver.observe(s => !!document.querySelector(s), selector))
    throw new Blocked(`${control.id} needs its module, treatment or graph branch; run the matching module/graph case`);
  return selector;
}
export async function rangeContract(t, definition) {
  const container = await locateControl(t, definition), selector = `${container} input[type=range]`;
  let s = await reveal(t, selector);
  if (s.disabled) throw new Blocked(`Disabled ${definition.control.id}: fixture/module prerequisite`);
  const label = await reveal(t, `${container} > label`);
  await t.driver.point(label.x, label.y, 2);
  const baseline = await settledPhoto(t);
  s = await reveal(t, selector); const neutral = +s.value;
  const at = v => ({ x: s.bounds.x + 8 + (s.bounds.width - 16) * (v - s.min) / (s.max - s.min), y: s.y });
  for (const sign of [-1, 1]) {
    const target = Math.min(s.max, Math.max(s.min, neutral + sign * (s.max - s.min) * .08));
    if (Math.abs(target - neutral) < (s.step || .001)) continue;
    await t.driver.drag(at(+(await t.driver.observe(inspect, selector)).value), at(target));
    const changed = await until(async () => { const c = await t.driver.observe(inspect, selector); return Math.abs(+c.value - neutral) >= (s.step || .001) && c; }, 'pointer range change');
    const photo = await settledPhoto(t);
    t.measure({ name: `drag-${sign}`, value: changed.value, displayed: changed.displayed, photoChanged: photo.hash !== baseline.hash, css: changed.css });
    await t.evidence(`drag-${sign}`);
  }
  // Native keyboard range limits and step, including nonlinear position ranges.
  await click(t, selector); await t.driver.keys('\uE011'); // Home
  await until(async () => +(await t.driver.observe(inspect, selector)).value === s.min, 'Home minimum');
  await t.driver.keys('\uE014');
  const step = +(await t.driver.observe(inspect, selector)).value;
  assert(Math.abs(step - Math.min(s.max, s.min + s.step)) < Math.max(1e-6, s.step / 100), 'ArrowRight follows declared track step');
  await t.driver.keys('\uE010');
  await until(async () => +(await t.driver.observe(inspect, selector)).value === s.max, 'End maximum');
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
  const reset = await reveal(t, `${container} > label`); await t.driver.point(reset.x, reset.y, 2);
  await until(async () => Math.abs(+(await t.driver.observe(inspect, selector)).value - neutral) <= s.step, 'double-click reset');
  await settledPhoto(t, p => p.hash === baseline.hash); await t.evidence('reset');
}
export async function choiceContract(t, definition) {
  const container = await locateControl(t, definition);
  const select = await t.driver.observe(s => !!document.querySelector(`${s} select`), container);
  if (select) {
    const { choose } = await import('../support/scenario.mjs');
    const initial = await reveal(t, `${container} select`);
    for (const option of initial.options.filter(o => !o.disabled)) {
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
        assert.equal((await t.driver.observe(inspect, selector)).checked, i ? initial.checked : !initial.checked);
        await settledPhoto(t); await t.evidence(`toggle-${i}`);
      }
    } else {
      const count = await t.driver.observe(s => document.querySelectorAll(`${s} button`).length, container);
      assert(count > 0, 'choice must expose buttons');
      for (let i = 1; i <= count; i++) {
        const selector = `${container} button:nth-of-type(${i})`;
        await click(t, selector);
        assert((await t.driver.observe(inspect, selector)).active, 'choice publishes selected style');
        await settledPhoto(t); await t.evidence(`choice-${i}`);
      }
    }
  }
}
