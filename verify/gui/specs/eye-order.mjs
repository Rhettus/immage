// SPDX-License-Identifier: GPL-3.0-or-later
// Every Adjustments panel's eye (PanelView.tsx, PeekButton) sits directly
// beside its chevron, with More controls, where a panel has it, on the eye's
// left, so the eyes line up down the column whether or not a panel has More
// controls
import assert from 'node:assert/strict';
import { panel } from '../support/scenario.mjs';
import { until } from '../support/webdriver.mjs';
import { settledPhoto } from './smoke.mjs';

const rows = () => [...document.querySelectorAll('.panel.adjust[data-panel-id] > .panel-title')].map((title) => {
  const id = title.parentElement.dataset.panelId;
  const eye = title.querySelector(':scope > [data-panel-peek]');
  const more = title.querySelector(':scope > [data-advanced-toggle]');
  const chevron = title.querySelector(':scope > .chevron');
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
  return { id, eye: box(eye), more: box(more), chevron: box(chevron),
           eyeBeforeChevron: !!eye && eye.nextElementSibling === chevron,
           moreBeforeEye: !more || more.nextElementSibling === eye };
});

export async function eyeOrder(t) {
  await panel(t, 'basic');
  await settledPhoto(t);
  const found = await until(async () => { const r = await t.driver.observe(rows); return r.filter((x) => x.eye).length >= 4 && r; }, 'Adjustments panels with eyes');
  t.measure({ name: 'title-rows', rows: found });
  await t.evidence('eye-order');
  const eyes = found.filter((x) => x.eye && x.eye.width > 0);
  assert(eyes.some((x) => x.more) && eyes.some((x) => !x.more), 'panels both with and without More controls are checked');
  for (const x of eyes) {
    assert(x.eyeBeforeChevron, `${x.id}: the eye sits directly before the chevron`);
    assert(x.moreBeforeEye, `${x.id}: More controls sits directly left of the eye`);
    if (x.more) assert(x.more.right <= x.eye.left + .5, `${x.id}: More controls is left of the eye`);
  }
  const rights = eyes.map((x) => x.eye.right);
  assert(Math.max(...rights) - Math.min(...rights) < 1, `the eyes line up (right edges ${rights.map((r) => r.toFixed(1)).join(', ')})`);
}
