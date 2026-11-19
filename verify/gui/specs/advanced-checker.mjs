// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import assert from 'node:assert/strict';
import { box, count, inAdvanced, meanError, openCard, turnOn, undoRedo } from '../support/cards.mjs';
import { click, inspect } from '../support/controls.mjs';
import { until } from '../support/webdriver.mjs';
import { Blocked } from '../support/scenario.mjs';
import { settledPhoto } from './smoke.mjs';

export async function advancedChecker(t) {
  if (t.fixture.name !== "checker") throw new Blocked("advanced-checker requires --fixture checker");
  await inAdvanced(t, async () => {
    const { sel } = await openCard(t, 'basic', 'channelmixerrgb');
    await turnOn(t, sel);
    const baseline = await settledPhoto(t);
    const control = suffix => `${sel} [data-control-id="adv:checker${suffix}"]`;
    await click(t, control(''));
    await until(async () => await count(t, '.checker-box polygon') === 25, 'chart outline and 24 patches');
    assert.equal(await count(t, '.checker-corner'), 4);
    const handle = '.checker-corner:first-of-type';
    const first = await box(t, handle);
    const from = { x: first.x + first.w / 2, y: first.y + first.h / 2 };
    await t.driver.drag(from, { x: from.x + 9, y: from.y + 7 });
    await until(async () => (await box(t, handle)).x > first.x + 4, 'the corner moves after dragging');
    await click(t, control('-recompute'));
    await until(() => t.driver.observe(s => document.querySelector(s)?.disabled === false, control('-accept')), 'computed profile');
    assert.equal(await count(t, `${sel} .checker-matrix td`), 9);
    await t.evidence('computed-profile');
    await click(t, control('-accept'));
    await settledPhoto(t, frame => meanError(frame, baseline) > 0.05);
    await click(t, control('-validate'));
    await until(() => t.driver.observe(s => document.querySelector(s)?.textContent.includes('Output ΔE'), `${sel} .checker-report`), 'output validation report');
    assert.equal(await count(t, `${sel} .checker-matrix td`), 0);
    assert.equal((await t.driver.observe(inspect, control('-accept'), null)).disabled, true);
    await t.evidence('validated-profile');
    await undoRedo(t, 'undo');
    await settledPhoto(t, frame => meanError(frame, baseline) < 1);
  });
}
