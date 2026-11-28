// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { until } from '../support/webdriver.mjs';
import { click, inspect } from '../support/controls.mjs';

const previewName = () => document.querySelector('.modal-backdrop[aria-label="Culling preview"] .culling-lightbox')?.firstElementChild?.textContent ?? null;
const noPreview = () => !document.querySelector('.modal-backdrop[aria-label="Culling preview"]');

async function revealCulling(t) {
  const edge = await t.driver.observe(() => ({ x: innerWidth - 2, y: innerHeight / 2 }));
  await t.driver.move(edge.x, edge.y);
  await until(() => t.driver.observe(() => {
    const slot = document.querySelector('.right-slot');
    return slot && !slot.classList.contains('closed')
      && (!slot.classList.contains('floating') || slot.classList.contains('revealed'));
  }), 'Culling panel is revealed');
  await until(() => t.driver.observe(() => !document.querySelector('.app')?.classList.contains('sliding')
    && !document.getAnimations().some(a => a.playState === 'running' && a.effect?.target?.closest?.('.right-slot'))),
  'Culling panel slide settles');
}

export async function cullingPanel(t) {
  await until(() => t.driver.observe(() => document.querySelectorAll('.filmstrip .thumb[data-imgid]').length >= 3),
    'three photos in the folder', 120000);
  await t.driver.keys('g');
  await until(() => t.driver.observe(() => !!document.querySelector('.filmstrip.grid')), 'grid view');
  const cells = await t.driver.observe(() => [...document.querySelectorAll('.filmstrip.grid .thumb[data-imgid]')].map(c => {
    const r = c.getBoundingClientRect();
    return { id: c.dataset.imgid, title: c.title, x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }));
  assert(cells.length >= 3, 'three grid photos are visible');
  await click(t, `.filmstrip.grid .thumb[data-imgid="${cells[1].id}"]`);
  await until(() => t.driver.observe(id => document.querySelector(`.filmstrip.grid .thumb[data-imgid="${id}"]`)?.classList.contains('active'), cells[1].id), 'second photo selected');

  await click(t, 'button[data-tour="culling"]');
  await revealCulling(t);
  const panel = await until(() => t.driver.observe(() => {
    const aside = document.querySelector('.right');
    const title = aside?.querySelector('.culling-card .panel-title-toggle');
    const action = aside?.querySelector('.culling-action');
    const find = aside?.querySelector('.find-pop');
    const chevron = find?.querySelector('.panel-title-toggle .chevron');
    const reset = find?.querySelector('.find-clear');
    return aside && title?.textContent === 'Culling' && action && { grid: !!document.querySelector('.filmstrip.grid'),
      find: !!aside.querySelector('[role="search"][aria-label="Find"]'),
      chevrons: aside.querySelectorAll('.library-right-panels .panel-title-toggle .chevron').length,
      chevronAfterReset: chevron && reset && chevron.getBoundingClientRect().left >= reset.getBoundingClientRect().right,
      findGap: find?.getBoundingClientRect().top - aside.querySelector('.library-right-panels .culling-action:last-child').getBoundingClientRect().bottom, preview: !!document.querySelector('.culling-lightbox') };
  }), 'Culling panel opens over the grid');
  assert(panel.grid, 'opening Culling keeps the grid and selection active');
  assert.equal(panel.chevrons, 2, 'Both panel titles have chevrons');
  assert(panel.chevronAfterReset, 'Find chevron is to the right of Reset');
  assert(panel.findGap >= 0 && panel.findGap < 24, 'Find follows the last Culling action');
  assert(panel.find, 'Find remains below Culling in the Library column');
  assert(!panel.preview, 'opening Culling does not launch the preview');

  await click(t, 'button[data-tour="prefs"]');
  const focus = '[data-pref-label="Focus mode"] input.switch';
  await until(() => t.driver.observe(s => !!document.querySelector(s), focus), 'Focus mode setting');
  if (!await t.driver.observe(s => document.querySelector(s).checked, focus)) await click(t, focus);
  await click(t, '.prefs-foot button');
  await until(() => t.driver.observe(() => !document.querySelector('.prefs')), 'Preferences closed');
  await click(t, '.culling-card .panel-title-toggle'); // fold Culling, keeping Find open
  await click(t, '.culling-card .panel-title-toggle'); // opening Culling folds Find
  assert(await t.driver.observe(() => !document.querySelector('.find-pop .find-head')),
    'Focus mode collapses Find when Culling expands');
  await click(t, '.find-pop .panel-title-toggle');
  await until(() => t.driver.observe(() => !document.querySelector('.library-right-panels .culling-card .culling-panel')),
    'Focus mode collapses Culling when Find expands');
  await click(t, '.culling-card .panel-title-toggle');
  const findTitle = await t.driver.observe(inspect, '.find-pop .panel-title-toggle');
  await t.driver.pointWithModifier(findTitle.x, findTitle.y, '\uE00A');
  assert(await t.driver.observe(() => !!document.querySelector('.library-right-panels .culling-card .culling-panel')
    && !!document.querySelector('.find-pop .find-head')), 'Alt-click expands Find alongside Culling in Focus mode');
  await click(t, 'button[data-tour="culling"]');
  await revealCulling(t);

  const rows = await t.driver.observe(() => [...document.querySelectorAll('.library-right-panels .culling-action')].map(b => ({
    text: b.textContent.trim(), disabled: b.disabled, color: getComputedStyle(b).color,
  })));
  assert.equal(rows.length, 7, 'the panel shows the preview action and six planned actions');
  assert.equal(rows[0].disabled, false, 'Culling Preview is enabled');
  assert(rows.slice(1).every(row => row.disabled), 'Compare, Survey, Auto Cull and Scenes actions are disabled');
  assert(rows.slice(1).every(row => row.color !== rows[0].color), 'disabled actions are visibly dimmed');
  assert.equal(await t.driver.observe(() => document.querySelectorAll('.library-right-panels .culling-panel .group-label span').length), 2, 'Auto Cull and Scenes show Coming soon');
  await t.evidence('culling-panel');

  await click(t, '[data-panel-toggle="find"]');
  await until(() => t.driver.observe(() => document.querySelector('.right-slot')?.classList.contains('closed')), 'Culling panel closes');
  await click(t, 'button[data-tour="culling"]');
  await revealCulling(t);
  await until(() => t.driver.observe(() => !document.querySelector('.right-slot')?.classList.contains('closed')), 'Culling panel reopens');

  // A real coordinate click on a native disabled button cannot open anything.
  const disabled = await t.driver.observe(() => {
    const b = document.querySelectorAll('.library-right-panels .culling-action')[1], r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await t.driver.point(disabled.x, disabled.y);
  assert(await t.driver.observe(noPreview), 'disabled Compare does not open a preview');

  const selectedName = cells[1].title;
  await t.driver.keys('f');
  await until(async () => { const name = await t.driver.observe(previewName); return name?.startsWith(selectedName) && name; },
    'F opens the selected photo in the existing lightbox');
  await t.evidence('culling-panel-f-preview');
  await t.driver.keys('\uE00C');
  await until(() => t.driver.observe(noPreview), 'F preview closes with Escape');
  await click(t, '.library-right-panels .culling-action:not(:disabled)');
  await until(async () => { const name = await t.driver.observe(previewName); return name?.startsWith(selectedName) && name; },
    'panel action opens the selected photo');
  await t.driver.keys('\uE00C');
  await until(() => t.driver.observe(noPreview), 'panel preview closes');
  await click(t, '[data-menu="View"]');
  await click(t, '[data-menu-item="culling-preview"]');
  await until(async () => { const name = await t.driver.observe(previewName); return name?.startsWith(selectedName) && name; },
    'View menu still opens the selected photo');
  await t.driver.keys('\uE00C');
  await until(() => t.driver.observe(noPreview), 'menu preview closes');

  await click(t, 'button[data-tour="prefs"]');
  const autoHide = '[data-pref-label="Auto-hide panels"] input.switch';
  await until(() => t.driver.observe(s => !!document.querySelector(s), autoHide), 'Auto-hide setting');
  if (!await t.driver.observe(s => document.querySelector(s).checked, autoHide)) await click(t, autoHide);
  await click(t, '.prefs-foot button');
  await until(() => t.driver.observe(() => !document.querySelector('.prefs')), 'Preferences closed');
  const pin = async () => t.driver.observe(() => {
    const b = document.querySelector('.right .panel-head button.pin');
    if (!b) return null;
    const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, on: b.classList.contains('on') };
  });
  await revealCulling(t);
  await click(t, '.library-right-panels .culling-card .pin');
  await until(async () => (await pin())?.on, 'right panel pinned');
  await t.driver.move(cells[1].x, cells[1].y);
  await until(async () => (await pin())?.on, 'pinned panel remains available');
  assert(await t.driver.observe(() => !document.querySelector('.right-slot')?.classList.contains('floating')),
    'pinning keeps the Culling panel docked while the pointer is away');

  const themes = ['Dark', 'Darktable Grey', 'Light'];
  await click(t, 'button[data-tour="prefs"]');
  const themeBackgrounds = [];
  for (const name of themes) {
    await click(t, `[role="group"][aria-label="Theme"] button[aria-label=${JSON.stringify(name)}]`);
    const appearance = await t.driver.observe(() => {
      const action = document.querySelector('.culling-action');
      const style = getComputedStyle(action);
      return { theme: document.documentElement.dataset.theme, color: style.color, background: style.backgroundColor };
    });
    assert.equal(appearance.theme, name.toLowerCase().replace('darktable ', ''), `${name}: theme is applied`);
    assert.notEqual(appearance.background, 'rgba(0, 0, 0, 0)', `${name}: action has a themed surface`);
    assert.notEqual(appearance.color, appearance.background, `${name}: action text contrasts with its surface`);
    themeBackgrounds.push(appearance.background);
    t.measure({ name: `culling-theme-${name}`, ...appearance });
    await t.evidence(`culling-theme-${name.toLowerCase().replaceAll(' ', '-')}`);
  }
  assert.equal(new Set(themeBackgrounds).size, 3, 'Culling actions follow all three built-in themes');
  await click(t, `[role="group"][aria-label="Theme"] button[aria-label="Dark"]`);
  await click(t, '.prefs-foot button');
  await until(() => t.driver.observe(() => !document.querySelector('.prefs')), 'Preferences closed');
  t.measure({ name: 'culling-panel', previewSource: 'panel, F, View menu', themes, disabledActions: rows.slice(1).map(row => row.text), pinned: true });
}
