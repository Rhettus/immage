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
  const defaultMode = await t.driver.observe(() => {
    const e = [...document.querySelectorAll('.prefs button')].find(e => e.textContent.trim() === 'Default');
    const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await t.driver.point(defaultMode.x, defaultMode.y);
  await until(() => t.driver.observe(() => !document.querySelector('#module-prefs-global select, #module-prefs-masks select')), 'Default uses plain module names');
  assert(await t.driver.observe(() => !!document.querySelector('#module-prefs-global .pref-value, #module-prefs-masks .pref-value')), 'Default module names remain visible');
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

// Help uses real pointer/keyboard input; inspection only reads DOM and geometry.
export async function preferencesHelp(t) {
  const { tabTo } = await import('../support/controls.mjs');
  await click(t, 'button[data-tour="prefs"]');
  const tab = await t.driver.observe(() => {
    const e = [...document.querySelectorAll('.prefs-tabs button')].find(e => e.textContent.trim() === 'General');
    const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await t.driver.point(tab.x, tab.y);
  const selector = '[data-pref-label="Canvas"] .pref-help';
  const help = await reveal(t, selector);
  await t.driver.move(help.x, help.y);
  await until(() => t.driver.observe(() => !!document.querySelector('[role="tooltip"]')), 'hover help');
  const hover = await t.driver.observe(() => {
    const tip = document.querySelector('[role="tooltip"]');
    const r = tip.getBoundingClientRect();
    return { text: tip.textContent, contained: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      hint: document.querySelector('[data-pref-label="Canvas"] .pref-hint').textContent };
  });
  assert(hover.contained, 'help fits within the webview');
  assert(hover.text.length > hover.hint.length, 'short visible copy retains full help');
  await t.evidence('preferences-hover-help');
  await t.driver.keys('\uE00C');
  await until(() => t.driver.observe(() => !document.querySelector('[role="tooltip"]')), 'Escape dismisses help');
  assert(await t.driver.observe(() => !!document.querySelector('.prefs')), 'Escape leaves Preferences open');
  await t.driver.move(tab.x, tab.y);
  await tabTo(t, selector);
  await until(() => t.driver.observe(() => {
    const e = document.activeElement;
    return e?.getAttribute('aria-describedby') === document.querySelector('[role="tooltip"]')?.id;
  }), 'focused help is described by tooltip');
  await t.evidence('preferences-keyboard-help');
  await t.driver.keys('\uE004');
  await until(() => t.driver.observe(() => !document.querySelector('[role="tooltip"]')), 'blur dismisses help');
  const performance = await t.driver.observe(() => {
    const e = [...document.querySelectorAll('.prefs-tabs button')].find(e => e.textContent.trim() === 'Performance');
    const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await t.driver.point(performance.x, performance.y);
  await until(() => t.driver.observe(() => document.querySelector('.prefs .pref-card h4')?.textContent === 'GPU'), 'GPU section first in Performance');
  await click(t, '.prefs-foot button');
  t.measure({ name: 'preferences-help', coverage: ['short copy', 'hover help', 'focus help', 'tooltip bounds', 'Escape', 'blur', 'ARIA description', 'GPU section first in Performance'] });
}
