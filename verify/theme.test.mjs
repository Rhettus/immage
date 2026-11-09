// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../app/package.json', import.meta.url));
const { transformSync } = await import(require.resolve('rolldown/experimental'));
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'react') return { url: 'data:text/javascript,export const useSyncExternalStore=()=>{}', shortCircuit: true };
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

const dispatched = [];
globalThis.window = { dispatchEvent: event => { dispatched.push(event.type); return true; } };
const values = new Map();
let failStorage = false;
globalThis.localStorage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => { if (failStorage) throw Error('storage unavailable'); values.set(key, String(value)); },
};
const { BUILTIN_THEMES, THEME_MAX_BYTES, THEME_TOKENS, parseTheme, validateTheme,
  loadThemes, themeEntries, selectedTheme, selectTheme, importTheme, removeTheme } = await import('../app/src/themes.ts');
const KEY = 'immage.themes.v1';
const valid = { ...BUILTIN_THEMES[0], id: undefined };
delete valid.id;
const json = value => JSON.stringify(value);

test('built-in themes and strict palette schema validate', () => {
  assert.deepEqual(BUILTIN_THEMES.map(t => t.id), ['dark', 'grey', 'light']);
  for (const { id, ...palette } of BUILTIN_THEMES) assert.deepEqual(validateTheme(palette), palette);
  assert.equal(THEME_TOKENS.length, 18);
  const normalized = parseTheme(json({ ...valid, name: '  Example  ', colors: { ...valid.colors, text: '#ABCDEF' } }));
  assert.equal(normalized.name, 'Example');
  assert.equal(normalized.colors.text, '#abcdef');
  for (const malformed of [null, [], { ...valid, version: 2 }, { ...valid, extra: true },
    { ...valid, name: '' }, { ...valid, name: 'x'.repeat(81) }, { ...valid, colorScheme: 'system' },
    { ...valid, colors: { ...valid.colors, missing: '#ffffff' } },
    { ...valid, colors: Object.fromEntries(THEME_TOKENS.slice(1).map(k => [k, valid.colors[k]])) },
    { ...valid, colors: { ...valid.colors, text: '#fff' } },
    { ...valid, colors: { ...valid.colors, text: 'red' } }]) {
    assert.throws(() => validateTheme(malformed));
  }
  assert.throws(() => parseTheme('{'), /Invalid JSON/);
  assert.throws(() => parseTheme(' '.repeat(THEME_MAX_BYTES + 1)), /64 KiB/);
  const exactLimit = json(valid) + ' '.repeat(THEME_MAX_BYTES - new TextEncoder().encode(json(valid)).length);
  assert.equal(new TextEncoder().encode(exactLimit).length, THEME_MAX_BYTES);
  assert.doesNotThrow(() => parseTheme(exactLimit));
});

test('documented example and JSON schema stay aligned with the importer', () => {
  const example = readFileSync(new URL('../app/docs/themes/example.json', import.meta.url), 'utf8');
  assert.doesNotThrow(() => parseTheme(example));
  const schema = JSON.parse(readFileSync(new URL('../app/docs/themes/schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(schema.required, ['version', 'name', 'colorScheme', 'colors']);
  assert.deepEqual(schema.properties.colors.required, THEME_TOKENS);
  assert.deepEqual(Object.keys(schema.properties.colors.properties).sort(), [...THEME_TOKENS].sort());
  assert.equal(schema.properties.version.const, 1);
  assert.deepEqual(schema.properties.colorScheme.enum, ['dark', 'light']);
});

test('imports persist, duplicate names remain valid, removal falls back and publishes changes', () => {
  values.delete(KEY);
  loadThemes();
  const beforeEvents = dispatched.length;
  try {
    const first = importTheme(json(valid));
    const second = importTheme(json(valid));
    assert.deepEqual(themeEntries().slice(-2).map(t => t.name), ['Dark (2)', 'Dark (3)']);
    assert.equal(selectedTheme().id, second);
    assert.equal(JSON.parse(values.get(KEY)).custom.length, 2);
    assert.equal(dispatched.length - beforeEvents, 2, 'each import publishes a change');
    removeTheme(second);
    assert.equal(selectedTheme().id, 'dark');
    assert.deepEqual(themeEntries().slice(-1).map(t => t.id), [first]);
    assert.equal(dispatched.length - beforeEvents, 3);
    assert.throws(() => removeTheme('light'), /Only imported/);
    assert.throws(() => selectTheme('missing'), /Unknown theme/);
  } finally {}
});

test('long duplicate names remain within schema and survive reload', () => {
  values.delete(KEY);
  loadThemes();
  const palette = { ...valid, name: 'n'.repeat(80) };
  importTheme(json(palette));
  importTheme(json(palette));
  const names = themeEntries().slice(-2).map(t => t.name);
  assert.equal(names[0].length, 80);
  assert.equal(names[1].length, 80);
  assert.notEqual(names[0], names[1]);
  loadThemes();
  assert.deepEqual(themeEntries().slice(-2).map(t => t.name), names);
});

test('failed persistence leaves selection and imported themes unchanged; corrupt saved data falls back', () => {
  values.delete(KEY);
  loadThemes();
  const original = themeEntries().map(t => t.id);
  failStorage = true;
  assert.throws(() => importTheme(json(valid)), /storage unavailable/);
  assert.throws(() => selectTheme('light'), /storage unavailable/);
  assert.throws(() => removeTheme('dark'), /Only imported/);
  assert.deepEqual(themeEntries().map(t => t.id), original);
  assert.equal(selectedTheme().id, 'dark');
  failStorage = false;
  values.set(KEY, JSON.stringify({ selected: 'custom-gone', custom: [
    { ...valid, id: 'custom-duplicate' }, { ...valid, id: 'custom-duplicate' },
    { ...valid, id: 'builtin-as-custom' }, { ...valid, id: 'custom-invalid', extra: true },
  ] }));
  loadThemes();
  assert.equal(selectedTheme().id, 'dark');
  assert.deepEqual(themeEntries().map(t => t.id), ['dark', 'grey', 'light', 'custom-duplicate']);
});
