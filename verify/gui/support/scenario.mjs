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
  const point = await until(() => t.driver.observe((scope, text) => {
    // a menu item's shortcut (<span class="key">) is not part of its name
    const name = b => [...b.childNodes].filter(n => !n.classList?.contains('key')).map(n => n.textContent).join('').trim();
    const e = [...document.querySelectorAll(`${scope} button`)].find(e => name(e) === text);
    if (!e) return null; const r = e.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return r.width && r.height && !e.disabled && (e === hit || e.contains(hit)) && { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, scope, text), `button ${scope}/${text}`);
  await t.driver.point(point.x, point.y);
}
export async function choose(t, selector, value) {
  const c = await reveal(t, selector);
  if (c.disabled) throw new Blocked(`Disabled prerequisite ${selector}`);
  const index = c.options?.findIndex(o => o.value === String(value));
  assert(index >= 0 && !c.options[index].disabled, `${selector} has enabled option ${value}`);
  await t.driver.point(c.x, c.y);
  await t.driver.keys('\uE011', ...Array(index).fill('\uE015'), '\uE007');
  await until(async () => (await t.driver.observe(inspect, selector))?.value === String(value), `selected ${value}`);
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
