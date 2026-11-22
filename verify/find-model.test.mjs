// SPDX-License-Identifier: GPL-3.0-or-later
// Engine-free: the Find popup model (findModel.ts), pure state rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { withNodeLocales } from './vite-locales.mjs';
const require = createRequire(new URL('../app/package.json', import.meta.url));
const { transformSync } = await import(require.resolve('rolldown/experimental'));
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@tauri-apps/api/core') return { url: 'data:text/javascript,export const invoke=async()=>({});', shortCircuit: true };
    if (spec === '@tauri-apps/api/event') return { url: 'data:text/javascript,export const listen=async()=>()=>{};', shortCircuit: true };
    // library.ts only uses immich.ts for thumbnails, which these tests never fetch
    if (spec === './immich' && ctx.parentURL?.endsWith('/library.ts')) return { url: 'data:text/javascript,export const fetchImmichThumb=async()=>null;', shortCircuit: true };
    if (ctx.parentURL?.endsWith('/immich.ts')) {
      const m = { './commands': 'export const commands={};', './settings': 'export const settings={get:()=>null,set:()=>{}};',
        './tunerWorkload': 'export const timeTunerWork=(_,f)=>f();', '@immporter/api': 'export const api={};' }[spec];
      if (m) return { url: 'data:text/javascript,' + encodeURIComponent(m), shortCircuit: true };
    }
    if (spec.startsWith('./') || spec.startsWith('../')) for (const ext of ['.ts', '.tsx']) {
      const url = new URL(spec + ext, ctx.parentURL);
      if (existsSync(url)) return next(url.href, ctx);
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (!url.startsWith('file:') || !/\.tsx?$/.test(url)) return next(url, ctx);
    const path = fileURLToPath(url);
    const source = withNodeLocales(url, readFileSync(path, 'utf8'));
    return { format: 'module', source: transformSync(path, source, { jsx: { runtime: 'automatic' } }).code, shortCircuit: true };
  },
});
const M = await import('../app/src/findModel.ts');
const { NO_SEARCH } = await import('../app/src/immich.ts');
const { NO_FILTER } = await import('../app/src/filter.ts');
const { searchIn, withSearchIn, reach, needsSearch, visibleCategories, serverPickers, effectiveFilter, setStars, setTaken,
  setKinds, setRawOnly, folderSearch, withFilter, settingOf, clearCategory, clearAll, chips, findCount, sameFind, normalizeFind, NO_FIND, CATEGORIES } = M;

const st = (search = {}, filter = {}) => ({ search: { ...NO_SEARCH, ...search }, filter: { ...NO_FILTER, ...filter } });
const keys = (cs) => cs.map(c => c.key);

test('searchIn and withSearchIn round-trip', () => {
  for (const v of ['folder', 'library', 'immich', 'both']) assert.equal(searchIn(withSearchIn(NO_SEARCH, v)), v);
  assert.equal(withSearchIn({ ...NO_SEARCH, scope: 'folder' }, 'both').scope, 'library');
  assert.equal(withSearchIn(NO_SEARCH, 'both').source, 'both');
});

test('folderSearch returns to the open folder with no words, keeping filters and mode', () => {
  assert.equal(NO_SEARCH.scope, 'folder');
  const q = folderSearch({ ...NO_SEARCH, source: 'both', scope: 'library', mode: 'filename', text: 'cat', minRating: 3, favorites: true, takenFrom: '2024-01-01' });
  assert.equal(q.source, 'local'); assert.equal(q.scope, 'folder'); assert.equal(q.text, '');
  assert.equal(q.minRating, 3); assert.equal(q.favorites, true); assert.equal(q.takenFrom, '2024-01-01'); assert.equal(q.mode, 'filename');
  assert.equal(needsSearch({ search: q, filter: NO_FILTER }, true), false);
});

test('reach', () => {
  for (const source of ['immich', 'both']) {
    assert.deepEqual(reach({ ...NO_SEARCH, source }, false), { local: true, immich: false, skipped: true });
  }
  assert.deepEqual(reach({ ...NO_SEARCH, source: 'local' }, false), { local: true, immich: false, skipped: false });
  assert.deepEqual(reach({ ...NO_SEARCH, source: 'immich' }, true), { local: false, immich: true, skipped: false });
  assert.deepEqual(reach({ ...NO_SEARCH, source: 'both' }, true), { local: true, immich: true, skipped: false });
  assert.deepEqual(reach({ ...NO_SEARCH, source: 'local' }, true), { local: true, immich: false, skipped: false });
});

test('needsSearch', () => {
  const folder = { scope: 'folder' };
  assert.equal(needsSearch(st(folder), true), false);
  assert.equal(needsSearch(st({ ...folder, text: 'cat' }), true), true);
  assert.equal(needsSearch(st({ ...folder, text: '   ' }), true), false);
  assert.equal(needsSearch(st({ scope: 'library' }), true), true);
  assert.equal(needsSearch(st({ ...folder, source: 'immich' }), true), true);
  assert.equal(needsSearch(st({ ...folder, source: 'immich' }), false), false);
});

test('visibleCategories', () => {
  const hidden = ['place', 'people', 'albums', 'favorites'];
  const local = keys(visibleCategories({ ...NO_SEARCH, source: 'local' }, true));
  for (const k of hidden) assert.ok(!local.includes(k));
  assert.equal(local.length, 9);
  assert.equal(local[local.indexOf('rating') + 1], 'edits');
  assert.ok(!keys(visibleCategories({ ...NO_SEARCH, source: 'immich' }, true)).includes('edits'));
  const im = keys(visibleCategories({ ...NO_SEARCH, source: 'immich' }, true));
  assert.ok(!im.includes('bodies') && !im.includes('exposure'));
  for (const k of hidden) assert.ok(im.includes(k));
  const both = visibleCategories({ ...NO_SEARCH, source: 'both' }, true);
  assert.equal(both.length, 13);
  assert.deepEqual(both, CATEGORIES);
});

const busy = () => st({ source: 'immich' }, { cameras: ['A'], keywords: ['k'], rejected: 'hide', minRating: 3, takenFrom: '2020-01-01',
  takenTo: '2021-01-01', kinds: ['RAW'], bodies: ['b'], lenses: ['l'], labels: 2 });

test('serverPickers and effectiveFilter', () => {
  assert.equal(serverPickers({ ...NO_SEARCH, source: 'immich' }, true), true);
  assert.equal(serverPickers({ ...NO_SEARCH, source: 'both' }, true), false);
  assert.equal(serverPickers({ ...NO_SEARCH, source: 'immich' }, false), false);
  const s = busy();
  assert.deepEqual(effectiveFilter(s, true), { ...NO_FILTER, minRating: 3, takenFrom: '2020-01-01', takenTo: '2021-01-01', kinds: ['RAW'] });
  for (const source of ['both', 'local']) {
    const t = { ...s, search: { ...s.search, source } };
    assert.equal(effectiveFilter(t, true), t.filter);
  }
});

test('setStars, setTaken, setKinds, setRawOnly, withFilter write both halves', () => {
  let s = setStars(NO_FIND, 4);
  assert.equal(s.search.minRating, 4); assert.equal(s.filter.minRating, 4);
  s = setTaken(s, '2020-01-01', '2020-02-01');
  assert.deepEqual([s.search.takenFrom, s.search.takenTo, s.filter.takenFrom, s.filter.takenTo],
    ['2020-01-01', '2020-02-01', '2020-01-01', '2020-02-01']);
  s = setKinds(s, ['RAW']);
  assert.equal(s.search.rawOnly, true); assert.deepEqual(s.filter.kinds, ['RAW']);
  s = setKinds(s, ['RAW', 'JPEG']);
  assert.equal(s.search.rawOnly, false); assert.deepEqual(s.filter.kinds, ['RAW', 'JPEG']);
  s = setRawOnly(s, true);
  assert.equal(s.search.rawOnly, true); assert.deepEqual(s.filter.kinds, ['RAW']);
  s = setRawOnly(s, false);
  assert.equal(s.search.rawOnly, false); assert.deepEqual(s.filter.kinds, []);
  const w = withFilter(NO_FIND, { ...NO_FILTER, minRating: 2, takenFrom: 'a', takenTo: 'b', kinds: ['RAW'] });
  assert.deepEqual([w.search.minRating, w.search.takenFrom, w.search.takenTo, w.search.rawOnly], [2, 'a', 'b', true]);
});

test('settingOf', () => {
  for (const c of CATEGORIES) for (const server of [false, true]) assert.equal(settingOf(c.key, NO_FIND, server), null, c.key);
  const s = st({ make: 'Nikon', model: 'Z6', lens: 'L', tagIds: ['t1'], rawOnly: true },
    { cameras: ['C'], lenses: ['LL'], keywords: ['kw'], kinds: ['JPEG'] });
  assert.deepEqual(settingOf('cameras', s, true), { make: 'Nikon', model: 'Z6' });
  assert.deepEqual(settingOf('lenses', s, true), { lens: 'L' });
  assert.deepEqual(settingOf('keywords', s, true), { values: ['t1'] });
  assert.deepEqual(settingOf('kinds', s, true), { flags: ['raw'] });
  assert.deepEqual(settingOf('cameras', s, false), { values: ['C'] });
  assert.deepEqual(settingOf('lenses', s, false), { values: ['LL'] });
  assert.deepEqual(settingOf('keywords', s, false), { values: ['kw'] });
  assert.deepEqual(settingOf('kinds', s, false), { values: ['JPEG'] });
  assert.equal(settingOf('rating', st({ minRating: 3 }), true).stars, 3);
  assert.equal(settingOf('rating', st({}, { minRating: 2 }), false).stars, 2);
  // Edit status is its own category; the rating setting no longer carries it
  assert.deepEqual(settingOf('edits', st({}, { edited: 'edited' }), false), { edited: 'edited' });
  assert.equal(settingOf('rating', st({}, { edited: 'unedited' }), false), null);
  assert.equal(settingOf('rating', st({}, { minRating: 2, edited: 'edited' }), false).edited, undefined);
});

test('clearCategory clears both halves', () => {
  const s = st({ minRating: 3, rawOnly: true, tagIds: ['t'], make: 'a', model: 'b', lens: 'c', takenFrom: 'x', takenTo: 'y' },
    { minRating: 3, kinds: ['RAW'], keywords: ['k'], cameras: ['c'], takenFrom: 'x', takenTo: 'y', rejected: 'hide' });
  let r = clearCategory(s, 'rating');
  assert.equal(r.search.minRating, 0); assert.equal(r.filter.minRating, 0); assert.equal(r.filter.rejected, 'all');
  r = clearCategory(st({}, { edited: 'unedited', minRating: 2 }), 'edits');
  assert.equal(r.filter.edited, 'all'); assert.equal(r.filter.minRating, 2);
  r = clearCategory(st({}, { edited: 'unedited', minRating: 2 }), 'rating');
  assert.equal(r.filter.edited, 'unedited'); assert.equal(r.filter.minRating, 0);
  r = clearCategory(s, 'kinds');
  assert.equal(r.search.rawOnly, false); assert.deepEqual(r.filter.kinds, []);
  r = clearCategory(s, 'keywords');
  assert.deepEqual([r.search.tagIds, r.filter.keywords], [[], []]);
  r = clearCategory(s, 'cameras');
  assert.deepEqual([r.search.make, r.search.model, r.search.lens, r.filter.cameras], ['', '', '', []]);
  r = clearCategory(s, 'taken');
  assert.deepEqual([r.search.takenFrom, r.search.takenTo, r.filter.takenFrom, r.filter.takenTo], ['', '', '', '']);
});

test('clearAll clears the words, keeping where and how', () => {
  const base = { text: 'cat', mode: 'filename', source: 'both', scope: 'library', subject: 'edited', library: 'all' };
  const dirty = st({ ...base, minRating: 2, favorites: true, personIds: ['p'], albumIds: ['a'], country: 'NL', city: 'X', rawOnly: true },
    { cameras: ['c'], bodies: ['b'], lenses: ['l'], iso: ['100'], kinds: ['RAW'], rejected: 'only', labels: 1, unlabeled: true, edited: 'only' });
  assert.ok(sameFind(clearAll(dirty), st({ ...base, text: '' })));
  assert.deepEqual([clearAll(dirty).search.text, clearAll(dirty).search.mode], ['', 'filename']);
});

test('active filters count categories, not values', () => {
  assert.equal(findCount(st({ minRating: 3 }, { minRating: 3, rejected: 'hide' }), false), 1);
  assert.equal(findCount(st({ minRating: 3 }, { minRating: 3, rejected: 'hide', edited: 'edited' }), false), 2);
});

test('chips excludes', () => {
  const s = st({ source: 'both', personIds: ['p'], tagIds: ['t'], minRating: 2, takenFrom: '2020-01-01' },
    { keywords: ['k'], minRating: 2, takenFrom: '2020-01-01' });
  const by = (cs) => Object.fromEntries(cs.map(c => [c.key, c.excludes]));
  let e = by(chips(s, true));
  assert.equal(e.people, 'local'); assert.equal(e.keywords, 'immich'); assert.equal(e.rating, null); assert.equal(e.taken, null);
  const ed = chips(st({ source: 'both' }, { edited: 'edited' }), true);
  assert.deepEqual(ed.map(c => c.key), ['edits']); assert.equal(ed[0].excludes, 'immich');
  assert.deepEqual(chips(st({ source: 'local' }, { edited: 'unedited' }), true).map(c => c.setting), [{ edited: 'unedited' }]);
  assert.deepEqual(chips(st({ source: 'immich' }, { edited: 'edited' }), true), []);
  const rej = st({ source: 'both' }, { rejected: 'hide' });
  assert.equal(by(chips(rej, true)).rating, 'immich');
  const loc = { ...s, search: { ...s.search, source: 'local' } };
  for (const c of chips(loc, true)) assert.equal(c.excludes, null);
  assert.equal(findCount(s, true), chips(s, true).length);
  assert.equal(findCount(NO_FIND, true), 0);
});

test('sameFind', () => {
  const a = st({ text: ' cat ', personIds: ['a', 'b'] }, { cameras: ['x', 'y'] });
  const b = st({ text: 'cat', personIds: ['b', 'a'] }, { cameras: ['y', 'x'] });
  assert.ok(sameFind(a, b));
  assert.ok(!sameFind(a, { ...b, filter: { ...b.filter, minRating: 3 } }));
  assert.ok(!sameFind(a, { ...b, search: { ...b.search, minRating: 3 } }));
});

test('normalizeFind', () => {
  assert.deepEqual(normalizeFind(null), { search: NO_SEARCH, filter: NO_FILTER });
  assert.deepEqual(normalizeFind({}), { search: NO_SEARCH, filter: NO_FILTER });
  const n = normalizeFind({ search: { text: 'x' } });
  assert.deepEqual(n, { search: { ...NO_SEARCH, text: 'x' }, filter: NO_FILTER });
});

test('smartAvailable needs the CLIP model, morfPhoto CLIP, or Immich', () => {
  assert.equal(M.smartAvailable(false, false), false);
  assert.equal(M.smartAvailable(true, false), true);
  assert.equal(M.smartAvailable(false, true), true);
  assert.equal(M.smartAvailable(true, true), true);
  assert.equal(M.smartAvailable(false, false, true), true);
});

test('effectiveSearch searches file names only while Smart is unavailable, without rewriting the stored mode', () => {
  const smart = { ...NO_SEARCH, mode: 'smart', text: 'cat' };
  const stored = JSON.stringify(smart);
  assert.equal(M.effectiveSearch(smart, false).mode, 'filename');
  assert.equal(M.effectiveSearch(smart, false).text, 'cat');
  assert.equal(JSON.stringify(smart), stored, 'the input is not changed');
  assert.equal(M.effectiveSearch(smart, true), smart, 'Smart runs as chosen once it is available');
  const name = { ...smart, mode: 'filename' };
  assert.equal(M.effectiveSearch(name, false), name);
  assert.equal(M.effectiveSearch(name, true), name);
  // a saved filter that asks for Smart degrades the same way, and the mode does not change whether a search runs
  const saved = normalizeFind(JSON.parse(JSON.stringify({ search: smart, filter: NO_FILTER })));
  assert.equal(M.effectiveSearch(saved.search, false).mode, 'filename');
  assert.equal(needsSearch({ ...saved, search: M.effectiveSearch(saved.search, false) }, false), needsSearch(saved, false));
  assert.deepEqual(chips({ ...saved, search: M.effectiveSearch(saved.search, false) }, false), chips(saved, false));
});

test('clipTipVisible: only once known, missing, not dismissed, and not all remote', () => {
  assert.equal(M.clipTipVisible(false, false, false), false, 'not before the first status answer');
  assert.equal(M.clipTipVisible(true, false, false), true);
  assert.equal(M.clipTipVisible(true, true, false), false, 'gone once the model is installed');
  assert.equal(M.clipTipVisible(true, false, true), false, 'never again after dismissing');
  assert.equal(M.clipTipVisible(true, false, false, true), false, 'hidden when remote CLIP covers every folder');
});

test('File type ticks: All RAW, one raw extension, legacy kinds', async () => {
  const { passes, facets } = await import('../app/src/filter.ts');
  const { pickKinds } = M;
  const img = (filename) => ({ filename, rejected: false, edited: false, rating: 0, labels: 0, exif: {}, keywords: [] });
  const names = ['a.ORF', 'b.orf', 'c.DNG', 'd.jpg', 'e.JPEG', 'f.tiff', 'g.cr3'];
  const pass = (kinds) => names.filter((n) => passes(img(n), { ...NO_FILTER, kinds }));
  assert.deepEqual(pass(['ORF']), ['a.ORF', 'b.orf']);
  assert.deepEqual(pass(['RAW']), ['a.ORF', 'b.orf', 'c.DNG', 'g.cr3']);
  assert.deepEqual(pass(['DNG', 'JPG']), ['c.DNG', 'd.jpg', 'e.JPEG']);
  // saved filters from before the extension list still mean what they did
  assert.deepEqual(pass(['JPEG']), ['d.jpg', 'e.JPEG']);
  assert.deepEqual(pass(['TIFF']), ['f.tiff']);
  assert.deepEqual(pass([]), names);
  // the list: the RAW group, its extensions, then the others by name
  assert.deepEqual(facets(names.map(img)).kinds, [['RAW', 4], ['CR3', 1], ['DNG', 1], ['ORF', 2], ['JPG', 2], ['TIFF', 1]]);
  assert.deepEqual(facets([img('a.jpg')]).kinds, [['JPG', 1]]);
  // All RAW and the raw extensions exclude each other; others combine
  assert.deepEqual(pickKinds(['ORF'], ['ORF', 'RAW']), ['RAW']);
  assert.deepEqual(pickKinds(['RAW'], ['RAW', 'ORF']), ['ORF']);
  assert.deepEqual(pickKinds(['RAW'], ['RAW', 'JPG']), ['RAW', 'JPG']);
  assert.deepEqual(pickKinds(['RAW'], []), []);
  // RAW alone still narrows the server to Raw only; an extension does not
  assert.equal(setKinds(st(), ['RAW']).search.rawOnly, true);
  assert.equal(setKinds(st(), ['ORF']).search.rawOnly, false);
});
