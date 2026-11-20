// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import assert from 'node:assert/strict';
import { click, openTool, reveal } from '../support/controls.mjs';
import { meanError, openCard, undoRedo } from '../support/cards.mjs';
import { openMaskGroup, panel, textButton } from '../support/scenario.mjs';
import { pause, until } from '../support/webdriver.mjs';
import { setMode } from './editing-mode.mjs';
import { settledPhoto } from './smoke.mjs';

async function checkWheel(t, selector, name) {
  const before = await settledPhoto(t);
  const handle = () => t.driver.observe(s => {
    const style = document.querySelector(`${s} .wheel-handle`)?.style;
    return style ? [parseFloat(style.left), parseFloat(style.top)] : null;
  }, selector);
  const samePosition = (a, b) => a && b && a.every((value, index) => Math.abs(value - b[index]) < .1);
  const expectHandle = async (want, label) => {
    let actual;
    try {
      await until(async () => samePosition(actual = await handle(), want), `${name} wheel position after ${label}`, 5000);
    } catch (error) {
      t.measure({ name, label, expected: want, actual });
      throw error;
    }
  };
  const { x, y, bounds } = await reveal(t, selector);
  const at = (dx, dy) => ({ x: x + dx * bounds.width, y: y + dy * bounds.height });
  const initial = await handle();
  assert(initial, `${name} wheel handle is visible`);
  const first = at(.18, -.15);
  const last = at(-.27, -.21);

  // Pause while the pointer is still held, beyond the normal history merge window.
  let halfway;
  try {
    await t.driver.hold(at(.10, .10), first);
    halfway = await handle();
    await pause(1400);
  } finally {
    await t.driver.dropAt(last, first);
  }
  const ending = await handle();
  assert(halfway && !samePosition(halfway, initial), `${name} wheel moves while held`);
  assert(ending && !samePosition(ending, halfway) && !samePosition(ending, initial), `${name} wheel moves again after the pause`);
  const edited = await settledPhoto(t, photo => photo.hash !== before.hash);
  await t.evidence(`${name}-dragged`);

  for (const [action, want, frame] of [['undo', initial, before], ['redo', ending, edited], ['undo', initial, before]]) {
    await undoRedo(t, action);
    await expectHandle(want, action);
    await settledPhoto(t, photo => meanError(photo, frame) < 1);
  }

  // Two separate gestures on the same wheel, with no render wait between them.
  // Advanced can still be painting an intermediate position after WebDriver
  // returns. Derive the expected positions from the two pointer endpoints.
  const positionAt = ({ x: endX, y: endY }) => {
    const dx = Math.round(endX) - x, dy = y - Math.round(endY);
    const angle = Math.round((Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360) * Math.PI / 180;
    const radius = Math.round(100 * Math.min(1, Math.hypot(dx, dy) / (bounds.width / 2))) / 2;
    return [50 + radius * Math.cos(angle), 50 - radius * Math.sin(angle)];
  };
  const firstEnd = at(.34, .12), secondEnd = at(-.20, .32);
  const quickFirst = positionAt(firstEnd), quickSecond = positionAt(secondEnd);
  await t.driver.drag(at(.12, .05), firstEnd, 20);
  await t.driver.drag(at(-.10, .11), secondEnd, 20);
  const quickFrame = await settledPhoto(t, photo => photo.hash !== before.hash);
  await expectHandle(quickSecond, 'second quick drag');

  for (const [action, want] of [['undo', quickFirst], ['undo', initial], ['redo', quickFirst], ['redo', quickSecond]]) {
    await undoRedo(t, action);
    await expectHandle(want, action);
  }
  await settledPhoto(t, photo => meanError(photo, quickFrame) < 1);
  await t.evidence(`${name}-quick-drags-redone`);
  await undoRedo(t, 'undo');
  await expectHandle(quickFirst, 'undo');
  await undoRedo(t, 'undo');
  await expectHandle(initial, 'undo');
  await settledPhoto(t, photo => meanError(photo, before) < 1);
  t.measure({ name, initial, halfway, ending, quickFirst, quickSecond });
}

export async function wheelUndo(t) {
  await openTool(t, 'adjust');
  const wasAdvanced = await t.driver.observe(() => !!document.querySelector('.advanced-search'));
  try {
    if (wasAdvanced) await setMode(t, 'Simple');
    const grading = await panel(t, 'colorgrading');
    await textButton(t, `${grading} .tabs`, 'Global');
    await checkWheel(t, `${grading} .wheel`, 'simple');

    await openTool(t, 'masks');
    await click(t, '.create-mask');
    await textButton(t, '.shape-menu-list', 'Linear Gradient');
    const photo = await reveal(t, 'svg.mask-svg');
    await t.driver.drag({ x: photo.x, y: photo.y - photo.bounds.height * .2 },
                        { x: photo.x, y: photo.y + photo.bounds.height * .2 });
    await until(() => t.driver.observe(() => !!document.querySelector('.mask-list > li.on .mask-ops')), 'mask created');
    await openMaskGroup(t, 'Color Grading');
    const maskGrading = '.masks-panel section:has(> [data-mask-group="Color Grading"])';
    await textButton(t, `${maskGrading} .tabs`, 'Global');
    await checkWheel(t, `${maskGrading} .wheel`, 'mask');
    await click(t, '.mask-list > li.on .mask-del');

    await setMode(t, 'Advanced');
    const { sel, added } = await openCard(t, 'colorgrading', 'colorbalancergb');
    await checkWheel(t, `${sel} [data-wheel="global_H"] .wheel`, 'advanced');
    if (added) await undoRedo(t, 'undo');
  } finally {
    await openTool(t, 'adjust');
    const isAdvanced = await t.driver.observe(() => !!document.querySelector('.advanced-search'));
    if (isAdvanced !== wasAdvanced) await setMode(t, wasAdvanced ? 'Advanced' : 'Simple');
  }
}
