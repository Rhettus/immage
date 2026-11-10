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
const M = await import('../app/src/menu.ts');

const walk = (items, f) => items.forEach(i => { f(i); if (i.kind === 'submenu') walk(i.items, f); });
const ids = (menus) => { const r = []; menus.forEach(m => walk(m.items, i => { if (i.kind === 'item') r.push(i.id); })); return r; };

// mac uses predefined roles for these; Windows/Linux has About only as an item
const MAC_ROLES = ['quit', 'cut', 'copy', 'paste', 'about'];

test('every action appears once per platform', () => {
  for (const mac of [true, false]) {
    const got = ids(M.forPlatform(M.MENUS, mac));
    const want = M.ACTION_IDS.filter(a => !(mac && MAC_ROLES.includes(a)));
    assert.deepEqual([...got].sort(), [...want].sort(), mac ? 'mac' : 'other');
    assert.equal(new Set(got).size, got.length);
  }
});

test('menu ids are known actions', () => {
  for (const id of ids(M.MENUS)) assert.ok(M.ACTION_IDS.includes(id), id);
  assert.equal(new Set(M.ACTION_IDS).size, M.ACTION_IDS.length);
});

test('nativeAccel', () => {
  const cases = { '⇧⌘E': 'CmdOrCtrl+Shift+E', "⌘'": "CmdOrCtrl+'", '⌘[': 'CmdOrCtrl+[', '⌘=': 'CmdOrCtrl+=',
    '⌘-': 'CmdOrCtrl+-', '⌥⌘V': 'CmdOrCtrl+Alt+V', '⌘,': 'CmdOrCtrl+,', '⌘/': 'CmdOrCtrl+/', '⌃H': 'Ctrl+H',
    F: undefined, Tab: undefined, 0: undefined, '⇧H': undefined };
  for (const [s, a] of Object.entries(cases)) assert.equal(M.nativeAccel(s), a, s);
  assert.ok(M.isSingleKey('⇧H') && M.isSingleKey('Tab') && !M.isSingleKey('⌃H') && !M.isSingleKey('⇧⌘E'));
});

test('nativeSpec labels single keys and gives them no accelerator', () => {
  const shortcuts = new Map();
  M.MENUS.forEach(m => walk(m.items, i => { if (i.kind === 'item' && i.shortcut) shortcuts.set(i.id, i.shortcut); }));
  const seen = new Set();
  const check = (items) => items.forEach(i => {
    if (i.type === 'submenu') return check(i.items);
    if (i.type !== 'item') return;
    seen.add(i.id);
    const s = shortcuts.get(i.id);
    if (s && M.isSingleKey(s)) {
      assert.equal(i.accel, undefined, i.id);
      assert.ok(i.label.endsWith(` (${s})`), i.label);
    } else if (s) assert.equal(i.accel, M.nativeAccel(s), i.id);
    else assert.equal(i.accel, undefined, i.id);
  });
  M.nativeSpec(M.MENUS).forEach(m => check(m.items));
  assert.ok(seen.has('grid'));
  const grid = M.nativeSpec(M.MENUS).flatMap(m => m.items).find(i => i.id === 'grid');
  assert.equal(grid.label, 'Grid View (G)');
});

test('shortcuts are listed in Shortcuts.tsx', () => {
  const src = readFileSync(new URL('../app/src/Shortcuts.tsx', import.meta.url), 'utf8');
  const exceptions = {
    '⌘X': 'standard clipboard keys, handled by the webview', '⌘C': 'standard clipboard keys, handled by the webview',
    '⌘V': 'standard clipboard keys, handled by the webview', '⌘A': 'standard select all, handled by the webview',
    '⌘Q': 'quit is the window manager/OS convention',
    0: 'listed as the range "0 – 5"', 1: 'range "0 – 5"', 2: 'range "0 – 5"', 3: 'range "0 – 5"', 4: 'range "0 – 5"', 5: 'range "0 – 5"',
    6: 'listed as the range "6 – 9"', 7: 'range "6 – 9"', 8: 'range "6 – 9"', 9: 'range "6 – 9"',
  };
  M.MENUS.forEach(m => walk(m.items, i => {
    if (i.kind !== 'item' || !i.shortcut || i.shortcut in exceptions) return;
    assert.ok(src.includes(`"${i.shortcut}"`) || src.includes(`"${i.shortcut} `) || src.includes(` ${i.shortcut}"`), `${i.id} ${i.shortcut}`);
  }));
});

test('forPlatform leaves clean separators', () => {
  for (const mac of [true, false]) {
    const check = (items, where) => {
      assert.ok(items.length, where + ' empty');
      assert.notEqual(items[0].kind, 'separator', where);
      assert.notEqual(items.at(-1).kind, 'separator', where);
      items.forEach((it, n) => {
        if (it.kind === 'separator') assert.notEqual(items[n - 1].kind, 'separator', where);
        if (it.kind === 'submenu') check(it.items, where + '/' + it.label);
      });
    };
    M.forPlatform(M.MENUS, mac).forEach(m => check(m.items, m.label));
  }
  assert.ok(M.forPlatform(M.MENUS, true).some(m => m.label === 'Immage'));
  assert.ok(!M.forPlatform(M.MENUS, false).some(m => m.label === 'Immage' || m.label === 'Window'));
});
