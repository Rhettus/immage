// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import assert from 'node:assert/strict';
import { until } from '../support/webdriver.mjs';
import { click, openTool, reveal } from '../support/controls.mjs';
import { panel, choose } from '../support/scenario.mjs';
import { settledPhoto } from './smoke.mjs';
import { setMode } from './editing-mode.mjs';
import { addCard } from './advanced-exposure.mjs';
import { waitSetting } from '../support/settings.mjs';

const KEY = 'immage.editMode';
const meanError = (a, b) => { let e = 0; for (let i = 0; i < a.rgba.length; i++) e += Math.abs(a.rgba[i] - b.rgba[i]); return e / a.rgba.length; };
const undoRedo = (t, which) => click(t, `button.tool[title^="${which} ("]`);
const count = (t, sel) => t.driver.observe(s => document.querySelectorAll(s).length, sel);

// adds the card when the group has none, and opens it
async function openCard(t, group, op) {
  const sel = `[data-panel-id="${group}"] [data-module^="${op}#"]`;
  await panel(t, group);
  const added = await addCard(t, group, op, sel);
  const open = () => t.driver.observe(s => !!document.querySelector(`${s} > .collapse.open`), sel);
  await until(async () => (await t.driver.observe(s => !!document.querySelector(s), sel)), `${op} card`);
  if (!await open()) await click(t, `${sel} .module-card-head`);
  await until(open, `${op} card open`);
  return { sel, added };
}

// a graph's box, in viewport pixels
const box = (t, sel) => t.driver.observe(s => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, sel);
// a pointer click at a fraction of a graph's width and height (0 at its top left)
async function clickAt(t, sel, fx, fy) {
  await reveal(t, sel);
  const b = await box(t, sel);
  await t.driver.point(b.x + b.w * fx, b.y + b.h * fy);
}

// a choice field's options, drawn as a select or as buttons
async function choice(t, sel, id) {
  return t.driver.observe((s, i) => {
    const e = document.querySelector(`${s} [data-control-id="${i}"]`);
    const select = e?.querySelector('select');
    if (select) return { select: true, options: [...select.options].map(o => ({ value: o.value, label: o.textContent.trim() })) };
    return e && { select: false, options: [...e.querySelectorAll('button')].map(b => ({ label: b.textContent.trim() })) };
  }, sel, id);
}
async function pick(t, sel, id, label) {
  const c = await until(() => choice(t, sel, id), `${id} choice`);
  const o = c.options.find(x => label.test(x.label));
  assert(o, `${id} lists ${label}: ${JSON.stringify(c.options)}`);
  if (c.select) await choose(t, `${sel} [data-control-id="${id}"] select`, o.value);
  else await click(t, `${sel} [data-control-id="${id}"] button:nth-of-type(${c.options.indexOf(o) + 1})`);
}

// types a value into a card's slider through its numeric editor
async function type(t, sel, id, text) {
  const slider = `${sel} [data-control-id="adv:${id}"]`;
  const v = await reveal(t, `${slider} .value`);
  await t.driver.point(v.x, v.y, 2);
  await until(() => t.driver.observe(s => !!document.querySelector(`${s} .value-edit`), slider), `${id} numeric editor`);
  await t.driver.keys(...text, '\uE007'); // Enter
}
// a card field's readout as a number, and its slider position
const readout = (t, sel, id) => t.driver.observe((s, i) => {
  const e = document.querySelector(`${s} [data-control-id="adv:${i}"]`);
  const x = e?.querySelector('.value')?.textContent.replace(/[^0-9.\-]/g, '');
  return e && x ? { shown: parseFloat(x), slider: e.querySelector('input[type=range]') ? +e.querySelector('input[type=range]').value : null } : null;
}, sel, id);

export async function advancedEditors(t) {
  await settledPhoto(t);
  await openTool(t, 'adjust');
  const originalValue = await waitSetting(t, KEY, () => true, 'settings file readable');
  const original = originalValue === 'advanced' ? 'Advanced' : 'Simple';
  try {
    if (original === 'Simple') await setMode(t, 'Advanced');
    await openTool(t, 'adjust');

    // 1. Tone Curve: the rgb curve card draws the graph; a click above the
    // diagonal adds a point and brightens the photo; undo returns it
    const rc = await openCard(t, 'tonecurve', 'rgbcurve');
    const graph = `${rc.sel} .module-card-curve[data-curve="rgbcurve"]`;
    await until(() => t.driver.observe(s => !!document.querySelector(s), `${graph} svg.point-curve`), 'rgb curve graph');
    const base = await settledPhoto(t);
    const points = () => count(t, `${graph} svg.point-curve circle.pt`);
    const n0 = await points();
    await clickAt(t, `${graph} svg.point-curve`, .5, .25);
    await until(async () => (await points()) === n0 + 1, 'a point added by the click');
    const bright = await settledPhoto(t, p => meanError(p, base) > .5);
    t.measure({ name: 'rgbcurve-point', points: [n0, n0 + 1], meanAbsoluteError: meanError(bright, base), luma: [base.luma, bright.luma] });
    assert(bright.luma > base.luma, `a point above the diagonal: luma ${bright.luma} not above ${base.luma}`);
    await t.evidence('rgbcurve-point');
    await undoRedo(t, 'undo');
    const back = await settledPhoto(t, p => meanError(p, base) < 1);
    assert(meanError(back, base) < 1, `undo of the curve point: photo mean pixel error ${meanError(back, base)} exceeds 1/255`);
    // the interpolation method lists darktable's three
    const interp = await t.driver.observe(s => [...document.querySelector(`${s} [data-control-id="rgbcurve-interpolation"] select`).options].map(o => o.textContent.trim()), rc.sel);
    t.measure({ name: 'rgbcurve-interpolation', interp });
    assert.equal(interp.length, 3, `interpolation options: ${interp}`);
    // independent channels show R, G and B tabs; linked channels do not
    assert.equal(await count(t, `${graph} [data-curve-channel]`), 0, 'linked channels show no channel tabs');
    await pick(t, rc.sel, 'adv:curve_autoscale', /independent/i);
    await until(async () => (await count(t, `${graph} [data-curve-channel]`)) === 3, 'R, G and B tabs');
    const names = await t.driver.observe(s => [...document.querySelectorAll(`${s} [data-curve-channel]`)].map(e => e.getAttribute('data-curve-channel')), graph);
    assert.deepEqual(names, ['R', 'G', 'B']);
    await t.evidence('rgbcurve-channels');

    // 2. Tone curve: L, a and b tabs; the a and b curves are disabled until
    // the color space is Lab, independent channels
    const tc = await openCard(t, 'tonecurve', 'tonecurve');
    const tg = `${tc.sel} .module-card-curve[data-curve="tonecurve"]`;
    await until(() => t.driver.observe(s => !!document.querySelector(s), `${tg} svg.point-curve`), 'tone curve graph');
    const tabs = await t.driver.observe(s => [...document.querySelectorAll(`${s} [data-curve-channel]`)].map(e => e.getAttribute('data-curve-channel')), tg);
    assert.deepEqual(tabs, ['L', 'a', 'b'], 'tone curve tabs');
    const disabled = () => t.driver.observe(s => document.querySelector(`${s} svg.point-curve`).classList.contains('disabled'), tg);
    assert.equal(await disabled(), false, 'the L curve is editable');
    await click(t, `${tg} [data-curve-channel="a"]`);
    await until(disabled, 'the a curve disabled outside Lab independent channels');
    await t.evidence('tonecurve-a-disabled');
    await pick(t, tc.sel, 'adv:tonecurve_autoscale_ab', /^Lab, independent/i);
    await until(async () => !(await disabled()), 'the a curve editable in Lab independent channels');
    await t.evidence('tonecurve-a-enabled');

    // 3. Detail: the contrast equalizer is Simple's graph with no heading of
    // its own; a click raising a band changes the photo, undo returns it
    const eq = await openCard(t, 'detail', 'atrous');
    const eg = `${eq.sel} .module-card-graph[data-graph="atrous"]`;
    await until(() => t.driver.observe(s => !!document.querySelector(s), `${eg} svg.equalizer-graph`), 'equalizer graph');
    assert.equal(await count(t, `${eg} .equalizer-heading`), 0, 'the Advanced card draws no equalizer heading');
    const flat = await settledPhoto(t);
    // band 3 of 6 (x 156 of a 272-wide box), up near the top
    await clickAt(t, `${eg} svg.equalizer-graph`, (3 * 52 + 6) / 272, .12);
    const sharp = await settledPhoto(t, p => meanError(p, flat) > .3);
    t.measure({ name: 'atrous-band', meanAbsoluteError: meanError(sharp, flat) });
    await t.evidence('atrous-band');
    await undoRedo(t, 'undo');
    const flatBack = await settledPhoto(t, p => meanError(p, flat) < 1);
    assert(meanError(flatBack, flat) < 1, `undo of the band: photo mean pixel error ${meanError(flatBack, flat)} exceeds 1/255`);

    // 4. HSL: the saturation curve graph; a click above the flat line adds a
    // point and changes the photo
    const sc = await openCard(t, 'hsl', 'satcurvergb');
    const sg = `${sc.sel} [data-graph="satcurvergb"]`;
    await until(() => t.driver.observe(s => !!document.querySelector(s), `${sg} svg.point-curve`), 'saturation curve graph');
    const plain = await settledPhoto(t);
    const sp = () => count(t, `${sg} svg.point-curve circle.pt`);
    const s0 = await sp();
    await clickAt(t, `${sg} svg.point-curve`, .5, .15);
    await until(async () => (await sp()) === s0 + 1, 'a saturation point added');
    const sat = await settledPhoto(t, p => meanError(p, plain) > .3);
    t.measure({ name: 'satcurve-point', points: [s0, s0 + 1], meanAbsoluteError: meanError(sat, plain) });
    await t.evidence('satcurve-point');

    // 5. Lens Corrections: the lens picker only with the Lensfun method
    const lc = await openCard(t, 'lens', 'lens');
    const picker = `${lc.sel} [data-control-id="adv:lens_pick"]`;
    await pick(t, lc.sel, 'adv:method', /lensfun/i);
    await until(() => t.driver.observe(s => !!document.querySelector(s), picker), 'lens picker with Lensfun');
    await t.evidence('lens-picker');
    await pick(t, lc.sel, 'adv:method', /manual|none|off|disabled/i);
    await until(() => t.driver.observe(s => !document.querySelector(s), picker), 'lens picker gone with another method');

    // 6. White balance: the scene illuminant temperature and tint read above
    // 0, typing a temperature moves the coefficients and the photo, green
    // stays 1, and undo returns both
    const wb = await openCard(t, 'basic', 'temperature');
    const isOn = () => t.driver.observe(s => document.querySelector(`${s} input.switch`).checked, wb.sel);
    if (!await isOn()) await click(t, `${wb.sel} input.switch`);
    await until(isOn, 'white balance on');
    const rd = id => until(async () => { const r = await readout(t, wb.sel, id); return r && r.shown > 0 && r; }, `${id} readout above 0`);
    const temp0 = await rd('temp_k');
    const tint0 = await rd('tint');
    const red0 = await rd('red'), blue0 = await rd('blue');
    const wbBase = await settledPhoto(t);
    const target = temp0.shown > 5000 ? 3500 : 7500;
    t.measure({ name: 'wb-before', temp: temp0.shown, tint: tint0.shown, red: red0.shown, blue: blue0.shown, target });
    await t.evidence('wb-before');
    await type(t, wb.sel, 'temp_k', String(target));
    const wbEdit = await settledPhoto(t, p => meanError(p, wbBase) > .5);
    const temp1 = await until(async () => { const r = await readout(t, wb.sel, 'temp_k'); return r && Math.abs(r.shown - target) <= 3 && r; }, `temperature reads ${target} K`);
    const red1 = await readout(t, wb.sel, 'red'), blue1 = await readout(t, wb.sel, 'blue'), green1 = await readout(t, wb.sel, 'green');
    t.measure({ name: 'wb-typed', temp: temp1.shown, red: red1.shown, blue: blue1.shown, green: green1.shown, meanAbsoluteError: meanError(wbEdit, wbBase) });
    await t.evidence('wb-typed');
    assert(meanError(wbEdit, wbBase) > .5, `typing a temperature changed the photo: ${meanError(wbEdit, wbBase)}`);
    assert(red1.shown !== red0.shown || blue1.shown !== blue0.shown, `a coefficient moved: red ${red0.shown} to ${red1.shown}, blue ${blue0.shown} to ${blue1.shown}`);
    assert(Math.abs(green1.shown - 1) < .0005, `green reads 1: ${green1.shown}`);
    await undoRedo(t, 'undo');
    const wbBack = await settledPhoto(t, p => meanError(p, wbBase) < 1);
    assert(meanError(wbBack, wbBase) < 1, `undo of the temperature: photo mean pixel error ${meanError(wbBack, wbBase)} exceeds 1/255`);
    await until(async () => { const r = await readout(t, wb.sel, 'temp_k'); return r && Math.abs(r.shown - temp0.shown) <= 3; }, `temperature reads ${temp0.shown} K after undo`);
    await t.evidence('editors-done');
  } finally {
    try {
      const now = await t.driver.observe(() => !!document.querySelector('.advanced-search'));
      if (now !== (original === 'Advanced')) await setMode(t, original);
    } catch { /* the failure above is the one to report */ }
  }
}
