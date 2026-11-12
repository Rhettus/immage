// SPDX-License-Identifier: GPL-3.0-or-later
// Every command the Rust layer, the release checks and the benchmarks send to
// the engine must be one engine/main.c answers. Engine-free: it reads sources.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (rel) => readFileSync(root + rel, 'utf8');
const ls = (dir, ext) => (existsSync(root + dir) ? readdirSync(root + dir) : [])
  .filter((f) => f.endsWith(ext)).map((f) => dir + f);

// the engine's command names, in file order (duplicates kept). Reads the
// `_commands[]` table when main.c has one, else the `!g_strcmp0(cmd, "...")`
// chain in _handle() and _read_requests()
export function engineCommands(src) {
  const table = src.match(/^static const eng_cmd_t _commands\[\] =[^\n]*\n([\s\S]*?)^\};/m);
  if (table) return [...table[1].matchAll(/^\s*\{\s*"([a-z_0-9]+)"\s*,/gm)].map((m) => m[1]);
  // _read_requests() repeats the names it routes to threads (and a few
  // `&& json_object_has_member` variants); only names _handle() lacks are new
  const body = (start) => {
    const at = src.indexOf(start);
    assert.ok(at >= 0, `engine/main.c: ${start} not found`);
    return src.slice(at, src.indexOf('\n}\n', at));
  };
  const re = /!g_strcmp0\(\s*cmd\s*,\s*"([a-z_0-9]+)"\s*\)(\s*&&)?/g;
  const names = [];
  const guarded = [];
  for (const m of body('static void _handle(').matchAll(re)) (m[2] ? guarded : names).push(m[1]);
  for (const n of guarded) if (!names.includes(n)) names.push(n);
  for (const m of body('static gpointer _read_requests(').matchAll(re)) if (!names.includes(m[1])) names.push(m[1]);
  return names;
}

// command names a source file sends: {"cmd": "name"}, { cmd: "name" } and the
// like in Rust, JS and Python, plus the two names Rust picks with an if
function sentCommands(file, src) {
  if (file.endsWith('.rs')) src = src.replace(/^mod tests \{[\s\S]*$/m, ''); // tests send placeholders
  const names = [...src.matchAll(/["']?\bcmd["']?\s*:\s*["']([a-z_0-9]+)["']/g)].map((m) => m[1]);
  if (file.endsWith('main.rs')) {
    for (const m of src.matchAll(/let cmd = if \w+ \{ "([a-z_0-9]+)" \} else \{ "([a-z_0-9]+)" \}/g)) names.push(m[1], m[2]);
    for (const m of src.matchAll(/\["cmd"\]\s*=\s*json!\("([a-z_0-9]+)"\)/g)) names.push(m[1]);
  }
  return names;
}

const engineList = engineCommands(read('engine/main.c'));
const engine = new Set(engineList);

// not engine commands: the benchmark edit server's own protocol, and the
// unknown name request-ids.py sends on purpose
const notEngine = new Set(['benchmarking/lib/edits.mjs']);
const deliberate = new Set(['no_such_command']);
const sources = [
  ...ls('app/src-tauri/src/', '.rs'),
  ...ls('verify/', '.mjs').filter((f) => f !== 'verify/engine-commands.test.mjs'),
  ...ls('verify/', '.py'),
  ...ls('benchmarking/', '.mjs'), ...ls('benchmarking/', '.py'), ...ls('benchmarking/lib/', '.mjs'),
];
const sent = new Map(); // name -> files
for (const f of sources) {
  if (notEngine.has(f)) continue;
  for (const n of sentCommands(f, read(f))) {
    if (deliberate.has(n)) continue;
    if (!sent.has(n)) sent.set(n, new Set());
    sent.get(n).add(f);
  }
}

test('engine command list is found', () => {
  assert.ok(engineList.length > 50, `only ${engineList.length} commands found in engine/main.c`);
});

test('engine/main.c names no command twice', () => {
  const dup = engineList.filter((n, i) => engineList.indexOf(n) !== i);
  assert.deepEqual([...new Set(dup)], [], 'engine/main.c: duplicate commands');
});

test('every command sent to the engine exists in engine/main.c', () => {
  const missing = [];
  for (const [n, files] of sent) if (!engine.has(n)) missing.push(`${[...files].join(', ')}: sends "${n}", which engine/main.c does not handle`);
  assert.deepEqual(missing, []);
});

test('engine commands nobody sends (informational)', (t) => {
  const unused = engineList.filter((n) => !sent.has(n));
  t.diagnostic(`${unused.length} of ${engine.size} unsent: ${unused.join(' ')}`);
});
