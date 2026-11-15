// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { until } from '../support/webdriver.mjs';
import { dismissTour } from './smoke.mjs';

export async function dngThumbnail(t) {
  await until(async () => { try { return await t.driver.guard(); } catch { return false; } }, 'Immage main window', 60000);
  await until(() => t.driver.observe(() => document.fonts.status === 'loaded'), 'fonts');
  await dismissTour(t);
  const photo = await until(() => t.driver.observe(() => {
    const cell = [...document.querySelectorAll('.filmstrip .thumb[data-imgid]')].find(e => e.title === 'fallback-preview.dng');
    const canvas = cell?.querySelector('.thumb-image canvas');
    if (!canvas || canvas.width !== 256 || canvas.height !== 128) return null;
    const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
    const points = [[.25,.25],[.75,.25],[.25,.75],[.75,.75]].map(([x,y]) => {
      const at = (Math.floor(y * canvas.height) * canvas.width + Math.floor(x * canvas.width)) * 4;
      return [...data.slice(at, at + 4)];
    });
    return { name: cell.title, width: canvas.width, height: canvas.height, points };
  }), 'embedded TIFF preview is drawn at its decoded preview dimensions', 120000);
  assert(photo.width > 0 && photo.height > 0, `preview has dimensions ${photo.width}x${photo.height}`);
  assert(new Set(photo.points.map(p => JSON.stringify(p))).size === 4,
    `preview has four distinct color regions rather than a blank canvas (${JSON.stringify(photo.points)})`);
  await t.evidence('dng-preview');
  t.measure({ name: 'dng-thumbnail', photo });
}
