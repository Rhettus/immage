// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import type { Sample } from "./perf";
import type { Preview } from "./Preferences";

export type TunerSettings = { preview: Preview; balancedSize: number; smallest: number; draftTarget: number; cachedDetail: boolean };
export type TunerContext = { photo:string; width:number; height:number; dpr:number };
export type TunerRun = { context?: TunerContext; valid?: boolean; path: string; samples: Sample[]; phases: { atMs: number; label: string }[] };
export type TunerMeasurement = { fps: number; latency: number; complete: boolean; modules: [string, number][] };

// discard each outer decile by rank, then take the median of the retained frames
export function trimmedMedian(values: number[]): number {
  const sorted = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a,b) => a-b);
  if (!sorted.length) return Infinity;
  const cut = Math.floor(sorted.length*0.1);
  const middle = sorted.slice(cut,sorted.length-cut), at = Math.floor(middle.length/2);
  return middle.length%2 ? middle[at] : (middle[at-1]+middle[at])/2;
}

export function measureTuner(run: TunerRun): TunerMeasurement {
  const drags = run.phases.flatMap((phase,i) => {
    if (!phase.label.endsWith(" drag") || !run.phases[i+1]) return [];
    const end = run.phases[i+1].atMs;
    return [run.samples.filter((s) => s.kind === "edit" && s.at >= phase.atMs && s.at < end).sort((a,b) => a.at-b.at)];
  });
  const samples = drags.flat();
  const intervals = drags.flatMap((frames) => frames.slice(1).map((s,i) => s.at-frames[i].at)).filter((v) => v>0);
  const frameTime = trimmedMedian(intervals), costs = new Map<string,number[]>();
  for (const sample of samples) for (const m of sample.modules) {
    if (m.kind !== "module" || !Number.isFinite(m.ms)) continue;
    const values = costs.get(m.label) ?? [];
    values.push(m.ms); costs.set(m.label,values);
  }
  return {
    fps: Number.isFinite(frameTime) && frameTime>0 ? 1000/frameTime : 0,
    latency: trimmedMedian(samples.map((s) => s.total)),
    complete: run.valid !== false && drags.length>=6 && drags.every((frames) => frames.length>=2 && frames.some((s) => !s.estimated) && frames.every((s) => Number.isFinite(s.total) && s.total>=0)),
    modules: [...costs].map(([name,times]):[string,number] => [name,trimmedMedian(times)]).sort((a,b) => b[1]-a[1]).slice(0,4),
  };
}

export function tunerChanges(from: TunerSettings, to: TunerSettings): string[] {
  const changes: string[] = [];
  if (from.cachedDetail !== to.cachedDetail) changes.push(`Adaptive cached preview: ${to.cachedDetail ? "On" : "Off"}`);
  if (from.preview !== to.preview) changes.push(`Preview: ${from.preview} → ${to.preview}`);
  if (to.preview === "balanced" && from.balancedSize !== to.balancedSize) changes.push(`Balanced preview size: ${to.balancedSize * 100}%`);
  if (from.smallest !== to.smallest) changes.push(`Smaller drafts for slow sliders: ${to.smallest * 100}% of the selected preview size`);
  if (from.draftTarget !== to.draftTarget) changes.push(`Draft time: ${to.draftTarget} ms`);
  return changes;
}

export type TunerTrial = { settings: TunerSettings; measurement: TunerMeasurement; path: string };
export function tunerCandidates(): TunerSettings[] {
  const full: TunerSettings = { preview: "quality", balancedSize: 1, smallest: 1, draftTarget: 40, cachedDetail: false };
  return [
    { ...full, preview: "balanced", cachedDetail: true },
    { ...full, preview: "balanced" },
    { ...full, preview: "balanced", balancedSize: 0.75 },
    { ...full, preview: "balanced", balancedSize: 0.5 },
    { ...full, preview: "balanced", balancedSize: 0.5, smallest: 0.7 },
    { ...full, preview: "balanced", balancedSize: 0.5, smallest: 0.5 },
    { ...full, preview: "performance", balancedSize: 0.5, smallest: 1 },
    { ...full, preview: "performance", balancedSize: 0.5, smallest: 0.7 },
    { ...full, preview: "performance", balancedSize: 0.5, smallest: 0.5 },
  ].flatMap((settings) => settings.balancedSize === 1 ? [settings]
    : [{...settings,cachedDetail:true},settings]) as TunerSettings[];
}

// Prefer full-size adaptive previews; stop as soon as both measured targets are met.
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
