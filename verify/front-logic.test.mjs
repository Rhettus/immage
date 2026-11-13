// SPDX-License-Identifier: GPL-3.0-or-later
// Engine-free unit tests of exportTokens.ts, paths.ts, filter.ts, library.ts
// (pairing, withKnown) and keys.ts (fieldKeeps)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../app/package.json', import.meta.url));
const { transformSync } = await import(require.resolve('rolldown/experimental'));
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@tauri-apps/api/core') return { url: 'data:text/javascript,export const invoke=async()=>({});', shortCircuit: true };
    if (spec === '@tauri-apps/api/event') return { url: 'data:text/javascript,export const listen=async()=>()=>{};', shortCircuit: true };
    // library.ts only uses immich.ts for thumbnails, which these tests never fetch
    if (spec === './immich' && ctx.parentURL?.endsWith('/library.ts')) return { url: 'data:text/javascript,export const fetchImmichThumb=async()=>null;', shortCircuit: true };
    if (spec.startsWith('./') || spec.startsWith('../')) for (const ext of ['.ts', '.tsx']) {
      const url = new URL(spec + ext, ctx.parentURL);
      if (existsSync(url)) return next(url.href, ctx);
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (!url.startsWith('file:') || !/\.tsx?$/.test(url)) return next(url, ctx);
    const path = fileURLToPath(url);
    return { format: 'module', source: transformSync(path, readFileSync(path, 'utf8'), { jsx: { runtime: 'automatic' } }).code, shortCircuit: true };
  },
});
const T = await import('../app/src/exportTokens.ts');
const P = await import('../app/src/paths.ts');
const F = await import('../app/src/filter.ts');
const L = await import('../app/src/library.ts');
const K = await import('../app/src/keys.ts');

const exif = (o = {}) => ({ maker: 'Canon', model: 'EOS R5', lens: 'RF 50mm F1.8', exposure: 1 / 250, aperture: 2.79,
  iso: 400.4, focal_length: 50, exposure_bias: 0, focus_distance: 0, datetime: '2024:03:05 14:07:09', ...o });
const img = (o = {}) => ({ imgid: 1, path: '/p/IMG_0001.CR3', filename: 'IMG_0001.CR3', rating: 3, rejected: false, labels: 0,
  edited: false, width: 10, height: 10, exif: exif(o.exif), ...o, ...(o.exif ? { exif: exif(o.exif) } : {}) });
const meta = { title: 'T', description: 'D', creator: 'C', rights: 'R' };

// ---- exportTokens
test('every file name token expands', () => {
  const i = img();
  const x = (t, n = 7, tot = 20) => T.expand(t, i, meta, n, tot, 'YYYY-MM-DD');
  assert.equal(x('{filename}'), 'IMG_0001');
  assert.equal(x('{title}'), 'T');
  assert.equal(x('{caption}'), 'D');
  assert.equal(x('{creator}'), 'C');
  assert.equal(x('{copyright}'), 'R');
  assert.equal(x('{datecaptured}'), '2024-03-05');
  assert.equal(x('{timecaptured}'), '140709');
  assert.equal(x('{year}{month}{day}'), '20240305');
  assert.equal(x('{camera}'), 'EOS R5');
  assert.equal(x('{lens}'), 'RF 50mm F1.8');
  assert.equal(x('{iso}'), '400');
  assert.equal(x('{rating}'), '3');
  assert.equal(x('{seq}'), '007');
  for (const t of T.TOKENS) assert.notEqual(x(`a{${t}}`), `a{${t}}`, t);
});
test('token formats, unknown tokens and sequence padding', () => {
  const i = img();
  assert.equal(T.expand('{datecaptured:YY.MM.DD}_{timecaptured:HH-mm-ss}', i, meta, 1, 1, 'YYYY'), '24.03.05_14-07-09');
  assert.equal(T.expand('{filename}_{nope}', i, meta, 1, 1, 'YYYY'), 'IMG_0001_{nope}');
  assert.equal(T.expand('{seq}', i, meta, 5, 99, 'YYYY'), '005');
  assert.equal(T.expand('{seq}', i, meta, 5, 1000, 'YYYY'), '0005');
  assert.equal(T.expand('{seq}', i, meta, 12345, 12345, 'YYYY'), '12345');
});
test('characters illegal in file names become underscores, runs collapse', () => {
  const m = { ...meta, title: 'a/b\\c:d*e?f"g<h>i|j' };
  assert.equal(T.expand('{title}', img(), m, 1, 1, 'YYYY'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(T.expand('{title}', img(), { ...meta, title: 'a//::b' }, 1, 1, 'YYYY'), 'a_b');
  assert.equal(T.expand('x{title}', img(), { ...meta, title: 'l1\nl2\tz' }, 1, 1, 'YYYY'), 'xl1_l2_z');
  assert.equal(T.expand('a/b', img(), meta, 1, 1, 'YYYY'), 'a_b');
});
test('empty metadata trims separators and falls back to the original name', () => {
  const i = img({ filename: 'DSC.NEF', exif: { datetime: '', lens: 'n/a', iso: 0 } });
  const e = T.EMPTY_META;
  assert.equal(T.expand('{title}', i, e, 1, 1, 'YYYY'), 'DSC');
  assert.equal(T.expand('{title}-{creator}', i, e, 1, 1, 'YYYY'), 'DSC');
  assert.equal(T.expand('{title}_{seq}', i, e, 2, 3, 'YYYY'), '002');
  assert.equal(T.expand('{year}-{lens}-{iso}-{filename}', i, e, 1, 1, 'YYYY'), 'DSC');
  assert.equal(T.expand('{datecaptured}', i, e, 1, 1, 'YYYY'), 'DSC');
  assert.equal(T.expand('', i, e, 1, 1, 'YYYY'), 'DSC');
  assert.equal(T.expand('a__b  c--d', i, e, 1, 1, 'YYYY'), 'a_b c-d');
  assert.equal(T.expand('{filename}', img({ filename: 'a.b.c.jpg' }), e, 1, 1, ''), 'a.b.c');
  assert.equal(T.expand('{filename}', img({ filename: 'noext' }), e, 1, 1, ''), 'noext');
});
test('a malformed capture time yields empty date tokens', () => {
  const i = img({ exif: { datetime: 'garbage' } });
  assert.equal(T.expand('{year}x', i, meta, 1, 1, 'YYYY'), 'x');
});
test('shutter text', () => {
  assert.equal(T.shutter(0), ''); assert.equal(T.shutter(-1), ''); assert.equal(T.shutter(NaN), '');
  assert.equal(T.shutter(1 / 250), '1/250'); assert.equal(T.shutter(0.3), '0.3s');
  assert.equal(T.shutter(2), '2s'); assert.equal(T.shutter(1.25), '1.3s');
});
test('every caption token expands, with fallbacks and unknown tokens kept', () => {
  const i = img({ exif: { exposure_bias: -0.7, focus_distance: 2.5, maker: 'Canon', focal_length: 50 } });
  const x = (t, m = meta) => T.expandText(t, i, m);
  assert.equal(x('{title}|{caption}|{creator}|{copyright}|{filename}'), 'T|D|C|R|IMG_0001');
  assert.equal(x('{dateCaptured}'), '2024/03/05');
  assert.equal(x('{dateCaptured:YYYY.MM.DD}'), '2024.03.05');
  assert.equal(x('{timeCaptured}'), '14:07');
  assert.equal(x('{timeCaptured:HH:mm:ss}'), '14:07:09');
  assert.equal(x('{cameraMake}/{cameraModel}/{lens}'), 'Canon/EOS R5/RF 50mm F1.8');
  assert.equal(x('{focalLength} {aperture} {shutterSpeed} {isoSpeedRating}'), '50 mm f/2.8 1/250 ISO 400');
  assert.equal(x('{shootingInfo}'), '50 mm · f/2.8 · 1/250 · ISO 400');
  assert.equal(x('{exposureBias}'), '-0.7 EV');
  assert.equal(x('{subjectDistance}'), '2.50 m');
  assert.equal(x('{rating}'), '\u2605\u2605\u2605');
  assert.equal(x('{bogus}'), '{bogus}');
  assert.equal(x('{title, none}', T.EMPTY_META), 'none');
  assert.equal(x('{title, none}'), 'T');
  assert.equal(x('{title}', T.EMPTY_META), '');
  assert.equal(T.expandText('{exposureBias}', img({ exif: { exposure_bias: 1 } }), meta), '+1 EV');
  for (const [, items] of T.TEXT_TOKENS) for (const [k] of items) assert.notEqual(x(`{${k}}`), `{${k}}`, k);
});
test('caption tokens on a photo without exposure data', () => {
  const i = img({ rating: 0, exif: { lens: 'n/a', exposure: 0, aperture: 0, iso: 0, focal_length: 0, datetime: '' } });
  assert.equal(T.expandText('{lens}{shootingInfo}{rating}{dateCaptured}[{aperture, no f}]', i, meta), '[no f]');
});

// ---- paths
test('baseName', () => {
  assert.equal(P.baseName('/a/b/c.jpg'), 'c.jpg');
  assert.equal(P.baseName('C:\\Users\\me\\c.jpg'), 'c.jpg');
  assert.equal(P.baseName('C:/mixed\\sep/c.jpg'), 'c.jpg');
  assert.equal(P.baseName('/a/b/'), 'b');
  assert.equal(P.baseName('C:\\a\\b\\\\'), 'b');
  assert.equal(P.baseName('\\\\server\\share\\f\\x.raw'), 'x.raw');
  assert.equal(P.baseName('\\\\server\\share'), 'share');
  assert.equal(P.baseName('C:\\'), 'C:');
  assert.equal(P.baseName('name'), 'name');
  assert.equal(P.baseName('/'), '/');
  assert.equal(P.baseName(''), '');
});
test('parentDir', () => {
  assert.equal(P.parentDir('/a/b/c.jpg'), '/a/b');
  assert.equal(P.parentDir('C:\\Users\\me\\c.jpg'), 'C:\\Users\\me');
  assert.equal(P.parentDir('C:/x/c.jpg'), 'C:/x');
  assert.equal(P.parentDir('\\\\srv\\share\\c.jpg'), '\\\\srv\\share');
  assert.equal(P.parentDir('name'), 'name');
  // a file at the root loses its separator: the root is "", not "/"
  assert.equal(P.parentDir('/c.jpg'), '');
  assert.equal(P.parentDir('C:\\c.jpg'), 'C:');
  // a trailing separator is the folder's own: its "parent" is the folder
  assert.equal(P.parentDir('/a/b/'), '/a/b');
});
test('within', () => {
  assert.ok(P.within('/a/b', '/a/b'));
  assert.ok(P.within('/a/b/c', '/a/b'));
  assert.ok(P.within('/a/b/c', '/a/b/'));
  assert.ok(P.within('/a/b/c', '/a/b///'));
  assert.ok(!P.within('/a/bc', '/a/b'));
  assert.ok(!P.within('/a', '/a/b'));
  assert.ok(P.within('C:\\a\\b\\c', 'C:\\a\\b'));
  // separators are not normalized: a path and base must use the same one
  assert.ok(!P.within('C:\\a\\b\\c', 'C:/a/b'));
  assert.ok(!P.within('C:\\a\\bc', 'C:\\a\\b'));
  assert.ok(P.within('\\\\srv\\share\\x', '\\\\srv\\share'));
  assert.ok(P.within('/a', '/'), 'root');
  // the comparison is case-sensitive, also for drive letters
  assert.ok(!P.within('c:\\a\\b', 'C:\\a'));
});

// ---- keys
test('fieldKeeps', () => {
  const t = (tagName, type) => ({ tagName, type });
  assert.equal(K.fieldKeeps(null, 'a'), false);
  assert.equal(K.fieldKeeps(t('DIV'), 'a'), false);
  assert.equal(K.fieldKeeps(t('BUTTON'), ' '), false);
  assert.equal(K.fieldKeeps(t('TEXTAREA'), 'x'), true);
  assert.equal(K.fieldKeeps(t('INPUT', 'text'), 'x'), true);
  assert.equal(K.fieldKeeps(t('INPUT', 'number'), 'Delete'), true);
  assert.equal(K.fieldKeeps(t('INPUT', 'range'), 'ArrowLeft'), true);
  assert.equal(K.fieldKeeps(t('INPUT', 'range'), 'o'), false);
  assert.equal(K.fieldKeeps(t('INPUT', 'checkbox'), ' '), true);
  assert.equal(K.fieldKeeps(t('INPUT', 'checkbox'), 'o'), false);
  assert.equal(K.fieldKeeps(t('INPUT', 'checkbox'), 'ArrowLeft'), false);
  for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Enter', ' '])
    assert.equal(K.fieldKeeps(t('SELECT'), k), true, k);
  assert.equal(K.fieldKeeps(t('SELECT'), 'a'), false);
  assert.equal(K.fieldKeeps(t('SELECT'), 'Escape'), false);
});
test('keys() writes shortcuts for a non-Mac platform', () => {
  assert.equal(K.IS_MAC, false);
  assert.equal(K.keys('\u21e7\u2318E'), 'Ctrl+Shift+E');
  assert.equal(K.keys('\u2325-click'), 'Alt-click');
  assert.equal(K.keys('hold \u2325'), 'hold Alt');
  assert.equal(K.keys('(hold \u2325)'), '(hold Alt)');
});

// ---- library: kinds, pairing, ordering
test('fileKind', () => {
  assert.equal(L.fileKind('a.JPG'), 'JPEG'); assert.equal(L.fileKind('a.heic'), 'HEIF');
  assert.equal(L.fileKind('a.CR3'), 'RAW'); assert.equal(L.fileKind('a.tiff'), 'TIFF');
  assert.equal(L.fileKind('noext'), 'RAW'); assert.equal(L.fileKind('a.b.jpeg'), 'JPEG');
  assert.equal(L.fileKind('a.pgm'), 'PNM');
});
test('pairKey, isCompanion, isPrimaryRaw', () => {
  assert.equal(L.pairKey('/p/IMG_1.CR3'), L.pairKey('/p/img_1.jpg'));
  assert.notEqual(L.pairKey('/p/IMG_1.CR3'), L.pairKey('/q/IMG_1.CR3'));
  assert.equal(L.pairKey('C:\\p.d\\IMG_1.CR3'), 'c:\\p.d\\img_1');
  assert.ok(L.isCompanion('a.jpg') && L.isCompanion('a.HIF') && L.isCompanion('a.ORI'));
  assert.ok(!L.isCompanion('a.cr3') && !L.isCompanion('a.png'));
  assert.ok(L.isPrimaryRaw('a.orf') && !L.isPrimaryRaw('a.ori') && !L.isPrimaryRaw('a.jpg'));
});
const e = (imgid, path, o = {}) => img({ imgid, path, filename: path.split('/').pop(), ...o });
test('pairPartners stacks companions behind a single raw', () => {
  const raw = e(1, '/p/A.CR3'), jpg = e(2, '/p/a.jpg'), heif = e(3, '/p/A.heic'), lone = e(4, '/p/B.jpg');
  const m = L.pairPartners([raw, jpg, heif, lone]);
  assert.deepEqual([...m.keys()], [1]);
  assert.deepEqual(m.get(1).map((x) => x.imgid), [2, 3]);
});
test('pairPartners: two raws, a virtual copy, .ORI, other folder and PNG pair nothing wrongly', () => {
  assert.equal(L.pairPartners([e(1, '/p/A.CR3'), e(2, '/p/A.NEF'), e(3, '/p/A.jpg')]).size, 0);
  assert.equal(L.pairPartners([e(1, '/p/A.CR3'), e(2, '/p/A.jpg', { copy: true })]).size, 0);
  assert.equal(L.pairPartners([e(1, '/p/A.CR3'), e(2, '/q/A.jpg')]).size, 0);
  assert.equal(L.pairPartners([e(1, '/p/A.CR3'), e(2, '/p/A.png')]).size, 0);
  const ori = L.pairPartners([e(1, '/p/A.ORF'), e(2, '/p/A.ORI')]);
  assert.deepEqual(ori.get(1).map((x) => x.imgid), [2]);
  assert.equal(L.pairPartners([e(1, '/p/A.ORI')]).size, 0);
});
test('byCaptureTime and withKnown ordering', () => {
  const k = (path, datetime, file_datetime) => ({ ...e(0, path), imgid: undefined, exif: exif({ datetime, file_datetime }) });
  const a = k('/a', '2024:01:02 00:00:00'), b = k('/b', '2024:01:01 00:00:00'), c = k('/c', '', '2023:12:31 00:00:00'),
    n1 = k('/n1', ''), n2 = k('/n2', ''), t1 = k('/t1', '2024:01:02 00:00:00');
  assert.deepEqual(L.byCaptureTime([n1, a, c, b, n2]).map((x) => x.path), ['/c', '/b', '/a', '/n1', '/n2']);
  const input = [a, b]; L.byCaptureTime(input);
  assert.deepEqual(input.map((x) => x.path), ['/a', '/b'], 'does not mutate');
  // ties: read ones go first
  assert.deepEqual(L.withKnown([a], [t1, b]).map((x) => x.path), ['/b', '/a', '/t1']);
  assert.deepEqual(L.withKnown([], []), []);
  assert.deepEqual(L.withKnown([n1], [n2, c]).map((x) => x.path), ['/c', '/n1', '/n2']);
  assert.equal(L.knownKey({ path: '/x' }), '0:/x'); assert.equal(L.knownKey({ path: '/x', version: 2 }), '2:/x');
  assert.equal(L.takenAt({ exif: { datetime: '', file_datetime: 'f' } }), 'f');
});

// ---- filter
const NF = F.NO_FILTER;
const f = (o) => ({ ...NF, ...o });
test('passes: every field', () => {
  const i = img({ rating: 3, labels: 5, keywords: ['a|b|c', 'x'], exif: { body_serial: ' 123 ' } });
  assert.ok(F.passes(i, NF));
  assert.ok(F.passes(i, f({ minRating: 3 })) && !F.passes(i, f({ minRating: 4 })));
  assert.ok(!F.passes(img({ rejected: true, rating: 5 }), f({ minRating: 1 })), 'rejected never meets a star filter');
  assert.ok(!F.passes(i, f({ rejected: 'only' })) && F.passes(i, f({ rejected: 'hide' })));
  assert.ok(F.passes(img({ rejected: true }), f({ rejected: 'only' })));
  assert.ok(!F.passes(img({ rejected: true }), f({ rejected: 'hide' })));
  assert.ok(!F.passes(i, f({ edited: 'edited' })) && F.passes(i, f({ edited: 'unedited' })));
  assert.ok(F.passes(i, f({ labels: 1 })) && F.passes(i, f({ labels: 2 | 4 })) && !F.passes(i, f({ labels: 2 })));
  assert.ok(!F.passes(i, f({ unlabeled: true })) && F.passes(img(), f({ unlabeled: true })));
  assert.ok(F.passes(i, f({ unlabeled: true, labels: 1 })));
  assert.ok(F.passes(i, f({ kinds: ['RAW'] })) && !F.passes(i, f({ kinds: ['JPEG', 'TIFF'] })));
  assert.ok(F.passes(i, f({ cameras: ['Canon EOS R5'] })) && !F.passes(i, f({ cameras: ['Nikon Z6'] })));
  assert.ok(F.passes(i, f({ lenses: ['RF 50mm F1.8'] })) && !F.passes(i, f({ lenses: ['x'] })));
  assert.ok(F.passes(i, f({ bodies: [F.bodyOf(i)] })) && !F.passes(img(), f({ bodies: [F.bodyOf(i)] })));
  assert.ok(F.passes(img(), f({ bodies: [''] })), 'no serial is the "not recorded" body');
});
test('passes: keywords nest, all must match', () => {
  const i = img({ keywords: ['a|b|c', 'x'] });
  assert.ok(F.passes(i, f({ keywords: ['a'] })) && F.passes(i, f({ keywords: ['a|b'] })) && F.passes(i, f({ keywords: ['a', 'x'] })));
  assert.ok(!F.passes(i, f({ keywords: ['a', 'y'] })) && !F.passes(i, f({ keywords: ['a|bb'] })) && !F.passes(i, f({ keywords: ['b'] })));
  assert.ok(!F.passes(img(), f({ keywords: ['a'] })));
});
test('passes: dates and exposure', () => {
  const i = img();
  assert.ok(F.passes(i, f({ takenFrom: '2024-03-05', takenTo: '2024-03-05' })));
  assert.ok(!F.passes(i, f({ takenFrom: '2024-03-06' })) && !F.passes(i, f({ takenTo: '2024-03-04' })));
  const none = img({ exif: { datetime: '' } });
  assert.ok(!F.passes(none, f({ takenFrom: '2000-01-01' })) && !F.passes(none, f({ takenTo: '2999-01-01' })));
  const fileOnly = img({ exif: { datetime: '', file_datetime: '2024:03:05 01:00:00' } });
  assert.ok(F.passes(fileOnly, f({ takenFrom: '2024-03-05' })));
  assert.ok(F.passes(i, f({ iso: ['400'], aperture: ['f/2.8'], focal: ['50 mm'], shutter: ['1/250'] })));
  assert.ok(!F.passes(i, f({ iso: ['800'] })));
  assert.ok(!F.passes(img({ exif: { iso: 0 } }), f({ iso: ['0'] })));
});
test('exposureLabel, popupCount, needsRead, bodyLabel', () => {
  assert.equal(F.exposureLabel('iso', 0), ''); assert.equal(F.exposureLabel('aperture', 2.79), 'f/2.8');
  assert.equal(F.exposureLabel('aperture', 4), 'f/4'); assert.equal(F.exposureLabel('focal', 24.4), '24 mm');
  assert.equal(F.exposureLabel('shutter', 1 / 250), '1/250');
  assert.equal(F.popupCount(NF), 0);
  assert.equal(F.popupCount(f({ rejected: 'hide', kinds: ['RAW'], iso: ['1'], takenTo: '2020-01-01' })), 4);
  assert.equal(F.needsRead(NF), false);
  assert.equal(F.needsRead(f({ kinds: ['RAW'] })), false, 'a file type needs no read');
  assert.equal(F.needsRead(f({ kinds: ['RAW'], cameras: ['x'] })), true);
  assert.equal(F.needsRead(f({ minRating: 1 })), true);
  assert.equal(F.needsRead(f({ cameras: ['x'] })), true);
  assert.equal(F.bodyLabel(''), 'Serial not recorded');
  assert.equal(F.bodyLabel(F.bodyOf(img({ exif: { body_serial: '9' } }))), 'Canon EOS R5 \u00b7 Serial 9');
});
test('facets: counts, order, nesting', () => {
  const imgs = [
    img({ imgid: 1, filename: 'a.cr3', keywords: ['a|b'], exif: { datetime: '2024:03:05 10:00:00', iso: 800, exposure: 1 / 60 } }),
    img({ imgid: 2, filename: 'b.jpg', keywords: ['a|b', 'a|c', 'a|b'], exif: { datetime: '2023:12:05 10:00:00', iso: 100, lens: 'Z' } }),
    img({ imgid: 3, filename: 'c.png', keywords: undefined, exif: { datetime: '', file_datetime: '2024:01:01 00:00:00', maker: '', model: '' } }),
    img({ imgid: 4, filename: 'd.nef', exif: { iso: 0 } }),
  ];
  const r = F.facets(imgs);
  assert.deepEqual(r.kinds, [['RAW', 2], ['JPEG', 1], ['PNG', 1]]);
  assert.deepEqual(r.keywords, [['a', 2], ['a|b', 2], ['a|c', 1]]);
  assert.deepEqual(r.months, [['2024-03', 2], ['2024-01', 1], ['2023-12', 1]]);
  assert.deepEqual(r.iso, [['100', 1], ['400', 1], ['800', 1]]);
  assert.deepEqual(r.cameras.find(([n]) => n === 'Canon EOS R5'), ['Canon EOS R5', 3]);
  assert.ok(!r.cameras.some(([n]) => n === ''), 'a photo without a camera is not a facet');
  assert.deepEqual(r.bodies, [['', 4]], 'photos without a serial form the not-recorded body');
  assert.deepEqual(F.facets([]).kinds, []);
});
test('facetsWithin narrows by the rest of the filter, not the list shown', () => {
  const imgs = [img({ imgid: 1, exif: { model: 'A', lens: 'L1' } }), img({ imgid: 2, exif: { model: 'B', lens: 'L2' } })];
  const flt = f({ cameras: ['Canon A'] });
  assert.deepEqual(F.facetsWithin(imgs, flt, {}).lenses, [['L1', 1]]);
  assert.deepEqual(F.facetsWithin(imgs, flt, { cameras: [] }).lenses, [['L1', 1], ['L2', 1]]);
});
