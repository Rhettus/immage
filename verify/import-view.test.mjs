// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const appPkgUrl = new URL('../app/package.json', import.meta.url).href;
const require = createRequire(appPkgUrl);
const { transformSync } = await import(require.resolve('rolldown/experimental'));
const { parseSync } = await import(require.resolve('rolldown/utils'));
const zustandDir = dirname(require.resolve('zustand/package.json'));
const zustandUrl = pathToFileURL(join(zustandDir, 'esm/index.mjs')).href;
const zustandVanillaUrl = pathToFileURL(join(zustandDir, 'esm/vanilla.mjs')).href;

const apiCalls = {
  listVolumes: async () => [],
  scanSource: async () => ({ gen: 1, root: '', items: [] }),
  closeSource: () => {},
};
globalThis.__immporterTestApi = apiCalls;
globalThis.window ??= globalThis;

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'react') {
      return {
        url: 'data:text/javascript,export const useSyncExternalStore=()=>{};export default{useSyncExternalStore,useCallback:f=>f,useDebugValue:()=>{}};',
        shortCircuit: true,
      };
    }
    if (spec === 'zustand') {
      return { url: zustandUrl, shortCircuit: true };
    }
    if (spec === 'zustand/vanilla') {
      return { url: zustandVanillaUrl, shortCircuit: true };
    }
    if (ctx.parentURL?.endsWith('/immporter/src/store.ts') && spec === './api') {
      return {
        url: 'data:text/javascript,' + encodeURIComponent(`
          export const defaultSettings = {
            destRoot: null,
            folderTpl: "{YYYY}/{MMMM}",
            nameTpl: "{original}",
            importDuplicates: false,
            importDeleted: false,
            paranoid: true,
            tileSize: 180,
            hideDuplicates: false,
            includeSubfolders: true,
            skipRejected: true,
            includeVideos: true,
            sortBy: "capture",
            sortDesc: false,
          };
          export const api = new Proxy({}, {
            get: (_, prop) => (...args) => globalThis.__immporterTestApi[prop](...args),
          });
        `),
        shortCircuit: true,
      };
    }
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
    return {
      format: 'module',
      source: transformSync(path, readFileSync(path, 'utf8'), { jsx: { runtime: 'automatic' } }).code,
      shortCircuit: true,
    };
  },
});

const { useStore, isOnVolume } = await import('../immporter/src/store.ts');

const makeVol = (mountPoint, name = 'CARD') => ({
  name,
  mountPoint,
  total: 1000,
  available: 500,
  removable: true,
  fileSystem: 'exfat',
  hasDcim: true,
});

const makeItem = (id, name = `IMG_${id}.ARW`, thumb = `/tmp/thumb_${id}.jpg`) => ({
  id,
  name,
  dir: 'DCIM/100MSDCF',
  size: 100,
  files: [{ name, size: 100, kind: 'raw', status: 'new', existing: null, immich: null }],
  capture: null,
  fileTime: null,
  dateSource: null,
  camera: null,
  thumb,
  thumbFailed: false,
  status: 'new',
  kind: 'raw',
  durationSecs: null,
  width: null,
  height: null,
});

function resetStore(patch = {}) {
  useStore.setState({
    volumes: [],
    refreshSeq: 0,
    source: null,
    sourceRoot: null,
    scanning: false,
    scanError: null,
    gen: 0,
    items: [],
    selected: new Set(),
    highlighted: new Set(),
    touched: new Set(),
    anchor: null,
    outcomes: new Map(),
    summary: null,
    importing: false,
    ...patch,
  });
}

test('styles.css maps all 14 Immporter theme variables under .import-view .immporter', () => {
  const css = readFileSync(new URL('../app/src/styles.css', import.meta.url), 'utf8');
  const match = css.match(/\.import-view\s+\.immporter\s*\{([^}]*)\}/);
  assert.ok(match, 'expected .import-view .immporter rule in app/src/styles.css');
  const block = match[1];
  const expectedVars = [
    '--app-bg-primary',
    '--app-bg-secondary',
    '--app-surface',
    '--app-card-active',
    '--app-button-text',
    '--app-text-primary',
    '--app-text-secondary',
    '--app-accent',
    '--app-border-color',
    '--app-hover-color',
    '--app-success',
    '--app-danger',
    '--app-highlight',
    '--app-highlight-ring',
  ];
  for (const name of expectedVars) {
    assert.match(block, new RegExp(`${name}\\s*:`), `missing ${name} in .import-view .immporter`);
  }
});

test('ImportView close button matches culling lightbox X icon button', () => {
  const src = readFileSync(new URL('../app/src/ImportView.tsx', import.meta.url), 'utf8');
  const { errors } = parseSync('ImportView.tsx', src);
  assert.equal(errors.length, 0);
  assert.match(src, /className="tool"[^>]*aria-label=\{t\("library\.import\.close"\)\}/);
  assert.match(src, /<X\s+size=\{16\}\s+aria-hidden="true"\s*\/>/);
});

test('isOnVolume handles POSIX and Windows separators cleanly', () => {
  assert.equal(isOnVolume('/Volumes/CARD', '/Volumes/CARD'), true);
  assert.equal(isOnVolume('/Volumes/CARD/DCIM/100', '/Volumes/CARD'), true);
  assert.equal(isOnVolume('/Volumes/CARD2', '/Volumes/CARD'), false);
  assert.equal(isOnVolume('E:\\DCIM\\100', 'E:\\'), true);
  assert.equal(isOnVolume('E:\\DCIM\\100', 'E:'), true);
});

test('refreshSource rescans mounted source, bumps refreshSeq, and picks up new items/thumbnails', async () => {
  const vol = makeVol('/Volumes/CARD');
  resetStore({
    volumes: [vol],
    source: '/Volumes/CARD',
    sourceRoot: '/Volumes/CARD',
    gen: 1,
    items: [makeItem(0, 'OLD.ARW', '/tmp/old.jpg')],
  });
  let scanCalls = 0;
  apiCalls.listVolumes = async () => [vol];
  apiCalls.scanSource = async (path) => {
    scanCalls++;
    assert.equal(path, '/Volumes/CARD');
    return {
      gen: 2,
      root: '/Volumes/CARD',
      items: [makeItem(0, 'OLD.ARW', '/tmp/old.jpg'), makeItem(1, 'NEW.ARW', '/tmp/new.jpg')],
    };
  };
  apiCalls.closeSource = () => {};

  await useStore.getState().refreshSource();
  const s = useStore.getState();
  assert.equal(scanCalls, 1);
  assert.equal(s.refreshSeq, 1);
  assert.equal(s.gen, 2);
  assert.deepEqual(s.items.map((i) => i.name), ['OLD.ARW', 'NEW.ARW']);
});

test('refreshSource clears source and calls closeSource when ejected card is no longer mounted', async () => {
  const vol = makeVol('/Volumes/CARD');
  resetStore({
    volumes: [vol],
    source: '/Volumes/CARD/DCIM',
    sourceRoot: '/Volumes/CARD/DCIM',
    gen: 3,
    items: [makeItem(0)],
    selected: new Set([0]),
  });
  let closed = 0;
  let scanned = 0;
  apiCalls.listVolumes = async () => [];
  apiCalls.scanSource = async () => {
    scanned++;
    return { gen: 4, root: '', items: [] };
  };
  apiCalls.closeSource = () => {
    closed++;
  };

  await useStore.getState().refreshSource();
  const s = useStore.getState();
  assert.equal(closed, 1);
  assert.equal(scanned, 0);
  assert.equal(s.refreshSeq, 1);
  assert.equal(s.source, null);
  assert.equal(s.sourceRoot, null);
  assert.deepEqual(s.items, []);
  assert.equal(s.selected.size, 0);
});

test('refreshSource falls back to card root when previous subfolder disappeared on reinserted card', async () => {
  const vol = makeVol('/Volumes/CARD');
  resetStore({
    volumes: [vol],
    source: '/Volumes/CARD/DCIM/100OLD',
    sourceRoot: '/Volumes/CARD/DCIM/100OLD',
    gen: 1,
    items: [makeItem(0)],
  });
  const scannedPaths = [];
  apiCalls.listVolumes = async () => [vol];
  apiCalls.scanSource = async (path) => {
    scannedPaths.push(path);
    if (path === '/Volumes/CARD/DCIM/100OLD') {
      throw new Error('Folder not found');
    }
    return {
      gen: 5,
      root: '/Volumes/CARD',
      items: [makeItem(0, 'REFORMATTED.ARW', '/tmp/reformatted.jpg')],
    };
  };

  await useStore.getState().refreshSource();
  const s = useStore.getState();
  assert.deepEqual(scannedPaths, ['/Volumes/CARD/DCIM/100OLD', '/Volumes/CARD']);
  assert.equal(s.source, '/Volumes/CARD');
  assert.equal(s.scanError, null);
  assert.equal(s.gen, 5);
  assert.deepEqual(s.items.map((i) => i.name), ['REFORMATTED.ARW']);
});

test('refreshSource skips rescan while importing is true', async () => {
  const vol = makeVol('/Volumes/CARD');
  resetStore({
    volumes: [vol],
    source: '/Volumes/CARD',
    importing: true,
    items: [makeItem(0, 'LOCKED.ARW')],
  });
  let scanned = 0;
  let closed = 0;
  apiCalls.listVolumes = async () => [];
  apiCalls.scanSource = async () => {
    scanned++;
    return { gen: 2, root: '/Volumes/CARD', items: [] };
  };
  apiCalls.closeSource = () => {
    closed++;
  };

  await useStore.getState().refreshSource();
  const s = useStore.getState();
  assert.equal(scanned, 0);
  assert.equal(closed, 0);
  assert.equal(s.source, '/Volumes/CARD');
  assert.equal(s.refreshSeq, 1);
});

test('openSource ignores stale out-of-order scan responses for the same path', async () => {
  resetStore();
  let resolveFirst;
  let resolveSecond;
  let call = 0;
  apiCalls.scanSource = () => {
    call++;
    if (call === 1) return new Promise((r) => { resolveFirst = r; });
    return new Promise((r) => { resolveSecond = r; });
  };

  const p1 = useStore.getState().openSource('/Volumes/CARD');
  const p2 = useStore.getState().openSource('/Volumes/CARD');

  resolveSecond({ gen: 20, root: '/Volumes/CARD', items: [makeItem(0, 'FRESH.ARW')] });
  await p2;
  assert.equal(useStore.getState().gen, 20);
  assert.deepEqual(useStore.getState().items.map((i) => i.name), ['FRESH.ARW']);

  resolveFirst({ gen: 10, root: '/Volumes/CARD', items: [makeItem(0, 'STALE.ARW')] });
  await p1;
  assert.equal(useStore.getState().gen, 20);
  assert.deepEqual(useStore.getState().items.map((i) => i.name), ['FRESH.ARW']);
});
