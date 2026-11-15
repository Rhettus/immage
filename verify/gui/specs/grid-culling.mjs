// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { until, pause } from '../support/webdriver.mjs';
import { textButton } from '../support/scenario.mjs';

const preview = '.modal-backdrop[aria-label="Culling preview"]';
const hasPreview = () => !!document.querySelector('.modal-backdrop[aria-label="Culling preview"]');
const inspect = () => {
  const root = document.querySelector('.filmstrip.grid');
  const box = document.querySelector('.modal-backdrop[aria-label="Culling preview"] .culling-lightbox');
  const canvas = document.querySelector('.modal-backdrop[aria-label="Culling preview"] canvas');
  const viewport = document.querySelector('.modal-backdrop[aria-label="Culling preview"] .culling-lightbox > div[style*="overflow"]');
  const active = document.querySelector('.filmstrip .thumb.active');
  return { grid: !!root, count: root?.querySelectorAll('.thumb[data-imgid]').length ?? 0,
    selected: root?.querySelector('.thumb.selected')?.getAttribute('data-imgid') ?? null,
    name: box?.firstElementChild?.textContent ?? null,
    photo: !!document.querySelector('.modal-backdrop[aria-label="Culling preview"]'), bounds: box && { x: box.getBoundingClientRect().x,
      y: box.getBoundingClientRect().y, width: box.getBoundingClientRect().width,
      height: box.getBoundingClientRect().height },
    canvas: canvas && { width: canvas.width, height: canvas.height,
      rect: { width: canvas.getBoundingClientRect().width, height: canvas.getBoundingClientRect().height } },
    dpr: window.devicePixelRatio,
    loading: box?.textContent.includes('Loading preview…') ?? false,
    scroll: viewport && { left: viewport.scrollLeft, top: viewport.scrollTop,
      width: viewport.clientWidth, height: viewport.clientHeight },
    active: active?.title ?? null };
};

export async function gridCulling(t) {
  await until(() => t.driver.observe(() => document.querySelectorAll('.filmstrip .thumb[data-imgid]').length >= 3),
    'three photos in the folder', 120000);
  await t.driver.keys('g');
  await until(() => t.driver.observe(() => !!document.querySelector('.filmstrip.grid')), 'grid view');
  const target = await t.driver.observe(() => {
    const cell = document.querySelector('.filmstrip.grid .thumb.selected')
      ?? document.querySelector('.filmstrip.grid .thumb[data-imgid]');
    if (!cell) return null;
    const r = cell.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  assert(target, 'a grid photo can be hovered');
  await t.driver.move(target.x, target.y);
  await t.driver.keys('f');
  await until(() => t.driver.observe(hasPreview), 'culling preview opens');
  let state = await until(async () => {
    const s = await t.driver.observe(inspect); return s.canvas?.width > 0 && s.bounds && s;
  }, 'preview pixels drawn', 60000);
  const fixedFrame = state.bounds;
  const viewport = await t.driver.observe(() => ({ width: innerWidth, height: innerHeight }));
  assert(state.bounds.width <= viewport.width * .8 + 2 && state.bounds.height <= viewport.height * .8 + 2,
    `preview frame stays within 80% of the window (${JSON.stringify(state.bounds)})`);
  await t.evidence('culling-fit');
  const next = await t.driver.observe(() => {
    const b = document.querySelector('.modal-backdrop[aria-label="Culling preview"] button[aria-label="Next photo (right arrow key)"]');
    const r = b?.getBoundingClientRect(); return r && { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: b.disabled };
  });
  assert(next && !next.disabled, 'next photo is available');
  const firstName = state.name;
  await t.driver.keys('\uE014'); // WebDriver ArrowRight
  state = await until(() => t.driver.observe((previous) => {
    const root = document.querySelector('.modal-backdrop[aria-label="Culling preview"]');
    const box = root?.querySelector('.culling-lightbox'); const canvas = root?.querySelector('canvas');
    const name = box?.firstElementChild?.textContent ?? null;
    if (name === previous || !canvas?.width) return null;
    return { name, canvas: { width: canvas.width, height: canvas.height } };
  }, firstName), 'right arrow selects and draws the next preview', 60000);
  const nextButton = await t.driver.observe(() => {
    const b = document.querySelector('.modal-backdrop[aria-label="Culling preview"] button[aria-label="Next photo (right arrow key)"]');
    const r = b?.getBoundingClientRect(); return r && { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: b.disabled };
  });
  assert(nextButton && !nextButton.disabled, 'the outer next arrow is available');
  await t.driver.point(nextButton.x, nextButton.y);
  const afterButton = await until(() => t.driver.observe((previous) => {
    const root = document.querySelector('.modal-backdrop[aria-label="Culling preview"]');
    const box = root?.querySelector('.culling-lightbox'); const canvas = root?.querySelector('canvas');
    const name = box?.firstElementChild?.textContent ?? null;
    if (name === previous || !canvas?.width) return null;
    return { name, canvas: { width: canvas.width, height: canvas.height } };
  }, state.name),
    'outer next arrow selects and draws a photo', 60000);
  state = afterButton;
  const frameAfterNavigation = await t.driver.observe(inspect);
  assert.deepEqual(frameAfterNavigation.bounds, fixedFrame, 'preview frame stays the same when the photo changes');
  const zoomButton = await t.driver.observe(() => {
    const b = [...document.querySelectorAll('.modal-backdrop[aria-label="Culling preview"] button')].find(e => e.textContent.trim() === '100%');
    const r = b?.getBoundingClientRect(); return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  assert(zoomButton, '100% button is available');
  await t.driver.point(zoomButton.x, zoomButton.y);
  await until(() => t.driver.observe(() => [...document.querySelectorAll('.modal-backdrop[aria-label="Culling preview"] button')]
    .some(e => e.textContent.trim() === 'Fit')), '100% preview is ready');
  const zoomed = await until(() => t.driver.observe(s => {
    const root = document.querySelector(s); if (!root) return null;
    const box = root.querySelector('.culling-lightbox'), canvas = root.querySelector('canvas');
    const viewport = root.querySelector('.culling-lightbox > div[style*="overflow"]');
    if (!canvas?.width || box?.textContent.includes('Loading preview…')) return null;
    const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio;
    if (Math.abs(r.width - canvas.width / dpr) > 2 || Math.abs(r.height - canvas.height / dpr) > 2) return null;
    return { image: { width: r.width, height: r.height, pixels: [canvas.width, canvas.height] },
      viewport: { width: viewport.clientWidth, height: viewport.clientHeight, left: viewport.scrollLeft, top: viewport.scrollTop } };
  }, '.modal-backdrop[aria-label="Culling preview"]'), 'full-resolution 100% preview settles', 60000);
  t.measure({ name: 'culling-100-percent', ...zoomed });
  const frameAt100 = await t.driver.observe(inspect);
  assert.deepEqual(frameAt100.bounds, fixedFrame, 'preview frame stays the same at 100%');
  const overflow = zoomed.image.width > zoomed.viewport.width + 2 || zoomed.image.height > zoomed.viewport.height + 2;
  let pan = { exercised: false, reason: 'the full-resolution preview fits the viewport' };
  if (overflow) {
    const lightbox = await t.driver.observe(inspect);
    const from = { x: lightbox.bounds.x + lightbox.bounds.width / 2,
      y: lightbox.bounds.y + lightbox.bounds.height - 80 };
    await t.driver.spaceDrag(from, { x: from.x - 80, y: from.y - 45 });
    const afterPan = await t.driver.observe(inspect);
    assert(afterPan.scroll.left !== zoomed.viewport.left || afterPan.scroll.top !== zoomed.viewport.top,
      'Space-drag pans the zoomed preview');
    pan = { exercised: true, before: zoomed.viewport, after: afterPan.scroll };
  }
  t.measure({ name: 'culling-pan', ...pan });
  await textButton(t, preview, 'Fit');
  await until(() => t.driver.observe(() => [...document.querySelectorAll('.modal-backdrop[aria-label="Culling preview"] button')]
    .some(e => e.textContent.trim() === '100%')), 'Fit returns to the fitted preview');
  await t.driver.keys('3');
  await until(() => t.driver.observe(() => document.querySelector('.modal-backdrop[aria-label="Culling preview"] [aria-label="3 stars"]')?.getAttribute('aria-pressed') === 'true'),
    '3 rates the displayed photo');
  await t.driver.keys('x');
  await until(() => t.driver.observe(() => document.querySelector('.modal-backdrop[aria-label="Culling preview"] [aria-label="Reject photo"]')?.getAttribute('aria-pressed') === 'true'),
    'X rejects the displayed photo');
  await t.driver.keys('4');
  await until(() => t.driver.observe(() => document.querySelector('.modal-backdrop[aria-label="Culling preview"] [aria-label="4 stars"]')?.getAttribute('aria-pressed') === 'true'
      && document.querySelector('.modal-backdrop[aria-label="Culling preview"] [aria-label="Reject photo"]')?.getAttribute('aria-pressed') === 'false'),
    'rating clears reject');
  await t.driver.keys('6');
  await until(() => t.driver.observe(() => document.querySelector('.modal-backdrop[aria-label="Culling preview"] [aria-label="Red label"]')?.getAttribute('aria-pressed') === 'true'),
    '6 toggles the red label');
  await t.evidence('culling-rating');
  await t.driver.keys('\uE00C'); // WebDriver Escape
  await until(() => t.driver.observe(() => !document.querySelector('.modal-backdrop[aria-label="Culling preview"]')), 'preview closes with Escape');
  await pause(300);
  const rated = await t.driver.observe(() => [...document.querySelectorAll('.filmstrip .thumb[data-imgid]')]
    .map(e => ({ title: e.title, stars: e.querySelectorAll('.thumb-stars button.on').length,
      rejected: e.classList.contains('rejected'), red: !!e.querySelector('.thumb-label[title*="Red"]') })));
  assert(rated.some(x => x.stars === 4 && !x.rejected), 'rating updates the library photo');

  // A two-photo selection takes precedence over the hovered third photo for
  // K and the context-menu command; all keyword chips are common to both.
  const cells = await t.driver.observe(() => [...document.querySelectorAll('.filmstrip.grid .thumb[data-imgid]')].slice(0, 3).map(e => {
    const r = e.getBoundingClientRect(); return { title: e.title, x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }));
  assert.equal(cells.length, 3, 'three grid photos are available for a selection');
  await t.driver.point(cells[0].x, cells[0].y);
  await t.driver.modifiedPoint('\uE009', cells[1].x, cells[1].y);
  await until(() => t.driver.observe(() => document.querySelectorAll('.filmstrip.grid .thumb.selected').length === 2),
    'two photos selected');
  await t.driver.move(cells[2].x, cells[2].y);
  await t.driver.keys('k');
  await until(() => t.driver.observe(() => !!document.querySelector('[aria-label="Grid keywords"]')), 'grid keyword dialog opens with K');
  await until(() => t.driver.observe(() => document.querySelector('[aria-label="Grid keywords"] h2')?.textContent === 'Keywords · 2 photos'),
    'K uses the selected photos instead of the hovered photo');
  const keywordInput = await until(() => t.driver.observe(() => {
    const e = document.querySelector('input.field[placeholder="add keywords, separated by commas"]'); const r = e?.getBoundingClientRect();
    return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }), 'keyword input is available');
  assert(keywordInput, 'keyword input is available');
  await t.driver.point(keywordInput.x, keywordInput.y);
  await t.driver.keys(...'GUI Test > Grid Culling', '\uE007');
  await until(() => t.driver.observe((title) => [...document.querySelectorAll('[aria-label="Grid keywords"] .kw-chip')]
    .some(e => e.title === title), 'GUI Test > Grid Culling'), 'keyword is added to the selected photo');
  await t.evidence('culling-keywords');
  await textButton(t, '[aria-label="Grid keywords"] .modal', 'Close');
  await until(() => t.driver.observe(() => !document.querySelector('[aria-label="Grid keywords"]')), 'keyword dialog closes');
  await t.driver.move(cells[2].x, cells[2].y);
  await t.driver.keys('k');
  await until(() => t.driver.observe(() => document.querySelector('[aria-label="Grid keywords"] h2')?.textContent === 'Keywords · 2 photos'),
    'K reopens the selected-photo keyword dialog');
  await until(() => t.driver.observe((title) => [...document.querySelectorAll('[aria-label="Grid keywords"] .kw-chip')]
    .some(e => e.title === title), 'GUI Test > Grid Culling'), 'shared keyword is visible on both selected photos');
  await textButton(t, '[aria-label="Grid keywords"] .modal', 'Close');
  // A context click on an unselected photo acts on that photo alone, even
  // while another multi-selection remains selected.
  const beforeUnselectedContext = await t.driver.observe(() => [...document.querySelectorAll('.filmstrip.grid .thumb.selected')].map(e => e.title));
  const unselectedCell = await t.driver.observe((title) => {
    const e = [...document.querySelectorAll('.filmstrip.grid .thumb[data-imgid]')].find(c => c.title === title);
    const r = e?.getBoundingClientRect(); return r && { x: r.x + r.width / 2, y: r.y + r.height / 2,
      selected: e.classList.contains('selected') };
  }, cells[2].title);
  assert(unselectedCell && !unselectedCell.selected, 'third photo is outside the current selection');
  const unselectedHit = await t.driver.observe((x, y) => {
    const cell = document.elementFromPoint(x, y)?.closest('.filmstrip.grid .thumb[data-imgid]');
    return { title: cell?.title ?? null, selected: !!cell?.classList.contains('selected'),
      count: document.querySelectorAll('.filmstrip.grid .thumb.selected').length };
  }, unselectedCell.x, unselectedCell.y);
  await t.driver.rightClick(unselectedCell.x, unselectedCell.y);
  const selectionAfterUnselectedRightClick = await t.driver.observe(() => [...document.querySelectorAll('.filmstrip.grid .thumb.selected')].map(e => e.title));
  t.measure({ name: 'unselected-context-click', hit: unselectedHit, before: beforeUnselectedContext,
    afterRightClick: selectionAfterUnselectedRightClick });
  assert.deepEqual(selectionAfterUnselectedRightClick, beforeUnselectedContext,
    'right-clicking an unselected photo preserves the existing selection');
  await until(() => t.driver.observe(() => !!document.querySelector('.context-menu')), 'unselected photo context menu opens');
  await textButton(t, '.context-menu', 'Keywords… (K)');
  const unselectedContextHeading = await until(() => t.driver.observe(() => document.querySelector('[aria-label="Grid keywords"] h2')?.textContent ?? null),
    'unselected context keyword dialog opens');
  assert.equal(unselectedContextHeading, 'Keywords · 1 photo', 'unselected context action targets only its hit photo');
  const afterUnselectedContext = await t.driver.observe(() => [...document.querySelectorAll('.filmstrip.grid .thumb.selected')].map(e => e.title));
  assert.deepEqual(afterUnselectedContext, beforeUnselectedContext, 'context action leaves the existing selection intact');
  await t.driver.keys('\uE00C');
  await until(() => t.driver.observe(() => !document.querySelector('[aria-label="Grid keywords"]')), 'unselected context dialog closes');
  const contextSelection = await t.driver.observe(() => [...document.querySelectorAll('.filmstrip.grid .thumb.selected')].map(e => {
    const r = e.getBoundingClientRect(); return { title: e.title, x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }));
  const contextTarget = contextSelection[0] && await t.driver.observe((x, y) => {
    const cell = document.elementFromPoint(x, y)?.closest('.filmstrip.grid .thumb[data-imgid]');
    return { title: cell?.title ?? null, selected: !!cell?.classList.contains('selected'), count: document.querySelectorAll('.filmstrip.grid .thumb.selected').length };
  }, contextSelection[0].x, contextSelection[0].y);
  t.measure({ name: 'context-selection-before', selected: contextSelection, hit: contextTarget });
  assert.equal(contextSelection.length, 2, `two photos remain selected before context action (${contextSelection})`);
  assert.equal(contextTarget?.title, contextSelection[0].title, 'right-click coordinates target the selected photo');
  assert(contextTarget?.selected, 'right-click target is selected before context menu opens');
  await t.driver.rightClick(contextSelection[0].x, contextSelection[0].y);
  const selectionAfterRightClick = await t.driver.observe(() => ({
    selected: [...document.querySelectorAll('.filmstrip.grid .thumb.selected')].map(e => e.title),
    active: document.querySelector('.filmstrip.grid .thumb.active')?.title ?? null,
  }));
  t.measure({ name: 'context-selection-after-right-click', ...selectionAfterRightClick });
  assert.deepEqual(selectionAfterRightClick.selected, contextSelection.map(e => e.title),
    'right-clicking a selected photo preserves the whole selected group');
  await until(() => t.driver.observe(() => !!document.querySelector('.context-menu')), 'grid context menu opens');
  await textButton(t, '.context-menu', 'Keywords… (K)');
  const contextHeading = await until(() => t.driver.observe(() => document.querySelector('[aria-label="Grid keywords"] h2')?.textContent ?? null),
    'context menu keyword dialog opens');
  const contextSelectionWorked = contextHeading === 'Keywords · 2 photos'
    && selectionAfterRightClick.selected.length === contextSelection.length;
  t.measure({ name: 'context-keywords', expected: 'Keywords · 2 photos', heading: contextHeading,
    contextSelectionWorked });
  t.subcheck('context keyword selection', contextSelectionWorked,
    { expected: 'Keywords · 2 photos', observed: contextHeading, hit: contextTarget, before: contextSelection,
      afterRightClick: selectionAfterRightClick });
  assert.match(contextHeading, /^Keywords · [12] photos?$/, 'context menu opens keywording');
  await t.evidence('context-keywords');
  await t.driver.keys('\uE00C');
  await until(() => t.driver.observe(() => !document.querySelector('[aria-label="Grid keywords"]')), 'context keyword dialog closes');
  const recentTarget = await t.driver.observe((title) => {
    const e = [...document.querySelectorAll('.filmstrip.grid .thumb[data-imgid]')].find(c => c.title === title);
    const r = e?.getBoundingClientRect(); return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, cells[2].title);
  assert(recentTarget, 'the Recent keyword test photo remains visible');
  await t.driver.point(recentTarget.x, recentTarget.y);
  await until(() => t.driver.observe(() => document.querySelectorAll('.filmstrip.grid .thumb.active').length === 1
    && document.querySelector('.filmstrip.grid .thumb.active')?.title === 'culling-03.jpg'),
    'one photo active for Recent keywords');
  await t.driver.keys('k');
  await until(() => t.driver.observe(() => document.querySelector('[aria-label="Grid keywords"] h2')?.textContent?.startsWith('Keywords · 1 photo')),
    'a single selected photo opens keywording');
  await until(() => t.driver.observe((title) => !!document.querySelector(`[aria-label="Grid keywords"] .kw-recent button[title="${title}"]`), 'GUI Test > Grid Culling'),
    'the added keyword appears in Recent keywords');
  await textButton(t, '[aria-label="Grid keywords"] .kw-recent', 'Grid Culling');
  await until(() => t.driver.observe((title) => [...document.querySelectorAll('[aria-label="Grid keywords"] .kw-chip')]
    .some(e => e.title === title), 'GUI Test > Grid Culling'), 'recent keyword can be applied');
  await textButton(t, '[aria-label="Grid keywords"] .modal', 'Close');
  await until(() => t.driver.observe(() => !document.querySelector('[aria-label="Grid keywords"]')), 'keyword dialog closes');
  // With no photo under the pointer, F falls back to the first selected photo.
  await t.driver.move(10, 10);
  await t.driver.keys('f');
  await until(() => t.driver.observe(hasPreview), 'F opens a culling preview');
  const selectedFallback = await t.driver.observe(inspect);
  assert(selectedFallback.name.includes(cells[2].title), `F without a hovered photo previews the selected photo (${selectedFallback.name})`);
  await t.driver.keys('\uE00C'); // WebDriver Escape
  await until(() => t.driver.observe(() => !document.querySelector('.modal-backdrop[aria-label="Culling preview"]')), 'preview closes');
  // Double-click the photo to hand it to the editor.
  await t.driver.point(cells[2].x, cells[2].y, 2);
  await until(() => t.driver.observe(() => !document.querySelector('.filmstrip.grid')), 'double-click opens the photo editor');
  t.measure({ name: 'grid-culling', viewport, preview: fixedFrame, zoomed: zoomed.image,
    panned: pan.exercised, selectionAndRecentKeywords: true,
    contextKeywords: true, doubleClickEdit: true });
}
