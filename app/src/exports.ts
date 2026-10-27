// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// exports running in the background, for the activity line: the Export
// dialog starts one and closes, and export_images renders it on the
// engine's export thread while the photo is edited. each shows its progress,
// then what it did, for a while or, if anything went wrong, until dismissed
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

export type ExportJob = {
  id: number;
  what: string;            // "Exporting", "Uploading"...
  done: number;
  total: number;
  stopping: boolean;
  summary: string | null;  // set once it is over
  failed: boolean;
};

// how long a clean export's summary stays up
const SUMMARY_MS = 5000;

let jobs: ExportJob[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const update = (id: number, change: Partial<ExportJob>) => {
  jobs = jobs.map((j) => (j.id === id ? { ...j, ...change } : j));
  emit();
};

// unique while the page runs, and across a reload while an older page's
// export still runs in Rust
let next = Date.now();

let progress: Promise<unknown> | null = null;

// runs export_images with `args` as job `what` of `total` images, and
// returns its result; `summarize` says what it did, and whether all went well
export async function runExport<R>(what: string, total: number, args: Record<string, unknown>,
                                   summarize: (r: R) => { text: string; ok: boolean }): Promise<R | null> {
  progress ??= listen<{ job: number; done: number }>("export-progress", (e) => update(e.payload.job, { done: e.payload.done }));
  await progress;
  const id = next++;
  jobs = [...jobs, { id, what, done: 0, total, stopping: false, summary: null, failed: false }];
  emit();
  try {
    const r = await invoke<R>("export_images", { job: id, ...args });
    const s = summarize(r);
    update(id, { summary: s.text, failed: !s.ok });
    if (s.ok) window.setTimeout(() => dismissExport(id), SUMMARY_MS);
    return r;
  } catch (e) {
    update(id, { summary: `Export failed: ${e}`, failed: true });
    return null;
  }
}

// stops it before its next image
export function stopExport(id: number) {
  update(id, { stopping: true });
  void invoke("export_cancel", { job: id });
}

export function dismissExport(id: number) {
  jobs = jobs.filter((j) => j.id !== id);
  emit();
}

export function useExports(): ExportJob[] {
  const [shown, setShown] = useState(jobs);
  useEffect(() => {
    const l = () => setShown(jobs);
    listeners.add(l);
    l();
    return () => { listeners.delete(l); };
  }, []);
  return shown;
}
