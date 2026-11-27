// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { extname } from 'node:path';
import { reveal } from '../support/controls.mjs';
import { panel, Blocked } from '../support/scenario.mjs';
import { until } from '../support/webdriver.mjs';
import { settledPhoto } from './smoke.mjs';
import * as read from '../support/observations.mjs';

const statusText = () => document.querySelector('.status')?.textContent ?? '';
// the engine's refusal for an edit with nothing open; it must never reach the user here
const active = () => document.querySelector('.filmstrip .thumb.active')?.title ?? null;
const noImage = () => document.body.innerText.toLowerCase().includes('no image open');

// Open a photo from the filmstrip: two clicks open it whether the preference is
// single or double click.
async function openByName(t, name) {
  const selector = `.filmstrip .thumb[data-imgid][title=${JSON.stringify(name)}]`;
  let fromStart = false;
  await until(async () => {
    const strip = await t.driver.observe(s => {
      if (document.querySelector(s)) return { found: true };
      const el = document.querySelector('.filmstrip');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, left: el.scrollLeft,
        end: el.scrollWidth - el.clientWidth };
    }, selector);
    if (strip?.found) return true;
    if (!strip) return false;
    if (strip.left <= 1) fromStart = true;
    const delta = fromStart ? (strip.left < strip.end - 1 ? 300 : 0) : -300;
    if (delta) await t.driver.wheel(strip.x, strip.y, 0, delta);
    return false;
  }, `filmstrip thumbnail ${name}`);
  const cell = await reveal(t, selector);
  await t.driver.point(cell.x, cell.y, 2);
  return name;
}

async function moveExposureToMax(t) {
  await panel(t, 'basic');
  const slider = await reveal(t, '[data-control-id="exposure"] input[type=range]');
  await t.driver.point(slider.x, slider.y);
  await t.driver.keys(''); // End
  return until(async () => { const s = await t.driver.observe(read.exposure); return s && s.value > s.max - .3 && s; }, 'Exposure moved');
}

export async function openFailureRecovery(t) {
  const goodA = t.fixture.file;
  const ext = extname(goodA);
  const bad = `open-bad${ext}`;

  // A: open and edit
  await openByName(t, goodA);
  await until(() => t.driver.observe(a => document.querySelector('.filmstrip .thumb.active')?.title === a, goodA), 'photo A is active');
  await settledPhoto(t);
  await moveExposureToMax(t);
  await t.evidence('open-failure-a-edited');

  // the truncated file
  await openByName(t, bad);
  const failed = await until(() => t.driver.observe(statusText).then(s => /could not (open|load)/i.test(s) && s), 'open failure status', 30000).catch(async e => {
    if (await t.driver.observe(() => !!document.querySelector('canvas.layer.sharp:not(.empty)')) && await t.driver.observe(a => document.querySelector('.filmstrip .thumb.active')?.title === a, bad))
      throw new Blocked('the truncated file opened; the fixture is not truncated enough for this engine');
    throw e;
  });
  assert(failed.includes(bad), `status names the file (${failed})`);
  assert(!await t.driver.observe(noImage), 'no "no image open" anywhere after the failed open');
  t.measure({ name: 'open-failure-status', status: failed });
  await t.evidence('open-failure-status');

  // B: a good photo opens and takes an edit
  const goodB = await openByName(t, `open-b${ext}`);
  await until(() => t.driver.observe(a => document.querySelector('.filmstrip .thumb.active')?.title === a, goodB), 'photo B is active');
  const before = await settledPhoto(t);
  assert(!await t.driver.observe(noImage), 'no "no image open" after opening B');
  const exposure = await until(async () => { const s = await t.driver.observe(read.exposure); return s && !s.disabled && s; }, 'Exposure available on B');
  assert(Math.abs(exposure.value) < .02, `B starts with a neutral Exposure (${exposure.value})`);
  const moved = await moveExposureToMax(t);
  const after = await settledPhoto(t, p => p.hash !== before.hash && p.luma > before.luma + 2);
  assert(!await t.driver.observe(noImage), 'no "no image open" after editing B');
  assert(!/could not open|error/i.test(await t.driver.observe(statusText)), `status shows no error after editing B (${await t.driver.observe(statusText)})`);
  t.measure({ name: 'edit-after-failure', exposure: moved.value, lumaBefore: before.luma, lumaAfter: after.luma });
  await t.evidence('open-failure-b-edited');

  // two quick opens: only the last stays open
  const fromA = await openByName(t, goodA);
  const last = await openByName(t, `open-c${ext}`);
  assert.notEqual(fromA, last, 'two different photos were opened');
  await until(() => t.driver.observe(a => document.querySelector('.filmstrip .thumb.active')?.title === a, last), 'only the last opened photo is active');
  await settledPhoto(t);
  assert.equal(await t.driver.observe(active), last, 'the last photo stays active after settling');
  assert(!await t.driver.observe(noImage), 'no "no image open" after the quick opens');
  t.measure({ name: 'quick-opens', first: fromA, last });
}
