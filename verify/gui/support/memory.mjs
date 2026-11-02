// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile } from 'node:fs/promises';

export const memoryPolicy = Object.freeze({ minimumAvailableBytes: 4 * 1024 ** 3, maximumSwapUsedFraction: .5 });
export function assessMemory(meminfo) {
  const fields = {};
  for (const line of meminfo.split('\n')) {
    const m = /^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+)\s+kB$/.exec(line);
    if (m) fields[m[1]] = Number(m[2]) * 1024;
  }
  for (const key of ['MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree'])
    if (!Number.isSafeInteger(fields[key]) || fields[key] < 0) throw Error(`Cannot establish memory safety: invalid/missing ${key}`);
  if (!fields.MemTotal || fields.MemAvailable > fields.MemTotal || fields.SwapFree > fields.SwapTotal)
    throw Error('Cannot establish memory safety: inconsistent memory counters');
  const swapUsedFraction = fields.SwapTotal ? (fields.SwapTotal - fields.SwapFree) / fields.SwapTotal : 0;
  const reasons = [];
  if (fields.MemAvailable < memoryPolicy.minimumAvailableBytes)
    reasons.push(`available RAM ${(fields.MemAvailable / 1024 ** 3).toFixed(2)} GiB is below the required 4 GiB`);
  if (swapUsedFraction > memoryPolicy.maximumSwapUsedFraction)
    reasons.push(`swap usage ${(swapUsedFraction * 100).toFixed(1)}% exceeds 50%`);
  return { at: new Date().toISOString(), ...fields, swapUsedFraction, policy: memoryPolicy, allowed: !reasons.length, reasons };
}
export async function availableMemory() {
  return assessMemory(await readFile('/proc/meminfo', 'utf8'));
}
