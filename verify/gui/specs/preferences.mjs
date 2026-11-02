// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { until } from '../support/webdriver.mjs';
import { inspect, click, reveal } from '../support/controls.mjs';

async function modules(t) {
  await click(t, 'button[data-tour="prefs"]');
  const tab = await until(() => t.driver.observe(() => {
    const e = [...document.querySelectorAll('.prefs-tabs button')].find(e => e.textContent.trim() === 'Modules');
    if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }), 'Modules tab');
  await t.driver.point(tab.x, tab.y);
  const custom = await until(() => t.driver.observe(() => {
    const e = [...document.querySelectorAll('.prefs button')].find(e => e.textContent.trim() === 'Custom');
    if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }), 'Custom mode');
  await t.driver.point(custom.x, custom.y);
}
async function scope(t, name) {
  const selector = `button[aria-controls="module-prefs-${name}"]`;
  const expanded = await t.driver.observe(s => document.querySelector(s)?.getAttribute('aria-expanded') === 'true', selector);
  if (!expanded) await click(t, selector);
  await until(() => t.driver.observe(s => !!document.querySelector(s)?.closest('.collapse.open'), `#module-prefs-${name}`), `${name} module section open`);
}
async function selectIndex(t, selector, index) {
  const c = await reveal(t, selector);
  assert(!c.disabled, `${selector} enabled in Custom mode`);
  await t.driver.point(c.x, c.y);
  await t.driver.keys('\uE011', ...Array(index).fill('\uE015'), '\uE007'); // Home, Down, Enter
  await until(async () => (await t.driver.observe(inspect, selector))?.value === c.options[index].value, `${selector} option ${index}`);
}
export async function moduleOptions(t) {
  await modules(t);
  const results = [];
  for (const group of ['global', 'masks']) {
    await scope(t, group);
    const menus = await t.driver.observe(s => [...document.querySelectorAll(`${s} select`)].map(e => e.getAttribute('aria-label')), `#module-prefs-${group}`);
    assert(menus.length, `${group} module menus present`);
    for (const label of menus) {
      const selector = `select[aria-label=${JSON.stringify(label)}]`;
      const original = await t.driver.observe(inspect, selector);
      for (let i = 0; i < original.options.length; i++) {
        if (original.options[i].disabled) continue;
        await selectIndex(t, selector, i);
        const chosen = await t.driver.observe(inspect, selector);
        assert(chosen.visible && chosen.hit, `${label} option remains readable and clickable`);
        results.push({ label, value: chosen.value, option: chosen.options[i].label, css: chosen.css });
        await t.evidence(`module-${group}-${menus.indexOf(label)}-${i}`);
      }
      await selectIndex(t, selector, original.options.findIndex(o => o.value === original.value));
    }
  }
  // faa19d7 / 9d956c7: deliberately choose different Contrast modules.
  await scope(t, 'global');
  const global = 'select[aria-label="Global Contrast"]', mask = 'select[aria-label="Masks Contrast"]';
  const g = await t.driver.observe(inspect, global);
  assert(g?.options.length > 1, 'Global Contrast has alternatives');
  await selectIndex(t, global, 0);
  await scope(t, 'masks');
  const m = await t.driver.observe(inspect, mask);
  const different = m.options.findIndex(o => o.value !== g.options[0].value);
  assert(different >= 0, 'Masks Contrast has an independent alternative');
  await selectIndex(t, mask, different);
  await t.evidence('independent-mask-contrast');
  // Reopen the sections to verify React/storage-backed choices survive folding.
  await scope(t, 'global');
  assert.equal((await t.driver.observe(inspect, global)).value, g.options[0].value);
  await scope(t, 'masks');
  assert.equal((await t.driver.observe(inspect, mask)).value, m.options[different].value);
  t.measure({ name: 'module-options', options: results, regression: ['faa19d7', '9d956c7'],
    limitation: 'Preference selection and independent scopes only; engine output for every module needs dedicated photo cases.' });
  await selectIndex(t, mask, m.options.findIndex(o => o.value === m.value));
  await scope(t, 'global');
  await selectIndex(t, global, g.options.findIndex(o => o.value === g.value));
  await click(t, '.prefs-foot button');
  await until(() => t.driver.observe(() => !document.querySelector('.prefs')), 'Preferences closed');
}
