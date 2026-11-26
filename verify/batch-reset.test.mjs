// SPDX-License-Identifier: GPL-3.0-or-later
// Engine-free tests for resetting edited photos from the grid context menu.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks, createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../app/package.json', import.meta.url));
const { transformSync } = await import(require.resolve('rolldown/experimental'));
const data = source => 'data:text/javascript,' + encodeURIComponent(source);

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@tauri-apps/api/core') {
      return { url: data('export const invoke = (...args) => globalThis.resetInvoke(...args);'), shortCircuit: true };
    }
    if (ctx.parentURL?.endsWith('/batchPaste.ts') && spec === './session') {
      return { url: data('export class Session {}; export const instanceKey = () => {}, mapOpOf = () => {};'), shortCircuit: true };
    }
    if (ctx.parentURL?.endsWith('/batchPaste.ts') && spec === './pasteDefaults') {
      return { url: data('export const filterValuesForPhoto = v => v;'), shortCircuit: true };
    }
    if (spec === './manifest') {
      return { url: data('export const CONVERSIONS = [], LOCAL_CONTROLS = [], TONE_MAPPER_ALL_OPS = new Set(), TM_SIGMOID = 0, TM_AGX = 1;'), shortCircuit: true };
    }
    if (spec.startsWith('.') && !/\.[jt]sx?$/.test(spec)) {
      for (const ext of ['.ts', '.tsx']) {
        const u = new URL(spec + ext, ctx.parentURL);
        if (existsSync(fileURLToPath(u))) return next(u.href, ctx);
      }
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (!url.startsWith('file:') || !url.endsWith('.ts')) return next(url, ctx);
    return {
      format: 'module',
      source: transformSync(fileURLToPath(url), readFileSync(fileURLToPath(url), 'utf8')).code,
      shortCircuit: true,
    };
  },
});

const { resetTargets, runReset } = await import('../app/src/batchPaste.ts');

test('resetTargets excludes unedited, remote, stacked partners, and duplicates', () => {
  const photos = [
    { imgid: 1, path: '/a.arw', edited: true, remote: false },
    { imgid: 2, path: '/b.arw', edited: false, remote: false },
    { imgid: 3, path: '/c.arw', edited: true, remote: true },
    { imgid: 4, path: '/a.jpg', edited: true, remote: false }, // stacked partner in behindRaw
    { imgid: 5, path: '/d.arw', edited: true, remote: false },
    { imgid: 1, path: '/a.arw', edited: true, remote: false }, // duplicate imgid
  ];
  const behindRaw = new Set([4]);
  const isRemote = (p) => p.remote;

  assert.deepEqual(resetTargets([photos[1]], behindRaw, isRemote), []);
  assert.deepEqual(resetTargets([photos[2]], behindRaw, isRemote), []);
  assert.deepEqual(resetTargets([photos[3]], behindRaw, isRemote), []);
  assert.deepEqual(
    resetTargets(photos, behindRaw, isRemote).map(p => p.imgid),
    [1, 5],
  );
});

test('runReset discards history for single and multiple targets inside a batch', async () => {
  const calls = [];
  const progress = [];
  const saved = [];
  globalThis.resetInvoke = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'paste_batch' && args.action === 'begin') return { token: 42 };
    if (cmd === 'history_discard') return { edited: false };
    if (cmd === 'paste_batch' && args.action === 'commit') return {};
    throw Error(`unexpected command ${cmd}`);
  };

  try {
    const single = await runReset(
      [{ imgid: 10, path: '/one.arw' }],
      (done, total) => progress.push([done, total]),
      (u) => saved.push(u),
    );
    assert.deepEqual(single, { token: 42, error: null, recovery: false });
    assert.deepEqual(calls, [
      { cmd: 'paste_batch', args: { action: 'begin', token: null, imgids: [10] } },
      { cmd: 'history_discard', args: { imgid: 10 } },
      { cmd: 'paste_batch', args: { action: 'commit', token: 42, imgids: null } },
    ]);
    assert.deepEqual(progress, [[0, 1], [1, 1]]);
    assert.deepEqual(saved, [{ imgid: 10, edited: false, error: null }]);

    calls.length = 0;
    progress.length = 0;
    saved.length = 0;
    const multi = await runReset(
      [{ imgid: 11, path: '/a.arw' }, { imgid: 12, path: '/b.arw' }],
      (done, total) => progress.push([done, total]),
      (u) => saved.push(u),
    );
    assert.deepEqual(multi, { token: 42, error: null, recovery: false });
    assert.deepEqual(calls, [
      { cmd: 'paste_batch', args: { action: 'begin', token: null, imgids: [11, 12] } },
      { cmd: 'history_discard', args: { imgid: 11 } },
      { cmd: 'history_discard', args: { imgid: 12 } },
      { cmd: 'paste_batch', args: { action: 'commit', token: 42, imgids: null } },
    ]);
    assert.deepEqual(progress, [[0, 2], [1, 2], [2, 2]]);
    assert.deepEqual(saved, [
      { imgid: 11, edited: false, error: null },
      { imgid: 12, edited: false, error: null },
    ]);
  } finally {
    delete globalThis.resetInvoke;
  }
});

test('runReset rolls back via abort and release on failure, and keeps token for recovery when abort fails', async () => {
  const calls = [];
  const saved = [];
  globalThis.resetInvoke = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'paste_batch' && args.action === 'begin') return { token: 77 };
    if (cmd === 'history_discard' && args.imgid === 1) return { edited: false };
    if (cmd === 'history_discard' && args.imgid === 2) throw Error('disk full');
    if (cmd === 'paste_batch' && args.action === 'abort') {
      return { updates: [{ imgid: 1, edited: true, error: null }, { imgid: 2, edited: true, error: null }] };
    }
    if (cmd === 'paste_batch' && args.action === 'release') return {};
    throw Error(`unexpected command ${cmd}`);
  };

  try {
    const rolledBack = await runReset(
      [{ imgid: 1, path: '/1.arw' }, { imgid: 2, path: '/2.arw' }],
      () => {},
      (u) => saved.push(u),
    );
    assert.equal(rolledBack.token, null);
    assert.equal(rolledBack.recovery, false);
    assert.match(rolledBack.error, /disk full/);
    assert.match(rolledBack.error, /batch rolled back/);
    assert.deepEqual(calls.map(c => `${c.cmd}:${c.args.action ?? c.args.imgid}`), [
      'paste_batch:begin',
      'history_discard:1',
      'history_discard:2',
      'paste_batch:abort',
      'paste_batch:release',
    ]);
    assert.deepEqual(saved, [
      { imgid: 1, edited: false, error: null },
      { imgid: 1, edited: true, error: null },
      { imgid: 2, edited: true, error: null },
    ]);

    calls.length = 0;
    saved.length = 0;
    globalThis.resetInvoke = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'paste_batch' && args.action === 'begin') return { token: 88 };
      if (cmd === 'history_discard') throw Error('io error');
      if (cmd === 'paste_batch' && args.action === 'abort') {
        return { updates: [{ imgid: 1, edited: false, error: 'read-only sidecar' }] };
      }
      throw Error(`unexpected command ${cmd}`);
    };
    const failedRecovery = await runReset(
      [{ imgid: 1, path: '/1.arw' }],
      () => {},
      (u) => saved.push(u),
    );
    assert.equal(failedRecovery.token, 88);
    assert.equal(failedRecovery.recovery, true);
    assert.match(failedRecovery.error, /recovery failed for 1 photo\(s\)/);
    assert.equal(calls.some(c => c.cmd === 'paste_batch' && c.args.action === 'release'), false);
    assert.deepEqual(saved, [{ imgid: 1, edited: false, error: 'read-only sidecar' }]);
  } finally {
    delete globalThis.resetInvoke;
  }
});

test('App closes the active engine session before resetting or discarding history', () => {
  const app = readFileSync(new URL('../app/src/App.tsx', import.meta.url), 'utf8');
  const pauseMatch = app.match(/const pauseForPaste = async \(\) => \{[\s\S]*?\n  \};/);
  assert.ok(pauseMatch, 'pauseForPaste found in App.tsx');
  assert.match(pauseMatch[0], /await session\.current\?\.close\(\);[\s\S]*await commands\.closeImage\(\);/);
  const resetMatch = app.match(/const resetPhotos = async \([\s\S]*?\n  \};/);
  assert.ok(resetMatch, 'resetPhotos found in App.tsx');
  assert.match(resetMatch[0], /if \(hadSession\) await pauseForPaste\(\);\s*else await commands\.closeImage\(\);/);
});
