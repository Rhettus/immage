// SPDX-License-Identifier: GPL-3.0-or-later
// Compare the mask allowlist with the pinned upstream module flags. CI's
// front-end job does not fetch darktable; when absent, report this check skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import './load-app-ts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const iopDir = join(root, 'darktable/src/iop');
const { MASK_MODULES } = await import('../app/src/manifest.ts');

function fnBody(source, name) {
  const start = new RegExp(`\\b${name}\\s*\\([^)]*\\)\\s*\\{`).exec(source);
  if (!start) return '';
  const open = source.indexOf('{', start.index);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
  }
  return '';
}

function sourceModules() {
  return new Map(readdirSync(iopDir).filter((file) => /\.(?:c|cc)$/.test(file)).map((file) => {
    const source = readFileSync(join(iopDir, file), 'utf8');
    const flags = new Set([...fnBody(source, 'flags').matchAll(/IOP_FLAGS_(\w+)/g)].map((m) => m[1]));
    return [file.replace(/\.(?:c|cc)$/, ''), flags];
  }));
}

test('mask modules support blending and permit mask-owned instances in pinned source', {
  skip: existsSync(iopDir) ? false : 'darktable/src/iop is absent; the upstream submodule is not checked out',
}, () => {
  const modules = sourceModules();
  for (const { op } of MASK_MODULES) {
    const flags = modules.get(op);
    assert.ok(flags, `${op} has pinned .c/.cc source`);
    assert.ok(flags.has('SUPPORTS_BLENDING'), `${op} supports blending`);
    assert.ok(!flags.has('NO_MASKS'), `${op} does not prohibit masks`);
    assert.ok(!flags.has('ONE_INSTANCE'), `${op} permits one instance per mask`);
  }
});
