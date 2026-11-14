// SPDX-License-Identifier: GPL-3.0-or-later
// Presence's Texture and Clarity on contrast & texture (DetailControls.tsx,
// detailRows): each one's detail sliders sit in a shaded box headed by its
// name, labeled without the prefix; More controls adds the rest, the tuning
// ones a gap below the three bands
import assert from 'node:assert/strict';
import { until } from '../support/webdriver.mjs';
import { click, reveal } from '../support/controls.mjs';
import { Blocked, panel, expandSections } from '../support/scenario.mjs';

const groups = () => [...document.querySelectorAll('[data-panel-id="basic"] .detail-group')].map((g) => {
  const r = g.getBoundingClientRect(), bg = getComputedStyle(g).backgroundColor;
  const rows = [...g.querySelectorAll('[data-control-id]')].map((e) => ({
    id: e.dataset.controlId,
    label: e.querySelector('label, .label')?.textContent.trim() ?? '',
    gap: !!e.closest('.detail-tuning'), compact: e.classList.contains('compact'),
    top: e.getBoundingClientRect().top, bottom: e.getBoundingClientRect().bottom,
  }));
  return { head: g.dataset.detailGroup, title: g.querySelector('.subcard-head')?.textContent.trim(), rows, bg, width: r.width, height: r.height };
});
const toggle = '[data-panel-id="basic"] > .panel-title [data-advanced-toggle]';
const pressed = () => document.querySelector('[data-panel-id="basic"] > .panel-title [data-advanced-toggle]')?.getAttribute('aria-pressed');

function check(found, more) {
  for (const [title, name] of [['Texture', 'texture'], ['Clarity', 'clarity']]) {
    const g = found.find((x) => x.head === title);
    assert(g, `${name} has a detail box`);
    assert.equal(g.title, title, `${name}'s box heading`);
    assert(g.bg !== 'rgba(0, 0, 0, 0)' && g.bg !== 'transparent', `${name}'s box is shaded (${g.bg})`);
    const ids = g.rows.map((r) => r.id);
    const want = more
      ? ['coarse', 'medium', 'fine', 'level', 'halo', 'bias', 'shadows', 'highlights']
      : ['medium', 'fine'];
    assert.equal(ids.length, want.length, `${name}: ${ids.join(', ')}`);
    for (const r of g.rows) {
      assert(r.id.startsWith(`detail_${name}_`), `${r.id} is ${name}'s`);
      assert(!/^(Texture|Clarity):/.test(r.label), `${r.id} label "${r.label}" has no prefix`);
      assert(!r.compact, `${r.id} keeps its track under the label`);
    }
    const gaps = g.rows.filter((r) => r.gap).map((r) => r.id);
    assert.deepEqual(gaps, more ? [`detail_${name}_detail_level`] : [], `${name}'s gap row`);
  }
}

export async function detailGroup(t) {
  await panel(t, 'basic');
  await expandSections(t, '[data-panel-id="basic"]');
  if (!await t.driver.observe(s => !!document.querySelector(s), '[data-control-id="detail_texture_gain_medium"]'))
    throw new Blocked('Texture\'s detail sliders are not shown: contrast & texture is not the chosen module');
  const start = await t.driver.observe(pressed);
  if (start === 'true') { await click(t, toggle); await until(async () => (await t.driver.observe(pressed)) === 'false', 'More controls off'); }

  await reveal(t, '[data-detail-group="Texture"]');
  const off = await until(async () => { const g = await t.driver.observe(groups); return g.length >= 2 && g; }, 'detail boxes');
  t.measure({ name: 'more-off', groups: off });
  await t.evidence('detail-group-off');
  check(off, false);

  await click(t, toggle);
  await until(async () => (await t.driver.observe(pressed)) === 'true', 'More controls on');
  await reveal(t, '[data-control-id="detail_texture_detail_level"]');
  const on = await until(async () => { const g = await t.driver.observe(groups); return g.find((x) => x.head === 'Texture')?.rows.length === 8 && g; }, 'full detail boxes');
  t.measure({ name: 'more-on', groups: on });
  await t.evidence('detail-group-on');
  await reveal(t, '[data-control-id="detail_clarity_gain_highlights"]');
  await t.evidence('detail-group-on-clarity');
  check(on, true);
  const tex = on.find((x) => x.head === 'Texture');
  const fine = tex.rows.find((r) => r.id.endsWith('gain_fine')), level = tex.rows.find((r) => r.gap);
  const medium = tex.rows.find((r) => r.id.endsWith('gain_medium'));
  assert(level.top - fine.bottom > fine.top - medium.bottom + 4, `tuning gap ${level.top - fine.bottom}px over band spacing ${fine.top - medium.bottom}px`);

  // leave More controls as found
  if (start !== 'true') { await click(t, toggle); await until(async () => (await t.driver.observe(pressed)) === 'false', 'More controls restored'); }
}
