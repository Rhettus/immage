// SPDX-License-Identifier: GPL-3.0-or-later
// The Rust layer reaches the engine's main loop without holding up the
// async runtime (AGENTS.md, Threads and blocking): a single request goes
// through AppState::request, which imports cached photos before the engine
// lock and waits for it off the runtime's workers; the lock itself is taken
// only through AppState::engine or crate::blocking. Engine-free: it reads
// sources.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = 'app/src-tauri/src/';

// code without comments, so a note that names a call is not one
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// what a Rust source does that these rules forbid
export function blockingUses(name, src) {
  const text = code(src);
  const found = [];
  // one request: AppState::request, which imports first and settles after
  if (/\.engine\(\s*"[^"]*"\s*\)\s*\.request\(/.test(text)) found.push('engine(..).request( instead of request(');
  // the mutex itself (TracedMutex::lock takes the operation; a plain
  // Mutex's lock() takes nothing): only AppState in main.rs, or inside blocking()
  if (name !== 'main.rs') {
    for (const line of text.split('\n')) {
      if (/\bengine\.lock\(\s*[^)\s]/.test(line) && !/blocking\(\s*\|\|/.test(line)) found.push(`engine.lock( outside blocking(): ${line.trim()}`);
    }
  }
  return found;
}

test('the detector sees a direct request and a bare lock, and ignores comments', () => {
  assert.deepEqual(blockingUses('x.rs', 'state.engine("meta").request(json!({}))'), ['engine(..).request( instead of request(']);
  assert.deepEqual(blockingUses('x.rs', 'state.engine("meta")\n    .request(req)'), ['engine(..).request( instead of request(']);
  assert.equal(blockingUses('x.rs', 'let mut e = state.engine.lock(op, None);').length, 1);
  assert.deepEqual(blockingUses('x.rs', 'let mut e = crate::blocking(|| state.engine.lock(op, None));'), []);
  assert.deepEqual(blockingUses('x.rs', '// state.engine("x").request(y)\nstate.request("x", y)'), []);
  assert.deepEqual(blockingUses('main.rs', 'let mut engine = self.engine.lock(operation, None);'), []);
  assert.deepEqual(blockingUses('x.rs', 'engine.lock().unwrap().request(req)'), []);
});

test('the Rust layer reaches the engine without holding up the runtime', () => {
  const found = readdirSync(root + dir).filter((f) => f.endsWith('.rs')).flatMap((f) =>
    blockingUses(f, readFileSync(root + dir + f, 'utf8')).map((u) => `${f}: ${u}`));
  assert.deepEqual(found, []);
});
