// SPDX-License-Identifier: GPL-3.0-or-later
// Edited RAWs' culling previews rendered ahead (d7bd3d4, 9c5c24e; app/src/editedPreviews.ts).
// After culling has been opened once (which stores immage.culling.previewSize),
// leaving an edited RAW for another photo in the editor renders that RAW's
// culling-size preview in the background into the thumbnail disk cache, under a
// name starting "edit-". Culling that RAW then reads the file instead of
// rendering. run.mjs copies one corpus RAW as ecp-a / ecp-b and launches with
// ecp-a; the runner reads the profile's thumbs folder (t.thumbCacheNames).
import assert from 'node:assert/strict';
import { until, pause } from '../support/webdriver.mjs';
import * as read from '../support/observations.mjs';
import { reveal, rangeSelector } from '../support/controls.mjs';
import { Blocked, panel } from '../support/scenario.mjs';
import { settledPhoto } from './smoke.mjs';
import { lightboxDrawn } from './grid-culling.mjs';

export const ECP_NAMES = ['ecp-a', 'ecp-b'];
const APPEAR_LIMIT_MS = 30000;
const DRAW_LIMIT_MS = 3000;
const hasPreview = () => !!document.querySelector('.modal-backdrop[aria-label="Culling preview"]');
const inGrid = () => !!document.querySelector('.filmstrip.grid');

// read-only copy of the lightbox canvas: is it a real picture, not blank or black
const lightboxPixels = () => {
  const canvas = document.querySelector('.modal-backdrop[aria-label="Culling preview"] canvas');
  if (!canvas?.width || !canvas.height) return null;
  const copy = document.createElement('canvas'); copy.width = 64; copy.height = 64;
  const context = copy.getContext('2d'); context.drawImage(canvas, 0, 0, 64, 64);
  const rgba = context.getImageData(0, 0, 64, 64).data;
  let luma = 0, alpha = 0, min = 255, max = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const y = rgba[i] * .2126 + rgba[i + 1] * .7152 + rgba[i + 2] * .0722;
    luma += y; alpha += rgba[i + 3]; min = Math.min(min, y); max = Math.max(max, y);
  }
  return { luma: luma / 4096, alpha: alpha / 4096, spread: max - min };
};

const tile = (t, prefix) => until(() => t.driver.observe(p => {
  const e = [...document.querySelectorAll('.filmstrip .thumb[data-imgid]')].find(c => c.title.startsWith(p));
  const r = e?.getBoundingClientRect();
  return r && r.width && r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight
    ? { x: r.x + r.width / 2, y: r.y + r.height / 2, title: e.title } : null;
}, prefix), `thumbnail ${prefix}`);

const activeTitle = () => document.querySelector('.filmstrip .thumb.active')?.title ?? null;
const edits = async t => (await t.thumbCacheNames()).filter(n => n.startsWith('edit-'));

export async function editedCullingPreview(t) {
  const files = await t.fixtureFiles();
  if (!t.fixture.raw || !ECP_NAMES.every(n => files.some(f => f.startsWith(n + '.'))))
    throw new Blocked('needs the corpus RAW copies ecp-a and ecp-b made by run.mjs');
  await until(() => t.driver.observe(n => document.querySelectorAll('.filmstrip .thumb[data-imgid]').length >= n, 2),
    'both RAW copies listed', 120000);
  await settledPhoto(t);

  // 1. open culling once (stores the preview size), then close it
  if (!await t.driver.observe(inGrid)) await t.driver.keys('g');
  await until(() => t.driver.observe(inGrid), 'grid view');
  await pause(1000);
  const b = await tile(t, 'ecp-b');
  await t.driver.move(b.x, b.y);
  await t.driver.keys('f');
  await until(() => t.driver.observe(hasPreview), 'culling preview opens');
  await until(() => t.driver.observe(lightboxDrawn, 'ecp-b'), 'first culling preview drawn', 60000);
  await t.driver.keys(''); // WebDriver Escape
  await until(() => t.driver.observe(() => !document.querySelector('.modal-backdrop[aria-label="Culling preview"]')), 'culling preview closes');
  const before = await edits(t);
  t.measure({ name: 'edit-files-before', before });

  // 2. edit ecp-a in the editor
  const a = await tile(t, 'ecp-a');
  await t.driver.point(a.x, a.y, 2);
  await until(() => t.driver.observe(() => !document.querySelector('.filmstrip.grid')), 'double-click opens the editor');
  await until(() => t.driver.observe(n => document.querySelector('.filmstrip .thumb.active')?.title === n, a.title), 'ecp-a active');
  await settledPhoto(t);
  await panel(t, 'basic');
  await reveal(t, '[data-control-id="exposure"] label');
  await reveal(t, rangeSelector('exposure'));
  let slider = await until(async () => { const s = await t.driver.observe(read.exposure); return s?.visible && s.hit && !s.disabled && s; }, 'visible Exposure slider');
  const baseline = await settledPhoto(t);
  const target = slider.value > 0 ? -1 : 1;
  const { x, y, width, height } = slider.bounds;
  const at = v => ({ x: x + 8 + (width - 16) * (v - slider.min) / (slider.max - slider.min), y: y + height / 2 });
  await t.driver.drag(at(slider.value), at(target));
  const changed = await until(async () => { const s = await t.driver.observe(read.exposure); return Math.abs(s.value - target) < .3 && s; }, `Exposure near ${target}`);
  await settledPhoto(t, p => p.hash !== baseline.hash);
  await pause(1800); // autosave of the sidecar
  t.measure({ name: 'edited', exposure: changed.value });

  // 3. move to ecp-b in the editor
  const next = await tile(t, 'ecp-b');
  const moved = Date.now();
  await t.driver.point(next.x, next.y, 2);
  await until(() => t.driver.observe(n => document.querySelector('.filmstrip .thumb.active')?.title === n, next.title), 'ecp-b active');
  await settledPhoto(t);
  const firstFrameMs = Date.now() - moved;

  // 4. the edit- entry appears in the thumbnail cache
  const watch = Date.now();
  const created = await until(async () => {
    const now = await edits(t);
    const fresh = now.filter(n => !before.includes(n));
    return fresh.length ? { fresh, now } : null;
  }, 'an edit- preview in the thumbnail cache', APPEAR_LIMIT_MS);
  const appearMs = Date.now() - watch;
  assert(created.fresh.length >= 1, 'a new edit- cache file exists');
  t.measure({ name: 'edit-preview-appeared', afterFirstFrameMs: appearMs, sinceMoveMs: Date.now() - moved, firstFrameMs, files: created.fresh });
  await pause(1500); // let a second, unwanted, write show up
  const settled = await edits(t);

  // 5. culling ecp-a reads that file: quick, no new edit- file, not blank
  await t.driver.keys('g');
  await until(() => t.driver.observe(inGrid), 'grid view again');
  await pause(1000);
  const cell = await tile(t, 'ecp-a');
  await t.driver.point(cell.x, cell.y);
  // a single selection is the active photo (Filmstrip marks .selected only for several)
  await until(async () => (await t.driver.observe(activeTitle)) === cell.title, 'ecp-a selected');
  await t.driver.move(cell.x, cell.y);
  const opened = Date.now();
  await t.driver.keys('f');
  const drawn = await until(() => t.driver.observe(lightboxDrawn, 'ecp-a'), 'edited culling preview drawn', 60000);
  const drawMs = Date.now() - opened;
  assert(!drawn.error, `preview shows no error (${drawn.error})`);
  const pixels = await t.driver.observe(lightboxPixels);
  await t.evidence('edited-culling-preview');
  const after = await edits(t);
  t.measure({ name: 'edited-culling-preview', drawMs, limitMs: DRAW_LIMIT_MS, pixels, canvas: [drawn.width, drawn.height],
    appearMs, firstFrameMs, editFilesBefore: before, editFilesSettled: settled, editFilesAfter: after });
  assert(pixels && pixels.alpha > 250 && pixels.luma > 1 && pixels.spread > 8, `culling preview is not blank (${JSON.stringify(pixels)})`);
  assert.deepEqual(after, settled, 'culling the edited RAW created no further edit- file');
  assert(drawMs <= DRAW_LIMIT_MS, `edited culling preview drawn in ${drawMs} ms, limit ${DRAW_LIMIT_MS} ms`);
  await t.driver.keys('');
  await until(() => t.driver.observe(() => !document.querySelector('.modal-backdrop[aria-label="Culling preview"]')), 'culling preview closes');
}
