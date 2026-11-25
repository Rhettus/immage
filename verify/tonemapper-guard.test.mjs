// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../app/package.json', import.meta.url));
const reactPath = require.resolve('react');
const { transformSync } = await import(require.resolve('rolldown/experimental'));

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@tauri-apps/api/core') {
      return { url: 'data:text/javascript,export async function invoke(cmd, args){return globalThis.tmInvoke ? globalThis.tmInvoke(cmd, args) : {};}', shortCircuit: true };
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

globalThis.window = globalThis;
globalThis.addEventListener = () => {};
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};

const M = await import('../app/src/manifest.ts');
const { filterValuesForPhoto, newPhotoPresetValues, preparePastePhoto } = await import('../app/src/pasteDefaults.ts');
const { Session } = await import('../app/src/session.ts');
const { perf } = await import('../app/src/perf.ts');

test('TM_NONE never enables or activates agx or sigmoid maps', () => {
  assert.equal(M.controlById.get('tm_mode')?.neutral, M.TM_NONE);
  assert.equal(M.agxRuns({ tm_mode: M.TM_NONE }), false);
  const values = {
    tm_mode: M.TM_NONE,
    whites: 50,
    whites_brilliance: 100,
    contrast: 40,
    blacks: -30,
    saturation: 25,
    profile: 12,
    mod_contrast: 0,
    mod_blacks: 0,
    mod_saturation: 0,
  };
  for (const m of M.modules.filter((x) => x.op === 'agx' || x.op === 'sigmoid')) {
    assert.equal(m.enabled?.(values), false, `${m.op} (${m.controls.join(',')}) must be disabled on TM_NONE`);
    if (m.active) assert.equal(m.active(values), false, `${m.op} must be inactive on TM_NONE`);
  }
});

test('Whites on TM_NONE maps to colorbalancergb brilliance_highlights at mask scale (0.004)', () => {
  const whitesMap = M.modules.find((m) => m.op === 'colorbalancergb' && m.controls.includes('whites'));
  assert.ok(whitesMap);
  const values = { tm_mode: M.TM_NONE, whites: 50, whites_brilliance: 100 };
  assert.equal(M.choiceOn(whitesMap, values), true);
  assert.equal(whitesMap.enabled?.(values), true);
  assert.equal(whitesMap.enabled?.({ ...values, whites: 0 }), false);
  const written = whitesMap.write(values, {}, { sensorWidth: 100, sensorHeight: 100, orientation: 0, camera: 0 });
  assert.ok(Math.abs(written.brilliance_highlights - 0.2) < 1e-9);
  const read = whitesMap.read(written, { brilliance_highlights: 0 }, { sensorWidth: 100, sensorHeight: 100, orientation: 0, camera: 0 }, { tm_mode: M.TM_NONE });
  assert.ok(Math.abs(read.whites - 50) < 1e-9);
});

test('nonTmModuleChoice matches masks: strips AgX from Contrast, Blacks and Saturation', () => {
  const byId = (id) => M.nonTmModuleChoice(M.MODULE_CHOICES.find((c) => c.id === id));
  assert.deepEqual(byId('contrast').options.map((o) => [o.op, o.preferred]), [
    ['colorbalancergb', true],
    ['atrous', false],
  ]);
  assert.deepEqual(byId('blacks').options.map((o) => [o.op, o.preferred]), [
    ['exposure', true],
  ]);
  assert.deepEqual(byId('saturation').options.map((o) => [o.op, o.preferred]), [
    ['colorbalancergb', true],
    ['satcurvergb', false],
  ]);
});

test('filterValuesForPhoto, newPhotoPresetValues and profileSelection never enable AgX on LDR', () => {
  assert.deepEqual(M.profileSelection(12, false), { profile: 0 });
  assert.deepEqual(M.profileSelection(100, false), { profile: 0 });
  assert.deepEqual(M.profileSelection(2, false), { profile: 2 });
  assert.deepEqual(M.profileLabel(0, false), 'None');
  assert.deepEqual(M.profileLabel(1, false), 'Standard');

  const mixed = {
    tm_mode: M.TM_AGX,
    profile: 12,
    agx_black: -9,
    agx_white: 5,
    whites_brilliance: 140,
    contrast: 20,
    whites: 15,
    blacks: -10,
    saturation: 8,
  };
  assert.deepEqual(filterValuesForPhoto(mixed, false), {
    contrast: 20,
    whites: 15,
    blacks: -10,
    saturation: 8,
  });
  assert.deepEqual(filterValuesForPhoto({ ...mixed, profile: 3 }, false), {
    profile: 3,
    contrast: 20,
    whites: 15,
    blacks: -10,
    saturation: 8,
  });
  assert.deepEqual(newPhotoPresetValues({ ...mixed, lens_profile: 1, capture: 1 }, false, true, false), {
    contrast: 20,
    whites: 15,
    blacks: -10,
    saturation: 8,
  });
});

function makeEmptyModules() {
  const out = {};
  for (const m of M.modules) {
    const existing = out[m.op] ?? { enabled: false, default_enabled: false, params: {}, defaults: {} };
    for (const f of m.fields) {
      const def = f === 'curve_shoulder_power' ? 3.3
        : f === 'curve_contrast_around_pivot' ? 3
        : f === 'look_saturation' ? 1
        : f === 'display_white_target' ? 100
        : f === 'middle_grey_contrast' ? 1.5
        : f === 'display_black_target' ? 0.0152
        : f === 'range_black_relative_ev' ? -10
        : f === 'range_white_relative_ev' ? 6.5
        : f === 'curve_pivot_x' ? 0.5
        : 0;
      existing.params[f] = def;
      existing.defaults[f] = def;
    }
    out[m.op] = existing;
  }
  return out;
}

test('Session on LDR remaps Simple controls, blocks tm_mode, and preserves legacy AgX XMP untouched', async () => {
  storage.clear();
  const state = makeEmptyModules();
  // Simulate a legacy <= 0.47.1 JPEG sidecar that already had AgX enabled.
  state.agx.enabled = true;
  let openReply = { imgid: 1, sensor_width: 128, sensor_height: 96, orientation: 0, raw: false, ldr: true, fresh: false, edited: true, look: null, look_amount: 100, sensor: null };
  let historyItems = [{ op: 'agx', name: 'AgX', label: null, enabled: true, priority: 0, default_enabled: false, fixed: false, masked: false }];
  const sentParams = [];
  const origMasks = Session.prototype.loadMasks;
  const origRender = Session.prototype.requestRender;
  const origPump = Session.prototype.pump;
  globalThis.tmInvoke = async (cmd, args) => {
    if (cmd === 'open_image') return openReply;
    if (cmd === 'get_params') return { modules: state };
    if (cmd === 'history') return historyItems;
    if (cmd === 'spots') return { spots: [] };
    if (cmd === 'set_params') { sentParams.push(args); return {}; }
    return {};
  };
  Session.prototype.loadMasks = async () => {};
  Session.prototype.requestRender = () => {};
  Session.prototype.pump = async () => {};
  try {
    const s = await Session.open('legacy.jpg', null, () => ({ width: 128, height: 96 }), () => {}, (e) => { throw Error(e); }, true);
    assert.equal(s.toneMappable, false);
    assert.equal(s.values.tm_mode, M.TM_NONE);
    assert.equal(s.values.mod_contrast, 1);
    assert.equal(s.values.mod_blacks, 1);
    assert.equal(s.values.mod_saturation, 1);

    // Simple sliders must not dirty agx or sigmoid (preserving legacy AgX untouched).
    s.set('whites', 40);
    s.set('contrast', 20);
    s.set('blacks', -15);
    s.set('saturation', 10);
    s.set('tm_mode', M.TM_AGX);
    s.set('mod_contrast', 0);
    assert.equal(s.values.tm_mode, M.TM_NONE);
    assert.equal(s.values.mod_contrast, 1);
    assert.equal(s.dirty.has('agx'), false);
    assert.equal(s.dirty.has('sigmoid'), false);
    assert.equal(s.dirty.has('colorbalancergb'), true);
    assert.equal(s.dirty.has('exposure'), true);

    // Fresh LDR photo in preparePastePhoto must not set tm_mode = 1.
    openReply = { ...openReply, fresh: true, edited: false };
    historyItems = [];
    state.agx.enabled = false;
    const freshJpg = await Session.open('fresh.jpg', null, () => ({ width: 128, height: 96 }), () => {}, (e) => { throw Error(e); }, true);
    await preparePastePhoto(freshJpg, { profile: 12, compensation: 1, auto: false, preset: null });
    assert.equal(freshJpg.values.tm_mode, M.TM_NONE);
    assert.equal(freshJpg.dirty.has('agx'), false);
    assert.equal(freshJpg.dirty.has('sigmoid'), false);

    // Edited RAW with filmicrgb enabled: Simple sliders must stay on TM_NONE and
    // activeToneMappers/disableOtherToneMappers must detect and disable filmicrgb.
    openReply = { ...openReply, raw: true, ldr: false, fresh: false, edited: true };
    historyItems = [{ op: 'filmicrgb', name: 'filmic rgb', label: null, enabled: true, priority: 0, default_enabled: false, fixed: false, masked: false }];
    const rawFilmic = await Session.open('raw.dng', null, () => ({ width: 128, height: 96 }), () => {}, (e) => { throw Error(e); }, true);
    assert.equal(rawFilmic.toneMappable, true);
    assert.equal(rawFilmic.values.tm_mode, M.TM_NONE);
    assert.equal(rawFilmic.values.mod_contrast, 1);
    assert.equal(rawFilmic.values.mod_blacks, 1);
    assert.equal(rawFilmic.values.mod_saturation, 1);
    assert.deepEqual(rawFilmic.activeToneMappers().map((x) => x.op), ['filmicrgb']);
    rawFilmic.disableOtherToneMappers({ op: 'agx', priority: 0 });
    assert.equal(rawFilmic.modulePending.length, 1);
    assert.equal(rawFilmic.modulePending[0].op, 'filmicrgb');
    assert.equal(rawFilmic.modulePending[0].req.enabled, false);
  } finally {
    delete globalThis.tmInvoke;
    Session.prototype.loadMasks = origMasks;
    Session.prototype.requestRender = origRender;
    Session.prototype.pump = origPump;
  }
});
