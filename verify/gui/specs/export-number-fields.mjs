// SPDX-License-Identifier: GPL-3.0-or-later
// Export's size fields (NumberField.tsx) keep what is typed: double-clicking
// the long edge and typing 5128 gives 5128, not 16 at the first digit (the
// field used to clamp each keystroke to its minimum). A value under the
// minimum is corrected only when the field is left. Settings only: nothing is
// exported and no native chooser is opened.
import assert from 'node:assert/strict';
import { click, reveal } from '../support/controls.mjs';
import { choose, textButton } from '../support/scenario.mjs';
import { until } from '../support/webdriver.mjs';

const ENTER = '', TAB = '';
const dialog = '.modal.export';
const resize = `${dialog} select[data-export-field="resize"]`;
const longEdge = `${resize} ~ input.num-field`;
const canvasW = `${dialog} input.num-field[title]:nth-of-type(1)`;
const value = (t, s) => t.driver.observe(s => document.querySelector(s)?.value, s);

async function openExport(t) {
  await click(t, 'button[data-tour="export"]');
  await until(() => t.driver.observe(s => !!document.querySelector(s), dialog), 'the export dialog');
  const sec = `${dialog} [data-export-section="format"]`;
  const open = await t.driver.observe(s => document.querySelector(s)?.classList.contains('open'), sec);
  assert(open !== undefined && open !== null, 'the Format and size section exists');
  if (!open) await click(t, `${sec} > .export-section-head`);
  await until(() => t.driver.observe(s => !!document.querySelector(s), resize), 'the Size menu');
}

// what a user does: double-click the number to select it, then type over it
async function typeOver(t, selector, digits, end) {
  const c = await reveal(t, selector);
  await t.driver.point(c.x, c.y, 2);
  await t.driver.keys(...digits);
  const typed = await value(t, selector);
  if (end) await t.driver.keys(end);
  return typed;
}

export async function exportNumberFields(t) {
  await openExport(t);
  await choose(t, resize, 'fit');
  await until(() => t.driver.observe(s => !!document.querySelector(s), longEdge), 'the long edge field');
  t.measure({ name: 'start', longEdge: await value(t, longEdge) });

  // typing 5128 over the selected value keeps every digit
  const typed = await typeOver(t, longEdge, '5128', TAB);
  t.measure({ name: 'typed', value: typed });
  assert.equal(typed, '5128', 'the long edge holds 5128 while typing');
  await until(async () => await value(t, longEdge) === '5128', 'the long edge keeps 5128 after leaving it');
  await t.evidence('export-number-long-edge');

  // remembered: close and reopen
  await textButton(t, `${dialog} .modal-foot`, 'Cancel');
  await until(async () => !await t.driver.observe(s => !!document.querySelector(s), dialog), 'the dialog closed');
  await openExport(t);
  assert.equal(await value(t, longEdge), '5128', 'the long edge was remembered');

  // under the minimum: shown as typed, corrected to 16 on Enter
  const low = await typeOver(t, longEdge, '5', ENTER);
  assert.equal(low, '5', 'a single digit stays as typed');
  await until(async () => await value(t, longEdge) === '16', 'Enter corrects 5 to the minimum 16');
  // over the maximum: corrected to 30000 on leaving
  await typeOver(t, longEdge, '99999', TAB);
  await until(async () => await value(t, longEdge) === '30000', 'leaving corrects 99999 to the maximum 30000');

  // Fixed canvas: width and height
  await choose(t, resize, 'canvas');
  const canvasH = `${dialog} input.num-field[title]:nth-of-type(2)`;
  await until(() => t.driver.observe(s => !!document.querySelector(s), canvasH), 'the canvas fields');
  const w = await typeOver(t, canvasW, '3000', TAB);
  const h = await typeOver(t, canvasH, '2000', TAB);
  t.measure({ name: 'canvas', width: w, height: h });
  assert.equal(w, '3000', 'canvas width holds 3000 while typing');
  assert.equal(h, '2000', 'canvas height holds 2000 while typing');
  await until(async () => await value(t, canvasW) === '3000' && await value(t, canvasH) === '2000', 'canvas keeps 3000 x 2000');
  await t.evidence('export-number-canvas');

  await textButton(t, `${dialog} .modal-foot`, 'Cancel');
}
