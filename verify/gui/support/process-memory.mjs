// SPDX-License-Identifier: GPL-3.0-or-later
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function parseProcessStat(text) {
  const end = text.lastIndexOf(')'), start = text.indexOf('(');
  if (start < 0 || end < start) throw Error('Invalid process stat');
  const fields = text.slice(end + 2).trim().split(/\s+/);
  return { pid: Number(text.slice(0, start).trim()), name: text.slice(start + 1, end), ppid: +fields[1], group: +fields[2], started: fields[19] };
}
export async function sampleProcesses(rootPid, proc = '/proc', expectedStart) {
  const tree = [];
  for (const pid of await readdir(proc)) {
    if (!/^\d+$/.test(pid)) continue;
    try { tree.push(parseProcessStat(await readFile(join(proc, pid, 'stat'), 'utf8'))); } catch {}
  }
  const root=tree.find(p=>p.pid===rootPid);
  if(!root || (expectedStart!==undefined && root.started!==expectedStart))
    return {at:new Date().toISOString(),processes:[],rssSum:0,swapSum:0,identityLost:true};
  const owned = new Set([rootPid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const p of tree) if (owned.has(p.ppid) && !owned.has(p.pid)) { owned.add(p.pid); changed = true; }
  }
  const results = [];
  for (const p of tree.filter(p => owned.has(p.pid))) {
    try {
      const status = await readFile(join(proc, String(p.pid), 'status'), 'utf8');
      // Recheck start identity against PID reuse while collecting readings.
      const now = parseProcessStat(await readFile(join(proc, String(p.pid), 'stat'), 'utf8'));
      if (now.started !== p.started) continue;
      const value = key => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(status)?.[1] ?? 0) * 1024;
      let pss = null;
      try { pss = Number(/^Pss:\s+(\d+)/m.exec(await readFile(join(proc, String(p.pid), 'smaps_rollup'), 'utf8'))?.[1]) * 1024; } catch {}
      results.push({ ...p, rss: value('VmRSS'), peakRss: value('VmHWM'), swap: value('VmSwap'), pss: Number.isFinite(pss) ? pss : null });
    } catch {} // A child exiting during the sample is normal.
  }
  return { at: new Date().toISOString(), processes: results,
    rssSum: results.reduce((n, p) => n + p.rss, 0), swapSum: results.reduce((n, p) => n + p.swap, 0),
    note: 'RSS sum double counts shared pages. PSS may be unavailable; samples can miss short-lived children.' };
}
