// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// work running in the background, for the activity lines under the photo:
// exports, which the Export dialog starts and leaves, and HDR and Panorama
// Merge, on the engine's export thread, and AI Denoise on its thread, while
// the photo is edited. each shows its progress, then what it did: for a
// while, or until dismissed when anything went wrong or it offers a next
// step
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

export type Action = { label: string; run: () => void };

export type Job = {
  id: number;
  what: string;            // "Exporting", "Uploading"...
  done: number;
  total: number;           // 0 for work with no count, as a denoise
  stage: string | null;    // past the count, as a panorama's "blending"
  cancel: string | null;   // the command that stops it, if any
  stopping: boolean;
  summary: string | null;  // set once it is over
  failed: boolean;
  action: Action | null;   // offered with the summary, as Open
};

// what a job did, and whether all went well
export type Outcome = { text: string; ok: boolean; action?: Action };

// how long a clean job's summary stays up
const SUMMARY_MS = 5000;

let jobs: Job[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const update = (id: number, change: Partial<Job>) => {
  jobs = jobs.map((j) => (j.id === id ? { ...j, ...change } : j));
  emit();
};

// unique while the page runs, and across a reload while an older page's
// export still runs in Rust
let next = Date.now();

const start = (what: string, total: number, cancel: string | null) => {
  const id = next++;
  jobs = [...jobs, { id, what, done: 0, total, stage: null, cancel, stopping: false, summary: null, failed: false,
                     action: null }];
  emit();
  return id;
};

const track = async <R,>(id: number, run: () => Promise<R>, summarize: (r: R) => Outcome,
                         failed: string): Promise<R | null> => {
  try {
    const r = await run();
    const s = summarize(r);
    update(id, { summary: s.text, failed: !s.ok, action: s.action ?? null });
    if (s.ok && !s.action) window.setTimeout(() => dismissJob(id), SUMMARY_MS);
    return r;
  } catch (e) {
    // a merge stopped from its Stop answers so (main.c, _merge_step)
    if (String(e) === "stopped") {
      update(id, { summary: `${jobs.find((j) => j.id === id)?.what ?? "the job"}: stopped`, failed: false });
      window.setTimeout(() => dismissJob(id), SUMMARY_MS);
      return null;
    }
    update(id, { summary: `${failed}: ${e}`, failed: true });
    return null;
  }
};

let progress: Promise<unknown> | null = null;

// runs export_images with `args` as job `what` of `total` images, and
// returns its result; `summarize` says what it did
export async function runExport<R>(what: string, total: number, args: Record<string, unknown>,
                                   summarize: (r: R) => Outcome): Promise<R | null> {
  progress ??= listen<{ job: number; done: number }>("export-progress", (e) => update(e.payload.job, { done: e.payload.done }));
  await progress;
  const id = start(what, total, "export_cancel");
  return track(id, () => invoke<R>("export_images", { job: id, ...args }), summarize, "Export failed");
}

let merging: Promise<unknown> | null = null;

// runs the merge `command` (hdr_merge, pano_merge) with `args` as job
// `what` of `total` photos: their count as the engine reads them, then the
// merge's own stages, which the engine names and counts (main.c,
// _merge_report). past its last stop it can no longer be stopped
export async function runMerge<R>(what: string, total: number, command: string, args: Record<string, unknown>,
                                  summarize: (r: R) => Outcome, failed: string): Promise<R | null> {
  merging ??= listen<{ job: number; done: number; total: number; stage: string; last: boolean }>("merge-progress",
    (e) => {
      const { job, done, total, stage, last } = e.payload;
      update(job, { done, total, stage: stage === "photos" ? null : stage, ...(last ? { cancel: null } : {}) });
    });
  await merging;
  const id = start(what, total, "merge_cancel");
  return track(id, () => invoke<R>(command, { job: id, ...args }), summarize, failed);
}

// `run` as job `what`, which cannot be stopped; `failed` heads its error
export function runInBackground<R>(what: string, run: () => Promise<R>, summarize: (r: R) => Outcome,
                                   failed: string): Promise<R | null> {
  return track(start(what, 0, null), run, summarize, failed);
}

// stops an export before its next image, a merge before its next photo
export function stopJob(job: Job) {
  if (!job.cancel) return;
  update(job.id, { stopping: true });
  void invoke(job.cancel, { job: job.id });
}

export function dismissJob(id: number) {
  jobs = jobs.filter((j) => j.id !== id);
  emit();
}

export function useJobs(): Job[] {
  const [shown, setShown] = useState(jobs);
  useEffect(() => {
    const l = () => setShown(jobs);
    listeners.add(l);
    l();
    return () => { listeners.delete(l); };
  }, []);
  return shown;
}
