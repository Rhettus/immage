// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
//
// Engine-free tests for issue #66:
// 1. Selecting or arrow-stepping in Grid view updates selection without opening
//    the darkroom session; leaving Grid opens the selected photo if needed.
// 2. Opening a fresh photo with automatic baseline defaults (AgX, New Photos
//    preset, etc.) renders in memory without writing an XMP sidecar or calling
//    `save` (which would invalidate Smart search analysis) until the user edits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(new URL('../app/package.json', import.meta.url));
const reactPath = require.resolve('react');
const { transformSync } = await import(require.resolve('rolldown/experimental'));

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@tauri-apps/api/core') {
      return { url: 'data:text/javascript,export async function invoke(cmd, args){return globalThis.gbInvoke ? globalThis.gbInvoke(cmd, args) : {};}', shortCircuit: true };
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

const timers = new Map();
let nextTimer = 1;
globalThis.window = {
  setTimeout(fn, ms) { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
  clearTimeout(id) { timers.delete(id); },
  addEventListener() {},
};
globalThis.addEventListener = () => {};
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};

const grid = await import('../app/src/gridSelection.ts');
const manifest = await import('../app/src/manifest.ts');
const { Session } = await import('../app/src/session.ts');

test('grid selection helpers keep browsing lightweight and open on leave', () => {
  const photos = [{ imgid: 10 }, { imgid: 20 }, { imgid: 30 }];

  assert.equal(grid.shouldOpenOnPick(true), false, 'plain Grid click does not open the darkroom');
  assert.equal(grid.shouldOpenOnPick(false), true, 'filmstrip click still opens the photo');

  assert.equal(grid.gridActivePhoto(photos, new Set(), null), null);
  assert.equal(grid.gridActivePhoto(photos, new Set([20, 30]), 30)?.imgid, 30, 'anchor wins when inside selection');
  assert.equal(grid.gridActivePhoto(photos, new Set([20, 30]), 10)?.imgid, 20, 'falls back to first selected when anchor is unselected');

  assert.equal(grid.stepGridSelection(photos, new Set([10]), 10, 10, 1)?.imgid, 20);
  assert.equal(grid.stepGridSelection(photos, new Set([20]), 20, 10, 1)?.imgid, 30, 'steps from grid selection rather than hidden open photo');
  assert.equal(grid.stepGridSelection(photos, new Set([30]), 30, 10, 1)?.imgid, 30, 'clamps at end');
  assert.equal(grid.stepGridSelection(photos, new Set([10]), 10, 10, -1)?.imgid, 10, 'clamps at start');
  assert.equal(grid.stepGridSelection(photos, new Set(), null, null, 1)?.imgid, 10, 'starts from first photo when nothing selected');
  assert.equal(grid.stepGridSelection(photos, new Set(), null, null, -1)?.imgid, 30, 'starts from last photo stepping backward');

  assert.equal(grid.photoToOpenOnLeaveGrid(false, photos, new Set([20]), 20, () => false), null, 'no-op outside Grid');
  assert.equal(grid.photoToOpenOnLeaveGrid(true, photos, new Set([20]), 20, (i) => i.imgid === 20), null, 'already open photo is not reopened');
  assert.equal(grid.photoToOpenOnLeaveGrid(true, photos, new Set([20]), 20, (i) => i.imgid === 10)?.imgid, 20, 'opens selected grid photo when leaving Grid');
  assert.equal(grid.photoToOpenOnLeaveGrid(true, photos, new Set(), null, (i) => i.imgid === 10), null, 'keeps current photo if grid selection is empty');
});

test('fresh RAW baseline defaults render without saving or invalidating search until edited', async () => {
  const calls = [];
  const state = {};
  for (const m of manifest.modules) {
    const defaults = {};
    for (const f of m.fields) defaults[f] = 0;
    state[m.op] = { enabled: m.op === 'sigmoid', params: { ...defaults }, defaults };
  }
  const origMasks = Session.prototype.loadMasks;
  const origRefreshWb = Session.prototype.refreshWb;
  const origRenderView = Session.prototype.renderView;
  Session.prototype.loadMasks = async () => {};
  Session.prototype.refreshWb = async () => {};
  Session.prototype.renderView = async (view, _kind, _cycle, _idle, _have, edits) => {
    calls.push(['render', edits?.map((e) => e.op) ?? []]);
    return { width: view.width, height: view.height, fullWidth: 128, fullHeight: 96, hash: 'h1', pixels: new Uint8ClampedArray(4), view };
  };
  globalThis.gbInvoke = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'open_image') {
      return { imgid: 7, sensor_width: 128, sensor_height: 96, orientation: 0, raw: true, ldr: false, fresh: true, edited: false, look: null, look_amount: 100, sensor: null };
    }
    if (cmd === 'get_params') return { modules: state };
    if (cmd === 'history') return [];
    if (cmd === 'spots') return { spots: [] };
    if (cmd === 'save') return { edited: false };
    return {};
  };

  try {
    // 1. Interactive open of a fresh RAW: apply AgX baseline default, settle, close.
    timers.clear();
    const s = await Session.open('fresh.orf', 7, () => ({ width: 128, height: 96 }), () => {}, (e) => { throw Error(e); }, false);
    s.setMany([['tm_mode', manifest.TM_AGX]]);
    await s.settled();
    assert.equal(timers.size, 0, 'baseline default must not schedule an autosave timer');
    await s.close();
    assert.equal(calls.some(([c]) => c === 'save'), false, 'viewing an unedited fresh RAW must never call save');

    // 2. Interactive open followed by a real user edit (endBaseline + set): must send baseline_end then save.
    calls.length = 0;
    timers.clear();
    const s2 = await Session.open('fresh.orf', 7, () => ({ width: 128, height: 96 }), () => {}, (e) => { throw Error(e); }, false);
    s2.setMany([['tm_mode', manifest.TM_AGX]]);
    await s2.settled();
    s2.endBaseline();
    s2.set('exposure', 0.5);
    await s2.settled();
    assert.equal(timers.size, 1, 'real edit schedules autosave');
    await s2.close();
    const names = calls.map(([c]) => c);
    assert.ok(names.includes('baseline_end'), 'real edit sends baseline_end before saving');
    assert.ok(names.includes('save'), 'real edit saves on close');
    assert.ok(names.indexOf('baseline_end') < names.indexOf('save'), 'baseline_end precedes save');

    // 3. Background session (batch paste preparePastePhoto): still saves baseline defaults on close.
    calls.length = 0;
    timers.clear();
    const bg = await Session.open('fresh.orf', 7, () => ({ width: 1, height: 1 }), () => {}, (e) => { throw Error(e); }, true);
    bg.setMany([['tm_mode', manifest.TM_AGX]]);
    await bg.settled();
    await bg.close();
    assert.ok(calls.some(([c]) => c === 'save'), 'background paste preparation still persists its unedited baseline');
  } finally {
    delete globalThis.gbInvoke;
    Session.prototype.loadMasks = origMasks;
    Session.prototype.refreshWb = origRefreshWb;
    Session.prototype.renderView = origRenderView;
  }
});

test('engine/session.c does not save unedited baseline sessions on quit or paste batch', () => {
  const src = readFileSync(join(root, 'engine/session.c'), 'utf8');
  const savePending = /void session_save_pending\(void\)\s*\{([\s\S]*?)\n\}/.exec(src);
  assert.ok(savePending, 'finds session_save_pending');
  assert.match(savePending[1], /_s\.baseline/, 'session_save_pending skips unedited baseline sessions');
});
