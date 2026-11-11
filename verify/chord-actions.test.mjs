// SPDX-License-Identifier: GPL-3.0-or-later
// chordAction (app/src/actions.ts) must answer every key event as the if chain
// it replaced in App.tsx's keydown handler did. The chain is transcribed below
// as an oracle and both are run over every modifier combination and a list of
// keys, on a Mac and on Windows/Linux.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../app/package.json', import.meta.url));
const { transformSync } = await import(require.resolve('rolldown/experimental'));
// keys.ts computes IS_MAC once, at import. Each platform imports its own copy:
// the URL carries a query (?mac, ?other) and the resolve hook passes the query
// on to the modules a query-bearing module imports, so actions.ts gets the
// keys.ts copy of its own platform
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('./') || spec.startsWith('../')) {
      const query = ctx.parentURL?.split('?')[1];
      for (const ext of ['.ts', '.tsx']) {
        const url = new URL(spec.replace(/\?.*$/, '') + ext, ctx.parentURL);
        if (existsSync(url)) return next(url.href + (query ? '?' + query : ''), ctx);
      }
      if (query && !spec.includes('?')) return next(spec, ctx);
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (!url.startsWith('file:') || !/\.tsx?(\?.*)?$/.test(url)) return next(url, ctx);
    const path = fileURLToPath(url);
    return { format: 'module', source: transformSync(path, readFileSync(path, 'utf8'), { jsx: { runtime: 'automatic' } }).code, shortCircuit: true };
  },
});

const USER_AGENTS = {
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)',
  other: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)',
};
const chordActionFor = {};
for (const [platform, userAgent] of Object.entries(USER_AGENTS)) {
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent }, configurable: true, writable: true });
  chordActionFor[platform] = (await import('../app/src/actions.ts?' + platform)).chordAction;
}

// the chain from App.tsx at commit 8a29ff9 (the keydown handler, from the
// ⇧⌘P block to the ⌘A block), condition by condition. prevent is whether the
// block called e.preventDefault()
function original(e, IS_MAC) {
  const cmd = (e) => (IS_MAC ? e.metaKey : e.ctrlKey);
  if (cmd(e) && e.shiftKey && e.code === "KeyP") return { id: "perf-overlay", prevent: false };
  if (cmd(e) && e.shiftKey && (e.key === "e" || e.key === "E")) return { id: "export", prevent: true };
  if (cmd(e) && !e.shiftKey && !e.altKey && (e.key === "p" || e.key === "P")) return { id: "print", prevent: true };
  if (cmd(e) && (e.key === "c" || e.key === "C" || e.code === "KeyC") && e.shiftKey) return { id: "copy-settings", prevent: true };
  if (cmd(e) && e.code === "KeyV" && (e.shiftKey || e.altKey)) return { id: e.altKey ? "paste-previous" : "paste-settings", prevent: true };
  if (cmd(e) && e.code === "Slash") return { id: "shortcuts", prevent: true };
  if (cmd(e) && e.code === "Quote") return { id: "virtual-copy", prevent: true };
  if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === "KeyH") return { id: "hdr-merge", prevent: true };
  if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === "KeyM") return { id: "pano-merge", prevent: true };
  if (cmd(e) && e.key === ",") return { id: "preferences", prevent: true };
  if (cmd(e) && e.shiftKey && (e.key === "i" || e.key === "I")) return { id: "import", prevent: true };
  if (cmd(e) && (e.key === "z" || e.key === "Z")) return { id: e.shiftKey ? "redo" : "undo", prevent: true };
  if (cmd(e) && (e.code === "Equal" || e.code === "Minus") && !e.altKey) return { id: e.code === "Equal" ? "zoom-in" : "zoom-out", prevent: true };
  if (cmd(e) && (e.code === "BracketLeft" || e.code === "BracketRight")) return { id: e.code === "BracketLeft" ? "rotate-left" : "rotate-right", prevent: true };
  if (cmd(e) && e.code === "KeyA" && !e.shiftKey && !e.altKey) return { id: "select-all", prevent: true };
  return null;
}

const KEYS = [
  ['p', 'KeyP'], ['P', 'KeyP'], ['e', 'KeyE'], ['E', 'KeyE'],
  ['c', 'KeyC'], ['C', 'KeyC'], ['ç', 'KeyC'], ['v', 'KeyV'], ['V', 'KeyV'],
  ['/', 'Slash'], ['?', 'Slash'], ["'", 'Quote'], ['"', 'Quote'],
  ['h', 'KeyH'], ['H', 'KeyH'], ['m', 'KeyM'], ['M', 'KeyM'], [',', 'Comma'], ['<', 'Comma'],
  ['i', 'KeyI'], ['I', 'KeyI'], ['z', 'KeyZ'], ['Z', 'KeyZ'],
  ['=', 'Equal'], ['+', 'Equal'], ['-', 'Minus'], ['_', 'Minus'],
  ['[', 'BracketLeft'], ['{', 'BracketLeft'], [']', 'BracketRight'], ['}', 'BracketRight'],
  ['a', 'KeyA'], ['A', 'KeyA'],
  ['x', 'KeyX'], ['Tab', 'Tab'], ['Escape', 'Escape'],
  // key and code from different layouts
  ['z', 'KeyY'], ['y', 'KeyZ'], ['p', 'KeyO'], ['e', 'KeyR'], ['i', 'KeyK'], ['c', 'KeyX'], ['x', 'KeyC'],
  ['a', 'KeyQ'], ['q', 'KeyA'], [',', 'KeyM'], ['m', 'Comma'], ['h', 'KeyJ'], ['v', 'KeyB'],
];

const events = [];
for (let m = 0; m < 16; m++) for (const [key, code] of KEYS)
  events.push({ key, code, metaKey: !!(m & 1), ctrlKey: !!(m & 2), altKey: !!(m & 4), shiftKey: !!(m & 8) });

test('chordAction matches the original if chain on every event', () => {
  let checked = 0, matched = 0;
  for (const [platform, chordAction] of Object.entries(chordActionFor)) {
    for (const e of events) {
      const want = original(e, platform === 'mac');
      const got = chordAction(e);
      const at = `${platform} ${JSON.stringify(e)}`;
      if (want === null) assert.equal(got, null, at);
      else {
        assert.ok(got, at);
        assert.equal(got.id, want.id, at);
        assert.equal(got.keep, !want.prevent, at);
        matched++;
      }
      checked++;
    }
  }
  assert.equal(checked, events.length * 2);
  assert.ok(matched > 100, `only ${matched} events matched a rule`);
  console.log(`# ${checked} events checked, ${matched} matched a rule`);
});

const ev = (key, code, mods = '') => ({ key, code, metaKey: mods.includes('m'), ctrlKey: mods.includes('c'), altKey: mods.includes('a'), shiftKey: mods.includes('s') });

test('spot cases', () => {
  const { mac, other } = chordActionFor;
  assert.deepEqual(mac(ev('P', 'KeyP', 'ms')), { id: 'perf-overlay', keep: true });
  assert.deepEqual(other(ev('P', 'KeyP', 'cs')), { id: 'perf-overlay', keep: true });
  assert.deepEqual(other(ev('z', 'KeyZ', 'c')), { id: 'undo', keep: false });
  assert.deepEqual(other(ev('Z', 'KeyZ', 'cs')), { id: 'redo', keep: false });
  assert.deepEqual(mac(ev('h', 'KeyH', 'c')), { id: 'hdr-merge', keep: false });
  assert.equal(mac(ev('h', 'KeyH', 'm')), null);
  assert.equal(other(ev('z', 'KeyZ', 'm')), null);
  assert.deepEqual(mac(ev('a', 'KeyA', 'm')), { id: 'select-all', keep: false });
  assert.equal(mac(ev('a', 'KeyA', 'ma')), null);
});
