// SPDX-License-Identifier: GPL-3.0-or-later
// The page reaches the Rust layer only through the generated bindings, and
// every Immage command is in the typed list. Engine-free: it reads sources.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (rel) => readFileSync(root + rel, 'utf8');
const walk = (dir, ext) => readdirSync(root + dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(`${dir}${e.name}/`, ext) : e.name.endsWith(ext) ? [dir + e.name] : []);

// code without comments, so a note that mentions invoke() is not a call
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// the page's raw use of Tauri's invoke: its import, or a call to it
export function rawInvoke(src) {
  const text = code(src);
  const found = [];
  if (/from\s*["']@tauri-apps\/api\/core["']/.test(text)) found.push('imports @tauri-apps/api/core');
  if (/\binvoke\s*(<[^>(]*>)?\s*\(/.test(text)) found.push('calls invoke(');
  if (/__TAURI_INTERNALS__/.test(text)) found.push('uses __TAURI_INTERNALS__');
  return found;
}

test('the detector sees an import, a call and ignores comments', () => {
  assert.deepEqual(rawInvoke('import { invoke } from "@tauri-apps/api/core";'), ['imports @tauri-apps/api/core']);
  assert.deepEqual(rawInvoke('await invoke<string>("x");'), ['calls invoke(']);
  assert.deepEqual(rawInvoke('// invoke("x")\n/* invoke("y") */\nimport { open } from "@tauri-apps/plugin-dialog";'), []);
});

// bindings.ts is generated from the Rust signatures (app/src-tauri/src/bindings.rs);
// plugin APIs (@tauri-apps/plugin-*) and the window and event APIs are not commands of ours
test('no page file calls a command by name', () => {
  const offenders = walk('app/src/', '.ts').concat(walk('app/src/', '.tsx'))
    .filter((f) => f !== 'app/src/bindings.ts')
    .map((f) => [f, rawInvoke(read(f))]).filter(([, found]) => found.length)
    .map(([f, found]) => `${f}: ${found.join(', ')}`);
  assert.deepEqual(offenders, [], 'call commands.x(...) from app/src/commands.ts instead');
});

// the Rust source with its tests module cut off
const rust = (file) => read(`app/src-tauri/src/${file}`).replace(/^#\[cfg\(test\)\]\s*\nmod tests \{[\s\S]*$/m, '');

test('every #[tauri::command] is listed in collect_commands!', () => {
  const listed = new Set([...rust('bindings.rs').match(/collect_commands!\[([^\]]*)\]/)[1]
    .replace(/\/\/[^\n]*/g, '').split(',').map((s) => s.trim()).filter(Boolean)]
    .map((path) => path.split('::').slice(1).join('::')));
  const declared = [];
  for (const file of readdirSync(root + 'app/src-tauri/src').filter((f) => f.endsWith('.rs'))) {
    const src = rust(file);
    for (const m of src.matchAll(/#\[tauri::command[^\]]*\]((?:\s*#\[[^\]]*\])*)\s*(?:pub(?:\([a-z]+\))?\s+)?(?:async\s+)?fn\s+([a-z_0-9]+)/g)) {
      const module = file === 'main.rs' ? '' : file.replace(/\.rs$/, '::');
      declared.push({ path: module + m[2], specta: /specta::specta/.test(m[1]) });
    }
  }
  assert.ok(declared.length > 100, `found only ${declared.length} commands`);
  const missing = declared.filter((d) => !listed.has(d.path)).map((d) => d.path);
  assert.deepEqual(missing, [], 'list each in app/src-tauri/src/bindings.rs, collect_commands!');
  const plain = declared.filter((d) => !d.specta).map((d) => d.path);
  assert.deepEqual(plain, [], 'a command needs #[specta::specta] after #[tauri::command]');
  const unknown = [...listed].filter((p) => !declared.some((d) => d.path === p));
  assert.deepEqual(unknown, [], 'listed in collect_commands! but not a #[tauri::command] here');
});
