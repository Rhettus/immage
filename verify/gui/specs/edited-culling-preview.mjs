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

// drags Exposure to +1 (or -1 when already positive) in the open editor and
// waits for the changed frame; `saved` ms are then left for the autosave
async function editExposure(t, saved) {
  await settledPhoto(t);
  await panel(t, 'basic');
  await reveal(t, '[data-control-id="exposure"] label');
  await reveal(t, rangeSelector('exposure'));
  const slider = await until(async () => { const s = await t.driver.observe(read.exposure); return s?.visible && s.hit && !s.disabled && s; }, 'visible Exposure slider');
  const baseline = await settledPhoto(t);
  const target = slider.value > 0 ? -1 : 1;
  const { x, y, width, height } = slider.bounds;
  const at = v => ({ x: x + 8 + (width - 16) * (v - slider.min) / (slider.max - slider.min), y: y + height / 2 });
  await t.driver.drag(at(slider.value), at(target));
  const changed = await until(async () => { const s = await t.driver.observe(read.exposure); return Math.abs(s.value - target) < .3 && s; }, `Exposure near ${target}`);
  await settledPhoto(t, p => p.hash !== baseline.hash);
  await pause(saved);
  return changed.value;
}

// culls `name` from the grid: drawn within the limit, not blank, no new edit- file
async function cullFromGrid(t, name, settled) {
  const cell = await tile(t, name);
  await t.driver.point(cell.x, cell.y);
  // a single selection is the active photo (Filmstrip marks .selected only for several)
  await until(async () => (await t.driver.observe(activeTitle)) === cell.title, `${name} selected`);
  await t.driver.move(cell.x, cell.y);
  const opened = Date.now();
  await t.driver.keys('f');
  const drawn = await until(() => t.driver.observe(lightboxDrawn, name), `${name} culling preview drawn`, 60000);
  const drawMs = Date.now() - opened;
  assert(!drawn.error, `preview shows no error (${drawn.error})`);
  const pixels = await t.driver.observe(lightboxPixels);
  await t.evidence(`culling-${name}`);
  const after = await edits(t);
  assert(pixels && pixels.alpha > 250 && pixels.luma > 1 && pixels.spread > 8, `culling preview is not blank (${JSON.stringify(pixels)})`);
  assert.deepEqual(after, settled, `culling ${name} created no further edit- file`);
  assert(drawMs <= DRAW_LIMIT_MS, `${name} culling preview drawn in ${drawMs} ms, limit ${DRAW_LIMIT_MS} ms`);
  await t.driver.keys('\uE00C');
  await until(() => t.driver.observe(() => !document.querySelector('.modal-backdrop[aria-label="Culling preview"]')), 'culling preview closes');
  return { drawMs, pixels, canvas: [drawn.width, drawn.height], after };
}

// waits for an edit- file not in `known`
async function newEditFile(t, known, what) {
  const watch = Date.now();
  const fresh = await until(async () => {
    const f = (await edits(t)).filter(n => !known.includes(n));
    return f.length ? f : null;
  }, what, APPEAR_LIMIT_MS);
  return { fresh, ms: Date.now() - watch };
}

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
  const exposure = await editExposure(t, 1800);
  t.measure({ name: 'edited', exposure });

  // 3. move to ecp-b in the editor
  const next = await tile(t, 'ecp-b');
  const moved = Date.now();
  await t.driver.point(next.x, next.y, 2);
  await until(() => t.driver.observe(n => document.querySelector('.filmstrip .thumb.active')?.title === n, next.title), 'ecp-b active');
  await settledPhoto(t);
  const firstFrameMs = Date.now() - moved;

  // 4. the edit- entry appears in the thumbnail cache
  const created = await newEditFile(t, before, 'an edit- preview of ecp-a in the thumbnail cache');
  t.measure({ name: 'edit-preview-appeared', afterFirstFrameMs: created.ms, sinceMoveMs: Date.now() - moved, firstFrameMs, files: created.fresh });
  await pause(1500); // let a second, unwanted, write show up
  const settled = await edits(t);

  // 5. culling ecp-a reads that file: quick, no new edit- file, not blank
  await t.driver.keys('g');
  await until(() => t.driver.observe(inGrid), 'grid view again');
  await pause(1000);
  const first = await cullFromGrid(t, 'ecp-a', settled);
  t.measure({ name: 'edited-culling-preview', limitMs: DRAW_LIMIT_MS, ...first, appearMs: created.ms, firstFrameMs,
    editFilesBefore: before, editFilesSettled: settled });

  // 6. back to the grid with the edited photo still open: edit ecp-b (open in
  // the editor since step 3), press G before its autosave, and its preview is
  // prepared too (the grid saves it first)
  const bCell = await tile(t, 'ecp-b');
  await t.driver.point(bCell.x, bCell.y, 2);
  await until(() => t.driver.observe(() => !document.querySelector('.filmstrip.grid')), 'double-click returns to the editor');
  await until(async () => (await t.driver.observe(activeTitle)) === bCell.title, 'ecp-b active');
  const exposureB = await editExposure(t, 100);
  const left = Date.now();
  await t.driver.keys('g');
  await until(() => t.driver.observe(inGrid), 'grid view with ecp-b open');
  const createdB = await newEditFile(t, first.after, 'an edit- preview of ecp-b after returning to the grid');
  t.measure({ name: 'grid-edit-preview-appeared', exposure: exposureB, sinceGridMs: Date.now() - left, files: createdB.fresh });
  await pause(1500);
  const settledB = await edits(t);
  const second = await cullFromGrid(t, 'ecp-b', settledB);
  t.measure({ name: 'grid-edited-culling-preview', limitMs: DRAW_LIMIT_MS, ...second, editFilesSettled: settledB });
}
