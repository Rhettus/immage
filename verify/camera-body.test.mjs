// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { startEngine, stopEngine, request, requestTagged } from './shim.mjs';
const require = createRequire(new URL('../app/package.json', import.meta.url));
const { rolldown } = await import(require.resolve('rolldown'));
// Bundle the actual filter and library code; stub only external app services.
const bundle = await rolldown({ input: fileURLToPath(new URL('../app/src/filter.ts', import.meta.url)),
  plugins: [{ name: 'services', resolveId(id) {
    if (id.startsWith('@tauri-apps/') || id === '@immporter/api') return '\0' + id;
  }, load(id) {
    if (id.startsWith('\0')) return 'export const api = {}; export async function invoke() {} export async function listen() {}';
  } }] });
const { output } = await bundle.generate({ format: 'esm' });
await bundle.close();
const { NO_FILTER, bodyOf, bodyLabel, passes, facetsWithin, popupCount, needsRead } =
  await import('data:text/javascript;base64,' + Buffer.from(output[0].code).toString('base64'));
const photo = (serial, lens = '35mm', maker = 'Canon') => ({ filename: 'photo.CR3', rating: 0,
  rejected: false, edited: false, labels: 0, keywords: [],
  exif: { maker, model: 'EOS R6', body_serial: serial, lens, datetime: '', iso: 100 } });

test('identical models stay distinct across lens swaps, unknowns and combined filters', () => {
  const a = photo('001234'), b = photo('009876'), swapped = photo('001234', '85mm');
  const unknown = photo(undefined), anotherMake = photo('001234', '35mm', 'Other');
  const images = [a, b, swapped, unknown, anotherMake];
  const filter = { ...NO_FILTER, bodies: [bodyOf(a)] };
  assert.deepEqual(images.filter(i => passes(i, filter)), [a, swapped]);
  assert.equal(bodyLabel(bodyOf(a)), 'Canon EOS R6 · Serial 001234');
  assert.equal(bodyLabel(bodyOf(unknown)), 'Serial not recorded');
  assert.equal(passes(unknown, { ...filter, bodies: [''] }), true);
  assert.equal(passes(a, { ...filter, bodies: [''] }), false);
  assert.equal(passes(b, { ...filter, bodies: [bodyOf(a), bodyOf(b)] }), true);
  assert.deepEqual(images.filter(i => passes(i, { ...filter, lenses: ['85mm'] })), [swapped]);
  assert.deepEqual(facetsWithin(images, filter, { lenses: [] }).lenses, [['35mm', 1], ['85mm', 1]]);
  const bodies = new Map(facetsWithin(images, { ...filter, lenses: ['35mm'] }, { bodies: [] }).bodies);
  assert.equal(bodies.get(bodyOf(a)), 1);
  assert.equal(bodies.get(bodyOf(b)), 1);
  assert.equal(bodies.get(''), 1);
  assert.equal(popupCount(filter), 1);
  assert.equal(needsRead(filter), true);
  assert.equal(popupCount(NO_FILTER), 0);
});

test('engine extracts complete body serials and ignores lens serials and placeholders', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'immage-body-'));
  const fixtures = [
    ['standard', ['set Exif.Photo.BodySerialNumber Ascii 001234567890'], '001234567890'],
    ['dng-tag', ['set Exif.Image.CameraSerialNumber Ascii 009876543210'], '009876543210'],
    ['lens-only', ['set Exif.Photo.LensSerialNumber Ascii 123456'], ''],
    ['zero', ['set Exif.Photo.BodySerialNumber Ascii 000000'], ''],
    ['unknown', ['set Exif.Photo.BodySerialNumber Ascii unknown'], ''],
    ['missing', [], ''],
  ];
  try {
    for (const [name, tags] of fixtures) {
      const path = join(dir, name + '.jpg');
      copyFileSync(join(root, 'app/sample/stairs-to-mountain.jpg'), path);
      if (tags.length) execFileSync('exiv2', tags.flatMap(t => ['-M', t]).concat(path));
    }
    startEngine(join(root, 'build/bin/darktable-engine'), join(dir, 'runtime'));
    const imported = await requestTagged({ cmd: 'import', files: fixtures.map(([name]) => join(dir, name + '.jpg')) });
    assert.deepEqual(imported.images.map(i => i.exif.body_serial), fixtures.map(([, , serial]) => serial));
    for (const [name, , expected] of fixtures) {
      const path = join(dir, name + '.jpg');
      const { imgid } = await request({ cmd: 'open', path });
      const image = (await request({ cmd: 'meta', imgid })).image;
      assert.equal(image.exif.body_serial, expected, name);
      assert.equal((await request({ cmd: 'meta', imgid })).image.exif.body_serial, expected, name + ' cached');
    }
  } finally { await stopEngine(); rmSync(dir, { recursive: true, force: true }); }
});
