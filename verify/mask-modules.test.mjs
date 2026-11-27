// SPDX-License-Identifier: GPL-3.0-or-later
// The allowlist must only contain modules with a card and safe mask scope.
import test from 'node:test';
import assert from 'node:assert/strict';
import './load-app-ts.mjs';

const {
  LOCAL_CONTROLS,
  MASK_MODULES,
  TM_AGX,
  TM_NONE,
  TM_SIGMOID,
  moduleName,
  moduleOpFor,
} = await import('../app/src/manifest.ts');
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

test('moduleOpFor resolves every mask adjustment slider and module choice', () => {
  for (const control of LOCAL_CONTROLS) {
    const op = moduleOpFor(control.id, {}, 'masks');
    assert.ok(op, `mask control ${control.id} resolves to a darktable op`);
    assert.ok(moduleName(op).length > 0, `mask control ${control.id} op ${op} has a module name`);
  }

  const expectedStatic = {
    l_temp: 'channelmixerrgb',
    l_tint: 'channelmixerrgb',
    l_exposure: 'exposure',
    l_blacks: 'exposure',
    l_contrast: 'colorbalancergb',
    l_whites: 'colorbalancergb',
    l_hue: 'colorbalancergb',
    l_saturation: 'colorbalancergb',
    l_fulcrum: 'colorbalancergb',
    l_cg_shadows_hue: 'colorbalancergb',
    l_cg_midtones_sat: 'colorbalancergb',
    l_cg_highlights_lum: 'colorbalancergb',
    l_cg_global_hue: 'colorbalancergb',
    l_texture: 'diffuse',
    l_detail_texture_gain_medium: 'contrastntexture#texture',
    l_detail_texture_detail_level: 'contrastntexture#texture',
    l_clarity: 'bilat',
    l_detail_clarity_gain_medium: 'contrastntexture',
    l_detail_clarity_detail_level: 'contrastntexture',
    l_dehaze: 'hazeremoval',
    l_hsl_hue_red: 'colorequal',
    l_hsl_sat_green: 'colorequal',
    l_hsl_lum_blue: 'colorequal',
    l_noise: 'denoiseprofile',
    l_defringe: 'cacorrectrgb',
  };
  for (const [id, expectedOp] of Object.entries(expectedStatic)) {
    assert.equal(moduleOpFor(id, {}, 'masks'), expectedOp, `${id} resolves to ${expectedOp}`);
  }

  for (const id of ['l_highlights', 'l_shadows']) {
    assert.equal(moduleOpFor(id, {}, 'masks'), 'toneequal', `${id} defaults to toneequal`);
    assert.equal(moduleOpFor(id, { mod_tone: 0 }, 'masks'), 'toneequal', `${id} uses toneequal when mod_tone=0`);
    assert.equal(moduleOpFor(id, { mod_tone: 1 }, 'masks'), 'shadhi', `${id} uses shadhi when mod_tone=1`);
  }

  const sharpnessOp = moduleOpFor('l_sharpness', {}, 'masks');
  assert.equal(sharpnessOp, 'diffuse#sharpen');
  assert.equal(moduleName(sharpnessOp), 'diffuse or sharpen');
  assert.equal(moduleOpFor('l_usm', {}, 'masks'), 'sharpen');
  assert.equal(moduleName('sharpen'), 'sharpen');
});

test('moduleOpFor resolves global sliders across module choices and tone mappers', () => {
  for (const id of ['highlights', 'shadows']) {
    assert.equal(moduleOpFor(id, {}, 'global'), 'toneequal');
    assert.equal(moduleOpFor(id, { mod_tone: 0 }), 'toneequal');
    assert.equal(moduleOpFor(id, { mod_tone: 1 }), 'shadhi');
  }

  assert.equal(moduleOpFor('contrast', { mod_contrast: 0, tm_mode: TM_AGX }), 'agx');
  assert.equal(moduleOpFor('contrast', { mod_contrast: 0, tm_mode: TM_SIGMOID }), 'sigmoid');
  assert.equal(moduleOpFor('contrast', { mod_contrast: 1, tm_mode: TM_NONE }), 'colorbalancergb');
  assert.equal(moduleOpFor('contrast', { mod_contrast: 1, tm_mode: TM_AGX }), 'colorbalancergb');

  assert.equal(moduleOpFor('blacks', { mod_blacks: 0, tm_mode: TM_AGX }), 'agx');
  assert.equal(moduleOpFor('blacks', { mod_blacks: 0, tm_mode: TM_SIGMOID }), 'sigmoid');
  assert.equal(moduleOpFor('blacks', { mod_blacks: 1, tm_mode: TM_NONE }), 'exposure');

  assert.equal(moduleOpFor('saturation', { mod_saturation: 0, tm_mode: TM_AGX }), 'agx');
  assert.equal(moduleOpFor('saturation', { mod_saturation: 0, tm_mode: TM_SIGMOID }), 'colorbalancergb');
  assert.equal(moduleOpFor('saturation', { mod_saturation: 1, tm_mode: TM_NONE }), 'colorbalancergb');
});
