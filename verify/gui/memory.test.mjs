// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessMemory } from './support/memory.mjs';
const info = (available, free = 4 * 1024 ** 2, totalSwap = 8 * 1024 ** 2) =>
  `MemTotal: 8388608 kB\nMemAvailable: ${available} kB\nSwapTotal: ${totalSwap} kB\nSwapFree: ${free} kB\n`;
test('4 GiB available and 50% swap used meets admission limits', () => {
  assert(assessMemory(info(4 * 1024 ** 2)).allowed);
});
test('low available RAM blocks even with abundant swap', () => {
  const r = assessMemory(info(4 * 1024 ** 2 - 1, 8 * 1024 ** 2));
  assert(!r.allowed); assert.match(r.reasons.join(), /available RAM/);
});
test('swap pressure blocks despite sufficient RAM', () => {
  const r = assessMemory(info(6 * 1024 ** 2, 4 * 1024 ** 2 - 1));
  assert(!r.allowed); assert.match(r.reasons.join(), /swap usage/);
});
test('a machine with no swap can qualify on available RAM', () => {
  assert(assessMemory(info(5 * 1024 ** 2, 0, 0)).allowed);
});
test('missing, malformed and inconsistent counters fail closed', () => {
  for (const text of ['', 'MemAvailable: unknown kB', info(9 * 1024 ** 2), info(4 * 1024 ** 2, 9 * 1024 ** 2)])
    assert.throws(() => assessMemory(text), /Cannot establish memory safety/);
});
