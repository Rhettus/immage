// SPDX-License-Identifier: GPL-3.0-or-later
// Engine-free: Find's lists of values. filter.ts `facets` / `facetsWithin` and `passes` are the
// reference the Rust side (find_facets.rs, search_filters.rs) is tested against over the same
// photos and filters (verify/fixtures/find-facets.json, rewritten with WRITE_FIXTURES=1), and
// the long-list rule of libraryFacets.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

const { NO_FILTER, passes, facetsWithin, EXPOSURE } = await import('../app/src/filter.ts');
const { shownValues, MOST_USED } = await import('../app/src/libraryFacets.ts');

const FIXTURE = fileURLToPath(new URL('./fixtures/find-facets.json', import.meta.url));

// deterministic photos with every value the lists and filters read
function build() {
  let seed = 12345;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = (a) => a[Math.floor(next() * a.length)];
  const cameras = [['Nikon', 'Z 6'], ['Canon', 'EOS R5'], ['Sony', 'ILCE-7M3'], ['Fujifilm', 'X-T4'], ['', ''], ['Acme', 'X1']];
  const lenses = ['Canon RF 24-105mm F4 L IS USM', 'Nikkor Z 24-70mm f/4 S', 'FE 24-70mm F2.8 GM', '', 'Sigma 35mm F1.4'];
  const serials = ['', '', '123', '456'];
  const iso = [0, 100, 100.4, 400, 1600, 3199.5, 6400];
  const aperture = [0, 1.8, 2.25, 2.55, 2.8, 5.6, 11.04];
  const focal = [0, 24, 24.5, 35, 50, 85];
  const shutter = [0, 0.000125, 0.004, 0.29, 0.2999, 0.3, 0.301, 0.5, 1, 2.5, 30];
  const names = ['a.ARW', 'b.arw', 'c.jpg', 'd.JPEG', 'e.tif', 'f.png', 'g.nef', 'h.cr3', 'i.dng', 'j.heic', 'k.ori', 'l.bmp', 'm.jpe', 'o.TIFF', 'p.raf', 'q.orf'];
  const dates = ['', '2024:05:06 10:11:12', '2023:12:31 23:59:59', '2024:06:15 08:00:00', '2022:11:01 08:00:00', '2024:05:20 09:00:00'];
  const words = ['a', 'a|b', 'a|b|c', 'ab', 'a b', 'á', 'x|y', 'Places|France|Paris', 'Places|France', 'Places', 'People|Ann', 'b|a'];
  const photos = [];
  for (let n = 0; n < 160; n++) {
    const [maker, model] = pick(cameras), name = n < names.length ? names[n] : pick(names);
    photos.push({
      imgid: n + 1, path: `/p/${n}-${name}`, filename: `${n}-${name}`,
      rating: Math.floor(next() * 6), rejected: next() < 0.2, labels: Math.floor(next() * 32), edited: next() < 0.4,
      width: 0, height: 0, location: null, keywords: Array.from({ length: Math.floor(next() * 4) }, () => pick(words)),
      version: 0, copy: false,
      exif: { maker, model, lens: pick(lenses), body_serial: pick(serials), exposure: pick(shutter), aperture: pick(aperture),
        iso: pick(iso), focal_length: pick(focal), exposure_bias: 0, focus_distance: 0, datetime: pick(dates), capture_time_raw: '', file_datetime: '' },
    });
  }
  return photos;
}

const filters = () => {
  const f = (o) => ({ ...NO_FILTER, ...o });
  return [
    f({}), f({ minRating: 3 }), f({ rejected: 'hide' }), f({ rejected: 'only' }), f({ minRating: 2, rejected: 'only' }),
    f({ edited: 'edited' }), f({ edited: 'unedited' }), f({ labels: 3 }), f({ unlabeled: true }), f({ labels: 5, unlabeled: true }),
    f({ kinds: ['RAW'] }), f({ kinds: ['ARW'] }), f({ kinds: ['JPG'] }), f({ kinds: ['TIFF', 'PNG'] }), f({ kinds: ['JPEG'] }),
    f({ cameras: ['Nikon Z 6'] }), f({ cameras: ['Canon EOS R5', 'Sony ILCE-7M3'] }), f({ cameras: ['Acme X1'], minRating: 1 }),
    f({ bodies: [JSON.stringify(['Nikon', 'Z 6', '123'])] }), f({ bodies: [''] }),
    f({ lenses: ['FE 24-70mm F2.8 GM'] }), f({ lenses: ['Nikkor Z 24-70mm f/4 S'], cameras: ['Nikon Z 6'] }),
    f({ keywords: ['a'] }), f({ keywords: ['a|b'] }), f({ keywords: ['Places'] }), f({ keywords: ['Places', 'People'] }), f({ keywords: ['x'] }),
    f({ takenFrom: '2024-05-06' }), f({ takenTo: '2024-05-06' }), f({ takenFrom: '2023-12-31', takenTo: '2024-05-20' }),
    f({ iso: ['100'] }), f({ aperture: ['f/2.3', 'f/2.5'] }), f({ focal: ['24 mm'] }), f({ shutter: ['1/250', '0.3s'] }),
    f({ iso: ['400'], aperture: ['f/2.8'], rejected: 'hide', keywords: ['a'] }),
  ];
};
const NAME_LISTS = ['keywords', 'cameras', 'bodies', 'lenses'];
const CLEAR = {
  kinds: { kinds: [] }, keywords: { keywords: [] }, cameras: { cameras: [] }, bodies: { bodies: [] }, lenses: { lenses: [] },
  months: { takenFrom: '', takenTo: '' }, iso: { iso: [] }, aperture: { aperture: [] }, focal: { focal: [] }, shutter: { shutter: [] },
};
// names are in code point order here; the reader's order is the page's job
const byCodePoint = (l) => [...l].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

function expected() {
  const photos = build();
  return {
    photos,
    cases: filters().map((filter) => ({
      filter,
      matches: photos.flatMap((p, i) => (passes(p, filter) ? [i] : [])),
      lists: Object.fromEntries(Object.entries(CLEAR).map(([list, clear]) => {
        const l = facetsWithin(photos, filter, clear)[list];
        return [list, NAME_LISTS.includes(list) ? byCodePoint(l) : l];
      })),
    })),
  };
}

test('the fixture the Rust tests read is what filter.ts gives', () => {
  const want = expected();
  if (process.env.WRITE_FIXTURES) writeFileSync(FIXTURE, JSON.stringify(want) + '\n');
  const have = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  assert.deepEqual(have, JSON.parse(JSON.stringify(want)));
  assert.ok(want.cases.length >= 30);
  // lists that are not trivial
  assert.ok(want.cases[0].lists.kinds[0][0] === 'RAW');
  assert.ok(want.cases[0].lists.months.length > 3);
  assert.deepEqual(EXPOSURE, ['iso', 'aperture', 'focal', 'shutter']);
});

const items = (n) => Array.from({ length: n }, (_, i) => [`v${String(i).padStart(4, '0')}`, i % 7 + 1]);
const plain = (v) => v;

test('a long list draws the most used values and the chosen ones; the find box reaches the rest', () => {
  const all = items(500);
  const { shown, cut } = shownValues(all, [], '', plain, false);
  assert.equal(cut, true);
  assert.equal(shown.length, MOST_USED);
  // the most used first by count, ties in list order
  assert.ok(shown.every(([, n]) => n >= 5));
  assert.deepEqual(shown.map(([v]) => v), [...shown.map(([v]) => v)].sort());
  // a chosen value outside the top stays, and counts against the room
  const low = all.find(([, n]) => n === 1)[0];
  const kept = shownValues(all, [low], '', plain, false);
  assert.equal(kept.shown.length, MOST_USED);
  assert.ok(kept.shown.some(([v]) => v === low));
  // a chosen value the list no longer has is listed to untick
  assert.ok(shownValues(all, ['gone'], '', plain, false).shown.some(([v, n]) => v === 'gone' && n === 0));
  // find searches the whole list
  const found = shownValues(all, [], 'v0123', plain, false);
  assert.deepEqual(found.shown.map(([v]) => v), ['v0123']);
  assert.equal(found.cut, false);
  // a short list is whole, and sorted by name only when asked
  const short = [['b', 1], ['a', 2], ['É', 1]];
  assert.deepEqual(shownValues(short, [], '', plain, false).shown.map(([v]) => v), ['b', 'a', 'É']);
  assert.deepEqual(shownValues(short, [], '', plain, true).shown.map(([v]) => v), ['a', 'b', 'É']);
  assert.equal(shownValues(items(MOST_USED), [], '', plain, false).cut, false);
});
