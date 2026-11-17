// SPDX-License-Identifier: GPL-3.0-or-later
// The allowlist must only contain modules with a card and safe mask scope.
import test from 'node:test';
import assert from 'node:assert/strict';
import './load-app-ts.mjs';

const { MASK_MODULES } = await import('../app/src/manifest.ts');
const { LAYOUTS } = await import('../app/src/advancedLayout.ts');

const FORBIDDEN = {
  raw: new Set(['colorreconstruction', 'demosaic', 'demosaicscale', 'hotpixels', 'rawdenoise', 'rawoverexposed', 'rawprepare']),
  profiles: new Set(['colorin', 'colorout', 'profile_gamma', 'profilegamma']),
  toneMappers: new Set(['agx', 'basecurve', 'filmicrgb', 'sigmoid', 'tonemap']),
  geometry: new Set(['ashift', 'clipping', 'crop', 'flip', 'lens', 'liquify', 'perspective', 'rotatepixels', 'scalepixels']),
  immageTools: new Set(['ashift', 'crop', 'liquify', 'retouch']),
};

test('mask module allowlist is unique, card-backed and excludes unsafe categories', () => {
  const ops = MASK_MODULES.map(({ op }) => op);
  assert.ok(ops.length, 'mask allowlist is not empty');
  assert.equal(new Set(ops).size, ops.length, 'each op appears only once');
  const layoutOps = new Set(LAYOUTS.map(({ op }) => op));
  const expectedEarly = ['cacorrectrgb', 'denoiseprofile', 'hazeremoval', 'sharpen'];
  for (const op of expectedEarly) {
    const entry = MASK_MODULES.find((m) => m.op === op);
    assert.ok(entry, `${op} remains allowlisted`);
    assert.equal(entry.anchor, false, `${op} stays at its native early pipe position`);
  }
  for (const { op, anchor } of MASK_MODULES) {
    assert.ok(layoutOps.has(op), `${op} has an Advanced card layout`);
    for (const [category, set] of Object.entries(FORBIDDEN))
      assert.ok(!set.has(op), `${op} is not a ${category} module`);
    if (['atrous', 'bilateral', 'cacorrectrgb', 'denoiseprofile', 'hazeremoval', 'hotpixels', 'nlmeans', 'sharpen'].includes(op))
      assert.equal(anchor, false, `${op} is anchored at its native early pipe position`);
  }
});
