// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { click } from '../support/controls.mjs';
import { until } from '../support/webdriver.mjs';
import { dismissTour, settledPhoto } from './smoke.mjs';

const grid = '.filmstrip.grid';
const dialog = '[data-grid-keywords-dialog]';
const editor = '.panel.keywording';
const removed = 'GUI Keywords > Paris';
const retained = 'GUI Keywords > London';
const input = scope => `${scope} .kw-add input`;
const chip = (scope, title) => `${scope} .kw-chip[title="${title}"]`;
const recent = (scope, title) => `${scope} .kw-recent-keyword[title="${title}"]`;
const dismiss = (scope, title) => `${scope} .kw-recent-remove[aria-label="Remove ${title} from recent keywords"]`;

const present = (t, selector) => t.driver.observe(s => !!document.querySelector(s), selector);
const appears = (t, selector) => until(() => present(t, selector), `appears: ${selector}`);
const disappears = (t, selector) => until(async () => !await present(t, selector), `disappears: ${selector}`);

async function openGridKeywords(t) {
  if (!await present(t, grid)) await t.driver.keys('g');
  const cell = `${grid} .thumb[data-imgid]`;
  await appears(t, cell);
  await click(t, cell);
  await t.driver.keys('k');
  await appears(t, input(dialog));
}

export async function recentKeywords(t) {
  await openGridKeywords(t);
  await click(t, input(dialog));
  await t.driver.keys(...`${removed}, ${retained}`, '\uE007');
  await appears(t, chip(dialog, removed));
  await appears(t, recent(dialog, retained));
  await t.evidence('recent-keywords-before');
  await click(t, dismiss(dialog, removed));
  await disappears(t, recent(dialog, removed));
  assert(await present(t, recent(dialog, retained)), 'the other recent keyword remains');
  assert(await present(t, chip(dialog, removed)), 'removing a recent entry preserves its photo keyword');
  await t.evidence('recent-keywords-after');

  await click(t, `${dialog} button[aria-label="Close (F / Esc)"]`);
  await disappears(t, dialog);
  await t.driver.keys('g');
  await appears(t, `${editor} .panel-title`);
  if (!await present(t, input(editor))) await click(t, `${editor} .panel-title`);
  await appears(t, chip(editor, removed));
  assert(await present(t, recent(editor, retained)), 'the editor sees the same recent list');
  assert(!await present(t, recent(editor, removed)), 'the removed entry stays absent in the editor');

  await t.restart();
  await dismissTour(t);
  await settledPhoto(t);
  await openGridKeywords(t);
  await appears(t, chip(dialog, removed));
  await appears(t, recent(dialog, retained));
  assert(!await present(t, recent(dialog, removed)), 'the removal survives an application restart');

  await click(t, input(dialog));
  await t.driver.keys(...removed, '\uE007');
  await appears(t, recent(dialog, removed));
  await t.evidence('recent-keywords-reused');
}
