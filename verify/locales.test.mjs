// SPDX-License-Identifier: GPL-3.0-or-later
// Locale files: every key a translation has exists in en.json with the same
// {placeholders}; every t("key") in the sources is in en.json. Missing keys in
// a translation are allowed (they show English). Engine-free.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('../app/src/locales/', import.meta.url);
const load = (f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
const en = load('en.json');
const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
const others = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'en.json');

for (const f of others) {
  test(`${f} matches en.json`, () => {
    for (const [k, v] of Object.entries(load(f))) {
      const base = k.replace(/_(zero|one|two|few|many|other)$/, '');
      assert.ok(k in en || base in en, `${f}: unknown key ${k}`);
      if (k in en) assert.equal(vars(v), vars(en[k]), `${f}: placeholders differ for ${k}`);
    }
  });
}

test('every t("key") in the sources is in en.json', () => {
  const src = new URL('../app/src/', import.meta.url);
  for (const f of readdirSync(src).filter((n) => /\.tsx?$/.test(n) && n !== 'i18n.ts')) {
    for (const m of readFileSync(new URL(f, src), 'utf8').matchAll(/\bt\("([\w.-]+)"/g)) {
      const k = m[1];
      assert.ok(k in en || `${k}_other` in en, `${f}: ${k} missing from en.json`);
    }
  }
});
