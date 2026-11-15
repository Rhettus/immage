// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCases } from './gui/suites.mjs';

test('startup restore and DNG thumbnail keep their standalone initial-state launches', () => {
  assert.deepEqual(resolveCases('startup-restore'), ['startup-restore']);
  assert.deepEqual(resolveCases('dng-thumbnail,'), ['dng-thumbnail']);
  assert.throws(() => resolveCases('startup,dng-thumbnail'), /must run alone/);
  assert.throws(() => resolveCases('startup-restore,photo-filter'), /must run alone/);
});

test('the all selection excludes standalone initial-state cases', () => {
  const all = resolveCases('all');
  assert.equal(all[0], 'startup');
  assert.ok(!all.includes('startup-restore'));
  assert.ok(!all.includes('dng-thumbnail'));
});

test('ordinary cases keep one startup prerequisite and comma lists de-duplicate it', () => {
  assert.deepEqual(resolveCases('photo-filter'), ['startup', 'photo-filter']);
  assert.deepEqual(resolveCases('startup,photo-filter'), ['startup', 'photo-filter']);
});
