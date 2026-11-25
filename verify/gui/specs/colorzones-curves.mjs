// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import assert from 'node:assert/strict';
import { until } from '../support/webdriver.mjs';
import { click } from '../support/controls.mjs';
import { choose } from '../support/scenario.mjs';
import { settledPhoto } from './smoke.mjs';
import { inAdvanced, openCard, turnOn, meanError, count, exists, pointAt } from '../support/cards.mjs';

// Advanced mode's Color zones card: the curve editor with its Lightness,
// Chroma and Hue pages (ColorZonesCurve.tsx). Selectors are the roles and
// aria labels the component sets from fields.colorZones.* in en.json; the
// case runs in English, which the isolated profile defaults to.
const TABS = '[role="tablist"][aria-label="Color zones pages"]';

export async function colorzonesCurves(t) {
  await inAdvanced(t, async () => {
    const cz = await openCard(t, 'hsl', 'colorzones');
    await turnOn(t, cz.sel);
    const root = `${cz.sel} .color-zones`;
    const graph = page => `${root} svg.point-curve[aria-label="${page} curve"]`;
    const nodes = sel => t.driver.observe(s => [...document.querySelectorAll(`${s} circle.pt`)].map(c => [+c.getAttribute('cx'), +c.getAttribute('cy')]), sel);
    const pathOf = sel => t.driver.observe(s => document.querySelector(`${s} path.line`)?.getAttribute('d') ?? null, sel);
    const selected = () => t.driver.observe(s => document.querySelector(`${s} [role="tab"][aria-selected="true"]`)?.textContent.trim(), root + ' ' + TABS);
    const history = () => t.driver.observe(() => document.querySelectorAll('.panel.history .history-list li').length);
    const interp = () => t.driver.observe(s => document.querySelector(`${s} .choice-row select.field`).value, root);
    const sameNodes = (a, b, d = 1) => a.length === b.length && a.every((p, i) => Math.abs(p[0] - b[i][0]) <= d && Math.abs(p[1] - b[i][1]) <= d);
    // a node's centre in viewport pixels, read at interaction time
    const nodeAt = (sel, i) => t.driver.observe((s, k) => { const r = document.querySelectorAll(`${s} circle.pt`)[k].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, sel, i);
    const page = async name => {
      await click(t, `${root} ${TABS} [role="tab"]:nth-of-type(${['Lightness', 'Chroma', 'Hue'].indexOf(name) + 1})`);
      await until(async () => (await selected()) === name, `${name} page selected`);
      await until(() => exists(t, graph(name)), `${name} graph`);
    };

    // the History card must be open for its rows to be counted
    if (!await t.driver.observe(() => document.querySelector('.panel.history > .panel-title')?.classList.contains('open')))
      await click(t, '.panel.history > .panel-title');
    await until(() => exists(t, '.history-list'), 'History list shown');

    // 1. three page tabs in order, Hue selected first, the graph and the color band
    await until(() => exists(t, graph('Hue')), 'Hue graph');
    const tabs = await t.driver.observe(s => [...document.querySelectorAll(`${s} [role="tab"]`)].map(e => e.textContent.trim()), root + ' ' + TABS);
    assert.deepEqual(tabs, ['Lightness', 'Chroma', 'Hue'], 'page tabs');
    assert.equal(await selected(), 'Hue', 'Hue is selected first');
    const band = await t.driver.observe(s => { const e = document.querySelector(`${s} .color-zones-band`); const r = e?.getBoundingClientRect(); return e && { w: r.width, h: r.height, image: getComputedStyle(e).backgroundImage }; }, root);
    assert(band && band.w > 50 && band.h > 2 && /gradient/.test(band.image), `color band under the graph: ${JSON.stringify(band)}`);
    t.measure({ name: 'colorzones-initial', tabs, band });
    await t.evidence('colorzones-initial');

    // 2. a click on the hue page adds a node; dragging it up changes the photo
    const g = graph('Hue');
    const n0 = await nodes(g);
    const type0 = await interp();
    const base = await settledPhoto(t);
    const h0 = await history();
    await pointAt(t, g, .5, .5);
    await until(async () => (await nodes(g)).length === n0.length + 1, 'a node added by the click');
    await until(async () => (await history()) > h0, 'history gains an entry for the new node');
    const idx = (await nodes(g)).findIndex(p => !n0.some(q => Math.abs(q[0] - p[0]) < 1));
    assert(idx >= 0, `the new node is found among ${JSON.stringify(await nodes(g))}`);
    const cy0 = (await nodes(g))[idx][1];
    const from = await nodeAt(g, idx);
    await t.driver.drag(from, { x: from.x, y: from.y - 60 });
    await until(async () => (await nodes(g))[idx][1] < cy0 - 10, 'the node moved up');
    const moved = await settledPhoto(t, p => meanError(p, base) > .3);
    t.measure({ name: 'colorzones-hue-drag', nodes: [n0, await nodes(g)], history: [h0, await history()], meanAbsoluteError: meanError(moved, base) });
    assert(meanError(moved, base) > .3, `dragging a hue node changed the photo by ${meanError(moved, base)}`);
    await t.evidence('colorzones-hue-drag');
    const hueNodes = await nodes(g);
    const huePath = await pathOf(g);

    // 3. the interpolation select redraws the path; the other pages keep their own curves
    const other = type0 === '2' ? '0' : '2';
    await choose(t, `${root} .choice-row select.field`, other);
    await until(async () => (await pathOf(g)) !== huePath, 'the interpolation changes the hue path');
    assert.equal(await interp(), other, 'interpolation shown');
    await page('Chroma');
    const chromaNodes = await nodes(graph('Chroma'));
    assert(!sameNodes(chromaNodes, hueNodes), `the Chroma page has its own curve: ${JSON.stringify(chromaNodes)}`);
    assert.notEqual(await pathOf(graph('Chroma')), huePath, 'Chroma path differs from the edited Hue path');
    await t.evidence('colorzones-chroma');
    await page('Lightness');
    assert.notEqual(await pathOf(graph('Lightness')), huePath, 'Lightness path differs from the edited Hue path');
    await t.evidence('colorzones-lightness');
    await page('Hue');
    assert(sameNodes(await nodes(g), hueNodes), 'Hue page keeps its nodes after visiting the other pages');
    assert.equal(await interp(), other, 'Hue page keeps its interpolation');

    // 4. Reset Hue returns the page to its default nodes and interpolation
    const resetBtn = `${root} .equalizer-heading button`;
    const label = await t.driver.observe(s => document.querySelector(s)?.textContent.trim(), resetBtn);
    assert.equal(label, 'Reset Hue', 'reset button names the page');
    await click(t, resetBtn);
    await until(async () => sameNodes(await nodes(g), n0), 'Reset Hue returns the default nodes');
    assert.equal(await interp(), type0, 'Reset Hue restores the interpolation');
    const reset = await settledPhoto(t, p => meanError(p, base) < 1);
    assert(meanError(reset, base) < 1, `after Reset Hue the photo differs by ${meanError(reset, base)}`);
    await t.evidence('colorzones-reset');

    // 5. a double-click removes a node
    await pointAt(t, g, .5, .5);
    await until(async () => (await nodes(g)).length === n0.length + 1, 'a node added again');
    const k = (await nodes(g)).findIndex(p => !n0.some(q => Math.abs(q[0] - p[0]) < 1));
    const at = await nodeAt(g, k);
    await t.driver.point(at.x, at.y, 2);
    await until(async () => (await nodes(g)).length === n0.length, 'a double-click removed the node');
    await t.evidence('colorzones-removed');
  });
}
