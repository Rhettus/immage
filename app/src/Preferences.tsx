// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the app's preferences, behind the rail's gear (⌘,): settings that belong
// to the app rather than to any photo, a tab per subject
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { keys } from "./keys";
import { AGX_PROFILE_DEFAULT, PROFILE_GROUPS, PROFILE_OPTIONS } from "./manifest";
import { CachePrefs } from "./CachePrefs";
import { ImmichPrefs } from "./ImmichPrefs";
import { ModulePrefs } from "./ModulePrefs";
import { KeywordChips, KeywordInput, parseKeyword } from "./Keywording";
import { PluginPrefs } from "./PluginPrefs";
import type { PluginConfig } from "./plugins";
import { PrefCard, PrefRow, PrefSwitch } from "./PrefsUI";
import { DEFAULT_PRESET_ID, type Preset } from "./Presets";
import { setTourSeen, tourSeen } from "./Tour";
import { OVERLAY_COLORS, type Rgb } from "./masks";
import { loadSharedFrames, sharedFramesAvailable, storeSharedFrames } from "./sharedFrames";
import { loadScreenScale, screenScale, storeScreenScale } from "./pixelRatio";
import { checkForUpdate, lastChecked, loadAutoCheck, storeAutoCheck, useUpdate, type UpdateState } from "./updates";

// the profile a new raw gets (manifest.ts, PROFILE_GROUPS): AgX's default unless set
const PROFILE_KEY = "immage.newPhotosProfile";
export function loadNewPhotosProfile(): number {
  try {
    const v = Number(localStorage.getItem(PROFILE_KEY) ?? AGX_PROFILE_DEFAULT);
    return PROFILE_OPTIONS.some(([, x]) => x === v) ? v : AGX_PROFILE_DEFAULT;
  } catch { return AGX_PROFILE_DEFAULT; }
}
function storeNewPhotosProfile(v: number) {
  try { localStorage.setItem(PROFILE_KEY, String(v)); } catch { /* not kept */ }
}

// EV a new raw's exposure gets on an instance of its own (manifest.ts,
// exp_comp), so Exposure still starts at 0; off unless set. the amount is
// kept apart from the switch, so switching it off and on keeps it
const EXP_COMP_KEY = "immage.exposureCompNew";
const EXP_COMP_EV_KEY = "immage.exposureCompNewEv";
export const EXP_COMP_LIMIT = 3;
function loadExposureCompEv(): number {
  try {
    const v = Number(localStorage.getItem(EXP_COMP_EV_KEY) ?? 1);
    return Number.isFinite(v) ? Math.max(-EXP_COMP_LIMIT, Math.min(EXP_COMP_LIMIT, v)) : 1;
  } catch { return 1; }
}
function loadExposureCompOn(): boolean {
  try { return localStorage.getItem(EXP_COMP_KEY) === "1"; } catch { return false; }
}
// the EV a new raw gets, 0 when off
export function loadExposureCompNew(): number {
  return loadExposureCompOn() ? loadExposureCompEv() : 0;
}
function storeExposureComp(on: boolean, ev: number) {
  try {
    localStorage.setItem(EXP_COMP_KEY, on ? "1" : "0");
    localStorage.setItem(EXP_COMP_EV_KEY, String(ev));
  } catch { /* not kept */ }
}

// Basic's Auto on a new raw, as Lightroom's "apply auto tone"; off unless set
const AUTO_TONE_KEY = "immage.autoToneNew";
export function loadAutoToneNew(): boolean {
  try { return localStorage.getItem(AUTO_TONE_KEY) === "1"; } catch { return false; }
}
function storeAutoToneNew(on: boolean) {
  try { localStorage.setItem(AUTO_TONE_KEY, on ? "1" : "0"); } catch { /* not kept */ }
}

// the warning on opening the Negative panel, which says what converting
// turns off; its own "don't warn me again" box sets the same thing
const NEG_WARN_KEY = "immage.negWarn";
export function loadNegWarn(): boolean {
  try { return localStorage.getItem(NEG_WARN_KEY) !== "0"; } catch { return true; }
}
export function storeNegWarn(on: boolean) {
  try { localStorage.setItem(NEG_WARN_KEY, on ? "1" : "0"); } catch { /* not kept */ }
}

// keywords a photo gets once Immage saves it as edited, and loses when it is
// unedited again, so Immich, which reads them from the sidecar, can filter
// on them; none unless set
const EDITED_KEYWORDS_KEY = "immage.editedKeywords";
export function loadEditedKeywords(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(EDITED_KEYWORDS_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((k) => typeof k === "string" && k) : [];
  } catch { return []; }
}
function storeEditedKeywords(v: string[]) {
  try { localStorage.setItem(EDITED_KEYWORDS_KEY, JSON.stringify(v)); } catch { /* not kept */ }
}

// the copyright and creator a photo gets once Immage saves it as edited,
// where it has none of its own; {year} is the year it was taken
const EDITED_META_KEY = "immage.editedMeta";
export type EditedMeta = { rights: string; creator: string };
export function loadEditedMeta(): EditedMeta {
  try {
    const v = JSON.parse(localStorage.getItem(EDITED_META_KEY) ?? "null");
    return { rights: typeof v?.rights === "string" ? v.rights : "",
             creator: typeof v?.creator === "string" ? v.creator : "" };
  } catch { return { rights: "", creator: "" }; }
}
function storeEditedMeta(v: EditedMeta) {
  try { localStorage.setItem(EDITED_META_KEY, JSON.stringify(v)); } catch { /* not kept */ }
}

// the workspace: the viewer's canvas, and Lightroom's solo mode, where
// opening a panel closes the others
export type Canvas = "dark" | "gray" | "white";
// in the order L steps through them
export const CANVASES: readonly Canvas[] = ["dark", "gray", "white"];
const CANVAS_KEY = "immage.canvas";
const FOCUS_MODE_KEY = "immage.focusMode";
export function loadCanvas(): Canvas {
  try {
    const v = localStorage.getItem(CANVAS_KEY);
    return CANVASES.find((c) => c === v) ?? "dark";
  } catch { return "dark"; }
}
export function storeCanvas(v: Canvas) {
  try { localStorage.setItem(CANVAS_KEY, v); } catch { /* not kept */ }
}
// the masks' overlay on the photo: one of OVERLAY_COLORS or the custom
// color, which is kept while a preset is chosen; darktable's yellow unless set
export type OverlayColor = { pick: keyof typeof OVERLAY_COLORS | "custom"; custom: string };
const OVERLAY_COLOR_KEY = "immage.overlayColor";
export function loadOverlayColor(): OverlayColor {
  try {
    const v = JSON.parse(localStorage.getItem(OVERLAY_COLOR_KEY) ?? "null");
    return { pick: v?.pick === "red" || v?.pick === "custom" ? v.pick : "yellow",
             custom: /^#[0-9a-f]{6}$/i.test(v?.custom) ? v.custom : "#33ccff" };
  } catch { return { pick: "yellow", custom: "#33ccff" }; }
}
export function storeOverlayColor(v: OverlayColor) {
  try { localStorage.setItem(OVERLAY_COLOR_KEY, JSON.stringify(v)); } catch { /* not kept */ }
}
export function maskOverlayRgb(v: OverlayColor): Rgb {
  if (v.pick !== "custom") return OVERLAY_COLORS[v.pick];
  const n = parseInt(v.custom.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
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
    const v = JSON.parse(localStorage.getItem(GUIDE_COLOR_KEY) ?? "null");
    return { pick: v?.pick in GUIDE_COLORS || v?.pick === "custom" ? v.pick : "white",
             custom: /^#[0-9a-f]{6}$/i.test(v?.custom) ? v.custom : "#33ccff" };
  } catch { return { pick: "white", custom: "#33ccff" }; }
}
export function storeGuideColor(v: GuideColor) {
  try { localStorage.setItem(GUIDE_COLOR_KEY, JSON.stringify(v)); } catch { /* not kept */ }
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
  try { return localStorage.getItem(SLIDER_SCROLL_KEY) === "1"; } catch { return false; }
}
function storeSliderScroll(on: boolean) {
  try { localStorage.setItem(SLIDER_SCROLL_KEY, on ? "1" : "0"); } catch { /* not kept */ }
}
// how far a wheel click moves a slider, as a share of its range; 1% unless set
const SLIDER_SCROLL_STEP_KEY = "immage.sliderScrollStep";
const SCROLL_STEPS = [0.0025, 0.005, 0.01, 0.02, 0.04];
export function loadSliderScrollStep(): number {
  try {
    const v = Number(localStorage.getItem(SLIDER_SCROLL_STEP_KEY));
    return SCROLL_STEPS.includes(v) ? v : 0.01;
  } catch { return 0.01; }
}
function storeSliderScrollStep(v: number) {
  try { localStorage.setItem(SLIDER_SCROLL_STEP_KEY, String(v)); } catch { /* not kept */ }
}

// how much the photo gives up while it is being edited, for speed. Quality
// renders every frame in full; Balanced defaults to half size and leaves Grain
// and diffuse (Texture, Sharpening) out of drag frames and the idle base;
// Performance drags at quarter size, also without denoise and HSL, and its
// base is only the viewer's size. export is never affected
export type Preview = "quality" | "balanced" | "performance";
const PREVIEW_KEY = "immage.preview";
// before Preview, a switch for drag drafts: off is Quality's behavior
const DRAG_DRAFTS_KEY = "immage.dragDrafts";
export function loadPreview(): Preview {
  try {
    const v = localStorage.getItem(PREVIEW_KEY);
    if (v === "quality" || v === "balanced" || v === "performance") return v;
    return localStorage.getItem(DRAG_DRAFTS_KEY) === "0" ? "quality" : "balanced";
  } catch { return "balanced"; }
}
export function storePreview(v: Preview) {
  try { localStorage.setItem(PREVIEW_KEY, v); } catch { /* not kept */ }
}

const CACHED_DETAIL_KEY = "immage.cachedDetailPreview";
export function loadCachedDetailPreview(): boolean {
  try { return localStorage.getItem(CACHED_DETAIL_KEY) === "1"; }
  catch { return false; }
}
export function storeCachedDetailPreview(on: boolean) {
  try { localStorage.setItem(CACHED_DETAIL_KEY, on ? "1" : "0"); } catch { /* not kept */ }
}

export const BALANCED_PREVIEW_SIZES: readonly number[] = [0.5, 0.75, 1];
const BALANCED_SIZE_KEY = "immage.balancedPreviewSize";
export function loadBalancedPreviewSize(): number {
  try { const size = Number(localStorage.getItem(BALANCED_SIZE_KEY));
    return BALANCED_PREVIEW_SIZES.includes(size) ? size : 0.5; }
  catch { return 0.5; }
}
export function storeBalancedPreviewSize(v: number) {
  try { localStorage.setItem(BALANCED_SIZE_KEY, String(v)); } catch { /* not kept */ }
}

// how long darktable may take on a drag's draft before the next is smaller,
// and how small it may get each way (Session.draftView): 60 ms and 70% unless set
export const DRAFT_TARGETS = [40, 60, 80, 120] as const;
export const DRAFT_SMALLEST = [1, 0.7, 0.5] as const;
const DRAFT_TARGET_KEY = "immage.draftTarget";
const DRAFT_SMALLEST_KEY = "immage.draftSmallest";
export function loadDraftTarget(): number {
  try {
    const v = Number(localStorage.getItem(DRAFT_TARGET_KEY));
    return (DRAFT_TARGETS as readonly number[]).includes(v) ? v : 60;
  } catch { return 60; }
}
export function storeDraftTarget(v: number) {
  try { localStorage.setItem(DRAFT_TARGET_KEY, String(v)); } catch { /* not kept */ }
}
export function loadDraftSmallest(): number {
  try {
    const v = Number(localStorage.getItem(DRAFT_SMALLEST_KEY));
    return (DRAFT_SMALLEST as readonly number[]).includes(v) ? v : 0.7;
  } catch { return 0.7; }
}
export function storeDraftSmallest(v: number) {
  try { localStorage.setItem(DRAFT_SMALLEST_KEY, String(v)); } catch { /* not kept */ }
}

// memory for the full frames the viewer keeps (Session.frames), so zooming
// back out or returning to a view seen before needs no render. a 100% frame
// is the viewer's size: some 30 MB on a 4K screen, 45 on a 5K, against 10
// on a 2K, so the smallest fits only a few on a large screen
export const FRAME_CACHE_MB = [256, 512, 1024, 2048] as const;
const FRAME_CACHE_KEY = "immage.frameCache";
function defaultFrameCacheMb(): number {
  const dpr = window.devicePixelRatio || 1;
  return screen.width * dpr * screen.height * dpr >= 3840 * 2160 ? 512 : 256;
}
export function loadFrameCacheMb(): number {
  try {
    const v = Number(localStorage.getItem(FRAME_CACHE_KEY));
    return (FRAME_CACHE_MB as readonly number[]).includes(v) ? v : defaultFrameCacheMb();
  } catch { return defaultFrameCacheMb(); }
}
export function storeFrameCacheMb(v: number) {
  try { localStorage.setItem(FRAME_CACHE_KEY, String(v)); } catch { /* not kept */ }
}

// memory for the library's thumbnails (library.ts, ThumbLoader); past it,
// those off screen longest go, and come back from the disk cache. one is
// about 600 x 450, 1 MB, so 1 GB holds some 900
export const THUMB_MEMORY_MB = [256, 512, 1024, 2048, 4096] as const;
const THUMB_MEMORY_KEY = "immage.thumbMemory";
export function loadThumbMemoryMb(): number {
  try {
    const v = Number(localStorage.getItem(THUMB_MEMORY_KEY));
    return (THUMB_MEMORY_MB as readonly number[]).includes(v) ? v : 1024;
  } catch { return 1024; }
}
function storeThumbMemoryMb(v: number) {
  try { localStorage.setItem(THUMB_MEMORY_KEY, String(v)); } catch { /* not kept */ }
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
    const v = JSON.parse(localStorage.getItem(READ_AHEAD_KEY) ?? "null");
    const count = Number(v?.count ?? 1);
    return { count: Number.isInteger(count) && count >= 0 && count <= READ_AHEAD_MAX ? count : 1, both: !!v?.both };
  } catch { return { count: 1, both: false }; }
}
export function storeReadAhead(v: ReadAhead) {
  try { localStorage.setItem(READ_AHEAD_KEY, JSON.stringify(v)); } catch { /* not kept */ }
}

// darktable's resource level, kept by the Rust side for the engine's next
// start (engine.rs, resource_level)
type Resources = "small" | "default" | "large";
type RendererMode = "auto" | "mesa" | "nvidia";
type WebviewRenderer = { running: RendererMode; next: RendererMode; active: string;
  external: boolean; mesa: boolean; nvidia: boolean };

// a RAW+JPEG pair as one photo in the filmstrip, rated, rejected and
// deleted together; off, each file stands alone
const STACK_PAIRS_KEY = "immage.stackPairs";
export function loadStackPairs(): boolean {
  try { return localStorage.getItem(STACK_PAIRS_KEY) === "1"; } catch { return false; }
}
export function storeStackPairs(on: boolean) {
  try { localStorage.setItem(STACK_PAIRS_KEY, on ? "1" : "0"); } catch { /* not kept */ }
}

// Lightroom's Auto Hide & Show for the side panels, and which are pinned
// open; both remembered
const AUTO_HIDE_KEY = "immage.autoHide";
const PINS_KEY = "immage.pins";
export type Pins = { left: boolean; right: boolean; strip: boolean };
export function loadAutoHide(): boolean {
  try { return localStorage.getItem(AUTO_HIDE_KEY) === "1"; } catch { return false; }
}
export function storeAutoHide(on: boolean) {
  try { localStorage.setItem(AUTO_HIDE_KEY, on ? "1" : "0"); } catch { /* not kept */ }
}
export function loadPins(): Pins {
  try {
    const v = JSON.parse(localStorage.getItem(PINS_KEY) ?? "null");
    return { left: !!v?.left, right: !!v?.right, strip: !!v?.strip };
  } catch { return { left: false, right: false, strip: false }; }
}
export function storePins(p: Pins) {
  try { localStorage.setItem(PINS_KEY, JSON.stringify(p)); } catch { /* not kept */ }
}

// on unless turned off
export function loadFocusMode(): boolean {
  try { return localStorage.getItem(FOCUS_MODE_KEY) !== "0"; } catch { return true; }
}
export function storeFocusMode(on: boolean) {
  try { localStorage.setItem(FOCUS_MODE_KEY, on ? "1" : "0"); } catch { /* not kept */ }
}

// AI acceleration: the GPU provider and device AI upscaling runs on, as
// darktable's own setting; the engine lists what this computer has
export type AccelProvider = { id: string; name: string; devices: { id: number; name: string }[] };
export type AccelChoice = { provider: string; device: number };
const ACCEL_KEY = "immage.aiAccel";
export function loadAccel(): AccelChoice {
  try {
    const v = JSON.parse(localStorage.getItem(ACCEL_KEY) ?? "null");
    if (v && typeof v.provider === "string") return { provider: v.provider, device: Number(v.device ?? -1) };
  } catch { /* the default */ }
  return { provider: "auto", device: -1 };
}
export function storeAccel(v: AccelChoice) {
  try { localStorage.setItem(ACCEL_KEY, JSON.stringify(v)); } catch { /* not kept */ }
}

export type PrefsTab = "photos" | "modules" | "immich" | "plugins" | "general" | "performance" | "about";
type Tab = PrefsTab;

const svg = (body: React.ReactNode) => (
  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
       strokeLinecap="round" strokeLinejoin="round">{body}</svg>
);
const TABS: [Tab, string, React.ReactNode][] = [
  ["general", "General", svg(<><circle cx="12" cy="12" r="3" /><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" /></>)],
  ["performance", "Performance", svg(<><path d="M4.2 17.5a8.5 8.5 0 1 1 15.6 0" /><path d="m12 13 3.5-4.5" /><circle cx="12" cy="13" r="1.3" /></>)],
  ["photos", "New Photos", svg(<><rect x="3.5" y="5" width="17" height="14" rx="2.5" /><circle cx="9" cy="10" r="1.6" />
    <path d="m4 17 5-4.5 3.5 3 2.5-2 4.5 3.5" /></>)],
  ["modules", "Modules", svg(<><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><path d="M17 13.5v7M13.5 17h7" /></>)],
  ["immich", "Immich", svg(<><path d="M7 17.5a4.5 4.5 0 0 1-.6-8.96 6 6 0 0 1 11.5 1.46A3.75 3.75 0 0 1 17.25 17.5z" />
    <path d="M12 10.5v5M9.8 12.7 12 10.5l2.2 2.2" /></>)],
  ["plugins", "Plugins", svg(<path d="M9.5 4.5a2 2 0 0 1 4 0V6H17a1 1 0 0 1 1 1v3.5h-1.5a2 2 0 0 0 0 4H18V18a1 1 0 0 1-1 1h-3.5v-1.5a2 2 0 0 0-4 0V19H6a1 1 0 0 1-1-1v-3.5h1.5a2 2 0 0 0 0-4H5V7a1 1 0 0 1 1-1h3.5z" />)],
  ["about", "About", svg(<><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5M12 7.6v.2" /></>)],
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
// what the last check found, for About's row
function updateHint(state: UpdateState, app?: string): string {
  switch (state.kind) {
    case "checking": return "checking…";
    case "current": return `Immage ${app ?? ""} is the newest version`;
    case "available": case "downloading": case "installing": return `Immage ${state.update.version} is available`;
    case "failed": return state.update ? `Immage ${state.update.version} is available` : `the check failed: ${state.message}`;
    default: {
      const last = lastChecked();
      return last ? `last checked ${new Date(last).toLocaleString()}` : "not checked yet";
    }
  }
}
type Licenses = { gpl: string | null; libraries: string | null; librariesPath: string | null; notices: string | null };

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
        <div className="modal-foot"><button className="btn primary" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}

export function PreferencesDialog({ presets, newPhotos, onNewPhotos, onSaveCurrent, focus, canvas, onCanvas, overlayColor, onOverlayColor, guideColor, onGuideColor,
                                    focusMode, onFocusMode, autoHide, onAutoHide, stackPairs, onStackPairs,
                                    accel, plugins, onPlugins, perfHud, onPerfHud, onBenchmark, onTune, onRelaunch, onClose }: {
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
  focusMode: boolean;
  onFocusMode: (on: boolean) => void;
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
  onRelaunch: () => Promise<void>;       // the edit saved, then Immage started again
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>(focus ?? "general");
  // the guide's own "don't show" box sets the same thing
  const [showTour, setShowTour] = useState(() => !tourSeen());
  const [profile, setProfile] = useState(loadNewPhotosProfile);
  const [autoToneNew, setAutoToneNew] = useState(loadAutoToneNew);
  const [negWarn, setNegWarn] = useState(loadNegWarn);
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
  useEffect(() => { invoke<string[]>("keywords").then(setKnownKeywords).catch(() => {}); }, []);
  const [sliderScroll, setSliderScroll] = useState(loadSliderScroll);
  const [scrollStep, setScrollStep] = useState(loadSliderScrollStep);
  const [preview, setPreview] = useState(loadPreview);
  const [cachedDetail, setCachedDetail] = useState(loadCachedDetailPreview);
  const [balancedSize, setBalancedSize] = useState(loadBalancedPreviewSize);
  const [sharedFrames, setSharedFrames] = useState(loadSharedFrames);
  const [atScreenScale, setAtScreenScale] = useState(loadScreenScale);
  const [draftTarget, setDraftTarget] = useState(loadDraftTarget);
  const [draftSmallest, setDraftSmallest] = useState(loadDraftSmallest);
  const [frameCache, setFrameCache] = useState(loadFrameCacheMb);
  const [thumbMemory, setThumbMemory] = useState(loadThumbMemoryMb);
  const [readAhead, setReadAhead] = useState(loadReadAhead);
  const chooseReadAhead = (v: Partial<ReadAhead>) => {
    const next = { ...readAhead, ...v };
    setReadAhead(next);
    storeReadAhead(next);
  };
  const [resources, setResources] = useState<{ running: Resources; next: Resources } | null>(null);
  useEffect(() => { invoke<{ running: Resources; next: Resources }>("darktable_resources").then(setResources).catch(() => {}); }, []);
  const chooseResources = (level: Resources) => {
    if (!resources) return;
    invoke("darktable_resources_set", { level }).then(() => setResources({ ...resources, next: level })).catch(() => {});
  };
  const [gpuEdits, setGpuEdits] = useState<{ running: boolean; next: boolean } | null>(null);
  useEffect(() => { invoke<{ running: boolean; next: boolean }>("gpu_edits").then(setGpuEdits).catch(() => {}); }, []);
  const chooseGpuEdits = (on: boolean) => {
    if (!gpuEdits) return;
    invoke("gpu_edits_set", { on }).then(() => setGpuEdits({ ...gpuEdits, next: on })).catch(() => {});
  };
  const [renderer, setRenderer] = useState<WebviewRenderer | null>(null);
  const [rendererError, setRendererError] = useState("");
  const [rendererSaving, setRendererSaving] = useState(false);
  useEffect(() => { invoke<WebviewRenderer | null>("webview_renderer").then(setRenderer).catch(() => {}); }, []);
  const chooseRenderer = async (mode: RendererMode) => {
    if (!renderer) return;
    setRendererSaving(true);
    setRendererError("");
    try {
      await invoke("webview_renderer_set", { mode });
      setRenderer({ ...renderer, next: mode });
    } catch (e) { setRendererError(String(e)); }
    finally { setRendererSaving(false); }
  };
  const [accelChoice, setAccelChoice] = useState(loadAccel);
  const chooseAccel = (v: AccelChoice) => { setAccelChoice(v); storeAccel(v); };
  // the provider the choice comes to: the one chosen if this computer has
  // it, else the first, as the engine resolves "auto"
  const accelProvider = accel?.find((p) => p.id === accelChoice.provider) ?? accel?.[0];
  const [about, setAbout] = useState<{ app: string; darktable: string } | null>(null);
  const update = useUpdate();
  const [autoUpdate, setAutoUpdate] = useState(loadAutoCheck);
  useEffect(() => { invoke<{ app: string; darktable: string }>("about").then(setAbout).catch(() => {}); }, []);
  const [licenses, setLicenses] = useState<Licenses | null>(null);
  useEffect(() => { invoke<Licenses>("licenses").then(setLicenses).catch(() => {}); }, []);
  const [viewing, setViewing] = useState<{ title: string; text: string } | null>(null);
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
          <h2>Preferences</h2>
          {TABS.map(([id, label, icon]) => (
            <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>{icon}{label}</button>
          ))}
          {about && (
            <div className="prefs-about" title={`darktable ${about.darktable}`}>
              <span>Immage {about.app}</span>
              <span>darktable {about.darktable.split("~")[0]}</span>
            </div>
          )}
        </nav>
        <div className="prefs-pane">
          <div className="prefs-scroll">
            {tab === "photos" && (
              <>
                <p className="prefs-lead">
                  What a photo starts with the first time it is opened, if it has no edit yet in Immage or
                  darktable. Photos already edited keep their own settings. Keywords follow the photo's first
                  edit instead.
                </p>
                <PrefCard title="Profile">
                  <PrefRow label="Profile" hint="the color look a raw starts with: one of AgX's own, or darktable's color balance rgb's; JPEGs keep the camera's">
                    <select className="field" value={profile}
                            onChange={(e) => { const v = Number(e.target.value); setProfile(v); storeNewPhotosProfile(v); }}>
                      {PROFILE_GROUPS.map(([group, opts]) => (
                        <optgroup key={group} label={group}>
                          {opts.map(([label, v]) => <option key={v} value={v}>{label}</option>)}
                        </optgroup>))}
                    </select>
                  </PrefRow>
                </PrefCard>
                <PrefCard title="Exposure">
                  <PrefRow label="Exposure compensation"
                           hint="added to a raw's exposure on a module of its own: Exposure still starts at 0 and adds to it, and Auto allows for it; JPEGs get none">
                    <PrefSwitch checked={expCompOn}
                                onChange={(on) => { setExpCompOn(on); storeExposureComp(on, expCompEv); }} />
                  </PrefRow>
                  <PrefRow label="Amount" hint={`in EV, from -${EXP_COMP_LIMIT} to +${EXP_COMP_LIMIT}`}>
                    <input className="field" type="number" step={0.1} min={-EXP_COMP_LIMIT} max={EXP_COMP_LIMIT}
                           disabled={!expCompOn} value={expCompText}
                           onChange={(e) => typeExpComp(e.target.value)}
                           onBlur={() => setExpCompText(String(expCompEv))} />
                  </PrefRow>
                </PrefCard>
                <PrefCard title="Auto Tone">
                  <PrefRow label="Apply Auto"
                           hint="Basic's Auto once a raw has rendered: Exposure, AgX's range, Contrast, Highlights, Shadows, Whites and Blacks">
                    <PrefSwitch checked={autoToneNew} onChange={(on) => { setAutoToneNew(on); storeAutoToneNew(on); }} />
                  </PrefRow>
                </PrefCard>
                <PrefCard title="Preset">
                  <PrefRow label="Apply preset"
                           hint="Default gives a raw lens corrections; JPEGs get nothing">
                    <select className="field" value={newPhotos ?? ""} onChange={(e) => onNewPhotos(e.target.value || null)}>
                      <option value="">None</option>
                      {[...presets].sort((a, b) => Number(b.id === DEFAULT_PRESET_ID) - Number(a.id === DEFAULT_PRESET_ID)
                                                   || a.name.localeCompare(b.name)).map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </PrefRow>
                  <PrefRow label="New preset" hint="from the open photo, with only the settings you tick">
                    <button className="btn small" disabled={!onSaveCurrent} onClick={() => onSaveCurrent?.()}
                            title={onSaveCurrent ? undefined : "open a photo first"}>Save current settings…</button>
                  </PrefRow>
                </PrefCard>
                <PrefCard title="Keywords">
                  <PrefRow label="Keywords for edited photos"
                           hint="added to a photo once you edit it, and taken off if it is reset to unedited; Immich reads them from the sidecar, so its Tags filter finds the photos edited here">
                    <div className="pref-keywords">
                      <KeywordChips keywords={editedKeywords}
                                    onRemove={(k) => chooseEditedKeywords(editedKeywords.filter((x) => x !== k))} />
                      <KeywordInput attached={new Set(editedKeywords)} known={knownKeywords}
                                    onAdd={addEditedKeywords} addOnBlur />
                    </div>
                  </PrefRow>
                </PrefCard>
                <PrefCard title="Copyright">
                  <PrefRow label="Copyright"
                           hint="filled in once you edit a photo, if it has none yet from the camera or typed in; {year} is the year it was taken">
                    <input className="field" placeholder="© {year} Your Name" value={editedMeta.rights}
                           onChange={(e) => chooseEditedMeta({ rights: e.target.value })} />
                  </PrefRow>
                  <PrefRow label="Creator" hint="the same, for the photo's creator">
                    <input className="field" placeholder="Your Name" value={editedMeta.creator}
                           onChange={(e) => chooseEditedMeta({ creator: e.target.value })} />
                  </PrefRow>
                </PrefCard>
              </>
            )}
            {tab === "modules" && <ModulePrefs />}
            {tab === "immich" && <ImmichPrefs />}
            {tab === "plugins" && <PluginPrefs plugins={plugins} onPlugins={onPlugins} />}
            {tab === "general" && (
              <>
              <PrefCard title="Workspace">
                <PrefRow label="Canvas" hint="behind the photo, full screen too; neutral gray judges tones without a dark surround, white as on a print. L steps through them">
                  <div className="pref-swatches">
                    {/* the viewer's backgrounds in styles.css */}
                    {([["Dark", "dark", "#121212"], ["Neutral Gray", "gray", "#767676"], ["White", "white", "#fff"]] as const).map(([label, v, color]) => (
                      <button key={v} className={`swatch${canvas === v ? " on" : ""}`} title={label} aria-label={label}
                              style={{ background: color }} onClick={() => onCanvas(v)} />
                    ))}
                  </div>
                </PrefRow>
                <PrefRow label="Overlay color" hint="a mask's overlay on the photo, and the heal brush's stroke as it is painted">
                  <div className="pref-swatches">
                    {([["Yellow", "yellow"], ["Red", "red"]] as const).map(([label, v]) => (
                      <button key={v} className={`swatch${overlayColor.pick === v ? " on" : ""}`} title={label} aria-label={label}
                              style={{ background: `rgb(${OVERLAY_COLORS[v].join(", ")})` }}
                              onClick={() => onOverlayColor({ ...overlayColor, pick: v })} />
                    ))}
                    <label className={`swatch custom${overlayColor.pick === "custom" ? " on" : ""}`} title="Custom…"
                           style={{ "--custom": overlayColor.custom } as React.CSSProperties}>
                      <input type="color" aria-label="Custom color" value={overlayColor.custom}
                             onClick={() => onOverlayColor({ ...overlayColor, pick: "custom" })}
                             onChange={(e) => onOverlayColor({ pick: "custom", custom: e.target.value })} />
                    </label>
                  </div>
                </PrefRow>
                <PrefRow label="Guide color" hint="the crop frame and grid, the straighten line, Transform's and the vignette's guides, and a mask shape's outline">
                  <div className="pref-swatches">
                    {([["White", "white"], ["Yellow", "yellow"], ["Red", "red"]] as const).map(([label, v]) => (
                      <button key={v} className={`swatch${guideColor.pick === v ? " on" : ""}`} title={label} aria-label={label}
                              style={{ background: `rgb(${GUIDE_COLORS[v].join(", ")})` }}
                              onClick={() => onGuideColor({ ...guideColor, pick: v })} />
                    ))}
                    <label className={`swatch custom${guideColor.pick === "custom" ? " on" : ""}`} title="Custom…"
                           style={{ "--custom": guideColor.custom } as React.CSSProperties}>
                      <input type="color" aria-label="Custom color" value={guideColor.custom}
                             onClick={() => onGuideColor({ ...guideColor, pick: "custom" })}
                             onChange={(e) => onGuideColor({ pick: "custom", custom: e.target.value })} />
                    </label>
                  </div>
                </PrefRow>
                <PrefRow label="Focus mode" hint={keys("opening a panel closes the others; ⌥-click opens one alongside")}>
                  <PrefSwitch checked={focusMode} onChange={onFocusMode} />
                </PrefRow>
                <PrefRow label="Auto-hide panels"
                         hint="the side panels and filmstrip slide away when the pointer leaves them, and back at their edge (the rail, or below the toolbar); a pin keeps one open">
                  <PrefSwitch checked={autoHide} onChange={onAutoHide} />
                </PrefRow>
                <PrefRow label="Warn before converting a negative"
                         hint="opening the Negative panel says which of Basic's tools a converted negative turns off">
                  <PrefSwitch checked={negWarn} onChange={(on) => { setNegWarn(on); storeNegWarn(on); }} />
                </PrefRow>
                <PrefRow label="Scroll adjusts sliders"
                         hint="off, scrolling over the panels only scrolls them, so an edit cannot change by accident">
                  <PrefSwitch checked={sliderScroll} onChange={(on) => { setSliderScroll(on); storeSliderScroll(on); }} />
                </PrefRow>
                {sliderScroll && (
                  <PrefRow label="Scroll amount"
                           hint={`how far one click of the wheel moves a slider: ${scrollStep * 100}% of its range`}>
                    <input type="range" min={0} max={SCROLL_STEPS.length - 1} step={1}
                           value={SCROLL_STEPS.indexOf(scrollStep)}
                           onChange={(e) => { const v = SCROLL_STEPS[Number(e.target.value)]; setScrollStep(v); storeSliderScrollStep(v); }} />
                  </PrefRow>
                )}
              </PrefCard>
              <PrefCard title="Library">
                <PrefRow label="Stack RAW+JPEG pairs as one photo"
                         hint="a raw and the JPEG, HEIF or OM System .ORI of the same name show as one, and a rating, reject or delete takes them all"
                  ><PrefSwitch checked={stackPairs} onChange={onStackPairs} />
                </PrefRow>
              </PrefCard>
              <PrefCard title="Startup">
                <PrefRow label="Quick start guide" hint="a short tour of Immage when it opens">
                  <PrefSwitch checked={showTour} onChange={(on) => { setShowTour(on); setTourSeen(!on); }} />
                </PrefRow>
              </PrefCard>
              </>
            )}
            {tab === "performance" && (
              <>
              {renderer && (
                <PrefCard title="Interface rendering">
                  <PrefRow label="Window renderer"
                           hint={`draws Immage's interface; photo processing uses Edit on the GPU separately. Automatic keeps the Mesa workaround on NVIDIA. running: ${{ mesa: "Mesa", nvidia: "NVIDIA", system: "system default", environment: "environment override" }[renderer.active] ?? renderer.active}${renderer.external
                             ? ". remove __EGL_VENDOR_LIBRARY_FILENAMES from the launch environment to change this"
                             : renderer.next !== renderer.running ? ". relaunch to apply the selected renderer" : ""}`}>
                    <div className="segmented small">
                      {([["Automatic", "auto"], ["Mesa", "mesa"], ["NVIDIA", "nvidia"]] as const).map(([label, mode]) => (
                        <button key={mode} className={renderer.next === mode ? "active" : ""}
                                disabled={renderer.external || rendererSaving || (mode !== "auto" && !renderer[mode])}
                                onClick={() => void chooseRenderer(mode)}>{label}</button>
                      ))}
                    </div>
                    {renderer.next !== renderer.running && (
                      <button className="btn small" style={{ marginLeft: 8 }} disabled={rendererSaving}
                              onClick={() => void onRelaunch()}>Relaunch</button>
                    )}
                  </PrefRow>
                  {rendererError && <p role="alert">{rendererError}</p>}
                </PrefCard>
              )}
              <PrefCard title="Editing">
                <PrefRow label="Edit on the GPU"
                         hint={`renders the photo on the graphics card while you edit, as exports and the whole-photo render behind the viewer already are; off keeps edits on the CPU. without a usable GPU darktable uses the CPU either way. smaller drafts for slow sliders still apply, though on the GPU frames are seldom slow enough${gpuEdits && gpuEdits.next !== gpuEdits.running
                           ? ". applies once Immage starts again" : ""}`}>
                  <PrefSwitch checked={gpuEdits?.next ?? false} disabled={!gpuEdits} onChange={chooseGpuEdits} />
                  {gpuEdits && gpuEdits.next !== gpuEdits.running && (
                    <button className="btn small" style={{ marginLeft: 8 }} onClick={() => void onRelaunch()}>Relaunch</button>
                  )}
                </PrefRow>
                <PrefRow label="Preview"
                         hint={{
                           quality: "every frame in full while you edit: the slowest, most faithful preview",
                           balanced: "while a slider, wheel or curve moves, the photo renders at the selected preview size without grain, texture and diffuse or sharpen's sharpening, and in full on release. the zoomed-out view behind the photo leaves them out too",
                           performance: "as Balanced, at quarter size while dragging and also without noise reduction and HSL; the whole-photo render behind the viewer is only the viewer's size",
                         }[preview]}>
                  <div className="segmented small">
                    {([["Quality", "quality"], ["Balanced", "balanced"], ["Performance", "performance"]] as const).map(([label, v]) => (
                      <button key={v} className={preview === v ? "active" : ""}
                              onClick={() => { setPreview(v); storePreview(v); }}>{label}</button>
                    ))}
                  </div>
                </PrefRow>
                <PrefRow label="Adaptive cached preview"
                         hint="experimental: exposure, vibrance, saturation and detail drags estimate between recent full renders. periodic native renders check accuracy; release gives the accurate result">
                  <div className="segmented small">
                    {[false, true].map((on) => (
                      <button key={String(on)} className={cachedDetail === on ? "active" : ""}
                              onClick={() => { setCachedDetail(on); storeCachedDetailPreview(on); }}>{on ? "On" : "Off"}</button>
                    ))}
                  </div>
                </PrefRow>
                {preview === "balanced" && (
                  <PrefRow label="Balanced preview size"
                           hint="100% keeps drag previews at full size and disables smaller drafts for slow sliders; grain, texture and sharpening shortcuts still apply">
                    <div className="segmented small">
                      {BALANCED_PREVIEW_SIZES.map((v) => (
                        <button key={v} className={balancedSize === v ? "active" : ""}
                                onClick={() => { setBalancedSize(v); storeBalancedPreviewSize(v); }}>{v * 100}%</button>
                      ))}
                    </div>
                  </PrefRow>
                )}
                {preview !== "quality" && !(preview === "balanced" && balancedSize === 1) && (
                  <>
                    <PrefRow label="Smaller drafts for slow sliders"
                             hint="while a slider early in darktable's pipe moves (Exposure, White Balance, noise reduction), the photo renders smaller again, so each frame comes sooner. off keeps Preview's size">
                      <div className="segmented small">
                        {DRAFT_SMALLEST.map((v) => (
                          <button key={v} className={draftSmallest === v ? "active" : ""}
                                  onClick={() => { setDraftSmallest(v); storeDraftSmallest(v); }}>
                            {v === 1 ? "Off" : `${v * 100}%`}
                          </button>
                        ))}
                      </div>
                    </PrefRow>
                    {draftSmallest < 1 && (
                      <PrefRow label="Draft time"
                               hint="how long darktable may take on a frame while a slider moves before the next one is smaller; less is quicker and softer">
                        <div className="segmented small">
                          {DRAFT_TARGETS.map((ms) => (
                            <button key={ms} className={draftTarget === ms ? "active" : ""}
                                    onClick={() => { setDraftTarget(ms); storeDraftTarget(ms); }}>{ms} ms</button>
                          ))}
                        </div>
                      </PrefRow>
                    )}
                  </>
                )}
                {sharedFramesAvailable && (
                  <PrefRow label="Shared-memory frames"
                           hint="hands each frame to the window in memory both share, rather than copying it through Tauri. off to compare the two in the GUI benchmark">
                    <PrefSwitch checked={sharedFrames} onChange={(on) => { setSharedFrames(on); storeSharedFrames(on); }} />
                  </PrefRow>
                )}
                {screenScale() !== null && (
                  <PrefRow label="Drag drafts at the screen's scale"
                           hint={`while a slider moves, renders the photo for this screen's ${Math.round(screenScale()! * 100)}%, not the ${Math.round((window.devicePixelRatio || 1) * 100)}% the window is drawn at and shrunk from: fewer pixels for darktable. the frame after letting go is full size either way. off to compare the two in the GUI benchmark`}>
                    <PrefSwitch checked={atScreenScale} onChange={(on) => { setAtScreenScale(on); storeScreenScale(on); }} />
                  </PrefRow>
                )}
              </PrefCard>
              <PrefCard title="Memory">
                <PrefRow label="darktable memory"
                         hint={`${{
                           small: "darktable keeps to about an eighth of this computer's memory, for working beside other large programs; more of each edit is worked out again",
                           default: "darktable may take about half of this computer's memory for its pipes and caches",
                           large: "about two thirds, for when Immage is the only large program running",
                         }[resources?.next ?? "default"]}${resources && resources.next !== resources.running
                           ? ". applies once Immage starts again" : ""}`}>
                  <div className="segmented small">
                    {([["Small", "small"], ["Default", "default"], ["Large", "large"]] as const).map(([label, v]) => (
                      <button key={v} className={resources?.next === v ? "active" : ""} disabled={!resources}
                              onClick={() => chooseResources(v)}>{label}</button>
                    ))}
                  </div>
                  {resources && resources.next !== resources.running && (
                    <button className="btn small" style={{ marginLeft: 8 }} onClick={() => void onRelaunch()}>Relaunch</button>
                  )}
                </PrefRow>
                <PrefRow label="Frame cache"
                         hint="memory for the frames the viewer keeps, so zooming back out or returning to a view seen before shows it without a render. a 100% frame is about 30 MB on a 4K screen and 45 MB on a 5K one">
                  <div className="segmented small">
                    {FRAME_CACHE_MB.map((mb) => (
                      <button key={mb} className={frameCache === mb ? "active" : ""}
                              onClick={() => { setFrameCache(mb); storeFrameCacheMb(mb); }}>
                        {mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`}
                      </button>
                    ))}
                  </div>
                </PrefRow>
                <PrefRow label="Thumbnail memory"
                         hint="for the library's thumbnails; past it, those scrolled out of sight longest are let go, and read from the disk cache again when scrolled back. a thumbnail takes about 1 MB">
                  <div className="segmented small">
                    {THUMB_MEMORY_MB.map((mb) => (
                      <button key={mb} className={thumbMemory === mb ? "active" : ""}
                              onClick={() => { setThumbMemory(mb); storeThumbMemoryMb(mb); }}>
                        {mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`}
                      </button>
                    ))}
                  </div>
                </PrefRow>
                <PrefRow label="Read ahead"
                         hint="photos whose raws are decoded while you edit, in the direction you last stepped, so the arrow keys open them without the decode (some 300 ms for a compressed raw). each holds its raw in memory, about 50 MB for 24 megapixels">
                  <div className="segmented small">
                    {Array.from({ length: READ_AHEAD_MAX + 1 }, (_, n) => (
                      <button key={n} className={readAhead.count === n ? "active" : ""}
                              onClick={() => chooseReadAhead({ count: n })}>{n ? String(n) : "Off"}</button>
                    ))}
                  </div>
                </PrefRow>
                {readAhead.count > 0 && (
                  <PrefRow label="Read ahead both ways" hint="as many photos behind the open one too, for stepping back">
                    <PrefSwitch checked={readAhead.both} onChange={(on) => chooseReadAhead({ both: on })} />
                  </PrefRow>
                )}
              </PrefCard>
              <CachePrefs />
              <PrefCard title="AI Acceleration">
                <PrefRow label="GPU" hint={accel === null ? "looking for GPU acceleration…"
                  : accel.length ? "what AI upscaling at export runs on"
                  : "none found on this computer, so AI upscaling is not offered"}>
                  {accel && accel.length > 0 && (
                    <select className="field" value={accelChoice.provider}
                            onChange={(e) => chooseAccel({ provider: e.target.value, device: -1 })}>
                      <option value="auto">Automatic ({accel[0].name})</option>
                      {accel.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  )}
                </PrefRow>
                {accelProvider && accelProvider.devices.length > 1 && (
                  <PrefRow label="Device" hint="the graphics card to use">
                    <select className="field" value={accelChoice.device}
                            onChange={(e) => chooseAccel({ ...accelChoice, device: Number(e.target.value) })}>
                      <option value={-1}>Default</option>
                      {accelProvider.devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </PrefRow>
                )}
              </PrefCard>
              <PrefCard title="Measuring">
                <PrefRow label="Performance overlay"
                         hint="over the photo: frame rate, the time from a slider moving to the photo changing, where that time went, and darktable's slowest modules">
                  <PrefSwitch checked={perfHud} onChange={onPerfHud} />
                </PrefRow>
                <PrefRow label="GUI benchmark"
                         hint={onBenchmark
                           ? "drags the main sliders on the open photo and back, zooms in and out, and saves timing, frame pacing and resource usage; every slider ends where it started. use a copy of a photo you care about"
                           : "open a photo to run it"}>
                  <button className="btn" disabled={!onBenchmark} onClick={() => onBenchmark?.()}>Run</button>
                </PrefRow>
                <PrefRow label="Performance tuner"
                         hint="load a representative RAW from your usual work and use your normal window size. finds the highest-quality preview meeting your FPS and latency targets; Apply verifies the result">
                  <button className="btn" disabled={!onTune} onClick={() => onTune?.()}>Tune…</button>
                </PrefRow>
              </PrefCard>
              </>
            )}
            {tab === "about" && (
              <>
                <PrefCard title="Immage">
                  <div className="prefs-legal">
                    <p>Immage {about?.app ?? ""}, Copyright © 2026 the Immage authors</p>
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
                <PrefCard title="Updates">
                  <PrefRow label="Check automatically" hint="once a day, from Immage's releases on GitHub">
                    <PrefSwitch checked={autoUpdate} onChange={(on) => { setAutoUpdate(on); storeAutoCheck(on); }} />
                  </PrefRow>
                  <PrefRow label="Check for updates" hint={updateHint(update, about?.app)}>
                    <button className="btn" disabled={update.kind === "checking" || update.kind === "downloading" || update.kind === "installing"}
                            onClick={() => void checkForUpdate(true)}>Check Now</button>
                  </PrefRow>
                </PrefCard>
                <PrefCard title="License and Source">
                  <PrefRow label="License" hint="GNU General Public License, version 3 or later">
                    <button className="btn" disabled={!licenses?.gpl}
                            onClick={() => licenses?.gpl && setViewing({ title: "GNU General Public License", text: licenses.gpl })}
                    >View</button>
                  </PrefRow>
                  <PrefRow label="Source code" hint={sourceUrl(about?.app)}>
                    <button className="btn" onClick={() => void openUrl(sourceUrl(about?.app))}>Open</button>
                  </PrefRow>
                  <PrefRow label="darktable source" hint={darktableUrl(about?.darktable)}>
                    <button className="btn" onClick={() => void openUrl(darktableUrl(about?.darktable))}>Open</button>
                  </PrefRow>
                  <PrefRow label="Bundled libraries"
                           hint={licenses?.libraries ? "the engine's libraries, each under its own license, and where their source is"
                             : "not bundled in this build"}>
                    <div className="segmented small">
                      <button disabled={!licenses?.libraries}
                              onClick={() => licenses?.libraries && setViewing({ title: "Bundled Libraries", text: licenses.libraries })}
                      >View</button>
                      <button disabled={!licenses?.librariesPath}
                              onClick={() => licenses?.librariesPath && void revealItemInDir(licenses.librariesPath)}
                      >License Texts</button>
                    </div>
                  </PrefRow>
                  <PrefRow label="App components"
                           hint={licenses?.notices ? "the Rust crates and npm packages built into the app, and their licenses"
                             : "not generated for this build"}>
                    <button className="btn" disabled={!licenses?.notices}
                            onClick={() => licenses?.notices && setViewing({ title: "App Components", text: licenses.notices })}
                    >View</button>
                  </PrefRow>
                </PrefCard>
              </>
            )}
          </div>
          <div className="prefs-foot">
            <span className="prefs-note">changes apply as you make them</span>
            <button className="btn primary" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
      {viewing && <LicenseText title={viewing.title} text={viewing.text} onClose={() => setViewing(null)} />}
    </div>
  );
}
