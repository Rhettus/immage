// SPDX-License-Identifier: GPL-3.0-or-later
// Advanced mode's hidden modules (app/src/hiddenModules.ts): the stored list,
// filtering of search and Add module by it, and the Essentials set. Headless.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('./') && ctx.parentURL?.endsWith('.ts')) {
      const url = new URL(spec + '.ts', ctx.parentURL);
      if (existsSync(url)) return next(url.href, ctx);
    }
    return next(spec, ctx);
  },
});

const { hiddenKey, isHidden, visibleLayouts, essentialsHidden, ESSENTIAL_OPS, loadHiddenModules, storeHiddenModules } =
  await import('../app/src/hiddenModules.ts');
const { searchModules } = await import('../app/src/advancedSearch.ts');
const { LAYOUTS, groupLayouts } = await import('../app/src/advancedLayout.ts');

const groups = [{ id: 'detail', title: 'Detail' }, { id: 'basic', title: 'Basic' }];

test('a hidden module leaves the search, only in its own group', () => {
  assert.ok(searchModules(LAYOUTS, groups, 'lowpass').some((h) => h.op === 'lowpass'));
  const hidden = new Set([hiddenKey('detail', 'lowpass')]);
  assert.equal(searchModules(visibleLayouts(LAYOUTS, hidden), groups, 'lowpass').some((h) => h.op === 'lowpass'), false);
  // diffuse or sharpen is in Basic and Detail; hiding Detail's leaves Basic's
  const d = new Set([hiddenKey('detail', 'diffuse')]);
  const hits = searchModules(visibleLayouts(LAYOUTS, d), groups, 'diffuse or sharpen');
  assert.deepEqual(hits.map((h) => h.group), ['basic']);
});

test('a hidden module leaves its group\'s Add module choices', () => {
  const hidden = new Set([hiddenKey('detail', 'sharpen')]);
  const ops = visibleLayouts(groupLayouts('detail'), hidden).map((l) => l.op);
  assert.ok(!ops.includes('sharpen') && ops.includes('lowpass'));
  assert.equal(isHidden(hidden, 'detail', 'sharpen'), true);
  assert.equal(isHidden(hidden, 'basic', 'sharpen'), false);
});

test('Essentials resolves to real ops and keeps them in every group', () => {
  const all = new Set(LAYOUTS.map((l) => l.op));
  for (const op of ESSENTIAL_OPS) assert.ok(all.has(op), `${op} has no layout`);
  const hidden = new Set(essentialsHidden(LAYOUTS));
  for (const l of LAYOUTS) {
    const keep = ESSENTIAL_OPS.includes(l.op) || !!l.instance;
    assert.equal(hidden.has(hiddenKey(l.group, l.op)), !keep, `${l.group}:${l.op}`);
  }
  assert.ok(!hidden.has('basic:exposure') && hidden.has('detail:lowpass') && !hidden.has('bw:channelmixerrgb'));
});

test('the stored list round-trips and ignores junk', () => {
  storeHiddenModules(['b:x', 'a:y', 'a:y']);
  assert.deepEqual([...loadHiddenModules()].sort(), ['a:y', 'b:x']);
  storeHiddenModules([]);
  assert.equal(loadHiddenModules().size, 0);
});
