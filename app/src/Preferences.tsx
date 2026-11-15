import { useAgxProfiles } from "./agxProfiles";
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the app's preferences, behind the rail's gear (⌘,): settings that belong
// to the app rather than to any photo, a tab per subject
import { useEffect, useState } from "react";
import { currentMemoryBudget, refreshMemoryBudget } from "./memoryBudget";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { keys } from "./keys";
import { AGX_PROFILE_DEFAULT, PROFILE_GROUPS, PROFILE_OPTIONS } from "./manifest";
import { ThemePrefs } from "./ThemePrefs";
import { CachePrefs } from "./CachePrefs";
import { MapSearchPrefs } from "./MapSearchPrefs";
import { Chevron, Collapse } from "./Collapse";
import { ImmichPrefs } from "./ImmichPrefs";
import { ModulePrefs } from "./ModulePrefs";
import { KeywordChips, KeywordInput, parseKeyword } from "./Keywording";
import { PluginPrefs } from "./PluginPrefs";
import type { PluginConfig } from "./plugins";
import { PrefCard, PrefRow, PrefSwitch } from "./PrefsUI";
import { BackupDialog, type BackupMode } from "./BackupDialog";
import { DEFAULT_PRESET_ID, type Preset } from "./Presets";
import { setTourSeen, tourSeen } from "./Tour";
import { OVERLAY_COLORS, OVERLAY_OPACITY, type Rgb } from "./masks";
import { loadSharedFrames, sharedFramesAvailable, storeSharedFrames } from "./sharedFrames";
import { loadScreenScale, screenScale, storeScreenScale, loadSettledScale, storeSettledScale } from "./pixelRatio";
import { checkForUpdate, lastChecked, loadAutoCheck, storeAutoCheck, useUpdate, type UpdateState } from "./updates";

import { loadNewPhotosProfile, storeNewPhotosProfile } from "./profileDefault";
import { settings } from "./settings";
import { loadThumbThreads, storeThumbThreads, THUMB_THREADS } from "./library";
export { loadHiddenModules, storeHiddenModules } from "./hiddenModules";
import { LOCALES, SYSTEM, startupLanguage, loadLanguage, storeLanguage, t } from "./i18n";
import { commands, type AccelProvider, type GpuEditState, type Licenses, type ResourceLevels, type WebviewRenderer } from "./commands";
export { loadNewPhotosProfile } from "./profileDefault";

// EV a new raw's exposure gets on an instance of its own (manifest.ts,
// exp_comp), so Exposure still starts at 0; off unless set. the amount is
// kept apart from the switch, so switching it off and on keeps it
const EXP_COMP_KEY = "immage.exposureCompNew";
const EXP_COMP_EV_KEY = "immage.exposureCompNewEv";
export const EXP_COMP_LIMIT = 3;
function loadExposureCompEv(): number {
  try {
    const v = Number(settings.get(EXP_COMP_EV_KEY) ?? 1);
    return Number.isFinite(v) ? Math.max(-EXP_COMP_LIMIT, Math.min(EXP_COMP_LIMIT, v)) : 1;
  } catch { return 1; }
}
function loadExposureCompOn(): boolean {
  try { return settings.get(EXP_COMP_KEY) === "1"; } catch { return false; }
}
// the EV a new raw gets, 0 when off
export function loadExposureCompNew(): number {
  return loadExposureCompOn() ? loadExposureCompEv() : 0;
}
function storeExposureComp(on: boolean, ev: number) {
  try {
    settings.set(EXP_COMP_KEY, on ? "1" : "0");
    settings.set(EXP_COMP_EV_KEY, String(ev));
  } catch { /* not kept */ }
}

// Basic's Auto on a new raw, as Lightroom's "apply auto tone"; off unless set
const AUTO_TONE_KEY = "immage.autoToneNew";
export function loadAutoToneNew(): boolean {
  try { return settings.get(AUTO_TONE_KEY) === "1"; } catch { return false; }
}
// the new-photos preset on JPEGs and other non-raw photos too; off by default
const PRESET_NON_RAW_KEY = "immage.newPhotosNonRaw";
export function loadNewPhotosNonRaw(): boolean {
  try { return settings.get(PRESET_NON_RAW_KEY) === "1"; } catch { return false; }
}
function storeNewPhotosNonRaw(on: boolean) {
  try { settings.set(PRESET_NON_RAW_KEY, on ? "1" : "0"); } catch { /* not kept */ }
}
function storeAutoToneNew(on: boolean) {
  try { settings.set(AUTO_TONE_KEY, on ? "1" : "0"); } catch { /* not kept */ }
}

// the warning on opening the Negative panel, which says what converting
// turns off; its own "don't warn me again" box sets the same thing
const NEG_WARN_KEY = "immage.negWarn";
export function loadNegWarn(): boolean {
  try { return settings.get(NEG_WARN_KEY) !== "0"; } catch { return true; }
}
export function storeNegWarn(on: boolean) {
  try { settings.set(NEG_WARN_KEY, on ? "1" : "0"); } catch { /* not kept */ }
}

// the Input and Working Profiles last chosen in the Negative panel, each on
// its own; a conversion of a photo still on its default profiles uses them
export type NegProfiles = { input?: number; working?: number };
const NEG_PROFILES_KEY = "immage.negProfiles";
export function loadNegProfiles(): NegProfiles {
  try {
    const v = JSON.parse(settings.get(NEG_PROFILES_KEY) ?? "{}");
    const out: NegProfiles = {};
    for (const role of ["input", "working"] as const)
      if (Number.isFinite(v?.[role])) out[role] = v[role];
    return out;
  } catch { return {}; }
}
export function storeNegProfile(role: "input" | "working", id: number) {
  try { settings.set(NEG_PROFILES_KEY, JSON.stringify({ ...loadNegProfiles(), [role]: id })); }
  catch { /* not kept */ }
}

// what Export to Library writes for a converted negative or a film
// simulation; the Negative and Film Simulation panels set it too. the key
// keeps the name it had when only negatives used it
export type NegativeExportFormat = "dng" | "tiff";
const NEG_EXPORT_KEY = "immage.negativeExportFormat";
export function loadNegativeExportFormat(): NegativeExportFormat {
  try { return settings.get(NEG_EXPORT_KEY) === "tiff" ? "tiff" : "dng"; }
  catch { return "dng"; }
}
export function storeNegativeExportFormat(format: NegativeExportFormat) {
  try { settings.set(NEG_EXPORT_KEY, format); } catch { /* not kept */ }
}

// keywords a photo gets once Immage saves it as edited, and loses when it is
// unedited again, so Immich, which reads them from the sidecar, can filter
// on them; none unless set
const EDITED_KEYWORDS_KEY = "immage.editedKeywords";
export function loadEditedKeywords(): string[] {
  try {
    const v = JSON.parse(settings.get(EDITED_KEYWORDS_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((k) => typeof k === "string" && k) : [];
  } catch { return []; }
}
function storeEditedKeywords(v: string[]) {
  try { settings.set(EDITED_KEYWORDS_KEY, JSON.stringify(v)); } catch { /* not kept */ }
}

// the copyright and creator a photo gets once Immage saves it as edited,
// where it has none of its own; {year} is the year it was taken
const EDITED_META_KEY = "immage.editedMeta";
export type EditedMeta = { rights: string; creator: string };
export function loadEditedMeta(): EditedMeta {
  try {
    const v = JSON.parse(settings.get(EDITED_META_KEY) ?? "null");
    return { rights: typeof v?.rights === "string" ? v.rights : "",
             creator: typeof v?.creator === "string" ? v.creator : "" };
  } catch { return { rights: "", creator: "" }; }
}
function storeEditedMeta(v: EditedMeta) {
  try { settings.set(EDITED_META_KEY, JSON.stringify(v)); } catch { /* not kept */ }
}

// the workspace: the viewer's canvas, and Lightroom's solo mode, where
// opening a panel closes the others
export type Canvas = "dark" | "gray" | "white";
// in the order L steps through them
export const CANVASES: readonly Canvas[] = ["dark", "gray", "white"];
const OPEN_GENERATED_KEY = "immage.openGenerated";
export function loadOpenGenerated(): boolean {
  try { return settings.get(OPEN_GENERATED_KEY) !== "0"; } catch { return true; }
}
export function storeOpenGenerated(on: boolean) {
  try { settings.set(OPEN_GENERATED_KEY, on ? "1" : "0"); } catch { /* not kept */ }
}
const LOUPE_KEY = "immage.loupe";
export function loadLoupe(): boolean {
  try {
    const v = settings.get(LOUPE_KEY);
    return v === null ? PROFILES[loadPreview()].loupe : v === "1";
  } catch { return false; }
}
export function storeLoupe(on: boolean) {
  try { settings.set(LOUPE_KEY, on ? "1" : "0"); } catch { /* not kept */ }
}
const CANVAS_KEY = "immage.canvas";
const FOCUS_MODE_KEY = "immage.focusMode";
export function loadCanvas(): Canvas {
  try {
    const v = settings.get(CANVAS_KEY);
    return CANVASES.find((c) => c === v) ?? "dark";
  } catch { return "dark"; }
}
export function storeCanvas(v: Canvas) {
  try { settings.set(CANVAS_KEY, v); } catch { /* not kept */ }
}
// the masks' overlay on the photo: one of OVERLAY_COLORS or the custom
// color, which is kept while a preset is chosen; darktable's yellow unless set
export type OverlayColor = { pick: keyof typeof OVERLAY_COLORS | "custom"; custom: string; opacity: number };
const OVERLAY_COLOR_KEY = "immage.overlayColor";
export function loadOverlayColor(): OverlayColor {
  try {
    const v = JSON.parse(settings.get(OVERLAY_COLOR_KEY) ?? "null");
    return { pick: v?.pick === "red" || v?.pick === "custom" ? v.pick : "yellow",
             custom: /^#[0-9a-f]{6}$/i.test(v?.custom) ? v.custom : "#33ccff",
             opacity: Number.isFinite(v?.opacity) ? Math.min(100, Math.max(10, Math.round(v.opacity))) : OVERLAY_OPACITY };
  } catch { return { pick: "yellow", custom: "#33ccff", opacity: OVERLAY_OPACITY }; }
}
export function storeOverlayColor(v: OverlayColor) {
  try { settings.set(OVERLAY_COLOR_KEY, JSON.stringify(v)); } catch { /* not kept */ }
}
export function maskOverlayRgb(v: OverlayColor): Rgb {
  if (v.pick !== "custom") { const [r, g, b] = OVERLAY_COLORS[v.pick]; return [r, g, b, v.opacity]; }
  const n = parseInt(v.custom.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255, v.opacity];
}
// the guides drawn over the photo (the crop frame and its grid, the
// straighten line, Transform's grid and guides, the vignette's and a mask
// shape's, a box being picked): white unless set, each with a dark edge
// under it so it shows on a light photo or canvas too
export const GUIDE_COLORS = { white: [255, 255, 255] as Rgb, yellow: OVERLAY_COLORS.yellow, red: OVERLAY_COLORS.red };
export type GuideColor = { pick: keyof typeof GUIDE_COLORS | "custom"; custom: string };
const GUIDE_COLOR_KEY = "immage.guideColor";
export function loadGuideColor(): GuideColor {
  try {
    const v = JSON.parse(settings.get(GUIDE_COLOR_KEY) ?? "null");
    return { pick: v?.pick in GUIDE_COLORS || v?.pick === "custom" ? v.pick : "white",
             custom: /^#[0-9a-f]{6}$/i.test(v?.custom) ? v.custom : "#33ccff" };
  } catch { return { pick: "white", custom: "#33ccff" }; }
}
export function storeGuideColor(v: GuideColor) {
  try { settings.set(GUIDE_COLOR_KEY, JSON.stringify(v)); } catch { /* not kept */ }
}
export function guideRgb(v: GuideColor): Rgb {
  if (v.pick !== "custom") return GUIDE_COLORS[v.pick];
  const n = parseInt(v.custom.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}
// the wheel over a slider moves it only when this is on; off, the panel
// scrolls past it, as in Lightroom, and an edit cannot change by accident
const SLIDER_SCROLL_KEY = "immage.sliderScroll";
export function loadSliderScroll(): boolean {
  try { return settings.get(SLIDER_SCROLL_KEY) === "1"; } catch { return false; }
}
function storeSliderScroll(on: boolean) {
  try { settings.set(SLIDER_SCROLL_KEY, on ? "1" : "0"); } catch { /* not kept */ }
}
// how far a wheel click moves a slider, as a share of its range; 1% unless set
const SLIDER_SCROLL_STEP_KEY = "immage.sliderScrollStep";
const SCROLL_STEPS = [0.0025, 0.005, 0.01, 0.02, 0.04];
export function loadSliderScrollStep(): number {
  try {
    const v = Number(settings.get(SLIDER_SCROLL_STEP_KEY));
    return SCROLL_STEPS.includes(v) ? v : 0.01;
  } catch { return 0.01; }
}
function storeSliderScrollStep(v: number) {
  try { settings.set(SLIDER_SCROLL_STEP_KEY, String(v)); } catch { /* not kept */ }
}

// how much the photo gives up while it is being edited, for speed. a profile
// is a set of defaults for a class of machine: Quality drags at full size,
// Balanced at 75%, Performance at 50% with drafts that may shrink to 50% and
// the detail loupe on. every profile leaves Grain and diffuse (Texture,
// Sharpening) out of drag frames and the idle base. each value can then be
// changed under Advanced, and Reset returns to the profile's. export is never
// affected
export type Preview = "quality" | "balanced" | "performance";
const PREVIEW_KEY = "immage.preview";
// before Preview, a switch for drag drafts: off is Quality's behavior
const DRAG_DRAFTS_KEY = "immage.dragDrafts";
export function loadPreview(): Preview {
  try {
    const v = settings.get(PREVIEW_KEY);
    if (v === "quality" || v === "balanced" || v === "performance") return v;
    return settings.get(DRAG_DRAFTS_KEY) === "0" ? "quality" : "balanced";
  } catch { return "balanced"; }
}
export function storePreview(v: Preview) {
  try { settings.set(PREVIEW_KEY, v); } catch { /* not kept */ }
}

// what choosing a profile sets (draft time is the same for all three). a
// value never stored follows the profile in use
export const PROFILES: Record<Preview, { size: number; smallest: number; target: number; loupe: boolean }> = {
  quality: { size: 1, smallest: 1, target: 60, loupe: false },
  balanced: { size: 0.75, smallest: 1, target: 60, loupe: false },
  performance: { size: 0.5, smallest: 0.5, target: 60, loupe: true },
};

// drag frames' size, as a share of the photo's: the profile's, or as set
export const BALANCED_PREVIEW_SIZES: readonly number[] = [0.5, 0.75, 1];
const BALANCED_SIZE_KEY = "immage.balancedPreviewSize";
export function loadBalancedPreviewSize(): number {
  try { const size = Number(settings.get(BALANCED_SIZE_KEY));
    return BALANCED_PREVIEW_SIZES.includes(size) && settings.get(BALANCED_SIZE_KEY) !== null
      ? size : PROFILES[loadPreview()].size; }
  catch { return PROFILES.balanced.size; }
}
export function storeBalancedPreviewSize(v: number) {
  try { settings.set(BALANCED_SIZE_KEY, String(v)); } catch { /* not kept */ }
}

// how long darktable may take on a drag's draft before the next is smaller,
// and how small it may get each way (Session.draftView): 60 ms and the
// profile's smallest unless set
export const DRAFT_TARGETS = [40, 60, 80, 120] as const;
export const DRAFT_SMALLEST = [1, 0.7, 0.5] as const;
const DRAFT_TARGET_KEY = "immage.draftTarget";
const DRAFT_SMALLEST_KEY = "immage.draftSmallest";
export function loadDraftTarget(): number {
  try {
    const v = Number(settings.get(DRAFT_TARGET_KEY));
    return (DRAFT_TARGETS as readonly number[]).includes(v) ? v : 60;
  } catch { return 60; }
}
export function storeDraftTarget(v: number) {
  try { settings.set(DRAFT_TARGET_KEY, String(v)); } catch { /* not kept */ }
}
export function loadDraftSmallest(): number {
  try {
    const v = Number(settings.get(DRAFT_SMALLEST_KEY));
    return (DRAFT_SMALLEST as readonly number[]).includes(v) && settings.get(DRAFT_SMALLEST_KEY) !== null
      ? v : PROFILES[loadPreview()].smallest;
  } catch { return PROFILES.balanced.smallest; }
}
export function storeDraftSmallest(v: number) {
  try { settings.set(DRAFT_SMALLEST_KEY, String(v)); } catch { /* not kept */ }
}

// how many photos have their raws decoded ahead (App.tsx, prefetchNext):
// in the direction last stepped, and as many behind it with `both`.
// darktable's cache keeps at least 8 decoded raws (main.c, _prefetch), so
// 3 each way and the open photo fit. one ahead unless set
export const READ_AHEAD_MAX = 3;
const READ_AHEAD_KEY = "immage.readAhead";
export type ReadAhead = { count: number; both: boolean };
export function loadReadAhead(): ReadAhead {
  try {
    const v = JSON.parse(settings.get(READ_AHEAD_KEY) ?? "null");
    const count = Number(v?.count ?? 1);
    return { count: Number.isInteger(count) && count >= 0 && count <= READ_AHEAD_MAX ? count : 1, both: !!v?.both };
  } catch { return { count: 1, both: false }; }
}
export function storeReadAhead(v: ReadAhead) {
  try { settings.set(READ_AHEAD_KEY, JSON.stringify(v)); } catch { /* not kept */ }
}

// darktable's resource level, kept by the Rust side for the engine's next
// start (engine.rs, resource_level)
type Resources = "small" | "default" | "large";
type RendererMode = "auto" | "mesa" | "nvidia";

// a RAW+JPEG pair as one photo in the filmstrip, rated, rejected and
// deleted together; off, each file stands alone
const STACK_PAIRS_KEY = "immage.stackPairs";
export function loadStackPairs(): boolean {
  try { return settings.get(STACK_PAIRS_KEY) === "1"; } catch { return false; }
}
export function storeStackPairs(on: boolean) {
  try { settings.set(STACK_PAIRS_KEY, on ? "1" : "0"); } catch { /* not kept */ }
}
// the grid view's cell height in CSS pixels, anywhere from GRID_SIZE_MIN to
// GRID_SIZE_MAX, remembered; in the grid the toolbar's zoom slider sets it,
// ⌘+ and ⌘- ease it and a pinch or ⌘ wheel zooms it freely. the thumbnails come from the mipmap that holds a 240 pixel square
// (library.ts THUMB_SIZE), 450 pixels tall, so the largest size stays sharp at 1x
const GRID_SIZE_KEY = "immage.gridSize";
export const GRID_SIZE_MIN = 120;
export const GRID_SIZE_MAX = 400;
export const GRID_SIZE_DEFAULT = 200;
export const clampGridSize = (v: number) => Math.min(GRID_SIZE_MAX, Math.max(GRID_SIZE_MIN, v));
export function loadGridSize(): number {
  try {
    const v = Number(settings.get(GRID_SIZE_KEY));
    return Number.isFinite(v) && v > 0 ? clampGridSize(v) : GRID_SIZE_DEFAULT;
  } catch { return GRID_SIZE_DEFAULT; }
}
export function storeGridSize(v: number) {
  try { settings.set(GRID_SIZE_KEY, String(v)); } catch { /* not kept */ }
}

// Lightroom's Auto Hide & Show for the side panels, and which are pinned
// open; both remembered
const AUTO_HIDE_KEY = "immage.autoHide";
const PINS_KEY = "immage.pins";
export type Pins = { left: boolean; right: boolean; strip: boolean };
export function loadAutoHide(): boolean {
  try { return settings.get(AUTO_HIDE_KEY) === "1"; } catch { return false; }
}
export function storeAutoHide(on: boolean) {
  try { settings.set(AUTO_HIDE_KEY, on ? "1" : "0"); } catch { /* not kept */ }
}
export function loadPins(): Pins {
  try {
    const v = JSON.parse(settings.get(PINS_KEY) ?? "null");
    return { left: !!v?.left, right: !!v?.right, strip: !!v?.strip };
  } catch { return { left: false, right: false, strip: false }; }
}
export function storePins(p: Pins) {
  try { settings.set(PINS_KEY, JSON.stringify(p)); } catch { /* not kept */ }
}

// on unless turned off
export function loadFocusMode(): boolean {
  try { return settings.get(FOCUS_MODE_KEY) !== "0"; } catch { return true; }
}
export function storeFocusMode(on: boolean) {
  try { settings.set(FOCUS_MODE_KEY, on ? "1" : "0"); } catch { /* not kept */ }
}

// Simple's sliders, or Advanced's darktable modules; Simple unless chosen
export type EditMode = "simple" | "advanced";
const EDIT_MODE_KEY = "immage.editMode";
export function loadEditMode(): EditMode {
  try { return settings.get(EDIT_MODE_KEY) === "advanced" ? "advanced" : "simple"; } catch { return "simple"; }
}
export function storeEditMode(v: EditMode) {
  try { settings.set(EDIT_MODE_KEY, v); } catch { /* not kept */ }
}

// AI acceleration: the GPU provider and device AI upscaling runs on, as
// darktable's own setting; the engine lists what this computer has
export type { AccelProvider } from "./commands";
export type AccelChoice = { provider: string; device: number };
const ACCEL_KEY = "immage.aiAccel";
export function loadAccel(): AccelChoice {
  try {
    const v = JSON.parse(settings.get(ACCEL_KEY) ?? "null");
    if (v && typeof v.provider === "string") return { provider: v.provider, device: Number(v.device ?? -1) };
  } catch { /* the default */ }
  return { provider: "auto", device: -1 };
}
export function storeAccel(v: AccelChoice) {
  try { settings.set(ACCEL_KEY, JSON.stringify(v)); } catch { /* not kept */ }
}

export type PrefsTab = "photos" | "modules" | "immich" | "plugins" | "general" | "performance" | "about";
type Tab = PrefsTab;

const svg = (body: React.ReactNode) => (
  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
       strokeLinecap="round" strokeLinejoin="round">{body}</svg>
);
const TABS: [Tab, string, React.ReactNode][] = [
  ["general", t("prefs.tab.general"), svg(<><circle cx="12" cy="12" r="3" /><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" /></>)],
  ["performance", t("prefs.tab.performance"), svg(<><path d="M4.2 17.5a8.5 8.5 0 1 1 15.6 0" /><path d="m12 13 3.5-4.5" /><circle cx="12" cy="13" r="1.3" /></>)],
  ["photos", t("prefs.tab.photos"), svg(<><rect x="3.5" y="5" width="17" height="14" rx="2.5" /><circle cx="9" cy="10" r="1.6" />
    <path d="m4 17 5-4.5 3.5 3 2.5-2 4.5 3.5" /></>)],
  ["modules", t("prefs.tab.modules"), svg(<><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><path d="M17 13.5v7M13.5 17h7" /></>)],
  ["immich", t("prefs.tab.immich"), svg(<><path d="M7 17.5a4.5 4.5 0 0 1-.6-8.96 6 6 0 0 1 11.5 1.46A3.75 3.75 0 0 1 17.25 17.5z" />
    <path d="M12 10.5v5M9.8 12.7 12 10.5l2.2 2.2" /></>)],
  ["plugins", t("prefs.tab.plugins"), svg(<path d="M9.5 4.5a2 2 0 0 1 4 0V6H17a1 1 0 0 1 1 1v3.5h-1.5a2 2 0 0 0 0 4H18V18a1 1 0 0 1-1 1h-3.5v-1.5a2 2 0 0 0-4 0V19H6a1 1 0 0 1-1-1v-3.5h1.5a2 2 0 0 0 0-4H5V7a1 1 0 0 1 1-1h3.5z" />)],
  ["about", t("prefs.tab.about"), svg(<><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5M12 7.6v.2" /></>)],
];

// where Immage's source is published, which the GPL requires anyone given
// the app to be able to get: the tag each release is built from
const SOURCE_URL = "https://github.com/Rhettus/immage";
const sourceUrl = (app?: string) => (app ? `${SOURCE_URL}/tree/v${app}` : SOURCE_URL);
// darktable's source at what the engine was built from: the commit its
// version names ("5.7.0+1428~g2747ed2a0d"), or a release's tag ("5.8.0")
const DARKTABLE_URL = "https://github.com/darktable-org/darktable";
function darktableUrl(version?: string) {
  const commit = /~g([0-9a-f]{7,})/.exec(version ?? "");
  if (commit) return `${DARKTABLE_URL}/tree/${commit[1]}`;
  const release = /^(\d+\.\d+\.\d+)$/.exec(version?.replace(/-dirty$/, "") ?? "");
  return release ? `${DARKTABLE_URL}/tree/release-${release[1]}` : DARKTABLE_URL;
}
// Preferences > About: the homepage, Discord and GitHub, as icons under the version
const ABOUT_LINKS: [string, string, React.ReactNode][] = [
  [t("prefs.link.home"), "https://immage.photo", svg(<><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.900-3.500 8.500c-2.500-2.600-3.500-5.400-3.500-8.500s1-5.900 3.500-8.500z" /></>)],
  [t("prefs.link.discord"), "https://discord.gg/zm5JwPhdh", svg(<><path d="M7 6.500c3-1.300 7-1.300 10 0 1.800 2.700 2.600 5.400 2.500 8.500-1.200.9-2.400 1.400-3.700 1.800l-.9-1.500M7 6.500C5.200 9.200 4.400 11.900 4.500 15c1.200.9 2.400 1.400 3.700 1.800l.9-1.500" /><circle cx="9.500" cy="12" r=".9" /><circle cx="14.500" cy="12" r=".9" /></>)],
  [t("prefs.link.github"), "https://github.com/Rhettus/immage", svg(<path d="M9 19c-4 1.200-4-2-6-2.500m12 4.500v-3.100a2.700 2.700 0 0 0-.8-2.100c2.600-.3 5.300-1.300 5.300-5.700a4.400 4.400 0 0 0-1.200-3.100 4.100 4.100 0 0 0-.1-3.100s-1-.3-3.200 1.200a11 11 0 0 0-5.800 0C7.100 3.800 6.100 4.100 6.100 4.100a4.100 4.100 0 0 0-.1 3.100A4.400 4.400 0 0 0 4.800 10.300c0 4.400 2.700 5.400 5.300 5.700a2.700 2.700 0 0 0-.8 2.100V21" />)],
];

// what the last check found, for About's row
function updateHint(state: UpdateState, app?: string): string {
  switch (state.kind) {
    case "checking": return t("prefs.update.checking");
    case "current": return t("prefs.update.current", { version: app ?? "" });
    case "available": case "downloading": case "installing": return t("prefs.update.available", { version: state.update.version });
    case "failed": return state.update ? t("prefs.update.available", { version: state.update.version }) : t("prefs.update.failed", { message: state.message });
    default: {
      const last = lastChecked();
      return last ? t("prefs.update.last", { date: new Date(last).toLocaleString() }) : t("prefs.update.never");
    }
  }
}
// a license text over Preferences, taking Escape before Preferences does
function LicenseText({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", esc, true);
    return () => window.removeEventListener("keydown", esc, true);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal license-view">
        <div className="modal-head"><h2>{title}</h2></div>
        <div className="modal-body"><pre>{text}</pre></div>
        <div className="modal-foot"><button className="btn primary" onClick={onClose}>{t("prefs.done")}</button></div>
      </div>
    </div>
  );
}

// the renderer a window is running on, as Preferences names it
function rendererName(active: string): string {
  return ({ mesa: "Mesa", nvidia: "NVIDIA", system: t("prefs.renderer.system"), environment: t("prefs.renderer.environment") } as Record<string, string>)[active] ?? active;
}

export function PreferencesDialog({ presets, newPhotos, onNewPhotos, onSaveCurrent, focus, canvas, onCanvas, overlayColor, onOverlayColor, guideColor, onGuideColor,
                                    openGenerated, onOpenGenerated, loupe, onLoupe, focusMode, onFocusMode, editMode, onEditMode, autoHide, onAutoHide, stackPairs, onStackPairs,
                                    accel, plugins, onPlugins, perfHud, onPerfHud, onBenchmark, onGpuCheck, onTune, onRelaunch, onClose }: {
  presets: Preset[];
  focus?: Tab;                           // a tab to open at
  onSaveCurrent: (() => void) | null;    // a new preset from the open photo, or null with none open
  newPhotos: string | null;              // the preset new photos get, by id
  onNewPhotos: (id: string | null) => void;
  canvas: Canvas;
  onCanvas: (v: Canvas) => void;
  overlayColor: OverlayColor;
  onOverlayColor: (v: OverlayColor) => void;
  guideColor: GuideColor;
  onGuideColor: (v: GuideColor) => void;
  openGenerated: boolean;
  onOpenGenerated: (on: boolean) => void;
  loupe: boolean;
  onLoupe: (on: boolean) => void;
  focusMode: boolean;
  onFocusMode: (on: boolean) => void;
  editMode: EditMode;
  onEditMode: (v: EditMode) => void;
  autoHide: boolean;
  onAutoHide: (on: boolean) => void;
  stackPairs: boolean;
  onStackPairs: (on: boolean) => void;
  accel: AccelProvider[] | null;         // null until the engine has said
  plugins: PluginConfig[];
  onPlugins: (list: PluginConfig[]) => void;
  perfHud: boolean;
  onPerfHud: (on: boolean) => void;
  onTune: (() => void) | null;
  onBenchmark: (() => void) | null;     // null with no photo open
  onGpuCheck: (() => void) | null;      // null with no photo open
  onRelaunch: () => Promise<void>;       // the edit saved, then Immage started again
  onClose: () => void;
}) {
  useAgxProfiles();
  const [tab, setTab] = useState<Tab>(focus ?? "general");
  const [chosenLanguage, setChosenLanguage] = useState(loadLanguage);
  const [languageBusy, setLanguageBusy] = useState(false);
  const [languageError, setLanguageError] = useState("");
  const restartForLanguage = async () => {
    setLanguageBusy(true);
    setLanguageError("");
    try { await settings.flush(); await onRelaunch(); }
    catch (error) { setLanguageError(String(error)); }
    finally { setLanguageBusy(false); }
  };
  // the guide's own "don't show" box sets the same thing
  const [showTour, setShowTour] = useState(() => !tourSeen());
  const [profile, setProfile] = useState(loadNewPhotosProfile);
  const [autoToneNew, setAutoToneNew] = useState(loadAutoToneNew);
  const [presetNonRaw, setPresetNonRaw] = useState(loadNewPhotosNonRaw);
  const [negWarn, setNegWarn] = useState(loadNegWarn);
  const [negativeExportFormat, setNegativeExportFormat] = useState(loadNegativeExportFormat);
  const [expCompOn, setExpCompOn] = useState(loadExposureCompOn);
  const [expCompEv, setExpCompEv] = useState(loadExposureCompEv);
  // as typed, so "-" or "1." can be on the way to a number
  const [expCompText, setExpCompText] = useState(() => String(loadExposureCompEv()));
  const typeExpComp = (text: string) => {
    setExpCompText(text);
    const v = Number(text);
    if (text.trim() === "" || !Number.isFinite(v)) return;
    const ev = Math.round(100 * Math.max(-EXP_COMP_LIMIT, Math.min(EXP_COMP_LIMIT, v))) / 100;
    setExpCompEv(ev);
    storeExposureComp(expCompOn, ev);
  };
  const [editedKeywords, setEditedKeywords] = useState(loadEditedKeywords);
  const chooseEditedKeywords = (v: string[]) => { setEditedKeywords(v); storeEditedKeywords(v); };
  const addEditedKeywords = (names: string[]) => {
    const fresh = names.map(parseKeyword).filter((k) => k && !editedKeywords.includes(k));
    if (fresh.length) chooseEditedKeywords([...editedKeywords, ...new Set(fresh)]);
  };
  const [editedMeta, setEditedMeta] = useState(loadEditedMeta);
  const chooseEditedMeta = (v: Partial<EditedMeta>) => {
    const next = { ...editedMeta, ...v };
    setEditedMeta(next);
    storeEditedMeta(next);
  };
  // every keyword ever used, for the suggestions
  const [knownKeywords, setKnownKeywords] = useState<string[]>([]);
  useEffect(() => { commands.keywords().then(setKnownKeywords).catch(() => {}); }, []);
  const [sliderScroll, setSliderScroll] = useState(loadSliderScroll);
  const [scrollStep, setScrollStep] = useState(loadSliderScrollStep);
  const [preview, setPreview] = useState(loadPreview);
  const [balancedSize, setBalancedSize] = useState(loadBalancedPreviewSize);
  const [sharedFrames, setSharedFrames] = useState(loadSharedFrames);
  const [atScreenScale, setAtScreenScale] = useState(loadScreenScale);
  const [settledAtScreen, setSettledAtScreen] = useState(loadSettledScale);
  const [draftTarget, setDraftTarget] = useState(loadDraftTarget);
  const [draftSmallest, setDraftSmallest] = useState(loadDraftSmallest);
  const [readAhead, setReadAhead] = useState(loadReadAhead);
  const [thumbThreads, setThumbThreads] = useState(loadThumbThreads);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // choosing a profile sets what it stands for, which Advanced can then change
  const applyProfile = (p: Preview) => {
    const d = PROFILES[p];
    setPreview(p); storePreview(p);
    setBalancedSize(d.size); storeBalancedPreviewSize(d.size);
    setDraftSmallest(d.smallest); storeDraftSmallest(d.smallest);
    setDraftTarget(d.target); storeDraftTarget(d.target);
    onLoupe(d.loupe);
  };
  const customized = (() => {
    const d = PROFILES[preview];
    return balancedSize !== d.size || draftSmallest !== d.smallest || draftTarget !== d.target || loupe !== d.loupe;
  })();
  const chooseReadAhead = (v: Partial<ReadAhead>) => {
    const next = { ...readAhead, ...v };
    setReadAhead(next);
    storeReadAhead(next);
  };
  const [resources, setResources] = useState<ResourceLevels | null>(null);
  useEffect(() => { commands.darktableResources().then(setResources).catch(() => {}); }, []);
  const [budget, setBudget] = useState(currentMemoryBudget);
  useEffect(() => { void refreshMemoryBudget().then(setBudget); }, []);
  const gb = (mb: number) => mb >= 1024 ? `${Math.round(mb / 102.4) / 10} ${t("unit.gb")}` : `${mb} ${t("unit.mb")}`;
  const chooseResources = (level: Resources) => {
    if (!resources) return;
    commands.darktableResourcesSet(level)
      .then(() => { setResources({ ...resources, next: level }); return refreshMemoryBudget(); })
      .then((b) => setBudget(b)).catch(() => {});
  };
  const [gpuEdits, setGpuEdits] = useState<GpuEditState | null>(null);
  useEffect(() => { commands.gpuEdits().then(setGpuEdits).catch(() => {}); }, []);
  const chooseGpuEdits = (on: boolean) => {
    if (!gpuEdits) return;
    commands.gpuEditsSet(on).then(() => setGpuEdits({ ...gpuEdits, next: on })).catch(() => {});
  };
  const [renderer, setRenderer] = useState<WebviewRenderer | null>(null);
  const [rendererError, setRendererError] = useState("");
  const [rendererSaving, setRendererSaving] = useState(false);
  useEffect(() => { commands.webviewRenderer().then(setRenderer).catch(() => {}); }, []);
  const chooseRenderer = async (mode: RendererMode) => {
    if (!renderer) return;
    setRendererSaving(true);
    setRendererError("");
    try {
      await commands.webviewRendererSet(mode);
      setRenderer({ ...renderer, next: mode });
    } catch (e) { setRendererError(String(e)); }
    finally { setRendererSaving(false); }
  };
  const [accelChoice, setAccelChoice] = useState(loadAccel);
  const chooseAccel = (v: AccelChoice) => { setAccelChoice(v); storeAccel(v); };
  // the provider the choice comes to: the one chosen if this computer has
  // it, else the first, as the engine resolves "auto"
  const accelProvider = accel?.find((p) => p.id === accelChoice.provider) ?? accel?.[0];
  // commit: the one this app was built from (main.rs, build_label), null outside Git
  const [about, setAbout] = useState<{ app: string; commit: string | null; darktable: string } | null>(null);
  const update = useUpdate();
  const [autoUpdate, setAutoUpdate] = useState(loadAutoCheck);
  useEffect(() => { commands.about().then(setAbout).catch(() => {}); }, []);
  const [licenses, setLicenses] = useState<Licenses | null>(null);
  useEffect(() => { commands.licenses().then(setLicenses).catch(() => {}); }, []);
  const [viewing, setViewing] = useState<{ title: string; text: string } | null>(null);
  const [backup, setBackup] = useState<BackupMode | null>(null);
  useEffect(() => {
    // a dialog opened over this one takes its own Escape
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && document.querySelectorAll(".modal-backdrop").length === 1) onClose();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal prefs">
        <nav className="prefs-tabs">
          <h2>{t("prefs.title")}</h2>
          {TABS.map(([id, label, icon]) => (
            <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>{icon}{label}</button>
          ))}
          {about && (
            <div className="prefs-about" title={`darktable ${about.darktable}`}>
              <span>Immage {about.app}</span>
              {about.commit && <span>commit {about.commit}</span>}
              <span>darktable {about.darktable.split("~")[0]}</span>
              <div className="prefs-links">
                {ABOUT_LINKS.map(([label, url, icon]) => (
                  <button key={label} title={label} aria-label={label} onClick={() => void openUrl(url)}>{icon}</button>
                ))}
              </div>
            </div>
          )}
        </nav>
        <div className="prefs-pane">
          <div className="prefs-scroll">
            {tab === "photos" && (
              <>
                <p className="prefs-lead">{t("prefs.photos.lead")}</p>
                <PrefCard title={t("prefs.card.profile")}>
                  <PrefRow id="Profile" label={t("prefs.row.profile")} summary={t("prefs.row.profile.summary")} hint={t("prefs.row.profile.hint")}>
                    <select className="field" value={profile}
                            onChange={(e) => { const v = Number(e.target.value); setProfile(v); storeNewPhotosProfile(v); }}>
                      {PROFILE_GROUPS.map(([group, opts]) => (
                        <optgroup key={group} label={group}>
                          {opts.map(([label, v]) => <option key={v} value={v}>{label}</option>)}
                        </optgroup>))}
                    </select>
                  </PrefRow>
                </PrefCard>
                <PrefCard title={t("prefs.card.exposure")}>
                  <PrefRow id="Exposure compensation" label={t("prefs.row.expcomp")} summary={t("prefs.row.expcomp.summary")}
                           hint={t("prefs.row.expcomp.hint")}>
                    <PrefSwitch checked={expCompOn}
                                onChange={(on) => { setExpCompOn(on); storeExposureComp(on, expCompEv); }} />
                  </PrefRow>
                  <PrefRow id="Amount" label={t("prefs.row.expcomp.amount")} hint={t("prefs.row.expcomp.amount.hint", { limit: EXP_COMP_LIMIT })}>
                    <input className="field" type="number" step={0.1} min={-EXP_COMP_LIMIT} max={EXP_COMP_LIMIT}
                           disabled={!expCompOn} value={expCompText}
                           onChange={(e) => typeExpComp(e.target.value)}
                           onBlur={() => setExpCompText(String(expCompEv))} />
                  </PrefRow>
                </PrefCard>
                <PrefCard title={t("prefs.card.autotone")}>
                  <PrefRow id="Apply Auto" label={t("prefs.row.autotone")} summary={t("prefs.row.autotone.summary")}
                           hint={t("prefs.row.autotone.hint")}>
                    <PrefSwitch checked={autoToneNew} onChange={(on) => { setAutoToneNew(on); storeAutoToneNew(on); }} />
                  </PrefRow>
                </PrefCard>
                <PrefCard title={t("prefs.card.preset")}>
                  <PrefRow id="Apply preset" label={t("prefs.row.preset")} summary={t("prefs.row.preset.summary")}
                           hint={t("prefs.row.preset.hint")}>
                    <select className="field" value={newPhotos ?? ""} onChange={(e) => onNewPhotos(e.target.value || null)}>
                      <option value="">{t("prefs.none")}</option>
                      {[...presets].sort((a, b) => Number(b.id === DEFAULT_PRESET_ID) - Number(a.id === DEFAULT_PRESET_ID)
                                                   || a.name.localeCompare(b.name)).map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </PrefRow>
                  <PrefRow id="Also apply to JPEGs" label={t("prefs.row.presetjpeg")} summary={t("prefs.row.presetjpeg.summary")}
                           hint={t("prefs.row.presetjpeg.hint")}>
                    <PrefSwitch checked={presetNonRaw} disabled={!newPhotos}
                                onChange={(on) => { setPresetNonRaw(on); storeNewPhotosNonRaw(on); }} />
                  </PrefRow>
                  <PrefRow id="New preset" label={t("prefs.row.newpreset")} summary={t("prefs.row.newpreset.summary")} hint={t("prefs.row.newpreset.hint")}>
                    <button className="btn small" disabled={!onSaveCurrent} onClick={() => onSaveCurrent?.()}
                            title={onSaveCurrent ? undefined : t("prefs.row.newpreset.title")}>{t("prefs.row.newpreset.button")}</button>
                  </PrefRow>
                </PrefCard>
                <PrefCard title={t("prefs.card.keywords")}>
                  <PrefRow id="Keywords for edited photos" label={t("prefs.row.keywords")} summary={t("prefs.row.keywords.summary")}
                           hint={t("prefs.row.keywords.hint")}>
                    <div className="pref-keywords">
                      <KeywordChips keywords={editedKeywords}
                                    onRemove={(k) => chooseEditedKeywords(editedKeywords.filter((x) => x !== k))} />
                      <KeywordInput attached={new Set(editedKeywords)} known={knownKeywords}
                                    onAdd={addEditedKeywords} addOnBlur />
                    </div>
                  </PrefRow>
                </PrefCard>
                <PrefCard title={t("prefs.card.copyright")}>
                  <PrefRow id="Copyright" label={t("prefs.row.copyright")} summary={t("prefs.row.copyright.summary")}
                           hint={t("prefs.row.copyright.hint")}>
                    <input className="field" placeholder={t("prefs.row.copyright.placeholder")} value={editedMeta.rights}
                           onChange={(e) => chooseEditedMeta({ rights: e.target.value })} />
                  </PrefRow>
                  <PrefRow id="Creator" label={t("prefs.row.creator")} summary={t("prefs.row.creator.summary")} hint={t("prefs.row.creator.hint")}>
                    <input className="field" placeholder={t("prefs.row.creator.placeholder")} value={editedMeta.creator}
                           onChange={(e) => chooseEditedMeta({ creator: e.target.value })} />
                  </PrefRow>
                </PrefCard>
              </>
            )}
            {tab === "modules" && <ModulePrefs focusMode={focusMode} />}
            {tab === "immich" && <ImmichPrefs />}
            {tab === "plugins" && <PluginPrefs plugins={plugins} onPlugins={onPlugins} />}
            {tab === "general" && (
              <>
              <PrefCard title={t("prefs.card.editing")}>
                <PrefRow id="Editing mode" label={t("prefs.row.editmode")} summary={t("prefs.row.editmode.summary")}
                         hint={t("prefs.row.editmode.hint")}>
                  <div className="segmented small">
                    {([[t("prefs.mode.simple"), "simple"], [t("prefs.mode.advanced"), "advanced"]] as const).map(([label, v]) => (
                      <button key={v} className={editMode === v ? "active" : ""} onClick={() => onEditMode(v)}>{label}</button>
                    ))}
                  </div>
                </PrefRow>
              </PrefCard>
              <PrefCard title={t("prefs.card.workspace")}>
                <ThemePrefs />
                <PrefRow id="Language" label={t("prefs.language")} hint={t("prefs.language.hint")}>
                  <select className="field" aria-label={t("prefs.language")} value={chosenLanguage} disabled={languageBusy}
                          onChange={(e) => { storeLanguage(e.target.value); setChosenLanguage(e.target.value); }}>
                    <option value={SYSTEM}>{t("prefs.language.system")}</option>
                    {Object.entries(LOCALES).map(([code, l]) => <option key={code} value={code}>{l.name}</option>)}
                  </select>
                  {chosenLanguage !== startupLanguage && (
                    <button className="btn small" disabled={languageBusy} onClick={() => void restartForLanguage()}>
                      {t("prefs.relaunchButton")}
                    </button>
                  )}
                  {languageError && <span role="alert">{languageError}</span>}
                </PrefRow>
                <PrefRow id="Canvas" label={t("prefs.row.canvas")} summary={t("prefs.row.canvas.summary")} hint={t("prefs.row.canvas.hint")}>
                  <div className="pref-swatches">
                    {/* the viewer's backgrounds in styles.css */}
                    {([[t("prefs.color.dark"), "dark", "#121212"], [t("prefs.color.gray"), "gray", "#767676"], [t("prefs.color.white"), "white", "#fff"]] as const).map(([label, v, color]) => (
                      <button key={v} className={`swatch${canvas === v ? " on" : ""}`} title={label} aria-label={label}
                              style={{ background: color }} onClick={() => onCanvas(v)} />
                    ))}
                  </div>
                </PrefRow>
                <PrefRow id="Overlay color" label={t("prefs.row.overlaycolor")} summary={t("prefs.row.overlaycolor.summary")} hint={t("prefs.row.overlaycolor.hint")}>
                  <div className="pref-swatches">
                    {([[t("prefs.color.yellow"), "yellow"], [t("prefs.color.red"), "red"]] as const).map(([label, v]) => (
                      <button key={v} className={`swatch${overlayColor.pick === v ? " on" : ""}`} title={label} aria-label={label}
                              style={{ background: `rgb(${OVERLAY_COLORS[v].join(", ")})` }}
                              onClick={() => onOverlayColor({ ...overlayColor, pick: v })} />
                    ))}
                    <label className={`swatch custom${overlayColor.pick === "custom" ? " on" : ""}`} title={t("prefs.color.custom")}
                           style={{ "--custom": overlayColor.custom } as React.CSSProperties}>
                      <input type="color" aria-label={t("prefs.color.customLabel")} value={overlayColor.custom}
                             onClick={() => onOverlayColor({ ...overlayColor, pick: "custom" })}
                             onChange={(e) => onOverlayColor({ ...overlayColor, pick: "custom", custom: e.target.value })} />
                    </label>
                  </div>
                </PrefRow>
                <PrefRow id="Overlay opacity" label={t("prefs.row.opacity")} summary={t("prefs.row.opacity.summary", { opacity: overlayColor.opacity })} hint={t("prefs.row.opacity.hint", { opacity: overlayColor.opacity })}>
                  <input type="range" min={10} max={100} step={5} aria-label={t("prefs.row.opacity")} value={overlayColor.opacity}
                         onChange={(e) => onOverlayColor({ ...overlayColor, opacity: Number(e.target.value) })} />
                  <button className="btn small" style={{ marginLeft: 8 }} disabled={overlayColor.opacity === OVERLAY_OPACITY}
                          onClick={() => onOverlayColor({ ...overlayColor, opacity: OVERLAY_OPACITY })}>{t("prefs.reset")}</button>
                </PrefRow>
                <PrefRow id="Guide color" label={t("prefs.row.guidecolor")} summary={t("prefs.row.guidecolor.summary")} hint={t("prefs.row.guidecolor.hint")}>
                  <div className="pref-swatches">
                    {([[t("prefs.color.white"), "white"], [t("prefs.color.yellow"), "yellow"], [t("prefs.color.red"), "red"]] as const).map(([label, v]) => (
                      <button key={v} className={`swatch${guideColor.pick === v ? " on" : ""}`} title={label} aria-label={label}
                              style={{ background: `rgb(${GUIDE_COLORS[v].join(", ")})` }}
                              onClick={() => onGuideColor({ ...guideColor, pick: v })} />
                    ))}
                    <label className={`swatch custom${guideColor.pick === "custom" ? " on" : ""}`} title={t("prefs.color.custom")}
                           style={{ "--custom": guideColor.custom } as React.CSSProperties}>
                      <input type="color" aria-label={t("prefs.color.customLabel")} value={guideColor.custom}
                             onClick={() => onGuideColor({ ...guideColor, pick: "custom" })}
                             onChange={(e) => onGuideColor({ pick: "custom", custom: e.target.value })} />
                    </label>
                  </div>
                </PrefRow>
                <PrefRow id="Focus mode" label={t("prefs.row.focus")} summary={keys(t("prefs.row.focus.summary"))} hint={keys(t("prefs.row.focus.hint"))}>
                  <PrefSwitch checked={focusMode} onChange={onFocusMode} />
                </PrefRow>
                <PrefRow id="Auto-hide panels" label={t("prefs.row.autohide")} summary={t("prefs.row.autohide.summary")}
                         hint={t("prefs.row.autohide.hint")}>
                  <PrefSwitch checked={autoHide} onChange={onAutoHide} />
                </PrefRow>
                <PrefRow id="Scroll adjusts sliders" label={t("prefs.row.scroll")} summary={t("prefs.row.scroll.summary")}
                         hint={t("prefs.row.scroll.hint")}>
                  <PrefSwitch checked={sliderScroll} onChange={(on) => { setSliderScroll(on); storeSliderScroll(on); }} />
                </PrefRow>
                {sliderScroll && (
                  <PrefRow id="Scroll amount" label={t("prefs.row.scrollstep")} summary={t("prefs.row.scrollstep.summary", { percent: scrollStep * 100 })}
                           hint={t("prefs.row.scrollstep.hint", { percent: scrollStep * 100 })}>
                    <input type="range" min={0} max={SCROLL_STEPS.length - 1} step={1}
                           value={SCROLL_STEPS.indexOf(scrollStep)}
                           onChange={(e) => { const v = SCROLL_STEPS[Number(e.target.value)]; setScrollStep(v); storeSliderScrollStep(v); }} />
                  </PrefRow>
                )}
                <PrefRow id="Open generated photos" label={t("prefs.row.opengen")} summary={t("prefs.row.opengen.summary")} hint={t("prefs.row.opengen.hint")}>
                  <PrefSwitch checked={openGenerated} onChange={onOpenGenerated} />
                </PrefRow>
                <PrefRow id="Generated positive format" label={t("prefs.row.posformat")} summary={t("prefs.row.posformat.summary")}
                         hint={t("prefs.row.posformat.hint")}>
                  <select className="field" aria-label={t("prefs.row.posformat")} value={negativeExportFormat} onChange={(e) => {
                    const format = e.target.value as NegativeExportFormat;
                    setNegativeExportFormat(format); storeNegativeExportFormat(format);
                  }}>
                    <option value="dng">{t("prefs.posformat.dng")}</option>
                    <option value="tiff">{t("prefs.posformat.tiff")}</option>
                  </select>
                </PrefRow>
                <PrefRow id="Warn before converting a negative" label={t("prefs.row.negwarn")} summary={t("prefs.row.negwarn.summary")}
                         hint={t("prefs.row.negwarn.hint")}>
                  <PrefSwitch checked={negWarn} onChange={(on) => { setNegWarn(on); storeNegWarn(on); }} />
                </PrefRow>
              </PrefCard>
              <MapSearchPrefs />
              <PrefCard title={t("prefs.card.library")}>
                <PrefRow id="Stack RAW+JPEG pairs as one photo" label={t("prefs.row.stack")} summary={t("prefs.row.stack.summary")}
                         hint={t("prefs.row.stack.hint")}
                  ><PrefSwitch checked={stackPairs} onChange={onStackPairs} />
                </PrefRow>
              </PrefCard>
              <PrefCard title={t("prefs.card.startup")}>
                <PrefRow id="Quick start guide" label={t("prefs.row.tour")} hint={t("prefs.row.tour.hint")}>
                  <PrefSwitch checked={showTour} onChange={(on) => { setShowTour(on); setTourSeen(!on); }} />
                </PrefRow>
              </PrefCard>
              <PrefCard title={t("prefs.card.backup")}>
                <PrefRow id="Backup" label={t("prefs.row.backup")} summary={t("prefs.row.backup.summary")}
                         hint={t("prefs.row.backup.hint")}>
                  <button className="btn small" onClick={() => setBackup("create")}>{t("prefs.backup.create")}</button>
                  <button className="btn small" onClick={() => setBackup("restore")}>{t("prefs.backup.restore")}</button>
                </PrefRow>
              </PrefCard>
              </>
            )}
            {tab === "performance" && (
              <>
              <PrefCard title={t("prefs.card.gpu")}>
                <PrefRow id="GPU" label={t("prefs.row.gpu")} hint={accel === null ? t("prefs.row.gpu.hint.looking")
                  : accel.length ? t("prefs.row.gpu.hint.some")
                  : t("prefs.row.gpu.hint.none")}>
                  {accel && accel.length > 0 && (
                    <select className="field" value={accelChoice.provider}
                            onChange={(e) => chooseAccel({ provider: e.target.value, device: -1 })}>
                      <option value="auto">{t("prefs.gpu.auto", { name: accel[0].name })}</option>
                      {accel.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  )}
                </PrefRow>
                {accelProvider && accelProvider.devices.length > 1 && (
                  <PrefRow id="Device" label={t("prefs.row.device")} hint={t("prefs.row.device.hint")}>
                    <select className="field" value={accelChoice.device}
                            onChange={(e) => chooseAccel({ ...accelChoice, device: Number(e.target.value) })}>
                      <option value={-1}>{t("prefs.default")}</option>
                      {accelProvider.devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </PrefRow>
                )}
              </PrefCard>
              {renderer && (
                <PrefCard title={t("prefs.card.rendering")}>
                  <PrefRow id="Window renderer" label={t("prefs.row.renderer")} summary={t("prefs.row.renderer.summary", { name: rendererName(renderer.active) })
                             + (renderer.external ? ". " + t("prefs.row.renderer.summary.external") : renderer.next !== renderer.running ? ". " + t("prefs.relaunch") : "")}
                           hint={t("prefs.row.renderer.hint", { name: rendererName(renderer.active) })
                             + (renderer.external ? ". " + t("prefs.row.renderer.hint.external") : renderer.next !== renderer.running ? ". " + t("prefs.row.renderer.hint.relaunch") : "")}>
                    <div className="segmented small">
                      {([[t("prefs.renderer.auto"), "auto"], ["Mesa", "mesa"], ["NVIDIA", "nvidia"]] as const).map(([label, mode]) => (
                        <button key={mode} className={renderer.next === mode ? "active" : ""}
                                disabled={renderer.external || rendererSaving || (mode !== "auto" && !renderer[mode])}
                                onClick={() => void chooseRenderer(mode)}>{label}</button>
                      ))}
                    </div>
                    {renderer.next !== renderer.running && (
                      <button className="btn small" style={{ marginLeft: 8 }} disabled={rendererSaving}
                              onClick={() => void onRelaunch()}>{t("prefs.relaunchButton")}</button>
                    )}
                  </PrefRow>
                  {rendererError && <p role="alert">{rendererError}</p>}
                </PrefCard>
              )}
              <PrefCard title={t("prefs.card.editing")}>
                <PrefRow id="Edit on the GPU" label={t("prefs.row.gpuedit")} summary={t("prefs.row.gpuedit.summary") + (gpuEdits && gpuEdits.next !== gpuEdits.running ? " " + t("prefs.relaunch") : "")}
                         hint={t("prefs.row.gpuedit.hint") + (gpuEdits && gpuEdits.next !== gpuEdits.running ? ". " + t("prefs.row.gpuedit.hint.pending") : "")}>
                  <PrefSwitch checked={gpuEdits?.next ?? false} disabled={!gpuEdits} onChange={chooseGpuEdits} />
                  {gpuEdits && gpuEdits.next !== gpuEdits.running && (
                    <button className="btn small" style={{ marginLeft: 8 }} onClick={() => void onRelaunch()}>{t("prefs.relaunchButton")}</button>
                  )}
                </PrefRow>
                <PrefRow id="Performance profile" label={t("prefs.row.profile.perf")} summary={{ quality: t("prefs.profile.quality.summary"), balanced: t("prefs.profile.balanced.summary"), performance: t("prefs.profile.performance.summary") }[preview]}
                         hint={{
                           quality: t("prefs.profile.quality.hint"),
                           balanced: t("prefs.profile.balanced.hint"),
                           performance: t("prefs.profile.performance.hint"),
                         }[preview]}>
                  <div className="segmented small">
                    {([[t("prefs.profile.quality"), "quality"], [t("prefs.profile.balanced"), "balanced"], [t("prefs.profile.performance"), "performance"]] as const).map(([label, v]) => (
                      <button key={v} className={preview === v ? "active" : ""} onClick={() => applyProfile(v)}>{label}</button>
                    ))}
                  </div>
                  <button className="btn small" style={{ marginLeft: 8 }} disabled={!customized}
                          title={t("prefs.profile.reset", { profile: t(`prefs.profile.${preview}`) })}
                          onClick={() => applyProfile(preview)}>{t("prefs.reset")}</button>
                </PrefRow>
                <button className="module-prefs-fold" data-pref-fold="performance-advanced" aria-expanded={advancedOpen} aria-controls="perf-advanced"
                        onClick={() => setAdvancedOpen(!advancedOpen)}>
                  {t("prefs.advanced")}{customized ? ` ${t("prefs.customized")}` : ""} <Chevron open={advancedOpen} />
                </button>
                <Collapse open={advancedOpen}>
                  <div id="perf-advanced">
                <PrefRow id="Preview size while dragging" label={t("prefs.row.dragsize")} summary={t("prefs.row.dragsize.summary")}
                         hint={t("prefs.row.dragsize.hint")}>
                  <div className="segmented small">
                    {BALANCED_PREVIEW_SIZES.map((v) => (
                      <button key={v} className={balancedSize === v ? "active" : ""}
                              onClick={() => { setBalancedSize(v); storeBalancedPreviewSize(v); }}>{v * 100}%</button>
                    ))}
                  </div>
                </PrefRow>
                <PrefRow id="Smaller drafts for slow sliders" label={t("prefs.row.drafts")} summary={t("prefs.row.drafts.summary")}
                         hint={t("prefs.row.drafts.hint")}>
                  <div className="segmented small">
                    {DRAFT_SMALLEST.map((v) => (
                      <button key={v} className={draftSmallest === v ? "active" : ""} disabled={balancedSize === 1}
                              onClick={() => { setDraftSmallest(v); storeDraftSmallest(v); }}>
                        {v === 1 ? t("prefs.off") : `${v * 100}%`}
                      </button>
                    ))}
                  </div>
                </PrefRow>
                <PrefRow id="Draft time" label={t("prefs.row.drafttime")} summary={t("prefs.row.drafttime.summary")}
                         hint={t("prefs.row.drafttime.hint")}>
                  <div className="segmented small">
                    {DRAFT_TARGETS.map((ms) => (
                      <button key={ms} className={draftTarget === ms ? "active" : ""} disabled={draftSmallest === 1 || balancedSize === 1}
                              onClick={() => { setDraftTarget(ms); storeDraftTarget(ms); }}>{ms} ms</button>
                    ))}
                  </div>
                </PrefRow>
                <PrefRow id="Detail loupe" label={t("prefs.row.loupe")} summary={t("prefs.row.loupe.summary")} hint={t("prefs.row.loupe.hint")}>
                  <PrefSwitch checked={loupe} onChange={onLoupe} />
                </PrefRow>
                {sharedFramesAvailable && (
                  <PrefRow id="Shared-memory frames" label={t("prefs.row.shared")} summary={t("prefs.row.shared.summary")}
                           hint={t("prefs.row.shared.hint")}>
                    <PrefSwitch checked={sharedFrames} onChange={(on) => { setSharedFrames(on); storeSharedFrames(on); }} />
                  </PrefRow>
                )}
                {screenScale() !== null && (
                  <PrefRow id="Drag drafts at the screen's scale" label={t("prefs.row.screenscale")} summary={t("prefs.row.screenscale.summary")}
                           hint={t("prefs.row.screenscale.hint", { screen: Math.round(screenScale()! * 100), window: Math.round((window.devicePixelRatio || 1) * 100) })}>
                    <PrefSwitch checked={atScreenScale} onChange={(on) => { setAtScreenScale(on); storeScreenScale(on); }} />
                  </PrefRow>
                )}
                {screenScale() !== null && (
                  <PrefRow id="Fit frames at the screen's scale" label={t("prefs.row.fitscale")} summary={t("prefs.row.fitscale.summary")}
                           hint={t("prefs.row.fitscale.hint")}>
                    <PrefSwitch checked={settledAtScreen} onChange={(on) => { setSettledAtScreen(on); storeSettledScale(on); }} />
                  </PrefRow>
                )}
                <PrefRow id="Read ahead" label={t("prefs.row.readahead")} summary={t("prefs.row.readahead.summary")}
                         hint={t("prefs.row.readahead.hint")}>
                  <div className="segmented small">
                    {Array.from({ length: READ_AHEAD_MAX + 1 }, (_, n) => (
                      <button key={n} className={readAhead.count === n ? "active" : ""}
                              onClick={() => chooseReadAhead({ count: n })}>{n ? String(n) : t("prefs.off")}</button>
                    ))}
                  </div>
                </PrefRow>
                {readAhead.count > 0 && (
                  <PrefRow id="Read ahead both ways" label={t("prefs.row.readaheadboth")} summary={t("prefs.row.readaheadboth.summary")} hint={t("prefs.row.readaheadboth.hint")}>
                    <PrefSwitch checked={readAhead.both} onChange={(on) => chooseReadAhead({ both: on })} />
                  </PrefRow>
                )}
                  </div>
                </Collapse>
              </PrefCard>
              <PrefCard title={t("prefs.card.memory")}>
                <PrefRow id="Memory" label={t("prefs.row.memory")} summary={`${{ small: t("prefs.row.memory.summary.small"), default: t("prefs.row.memory.summary.default"), large: t("prefs.row.memory.summary.large") }[resources?.next ?? "default"]}${budget ? " " + t("prefs.row.memory.summary.budget", { views: gb(budget.frameCacheMb), thumbs: gb(budget.thumbMemoryMb) }) : ""}${resources && resources.next !== resources.running ? " " + t("prefs.relaunch") : ""}`}
                         hint={t("prefs.row.memory.hint", { level: {
                           small: t("prefs.row.memory.hint.small"),
                           default: t("prefs.row.memory.hint.default"),
                           large: t("prefs.row.memory.hint.large"),
                         }[resources?.next ?? "default"] ?? "" })}>
                  <div className="segmented small">
                    {([[t("prefs.memory.small"), "small"], [t("prefs.default"), "default"], [t("prefs.memory.large"), "large"]] as const).map(([label, v]) => (
                      <button key={v} className={resources?.next === v ? "active" : ""} disabled={!resources}
                              onClick={() => chooseResources(v)}>{label}</button>
                    ))}
                  </div>
                  {resources && resources.next !== resources.running && (
                    <button className="btn small" style={{ marginLeft: 8 }} onClick={() => void onRelaunch()}>{t("prefs.relaunchButton")}</button>
                  )}
                </PrefRow>
                <PrefRow id="Library workers" label={t("prefs.row.workers")} summary={t("prefs.row.workers.summary")}
                         hint={t("prefs.row.workers.hint")}>
                  <div className="segmented small">
                    {THUMB_THREADS.map((n) => (
                      <button key={n} className={thumbThreads === n ? "active" : ""}
                              onClick={() => { setThumbThreads(n); storeThumbThreads(n); }}>{String(n)}</button>
                    ))}
                  </div>
                </PrefRow>
              </PrefCard>
              <CachePrefs />
              <PrefCard title={t("prefs.card.measuring")}>
                <PrefRow id="Performance overlay" label={t("prefs.row.perfhud")} summary={t("prefs.row.perfhud.summary")}
                         hint={t("prefs.row.perfhud.hint")}>
                  <PrefSwitch checked={perfHud} onChange={onPerfHud} />
                </PrefRow>
                <PrefRow id="GUI benchmark" label={t("prefs.row.bench")} summary={onBenchmark ? t("prefs.row.bench.summary") : t("prefs.openPhoto")}
                         hint={onBenchmark
                           ? t("prefs.row.bench.hint")
                           : t("prefs.openPhoto.hint")}>
                  <button className="btn" disabled={!onBenchmark} onClick={() => onBenchmark?.()}>{t("prefs.run")}</button>
                </PrefRow>
                <PrefRow id="GPU check" label={t("prefs.row.gpucheck")} summary={onGpuCheck ? t("prefs.row.gpucheck.summary") : t("prefs.openPhoto")}
                         hint={onGpuCheck
                           ? t("prefs.row.gpucheck.hint")
                           : t("prefs.openPhoto.hint")}>
                  <button className="btn" disabled={!onGpuCheck} onClick={() => onGpuCheck?.()}>{t("prefs.run")}</button>
                </PrefRow>
                <PrefRow id="Performance tuner" label={t("prefs.row.tuner")} summary={t("prefs.row.tuner.summary")}
                         hint={t("prefs.row.tuner.hint")}>
                  <button className="btn" disabled={!onTune} onClick={() => onTune?.()}>{t("prefs.tune")}</button>
                </PrefRow>
              </PrefCard>
              </>
            )}
            {tab === "about" && (
              <>
                <PrefCard title="Immage">
                  <div className="prefs-legal">
                    <p>Immage {about?.app ?? ""}{about?.commit ? ` (commit ${about.commit})` : ""}, Copyright © 2026 the Immage authors</p>
                    <p>
                      Its raw processing engine is darktable{about ? ` ${about.darktable.split("~")[0]}` : ""},
                      Copyright © 2009–2026 darktable developers.
                    </p>
                    <p>
                      Immage is free software: you can redistribute it and/or modify it under the terms of the GNU
                      General Public License as published by the Free Software Foundation, either version 3 of the
                      License, or (at your option) any later version.
                    </p>
                    <p>
                      Immage is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
                      even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
                      General Public License for more details.
                    </p>
                  </div>
                </PrefCard>
                <PrefCard title={t("prefs.card.maps")}>
                  <div className="prefs-legal">
                    <p>Map data © OpenStreetMap contributors, available under the Open Database License (ODbL).
                      Map tiles provided by the OpenStreetMap Foundation.</p>
                    <p>Interactive maps use Leaflet, Copyright © 2010–2023 Volodymyr Agafonkin
                      and © 2010–2011 CloudMade, under the BSD 2-Clause license.</p>
                    <button className="btn" onClick={() => void openUrl("https://www.openstreetmap.org/copyright")}>{t("prefs.about.osm")}</button>{" "}
                    <button className="btn" onClick={() => void openUrl("https://github.com/Leaflet/Leaflet/blob/main/LICENSE")}>{t("prefs.about.leaflet")}</button>
                  </div>
                </PrefCard>
                <PrefCard title={t("prefs.card.updates")}>
                  <PrefRow id="Check automatically" label={t("prefs.row.autoupdate")} summary={t("prefs.row.autoupdate.summary")} hint={t("prefs.row.autoupdate.hint")}>
                    <PrefSwitch checked={autoUpdate} onChange={(on) => { setAutoUpdate(on); storeAutoCheck(on); }} />
                  </PrefRow>
                  <PrefRow id="Check for updates" label={t("prefs.row.checkupdate")} hint={updateHint(update, about?.app)}>
                    <button className="btn" disabled={update.kind === "checking" || update.kind === "downloading" || update.kind === "installing"}
                            onClick={() => void checkForUpdate(true)}>{t("prefs.about.checknow")}</button>
                  </PrefRow>
                </PrefCard>
                <PrefCard title={t("prefs.card.license")}>
                  <PrefRow id="License" label={t("prefs.row.gpl")} summary={t("prefs.row.gpl.summary")} hint={t("prefs.row.gpl.hint")}>
                    <button className="btn" disabled={!licenses?.gpl}
                            onClick={() => licenses?.gpl && setViewing({ title: "GNU General Public License", text: licenses.gpl })}
                    >{t("prefs.about.view")}</button>
                  </PrefRow>
                  <PrefRow id="Source code" label={t("prefs.row.source")} hint={sourceUrl(about?.app)}>
                    <button className="btn" onClick={() => void openUrl(sourceUrl(about?.app))}>{t("prefs.about.open")}</button>
                  </PrefRow>
                  <PrefRow id="darktable source" label={t("prefs.row.dtsource")} hint={darktableUrl(about?.darktable)}>
                    <button className="btn" onClick={() => void openUrl(darktableUrl(about?.darktable))}>{t("prefs.about.open")}</button>
                  </PrefRow>
                  <PrefRow id="Bundled libraries" label={t("prefs.row.libs")} summary={licenses?.libraries ? t("prefs.row.libs.summary") : t("prefs.row.libs.summary.none")}
                           hint={licenses?.libraries ? t("prefs.row.libs.hint")
                             : t("prefs.row.libs.hint.none")}>
                    <div className="segmented small">
                      <button disabled={!licenses?.libraries}
                              onClick={() => licenses?.libraries && setViewing({ title: t("prefs.about.libs.title"), text: licenses.libraries })}
                      >{t("prefs.about.view")}</button>
                      <button disabled={!licenses?.librariesPath}
                              onClick={() => licenses?.librariesPath && void revealItemInDir(licenses.librariesPath)}
                      >{t("prefs.about.licensetexts")}</button>
                    </div>
                  </PrefRow>
                  <PrefRow id="App components" label={t("prefs.row.components")} summary={licenses?.notices ? t("prefs.row.components.summary") : t("prefs.row.components.summary.none")}
                           hint={licenses?.notices ? t("prefs.row.components.hint")
                             : t("prefs.row.components.hint.none")}>
                    <button className="btn" disabled={!licenses?.notices}
                            onClick={() => licenses?.notices && setViewing({ title: t("prefs.about.components.title"), text: licenses.notices })}
                    >{t("prefs.about.view")}</button>
                  </PrefRow>
                </PrefCard>
              </>
            )}
          </div>
          <div className="prefs-foot">
            <span className="prefs-note">{t("prefs.note")}</span>
            <button className="btn primary" onClick={onClose}>{t("prefs.done")}</button>
          </div>
        </div>
      </div>
      {backup && <BackupDialog mode={backup} onClose={() => setBackup(null)} />}
      {viewing && <LicenseText title={viewing.title} text={viewing.text} onClose={() => setViewing(null)} />}
    </div>
  );
}
