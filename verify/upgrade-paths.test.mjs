// SPDX-License-Identifier: GPL-3.0-or-later
// What older versions left on disk, read by this version's front end: presets.json
// (bare list, v2, v3), export-presets.json, and a folder snapshot's entries
// (verify/fixtures/upgrade). The Rust side is tests/upgrade_paths.rs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(new URL('../app/package.json', import.meta.url));
const { transformSync } = await import(require.resolve('rolldown/experimental'));
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@tauri-apps/api/core') return { url: 'data:text/javascript,export const invoke=(...a)=>globalThis.__invoke(...a);', shortCircuit: true };
    if (spec === '@tauri-apps/api/event') return { url: 'data:text/javascript,export const listen=async()=>()=>{};', shortCircuit: true };
    if (spec === './immich' && ctx.parentURL?.endsWith('/library.ts')) return { url: 'data:text/javascript,export const fetchImmichThumb=async()=>null;', shortCircuit: true };
    if (spec.startsWith('./') || spec.startsWith('../')) for (const ext of ['.ts', '.tsx']) {
      const url = new URL(spec + ext, ctx.parentURL);
      if (existsSync(url)) return next(url.href, ctx);
    }
    if (!spec.startsWith('.') && !spec.startsWith('node:') && !spec.startsWith('data:') && !spec.startsWith('file:') && ctx.parentURL?.includes('/app/src/'))
      return next(pathToFileURL(require.resolve(spec)).href, ctx);
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (!url.startsWith('file:') || !/\.tsx?$/.test(url)) return next(url, ctx);
    const path = fileURLToPath(url);
    return { format: 'module', source: transformSync(path, readFileSync(path, 'utf8'), { jsx: { runtime: 'automatic' } }).code, shortCircuit: true };
  },
});
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/upgrade/${name}`, import.meta.url), 'utf8'));
// a stand-in for the Rust commands, answering as presets_load / export_presets_load do
let disk = {};
globalThis.__invoke = async (cmd, args) => {
  if (cmd === 'presets_load') return disk.presets ?? [];
  if (cmd === 'export_presets_load') return disk.export ?? null;
  if (cmd === 'presets_save') { disk.saved = args.presets; return null; }
  if (cmd === 'settings_all') return { 'immage.settings-migrated': '1' };
  return null;
};
const P = await import('../app/src/Presets.tsx');
const M = await import('../app/src/manifest.ts');
const E = await import('../app/src/exportSettings.ts');
const L = await import('../app/src/library.ts');
const F = await import('../app/src/filter.ts');

const byName = (l) => Object.fromEntries(l.map((p) => [p.name, p]));
const clamp = (x) => Math.max(-100, Math.min(100, x));

test('presets.json v1 (a bare list) keeps every preset, and migrates only the scales that changed', async () => {
  const old = fixture('presets-v1-bare-list.json');
  disk = { presets: old };
  const got = await P.loadPresets();
  assert.equal(got.length, old.length);
  assert.deepEqual(got.map((p) => [p.id, p.name, p.group, p.rawOnly]), old.map((p) => [p.id, p.name, p.group, p.rawOnly]));
  const moody = byName(got).Moody.values, was = old[0].values;
  assert.equal(Object.keys(moody).length, Object.keys(was).length, 'no slider dropped');
  // v1 -> v2: Blacks bends with Exposure; v2 -> v3: HSL saturation/luminance and B&W mix double
  assert.equal(moody.blacks, M.blacksFromLinear(was.blacks, was.exposure));
  assert.equal(moody.l_blacks, M.blacksFromLinear(was.l_blacks, was.l_exposure));
  assert.equal(moody.hsl_sat_red, clamp(2 * was.hsl_sat_red));
  assert.equal(moody.hsl_lum_blue, clamp(2 * was.hsl_lum_blue));
  assert.equal(moody.bw_red, clamp(2 * was.bw_red));
  for (const k of ['exposure', 'contrast', 'bw_mode', 'l_exposure']) assert.equal(moody[k], was[k], k);
  // a preset without migrated controls is untouched
  assert.deepEqual(byName(got)['Raw start'].values, old[1].values);
  assert.deepEqual(byName(got).Flat.values, old[2].values);
  for (const p of got) for (const v of Object.values(p.values)) assert.ok(Number.isFinite(v));
});

test('presets.json v2 migrates the HSL and B&W scales only', async () => {
  const old = fixture('presets-v2.json');
  disk = { presets: old };
  const got = await P.loadPresets();
  assert.deepEqual(got.map((p) => p.id), old.presets.map((p) => p.id));
  const w = byName(got)['Warm film'].values, was = old.presets[0].values;
  assert.equal(w.hsl_sat_orange, -100, 'doubled -80 is held at the slider end');
  assert.equal(w.hsl_lum_orange, 100);
  assert.equal(w.bw_mix, 80);
  assert.equal(w.l_hsl_sat_red, 90);
  for (const k of ['exposure', 'blacks', 'bw_mode', 'vibrance']) assert.equal(w[k], was[k], `${k} unchanged`);
  assert.equal(byName(got)['Imported default'].rawOnly, true);
});

test('presets.json at the current version is read as it is, and saved at the same version', async () => {
  const cur = fixture('presets-v3-current.json');
  disk = { presets: cur };
  const got = await P.loadPresets();
  assert.deepEqual(got, cur.presets);
  await P.savePresets(got);
  assert.equal(disk.saved.version, cur.version);
  assert.deepEqual(disk.saved.presets, cur.presets);
});

test('presets.json from a newer Immage is refused, not rewritten', async () => {
  disk = { presets: fixture('presets-future.json') };
  await assert.rejects(P.loadPresets(), /newer Immage/);
});

test('no presets.json yet (an empty list) loads as none', async () => {
  disk = {};
  assert.deepEqual(await P.loadPresets(), []);
});

test('migrated v1 presets round-trip through the shared preset file reader', async () => {
  disk = { presets: fixture('presets-v1-bare-list.json') };
  const got = await P.loadPresets();
  const shared = P.sharedPresets(got);
  const back = P.readSharedPresets(JSON.parse(JSON.stringify(shared)), []);
  const known = (p) => Object.keys(p.values).filter((k) => M.controlById.has(k)).length;
  assert.equal(back.length, got.filter((p) => known(p)).length, 'only presets with no known control may be left out');
  assert.equal(byName(back).Moody.values.blacks, byName(got).Moody.values.blacks);
});

test('export-presets.json from v0.31 loads whole and applies over this version\'s defaults', async () => {
  const old = fixture('export-presets-v0.31.json');
  disk = { export: old };
  const got = await E.loadPresets();
  assert.equal(got.length, 2);
  assert.deepEqual(got, old.presets, 'nothing reset or dropped on load');
  // choosing one (ExportDialog.applyPreset) lays its settings over the current ones: keys the old
  // file lacks (the metadata choices) keep their defaults, and none is lost
  const applied = { ...E.DEFAULTS, ...structuredClone(got[0].settings) };
  assert.equal(applied.quality, 85); assert.equal(applied.canvas, true); assert.equal(applied.removeLocation, true);
  assert.deepEqual(applied.keywords, ['web']); assert.equal(applied.borders[0].unit, 'long');
  assert.equal(applied.includeCamera, E.DEFAULTS.includeCamera);
  assert.equal(applied.includeKeywords, true);
  const tiff = { ...E.DEFAULTS, ...got[1].settings };
  assert.equal(tiff.format, 'tiff'); assert.equal(tiff.bpp, 16); assert.equal(tiff.conflict, 'overwrite');
  assert.equal(tiff.template, '{creator}-{datecaptured:YYYY.MM}-{seq}');
  assert.equal(tiff.texts.length, 1);
  assert.equal(got[1].icon, 'star');
  // a preset is "edited" only by a real change from the settings it applies
  assert.equal(E.presetEdited(got[0], applied), false);
  assert.equal(E.presetEdited(got[0], { ...applied, quality: 70 }), true);
  // every key an old preset holds is still a known export setting
  for (const p of got) for (const k of Object.keys(p.settings)) assert.ok(k in E.DEFAULTS, `${k} is no longer an export setting`);
});

test('no export-presets.json yet loads as none', async () => {
  disk = {};
  assert.deepEqual(await E.loadPresets(), []);
});

test('a v0.40.0 folder snapshot entry (without imgid, serial, version, keywords) is usable as a known image', () => {
  const known = fixture('snapshots/folder-v0.40.0.json');
  assert.equal(known.length, 3);
  // ordered by capture time: the file's own time stands in when none was recorded
  const order = L.byCaptureTime(known).map((i) => i.filename);
  assert.deepEqual(order, ['scan.TIF', 'IMG_0001.CR3', 'IMG_0001.JPG']);
  assert.equal(L.withKnown([], known).length, 3);
  assert.equal(L.knownKey(known[0]), `0:${known[0].path}`);
  // filtering and facets do not trip on the missing fields
  assert.equal(F.passes(known[0], F.NO_FILTER), true);
  assert.equal(F.passes(known[0], { ...F.NO_FILTER, keywords: ['a'] }), false);
  assert.equal(F.passes(known[0], { ...F.NO_FILTER, bodies: [''] }), true, 'no serial recorded');
  assert.equal(F.passes(known[2], { ...F.NO_FILTER, takenFrom: '2023-11-11', takenTo: '2023-11-11' }), true);
  assert.equal(F.passes(known[2], { ...F.NO_FILTER, rejected: 'only' }), true);
  const f = F.facets(known.map((i, n) => ({ ...i, imgid: n })));
  assert.deepEqual(f.kinds, [['RAW', 1], ['JPEG', 1], ['TIFF', 1]]);
  assert.deepEqual(f.months, [['2024-03', 2], ['2023-11', 1]]);
  assert.deepEqual(f.bodies, [['', 3]]);
  // RAW+JPEG pairing still stacks them
  const pairs = L.pairPartners(known.map((i, n) => ({ ...i, imgid: n + 1 })));
  assert.deepEqual([...pairs.keys()], [1]);
});
