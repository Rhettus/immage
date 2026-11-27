// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
// Run: node --test verify/preset-film.test.mjs
//
// a develop preset holding a film simulation: the modules applying it
// moves the film's tools to (Presets.tsx, filmChoices, which presetValues
// in PanelView.tsx adds), and its film controls kept through a shared
// preset file. needs no engine
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withNodeLocales } from './vite-locales.mjs';
const require = createRequire(new URL('../app/package.json', import.meta.url));
const { transformSync } = await import(require.resolve('rolldown/experimental'));
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@tauri-apps/api/core') return { url: 'data:text/javascript,export const invoke=async()=>null;', shortCircuit: true };
    if (spec.startsWith('@tauri-apps/')) return { url: 'data:text/javascript,export const listen=async()=>()=>{};export const getCurrentWindow=()=>({});', shortCircuit: true };
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
    const source = withNodeLocales(url, readFileSync(path, 'utf8'));
    return { format: 'module', source: transformSync(path, source, { jsx: { runtime: 'automatic' } }).code, shortCircuit: true };
  },
});
const P = await import('../app/src/Presets.tsx');
const M = await import('../app/src/manifest.ts');
const S = await import('../app/src/spektrafilm.ts');

const portra = S.stockHash('kodak_portra_400');
const film = { sf_on: 1, sf_film_hash: portra, sf_exposure_ev: 0.5, sf_grain_amount: 1.3, contrast: 10 };

test('a preset that turns film simulation on moves its tools to the modules the film keeps', () => {
  assert.ok(Object.keys(M.SF_CHOICES).length);
  assert.deepEqual(P.filmChoices(film), M.SF_CHOICES);
  for (const id of Object.keys(M.SF_CHOICES)) assert.ok(M.isModuleSetting(id), id);
});

test('a preset without film simulation, or with it off, chooses no modules', () => {
  assert.deepEqual(P.filmChoices({ contrast: 10 }), {});
  assert.deepEqual(P.filmChoices({ sf_on: 0, contrast: 10 }), {});
});

test('film simulation controls are preset controls, and survive a shared preset file', () => {
  for (const id of ['sf_on', ...S.SF_FIELDS.map((x) => S.sfId(x.field))]) assert.ok(M.controlById.has(id), id);
  const file = JSON.parse(JSON.stringify(P.sharedPresets([{ id: 'a', name: 'Portra', group: 'Film', values: film }])));
  const [got] = P.readSharedPresets(file, []);
  assert.deepEqual(got.values, film);
});
