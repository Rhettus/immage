// SPDX-License-Identifier: GPL-3.0-or-later
// Test built-in display translation independently of engine and browser startup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../app/package.json', import.meta.url));
const { transformSync } = await import(require.resolve('rolldown/experimental'));
const dataURL = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const coreFile = new URL('../app/src/i18nCore.ts', import.meta.url);
const coreURL = dataURL(transformSync(coreFile.pathname, readFileSync(coreFile, 'utf8')).code);
const catalog = code => new URL(`../app/src/locales/${code}.json`, import.meta.url).href;
async function display(code) {
  const runtime = dataURL(`import {createTranslator} from ${JSON.stringify(coreURL)};
    import en from ${JSON.stringify(catalog('en'))} with {type:'json'};
    import fr from ${JSON.stringify(catalog('fr'))} with {type:'json'};
    export const language=${JSON.stringify(code)};
    export const t=createTranslator(language,{en,fr});`);
  const path = new URL('../app/src/fieldText.ts', import.meta.url);
  const source = readFileSync(path, 'utf8')
    .replace('"./locales/en.json"', JSON.stringify(catalog('en')))
    .replace('"./i18n"', JSON.stringify(runtime));
  return (await import(dataURL(transformSync(path.pathname, source).code))).fieldText;
}

test('built-in fields use pinned French terminology at presentation', async () => {
  const text = await display('fr');
  assert.equal(text('Exposure'), 'Exposition');
  assert.equal(text('Radius'), 'Rayon');
  assert.equal(text('color calibration'), 'Calibration de couleur');
  assert.equal(text('Exposure: Radius'), 'Exposition : Rayon');
});

test('English names and unknown user text retain their identities', async () => {
  const english = await display('en');
  const french = await display('fr');
  assert.equal(english('Exposure'), 'Exposure');
  assert.equal(english('Exposure: Radius'), 'Exposure: Radius');
  assert.equal(french('My custom instance 37'), 'My custom instance 37');
  assert.equal(french(''), '');
});
