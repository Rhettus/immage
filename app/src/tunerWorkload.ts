// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
export type WorkSample = { name: string; ms: number; ok: boolean };
let recording: WorkSample[] | null = null;
export function startTunerWork() { recording = []; }
export function stopTunerWork() { const samples = recording ?? []; recording = null; return samples; }
export async function timeTunerWork<T>(name: string, work: () => Promise<T>): Promise<T> {
  const target = recording;
  if (!target) return work();
  const at = performance.now();
  let ok = false;
  try { const result = await work(); ok = true; return result; }
  finally { if (recording === target) target.push({ name, ms: performance.now() - at, ok }); }
}
export function recordTunerWork(name: string, ms: number, ok = true) {
  if (recording) recording.push({ name, ms, ok });
}
