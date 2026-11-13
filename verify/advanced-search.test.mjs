// SPDX-License-Identifier: GPL-3.0-or-later
// Advanced mode's module search (app/src/advancedSearch.ts): matching by
// module title and setting label, ranking and limits. Headless, no engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';

// the app's own imports leave out the .ts the bundler adds
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('./') && ctx.parentURL?.endsWith('.ts')) {
      const url = new URL(spec + '.ts', ctx.parentURL);
      if (existsSync(url)) return next(url.href, ctx);
    }
    return next(spec, ctx);
  },
});

const { searchModules } = await import('../app/src/advancedSearch.ts');
const { LAYOUTS } = await import('../app/src/advancedLayout.ts');

const L = (op, group, title, labels = []) => ({ op, group, title, fields: labels.map((label) => ({ path: label, label })) });
const groups = [{ id: 'a', title: 'Alpha' }, { id: 'b', title: 'Beta' }];
const layouts = [
  L('one', 'b', 'Blur', ['Radius']),
  L('two', 'a', 'Lowpass', ['Radius', 'Softness']),
  L('three', 'a', 'Soften', ['Strength']),
  L('four', 'b', 'Radial', ['Amount']),
  L('five', 'zzz', 'Radius ghost'),
];

test('fewer than two characters finds nothing', () => {
  assert.deepEqual(searchModules(layouts, groups, ''), []);
  assert.deepEqual(searchModules(layouts, groups, ' r '), []);
});

test('case-insensitive substring of the title', () => {
  const hits = searchModules(layouts, groups, 'LOW');
  assert.deepEqual(hits.map((h) => [h.op, h.groupTitle, h.setting]), [['two', 'Alpha', undefined]]);
});

test('title matches rank before setting matches, then group and card order', () => {
  const hits = searchModules(layouts, groups, 'radi');
  // Radial matches by title; Lowpass (group a) then Blur (group b) by setting
  assert.deepEqual(hits.map((h) => [h.op, h.setting]), [['four', undefined], ['two', 'Radius'], ['one', 'Radius']]);
});

test('one hit per module, with its first matching setting', () => {
  const hits = searchModules([L('x', 'a', 'X', ['Soft edge', 'Soft light'])], groups, 'soft');
  assert.deepEqual(hits.map((h) => h.setting), ['Soft edge']);
});

test('modules in a group the panel does not list are left out; the list is limited', () => {
  assert.ok(!searchModules(layouts, groups, 'ghost').length);
  const many = Array.from({ length: 30 }, (_, i) => L(`m${i}`, 'a', `Module ${i}`));
  assert.equal(searchModules(many, groups, 'module').length, 12);
  assert.equal(searchModules(many, groups, 'module', 5).length, 5);
});

test('the real layout table: lowpass is found in Detail', () => {
  const hits = searchModules(LAYOUTS, [{ id: 'detail', title: 'Detail' }], 'lowpass');
  assert.ok(hits.length && hits[0].op === 'lowpass' && hits[0].groupTitle === 'Detail', JSON.stringify(hits));
});
