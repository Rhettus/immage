// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../app/package.json', import.meta.url));
const reactPath = require.resolve('react');
const { transformSync } = await import(require.resolve('rolldown/experimental'));

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@tauri-apps/api/core') {
      return { url: 'data:text/javascript,export async function invoke(cmd, args){return {};}', shortCircuit: true };
    }
    if (spec === 'react') return next(reactPath, ctx);
    if (spec.startsWith('./') || spec.startsWith('../')) {
      for (const ext of ['.ts', '.tsx']) {
        const url = new URL(spec + ext, ctx.parentURL);
        if (existsSync(url)) return next(url.href, ctx);
      }
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (!url.startsWith('file:') || !/\.tsx?$/.test(url)) return next(url, ctx);
    const path = fileURLToPath(url);
    const out = transformSync(path, readFileSync(path, 'utf8'), { jsx: { runtime: 'automatic' } });
    if (out.errors?.length) throw Error(JSON.stringify(out.errors));
    return { format: 'module', source: out.code, shortCircuit: true };
  },
});

const stacking = await import('../app/src/stacking.ts');
const { buildStackView, toggleStackKey, selectionAfterCollapse, stackKey } = stacking;

test('collapsed stacks hide companions, populate collapsedPartners, emit ORF+JPG badge', () => {
  const passing = [
    { imgid: 1, path: '/photos/img1.ORF', filename: 'img1.ORF' },
    { imgid: 2, path: '/photos/img1.JPG', filename: 'img1.JPG' },
    { imgid: 3, path: '/photos/img2.ORF', filename: 'img2.ORF' },
  ];
  const allPartners = new Map([
    [1, [{ imgid: 2, path: '/photos/img1.JPG', filename: 'img1.JPG' }]],
  ]);
  const expandedStacks = new Set();

  const { shown, collapsedPartners, badges } = buildStackView(passing, allPartners, expandedStacks);

  assert.deepEqual(shown.map(s => s.imgid), [1, 3]);
  assert.equal(collapsedPartners.get(1)?.length, 1);
  assert.equal(collapsedPartners.get(1)?.[0].imgid, 2);

  const badge = badges.get(1);
  assert.deepEqual(badge, {
    key: stackKey('/photos/img1.ORF'),
    expanded: false,
    count: 2,
    position: 'collapsed',
    headId: 1,
    memberIds: [1, 2],
    types: 'ORF+JPG',
  });
});

test('3-file stacks emit count: 3, ORF+JPG+HEIF when collapsed, and head/member/tail positions when expanded', () => {
  const passing = [
    { imgid: 10, path: '/photos/shot.ORF', filename: 'shot.ORF' },
    { imgid: 11, path: '/photos/shot.JPG', filename: 'shot.JPG' },
    { imgid: 12, path: '/photos/shot.HEIF', filename: 'shot.HEIF' },
  ];
  const allPartners = new Map([
    [10, [
      { imgid: 11, path: '/photos/shot.JPG', filename: 'shot.JPG' },
      { imgid: 12, path: '/photos/shot.HEIF', filename: 'shot.HEIF' },
    ]],
  ]);

  // Collapsed
  const resColl = buildStackView(passing, allPartners, new Set());
  assert.deepEqual(resColl.shown.map(s => s.imgid), [10]);
  assert.equal(resColl.badges.get(10)?.types, 'ORF+JPG+HEIF');
  assert.equal(resColl.badges.get(10)?.count, 3);
  assert.equal(resColl.badges.get(10)?.position, 'collapsed');

  // Expanded
  const key = stackKey('/photos/shot.ORF');
  const resExp = buildStackView(passing, allPartners, new Set([key]));
  assert.deepEqual(resExp.shown.map(s => s.imgid), [10, 11, 12]);
  assert.equal(resExp.badges.get(10)?.position, 'head');
  assert.equal(resExp.badges.get(11)?.position, 'member');
  assert.equal(resExp.badges.get(12)?.position, 'tail');
});

test('expanding a stack places companions immediately after primary RAW even if companion appeared elsewhere in passing', () => {
  const passing = [
    { imgid: 1, path: '/photos/img1.ORF', filename: 'img1.ORF' },
    { imgid: 2, path: '/photos/img2.ORF', filename: 'img2.ORF' },
    { imgid: 199, path: '/photos/img1.JPG', filename: 'img1.JPG' }, // companion appears later in passing
  ];
  const allPartners = new Map([
    [1, [{ imgid: 199, path: '/photos/img1.JPG', filename: 'img1.JPG' }]],
  ]);
  const key = stackKey('/photos/img1.ORF');
  const { shown } = buildStackView(passing, allPartners, new Set([key]));

  assert.deepEqual(shown.map(s => s.imgid), [1, 199, 2]);
});

test('unpaired photos and standalone JPEGs remain visible with no badge', () => {
  const passing = [
    { imgid: 1, path: '/photos/unpaired.JPG', filename: 'unpaired.JPG' },
  ];
  const { shown, badges } = buildStackView(passing, new Map(), new Set());
  assert.deepEqual(shown.map(s => s.imgid), [1]);
  assert.equal(badges.size, 0);
});

test('isStackedUnread hides unread-paired companions', () => {
  const passing = [
    { imgid: 1, path: '/photos/img1.ORF', filename: 'img1.ORF' },
    { imgid: 2, path: '/photos/img1.JPG', filename: 'img1.JPG' },
  ];
  const allPartners = new Map([
    [1, [{ imgid: 2, path: '/photos/img1.JPG', filename: 'img1.JPG' }]],
  ]);
  const { shown } = buildStackView(passing, allPartners, new Set(), (item) => item.imgid === 2);
  assert.deepEqual(shown.map(s => s.imgid), [1]);
});

test('toggleStackKey adds and removes without mutating input', () => {
  const set1 = new Set(['abc']);
  const set2 = toggleStackKey(set1, 'abc');
  assert.equal(set1.has('abc'), true);
  assert.equal(set2.has('abc'), false);

  const set3 = toggleStackKey(set2, 'abc');
  assert.equal(set3.has('abc'), true);
});

test('selectionAfterCollapse retargets selection and anchor from companion to headId', () => {
  const memberIds = [1, 2, 3];
  const headId = 1;

  // Companion selected
  const res1 = selectionAfterCollapse(new Set([2, 5]), 2, memberIds, headId);
  assert.deepEqual([...res1.selection], [5, 1]);
  assert.equal(res1.anchor, 1);

  // No companion selected
  const res2 = selectionAfterCollapse(new Set([5, 6]), 5, memberIds, headId);
  assert.deepEqual([...res2.selection], [5, 6]);
  assert.equal(res2.anchor, 5);
});

test('movedCompanions finds a collapsed raw\'s partners and follows the file-type filter', () => {
  const raw = { imgid: 1, path: '/p/a.ORF', filename: 'a.ORF' };
  const jpg = { imgid: 2, path: '/p/a.JPG', filename: 'a.JPG' };
  const lone = { imgid: 3, path: '/p/b.JPG', filename: 'b.JPG' };
  const partners = new Map([[1, [jpg]]]);
  const { movedCompanions } = stacking;
  const all = [raw, jpg, lone];
  const unfiltered = movedCompanions(all, partners, () => true);
  assert.deepEqual(unfiltered.companions.map((c) => c.imgid), [2]);
  assert.equal(unfiltered.include, true);
  const rawsOnly = movedCompanions(all, partners, (i) => /\.ORF$/.test(i.filename));
  assert.deepEqual(rawsOnly.companions.map((c) => c.imgid), [2]);
  assert.equal(rawsOnly.include, false);
  // an expanded stack has no collapsed partners: each file is the user's pick
  assert.deepEqual(movedCompanions(all, new Map(), () => false).companions, []);
});
