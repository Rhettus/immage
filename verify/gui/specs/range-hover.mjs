// SPDX-License-Identifier: GPL-3.0-or-later
// Hovering a mask range previews its selection; O hides and restores it while
// the pointer stays over the range controls. Heal's Fill range has the same
// hover and keyboard behavior.
import assert from 'node:assert/strict';
import { click, openTool, reveal } from '../support/controls.mjs';
import { textButton } from '../support/scenario.mjs';
import { until } from '../support/webdriver.mjs';

const alpha = () => {
  let max = 0, count = 0;
  for (const c of document.querySelectorAll('canvas.mask-tint')) {
    if (!c.width || !c.height) continue;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i]) { max = Math.max(max, d[i]); count++; }
  }
  return { max, count };
};
async function shown(t, label) {
  return until(async () => {
    const a = await t.driver.observe(alpha);
    return a?.count > 0 ? a : false;
  }, label, 15000);
}
async function hidden(t, label) {
  await until(async () => (await t.driver.observe(alpha))?.count === 0, label, 15000);
}

async function maskRange(t, name, control) {
  await click(t, '.create-mask');
  await textButton(t, '.shape-menu-list', name);
  const photo = await reveal(t, 'svg.mask-svg');
  await t.driver.point(photo.x, photo.y);
  await until(() => t.driver.observe(() => !!document.querySelector('.mask-list > li.on')), `${name} mask selected`);
  const settings = '.masks-panel > .panel:first-child h3.fold';
  if (!await t.driver.observe(s => !!document.querySelector(s)?.querySelector('.chevron.open'), settings))
    await click(t, settings);
  const range = await reveal(t, `[data-control-id="${control}"] input[type="range"]`);
  await t.driver.move(photo.x, photo.y);
  if ((await t.driver.observe(alpha))?.count) {
    await t.driver.keys('o');
    await hidden(t, `${name} baseline overlay off`);
  }
  await t.driver.move(range.x, range.y);
  const preview = await shown(t, `${name} range hover preview`);
  assert(preview.max > 0, `${name} preview has visible overlay pixels`);
  await t.evidence(`${name.toLowerCase().replaceAll(' ', '-')}-hover`);
  await t.driver.move(photo.x, photo.y);
  await hidden(t, `${name} temporary preview clears when pointer leaves controls`);
  await t.driver.move(range.x, range.y);
  await shown(t, `${name} range hover preview returns`);
  await t.driver.keys('o');
  await hidden(t, `${name} preview toggled off with O while hovered`);
  await t.driver.keys('o');
  await shown(t, `${name} preview toggled on with O while hovered`);
  await t.driver.move(photo.x, photo.y);
  await shown(t, `${name} O-enabled overlay stays on after pointer leaves`);
  await t.driver.keys('o');
  await hidden(t, `${name} O turns off the persistent overlay`);
  await click(t, '.mask-list > li.on .mask-del');
  await until(() => t.driver.observe(() => !document.querySelector('.mask-list > li')), `${name} mask deleted`);
}

export async function maskRangeHover(t) {
  await openTool(t, 'masks');
  await maskRange(t, 'Color Range', 'r_ch');
  await maskRange(t, 'Luminance Range', 'r_lo');
}

export async function healRangeHover(t) {
  await openTool(t, 'heal');
  await textButton(t, '.heal-mode', 'Fill');
  await textButton(t, '.seg.heal-mode', 'Range');
  await until(() => t.driver.observe(() => [...document.querySelectorAll('.heal-row')]
    .some(row => [...row.querySelectorAll('span')].some(s => s.textContent.trim() === 'Limit to color'))), 'Limit to color row');
  const box = await t.driver.observe(() => {
    const row = [...document.querySelectorAll('.heal-row')].find(r => [...r.querySelectorAll('span')].some(s => s.textContent.trim() === 'Limit to color'));
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const photo = await t.driver.observe(() => {
    const r = document.querySelector('canvas.layer.sharp')?.getBoundingClientRect();
    return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await t.driver.move(photo.x, photo.y);
  if ((await t.driver.observe(alpha))?.count) {
    await t.driver.keys('o');
    await hidden(t, 'Heal baseline overlay off');
  }
  await t.driver.move(box.x, box.y);
  const preview = await shown(t, 'Heal Limit to color hover preview');
  assert(preview.max > 0, 'Heal preview has visible overlay pixels');
  await t.evidence('heal-range-hover');
  await t.driver.move(photo.x, photo.y);
  await hidden(t, 'Heal temporary preview clears when pointer leaves Limit to color');
  await t.driver.move(box.x, box.y);
  await shown(t, 'Heal Limit to color hover preview returns');
  await t.driver.keys('o');
  await hidden(t, 'Heal preview toggled off with O while hovered');
  await t.driver.keys('o');
  await shown(t, 'Heal preview toggled on with O while hovered');
  await t.driver.move(photo.x, photo.y);
  await shown(t, 'Heal O-enabled overlay stays on after pointer leaves');
  await t.driver.keys('o');
  await hidden(t, 'Heal O turns off the persistent overlay');
  await textButton(t, '.seg.heal-mode', 'Off');
}
