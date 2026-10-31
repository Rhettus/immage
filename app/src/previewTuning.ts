// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import type { Sample } from "./perf";
import type { Preview } from "./Preferences";

export type TunerSettings = { preview: Preview; balancedSize: number; smallest: number; draftTarget: number; cachedExposure: boolean };
export type TunerContext = { photo:string; width:number; height:number; dpr:number };
export type TunerRun = { context?: TunerContext; valid?: boolean; path: string; samples: Sample[]; phases: { atMs: number; label: string }[] };
export type TunerMeasurement = { fps: number; latency: number; complete: boolean; modules: [string, number][] };

export function measureTuner(run: TunerRun): TunerMeasurement {
  const drags = run.phases.flatMap((phase, i) => {
    if (!phase.label.endsWith(" drag") || !run.phases[i + 1]) return [];
    const end = run.phases[i + 1].atMs;
    const samples = run.samples.filter((s) => s.kind === "edit" && s.at >= phase.atMs && s.at < end);
    const times = samples.map((s) => s.total).filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
    return [{ fps: samples.length * 1000 / (end - phase.atMs), latency: times.length ? times[Math.ceil(times.length * 0.95) - 1] : Infinity, samples }];
  });
  const costs = new Map<string, number[]>();
  for (const drag of drags) for (const sample of drag.samples) for (const m of sample.modules) {
    if (m.kind !== "module" || !Number.isFinite(m.ms)) continue;
    const values = costs.get(m.label) ?? [];
    values.push(m.ms); costs.set(m.label, values);
  }
  return {
    fps: drags.length ? Math.min(...drags.map((d) => d.fps)) : 0,
    latency: drags.length ? Math.max(...drags.map((d) => d.latency)) : Infinity,
    complete: run.valid !== false && drags.length >= 6 && drags.every((d) => d.samples.length >= 2 && Number.isFinite(d.latency)),
    modules: [...costs].map(([name, times]): [string, number] => [name, times.reduce((a, b) => a + b, 0) / times.length])
      .sort((a, b) => b[1] - a[1]).slice(0, 4),
  };
}

export function tunerChanges(from: TunerSettings, to: TunerSettings): string[] {
  const changes: string[] = [];
  if (from.cachedExposure !== to.cachedExposure) changes.push(`Cached exposure preview: ${to.cachedExposure ? "On" : "Off"}`);
  if (from.preview !== to.preview) changes.push(`Preview: ${from.preview} → ${to.preview}${to.preview === "balanced" ? ". Grain, diffuse texture and sharpening are omitted while dragging" : ". Also omits noise reduction and HSL while dragging"}`);
  if (to.preview === "balanced" && from.balancedSize !== to.balancedSize) changes.push(`Balanced preview size: ${to.balancedSize * 100}%`);
  if (from.smallest !== to.smallest) changes.push(`Smaller drafts for slow sliders: ${to.smallest * 100}% of the selected preview size`);
  if (from.draftTarget !== to.draftTarget) changes.push(`Draft time: ${to.draftTarget} ms`);
  return changes;
}

export type TunerTrial = { settings: TunerSettings; measurement: TunerMeasurement; path: string };
export function tunerCandidates(): TunerSettings[] {
  const full: TunerSettings = { preview: "quality", balancedSize: 1, smallest: 1, draftTarget: 40, cachedExposure: false };
  return [
    full,
    { ...full, preview: "balanced" },
    { ...full, preview: "balanced", balancedSize: 0.5 },
    { ...full, preview: "balanced", balancedSize: 0.5, smallest: 0.7 },
    { ...full, preview: "balanced", balancedSize: 0.5, smallest: 0.5 },
    { ...full, preview: "performance", balancedSize: 0.5, smallest: 1 },
    { ...full, preview: "performance", balancedSize: 0.5, smallest: 0.7 },
    { ...full, preview: "performance", balancedSize: 0.5, smallest: 0.5 },
  ];
}

// test faithful previews first; stop as soon as both measured targets are met
export async function searchTuner(original: TunerSettings, target: { fps:number; latency:number },
  apply: (settings:TunerSettings) => Promise<void>, run: () => Promise<TunerRun>,
  progress: (settings:TunerSettings, index:number, total:number) => void) {
  const trials: TunerTrial[] = [];
  const candidates = tunerCandidates();
  try {
    for (const [i,candidate] of candidates.entries()) {
      progress(candidate,i+1,candidates.length);
      await apply(candidate);
      const measuredRun = await run();
      if (measuredRun.valid === false) throw new Error("The app was backgrounded or its viewport changed. Keep it visible at the same size and retry.");
      const measurement = measureTuner(measuredRun);
      const trial = { settings:candidate,measurement,path:measuredRun.path };
      trials.push(trial);
      if (measurement.complete && measurement.fps >= target.fps && measurement.latency <= target.latency) return { trial,trials,met:true };
    }
    const trial = [...trials].sort((a,b) => Number(b.measurement.complete)-Number(a.measurement.complete) || b.measurement.fps-a.measurement.fps || a.measurement.latency-b.measurement.latency)[0];
    return { trial,trials,met:false };
  } finally {
    await apply(original);
  }
}
