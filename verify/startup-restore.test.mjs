// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../app/package.json', import.meta.url));
const { transformSync } = await import(require.resolve('rolldown/experimental'));
const source = readFileSync(new URL('../app/src/App.tsx', import.meta.url), 'utf8');
const start = source.indexOf('  const restoreLast = async');
const end = source.indexOf('  // the grid or the editor', start);
const { code } = transformSync('restore.ts', source.slice(start, end));
const create = new Function('env', `with (env) { ${code}; return restoreLast; }`);
const photo = { path: '/photos/a.raw', imgid: 7, version: 0 };
function fixture({ entries = [photo], fails = false, missingFolder = false } = {}) {
  const views = [], opened = [], folders = [];
  let ready;
  const env = {
    autoGrid: { current: false }, currentRef: { current: null }, shownGen: { current: 0 },
    setGrid: value => views.push(value), setStatus() {},
    isOpen: (entry, current) => entry.imgid === current?.imgid,
    async showFolder(dir, _again, seen) {
      folders.push(dir);
      env.shownGen.current++;
      if (missingFolder && dir === '/photos') return null;
      seen(entries);
      return entries;
    },
    async openFile(path, imgid, _reload, firstFrame) {
      opened.push(path);
      env.currentRef.current = { path, imgid };
      ready = firstFrame;
      return !fails;
    },
  };
  const lib = { current: '/photos', folders: ['/photos'], image: photo.path, grid: false };
  return { env, views, opened, folders, lib, run: create(env), frame: () => ready?.() };
}
test('startup keeps browsing until the restored photo has a frame', async () => {
  const f = fixture();
  await f.run(f.lib);
  assert.deepEqual(f.opened, [photo.path]);
  assert.deepEqual(f.views, [true]);
  f.frame();
  assert.deepEqual(f.views, [true, false]);
});
test('an open failure with current already set leaves the grid visible', async () => {
  const f = fixture({ fails: true });
  await f.run(f.lib);
  assert.ok(f.env.currentRef.current);
  assert.deepEqual(f.views, [true]);
});
test('a missing photo leaves the grid visible', async () => {
  const f = fixture({ entries: [] });
  await f.run(f.lib);
  assert.deepEqual(f.views, [true]);
  assert.deepEqual(f.opened, []);
});
test('a saved grid session does not reopen the photo', async () => {
  const f = fixture();
  await f.run({ ...f.lib, grid: true });
  assert.deepEqual(f.opened, []);
  assert.deepEqual(f.views, [true]);
});
test('a delayed startup frame cannot replace a newer folder or photo', async () => {
  for (const change of [f => f.env.shownGen.current++, f => { f.env.currentRef.current = { imgid: 99 }; }]) {
    const f = fixture();
    await f.run(f.lib);
    change(f);
    f.frame();
    assert.deepEqual(f.views, [true]);
  }
});
test('an unavailable folder falls back to a recent folder in grid mode', async () => {
  const f = fixture({ missingFolder: true });
  await f.run({ ...f.lib, recent: ['/recent'] });
  assert.deepEqual(f.folders, ['/photos', '/recent']);
  assert.deepEqual(f.views, [true]);
  assert.deepEqual(f.opened, []);
});
