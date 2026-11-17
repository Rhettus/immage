// SPDX-License-Identifier: GPL-3.0-or-later
// Preferences > Immich (ImmichPrefs.tsx): the path fields and the example line
// under "Opening search results". Types example values only, no API key and no
// server contact, and takes the screenshot app/docs/images/immich-prefs.png is
// cut from. The local folder is a directory inside this run's fixture folder, or
// the existing directory named by DOC_LOCAL_DIR (a neutral path for the guide)
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Blocked } from '../support/scenario.mjs';
import { click, reveal } from '../support/controls.mjs';
import { until } from '../support/webdriver.mjs';

const row = (label) => `[data-pref-label=${JSON.stringify(label)}]`;
const LABELS = ['Destination as Immich sees it', 'External library path', 'Folder on this computer'];

// real key input to the field the pointer click just focused; WebDriver's
// element send-keys delivers ':' which per-key actions would send unshifted
async function typeInto(t, label, text) {
  const selector = `${row(label)} input.field`;
  await click(t, selector);
  await t.driver.guard();
  const found = await t.driver.command('POST', '/element', { using: 'css selector', value: selector });
  const id = Object.values(found)[0];
  await t.driver.command('POST', `/element/${id}/value`, { text });
  await until(() => t.driver.observe((s, v) => document.querySelector(s)?.value === v, selector, text), `${label} holds ${text}`);
}

export async function immichPrefs(t) {
  const root = t.fixtureDir;
  if (!root) throw new Blocked('no fixture folder');
  const local = process.env.DOC_LOCAL_DIR || join(root, 'photos');
  if (!process.env.DOC_LOCAL_DIR) await mkdir(local, { recursive: true });

  await click(t, 'button[data-tour="prefs"]');
  const tab = await until(() => t.driver.observe(() => {
    const e = [...document.querySelectorAll('.prefs-tabs button')].find(e => e.textContent.trim() === 'Immich');
    if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }), 'Immich preferences tab');
  await t.driver.point(tab.x, tab.y);
  await until(() => t.driver.observe(s => !!document.querySelector(s), row('Server URL')), 'the Immich tab');

  await typeInto(t, 'Server URL', 'https://photos.example.com');
  await click(t, `${row('Match the folder path')} input.switch`);
  await until(() => t.driver.observe(s => !!document.querySelector(s), row(LABELS[0])), `${LABELS[0]} after the switch`);
  await typeInto(t, LABELS[0], '/mnt/photos');
  await typeInto(t, LABELS[1], '/mnt/photos');
  await typeInto(t, LABELS[2], local);

  // the reachability check runs a moment after typing stops
  const example = () => t.driver.observe(() => {
    const cards = [...document.querySelectorAll('.pref-card')];
    const card = cards.find(c => c.querySelector('[data-pref-label="External library path"]'));
    return { example: [...(card?.querySelectorAll('.pref-card-lead') ?? [])].map(e => e.textContent.trim()).find(x => x.startsWith('✓')) ?? null,
             warned: !!card?.textContent.includes('not available'), title: card?.querySelector('.pref-card-title, h3, h4')?.textContent };
  });
  const seen = await until(async () => { const r = await example(); return r.example ? r : null; }, 'the ✓ example line');
  assert(!seen.warned, 'no "not available" warning');
  const labels = await t.driver.observe((l) => l.filter(x => !!document.querySelector(`[data-pref-label="${x}"]`)), LABELS);
  assert.deepEqual(labels, LABELS, 'the three path labels are present');
  const opening = await t.driver.observe(() => document.body.textContent.includes('Opening search results'));
  assert(opening, 'the Opening search results card is present');

  await reveal(t, `${row('Folder on this computer')} input.field`);
  const dialog = await t.driver.observe(() => {
    const r = document.querySelector('.prefs').getBoundingClientRect();
    const last = [...document.querySelectorAll('.pref-card-lead')].pop().getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, lastBottom: last.bottom, viewport: [innerWidth, innerHeight], scale: devicePixelRatio };
  });
  assert(dialog.lastBottom <= dialog.y + dialog.height, `the example line is inside the dialog (${JSON.stringify(dialog)})`);
  t.measure({ name: 'immich-prefs', example: seen.example, local, dialog });
  await t.evidence('immich-prefs');
  await click(t, '.prefs-foot button');
  await until(() => t.driver.observe(() => !document.querySelector('.prefs')), 'Preferences closed');
}
