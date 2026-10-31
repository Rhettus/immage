// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import { invoke } from "@tauri-apps/api/core";
import { loadPerfHud, perf } from "./perf";
import * as prefs from "./Preferences";
import { loadLimits, storeLimits, SIZES } from "./CachePrefs";
import { loadScreenScale, storeScreenScale, screenScale } from "./pixelRatio";
import { loadSharedFrames, storeSharedFrames, sharedFramesAvailable } from "./sharedFrames";
export type TunerOption = {
  id: string; label: string; workload: "editing" | "navigation";
  values: { label: string; value: string }[]; current: string; running?: string; restart?: boolean;
  set: (value: string) => Promise<void>;
};
const choices = (values: readonly (string | number | boolean)[]) => values.map((v) => ({ label: typeof v === "boolean" ? v ? "On" : "Off" : String(v), value: String(v) }));
export async function tunerOptions(onOverlay: (on: boolean) => void): Promise<TunerOption[]> {
  const options: TunerOption[] = [];
  const add = (id: string, label: string, workload: TunerOption["workload"], values: TunerOption["values"], current: unknown, set: (value: string) => void | Promise<unknown>, restart = false, running?: unknown) => {
    options.push({ id, label, workload, values, current: String(current), running: running === undefined ? undefined : String(running), restart, set: async (v) => { await set(v); } });
  };
  add("preview", "Preview", "editing", choices(["quality", "balanced", "performance"]), prefs.loadPreview(), (v) => prefs.storePreview(v as prefs.Preview));
  add("balancedSize", "Balanced preview size", "editing", [{label:"50%",value:"0.5"},{label:"100%",value:"1"}], prefs.loadBalancedPreviewSize(), (v) => prefs.storeBalancedPreviewSize(Number(v)));
  add("cachedExposure", "Cached exposure preview", "editing", choices([false,true]), prefs.loadCachedExposurePreview(), (v) => prefs.storeCachedExposurePreview(v === "true"));
  add("smallest", "Smaller drafts for slow sliders", "editing", choices(prefs.DRAFT_SMALLEST), prefs.loadDraftSmallest(), (v) => prefs.storeDraftSmallest(Number(v)));
  add("draftTarget", "Draft time (ms)", "editing", choices(prefs.DRAFT_TARGETS), prefs.loadDraftTarget(), (v) => prefs.storeDraftTarget(Number(v)));
  if (sharedFramesAvailable) add("sharedFrames", "Shared-memory frames", "editing", choices([false,true]), loadSharedFrames(), (v) => storeSharedFrames(v === "true"));
  if (screenScale() !== null) add("screenScale", "Drag drafts at screen scale", "editing", choices([false,true]), loadScreenScale(), (v) => storeScreenScale(v === "true"));
  add("frameCache", "Frame cache (MB)", "editing", choices(prefs.FRAME_CACHE_MB), prefs.loadFrameCacheMb(), (v) => prefs.storeFrameCacheMb(Number(v)));
  add("readAhead", "Read ahead", "navigation", choices([0,1,2,3]), prefs.loadReadAhead().count, (v) => prefs.storeReadAhead({...prefs.loadReadAhead(),count:Number(v)}));
  add("readBoth", "Read ahead both ways", "navigation", choices([false,true]), prefs.loadReadAhead().both, (v) => prefs.storeReadAhead({...prefs.loadReadAhead(),both:v === "true"}));
  const limits = loadLimits();
  for (const [id,label] of [["immichOriginals","Immich originals disk cache"]] as const) {
    add(id,label,"navigation",SIZES[id].map((v) => ({ label:`${v / 1024 ** 2} MB`,value:String(v) })),limits[id],(v) => storeLimits({...loadLimits(),[id]:Number(v)}));
  }
  const [gpu, resources, renderer] = await Promise.allSettled([
    invoke<{running:boolean;next:boolean}>("gpu_edits"),
    invoke<{running:string;next:string}>("darktable_resources"),
    invoke<{running:string;next:string;external:boolean;mesa:boolean;nvidia:boolean} | null>("webview_renderer"),
  ]);
  if (gpu.status === "fulfilled") add("gpu", "Edit on the GPU", "editing",choices([false,true]),gpu.value.next,(v) => invoke("gpu_edits_set",{on:v === "true"}),true,gpu.value.running);
  if (resources.status === "fulfilled") add("resources", "darktable memory", "editing",choices(["small","default","large"]),resources.value.next,(level) => invoke("darktable_resources_set",{level}),true,resources.value.running);
  if (renderer.status === "fulfilled" && renderer.value && !renderer.value.external) {
    const r = renderer.value;
    add("renderer","Window renderer","editing",choices(["auto",...(r.mesa ? ["mesa"] : []),...(r.nvidia ? ["nvidia"] : [])]),r.next,(mode) => invoke("webview_renderer_set",{mode}),true,r.running);
  }
  // the overlay is a diagnostic switch, measured using the same editing workload
  add("overlay","Performance overlay","editing",choices([false,true]),loadPerfHud(),(v) => { onOverlay(v === "true"); perf.enable(v === "true"); });
  return options;
}
