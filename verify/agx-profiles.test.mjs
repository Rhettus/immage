// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../app/package.json', import.meta.url));
const { transformSync } = await import(require.resolve('rolldown/experimental'));
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@tauri-apps/api/core') return { url: 'data:text/javascript,export const invoke=(...args)=>globalThis.agxInvoke(...args)', shortCircuit: true };
    if (spec.startsWith('./') || spec.startsWith('../')) for (const ext of ['.ts', '.tsx']) {
      const url = new URL(spec + ext, ctx.parentURL);
      if (existsSync(url)) return next(url.href, ctx);
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (!url.startsWith('file:') || !/\.tsx?$/.test(url)) return next(url, ctx);
    const path = fileURLToPath(url);
    return { format: 'module', source: transformSync(path, readFileSync(path, 'utf8'), { jsx: { runtime: 'automatic' } }).code, shortCircuit: true };
  },
});
let saved = [], failSave = false;
globalThis.agxInvoke = async (cmd, args) => {
  if (cmd === 'agx_profiles_load') return structuredClone(saved);
  if (cmd === 'agx_profiles_save') {
    if (failSave) throw Error('disk full');
    saved = structuredClone(args.profiles);
    return;
  }
  throw Error(cmd);
};
const M = await import('../app/src/manifest.ts');
const P = await import('../app/src/agxProfiles.ts');
const params = Object.fromEntries(M.AGX_FIELDS.map(f => [f, 0]));
Object.assign(params, M.AGX_PROFILES[0].params, { look_lift: .1, look_slope: 1.1, look_brightness: 1.25,
  range_black_relative_ev: -8, range_white_relative_ev: 5, curve_pivot_x: .4,
  curve_pivot_y_linear_output: .18, curve_target_display_white_ratio: 1,
  dynamic_range_scaling: .1, hdr_purity: .5 });

test('import names, persistent IDs, menu refresh and failed-save rollback', async () => {
  await P.loadAgxProfiles();
  const ids = await P.addAgxProfiles([{ name: 'Group|My look', params }, { name: 'Group|My look', params }]);
  assert.deepEqual(ids, [100, 101]);
  assert.deepEqual(saved.map(p => p.label), ['My look', 'My look (2)']);
  assert.equal(M.profileLabel(101), 'My look (2)');
  assert.equal(M.PROFILE_GROUPS.at(-1)[0], 'My Presets');
  await P.loadAgxProfiles();
  assert.equal(P.userProfiles().length, 2);
  failSave = true;
  await assert.rejects(P.addAgxProfiles([{ name: 'Failed', params }]), /disk full/);
  assert.equal(P.userProfiles().length, 2);
  assert.equal(M.PROFILE_OPTIONS.some(([label]) => label === 'Failed'), false);
  failSave = false;
});

test('imported profile retains full native settings and slider bases on reopen', () => {
  M.setUserProfiles([{ value: 100, label: 'My look', params }]);
  const profile = M.modules.find(m => m.op === 'agx' && m.controls.includes('profile'));
  const values = { ...M.profileSelection(100), whites: 0, contrast: 0, blacks: 0, saturation: 0 };
  const native = { ...profile.write(values, params) };
  for (const map of M.modules.filter(m => m.op === 'agx' && !m.controls.includes('profile'))) {
    if (map.enabled?.(values) === false || map.active?.(values) === false) continue;
    Object.assign(native, map.write(values, params));
  }
  for (const field of M.AGX_FIELDS) assert.ok(Math.abs(native[field] - params[field]) < 1e-6, field);
  assert.equal(profile.read(native, params).profile, 100);
  const black = M.modules.find(m => m.op === 'agx' && m.fields.includes('look_lift') && m.controls.includes('blacks'));
  const moved = { ...values, blacks: 20 };
  const edited = { ...native, ...black.write(moved, params) };
  assert.ok(Math.abs(black.read(edited, params, {}, moved).blacks - 20) < 1e-6);
  assert.equal(profile.read(edited, params).profile, 100);
  assert.deepEqual(M.profileSelection(11), { profile: 11 });
});

test('delete only imported profiles, preserve existing photo bases and never reuse IDs', async () => {
  await P.loadAgxProfiles();
  await assert.rejects(P.deleteAgxProfiles([0]), /Only user-loaded/);
  await assert.rejects(P.deleteAgxProfiles([11]), /Only user-loaded/);
  await assert.rejects(P.deleteAgxProfiles([100, 999]), /Only user-loaded/);
  assert.equal(P.userProfiles().length, 2, 'invalid mixed deletion is atomic');
  failSave = true;
  await assert.rejects(P.deleteAgxProfiles([100]), /disk full/);
  assert.equal(P.userProfiles().length, 2, 'failed delete leaves menu intact');
  failSave = false;
  const profile = M.modules.find(m => m.op === 'agx' && m.controls.includes('profile'));
  const values = M.profileSelection(100);
  const before = profile.write(values, params);
  await P.deleteAgxProfiles([100]);
  assert.deepEqual(P.userProfiles().map(p => p.value), [101]);
  assert(!M.PROFILE_OPTIONS.some(([, value]) => value === 100));
  assert.equal(M.profileLabel(100), 'My look (deleted)');
  assert.deepEqual(profile.write(values, params), before, 'deletion preserves an applied profile');
  assert(saved.find(p => p.value === 100).deleted);
  await P.loadAgxProfiles();
  assert.deepEqual(profile.write(values, params), before, 'bases survive restart');
  assert.deepEqual(P.userProfiles().map(p => p.value), [101]);
  assert.deepEqual(await P.addAgxProfiles([{ name: 'My look', params }]), [102]);
  await P.deleteAgxProfiles([101, 102]);
  assert.equal(P.userProfiles().length, 0);
  assert(!M.PROFILE_GROUPS.some(([label]) => label === 'My Presets'));
  assert.deepEqual(await P.addAgxProfiles([{ name: 'Fresh', params }]), [103]);
});
