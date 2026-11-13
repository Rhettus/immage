// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
// Help > Create Support Bundle: the scrubbed preview, its file tabs, and the
// line selection. Save... and Add GUI Benchmark Report... open native dialogs,
// which are outside the app-only boundary, so they are never clicked.
import assert from 'node:assert/strict';
import os from 'node:os';
import { click, reveal } from '../support/controls.mjs';
import { textButton } from '../support/scenario.mjs';
import { until, pause } from '../support/webdriver.mjs';
import { settledPhoto } from './smoke.mjs';

const ESC = '\uE00C';
const DIALOG = '.modal.support-bundle';
const ROW = 18; // SupportBundleDialog.tsx
const FILES = ['engine.log', 'system.json', 'preferences.json'];

const isOpen = t => t.driver.observe(sel => !!document.querySelector(sel), DIALOG);
const expanded = (t, name) => t.driver.observe(n => document.querySelector(`[data-menu="${n}"]`)?.getAttribute('aria-expanded') === 'true', name);

async function openDialog(t) {
  if (!await expanded(t, 'Help')) await click(t, '[data-menu="Help"]');
  await until(() => expanded(t, 'Help'), 'Help menu open');
  await click(t, '[data-menu-item="support-bundle"]');
  await until(() => isOpen(t), 'the Support Bundle dialog opens');
  // Collecting... until the engine's preview arrives
  await until(() => t.driver.observe(() => document.querySelectorAll('.sb-tab').length > 0 && !!document.querySelector('.sb-line')), 'bundle preview shown', 60000);
}

const tabNames = t => t.driver.observe(() => [...document.querySelectorAll('.sb-tab')].map(b => b.textContent.replace(/ \(\d+ left out\)$/, '')));
const activeTab = t => t.driver.observe(() => document.querySelector('.sb-tab.on')?.textContent.replace(/ \(\d+ left out\)$/, ''));
async function selectTab(t, name) {
  const names = await tabNames(t);
  const k = names.indexOf(name);
  assert(k >= 0, `tab ${name} exists in ${JSON.stringify(names)}`);
  await click(t, `.sb-tabs .sb-tab:nth-child(${k + 1})`);
  await until(async () => await activeTab(t) === name, `tab ${name} active`);
  await until(() => t.driver.observe(() => !!document.querySelector('.sb-line')), `${name} lines rendered`);
}

// the rendered lines: index from the row's top, full text from its title
const rendered = t => t.driver.observe(row => [...document.querySelectorAll('.sb-line')].map(e => ({
  i: Math.round(parseFloat(e.style.top) / row), text: e.title, gone: e.classList.contains('gone'),
  decoration: getComputedStyle(e).textDecorationLine, bounds: (r => ({ x: r.x, y: r.y, width: r.width, height: r.height }))(e.getBoundingClientRect()),
})), ROW);
const list = t => t.driver.observe(() => {
  const e = document.querySelector('.sb-lines'), r = e.getBoundingClientRect();
  return { top: e.scrollTop, height: e.scrollHeight, client: e.clientHeight, x: r.x + 24, y: r.y + r.height / 2, bottom: r.bottom, topEdge: r.top };
});
const header = t => t.driver.observe(() => [...document.querySelectorAll('.modal.support-bundle .modal-body > p')].map(p => p.textContent).join('\n'));

// scroll the whole list with real wheel input, collecting every line seen. The
// rows rendered ahead of the view mean 500 px per wheel leaves no gap.
async function readAll(t, maxSteps = 200) {
  const seen = new Map();
  const take = async () => { for (const l of await rendered(t)) seen.set(l.i, l.text); };
  await take();
  let stuck = 0, steps = 0, edge = false;
  for (; steps < maxSteps; steps++) {
    const before = await list(t);
    if (before.top + before.client >= before.height - 1) { edge = true; break; }
    await t.driver.wheel(before.x, before.y, 500);
    await until(async () => (await list(t)).top !== before.top || ++stuck > 6, 'list scrolled');
    const after = await list(t);
    if (after.top === before.top) { if (++stuck >= 2) break; } else stuck = 0;
    await take();
  }
  await take();
  const all = await list(t);
  return { seen, steps, complete: edge || all.top + all.client >= all.height - 1, rows: Math.round(all.height / ROW) };
}
async function toTop(t) {
  for (let n = 0; n < 400; n++) {
    const s = await list(t);
    if (s.top <= 0) return;
    await t.driver.wheel(s.x, s.y, -Math.max(500, s.top));
    await pause(60);
  }
  throw Error('could not scroll the list back to the top');
}

export async function supportBundle(t) {
  await settledPhoto(t);
  const home = os.homedir(), user = os.userInfo().username, host = os.hostname();
  const stem = t.fixture.file.replace(/\.[^.]+$/, '');
  const forbidden = [['home folder', home], ['login name', user], ['host name', host], ['host name first label', host.split('.')[0]],
    ['fixture photo stem', stem], ['fixture folder name', '/fixtures']].filter(([, v]) => v && v.length > 1 && v !== '/');
  // the stem could be a word of a placeholder (photo-N); then it proves nothing
  const stemUsable = !/^(photo|folder|home|user|host)$/i.test(stem);
  const lower = s => s.toLowerCase();

  // 1. Help > Create Support Bundle...
  await openDialog(t);
  const names = await tabNames(t);
  for (const f of FILES) assert(names.includes(f), `tab ${f} is shown: ${JSON.stringify(names)}`);
  const intro = await header(t);
  assert(/Replaced:|Nothing needed replacing\./.test(intro), `the replacement counts are shown: ${intro}`);
  assert(/Replaced:/.test(intro), `at least one replacement was counted (the fixture path, user or host name): ${intro}`);
  t.measure({ name: 'bundle-open', tabs: names, counts: intro });
  await t.evidence('support-bundle-open');

  // 2. no private value in the rendered text of any tab; system.json has an id and no host key
  const placeholders = new Set(), texts = {}, coverage = {};
  for (const name of names) {
    await selectTab(t, name);
    await toTop(t);
    const { seen, steps, complete, rows } = await readAll(t);
    const text = [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => l).join('\n');
    texts[name] = text;
    coverage[name] = { rows, read: seen.size, steps, complete };
    for (const [what, value] of forbidden) {
      if (what === 'fixture photo stem' && !stemUsable) continue;
      assert(!lower(text).includes(lower(value)), `${name} does not contain the ${what} (${what === 'login name' || what === 'home folder' ? 'redacted in this report' : value})`);
    }
    for (const m of text.matchAll(/\b(?:photo|folder)-[0-9a-z]+|~/gi)) placeholders.add(m[0]);
    if (name === 'system.json') {
      assert(!/"host"\s*:/.test(text), 'system.json has no "host" key');
      assert(/"id"\s*:/.test(text), 'system.json contains an "id"');
    }
  }
  for (const [what, value] of forbidden) {
    if (what === 'fixture photo stem' && !stemUsable) continue;
    assert(!lower(intro).includes(lower(value)), `the dialog text does not contain the ${what}`);
  }
  // soft: the log or preferences need not name the open photo or folder
  t.measure({ name: 'bundle-scrub', coverage, placeholders: [...placeholders].slice(0, 20),
    note: placeholders.size ? 'placeholders seen in the text' : 'SOFT: no photo-/folder-/~ placeholder was seen; the text may not reference the open photo or folder' });

  // 3. virtualization on engine.log: different lines after a wheel, and the list scrolls
  await selectTab(t, 'engine.log');
  await toTop(t);
  const first = await rendered(t), s0 = await list(t);
  assert(s0.height > s0.client, `engine.log is scrollable (content ${s0.height}px, view ${s0.client}px)`);
  const domRows = first.length;
  assert(domRows < s0.height / ROW || s0.height / ROW <= 40, `rows are virtualized: ${domRows} in the DOM of ${Math.round(s0.height / ROW)}`);
  await t.driver.wheel(s0.x, s0.y, 500);
  await until(async () => (await list(t)).top > s0.top, 'engine.log list scrolled by the wheel');
  const after = await rendered(t);
  assert(after.some(l => !first.some(f => f.i === l.i)), 'different lines are rendered after scrolling');
  assert(after[0].i > first[0].i || after.at(-1).i > first.at(-1).i, 'the rendered window moved down');
  await toTop(t);

  // 4. click removes a line, click again restores it
  const target = (await rendered(t)).find(l => l.i === 2 && l.bounds.height > 0) ?? (await rendered(t))[2];
  const lineAt = async i => (await rendered(t)).find(l => l.i === i);
  const clickLine = async i => { const l = await lineAt(i); assert(l, `line ${i} is rendered`); await t.driver.point(l.bounds.x + l.bounds.width / 2, l.bounds.y + l.bounds.height / 2); };
  const i0 = target.i;
  assert(!target.gone, 'a line starts as kept');
  await clickLine(i0);
  await until(async () => (await lineAt(i0))?.gone, `line ${i0} marked removed`);
  const struck = await lineAt(i0);
  assert(/line-through/.test(struck.decoration), `a removed line is struck through: ${struck.decoration}`);
  await until(async () => /\(1 left out\)/.test(await t.driver.observe(() => document.querySelector('.sb-tab.on').textContent)), 'the tab shows 1 left out');
  assert(/Save \(1 left out\)/.test(await t.driver.observe(() => document.querySelector('.modal-foot .btn.primary')?.textContent ?? '')), 'Save shows the removed count');
  await t.evidence('support-bundle-line-removed');
  await clickLine(i0);
  await until(async () => !(await lineAt(i0))?.gone, `line ${i0} restored`);
  assert(!/left out/.test(await t.driver.observe(() => document.querySelector('.sb-tab.on').textContent)), 'no count once restored');

  // 5. shift-click a second line removes the range between
  await clickLine(i0);
  await until(async () => (await lineAt(i0))?.gone, `line ${i0} removed again`);
  const j = i0 + 4, jl = await lineAt(j);
  assert(jl, `line ${j} is rendered`);
  await t.driver.modifiedPoint('', jl.bounds.x + jl.bounds.width / 2, jl.bounds.y + jl.bounds.height / 2);
  await until(async () => { const r = await rendered(t); return r.filter(l => l.i >= i0 && l.i <= j).every(l => l.gone); }, `lines ${i0}..${j} removed by Shift-click`);
  const inside = (await rendered(t)).filter(l => l.i >= i0 && l.i <= j);
  assert.equal(inside.length, j - i0 + 1, 'every line in the range is rendered');
  assert((await rendered(t)).filter(l => l.gone).length >= j - i0 + 1, 'the range is struck through');
  await until(async () => new RegExp(`\\(${j - i0 + 1} left out\\)`).test(await t.driver.observe(() => document.querySelector('.sb-tab.on').textContent)), 'the tab counts the range');
  t.measure({ name: 'bundle-lines', range: [i0, j], removed: j - i0 + 1 });
  await t.evidence('support-bundle-range-removed');

  // 6. Cancel closes; reopening and Escape closes
  await textButton(t, `${DIALOG} .modal-foot`, 'Cancel');
  await until(async () => !(await isOpen(t)), 'Cancel closes the dialog');
  await openDialog(t);
  assert((await tabNames(t)).includes('engine.log'), 'the reopened dialog shows the bundle');
  assert(!/left out/.test(await t.driver.observe(() => document.querySelector('.sb-tabs').textContent)), 'a reopened dialog starts with nothing left out');
  await t.driver.keys(ESC);
  await until(async () => !(await isOpen(t)), 'Escape closes the dialog');
  await settledPhoto(t);
}
