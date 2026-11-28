// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withNodeLocales } from './vite-locales.mjs';
import { buildStackView, stackKey } from '../app/src/stacking.ts';

const require = createRequire(new URL('../app/package.json', import.meta.url));
const { rolldown } = await import(require.resolve('rolldown'));
const marksPath = fileURLToPath(new URL('../app/src/photoMarks.ts', import.meta.url));
const filterPath = fileURLToPath(new URL('../app/src/filter.ts', import.meta.url));
const findPath = fileURLToPath(new URL('../app/src/findModel.ts', import.meta.url));
const bundle = await rolldown({
  input: 'test-entry',
  plugins: [{
    name: 'app-services',
    resolveId(id) {
      if (id === 'test-entry' || id.startsWith('@tauri-apps/') || id === '@immporter/api') return '\0' + id;
    },
    transform(code, id) {
      if (id.endsWith('/src/i18n.ts')) return withNodeLocales(pathToFileURL(id).href, code);
    },
    load(id) {
      if (id === '\0test-entry') return `export * from ${JSON.stringify(marksPath)}; export * from ${JSON.stringify(filterPath)}; export * from ${JSON.stringify(findPath)};`;
      if (id.startsWith('\0')) return 'export const api = {}; export async function invoke() {} export async function listen() {}';
    },
  }],
});
const { output } = await bundle.generate({ format: 'esm' });
await bundle.close();
const { markEdits, markTargets, summarizeMarks, NO_FILTER, passes, NO_FIND, findCount, clearAll, clearCategory, chips, withSearchIn } =
  await import('data:text/javascript;base64,' + Buffer.from(output[0].code).toString('base64'));

const photo = (imgid, filename = `photo-${imgid}.JPG`, fields = {}) => ({
  imgid, filename, path: `/folder/${filename}`, rating: 0, labels: 0, rejected: false, ...fields,
});
const apply = (photos, mark) => {
  const edits = new Map(markEdits(photos, mark).map(({ imgid, fields }) => [imgid, fields]));
  return photos.map(p => ({ ...p, ...edits.get(p.imgid) }));
};

test('collapsed marking scopes include companions, deduplicate targets, and skip Immich-only results', () => {
  const raw = photo(1, 'pair.ORF'), jpg = photo(2, 'pair.JPG'), solo = photo(3), remote = photo(-1);
  const all = [raw, jpg, solo, remote];
  const partners = new Map([[raw.imgid, [jpg]]]);
  const collapsed = buildStackView(all, partners, new Set());
  const expanded = buildStackView(all, partners, new Set([stackKey(raw.path)]));
  assert.deepEqual(markTargets([raw, solo, remote], collapsed.collapsedPartners), [raw, jpg, solo]);
  assert.deepEqual(markTargets([raw, jpg, raw], collapsed.collapsedPartners), [raw, jpg]);
  assert.deepEqual(markTargets([raw], collapsed.collapsedPartners), [raw, jpg]);
  assert.deepEqual(markTargets([raw], expanded.collapsedPartners), [raw]);
  assert.deepEqual(markTargets([jpg], expanded.collapsedPartners), [jpg]);
  assert.equal(summarizeMarks(markTargets([remote], partners)).disabled, true);
});

test('mixed ratings, labels, Pick and Reject have distinct pressed states', () => {
  const a = photo(1, undefined, { rating: 5, labels: 3, keywords: ['Pick'] });
  const b = photo(2, undefined, { rating: 3, labels: 1 });
  const c = photo(3, undefined, { rejected: true });
  assert.deepEqual(summarizeMarks([a, b]).stars[2], { exact: 'mixed', fill: true });
  assert.deepEqual(summarizeMarks([a, b]).stars[4], { exact: 'mixed', fill: 'mixed' });
  assert.deepEqual(summarizeMarks([a, b]).labels, [true, 'mixed', false, false, false]);
  assert.equal(summarizeMarks([a, b]).picked, 'mixed');
  assert.equal(summarizeMarks([a, c]).rejected, 'mixed');
  assert.equal(summarizeMarks([a]).picked, true);
});

test('ratings set or clear together, clear rejection and preserve Pick and labels', () => {
  const a = photo(1, undefined, { rating: 3, rejected: true, labels: 2, keywords: ['Pick'] });
  const b = photo(2, undefined, { rating: 3 });
  const rate = { type: 'rating', value: 3 };
  const result = apply([a, b], rate);
  assert.deepEqual(result, [{ ...a, rejected: false }, b]);
  assert.deepEqual(apply(result, rate), [{ ...a, rejected: false, rating: 0 }, { ...b, rating: 0 }]);
});

test('colors and rejection clear only when all targets already have the mark', () => {
  const a = photo(1, undefined, { labels: 3, rejected: true, keywords: ['Pick'] });
  const b = photo(2, undefined, { labels: 4, rating: 5 });
  const red = { type: 'label', value: 1 };
  assert.deepEqual(apply([a, b], red).map(p => p.labels), [3, 5]);
  assert.deepEqual(apply(apply([a, b], red), red).map(p => p.labels), [2, 4]);
  const reject = { type: 'reject' };
  const rejected = apply([a, b], reject);
  assert.deepEqual(rejected, [a, { ...b, rejected: true }]);
  assert.deepEqual(apply(rejected, reject), [{ ...a, rejected: false }, b]);
});

test('one batch keeps its original targets when a rating change removes them from Find', () => {
  const photos = [photo(1, undefined, { rating: 3 }), photo(2, undefined, { rating: 3 })];
  const filter = { ...NO_FILTER, minRating: 3 };
  const results = apply(photos.filter(p => passes(p, filter)), { type: 'rating', value: 3 });
  assert.deepEqual(results.map(p => p.rating), [0, 0]);
  assert.deepEqual(results.filter(p => passes(p, filter)), []);
  assert.equal(filter.minRating, 3);
});

test('Find counts local mark filters and independently clears their state', () => {
  for (const filter of [{ minRating: 3 }, { rejected: 'hide' }, { labels: 16 }, { unlabeled: true }]) {
    const find = { ...NO_FIND, filter: { ...NO_FILTER, ...filter } };
    assert.equal(findCount(find, false), 1);
    assert.equal(findCount(clearAll(find), false), 0);
  }
});

test('existing Pick filters appear under Rating & flags and clear independently of keywords', () => {
  const find = { ...NO_FIND, filter: { ...NO_FILTER, keywords: ['Pick', 'Trip'] } };
  assert.deepEqual(chips(find, false).map(({ key }) => key), ['rating', 'keywords']);
  assert.deepEqual(clearCategory(find, 'rating').filter.keywords, ['Trip']);
  assert.deepEqual(clearCategory(find, 'keywords').filter.keywords, ['Pick']);
  assert.deepEqual(clearAll(find).filter.keywords, []);
  const both = { ...find, search: withSearchIn(find.search, 'both') };
  assert.equal(chips(both, true).find(({ key }) => key === 'rating')?.excludes, 'immich');
  const immich = { ...find, search: withSearchIn(find.search, 'immich') };
  assert.equal(chips(immich, true).some(({ key }) => key === 'rating'), false);
});
