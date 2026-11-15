// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import { commands } from "./commands";
import { loadPerfHud, perf } from "./perf";
import * as prefs from "./Preferences";
import { loadLimits, storeLimits, SIZES } from "./CachePrefs";
import { loadScreenScale, storeScreenScale, screenScale } from "./pixelRatio";
import { loadSharedFrames, storeSharedFrames, sharedFramesAvailable } from "./sharedFrames";
import { t } from "./i18n";
export type TunerOption = {
  id: string; label: string; workload: "editing" | "navigation";
  values: { label: string; value: string }[]; current: string; running?: string; restart?: boolean;
  set: (value: string) => Promise<void>;
};
const choices = (values: readonly (string | number | boolean)[]) => values.map((v) => ({ label: typeof v === "boolean" ? v ? t("dialogs.tuner.value.on") : t("dialogs.tuner.value.off") : typeof v === "string" ? t(`dialogs.tuner.value.${v}`) : String(v), value: String(v) }));
export async function tunerOptions(onOverlay: (on: boolean) => void): Promise<TunerOption[]> {
  const options: TunerOption[] = [];
  const add = (id: string, label: string, workload: TunerOption["workload"], values: TunerOption["values"], current: unknown, set: (value: string) => void | Promise<unknown>, restart = false, running?: unknown) => {
    options.push({ id, label, workload, values, current: String(current), running: running === undefined ? undefined : String(running), restart, set: async (v) => { await set(v); } });
  };
  add("preview", t("dialogs.tuner.option.preview"), "editing", choices(["quality", "balanced", "performance"]), prefs.loadPreview(), (v) => prefs.storePreview(v as prefs.Preview));
  add("balancedSize", t("dialogs.tuner.option.balancedSize"), "editing", prefs.BALANCED_PREVIEW_SIZES.map((size) => ({label:`${size*100}%`,value:String(size)})), prefs.loadBalancedPreviewSize(), (v) => prefs.storeBalancedPreviewSize(Number(v)));
  add("smallest", t("dialogs.tuner.option.smallest"), "editing", choices(prefs.DRAFT_SMALLEST), prefs.loadDraftSmallest(), (v) => prefs.storeDraftSmallest(Number(v)));
  add("draftTarget", t("dialogs.tuner.option.draftTarget"), "editing", choices(prefs.DRAFT_TARGETS), prefs.loadDraftTarget(), (v) => prefs.storeDraftTarget(Number(v)));
  if (sharedFramesAvailable) add("sharedFrames", t("dialogs.tuner.option.sharedFrames"), "editing", choices([false,true]), loadSharedFrames(), (v) => storeSharedFrames(v === "true"));
  if (screenScale() !== null) add("screenScale", t("dialogs.tuner.option.screenScale"), "editing", choices([false,true]), loadScreenScale(), (v) => storeScreenScale(v === "true"));
  add("readAhead", t("dialogs.tuner.option.readAhead"), "navigation", choices([0,1,2,3]), prefs.loadReadAhead().count, (v) => prefs.storeReadAhead({...prefs.loadReadAhead(),count:Number(v)}));
  add("readBoth", t("dialogs.tuner.option.readBoth"), "navigation", choices([false,true]), prefs.loadReadAhead().both, (v) => prefs.storeReadAhead({...prefs.loadReadAhead(),both:v === "true"}));
  const limits = loadLimits();
  for (const [id,label] of [["immichOriginals",t("dialogs.tuner.option.immichOriginals")]] as const) {
    add(id,label,"navigation",SIZES[id].map((v) => ({ label:`${v / 1024 ** 2} MB`,value:String(v) })),limits[id],(v) => storeLimits({...loadLimits(),[id]:Number(v)}));
  }
  const [gpu, resources, renderer] = await Promise.allSettled([
    commands.gpuEdits(),
    commands.darktableResources(),
    commands.webviewRenderer(),
  ]);
  if (gpu.status === "fulfilled") add("gpu", t("dialogs.tuner.option.gpu"), "editing",choices([false,true]),gpu.value.next,(v) => commands.gpuEditsSet(v === "true"),true,gpu.value.running);
  if (resources.status === "fulfilled") add("resources", t("dialogs.tuner.option.resources"), "editing",choices(["small","default","large"]),resources.value.next,(level) => commands.darktableResourcesSet(level),true,resources.value.running);
  if (renderer.status === "fulfilled" && renderer.value && !renderer.value.external) {
    const r = renderer.value;
    add("renderer",t("dialogs.tuner.option.renderer"),"editing",choices(["auto",...(r.mesa ? ["mesa"] : []),...(r.nvidia ? ["nvidia"] : [])]),r.next,(mode) => commands.webviewRendererSet(mode),true,r.running);
  }
  // the overlay is a diagnostic switch, measured using the same editing workload
  add("overlay",t("dialogs.tuner.option.overlay"),"editing",choices([false,true]),loadPerfHud(),(v) => { onOverlay(v === "true"); perf.enable(v === "true"); });
  return options;
}
