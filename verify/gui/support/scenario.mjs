// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { inspect, reveal, click } from './controls.mjs';
import { until } from './webdriver.mjs';
export class Blocked extends Error { constructor(message) { super(message); this.name = 'Blocked'; } }
export async function requireElement(t, selector, reason = selector) {
  if (!await t.driver.observe(s => !!document.querySelector(s), selector)) throw new Blocked(`Missing prerequisite: ${reason}`);
}
export async function textButton(t, scope, text) {
  // Resolve by readonly text observation at interaction time; no DOM mutations.
  // reveal scrolls a button below or above its list into view first.
  const b = await reveal(t, `${scope} button`, text);
  await until(async () => !(await t.driver.observe(inspect, `${scope} button`, text))?.disabled, `enabled button ${scope}/${text}`);
  await t.driver.point(b.x, b.y);
}
// `appears`: an option that opens something (Enter Custom…) rather than
// staying selected; wait for that element instead of the value
export async function choose(t, selector, value, appears) {
  const c = await reveal(t, selector);
  if (c.disabled) throw new Blocked(`Disabled prerequisite ${selector}`);
  const index = c.options?.findIndex(o => o.value === String(value));
  assert(index >= 0 && !c.options[index].disabled, `${selector} has enabled option ${value}`);
  await t.driver.point(c.x, c.y);
  await t.driver.keys('\uE011', ...Array(index).fill('\uE015'), '\uE007');
  if (appears) await until(() => t.driver.observe(s => !!document.querySelector(s), appears), `${value} opens ${appears}`);
  else await until(async () => (await t.driver.observe(inspect, selector))?.value === String(value), `selected ${value}`);
}
export async function panel(t, id) {
  const selector = `[data-panel-id=${JSON.stringify(id)}]`;
  await requireElement(t, selector, `panel ${id}, fixture/module/treatment`);
  if (!await t.driver.observe(s => document.querySelector(`${s} > .panel-title`)?.classList.contains('open'), selector))
    await click(t, `${selector} > .panel-title`);
  await until(() => t.driver.observe(s => !!document.querySelector(`${s} > .collapse.open`), selector), `${id} open`);
  return selector;
}
export async function expandSections(t, selector) {
  for (let pass = 0; pass < 100; pass++) {
    const target = await t.driver.observe(s => {
      for (const e of document.querySelectorAll(`${s} section[data-section-id] > h3.fold`))
        if (e.querySelector('.chevron:not(.open)')) return `${s} section[data-section-id=${JSON.stringify(e.parentElement.dataset.sectionId)}] > h3.fold`;
      for (const e of document.querySelectorAll(`${s} button.detail-advanced[aria-expanded="false"]`))
        return `${s} button[data-detail-id=${JSON.stringify(e.dataset.detailId)}]`;
      return null;
    }, selector);
    if (!target) return;
    await click(t, target);
    await until(() => t.driver.observe(s => {
      const e = document.querySelector(s); return e?.getAttribute('aria-expanded') === 'true' || !!e?.querySelector('.chevron.open');
    }, target), 'section expanded');
  }
  throw Error('Section expansion exceeded limit');
}

// Open a mask adjustment group (Tone, Presence, ...) if it is closed. Its
// heading toggles, so clicking an already open group would close it.
export async function openMaskGroup(t, title) {
  const heading = `[data-mask-group=${JSON.stringify(title)}]`;
  await requireElement(t, heading, `${title} mask group`);
  if (await t.driver.observe(s => !!document.querySelector(`${s} .chevron:not(.open)`), heading)) await click(t, heading);
  await until(() => t.driver.observe(s => !!document.querySelector(`${s} .chevron.open`), heading), `${title} group open`);
}
