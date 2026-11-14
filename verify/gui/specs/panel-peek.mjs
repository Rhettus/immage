// SPDX-License-Identifier: GPL-3.0-or-later
// A panel's eye (PanelView.tsx, PeekButton): held, the photo shows the
// panel's controls at their defaults while the sliders stay where they are;
// let go, the edit is back. An unedited panel's eye is dimmed
import assert from 'node:assert/strict';
import { until } from '../support/webdriver.mjs';
import * as read from '../support/observations.mjs';
import { Blocked, panel } from '../support/scenario.mjs';
import { reveal, rangeSelector } from '../support/controls.mjs';
import { settledPhoto } from './smoke.mjs';

const summary = ({ rgba, ...rest }) => rest;
const meanError = (a, b) => { let e = 0; for (let i = 0; i < a.rgba.length; i++) e += Math.abs(a.rgba[i] - b.rgba[i]); return e / a.rgba.length; };
const eye = id => {
  const b = document.querySelector(`[data-panel-id=${JSON.stringify(id)}] > .panel-title [data-panel-peek]`);
  if (!b) return null;
  const r = b.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  return { x, y, width: r.width, height: r.height, disabled: b.disabled, pressed: b.getAttribute('aria-pressed') === 'true',
           hit: !!hit && (hit === b || b.contains(hit)), title: b.title,
           open: !!document.querySelector(`[data-panel-id=${JSON.stringify(id)}] > .collapse.open`) };
};

export async function panelPeek(t) {
  await panel(t, 'basic');
  await reveal(t, '[data-control-id="exposure"] label');
  await reveal(t, rangeSelector('exposure'));
  let slider = await until(async () => { const s = await t.driver.observe(read.exposure); return s?.visible && s.hit && !s.disabled && s; }, 'visible Exposure slider');
  if (Math.abs(slider.value) > .02) {
    await t.driver.point(slider.label.x, slider.label.y, 2);
    await until(async () => Math.abs((await t.driver.observe(read.exposure)).value) < .02, 'neutral Exposure');
  }
  const neutral = await settledPhoto(t);
  // a fresh photo: Basic has nothing to show without, so its eye is dimmed
  const idle = await until(() => t.driver.observe(eye, 'basic'), 'Basic eye');
  t.measure({ name: 'unedited-eye', eye: idle });
  assert(idle.disabled, 'an unedited panel\'s eye is dimmed');

  slider = await t.driver.observe(read.exposure);
  const { x, y, width, height } = slider.bounds;
  const at = value => ({ x: x + 8 + (width - 16) * (value - slider.min) / (slider.max - slider.min), y: y + height / 2 });
  await t.driver.drag(at(slider.value), at(1));
  const moved = await until(async () => { const s = await t.driver.observe(read.exposure); return Math.abs(s.value - 1) < .3 && s; }, 'Exposure near +1');
  const edited = await settledPhoto(t, p => p.hash !== neutral.hash && p.luma > neutral.luma + 2);
  await t.evidence('peek-edited');

  const ready = await until(async () => { const e = await t.driver.observe(eye, 'basic'); return e && !e.disabled && e; }, 'Basic eye enabled once edited');
  assert(ready.hit, 'the eye receives hit testing');
  assert(ready.open, 'Basic is open before the eye is held');
  await t.driver.hold(ready, ready);
  let held, peeked;
  try {
    held = await until(async () => { const e = await t.driver.observe(eye, 'basic'); return e?.pressed && e; }, 'eye pressed while held', 5000);
    // the settled frame while held, whatever it shows, measured against both
    peeked = await settledPhoto(t, p => p.hash !== edited.hash);
    const during = await t.driver.observe(read.exposure);
    const errorToNeutral = meanError(peeked, neutral), errorToEdited = meanError(peeked, edited);
    t.measure({ name: 'held', eye: held, slider: during, photo: summary(peeked), neutral: summary(neutral), edited: summary(edited),
                errorToNeutral, errorToEdited });
    await t.evidence('peek-held');
    assert(errorToNeutral < 1, `held, the photo is the neutral one (mean error ${errorToNeutral}; to the edit ${errorToEdited})`);
    assert(Math.abs(during.value - moved.value) < 1e-6, `Exposure stays at ${moved.value} while held (${during.value})`);
    assert(Math.abs(parseFloat(during.displayed) - moved.value) < .02, 'the displayed Exposure stays too');
  } finally { await t.driver.release(); }

  const back = await settledPhoto(t, p => meanError(p, edited) < 1);
  const after = await t.driver.observe(eye, 'basic');
  t.measure({ name: 'released', eye: after, photo: summary(back), errorToEdited: meanError(back, edited) });
  await t.evidence('peek-released');
  assert(!after.pressed, 'the eye is let go');
  assert(after.open, 'holding the eye does not fold the panel');
  assert(Math.abs((await t.driver.observe(read.exposure)).value - moved.value) < 1e-6, 'Exposure unchanged after the peek');

  // leave the photo as found
  slider = await t.driver.observe(read.exposure);
  await t.driver.point(slider.label.x, slider.label.y, 2);
  await until(async () => Math.abs((await t.driver.observe(read.exposure)).value) < .02, 'reset Exposure');
  if (!neutral) throw new Blocked('no neutral frame');
}
