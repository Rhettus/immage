// SPDX-License-Identifier: GPL-3.0-or-later
// Engine-free catalog validation and multilingual runtime regressions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../app/package.json', import.meta.url));
const { transformSync } = await import(require.resolve('rolldown/experimental'));
const corePath = new URL('../app/src/i18nCore.ts', import.meta.url);
const code = transformSync(corePath.pathname, readFileSync(corePath, 'utf8')).code;
const { canonicalLocale, resolveLanguage, createTranslator, textDirection } =
  await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const dir = new URL('../app/src/locales/', import.meta.url);
const load = (f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
const en = load('en.json');
const own = (obj, k) => Object.hasOwn(obj, k);
const plural = /_(zero|one|two|few|many|other)$/;
// A translation may repeat or reorder a variable, but must preserve its names.
const vars = (s) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]))].sort();

function validate(dict, reference) {
  assert.ok(dict && typeof dict === 'object' && !Array.isArray(dict), 'catalog must be an object');
  for (const [key, value] of Object.entries(dict)) {
    assert.equal(typeof value, 'string', `${key}: expected text`);
    assert.ok(value.trim(), `${key}: empty translation`);
    const base = key.replace(plural, '');
    const referenceKey = own(reference, key) ? key
      : plural.test(key) && own(reference, `${base}_other`) ? `${base}_other`
      : plural.test(key) && own(reference, base) ? base : undefined;
    assert.ok(referenceKey !== undefined, `unknown key ${key}`);
    assert.deepEqual(vars(value), vars(reference[referenceKey]), `${key}: placeholders differ`);
  }
}
for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
  test(`${f} is a valid catalog`, () => {
    const code = f.slice(0, -5);
    assert.equal(canonicalLocale(code), code, 'filename must be a canonical BCP 47 tag');
    validate(load(f), en);
  });
}

test('validator accepts extra plural categories and checks their placeholders', () => {
  const reference = { photos_one: '{n} photo', photos_other: '{n} photos' };
  validate({ photos_few: '{n} photos', photos_many: '{n} photos' }, reference);
  assert.throws(() => validate({ photos_few: '{count} photos' }, reference), /placeholders differ/);
  assert.throws(() => validate({ unknown_few: '{n} photos' }, reference), /unknown key/);
  assert.throws(() => validate({ photos_other: 3 }, reference), /expected text/);
});

test('every literal t(key) in all source directories is in en.json', () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(new URL(`${e.name}/`, dir))
      : /\.tsx?$/.test(e.name) && e.name !== 'i18n.ts' ? [new URL(e.name, dir)] : []);
  for (const file of walk(new URL('../app/src/', import.meta.url))) {
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(/\bt\(\s*["']([\w.-]+)["']/g)) {
      assert.ok(own(en, m[1]) || own(en, `${m[1]}_other`), `${file.pathname}: ${m[1]} missing from en.json`);
    }
  }
});

test('system language preferences, explicit choices, regional and script variants', () => {
  const catalogs = { en: {}, fr: {}, 'pt-BR': {}, 'zh-Hant': {}, sr: {}, 'sr-Latn': {} };
  assert.equal(resolveLanguage('system', ['de-DE', 'fr-CA', 'en'], catalogs), 'fr');
  assert.equal(resolveLanguage('en', ['fr'], catalogs), 'en');
  assert.equal(resolveLanguage('system', ['pt-BR'], catalogs), 'pt-BR');
  assert.equal(resolveLanguage('system', ['zh-TW'], catalogs), 'zh-Hant');
  assert.equal(resolveLanguage('system', ['sr-Latn-RS'], catalogs), 'sr-Latn');
  assert.equal(resolveLanguage('system', ['ja'], catalogs), 'en');
  assert.equal(resolveLanguage('system', ['invalid_tag', 'fr'], catalogs), 'fr');
  assert.equal(resolveLanguage('toString', ['fr'], catalogs), 'fr');
  assert.equal(resolveLanguage('system', [], catalogs), 'en');
});

test('English fallback uses English plural rules, including French zero and Russian few', () => {
  const catalogs = { en: { photos_one: '{n} photo', photos_other: '{n} photos' }, fr: {}, ru: {} };
  assert.equal(createTranslator('fr', catalogs)('photos', { n: 0 }), '0 photos');
  assert.equal(createTranslator('ru', catalogs)('photos', { n: 2 }), '2 photos');
  assert.equal(createTranslator('ru', catalogs)('photos', { n: 1 }), '1 photo');
});

test('Arabic six-way plurals and language-specific categories are usable', () => {
  const categories = ['zero', 'one', 'two', 'few', 'many', 'other'];
  const ar = Object.fromEntries(categories.map(c => [`photos_${c}`, c]));
  const t = createTranslator('ar', { en: { photos_other: 'English' }, ar });
  assert.deepEqual([0, 1, 2, 3, 11, 100].map(n => t('photos', { n })), categories);
});

test('partial regional catalogs fall back through parent locale before English', () => {
  const t = createTranslator('fr-CA', { en: { hello: 'Hello', done: 'Done' }, fr: { hello: 'Bonjour' }, 'fr-CA': { own: 'Québec' } });
  assert.equal(t('own'), 'Québec');
  assert.equal(t('hello'), 'Bonjour');
  assert.equal(t('done'), 'Done');
  assert.equal(t('missing'), 'missing');
});

test('interpolation preserves missing variables and literal values', () => {
  const t = createTranslator('en', { en: { hello: '{name} {name} {missing}', inherited: '{toString}' } });
  assert.equal(t('hello', { name: '$& <hello>' }), '$& <hello> $& <hello> {missing}');
  assert.equal(t('inherited', {}), '{toString}');
  assert.equal(t('toString'), 'toString');
});

test('text direction follows the language script', () => {
  for (const code of ['ar', 'he', 'fa', 'ur', 'az-Arab']) assert.equal(textDirection(code), 'rtl', code);
  for (const code of ['en', 'fr', 'ja', 'az-Latn']) assert.equal(textDirection(code), 'ltr', code);
});
