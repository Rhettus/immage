// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { BANDS, choiceOn, choiceShows, controlById, GUIDE_IDS, guidesOf, isModuleSetting, MAX_GUIDES, parametricOf, UPRIGHT_GUIDED,
         UPRIGHT_MODES, uprightAspect, mapOf, mapsFor, moduleName, mapsWith, panels, pointsOf, pointValues, profileLabel, turnRect, type Control, type ControlPreset, type CurveChannel, type Values,
         type Panel, type Section, type Turn } from "./manifest";
import { CircleOff, Grid2x2, MoveHorizontal, MoveVertical, PenLine, Sparkles, WandSparkles } from "lucide-react";
import { Session, instanceKey, mapOpOf, type Frame, type HistoryItem, type ModuleState, type View } from "./session";
import { AUTO_TONE_IDS, autoExposure, autoTone, type SceneKey } from "./autoTone";
import { curve } from "./tonecurve";
import { clipColor, computeHistogram, DEFAULT_SCOPE, drawScope, HARMONIES, HARMONY_WIDTHS, histogramPath, paintClipping,
         type ClipShow, type Histogram, type ScopeMode, type ScopeSettings, type VecSpace } from "./histogram";
import { applyCacheLimits } from "./CachePrefs";
import { fetchThumb, fileKind, isCompanion, isPrimaryRaw, LABEL_COLORS, loadIncludeSubfolders, openFolder, pairKey, pairPartners,
         storeIncludeSubfolders,
         ThumbLoader,
         byCaptureTime,
         type Exif, type ImageEntry } from "./library";
import { captureDate, exposureLine, known, MetadataPanel, shutter, type TextFields } from "./MetadataPanel";
import { HistoryPanel, stepName } from "./HistoryPanel";
import { VignetteOverlay } from "./VignetteOverlay";
import { GuideOverlay } from "./GuideOverlay";
import { autoMix } from "./bwauto";
import { begin, end, track, useWorking } from "./activity";
import { withModel } from "./aiModel";
import { bandWeights, invert, lightness, pixelAt, polyline, setProbe, useProbe, type Probe, type RGB } from "./probe";
import { anchored, neutralize, whitePatch, WB_PRESETS, type WB } from "./wb";
import { GradingWheels, type WheelMode } from "./ColorWheel";
import { CurveMarkView, PointCurve, type CurveMark } from "./PointCurve";
import { channelCurve, curve as paramCurve, isIdentity, monotone } from "./tonecurve";
import { ExportDialog, FILE_MANAGER } from "./ExportDialog";
import { CopyDialog, loadCopyGroups, makeClip, type Clip } from "./CopySettings";
import { DenoiseDialog } from "./DenoiseDialog";
import { Tour, tourSeen } from "./Tour";
import { UpdateBanner } from "./UpdateBanner";
import { autoCheck } from "./updates";
import { Chevron, Collapse } from "./Collapse";
import { loadAutoHide, loadAutoToneNew, loadExposureCompNew, loadCanvas, loadEditedKeywords, loadEditedMeta, loadFocusMode, loadNewPhotosProfile, loadOverlayColor, loadPins, maskOverlayRgb, loadPreview, loadSliderScroll, loadSliderScrollStep,
         loadStackPairs,
         PreferencesDialog, storeOverlayColor, storeStackPairs,
         storeAutoHide, storeCanvas, CANVASES, storeFocusMode, storePins, type AccelProvider, type Canvas,
         type Pins, type PrefsTab, type Preview } from "./Preferences";
import { kindOf, loadPlugins, loadReturns, returnValues, storePlugins, unfit, type PluginConfig,
         type PluginReturn } from "./plugins";
import { FolderTree } from "./FolderTree";
import { baseName, parentDir, within } from "./paths";
import { ImportView } from "./ImportView";
import type { ImportResult } from "@immporter/embed";
import { MaskOverlay, type BrushSettings, type MaskTool, type ObjectPrompt } from "./MaskOverlay";
import { MasksPanel, useDismiss, type AiKind, type ToolTarget } from "./MasksPanel";
import { HealPanel } from "./HealPanel";
import { LOCAL_TRANSITION, ObjectBox, ZoneAdjust, ZoneSystem, type ZoneMaskInfo } from "./ZoneSystem";
import { DEFAULT_TRANSITION, loadZoneOverlay, offsetsOf, overlayRgb, paintRange, paintWeights, parseZones, placeIds,
         placeTable, nextObjectKind, partLabel,
         rangeCenter, samePart, saveZoneOverlay, ZONE_PARTS, zoneAt, zoneMaskName, zoneOfMask, zonePartOf, zoneShape,
         type ZoneData, type ZoneOverlay, type ZonePart, type ZoneRange } from "./zones";
import { SpotOverlay, type SpotTool } from "./SpotOverlay";
import type { NewSpot, Spot } from "./spots";
import { flipMode, isRange, isRefined, maskAt, maskKindName, nextMaskName, NO_REFINE, overlayShown, overlayStep, rangeChannels,
         type BlendifChannel, type ChannelRange, type Mask, type ObjectShape, type OverlayToggle, type ParametricRange, type Range,
         type RangeMap, type Refine, type Region, type Shape } from "./masks";
import { channelTint, type Picked } from "./ParametricEditor";
import { BUILTIN_PRESETS, loadLooks, loadNewPhotosPreset, loadPresets, NewPresetDialog, PresetsPanel, PreviewCache,
         readSharedPresets, savePresets, sharedPresets, storeNewPhotosPreset, type Look, type Preset } from "./Presets";
import { ASPECTS, CropOverlay, customAspect, findAspect, fitAspect, FULL, loadCustomAspects, pixelAspect,
         rememberCustomAspect, type Aspect, type CropRect } from "./CropTool";
import { ShortcutsDialog } from "./Shortcuts";
import { cmd, keys } from "./keys";
import { perf, percentiles, STAGES, webviewInfo } from "./perf";
import { frameTransport } from "./sharedFrames";
import { PerfHud } from "./PerfHud";
import { KeywordingPanel } from "./Keywording";
import { ImmichPanel } from "./ImmichPanel";
import { immichUrl, isRemote, photoUrl, resolve, search as searchImmichPage, searchUrl, type ImmichSearch } from "./immich";


const MAX_PREVIEW = 2560;
// a drag's frames, as a share of the full frame's width and height, by the
// Preview preference; Quality has no drag frames
const DRAFT: Record<Preview, number> = { quality: 1, balanced: 0.5, performance: 0.25 };

// the before/after views, in the order the button and Y step through them
type BaMode = "off" | "side" | "vsplit" | "hsplit" | "overlay";
const BA_MODES: BaMode[] = ["off", "side", "vsplit", "hsplit", "overlay"];
const BA_NAMES: Record<BaMode, string> = {
  off: "Before / after off", side: "Side by side", vsplit: "Split left / right",
  hsplit: "Split top / bottom", overlay: "Hold for before",
};

// the overlay view explains its hold the first few times it opens
const bumpHoldHint = () => {
  try {
    const n = Number(localStorage.getItem("immage.holdHintSeen") ?? 0);
    if (n >= 3) return false;
    localStorage.setItem("immage.holdHintSeen", String(n + 1));
  } catch { /* shown every time */ }
  return true;
};

// Lightroom's navigator zoom levels. a number is image pixels per screen
// (device) pixel, so 1 is 100%
type Zoom = "fit" | "fill" | number;
const ZOOMS: [Zoom, string][] = [["fit", "FIT"], ["fill", "FILL"], [1, "1:1"], [2, "2:1"]];
// the levels ⌘= and ⌘- step through, as Lightroom's do past the navigator's,
// up to the wheel's 4:1
const KEY_ZOOMS: Zoom[] = ["fit", "fill", 1, 2, 3, 4];

// the image as last rendered, kept to place the zoomed window and the
// navigator's rectangle
type Placement = { fullWidth: number; fullHeight: number; scale: number; x: number; y: number;
                   width: number; height: number; upscale?: number };

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export default function App() {
  const [folder, setFolder] = useState<string | null>(null);
  const folderRef = useRef(folder);
  folderRef.current = folder;
  // with pairs stacked, each raw's partners (set at render); every rating,
  // reject, label and delete of a photo takes its partners too
  const partnersRef = useRef(new Map<number, ImageEntry[]>());
  const withPartners = (list: ImageEntry[]) =>
    [...new Set(list.flatMap((i) => [i, ...(partnersRef.current.get(i.imgid) ?? [])]))];
  const [folders, setFolders] = useState<string[]>(() => loadLibrary().folders);
  const foldersRef = useRef(folders);
  foldersRef.current = folders;
  // the tree's open folders, kept between launches, and a count bumped to
  // read their subfolders again
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(loadLibrary().expanded));
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const [folderRefresh, setFolderRefresh] = useState(0);
  // subfolders taken off the tree; adding one again brings it back
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(loadLibrary().hidden));
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const unhide = (dir: string) => {
    const next = new Set([...hiddenRef.current].filter((h) => !within(dir, h)));
    if (next.size === hiddenRef.current.size) return;
    hiddenRef.current = next;
    setHidden(next);
    saveLibrary({ hidden: [...next] });
  };
  const setExpandedTo = (next: Set<string>) => {
    setExpanded(next);
    saveLibrary({ expanded: [...next] });
  };
  const [images, setImages] = useState<ImageEntry[]>([]);
  const [, setThumbVersion] = useState(0);
  // the key handler and the loader outlive renders, so they read these refs
  const imagesRef = useRef<ImageEntry[]>([]);
  const currentRef = useRef<Opened | null>(null);
  // whether a listed photo is the open one: by imgid, as a file's virtual
  // copies share its path; until the engine has said, the file's original
  const isOpen = (i: ImageEntry, o = currentRef.current) =>
    !!o && (o.imgid !== null ? i.imgid === o.imgid : i.path === o.path && !i.copy);
  const thumbFrame = useRef(0);
  const loader = useRef<ThumbLoader | null>(null);
  if (!loader.current)
    loader.current = new ThumbLoader(() => session.current?.idle ?? true,
                                     (imgid) => imagesRef.current.find((i) => i.imgid === imgid),
                                     // thumbnails landing together redraw the window once per frame, not once each
                                     () => {
                                       if (thumbFrame.current) return;
                                       thumbFrame.current = requestAnimationFrame(() => {
                                         thumbFrame.current = 0;
                                         setThumbVersion((v) => v + 1);
                                       });
                                     },
                                     // the server's refusal is said once, not hidden behind placeholders
                                     (imgid, e) => {
                                       if (imgid >= 0 || thumbError.current) return;
                                       thumbError.current = true;
                                       setStatus(`Immich thumbnails: ${e}`);
                                     });
  const thumbError = useRef(false);
  const [current, setCurrent] = useState<Opened | null>(null);
  // the open photo's filmstrip cell, kept while the filmstrip shows another
  // folder or an Immich search, so the tools and panels that need it still work
  const [openCell, setOpenCell] = useState<ImageEntry | null>(null);
  const [values, setValues] = useState<Record<string, number>>({});
  const [status, setStatus] = useState("open a folder to start");
  // how far the open folder's reading has got, while it is read
  // `files` lists them all, in the order they are read
  const [reading, setReading] = useState<{ done: number; total: number; files: string[] } | null>(null);
  const [openPanels, setOpenPanels] = useState<Set<string>>(new Set(["basic"]));
  const [layout, setLayoutState] = useState<Layout>(loadLayout);
  const setLayout = (f: (l: Layout) => Layout) =>
    setLayoutState((l) => { const n = f(l); saveLayout(n); return n; });
  // panels slide open and closed; the transition is on only while a toggle
  // runs, so dragging a splitter still follows the pointer exactly
  const [sliding, setSliding] = useState(false);
  const slideTimer = useRef(0);
  const slide = () => {
    setSliding(true);
    window.clearTimeout(slideTimer.current);
    slideTimer.current = window.setTimeout(() => setSliding(false), 260);
  };
  const toggleSide = (k: PanelKey) => {
    slide();
    setLayout((l) => ({ ...l, [k]: !l[k] }));
  };
  // Lightroom's Tab and ⇧Tab: the panels away, and back as they were
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const stashed = useRef<Record<string, Partial<Layout>>>({});
  const hidePanels = (keys: PanelKey[]) => {
    const l = layoutRef.current, id = keys.join();
    let next: Partial<Layout>;
    if (keys.some((k) => l[k])) {
      stashed.current[id] = Object.fromEntries(keys.map((k) => [k, l[k]]));
      next = Object.fromEntries(keys.map((k) => [k, false]));
    } else {
      next = stashed.current[id] ?? Object.fromEntries(keys.map((k) => [k, true]));
      delete stashed.current[id];
    }
    slide();
    setLayout((old) => ({ ...old, ...next }));
  };
  // a rail button: switch the right-hand panel to its mode, or, already
  // showing it, slide the panel shut
  const showRight = (mode: RightMode) => {
    // leaving the crop tool for the mode it was opened over is not a second click
    const wasCropping = croppingRef.current;
    if (wasCropping) leaveCrop(true);
    if (layout.right && rightMode === mode && !wasCropping) { toggleSide("right"); return; }
    setRightMode(mode);
    if (!layout.right) toggleSide("right");
  };
  const [filter, setFilter] = useState<Filter>(NO_FILTER);
  const [metaText, setMetaText] = useState<TextFields | null>(null);
  // the open photo's keywords, and every keyword ever used
  const [keywords, setKeywords] = useState<string[] | null>(null);
  const [knownKeywords, setKnownKeywords] = useState<string[]>([]);
  const [exporting, setExporting] = useState(false);
  // Copy Settings: the dialog, what it copied, and the last photo's whole
  // edit for Previous
  const [copying, setCopying] = useState(false);
  const clip = useRef<Clip | null>(null);
  const [hasClip, setHasClip] = useState(false);
  const previous = useRef<Clip | null>(null);
  // the quick start guide: by itself on first start, then from the title bar
  const [touring, setTouring] = useState(() => !tourSeen());
  const [prefsOpen, setPrefsOpen] = useState<false | true | PrefsTab>(false);
  // the Immich card: shown once Immich is set up (checked again as
  // Preferences closes), with the server's URL for links into its web app.
  // with `immich` set, the filmstrip holds that search's results, not a folder
  const [immichBase, setImmichBase] = useState<string | null>(null);
  useEffect(() => { if (!prefsOpen) void immichUrl().then(setImmichBase); }, [prefsOpen]);
  const [immich, setImmichState] = useState<{ search: ImmichSearch; next: string | null; busy: boolean } | null>(null);
  const immichRef = useRef(immich);
  const setImmich = (v: typeof immich) => { immichRef.current = v; setImmichState(v); };
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // the filmstrip's selection, by image: ratings, labels and rejects apply
  // to all of it, as in Lightroom; the open photo is the active one
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  // Lightroom's Grid (G): the filmstrip spread over the editing area
  const [grid, setGrid] = useState(false);
  const gridRef = useRef(false);
  gridRef.current = grid;
  // Lightroom's Auto Hide & Show: with it on, an open side panel or the
  // filmstrip, if not pinned, floats over the photo, slides in when the
  // pointer reaches its edge of the window (the rail, on the right; the
  // toolbar, below) and away a moment after the pointer leaves it, so the
  // photo keeps the whole window and never re-renders as panels come and go
  const [autoHide, setAutoHide] = useState(loadAutoHide);
  const [pins, setPins] = useState<Pins>(loadPins);
  const [revealed, setRevealed] = useState<Pins>({ left: false, right: false, strip: false });
  const revealedRef = useRef(revealed);
  const leftAside = useRef<HTMLElement>(null);
  const rightAside = useRef<HTMLElement>(null);
  const rail = useRef<HTMLElement>(null);
  const stripSlot = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  // the floating filmstrip sits just above the toolbar
  const [toolbarSpace, setToolbarSpace] = useState(44);
  useEffect(() => {
    const el = toolbar.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setToolbarSpace(el.offsetHeight + 8));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const floatingRef = useRef<Pins>({ left: false, right: false, strip: false });
  const pinButton = (side: keyof Pins) => autoHide && (
    <button className={`tool pin${pins[side] ? " on" : ""}`}
            title={pins[side] ? "unpin: let the panel hide" : "pin: keep the panel open"}
            onClick={() => setPins((p) => { const n = { ...p, [side]: !p[side] }; storePins(n); return n; })}>
      <PinIcon on={pins[side]} /></button>
  );
  // the GPU providers this computer has for AI, asked of the engine once
  const [accel, setAccel] = useState<AccelProvider[] | null>(null);
  useEffect(() => { invoke<AccelProvider[]>("ai_accel").then(setAccel).catch(() => setAccel([])); }, []);
  // Preferences' cache limits, which the app's caches start without
  useEffect(() => { applyCacheLimits(); }, []);
  // a photo's right-click menu, where it was clicked
  // the photos it acts on are the selection when the click is in it, else
  // that photo alone
  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; imgid: number | null; targets: ImageEntry[] } | null>(null);
  // right-click on the Immich card or the results' empty space: the search
  // in Immich's web app
  const showResultsMenu = (e: React.MouseEvent) => {
    if (!immichRef.current) return;
    e.preventDefault();
    setFileMenu({ x: e.clientX, y: e.clientY, imgid: null, targets: [] });
  };
  const showFileMenu = (e: React.MouseEvent, imgid: number) => {
    e.preventDefault();
    const sel = selectionRef.current;
    const hit = imagesRef.current.find((i) => i.imgid === imgid);
    const targets = withPartners(hit && sel.size > 1 && sel.has(hit.imgid) ? imagesRef.current.filter((i) => sel.has(i.imgid))
      : hit ? [hit] : []);
    setFileMenu({ x: e.clientX, y: e.clientY, imgid, targets });
  };
  const [canvasColor, setCanvasColor] = useState<Canvas>(loadCanvas);
  const [focusMode, setFocusMode] = useState(loadFocusMode);
  const [overlayColor, setOverlayColor] = useState(loadOverlayColor);
  // Preferences' performance overlay, and Rust told of it once
  const [perfHud, setPerfHud] = useState(perf.enabled);
  useEffect(() => { perf.init(); }, []);
  const [stackPairs, setStackPairs] = useState(loadStackPairs);
  // the import screen, over the editor until closed
  const [importOpen, setImportOpen] = useState(false);
  const importOpenRef = useRef(false);
  importOpenRef.current = importOpen;
  const endTour = () => setTouring(false);
  // the tour points at both side panels, the filmstrip and the Adjustments
  // panels, so they show while it runs
  useEffect(() => {
    if (!touring) return;
    setImportOpen(false);
    if (croppingRef.current) leaveCrop(true);
    setLayout((l) => ({ ...l, left: true, right: true, strip: true }));
    setRightMode("adjust");
  }, [touring]);
  // what the right-hand panel shows: the adjustments, or the presets
  const [rightMode, setRightMode] = useState<RightMode>("adjust");
  // masks: the session's, mirrored for rendering, the one being edited, and
  // the drawing tool
  const [masks, setMasks] = useState<Mask[]>([]);
  const [maskSel, setMaskSel] = useState<string | null>(null);
  const [shapeSel, setShapeSel] = useState(0);
  const [maskTool, setMaskTool] = useState<MaskTool | null>(null);
  const [toolTarget, setToolTarget] = useState<ToolTarget>("new");
  // the parametric component's pickers: show reads the photo under the
  // pointer onto its slider; set range is a tool, for one channel
  const [pickShow, setPickShow] = useState(false);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [pickChan, setPickChan] = useState<BlendifChannel>("g");
  // the tab the parametric editor shows: the overlay takes its color
  const [pmTab, setPmTab] = useState<BlendifChannel | null>(null);
  const [brush, setBrush] = useState<BrushSettings>({ size: 0.05, hardness: 0.5, density: 1, erase: false });
  // the red overlay starts off; it shows anyway while a shape is drawn or
  // dragged (MaskOverlay), and O or the panel's switch keeps it on
  const [maskOverlay, setMaskOverlay] = useState<OverlayToggle>({ on: false, hold: null });
  // the mask createShape last made, for the Masks panel to open its Tone
  const [freshMask, setFreshMask] = useState<{ name: string; n: number } | null>(null);
  // the overlay steps aside while a mask's sliders move, so the change can
  // be seen, and comes back a moment after they stop
  const [adjusting, setAdjusting] = useState(false);
  const adjustTimer = useRef(0);
  const adjusted = () => {
    setAdjusting(true);
    window.clearTimeout(adjustTimer.current);
    adjustTimer.current = window.setTimeout(() => setAdjusting(false), 900);
  };
  // a slider that shapes the mask moving (refinements, ranges, depth): the
  // overlay shows, overlays on or not, and stays a moment after so the
  // engine's mask can catch up
  const [refining, setRefining] = useState(false);
  const refiningRef = useRef(false);
  refiningRef.current = refining;
  const refineTimer = useRef(0);
  const refined = () => {
    setRefining(true);
    window.clearTimeout(refineTimer.current);
    refineTimer.current = window.setTimeout(() => setRefining(false), 1500);
  };
  const maskBox = useRef<HTMLDivElement>(null);
  const masksMode = rightMode === "masks";
  const syncMasks = () => setMasks(session.current?.masks ?? []);
  // Heal and Clone: the image's spots, the selected one, the brush for new
  // ones, and Visualize Spots' threshold (null when off)
  const healMode = rightMode === "heal";
  const [spots, setSpots] = useState<Spot[]>([]);
  const [spotSel, setSpotSel] = useState<number | null>(null);
  const [spotTool, setSpotTool] = useState<SpotTool>({ mode: "heal", size: 0.03, feather: 0.5, opacity: 1 });
  const [visualize, setVisualize] = useState<number | null>(null);
  // bumped when the whole-image base is redrawn, for Visualize Spots
  const [baseTick, setBaseTick] = useState(0);
  const syncSpots = () => setSpots(session.current?.spots ?? []);
  // the engine's map of the selected mask's ranges, for the overlay
  const [rangeMap, setRangeMap] = useState<RangeMap | null>(null);
  // the Zone System: the engine's zones of the image, made again after
  // edits; the pinned run of zones and the one under the pointer, shown
  // over the image
  const [zoneData, setZoneData] = useState<ZoneData | null>(null);
  // the zones before the placement moved them, while it does
  const [zoneUnplaced, setZoneUnplaced] = useState<ZoneData | null>(null);
  const [zoneStale, setZoneStale] = useState(false);
  const [zoneError, setZoneError] = useState<string | null>(null);
  const [zonePinned, setZonePinned] = useState<ZoneRange | null>(null);
  const [zoneHover, setZoneHover] = useState<ZoneRange | null>(null);
  const [zoneOverlay, setZoneOverlayState] = useState<ZoneOverlay>(loadZoneOverlay);
  const setZoneOverlay = (o: ZoneOverlay) => { setZoneOverlayState(o); saveZoneOverlay(o); };
  const zoneBox = useRef<HTMLDivElement>(null);
  const zoneCanvas = useRef<HTMLCanvasElement>(null);
  // ⌥-dragging a detail slider: the module's mask in black and white, or
  // the photo in grayscale (Control.optionPreview)
  const [optPreview, setOptPreview] = useState<OptionPreview | null>(null);
  const detailBox = useRef<HTMLDivElement>(null);
  const detailCanvas = useRef<HTMLCanvasElement>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [newPhotos, setNewPhotos] = useState<string | null>(loadNewPhotosPreset);
  // the New Preset dialog: closed, or open with "use for new photos" ticked or not
  const [newPreset, setNewPreset] = useState<false | "plain" | "newPhotos">(false);
  const [looks, setLooks] = useState<Look[]>([]);
  const looksRef = useRef<Look[]>([]);
  const [look, setLookState] = useState<string | null>(null);
  const [lookAmount, setLookAmount] = useState(100);
  // the daily update check: once the splash has made way and the first
  // photos are coming in, and again each hour for an app left open for days
  useEffect(() => {
    const first = window.setTimeout(autoCheck, 10_000);
    const hourly = window.setInterval(autoCheck, 3600_000);
    return () => { window.clearTimeout(first); window.clearInterval(hourly); };
  }, []);
  useEffect(() => {
    loadPresets().then(setPresets).catch((e) => setStatus(`presets: ${e}`));
    loadLooks().then((l) => { looksRef.current = l; setLooks(l); }).catch((e) => setStatus(`looks: ${e}`));
  }, []);
  // the folder tree is read again when the window comes back, as folders
  // may have been made or moved meanwhile
  useEffect(() => {
    const back = () => setFolderRefresh((n) => n + 1);
    window.addEventListener("focus", back);
    return () => window.removeEventListener("focus", back);
  }, []);
  // the web view's own context menu (Reload, Inspect Element) is no part of
  // the app; text fields keep theirs, for copy and paste
  useEffect(() => {
    const block = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, [contenteditable]")) return;
      e.preventDefault();
    };
    window.addEventListener("contextmenu", block);
    return () => window.removeEventListener("contextmenu", block);
  }, []);
  // preview tiles for the presets panel, rendered while the engine is idle
  const [, setPreviewTick] = useState(0);
  const previews = useRef<PreviewCache | null>(null);
  if (!previews.current)
    previews.current = new PreviewCache(() => session.current?.idle ?? false, () => setPreviewTick((t) => t + 1));
  const wantedTiles = useRef<string[]>([]);
  const PREVIEW_SIZE = 220;
  // looks by path: true for a black and white one, found from its tile.
  // a .dtstyle says nothing of Treatment, and users add their own
  const lookMono = useRef(new Map<string, boolean>());
  const requestTiles = () => {
    const s = session.current;
    if (!s) return;
    const all = [...BUILTIN_PRESETS, ...presetsRef.current];
    previews.current!.request(wantedTiles.current.flatMap((key) => {
      // a look's tile is in color whatever the photo's Treatment, so a color
      // film shows as one on a black and white photo; it also tells
      // whether the look is a black and white one
      if (key.startsWith("l:")) {
        const path = key.slice(2);
        return [{ key, run: async () => {
          const f = await s.preview(PREVIEW_SIZE, { bw_mode: 0 }, path);
          lookMono.current.set(path, isMono(f));
          return f;
        } }];
      }
      const p = all.find((q) => `p:${q.id}` === key);
      return p ? [{ key, run: () => s.preview(PREVIEW_SIZE, p.values) }] : [];
    }));
  };
  const presetsRef = useRef<Preset[]>([]);
  presetsRef.current = presets;
  const newPhotosRef = useRef(newPhotos);
  newPhotosRef.current = newPhotos;
  // a shape drawn on the image: a new mask, or added to (or taken from) the
  // one being edited
  // returns the mask it went to
  // a new mask is named after what it is (`label`, or its shape's kind),
  // and the first of that name becomes "<name> 1" when a second arrives
  const createShape = (shape: Shape, target: ToolTarget = toolTarget, label?: string): string | null => {
    const s = session.current;
    if (!s) return null;
    leaveBefore();
    record(["mask:create"]);
    const m = s.masks.find((x) => x.name === maskSel);
    let name: string;
    if (target === "new" || !m) {
      const base = label ?? maskKindName(shape);
      name = nextMaskName(s.masks, base);
      if (name !== base && s.masks.some((x) => x.name === base)) {
        s.renameMask(base, `${base} 1`);
        if (maskSel === base) setMaskSel(`${base} 1`);
      }
      s.addMask(name, [{ ...shape, mode: undefined }]);
      setMaskSel(name);
      setFreshMask((f) => ({ name, n: (f?.n ?? 0) + 1 }));
      setShapeSel(0);
      setToolTarget("add");
    } else {
      name = m.name;
      // drawn as it reads on what is shown, which an inverted mask turns round
      const shown = target === "subtract" ? "subtract" : shape.mode ?? "add";
      const mode = m.invert ? flipMode(shown) : shown;
      s.setShapes(m.name, [...m.shapes, { ...shape, mode } as Shape]);
      setShapeSel(m.shapes.length);
    }
    syncMasks();
    overlayEvent("stroke");
    // a gradient is edited by its handles once drawn; the brush keeps painting
    if (shape.type !== "brush") setMaskTool(null);
    return name;
  };
  // a new spot copies from where the engine finds surroundings most like
  // its own; it can be moved after
  const createSpot = async (spot: NewSpot) => {
    const s = session.current;
    if (!s) return;
    leaveBefore();
    try {
      const { sx, sy } = await invoke<{ sx: number; sy: number }>("spot_source", { spot });
      record(["spot:create"]);
      s.setSpots([...s.spots, { ...spot, sx, sy } as Spot]);
      setSpotSel(s.spots.length - 1);
      syncSpots();
    } catch (e) {
      setStatus(`heal: ${e}`);
    }
  };
  const editSpots = (next: Spot[], key: string) => {
    const s = session.current;
    if (!s || JSON.stringify(next) === JSON.stringify(s.spots)) return;
    record([key]);
    s.setSpots(next);
    syncSpots();
  };
  const deleteSpot = () => {
    const s = session.current;
    if (!s || spotSel === null) return;
    editSpots(s.spots.filter((_, i) => i !== spotSel), "spot:delete");
    setSpotSel(null);
  };
  // a range tool's click: what the mask instances see there, as a band
  // around it; a mask holds one range of each kind, as darktable does
  const pickRange = async (x: number, y: number) => {
    const s = session.current, tool = maskTool;
    if (tool === "depth") { pickDepth(x, y); return; }
    if (!s || (tool !== "color" && tool !== "luminance")) return;
    try {
      const v = await invoke<{ ev: number; hue: number; chroma: number }>("sample", { x, y });
      const r: Range = tool === "luminance"
        ? { type: "luminance", lo: v.ev - 1, hi: v.ev + 1, feather: 1 }
        : { type: "color", hue: v.hue, width: 0.04, feather: 0.04, chroma: v.chroma * 0.5 };
      const m = s.masks.find((q) => q.name === maskSel);
      // on a mask with a Parametric component, the pick sets its channels
      const par = m && toolTarget !== "new" ? m.shapes.findIndex((q) => q.type === "parametric") : -1;
      if (m && par >= 0) {
        editParametric(par, { ...(m.shapes[par] as ParametricRange).channels, ...rangeChannels(r as Exclude<Range, ParametricRange>) },
                       "mask:range");
        setShapeSel(par);
        setMaskTool(null);
        return;
      }
      const same = m && toolTarget !== "new" ? m.shapes.findIndex((q) => q.type === r.type) : -1;
      if (m && same >= 0) {
        record(["mask:range"]);
        s.setShapes(m.name, m.shapes.map((q, i) => (i === same ? r : q)));
        setShapeSel(same);
        syncMasks();
        setMaskTool(null);
      } else createShape(r);
    } catch (e) {
      setStatus(`sample: ${e}`);
    }
  };
  // a Parametric component: darktable's parametric mask, alone on a new mask
  // or narrowing the selected one's shapes. it takes over the mask's
  // luminance and color ranges, which would write the same channels
  const addParametric = (target: ToolTarget) => {
    const s = session.current;
    if (!s) return;
    const m = s.masks.find((q) => q.name === maskSel);
    if (target === "new" || !m) {
      createShape({ type: "parametric", channels: {} });
      return;
    }
    const at = m.shapes.findIndex((q) => q.type === "parametric");
    if (at >= 0) { setShapeSel(at); setMaskTool(null); return; }
    let channels: ParametricRange["channels"] = {};
    for (const q of m.shapes) if (q.type === "luminance" || q.type === "color") channels = { ...channels, ...rangeChannels(q) };
    const kept = m.shapes.filter((q) => q.type !== "luminance" && q.type !== "color");
    if (!kept.length) { createShape({ type: "parametric", channels }); return; }
    record(["mask:create"]);
    s.setShapes(m.name, [...kept, { type: "parametric", channels }]);
    setShapeSel(kept.length);
    setMaskTool(null);
    syncMasks();
  };
  const editParametric = (k: number, channels: ParametricRange["channels"], key = `mask:parametric:${maskSel}`) => {
    const s = session.current, m = s?.masks.find((x) => x.name === maskSel);
    if (!s || !m || m.shapes[k]?.type !== "parametric") return;
    refined();
    record([key]);
    s.setShapes(m.name, m.shapes.map((x, i) => (i === k ? { ...x, channels } as Shape : x)));
    syncMasks();
  };
  // the set range picker: the channel's markers just outside what the box
  // (or a few pixels round a click) holds, its polarity set to take it in;
  // a hue band across 0/1 is the complement, turned round (blend_gui.c's
  // blend_color_picker_apply)
  const pickArea = async (area: [number, number, number, number] | null, [x, y]: [number, number]) => {
    const m = session.current?.masks.find((q) => q.name === maskSel);
    const k = m?.shapes.findIndex((q) => q.type === "parametric") ?? -1;
    if (!m || k < 0) return;
    try {
      const v = await invoke<{ channels: Picked }>("sample", { x, y, area });
      const r = v.channels[pickChan];
      const par = m.shapes[k] as ParametricRange;
      if (!r) return;
      const cur = par.channels[pickChan] ?? { p: [0, 0, 1, 1], invert: false, boost: pickChan === "Jz" || pickChan === "Cz" ? -6.64385619 : 0 };
      const scale = (u: number) => (pickChan === "hz" ? u : u / 2 ** cur.boost);
      let lo = scale(r.min), hi = scale(r.max);
      const wrap = lo > hi;
      if (wrap) [lo, hi] = [hi, lo];
      const c = (u: number) => Math.min(1, Math.max(0, u));
      const p: ChannelRange["p"] = [c(lo - 0.01), c(lo + 0.01), c(hi - 0.01), c(hi + 0.01)];
      if (p[1] > p[2]) { p[1] = c(lo); p[2] = c(hi); }
      p[0] = Math.min(p[0], p[1]);
      p[3] = Math.max(p[3], p[2]);
      editParametric(k, { ...par.channels, [pickChan]: { ...cur, p, invert: wrap } }, "mask:range");
      setMaskTool(null);
    } catch (e) {
      setStatus(`sample: ${e}`);
    }
  };
  // the show picker's reading under the pointer: one request at a time,
  // the latest point taken when it is in
  const hoverAt = useRef<[number, number] | null>(null);
  const hoverBusy = useRef(false);
  const hoverPick = (at: [number, number] | null) => {
    hoverAt.current = at;
    if (!at) { setPicked(null); return; }
    if (hoverBusy.current) return;
    hoverBusy.current = true;
    void (async () => {
      try {
        while (hoverAt.current) {
          const [x, y] = hoverAt.current;
          const v = await invoke<{ channels: Picked }>("sample", { x, y });
          if (hoverAt.current) setPicked(v.channels);
          if (hoverAt.current && hoverAt.current[0] === x && hoverAt.current[1] === y) break;
        }
      } catch {
        // no reading where the pointer is; the band waits for the next
      } finally {
        hoverBusy.current = false;
      }
    })();
  };
  // the AI object tool: the engine segments the photo (a few seconds the
  // first time, while it reads the photo) and replies with an outline
  const [aiBusy, setAiBusy] = useState(false);
  // an AI selection: its model installed first (downloaded on first use,
  // with the Rust side reporting progress), then run, then the outline
  // added as an object shape
  const runAi = async (model: string, working: string, run: () => Promise<ObjectShape["paths"]>,
                       done: (paths: ObjectShape["paths"]) => void) => {
    if (!session.current || aiBusy) return;
    setAiBusy(true);
    const stop = await listen<{ stage: string; mb?: number }>("ai-model", (e) => {
      const p = e.payload;
      setStatus(p.stage === "downloading" ? `downloading the AI model (${p.mb ?? "?"} MB), first use only…`
              : p.stage === "installing" ? "installing the AI model…" : working);
    });
    try {
      const paths = await withModel(model, () => { setStatus(working); return run(); });
      if (!paths.length) setStatus("nothing found");
      else { done(paths); setStatus(""); }
    } catch (e) {
      setStatus(`AI mask: ${e}`);
    } finally {
      stop();
      setAiBusy(false);
    }
  };
  // AI work runs for seconds: the viewer's busy indicator shows meanwhile
  useEffect(() => {
    if (!aiBusy) return;
    const job = begin();
    return () => end(job);
  }, [aiBusy]);
  const working = useWorking();
  // AI Denoise: darktable's raw denoise writes a DNG beside the raw with its
  // edit (the engine's ai_denoise), shown after it in the folder as an Edit
  // In result, and opened with noise reduction off, as the model did that
  const [denoising, setDenoising] = useState(false);
  // its model, downloaded on first use, for the dialog's preview
  const denoiseModel = async () => {
    const stop = await listen<{ stage: string; mb?: number }>("ai-model", (e) => {
      const p = e.payload;
      setStatus(p.stage === "downloading" ? `downloading the AI model (${p.mb ?? "?"} MB), first use only…`
              : p.stage === "installing" ? "installing the AI model…" : "");
    });
    try {
      await invoke("ai_model_ensure", { id: "rawdenoise-nind" });
    } finally {
      stop();
    }
  };
  // the dialog's piece starts where the view is: the middle of the zoomed
  // window, or of the photo
  const viewCenter = () => {
    const p = placementRef.current;
    if (zoom === "fit" || !p || p.scale <= 0) return { u: 0.5, v: 0.5 };
    return { u: clamp01((p.x + p.width / 2) / (p.fullWidth * p.scale)),
             v: clamp01((p.y + p.height / 2) / (p.fullHeight * p.scale)) };
  };
  const runDenoise = async (amount: number) => {
    if (!session.current || aiBusy) return;
    setAiBusy(true);
    const working = "AI Denoise: writing a denoised DNG, up to a minute…";
    const stop = await listen<{ stage: string; mb?: number }>("ai-model", (e) => {
      const p = e.payload;
      setStatus(p.stage === "downloading" ? `downloading the AI model (${p.mb ?? "?"} MB), first use only…`
              : p.stage === "installing" ? "installing the AI model…" : working);
    });
    try {
      const r = await withModel("rawdenoise-nind", () => {
        setStatus(working);
        return invoke<{ path: string; original: string; image: { imgid: number } }>(
          "ai_denoise", { strength: amount / 100 });
      });
      returns.current.set(r.path, { original: r.original, result: r.path, plugin: "ai-denoise", applied: true });
      if (folderRef.current && !immichRef.current) await showFolder(folderRef.current, true);
      await openFile(r.path, r.image.imgid);
      if (currentRef.current?.path === r.path) {
        changeMany([["nr_luminance", 0], ["nr_color", 0]], "AI Denoise: noise reduction off");
        setStatus(`AI Denoise: opened ${baseName(r.path)}`);
      }
    } catch (e) {
      setStatus(`AI Denoise: ${e}`);
    } finally {
      stop();
      setAiBusy(false);
    }
  };
  const selectObject = (prompt: ObjectPrompt) => runAi("mask-object-sam21-small", "finding the object…",
    () => invoke<ObjectShape["paths"]>("ai_object", { points: prompt.points ?? [], box: prompt.box ?? null }),
    (paths) => { createShape({ type: "object", paths }); });
  // the one-click selections: Subject, Background, which is the subject's
  // outline in a new mask, inverted, and People and the parts of a
  // landscape, which all come from the one scene model
  const scene = (what: string) => ({ model: "mask-scene-segformer-b2", working: `finding ${what}…` });
  const AI_KINDS: Record<AiKind, { model: string; kind: string; working: string; label: string }> = {
    subject: { model: "mask-subject-birefnet-lite", kind: "subject", working: "finding the subject…", label: "Subject" },
    background: { model: "mask-subject-birefnet-lite", kind: "subject", working: "finding the background…",
                  label: "Background" },
    people: { kind: "people", ...scene("people"), label: "People" },
    sky: { kind: "sky", ...scene("the sky"), label: "Sky" },
    water: { kind: "water", ...scene("water"), label: "Water" },
    vegetation: { kind: "vegetation", ...scene("vegetation"), label: "Vegetation" },
    mountains: { kind: "mountains", ...scene("mountains"), label: "Mountains" },
    ground: { kind: "ground", ...scene("natural ground"), label: "Natural Ground" },
    architecture: { kind: "architecture", ...scene("architecture"), label: "Architecture" },
    artificial_ground: { kind: "artificial_ground", ...scene("artificial ground"), label: "Artificial Ground" },
  };
  const selectAi = (k: AiKind, target: ToolTarget) => {
    const a = AI_KINDS[k];
    return runAi(a.model, a.working,
      () => invoke<ObjectShape["paths"]>("ai_mask", { kind: a.kind }),
      (paths) => {
        const name = createShape({ type: "object", paths }, k === "background" ? "new" : target, a.label);
        if (k === "background" && name) session.current?.setInvert(name, true);
        syncMasks();
      });
  };
  // Depth Range: the depth where the image was clicked, give or take, as a
  // shape traced by the engine around that band of its depth map
  const DEPTH_MODEL = "mask-depth-da2-small";
  const pickDepth = (x: number, y: number) => {
    let depth: [number, number] = [0, 1];
    void runAi(DEPTH_MODEL, "finding depth…", async () => {
      const map = await track(invoke<{ width: number; height: number; data: number[] }>("ai_depth", { size: 256 }));
      const i = Math.min(map.width - 1, Math.floor(x * map.width)), j = Math.min(map.height - 1, Math.floor(y * map.height));
      const d = map.data[j * map.width + i] / 255;
      depth = [Math.max(0, d - 0.15), Math.min(1, d + 0.15)];
      return invoke<ObjectShape["paths"]>("ai_mask", { kind: "depth", range: depth });
    }, (paths) => { createShape({ type: "object", paths, depth, feather: 0.01 }); });
  };
  // a Depth Range's sliders: the band traced again (a few ms once the
  // depth map is made); a reply overtaken by a newer move is dropped
  const depthToken = useRef(0);
  const editDepth = async (k: number, depth: [number, number], feather: number) => {
    const s = session.current, name = maskSel;
    if (!s || !name) return;
    const token = ++depthToken.current;
    try {
      const paths = await invoke<ObjectShape["paths"]>("ai_mask", { kind: "depth", range: depth });
      const m = s.masks.find((x) => x.name === name);
      if (token !== depthToken.current || !m || m.shapes[k]?.type !== "object") return;
      record([`mask:depth:${name}`]);
      s.setShapes(name, m.shapes.map((x, i) => (i === k ? { ...x, paths, depth, feather } as Shape : x)));
      syncMasks();
    } catch (e) {
      setStatus(`depth range: ${e}`);
    }
  };
  const editShapes = (f: (shapes: Shape[]) => Shape[]) => {
    const s = session.current, m = s?.masks.find((x) => x.name === maskSel);
    if (!s || !m) return;
    record([`mask:shapes:${m.name}`]);
    s.setShapes(m.name, f(m.shapes));
    syncMasks();
  };
  const deleteMask = (name: string) => {
    record(["mask:delete"]);
    session.current?.deleteMask(name);
    syncMasks();
    if (maskSel === name) { setMaskSel(null); setMaskTool(null); }
  };
  // a copy of a mask, inverted or not, to add to and take from on its own
  const duplicateMask = (name: string, invert: boolean) => {
    const s = session.current;
    if (!s) return;
    record(["mask:create"]);
    const to = nextMaskName(s.masks, `${name} copy`);
    s.duplicateMask(name, to);
    if (invert) s.setInvert(to, !s.masks.find((m) => m.name === to)!.invert);
    syncMasks();
    setMaskSel(to);
    setShapeSel(0);
  };
  // K and M pick a tool from anywhere, as in Lightroom
  const pickMaskTool = (t: MaskTool) => {
    if (!session.current) return;
    if (rightMode !== "masks") showRight("masks");
    setMaskTool(t);
    setToolTarget(maskSel ? "add" : "new");
  };
  // everything back to the image's defaults: sliders, crop, look and masks
  // one undo step
  const resetAll = () => {
    const s = session.current;
    if (!s) return;
    record(["reset"]);
    holdRecord.current = true;
    try {
      // the modules, profile and exposure compensation are the photo's own,
      // not adjustments; the orientation stays too, as in Lightroom
      changeMany(Object.entries(s.neutral).filter(([id]) => !isModuleSetting(id) && id !== "profile"
                                                            && id !== "exp_comp" && id !== "orient"));
      if (s.look) applyLook(null);
      for (const m of s.masks) s.deleteMask(m.name);
      if (s.spots.length) s.setSpots([]);
    } finally {
      holdRecord.current = false;
    }
    syncMasks();
    syncSpots();
    setSpotSel(null);
    setMaskSel(null);
    setMaskTool(null);
  };
  // a preset or look under the pointer, previewed over the image: a render
  // on the engine's preview pipe, so the edit itself is untouched. the
  // Presets panel's tiles, or a panel's swatches (the B&W filters, grain)
  const hoverCanvas = useRef<HTMLCanvasElement>(null);
  const [hoverShown, setHoverShown] = useState<"tiles" | "panel" | false>(false);
  const hoverToken = useRef(0);
  const hoverTile = (key: string | null) => {
    const all = [...BUILTIN_PRESETS, ...presetsRef.current];
    const p = key?.startsWith("p:") ? all.find((q) => `p:${q.id}` === key) : null;
    // a color look as it will be once chosen; a black and white one over
    // the photo's own B&W Mix
    const lookValues = (path: string): Values => (lookMono.current.get(path) === false ? { bw_mode: 0 } : {});
    showHover(!key ? null : "tiles", (s, size) =>
      key!.startsWith("l:") ? s.preview(size, lookValues(key!.slice(2)), key!.slice(2))
        : p ? s.preview(size, p.values) : null);
  };
  const hoverValues = (values: Values | null) =>
    showHover(values && "panel", (s, size) => s.preview(size, values!));
  const showHover = (from: "tiles" | "panel" | null,
                     render: (s: Session, size: number) => Promise<Frame> | null) => {
    const token = ++hoverToken.current;
    if (!from) { setHoverShown(false); return; }
    window.setTimeout(async () => {
      const s = session.current;
      if (!s || token !== hoverToken.current) return;
      const { w, h } = viewport();
      const size = Math.min(1600, Math.max(w, h));
      try {
        const r = render(s, size);
        const f = r && await track(r);
        const c = hoverCanvas.current;
        if (!f || !c || token !== hoverToken.current) return;
        c.width = f.width;
        c.height = f.height;
        c.getContext("2d")!.putImageData(new ImageData(f.pixels, f.width, f.height), 0, 0);
        placeLayers();
        setHoverShown(from);
      } catch {
        // no preview: the image stays as it is
      }
    }, 250);
  };

  // a preset's strength, as Lightroom's Amount: between the settings before
  // it was applied (0) and the preset's own (100), and beyond, to 200.
  // switches and choices take the preset's setting at any amount above 0
  const [amount, setAmount] = useState<{ name: string; value: number; before: Values; preset: Values } | null>(null);
  const isStepped = (id: string) => {
    const c = controlById.get(id);
    return !c || c.kind === "choice" || c.kind === "toggle" || id.endsWith("pn") || id === "tc_mode";
  };
  const applyPreset = (preset: Preset) => {
    const s = session.current;
    if (!s) return;
    const p = { ...preset, values: presetValues(preset) };
    const before = Object.fromEntries(Object.keys(p.values).map((id) => [id, s.values[id]]));
    changeMany(Object.entries(p.values), `Preset: ${p.name}`);
    setAmount({ name: p.name, value: 100, before, preset: p.values });
  };
  const changeAmount = (v: number) => {
    if (!amount) return;
    const a = v / 100;
    changeMany(Object.entries(amount.preset).map(([id, pv]) => {
      const b = amount.before[id] ?? pv;
      if (isStepped(id)) return [id, a > 0 ? pv : b];
      const c = controlById.get(id)!;
      return [id, Math.min(c.max, Math.max(c.min, b + (pv - b) * a))];
    }), `Preset: ${amount.name}`);
    setAmount({ ...amount, value: v });
  };

  // a color look on a black and white photo makes it color, in the same
  // undo step: the photo then looks as the look's tile did
  const applyLook = async (l: Look | null) => {
    const s = session.current;
    if (!s) return;
    let toColor = false;
    if (l && s.values.bw_mode === 1) {
      let mono = lookMono.current.get(l.path);
      if (mono === undefined) {
        try {
          mono = isMono(await s.preview(64, { bw_mode: 0 }, l.path));
          lookMono.current.set(l.path, mono);
        } catch { mono = true; }
        if (session.current !== s) return;
      }
      toColor = !mono;
    }
    leaveBefore();
    baseStale.current = true;
    record(["look"]);
    if (toColor) {
      holdRecord.current = true;
      try { changeMany([["bw_mode", 0]]); } finally { holdRecord.current = false; }
    }
    s.setLook(l?.path ?? null, l?.name ?? null);
    setLookState(l?.name ?? null);
    setLookAmount(100);
  };
  const storePresets = (next: Preset[]) => {
    setPresets(next);
    savePresets(next).catch((e) => setStatus(`presets: ${e}`));
  };
  // sharing: a preset or a look to a file, or files' presets and looks in
  const safeName = (name: string) => name.replace(/[/\\:*?"<>|]+/g, "_");
  const reloadLooks = async () => {
    const l = await loadLooks();
    looksRef.current = l;
    setLooks(l);
  };
  const exportPreset = async (p: Preset) => {
    const path = await save({ defaultPath: `${safeName(p.name)}.json`, filters: [{ name: "Immage preset", extensions: ["json"] }] });
    if (!path) return;
    await invoke("preset_file_write", { path, contents: sharedPresets([p]) })
      .then(() => setStatus(`exported "${p.name}"`), (e) => setStatus(`export preset: ${e}`));
  };
  const exportLook = async (l: Look) => {
    const path = await save({ defaultPath: `${safeName(l.name)}.dtstyle`,
                              filters: [{ name: "darktable style", extensions: ["dtstyle"] }] });
    if (!path) return;
    await invoke("look_export", { from: l.path, to: path })
      .then(() => setStatus(`exported "${l.name}"`), (e) => setStatus(`export look: ${e}`));
  };
  const deleteLook = async (l: Look) => {
    try {
      await invoke("look_delete", { path: l.path });
      // a photo wearing it keeps it, as its edit holds the look; only putting
      // it back on after the Before view needs the file
      if (session.current?.lookPath === l.path) session.current.lookPath = null;
      await reloadLooks();
    } catch (e) { setStatus(`delete look: ${e}`); }
  };
  const importShared = async () => {
    const picked = await open({ multiple: true, filters: [{ name: "Presets and looks", extensions: ["json", "dtstyle"] }] });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    let added: Preset[] = [];
    let looksIn = 0;
    const failed: string[] = [];
    for (const path of paths) {
      try {
        if (/\.dtstyle$/i.test(path)) {
          await invoke<string>("look_import", { path });
          looksIn++;
        } else {
          const got = readSharedPresets(await invoke("preset_file_read", { path }), [...BUILTIN_PRESETS, ...presets, ...added]);
          if (!got.length) throw new Error("it has no presets this version can use");
          added = [...added, ...got];
        }
      } catch (e) {
        failed.push(`${path.split(/[/\\]/).pop()}: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (added.length) storePresets([...presets, ...added]);
    if (looksIn) await reloadLooks().catch((e) => failed.push(`looks: ${e}`));
    const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
    const done = [added.length && plural(added.length, "preset"), looksIn && plural(looksIn, "look")].filter(Boolean);
    if (done.length || failed.length)
      setStatus([done.length && `imported ${done.join(" and ")}`, ...failed].filter(Boolean).join("; "));
  };
  // the crop tool: while it is open the crop module is bypassed, so the
  // whole image shows under the rectangle, which is applied on Done
  const [cropping, setCropping] = useState(false);
  // the key handler is installed once; it reaches the latest of this
  const pickToolRef = useRef<(t: MaskTool) => void>(() => {});
  const masksModeRef = useRef(false);
  masksModeRef.current = masksMode && !cropping;
  const zonesModeRef = useRef(false);
  zonesModeRef.current = rightMode === "zones" && !cropping;
  // the Heal panel's keys: Escape deselects, Delete removes the spot, [ and ]
  // size the brush, A toggles Visualize Spots; true when the key was used
  const healModeRef = useRef(false);
  healModeRef.current = healMode && !cropping;
  const healKeyRef = useRef<(e: KeyboardEvent) => boolean>(() => false);
  healKeyRef.current = (e) => {
    if (e.key === "Escape" && spotSel !== null) { setSpotSel(null); return true; }
    if ((e.key === "Delete" || e.key === "Backspace") && spotSel !== null) { deleteSpot(); return true; }
    if (e.key === "a" || e.key === "A") { setVisualize((v) => (v === null ? 50 : null)); return true; }
    if (e.key === "[" || e.key === "]") {
      const f = e.key === "]" ? 1.15 : 1 / 1.15;
      setSpotTool((t) => ({ ...t, size: Math.min(0.2, Math.max(0.002, t.size * f)) }));
      return true;
    }
    return false;
  };
  // Lightroom's wheel over the image while a brush is in hand: its size,
  // or with ⇧ its feather; true when it took the wheel. a pinch (a wheel
  // event with ctrl) still zooms
  const brushWheelRef = useRef<(e: WheelEvent) => boolean>(() => false);
  brushWheelRef.current = (e) => {
    const brushing = masksModeRef.current && maskTool === "brush";
    if (e.ctrlKey || previewRef.current || (!brushing && !healModeRef.current)) return false;
    // macOS turns a ⇧ wheel sideways; about 40 per mouse notch, a notch
    // being one press of [ or ]; up grows the brush or its feather
    const d = Math.max(-50, Math.min(50, e.deltaY || e.deltaX));
    if (e.shiftKey) {
      const by = (-d / 40) * 0.05;
      if (brushing) setBrush((b) => ({ ...b, hardness: Math.min(1, Math.max(0, b.hardness - by)) }));
      else setSpotTool((t) => ({ ...t, feather: Math.min(1, Math.max(0, t.feather + by)) }));
    } else {
      const f = Math.pow(1.15, -d / 40);
      if (brushing) setBrush((b) => ({ ...b, size: Math.min(0.4, Math.max(0.005, b.size * f)) }));
      else setSpotTool((t) => ({ ...t, size: Math.min(0.2, Math.max(0.002, t.size * f)) }));
    }
    return true;
  };
  const showHealRef = useRef(() => {});
  showHealRef.current = () => { if (rightMode !== "heal" || !layout.right) showRight("heal"); };
  pickToolRef.current = pickMaskTool;
  const selMask = masks.find((m) => m.name === maskSel) ?? null;
  // a mask whose name the pointer rests on in the Masks panel: its overlay
  // shows over the image, whether or not overlays are on
  const [peekName, setPeekName] = useState<string | null>(null);
  const peekMask = masksMode ? masks.find((m) => m.name === peekName) ?? null : null;
  // a tool in hand to add to the selected mask or take from it: its overlay
  // shows whatever the toggle says, so the shape is drawn against what is
  // there, until O or an adjustment sets it aside (overlayStep)
  const addingTo = masksMode && !!maskTool && toolTarget !== "new" && !!selMask;
  const addingRef = useRef(false);
  addingRef.current = addingTo;
  const maskShown = overlayShown(maskOverlay, addingTo);
  const overlayEvent = (ev: "key" | "adjust" | "stroke") => setMaskOverlay((t) => overlayStep(t, addingRef.current, ev));
  // what O or an adjustment set aside lasts as long as the tool in hand
  useEffect(() => setMaskOverlay((t) => (t.hold ? { ...t, hold: null } : t)), [addingTo]);
  // the last full (not a drag's) sharp render's view, which a refined mask's
  // overlay is made for: its refinements depend on the scale
  const [shownView, setShownView] = useState<{ x: number; y: number; scale: number; width: number; height: number;
                                               fit: boolean } | null>(null);
  // the mask the range map was made for
  const [rangeFor, setRangeFor] = useState<string | null>(null);
  useEffect(() => {
    const s = session.current, f = full.current;
    const target = peekMask ?? selMask;
    const ranges = target?.shapes.filter(isRange) ?? [];
    if (!s || !f || !masksMode || (!maskShown && !peekMask && !refining) || !ranges.length) { setRangeMap(null); return; }
    let stale = false;
    const t = window.setTimeout(async () => {
      while (!s.idle && !stale) await new Promise((r) => setTimeout(r, 60));
      if (stale) return;
      const width = 320, height = Math.max(1, Math.round((width * f.h) / f.w));
      try {
        const buf = await track(invoke<ArrayBuffer>("range_map", { ranges, width, height }));
        if (!stale) {
          setRangeMap({ width, height, data: new Uint8Array(buf, 8) });
          setRangeFor(target!.name);
        }
      } catch (e) {
        setStatus(`range map: ${e}`);
      }
    }, 150);
    return () => { stale = true; window.clearTimeout(t); };
  }, [selMask, peekMask, values, look, masksMode, maskShown, refining]);
  // darktable's own mask, for the overlay of a refined mask: refinements
  // follow the photo's edges and detail, which the shapes cannot show.
  // fetched again as soon as the last one is in while sliders move, and the
  // last one stays up until the next arrives
  // zoomed in, a range mask's map too: the engine's ranges map is of the
  // whole image, too coarse for the part shown
  const wantsFinal = (m: Mask) => isRefined(m) || (!!shownView && !shownView.fit && m.shapes.some(isRange));
  const [finalMap, setFinalMap] = useState<{ name: string; map: RangeMap; session: Session } | null>(null);
  const finalWant = useRef(0);
  const finalBusy = useRef(false);
  const finalTarget = useRef("");
  const finalView = useRef(shownView);
  useEffect(() => {
    const s = session.current, f = full.current;
    const target = peekMask ?? selMask;
    if (!s || !f || !shownView || !masksMode || !target || !wantsFinal(target) || target.hidden
        || (!maskShown && !peekMask && !refining)) return;
    finalTarget.current = target.name;
    finalView.current = shownView;
    finalWant.current++;
    if (finalBusy.current) return;
    finalBusy.current = true;
    void (async () => {
      let done = 0;
      try {
        while (done < finalWant.current) {
          done = finalWant.current;
          // the mask's latest settings reach the engine first
          while (s.masksPending) await new Promise((r) => setTimeout(r, 30));
          const name = finalTarget.current, v = finalView.current!;
          // the window the sharp render shows, at its scale, so the
          // refinements come out as they did in it
          try {
            const buf = await track(invoke<ArrayBuffer>("mask_map", { name, width: v.width, height: v.height,
                                                                      view: { x: v.x, y: v.y, scale: v.scale } }));
            const head = new DataView(buf, 0, 8);
            const width = head.getUint32(0, true), height = head.getUint32(4, true);
            const fw = v.scale * f.w, fh = v.scale * f.h;
            const at: Region = [v.x / fw, v.y / fh, (v.x + width) / fw, (v.y + height) / fh];
            setFinalMap({ name, map: { width, height, data: new Uint8Array(buf, 8), at }, session: s });
            // keep showing it a moment once it is in
            if (refiningRef.current) refined();
          } catch {
            // a mask with no adjustment yet drives nothing: the shapes' overlay serves
            setFinalMap(null);
          }
        }
      } finally {
        finalBusy.current = false;
      }
    })();
  }, [selMask, peekMask, values, look, masksMode, maskShown, refining, shownView]);
  // the range masks' maps for their thumbnails in the panel, small, made
  // again when their ranges change
  const [thumbMaps, setThumbMaps] = useState<Record<string, RangeMap>>({});
  const thumbKeys = useRef<Record<string, string>>({});
  useEffect(() => {
    const s = session.current, f = full.current;
    if (!s || !f || !masksMode) return;
    const due = masks.filter((m) => m.shapes.some(isRange)
                                    && thumbKeys.current[m.name] !== JSON.stringify(m.shapes.filter(isRange)));
    if (!due.length) return;
    let stale = false;
    const t = window.setTimeout(async () => {
      for (const m of due) {
        while (!s.idle && !stale) await new Promise((r) => setTimeout(r, 60));
        if (stale) return;
        const ranges = m.shapes.filter(isRange), width = 64, height = Math.max(1, Math.round((width * f.h) / f.w));
        try {
          const buf = await track(invoke<ArrayBuffer>("range_map", { ranges, width, height }));
          if (stale) return;
          thumbKeys.current[m.name] = JSON.stringify(ranges);
          setThumbMaps((o) => ({ ...o, [m.name]: { width, height, data: new Uint8Array(buf, 8) } }));
        } catch {
          return;
        }
      }
    }, 400);
    return () => { stale = true; window.clearTimeout(t); };
  }, [masks, masksMode]);
  // the editor needs placing as soon as it appears
  // tiles show the image as edited, so an edit makes them stale; they are
  // redone once editing pauses, and only while the panel is on show
  const tilesShown = layout.right && rightMode === "presets" && !cropping;
  useEffect(() => {
    previews.current!.invalidate();
    if (!tilesShown) return;
    const t = window.setTimeout(requestTiles, 700);
    return () => window.clearTimeout(t);
  }, [values, look, masks, tilesShown]);
  const [cropRect, setCropRect] = useState<CropRect>(FULL);
  const [cropAspect, setCropAspect] = useState("original");
  const [cropPortrait, setCropPortrait] = useState(false);
  // the customs typed in before, and the photo's own when it is not one of
  // them; the custom entry row, while open
  const [cropCustoms, setCropCustoms] = useState<Aspect[]>(loadCustomAspects);
  const [cropOwn, setCropOwn] = useState<Aspect | null>(null);
  const [cropEntry, setCropEntry] = useState<[string, string] | null>(null);
  const cropChoices = cropOwn ? [...cropCustoms, cropOwn] : cropCustoms;
  const [cropBox, setCropBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const croppingRef = useRef(false);
  // Lightroom's Full Screen Preview (F): the photo alone on black, with the
  // window taken full screen unless it already was (preview_fullscreen in
  // main.rs, which also keeps the keyboard with the page)
  const [preview, setPreviewState] = useState(false);
  // the window in macOS full screen (or another platform's): the title bar goes
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const w = getCurrentWindow();
    const check = () => void w.isFullscreen().then(setFullscreen).catch(() => {});
    check();
    const off = w.onResized(check);
    return () => { void off.then((f) => f()); };
  }, []);
  const previewRef = useRef(false);
  const madeFullscreen = useRef(false);
  const setPreview = (on: boolean) => {
    if (on === previewRef.current) return;
    previewRef.current = on;
    if (on) {
      if (croppingRef.current) leaveCrop(true);
      setMaskTool(null);
      setPicking(false);
    }
    setPreviewState(on);
    const w = getCurrentWindow();
    if (on) {
      void w.isFullscreen().then((full) => {
        if (full || !previewRef.current) return;
        madeFullscreen.current = true;
        void invoke("preview_fullscreen", { on: true });
      });
    } else if (madeFullscreen.current) {
      madeFullscreen.current = false;
      void invoke("preview_fullscreen", { on: false });
    }
  };
  const cropRef = useRef({ rect: FULL, aspect: "original", portrait: false, choices: [] as Aspect[] });
  cropRef.current = { rect: cropRect, aspect: cropAspect, portrait: cropPortrait, choices: cropChoices };
  const [zoom, setZoomState] = useState<Zoom>("fit");
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [histogram, setHistogram] = useState<Histogram | null>(null);
  const placementRef = useRef<Placement | null>(null);
  const session = useRef<Session | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewer = useRef<HTMLDivElement>(null);
  // the edit's pane: the whole viewer, or its half beside the before
  const pane = useRef<HTMLDivElement>(null);
  const navThumb = useRef<HTMLCanvasElement>(null);
  // the viewer shows two layers placed by one view: `viewZ` device pixels
  // per image pixel, and `center`, the image point (0..1) at the viewer's
  // middle. under everything a whole-image "base" render; over it the last
  // sharp render of the visible part. zooming and panning only move the
  // layers; a sharp render is asked for once the view settles, and fades in.
  // `zoomRef` is the zoom renders are made for
  const zoomRef = useRef<Zoom>("fit");
  // the level last picked in the navigator, which Z toggles with fit
  const navZoom = useRef<Zoom>(1);
  // the toolbar's zoom bar, told of every step of a zoom without a render
  const zoomShow = useRef<((z: number, fit: boolean) => void) | null>(null);
  const center = useRef({ x: 0.5, y: 0.5 });
  const viewZ = useRef(0); // 0 until the first frame
  const full = useRef<{ w: number; h: number } | null>(null);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);
  // Lightroom's Straighten tool: a line drawn along what should be level
  // (or plumb), with ⇧ held or the crop tool's ruler armed; on release the
  // image turns by the line's angle off the nearest axis
  type Line = { x0: number; y0: number; x1: number; y1: number };
  const [line, setLine] = useState<Line | null>(null);
  const lineRef = useRef<Line | null>(null);
  const [straightening, setStraightening] = useState(false);
  // ⇧ held over the photo shows the straighten cursor before the drag
  const [shiftHeld, setShiftHeld] = useState(false);
  useEffect(() => {
    const on = (e: KeyboardEvent) => setShiftHeld(e.shiftKey);
    const off = () => setShiftHeld(false);
    window.addEventListener("keydown", on);
    window.addEventListener("keyup", on);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("keydown", on);
      window.removeEventListener("keyup", on);
      window.removeEventListener("blur", off);
    };
  }, []);
  const straighteningRef = useRef(false);
  straighteningRef.current = straightening;
  const baseCanvas = useRef<HTMLCanvasElement>(null);
  // the whole image at the zoom's scale (Session.onCopy), between the base
  // and the sharp frame: what a pan or a zoom brings into view is sharp
  const copyCanvas = useRef<HTMLCanvasElement>(null);
  const copyMeta = useRef<{ scale: number; width: number; height: number } | null>(null);
  const [copyOn, setCopyOn] = useState(false);
  // a copy dropped while its bitmap was being made is not drawn
  const copyGen = useRef(0);
  // Lightroom's clipping overlay, one layer over each image layer: shown
  // while its triangle is on (or J), or while the pointer rests on it
  const clipBase = useRef<HTMLCanvasElement>(null);
  const clipSharp = useRef<HTMLCanvasElement>(null);
  const [clipOn, setClipOn] = useState<ClipShow>({ low: false, high: false });
  const [clipPeek, setClipPeek] = useState<"low" | "high" | null>(null);
  const clipShown: ClipShow = { low: clipOn.low || clipPeek === "low", high: clipOn.high || clipPeek === "high" };
  const clipRef = useRef(clipShown);
  clipRef.current = clipShown;
  const paintClip = (layer: "base" | "sharp" | "both") => {
    const pairs: [HTMLCanvasElement | null, HTMLCanvasElement | null][] = [];
    if (layer !== "sharp") pairs.push([baseCanvas.current, clipBase.current]);
    if (layer !== "base") pairs.push([canvas.current, clipSharp.current]);
    for (const [src, dst] of pairs) if (src && dst) paintClipping(src, dst, clipRef.current);
  };
  useEffect(() => { paintClip("both"); }, [clipShown.low, clipShown.high]);
  const baseMeta = useRef<{ width: number; height: number } | null>(null);
  // a control in the panels, the histogram or the mask editor held down (or
  // a wheel turning one): frames are drafts until it lets go, and then one
  // full frame follows if a draft was shown
  const dragging = useRef(false);
  const draftShown = useRef(false);
  useEffect(() => {
    const DRAG_AREAS = ".panels, .histogram, .mask-box";
    let wheelTimer = 0;
    const end = () => {
      if (!dragging.current) return;
      dragging.current = false;
      if (draftShown.current) session.current?.requestRender();
    };
    const down = (e: PointerEvent) => {
      // a <select>'s native menu takes the pointer on macOS: its pointerup
      // never reaches the page, so a drag begun there would never end
      if ((e.target as Element).closest?.("select")) return;
      if (e.button === 0 && (e.target as Element).closest?.(DRAG_AREAS) && loadPreview() !== "quality") dragging.current = true;
    };
    const wheel = (e: WheelEvent) => {
      if (!(e.target as Element).closest?.(".panels, .histogram") || !loadSliderScroll() || loadPreview() === "quality") return;
      dragging.current = true;
      window.clearTimeout(wheelTimer);
      wheelTimer = window.setTimeout(end, 250);
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    window.addEventListener("wheel", wheel, { capture: true, passive: true });
    return () => {
      window.clearTimeout(wheelTimer);
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      window.removeEventListener("wheel", wheel, true);
    };
  }, []);
  const sharpMeta = useRef<{ x: number; y: number; scale: number; width: number; height: number } | null>(null);
  // edits since the base was rendered; set on open and on every change
  const baseStale = useRef(true);
  // the base is a fitted frame at the viewer's size, not yet the sharper
  // one zooming wants
  const baseLowRes = useRef(false);
  // the fitted frame the base, histogram and navigator were last made from
  const overviewHash = useRef<bigint | null>(null);
  const baseTimer = useRef(0);
  // the large whole-image render holds the engine, so it waits for a pause
  // in editing. a short one will do: an edit during it cancels it
  // (Session.pump, cancel_base), waiting at most for the module under way
  const scheduleBase = (delay: number) => {
    window.clearTimeout(baseTimer.current);
    baseTimer.current = window.setTimeout(() => {
      const s = session.current;
      if (!s) return;
      if (!s.idle) { scheduleBase(400); return; }
      if (baseStale.current || baseLowRes.current) s.requestThumb();
    }, delay);
  };
  // zoomed in, the whole image at the zoom's scale (100% above it), once
  // the base and the edits are done with; the session keeps one
  const copyTimer = useRef(0);
  const scheduleCopy = (delay: number) => {
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => {
      const s = session.current, f = full.current;
      if (!s || !f || zoomRef.current === "fit" || anim.current.raf) return;
      if (!s.idle) { scheduleCopy(400); return; }
      s.requestCopy(Math.min(1, scaleFor(zoomRef.current)), f);
    }, delay);
  };
  const MARGIN = 16; // CSS pixels around a fitted image
  // the vignette's guides, while its panel is open and it does something,
  // and Grain, which shares the panel, was not the last thing changed
  const [grainLast, setGrainLast] = useState(false);
  const vignetteGuides = rightMode === "adjust" && openPanels.has("effects") && !!values.vig_amount && !grainLast
    && !!current && !cropping && !preview;
  useEffect(() => { placeLayers(); }, [masksMode, healMode, current, cropping, vignetteGuides]);
  // the guides also show while a slider of the vignette's shape moves (not
  // Amount): until the button comes up after a drag, or a moment after a
  // wheel notch or a typed value
  const [vigSliding, setVigSliding] = useState(false);
  const vigButton = useRef(false);
  const vigTimer = useRef(0);
  // the Transform panel's grid shows the same way while its sliders move
  const [tfSliding, setTfSliding] = useState(false);
  const tfTimer = useRef(0);
  useEffect(() => {
    const down = () => { vigButton.current = true; };
    const up = () => { vigButton.current = false; setVigSliding(false); setTfSliding(false); };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    };
  }, []);
  const vigMoved = () => {
    setVigSliding(true);
    window.clearTimeout(vigTimer.current);
    if (!vigButton.current) vigTimer.current = window.setTimeout(() => setVigSliding(false), 800);
  };
  const tfMoved = () => {
    setTfSliding(true);
    window.clearTimeout(tfTimer.current);
    if (!vigButton.current) tfTimer.current = window.setTimeout(() => setTfSliding(false), 800);
  };

  const viewport = () => {
    const el = pane.current ?? viewer.current!;
    const dpr = window.devicePixelRatio || 1;
    return { w: Math.round(el.clientWidth * dpr), h: Math.round(el.clientHeight * dpr) };
  };

  const fitScale = () => {
    const f = full.current;
    if (!f) return 1;
    const { w, h } = viewport();
    const m = 2 * MARGIN * (window.devicePixelRatio || 1);
    return Math.min(1, (w - m) / f.w, (h - m) / f.h);
  };

  const scaleFor = (z: Zoom): number => {
    const f = full.current;
    if (z === "fit" || !f) return fitScale();
    const { w, h } = viewport();
    return z === "fill" ? Math.max(w / f.w, h / f.h) : z;
  };

  // the view at k times the full frame's size each way, k < 1 a drag's
  // during a zoom that renders ahead (animateTo), the view it ends on
  const viewAt = (k: number): View => {
    const { w, h } = viewport();
    const f = full.current;
    const a = anim.current;
    const ahead = !!a.raf && !!a.end;
    const zoom = ahead ? a.zoom : zoomRef.current, c = ahead ? a.end! : center.current;
    if (zoom === "fit" || !f) {
      const m = 2 * MARGIN * (window.devicePixelRatio || 1);
      const width = Math.min(MAX_PREVIEW, w - m), height = Math.min(MAX_PREVIEW, h - m);
      return k === 1 ? { width, height } : { width: Math.round(width * k), height: Math.round(height * k), draft: true };
    }
    const scale = scaleFor(zoom) * k;
    const view = {
      width: Math.round(w * k), height: Math.round(h * k), scale,
      x: Math.round(c.x * f.w * scale - (w * k) / 2),
      y: Math.round(c.y * f.h * scale - (h * k) / 2),
    };
    return k === 1 ? view : { ...view, draft: true };
  };
  // while a control is dragged, half the size each way (a quarter under
  // Performance): a quarter of the pixels for darktable's modules after the
  // one that changed, which is most of a frame's time
  const currentView = useCallback((): View => viewAt(dragging.current ? DRAFT[loadPreview()] : 1), []);

  const follow = (layer: HTMLCanvasElement, clip: HTMLCanvasElement | null) => {
    if (!clip) return;
    clip.style.width = layer.style.width;
    clip.style.height = layer.style.height;
    clip.style.transform = layer.style.transform;
  };

  // place both layers for the current view
  // the zones, while the Zone System is open: after an edit, once the
  // engine is idle, so a slider drag does not wait on them
  const zonesOpen = !!current && values.bw_mode === 1 && rightMode === "zones" && layout.right;
  // the part of the photo the Local tab narrows the zones to, and the AI
  // outlines found for this photo so far, by kind
  const [zonePart, setZonePart] = useState<ZonePart | null>(null);
  const [zoneAiPaths, setZoneAiPaths] = useState<Record<string, ObjectShape["paths"]>>({});
  // a new object being boxed on the photo
  const [zoneBoxing, setZoneBoxing] = useState(false);
  const zoneBoxingRef = useRef(false);
  zoneBoxingRef.current = zoneBoxing;
  useEffect(() => {
    setZoneData(null); setZonePinned(null); setZoneError(null); setZonePart(null); setZoneAiPaths({});
    setZoneBoxing(false);
  }, [current]);
  useEffect(() => { if (!zonesOpen) setZoneBoxing(false); }, [zonesOpen]);
  // its layer may come without the overlay's, which places it otherwise
  useEffect(() => { if (zoneBoxing) placeLayers(); }, [zoneBoxing]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const s = session.current, f = full.current;
    if (!s || !f || !zonesOpen) return;
    setZoneStale(true);
    let stale = false;
    const t = window.setTimeout(async () => {
      while ((!s.idle || s.masksPending) && !stale) await new Promise((r) => setTimeout(r, 60));
      if (stale) return;
      const width = 512, height = Math.max(1, Math.round((width * f.h) / f.w));
      try {
        const buf = await track(invoke<ArrayBuffer>("zones", { width, height, transition: DEFAULT_TRANSITION, stage: "before" }));
        const placed = offsetsOf(s.values).some((o) => o !== 0);
        const unplaced = placed
          ? await track(invoke<ArrayBuffer>("zones", { width, height, transition: DEFAULT_TRANSITION, stage: "unplaced" }))
          : null;
        if (stale || s !== session.current) return;
        setZoneData(parseZones(buf));
        setZoneUnplaced(unplaced ? parseZones(unplaced) : null);
        setZoneError(null);
        setZoneStale(false);
      } catch (e) {
        if (!stale) setZoneError(`${e}`);
      }
    }, 250);
    return () => { stale = true; window.clearTimeout(t); };
  }, [zonesOpen, current, values, look, masks]);
  // the zones' local adjustments: masks whose shape is a zone range
  const zoneMasks: ZoneMaskInfo[] = masks.flatMap((m) => {
    const z = zoneOfMask(m);
    return z ? [{ name: m.name, range: z.range, w: z.w, values: m.values, opacity: m.opacity ?? 100,
                  edge: (m.refine?.feather ?? 0) / 2.5, part: zonePartOf(m.name) }] : [];
  });
  const zoneMaskOf = (r: ZoneRange | null, part: ZonePart | null = zonePart) =>
    r ? zoneMasks.find((m) => m.range[0] === r[0] && m.range[1] === r[1] && samePart(m.part, part)) ?? null : null;
  // a part's outline: found for this photo, or kept by a zone mask of it
  const partPaths = (kind: string): ObjectShape["paths"] | null => {
    if (zoneAiPaths[kind]) return zoneAiPaths[kind];
    for (const z of zoneMasks) {
      if (z.part?.kind !== kind) continue;
      const o = masks.find((m) => m.name === z.name)?.shapes.find((x) => x.type === "object") as ObjectShape | undefined;
      if (o) return o.paths;
    }
    return null;
  };
  const pickZonePart = (kind: string | null, invert: boolean) => {
    setZoneBoxing(false);
    if (!kind) { setZonePart(null); return; }
    if (partPaths(kind)) { setZonePart({ kind, invert }); return; }
    const a = AI_KINDS[kind as AiKind];
    if (!a) return;
    void runAi(a.model, a.working, () => invoke<ObjectShape["paths"]>("ai_mask", { kind: a.kind }), (paths) => {
      setZoneAiPaths((old) => ({ ...old, [kind]: paths }));
      setZonePart({ kind, invert });
    });
  };
  // the objects boxed on this photo so far, or kept by its zone masks
  const zoneObjects = [...new Set([...Object.keys(zoneAiPaths), ...zoneMasks.flatMap((z) => (z.part ? [z.part.kind] : []))])]
    .filter((k) => k.startsWith("object:")).sort();
  const boxZoneObject = (prompt: ObjectPrompt) => {
    setZoneBoxing(false);
    const kind = nextObjectKind(zoneObjects);
    if (!kind) { setStatus("no more objects on this photo"); return; }
    const invert = zonePart?.invert ?? false;
    void runAi("mask-object-sam21-small", "finding the object…",
      () => invoke<ObjectShape["paths"]>("ai_object", { points: prompt.points ?? [], box: prompt.box ?? null }),
      (paths) => {
        setZoneAiPaths((old) => ({ ...old, [kind]: paths }));
        setZonePart({ kind, invert });
      });
  };
  // an edit of a run of zones' adjustment, its mask made on first use, in
  // the one undo step; narrowed to the chosen part of the photo, the AI
  // outline multiplying the zones' range in the engine
  const zoneEdit = (r: ZoneRange, what: string, edit: (s: Session, name: string) => void) => {
    const s = session.current;
    if (!s) return;
    let name = zoneMaskOf(r)?.name;
    const want = zoneMaskName(r, zonePart);
    const paths = zonePart ? partPaths(zonePart.kind) : null;
    if (!name && zonePart && !paths) { setStatus("choose the part of the photo again"); return; }
    record([`mask:${name ?? want}:${what}`]);
    if (!name) {
      name = s.masks.some((m) => m.name === want) ? nextMaskName(s.masks, want) : want;
      s.addMask(name, [zoneShape(r, LOCAL_TRANSITION) as Shape,
                       ...(paths ? [{ type: "object", paths, mode: zonePart!.invert ? "subtract" : "add" } as Shape] : [])]);
    }
    edit(s, name);
    syncMasks();
  };
  // the chosen part over the zones' grid, for the overlay and the preview
  const zoneCover = useMemo(() => {
    const d = zoneData, f = full.current;
    const paths = zonePart ? partPaths(zonePart.kind) : null;
    if (!d || !f || !zonePart || !paths) return null;
    const m: Mask = { name: "", invert: zonePart.invert, values: {},
                      shapes: [{ type: "object", paths } as Shape] };
    const c = new Float32Array(d.width * d.height);
    for (let j = 0; j < d.height; j++)
      for (let i = 0; i < d.width; i++)
        c[j * d.width + i] = maskAt(m, (i + 0.5) / d.width, (j + 0.5) / d.height, f.w, f.h, null);
    return c;
  }, [zoneData, zonePart?.kind, zonePart?.invert, zoneAiPaths, masks]);   // eslint-disable-line react-hooks/exhaustive-deps
  // the pinned overlay steps aside while its sliders move; the hovered one
  // shows anyway
  // the placement's transition while Placement is open: the pinned zones
  // show how much of a move each pixel follows
  const [placeReach, setPlaceReach] = useState<number | null>(null);
  const zoneShown = zonesOpen && zoneData && !cropping && !preview
    ? zoneHover ?? ((zoneOverlay.show && !adjusting) || refining ? zonePinned : null) : null;
  const zoneShownW = (zoneShown === zonePinned && zoneMaskOf(zonePinned)?.w) || DEFAULT_TRANSITION;
  useEffect(() => {
    const c = zoneCanvas.current;
    if (!c || !zoneData || !zoneShown) return;
    c.width = zoneData.width;
    c.height = zoneData.height;
    c.getContext("2d")!.putImageData(zoneShown === zonePinned && placeReach !== null
      ? paintWeights(zoneUnplaced ?? zoneData, placeTable(zoneShown, placeReach), overlayRgb(zoneOverlay), zoneOverlay.opacity)
      : paintRange(zoneData, zoneShown, zoneShownW, overlayRgb(zoneOverlay),
                   zoneOverlay.opacity, zoneShown === zonePinned ? zoneCover : null), 0, 0);
    placeLayers();
  }, [zoneData, zoneUnplaced, zoneShown?.[0], zoneShown?.[1], zoneShownW, zoneOverlay, zoneCover, placeReach]);   // eslint-disable-line react-hooks/exhaustive-deps
  // the ⌥-drag mask, made again as the slider moves: white where the module
  // acts. one request at a time, the latest values winning
  const detailWant = useRef(0);
  const detailBusy = useRef(false);
  const maskOp = optPreview?.kind === "mask" ? optPreview.op : null;
  useEffect(() => {
    const s = session.current, f = full.current;
    if (!s || !f || !maskOp) return;
    detailWant.current++;
    if (detailBusy.current) return;
    detailBusy.current = true;
    void (async () => {
      let done = 0;
      try {
        while (done < detailWant.current) {
          done = detailWant.current;
          // the slider's latest value reaches the engine first
          while (s.pending) await new Promise((r) => setTimeout(r, 30));
          const width = 640, height = Math.max(1, Math.round((width * f.h) / f.w));
          let data: Uint8Array;
          try {
            data = new Uint8Array(await invoke<ArrayBuffer>("mask_map", { op: maskOp, width, height }), 8);
          } catch {
            // no mask of its own (masking at 0): all of it, or none when off
            const on = mapsFor(maskOp).some((m) => m.enabled?.(s.values));
            data = new Uint8Array(width * height).fill(on ? 255 : 0);
          }
          const c = detailCanvas.current;
          if (!c) continue;
          c.width = width;
          c.height = height;
          const img = new ImageData(width, height);
          for (let k = 0; k < data.length; k++) {
            img.data[4 * k] = img.data[4 * k + 1] = img.data[4 * k + 2] = data[k];
            img.data[4 * k + 3] = 255;
          }
          c.getContext("2d")!.putImageData(img, 0, 0);
          placeLayers();
        }
      } finally {
        detailBusy.current = false;
      }
    })();
  }, [maskOp, values]);   // eslint-disable-line react-hooks/exhaustive-deps
  const placeLayers = () => {
    const f = full.current, z = viewZ.current;
    if (!f || !z || !viewer.current) return;
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = viewport();
    // where the image's top-left corner lands, in device pixels
    const ox = w / 2 - center.current.x * f.w * z, oy = h / 2 - center.current.y * f.h * z;
    const b = baseMeta.current, bc = baseCanvas.current;
    if (b && bc) {
      bc.style.width = `${b.width / dpr}px`;
      bc.style.height = `${b.height / dpr}px`;
      bc.style.transform = `translate(${ox / dpr}px, ${oy / dpr}px) scale(${(z * f.w) / b.width})`;
      follow(bc, clipBase.current);
    }
    const cm = copyMeta.current, cc = copyCanvas.current;
    if (cm && cc) {
      cc.style.width = `${cm.width / dpr}px`;
      cc.style.height = `${cm.height / dpr}px`;
      cc.style.transform = `translate(${ox / dpr}px, ${oy / dpr}px) scale(${z / cm.scale})`;
    }
    const s = sharpMeta.current, sc = canvas.current;
    if (s && sc) {
      const sx = ox + (s.x / s.scale) * z, sy = oy + (s.y / s.scale) * z;
      sc.style.width = `${s.width / dpr}px`;
      sc.style.height = `${s.height / dpr}px`;
      sc.style.transform = `translate(${sx / dpr}px, ${sy / dpr}px) scale(${z / s.scale})`;
      follow(sc, clipSharp.current);
    }
    const bm = beforeMeta.current, bcv = beforeCanvas.current;
    if (bm && bcv) {
      const sx = ox + (bm.x / bm.scale) * z, sy = oy + (bm.y / bm.scale) * z;
      bcv.style.width = `${bm.width / dpr}px`;
      bcv.style.height = `${bm.height / dpr}px`;
      bcv.style.transform = `translate(${sx / dpr}px, ${sy / dpr}px) scale(${z / bm.scale})`;
    }
    zoomShow.current?.(z, zoomRef.current === "fit");
    const hc = hoverCanvas.current;
    if (hc) {
      hc.style.left = `${ox / dpr}px`;
      hc.style.top = `${oy / dpr}px`;
      hc.style.width = `${(f.w * z) / dpr}px`;
      hc.style.height = `${(f.h * z) / dpr}px`;
    }
    // the mask editor and the zone overlay cover the whole image, wherever it is
    for (const mb of [maskBox.current, zoneBox.current, detailBox.current, guideBox.current]) {
      if (!mb) continue;
      mb.style.left = `${ox / dpr}px`;
      mb.style.top = `${oy / dpr}px`;
      mb.style.width = `${(f.w * z) / dpr}px`;
      mb.style.height = `${(f.h * z) / dpr}px`;
    }
  };

  // the view as the navigator and the crop tool read it
  const updatePlacement = () => {
    const f = full.current, z = viewZ.current;
    if (!f || !z) return;
    const { w, h } = viewport();
    const pl: Placement = {
      fullWidth: f.w, fullHeight: f.h, scale: z,
      x: center.current.x * f.w * z - w / 2, y: center.current.y * f.h * z - h / 2, width: w, height: h,
    };
    placementRef.current = pl;
    setPlacement(pl);
  };

  const paintFrame = useCallback((f: Frame) => {
    draftShown.current = !!f.view.draft;
    // the split view's before side: drawn on its own layer, and the session
    // goes back to the edit at once
    if (f.before && baModeRef.current !== "off") {
      const bc = beforeCanvas.current;
      if (bc) {
        bc.width = f.width;
        bc.height = f.height;
        bc.getContext("2d")!.putImageData(new ImageData(f.pixels, f.width, f.height), 0, 0);
        const scale = f.view.scale ?? f.width / f.fullWidth;
        beforeMeta.current = { x: f.x, y: f.y, scale, width: f.width, height: f.height };
      }
      session.current?.showBefore(null);
      placeLayers();
      return;
    }
    const c = canvas.current!;
    if (c.width !== f.width || c.height !== f.height) {
      c.width = f.width;
      c.height = f.height;
    }
    c.getContext("2d")!.putImageData(new ImageData(f.pixels, f.width, f.height), 0, 0);
    if (clipRef.current.low || clipRef.current.high) paintClip("sharp");
    full.current = { w: f.fullWidth, h: f.fullHeight };
    const scale = f.view.scale ?? f.width / f.fullWidth;
    sharpMeta.current = { x: f.x, y: f.y, scale, width: f.width, height: f.height };
    // a drag's frame is drawn once and placed; the histogram follows it. the
    // base, navigator, split view and fade wait for the full frame after
    if (f.view.draft) {
      if (f.view.scale === undefined && zoomRef.current === "fit" && !anim.current.raf) {
        viewZ.current = fitScale();
        center.current = { x: 0.5, y: 0.5 };
      }
      placeLayers();
      if (f.view.scale === undefined) setHistogram(perf.histogram(() => computeHistogram(f.pixels, f.width, f.height)));
      return;
    }
    const fit = f.view.scale === undefined;
    setShownView((v) => v && v.x === f.x && v.y === f.y && v.scale === scale && v.width === f.width
                        && v.height === f.height && v.fit === fit ? v : { x: f.x, y: f.y, scale, width: f.width, height: f.height, fit });
    // a fitted frame recenters the view, unless a zoom is under way. the
    // scale comes from the viewer as it is now: the frame may have been
    // asked for before a resize, or capped in size, and taking its scale
    // made the view jump once it landed
    if (f.view.scale === undefined && zoomRef.current === "fit" && !anim.current.raf) {
      viewZ.current = fitScale();
      center.current = { x: 0.5, y: 0.5 };
    }
    placeLayers();
    // the split view's before side follows the view: a new view asks for a
    // fresh one, once the view has settled
    if (baModeRef.current !== "off" && !f.before) {
      const b = beforeMeta.current;
      if (!b || b.x !== f.x || b.y !== f.y || Math.abs(b.scale - (f.view.scale ?? f.width / f.fullWidth)) > 1e-6
          || b.width !== f.width || b.height !== f.height) captureBefore(300);
    }
    // fade the sharp layer in over the base
    c.classList.remove("fade-in");
    void c.offsetWidth;
    c.classList.add("fade-in");
    updatePlacement();
    // a fitted frame is the whole image, so it serves as the base, the
    // histogram and the navigator straight away; the sharper base follows
    // once editing pauses
    // zoomed back out with nothing changed, the frame is that one again:
    // made the overview, it replaced the sharper base, which then had to be
    // rendered again
    const again = f.hash === overviewHash.current && !baseStale.current && !autoPending.current
      && !tonePending.current && !wbTarget.current;
    if (f.view.scale === undefined && !again) {
      showOverview(f);
      overviewHash.current = f.hash ?? null;
      // Performance's base is the viewer's size, which this frame already is
      baseLowRes.current = loadPreview() !== "performance";
      scheduleBase(500);
    } else if (f.view.scale !== undefined && baseStale.current) {
      scheduleBase(300);
    }
    if (f.view.scale !== undefined && !f.before) scheduleCopy(600);
    setStatus("");
  }, []);
  // timed for the performance overlay
  const drawFrame = useCallback((f: Frame) => {
    perf.drawStart(f.trace);
    try { paintFrame(f); } finally { perf.drawEnd(); }
  }, []);

  // the base: the whole image at about twice the viewer's size, which also
  // feeds the navigator and the histogram
  // the B&W Mix's Auto needs the image in color, which in black and white
  // only a render with the conversion bypassed shows: the next whole-image
  // frame after the bypass is read for the mix, then the conversion returns
  const autoPending = useRef(false);
  // Basic's Auto: the sliders follow the first frame rendered with AgX's
  // new range. `quiet` is a new photo's, its starting point rather than an
  // undo step; a photo opened meanwhile drops it
  const tonePending = useRef<{ s: Session; quiet: boolean; key: SceneKey } | null>(null);
  const quietly = (f: () => void) => {
    holdRecord.current = true;
    try { f(); } finally { holdRecord.current = false; }
  };
  const applyAutoTone = (px: Uint8ClampedArray, width: number, height: number) => {
    const t = tonePending.current;
    tonePending.current = null;
    if (!t || t.s !== session.current) return;
    const v = autoTone(px, width, height, t.key);
    if (!v) { setStatus("auto: nothing to measure"); return; }
    // part of the step Auto began
    quietly(() => changeMany(Object.entries(v)));
  };
  const runAutoTone = async (quiet = false) => {
    const s = session.current;
    if (!s || tonePending.current) return;
    const gone = () => session.current !== s;
    // AgX measures, and the sliders are judged, without the sliders' own work
    const zero = AUTO_TONE_IDS.map((id) => [id, 0] as [string, number]);
    if (quiet) quietly(() => changeMany(zero)); else changeMany(zero, "auto tone");
    try {
      // exposure before AgX measures its range, which follows it
      await s.settled();
      if (gone()) return;
      // the scene's tones at the tone mapper's input, where exposure lands
      const z = parseZones(await invoke<ArrayBuffer>("zones", { width: 320, height: 320, transition: DEFAULT_TRANSITION,
                                                                 stage: "after" }));
      if (gone()) return;
      const { exposure, ...key } = autoExposure(s.values.exposure, z);
      if (exposure !== s.values.exposure) quietly(() => changeMany([["exposure", exposure]]));
      let range: [string, number][] = [];
      if (s.values.tm_mode === 1) {
        await s.settled();
        if (gone()) return;
        const r = await invoke<{ black_ev: number; white_ev: number }>("agx_auto");
        if (gone()) return;
        range = [["agx_black", r.black_ev], ["agx_white", r.white_ev]];
      }
      tonePending.current = { s, quiet, key };
      baseStale.current = true;
      const changed = range.filter(([id, v]) => Math.abs(s.values[id] - v) >= 0.005);
      if (changed.length) {
        quietly(() => changeMany(changed));
      } else {
        // nothing new to render: the frame shown is the one to measure
        await s.settled();
        const bc = baseCanvas.current;
        if (bc?.width && !gone()) {
          const img = bc.getContext("2d")!.getImageData(0, 0, bc.width, bc.height);
          applyAutoTone(img.data, img.width, img.height);
        } else tonePending.current = null;
      }
    } catch (e) {
      tonePending.current = null;
      if (!gone()) setStatus(`auto: ${e}`);
    }
  };

  // Lightroom's Upright (the Transform panel): rotate and perspective
  // fitted to the photo's lines, or to the guides drawn with Guided, which
  // the Manual sliders then adjust on top of. Auto, Level, Vertical and Full
  // start the Manual sliders over, as Lightroom's do
  type Guide = [number, number, number, number];
  type UprightFit = { rotation: number; lensshift_v: number; lensshift_h: number };
  const UPRIGHT_FITS = ["", "auto", "guided", "level", "vertical", "full"];
  const [guiding, setGuiding] = useState(false);
  const guidingRef = useRef(false);
  guidingRef.current = guiding;
  const [uprightNote, setUprightNote] = useState<string | null>(null);
  const [uprightBusy, setUprightBusy] = useState(false);
  const uprightBusyRef = useRef(false);
  const guideBox = useRef<HTMLDivElement>(null);
  // the guides where they show, mapped from the input image after each frame
  const [guidesShown, setGuidesShown] = useState<Guide[]>([]);
  const baseOf = (r: UprightFit): [string, number][] =>
    [["tf_base_r", r.rotation], ["tf_base_v", r.lensshift_v], ["tf_base_h", r.lensshift_h]];
  const busyUpright = (on: boolean) => { uprightBusyRef.current = on; setUprightBusy(on); };

  const runUpright = async (mode: number) => {
    const s = session.current;
    if (!s || uprightBusyRef.current) return;
    setUprightNote(null);
    if (mode === UPRIGHT_GUIDED) {
      setStraightening(false);
      setGuiding(true);
      if (!s.values.tf_gn) setUprightNote("drag along lines that should be plumb or level");
      return;
    }
    setGuiding(false);
    if (mode === 0) {
      changeMany([["tf_upright", 0], ...baseOf({ rotation: 0, lensshift_v: 0, lensshift_h: 0 }), ["tf_gn", 0]],
                 "Upright Off");
      return;
    }
    busyUpright(true);
    try {
      await s.settled();
      if (session.current !== s) return;
      const r = await invoke<UprightFit>("upright", { mode: UPRIGHT_FITS[mode], aspect: uprightAspect(s.values, s.context) });
      if (session.current !== s) return;
      changeMany([["tf_upright", mode], ...baseOf(r), ["tf_gn", 0],
                  ["tf_vertical", 0], ["tf_horizontal", 0], ["tf_rotate", 0]], `Upright ${UPRIGHT_MODES[mode]}`);
    } catch (e) {
      if (session.current === s) setUprightNote(String(e));
    } finally {
      busyUpright(false);
    }
  };

  // Guided's guides changed: kept, and fitted once there are two
  const fitGuides = async (s: Session, next: Guide[]) => {
    const entries: [string, number][] = [["tf_upright", UPRIGHT_GUIDED], ["tf_gn", next.length],
      ...GUIDE_IDS.map((id, i) => [id, next[i >> 2]?.[i & 3] ?? 0] as [string, number])];
    let base = baseOf({ rotation: s.values.tf_base_r ?? 0, lensshift_v: s.values.tf_base_v ?? 0,
                        lensshift_h: s.values.tf_base_h ?? 0 });
    let note: string | null = null;
    if (next.length >= 2) {
      try {
        base = baseOf(await invoke<UprightFit>("upright", { mode: "guided", guides: next.flat(),
                                                             aspect: uprightAspect(s.values, s.context) }));
      } catch (e) { note = String(e); }
    } else {
      base = baseOf({ rotation: 0, lensshift_v: 0, lensshift_h: 0 });
      note = next.length ? "draw another guide: Guided needs at least two" : "drag along lines that should be plumb or level";
    }
    if (session.current !== s) return;
    setUprightNote(note);
    changeMany([...entries, ...base], "Guided Upright");
  };
  const commitGuide = async (index: number | null, shown: Guide) => {
    const s = session.current;
    if (!s || uprightBusyRef.current) return;
    busyUpright(true);
    try {
      await s.settled();
      if (session.current !== s) return;
      const p = await invoke<number[]>("points", { points: shown, to: "input" });
      const next = guidesOf(s.values);
      const guide = p.slice(0, 4) as Guide;
      if (index === null) {
        next.push(guide);
        if (next.length > MAX_GUIDES) next.shift();
      } else next[index] = guide;
      await fitGuides(s, next);
    } catch (e) {
      if (session.current === s) setUprightNote(String(e));
    } finally {
      busyUpright(false);
    }
  };
  const deleteGuide = async (index: number) => {
    const s = session.current;
    if (!s || uprightBusyRef.current) return;
    busyUpright(true);
    try {
      await s.settled();
      if (session.current === s) await fitGuides(s, guidesOf(s.values).filter((_, i) => i !== index));
    } finally {
      busyUpright(false);
    }
  };
  const guideKey = guiding ? GUIDE_IDS.slice(0, 4 * (values.tf_gn ?? 0)).map((id) => values[id]).join(",") : "";
  useEffect(() => {
    const s = session.current;
    const g = guiding && s ? guidesOf(s.values) : [];
    if (!s || !g.length) { setGuidesShown([]); return; }
    let live = true;
    void (async () => {
      await s.settled();
      const p = await invoke<number[]>("points", { points: g.flat(), to: "shown" });
      if (live && session.current === s) setGuidesShown(g.map((_, k) => p.slice(4 * k, 4 * k + 4) as Guide));
    })().catch(() => {});
    return () => { live = false; };
  }, [guiding, guideKey, baseTick, current]);
  const transformView = rightMode === "adjust" && openPanels.has("transform") && !!current && !cropping && !preview
    && (guiding || tfSliding);
  useEffect(() => { placeLayers(); }, [transformView]);
  // Guided ends when its panel closes or another tool takes the photo
  useEffect(() => {
    if (guiding && (rightMode !== "adjust" || !openPanels.has("transform") || cropping || !current)) setGuiding(false);
  }, [guiding, rightMode, openPanels, cropping, current]);

  // white balance from the image: a picked spot, or Auto's white patch. the
  // render bends the correction a little (tone mapping, saturation), so each
  // new whole-image frame refines it until the change is too small to see.
  // `anchor` is the camera's own setting when the camera balanced the photo
  // itself; Auto then only nudges it toward the estimate (anchored())
  const wbTarget = useRef<{ at: { ix: number; iy: number } | null; round: number; anchor: WB | null } | null>(null);
  const [picking, setPickingState] = useState(false);
  const pickingRef = useRef(false);
  const setPicking = (on: boolean) => { pickingRef.current = on; setPickingState(on); };

  const refineWB = (px: Uint8ClampedArray, width: number, height: number) => {
    const t = wbTarget.current, s = session.current;
    // a frame rendered before the last correction landed would be read
    // against the new values; the next one will do
    if (!t || !s || s.pending) return;
    const rgb = t.at ? sampleSpot(px, width, height, t.at.ix, t.at.iy) : whitePatch(px, width, height);
    const cur: WB = { temp: s.values.temp, tint: s.values.tint };
    const next = rgb && neutralize(cur, rgb);
    const settled = !!next && Math.abs(1e6 / next.temp - 1e6 / cur.temp) < 2 && Math.abs(next.tint - cur.tint) < 1;
    if (!next || settled || t.round >= 4) {
      wbTarget.current = null;
      if (!next && t.round === 0) {
        setStatus(t.at ? "pick a lighter spot, not a clipped or black one" : "no usable colors for auto");
        return;
      }
      if (t.anchor) {
        const a = anchored(t.anchor, next ?? cur);
        changeMany([["temp", a.temp], ["tint", a.tint]]);
      }
      return;
    }
    t.round++;
    changeMany([["temp", next.temp], ["tint", next.tint]]);
  };

  const startWB = async (at: { ix: number; iy: number } | null) => {
    const bc = baseCanvas.current, s = session.current;
    if (!bc || !bc.width || !s) return;
    let anchor: WB | null = null;
    if (!at) {
      // "Auto", "AUTO1", "Auto (white priority)": the camera judged the light
      const m = await invoke<{ image: { exif?: { white_balance?: string } } }>("meta", { imgid: s.imgid })
        .catch(() => null);
      if (session.current !== s) return;
      if (/^auto/i.test(m?.image.exif?.white_balance ?? "")) anchor = { temp: s.neutral.temp, tint: s.neutral.tint };
    }
    wbTarget.current = { at, round: 0, anchor };
    const img = bc.getContext("2d")!.getImageData(0, 0, bc.width, bc.height);
    refineWB(img.data, img.width, img.height);
  };

  const showOverview = useCallback((f: Frame) => {
    if (autoPending.current) {
      autoPending.current = false;
      const mix = autoMix(f.pixels, f.width, f.height);
      session.current?.bypass("colorequal", false);
      changeMany(Object.entries(mix));
    }
    baseStale.current = false;
    refineWB(f.pixels, f.width, f.height);
    if (tonePending.current && !session.current?.pending) applyAutoTone(f.pixels, f.width, f.height);
    const bc = baseCanvas.current;
    if (bc) {
      bc.width = f.width;
      bc.height = f.height;
      bc.getContext("2d")!.putImageData(new ImageData(f.pixels, f.width, f.height), 0, 0);
      if (clipRef.current.low || clipRef.current.high) paintClip("base");
      baseMeta.current = { width: f.width, height: f.height };
      setBaseTick((t) => t + 1);
    }
    full.current = { w: f.fullWidth, h: f.fullHeight };
    if (!viewZ.current) viewZ.current = fitScale();
    placeLayers();
    const t = navThumb.current;
    if (t && bc) {
      t.width = 400;
      t.height = Math.round((400 * f.height) / f.width);
      t.getContext("2d")!.drawImage(bc, 0, 0, t.width, t.height);
    }
    setHistogram(perf.histogram(() => computeHistogram(f.pixels, f.width, f.height)));
  }, []);

  // the size the base is rendered at: twice the viewer, within reason, and
  // only the viewer's size under Performance
  const baseSize = () => {
    const { w, h } = viewport();
    const side = Math.min(3072, (loadPreview() === "performance" ? 1 : 2) * Math.max(w, h));
    return { width: side, height: side };
  };

  // ease the view toward a zoom; anchored, an image point stays under a
  // screen point (the cursor) all the way. a zoom to one level renders the
  // view it ends on while it eases (`end`, read by viewAt), so the sharp
  // frame is ready when it settles; the wheel's target moves with every
  // notch, and it renders once settled
  type Anchor = { ix: number; iy: number; sx: number; sy: number };
  const anim = useRef<{ raf: number | null; target: number; zoom: Zoom; settleAt: number; anchor: Anchor | null;
                        end: { x: number; y: number } | null; asked: View | null }>(
    { raf: null, target: 0, zoom: "fit", settleAt: 0, anchor: null, end: null, asked: null });
  // the share of the way left that one frame eases: half the frames 0.3 took
  const ZOOM_EASE = 1 - 0.7 * 0.7;

  // the view's center that keeps the anchor under its screen point at zoom z
  const anchoredCenter = (an: Anchor, z: number) => {
    const f = full.current!, dpr = window.devicePixelRatio || 1;
    const { w, h } = viewport();
    return { x: clamp01(an.ix - ((an.sx - w / 2 / dpr) * dpr) / (f.w * z)),
             y: clamp01(an.iy - ((an.sy - h / 2 / dpr) * dpr) / (f.h * z)) };
  };

  const animateTo = (z: Zoom, anchor: Anchor | null = null, settleDelay = 0, ahead = true) => {
    const f = full.current;
    if (!f || !viewZ.current) {
      zoomRef.current = z; setZoomState(z); session.current?.requestRender();
      return;
    }
    const a = anim.current;
    a.target = scaleFor(z);
    a.zoom = z;
    a.anchor = anchor;
    a.settleAt = performance.now() + settleDelay;
    a.end = !ahead ? null : z === "fit" ? { x: 0.5, y: 0.5 }
          : anchor ? anchoredCenter(anchor, a.target) : { ...center.current };
    a.asked = null;
    const running = !!a.raf;
    // viewAt reads `end` only while the ease runs
    if (!running) a.raf = -1;
    if (ahead) {
      a.asked = currentView();
      session.current?.requestRender();
    }
    if (running) return;
    const step = () => {
      let zz = viewZ.current + (a.target - viewZ.current) * ZOOM_EASE;
      if (Math.abs(a.target - zz) < a.target * 0.002) zz = a.target;
      viewZ.current = zz;
      if (a.zoom === "fit") {
        center.current = { x: center.current.x + (0.5 - center.current.x) * ZOOM_EASE,
                           y: center.current.y + (0.5 - center.current.y) * ZOOM_EASE };
      } else if (a.anchor) {
        center.current = anchoredCenter(a.anchor, zz);
      }
      placeLayers();
      if (zz === a.target && performance.now() >= a.settleAt) {
        a.raf = null;
        if (a.zoom === "fit") center.current = { x: 0.5, y: 0.5 };
        placeLayers();
        zoomRef.current = a.zoom;
        setZoomState(a.zoom);
        updatePlacement();
        // the view rendered ahead is the one settled on, unless the window
        // changed meanwhile
        const asked = a.asked, now = currentView();
        a.end = a.asked = null;
        if (!asked || asked.width !== now.width || asked.height !== now.height || asked.scale !== now.scale
            || asked.x !== now.x || asked.y !== now.y || !!asked.draft !== !!now.draft) {
          session.current?.requestRender();
        }
        return;
      }
      a.raf = requestAnimationFrame(step);
    };
    a.raf = requestAnimationFrame(step);
  };

  // the image point under a viewer position (CSS pixels from its corner)
  // a point in the edit's pane; side by side, a point on the before half is
  // taken as the same point of the image on the after half
  const paneXY = (clientX: number, clientY: number) => {
    const r = (pane.current ?? viewer.current!).getBoundingClientRect();
    const x = clientX < r.left ? clientX - viewer.current!.getBoundingClientRect().left : clientX - r.left;
    return { sx: x, sy: clientY - r.top };
  };

  const imageAt = (sx: number, sy: number) => {
    const f = full.current!, z = viewZ.current, dpr = window.devicePixelRatio || 1;
    const { w, h } = viewport();
    return { ix: center.current.x + ((sx - w / 2 / dpr) * dpr) / (f.w * z),
             iy: center.current.y + ((sy - h / 2 / dpr) * dpr) / (f.h * z) };
  };

  const setZoom = (z: Zoom) => animateTo(z);

  // the next level in or out from the zoom shown, or being eased to. fit and
  // fill depend on the window, and a small photo's fit can be 100%, so the
  // levels go by scale and one the same as the current is skipped
  const stepZoom = (dir: 1 | -1) => {
    if (!full.current) return;
    const a = anim.current;
    const from = a.raf ? a.target : viewZ.current || scaleFor(zoomRef.current);
    const levels = KEY_ZOOMS.map((z) => ({ z, s: scaleFor(z) })).sort((p, q) => p.s - q.s);
    const next = dir > 0 ? levels.find((l) => l.s > from * 1.001)
                         : levels.reverse().find((l) => l.s < from / 1.001);
    if (next) animateTo(next.z);
  };

  const updateImages = (next: ImageEntry[]) => {
    imagesRef.current = next;
    setImages(next);
    const open = next.find((i) => isOpen(i));
    if (open) setOpenCell(open);
  };
  // one photo's fields, in the filmstrip and in the open photo's kept cell
  const patchImage = (imgid: number, fields: Partial<ImageEntry>) => {
    updateImages(imagesRef.current.map((i) => (i.imgid === imgid ? { ...i, ...fields } : i)));
    setOpenCell((c) => (c?.imgid === imgid ? { ...c, ...fields } : c));
  };

  // the Library panel's cards, each as it was left: Folders open until
  // folded, the others shut until opened
  const [leftOpen, setLeftOpen] = useState(() => new Set(LEFT_CARDS.filter((id) => {
    try {
      const v = localStorage.getItem(`immage.${id}.open`);
      return id === "folders" || id === "immich" ? v !== "0" : v === "1";
    } catch { return id === "folders" || id === "immich"; }
  })));
  // focus mode and ⌥ as for the right panel's panels (togglePanel)
  const toggleLeft = (id: LeftCard, alt = false) => setLeftOpen((old) => {
    const solo = focusMode ? !alt && !old.has(id) : alt;
    let next: Set<LeftCard>;
    if (solo) next = new Set(old.has(id) && old.size === 1 ? [] : [id]);
    else { next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); }
    try { for (const c of LEFT_CARDS) localStorage.setItem(`immage.${c}.open`, next.has(c) ? "1" : "0"); } catch { /* not kept */ }
    return next;
  });
  const foldersOpen = leftOpen.has("folders");
  // Lightroom's Include Photos from Subfolders, for every folder shown
  const [includeSub, setIncludeSub] = useState(loadIncludeSubfolders);
  const includeSubRef = useRef(includeSub);
  includeSubRef.current = includeSub;
  // a folder's photos, shown batch by batch as they are read. `again` reads
  // the open folder anew (Refresh): its thumbnails stay, and the list is
  // swapped whole at the end rather than shrinking and growing back
  const showFolder = async (dir: string, again = false) => {
    setImmich(null);
    immichToken.current++;
    setFolder(dir);
    saveLibrary({ current: dir });
    if (!again) {
      loader.current!.clear();
      // a new folder starts unfiltered: one left on Rejected only looked empty
      setFilter(NO_FILTER);
    }
    let got: ImageEntry[] = [];
    let files: string[] = [];
    try {
      setReading({ done: 0, total: 0, files });
      const list = await openFolder(dir, includeSubRef.current, [...hiddenRef.current], (batch, done, total, all) => {
        // an Immich search took the filmstrip while this was read
        if (immichRef.current) return;
        if (all) {
          files = all;
          // the last folder's photos give way to the new one's cells at once
          if (!again) updateImages([]);
        }
        got = byCaptureTime([...got, ...batch]);
        if (!again && batch.length) updateImages(got);
        loader.current!.request(batch.map((i) => i.imgid));
        // a refresh's photos are on show already
        setReading({ done, total, files: again ? [] : files });
      });
      if (immichRef.current) return list;
      setReading(null);
      const sorted = byCaptureTime(list);
      updateImages(sorted);
      setStatus(`${list.length} images`);
      return sorted;
    } catch (e) {
      // another folder was opened meanwhile, and shows its own progress
      if (String(e) === "superseded") return [];
      setReading(null);
      if (!(await invoke<boolean>("path_exists", { path: dir }))) {
        updateImages([]);
        setFolderRefresh((n) => n + 1);
        setStatus(`folder not found: ${dir}. it was moved or deleted outside Immage`);
      } else setStatus(`error: ${e}`);
      return [];
    }
  };

  // an Immich search into the filmstrip; `more` adds its next page. a newer
  // search, or a folder opened, drops what an older one brings back
  const immichToken = useRef(0);
  const searchImmich = async (q: ImmichSearch, more = false) => {
    const prev = immichRef.current;
    if (more && (!prev?.next || prev.busy)) return;
    const token = ++immichToken.current;
    const after = more ? prev!.next : null;
    if (!more) thumbError.current = false;
    setImmich({ search: q, next: after, busy: true });
    if (!more) {
      loader.current!.clear();
      setFilter(NO_FILTER);
      setReading(null);
      updateImages([]);
      setGrid(true);
    }
    try {
      const page = await searchImmichPage(q, after);
      if (token !== immichToken.current) return;
      const list = more ? [...imagesRef.current, ...page.entries] : page.entries;
      updateImages(list);
      loader.current!.request(page.entries.map((i) => i.imgid));
      setImmich({ search: q, next: page.next, busy: false });
      setStatus(`${list.length.toLocaleString()}${page.next ? "+" : ""} photos from Immich`);
    } catch (e) {
      if (token !== immichToken.current) return;
      setImmich({ search: q, next: null, busy: false });
      setStatus(`Immich: ${e}`);
    }
  };

  // a photo picked in the filmstrip. an Immich result opens the external
  // library's file when it is on this computer, else the original downloaded
  // first; from then on the cell is that file, the engine's like any other
  const resolving = useRef(new Set<number>());
  const openEntry = async (i: ImageEntry) => {
    if (!isRemote(i)) return openFile(i.path, i.imgid);
    // a double click opens the cell twice, once for each of its clicks. the
    // second would find the first's open under way, take the session before
    // it for this photo's and give the cell its id, so the first's own id
    // never reached the cell and the open photo had no cell
    if (resolving.current.has(i.imgid)) return;
    resolving.current.add(i.imgid);
    setStatus(i.remote?.localPath ? "opening…" : "downloading the original from Immich…");
    try {
      const r = await resolve(i);
      await openFile(r.path);
      const s = session.current;
      if (!s || currentRef.current?.path !== r.path || currentRef.current.imgid !== s.imgid) return;
      const m = await invoke<{ image: ImageEntry }>("meta", { imgid: s.imgid }).then((x) => x.image).catch(() => null);
      const opened: Partial<ImageEntry> = m ? { rating: m.rating, rejected: m.rejected, labels: m.labels, edited: m.edited,
                                               width: m.width, height: m.height, exif: m.exif } : {};
      updateImages(imagesRef.current.map((x) => (x.imgid === i.imgid
        ? { ...x, ...opened, imgid: s.imgid, path: r.path, remote: { ...i.remote!, localPath: r.downloaded ? null : r.path } }
        : x)));
      setSelection(new Set([s.imgid]));
      loader.current!.request([s.imgid], true);
    } catch (e) {
      setStatus(`Immich: ${e}`);
    } finally {
      resolving.current.delete(i.imgid);
    }
  };

  const addFolder = async () => {
    const dir = await open({ directory: true });
    if (typeof dir !== "string") return;
    const next = folders.includes(dir) ? folders : [...folders, dir];
    setFolders(next);
    saveLibrary({ folders: next });
    unhide(dir);
    void showFolder(dir);
    setGrid(true);
  };

  // a listed folder leaves the list; a subfolder is hidden from the tree
  const removeFolder = (dir: string) => {
    const current = dir === folder ? { current: null } : {};
    if (folders.includes(dir)) {
      const next = folders.filter((f) => f !== dir);
      const nextHidden = new Set([...hidden].filter((h) => !within(h, dir)));
      setFolders(next);
      setHidden(nextHidden);
      saveLibrary({ folders: next, hidden: [...nextHidden], ...current });
    } else {
      const nextHidden = new Set(hidden).add(dir);
      hiddenRef.current = nextHidden;
      setHidden(nextHidden);
      saveLibrary({ hidden: [...nextHidden], ...current });
      // the grid showing it among a parent's photos reads that parent again
      if (folder && folder !== dir && includeSub && within(dir, folder) && !immich) void showFolder(folder, true);
    }
    setExpandedTo(new Set([...expanded].filter((p) => !within(p, dir))));
  };

  // a folder into the library: inside a listed folder, the tree opens down
  // to it; otherwise it is listed itself. its subfolders are read again
  const addPathToLibrary = (dir: string) => {
    unhide(dir);
    const root = foldersRef.current.find((r) => within(dir, r));
    if (!root) {
      const next = [...foldersRef.current, dir];
      foldersRef.current = next;
      setFolders(next);
      saveLibrary({ folders: next });
    } else {
      const open = new Set(expandedRef.current);
      for (let p = parentDir(dir); within(p, root); p = parentDir(p)) {
        open.add(p);
        if (p === root) break;
      }
      expandedRef.current = open;
      setExpandedTo(open);
    }
    setFolderRefresh((n) => n + 1);
  };

  // the importer's Immich buttons open Preferences there; stable, as the
  // importer keeps it
  const openImmichPrefs = useCallback(() => setPrefsOpen("immich"), []);
  // an import landed: its destination joins the library (or the listed
  // folder holding it opens down to it), so the new folders show
  const importDone = (r: ImportResult) => {
    if (r.root && r.summary.imported > 0) addPathToLibrary(r.root);
  };
  // "Show in Immage": back to the editor, on the first photo imported (the
  // oldest), in its folder; with nothing new copied, the folder most files
  // were found in
  const showImported = (r: ImportResult) => {
    setImportOpen(false);
    const first = r.files[0];
    const target = first ? parentDir(first)
      : Object.entries(r.dirs).sort((a, b) => b[1] - a[1])[0]?.[0] ?? r.root;
    if (!target) return;
    if (r.root) addPathToLibrary(r.root);
    addPathToLibrary(target);
    void showFolder(target).then((list) => {
      const photo = list.find((i) => i.path === first) ?? list[0];
      if (photo) void openFile(photo.path);
    });
  };

  // a photo handed over from outside (the command line, or macOS's open
  // and Finder): its folder is shown and kept in the list, and it opens
  const openLaunched = async (path: string) => {
    const dir = parentDir(path);
    addPathToLibrary(dir);
    const list = await showFolder(dir);
    if (list.some((i) => i.path === path)) await openFile(path);
    else setStatus(`not a photo Immage can open: ${path}`);
  };
  const openLaunchedRef = useRef(openLaunched);
  openLaunchedRef.current = openLaunched;

  // files dragged onto the window from Finder or Explorer: folders join the
  // library and the first shows as a grid; otherwise the first photo opens,
  // as one handed over does. the import screen is left alone
  const [dropping, setDropping] = useState(false);
  const dropped = async (paths: string[]) => {
    const kinds = await Promise.all(paths.map((path) => invoke<string | null>("path_kind", { path })));
    const dirs = paths.filter((_, i) => kinds[i] === "dir");
    if (dirs.length) {
      for (const d of dirs) addPathToLibrary(d);
      void showFolder(dirs[0]);
      setGrid(true);
      return;
    }
    const file = paths.find((_, i) => kinds[i] === "file");
    if (!file) return;
    setGrid(false);
    await openLaunched(file);
  };
  const droppedRef = useRef(dropped);
  droppedRef.current = dropped;
  useEffect(() => {
    const off = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (importOpenRef.current) { setDropping(false); return; }
      if (payload.type === "enter" || payload.type === "over") setDropping(true);
      else setDropping(false);
      if (payload.type === "drop" && payload.paths.length) void droppedRef.current(payload.paths);
    });
    return () => { void off.then((f) => f()); };
  }, []);

  // at start, a photo handed over, or else the folder and image open when
  // the app last closed; later, a photo handed to the running app
  const started = useRef(false);
  useEffect(() => {
    const off = listen("launch-file", async () => {
      const path = await invoke<string | null>("launch_file");
      if (path) void openLaunchedRef.current(path);
    });
    // once: React's development mode runs effects twice, which listed the
    // folder twice while the engine was still starting
    if (started.current) return () => { void off.then((f) => f()); };
    started.current = true;
    void invoke<string | null>("launch_file").then((path) => {
      if (path) { void openLaunchedRef.current(path); return; }
      const lib = loadLibrary();
      // the very first start: a sample photo, so there is something to edit
      // and the quick start has something to point at. once only, so a
      // removed sample stays removed
      if (!lib.folders.length && !lib.sampled) {
        saveLibrary({ sampled: true });
        void invoke<string>("sample_folder").then((dir) => {
          addPathToLibrary(dir);
          return showFolder(dir);
        }).then((list) => { if (list[0]) void openFile(list[0].path); })
          .catch((e) => setStatus(`sample photo: ${e}`));
        return;
      }
      if (!lib.current) return;
      void showFolder(lib.current).then((list) => {
        const last = list.find((i) => i.path === lib.image && (i.version ?? 0) === (lib.version ?? 0))
          ?? list.find((i) => i.path === lib.image && !i.copy);
        if (last) void openFile(last.path, last.imgid);
      });
    });
    return () => { void off.then((f) => f()); };
  }, []);

  // rating, labels, rejection and text fields: the engine writes the sidecar
  // a rating, reject or label for the photos selected in the filmstrip when
  // `from` is one of them, else for `from` alone. a label is a bit, put on
  // all of them or, when `from` has it, taken off all of them
  const rateSelection = (from: ImageEntry, fields: Partial<ImageEntry>) => {
    // an Immich result keeps Immich's rating until it is opened
    if (isRemote(from)) return;
    const sel = selectionRef.current;
    const targets = withPartners(sel.size > 1 && sel.has(from.imgid)
      ? imagesRef.current.filter((i) => sel.has(i.imgid)) : [from]).filter((i) => !isRemote(i));
    for (const i of targets) {
      if (fields.labels !== undefined) {
        const bit = fields.labels, on = !(from.labels & bit);
        void setMeta(i.imgid, { labels: on ? i.labels | bit : i.labels & ~bit });
      } else void setMeta(i.imgid, fields);
    }
  };
  const rateSelectionRef = useRef(rateSelection);
  rateSelectionRef.current = rateSelection;
  // a click in the filmstrip: plain opens the photo and selects it alone,
  // ⌘ adds it to the selection or takes it out, ⇧ selects the run from the
  // open photo to it; neither opens anything
  const pickPhoto = (i: ImageEntry, e: React.MouseEvent) => {
    if (cmd(e)) {
      setSelection((old) => {
        const next = new Set(old.size ? old : listedEntry ? [listedEntry.imgid] : []);
        if (next.has(i.imgid)) next.delete(i.imgid); else next.add(i.imgid);
        return next;
      });
      return;
    }
    if (e.shiftKey && listedEntry) {
      const list = shownRef.current;
      const a = list.findIndex((x) => x.imgid === listedEntry.imgid), b = list.findIndex((x) => x.imgid === i.imgid);
      if (a >= 0 && b >= 0) {
        setSelection(new Set(list.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.imgid)));
        return;
      }
    }
    // comparing, a click picks the candidate; the open photo stays
    if (compareRef.current !== null) {
      if (!isOpen(i) && !isRemote(i)) setCompare(i.imgid);
      return;
    }
    setSelection(new Set([i.imgid]));
    void openEntry(i);
  };
  const setMeta = async (imgid: number, fields: Partial<ImageEntry> & Record<string, unknown>) => {
    patchImage(imgid, fields);
    try {
      await invoke("meta_set", { imgid, fields });
    } catch (e) {
      setStatus(`error: ${e}`);
    }
  };

  // rejected photos to the Trash, once confirmed, with their sidecars. the
  // open photo moves on to the next one first, so the engine is not left
  // writing a sidecar beside a file in the Trash
  const deleteRejected = async (list: ImageEntry[]) => {
    if (!list.length) return;
    const n = list.length, photos = n === 1 ? `"${list[0].filename}"` : `${n} rejected photos`;
    // named, so a wrong selection shows before anything moves
    const names = list.slice(0, 8).map((i) => i.filename).join("\n") + (n > 8 ? `\n…and ${n - 8} more` : "");
    const ok = await ask(`Move ${photos} to the ${TRASH}? ${n === 1 ? "Its sidecar goes" : "Their sidecars go"} too.\n\n${names}`,
                         { title: "Delete rejected photos", kind: "warning", okLabel: `Move to ${TRASH}` });
    if (!ok) return;
    // an original takes its virtual copies with it; a copy goes alone
    const ids = new Set(list.map((i) => i.imgid)), files = new Set(list.filter((i) => !i.copy).map((i) => i.path));
    const gone = (i: ImageEntry) => ids.has(i.imgid) || files.has(i.path);
    const cur = imagesRef.current.find((i) => isOpen(i));
    if (cur && gone(cur)) {
      const shownNow = shownRef.current, at = shownNow.findIndex((i) => isOpen(i));
      const next = [...shownNow.slice(at + 1), ...shownNow.slice(0, Math.max(0, at)).reverse()]
        .find((i) => !gone(i));
      if (next) await openFile(next.path, next.imgid);
      else await closePhoto();
    }
    try {
      await invoke("trash_files", { imgids: list.map((i) => i.imgid) });
      updateImages(imagesRef.current.filter((i) => !gone(i)));
      setStatus(`moved ${n === 1 ? list[0].filename : `${n} photos`} to the ${TRASH}`);
    } catch (e) {
      setStatus(`delete: ${e}`);
    }
  };
  // Lightroom's Create Virtual Copy: another version of each photo, starting
  // from its edit as it stands, listed after the original and its copies.
  // the last one made opens, as in Lightroom
  const createCopies = async (list: ImageEntry[]) => {
    let made: ImageEntry | null = null;
    for (const src of list.filter((i) => !isRemote(i))) {
      try {
        // the engine saves the open photo's edit first, which its thumbnail then shows
        const copy = await invoke<ImageEntry>("create_virtual_copy", { imgid: src.imgid });
        if (session.current?.imgid === src.imgid) loader.current!.invalidate(src.imgid);
        const all = imagesRef.current;
        const last = all.reduce((at, i, k) => (i.path === src.path ? k : at), -1);
        updateImages([...all.slice(0, last + 1), copy, ...all.slice(last + 1)]);
        made = copy;
      } catch (e) {
        setStatus(`virtual copy: ${e}`);
        break;
      }
    }
    if (!made) return;
    setSelection(new Set([made.imgid]));
    await openFile(made.path, made.imgid);
    setStatus(`made virtual copy ${made.version} of ${made.filename}`);
  };
  const createCopiesRef = useRef(createCopies);
  createCopiesRef.current = createCopies;
  // the copies out of the library, their sidecars to the Trash; the file
  // stays with its original. the open one gives way to its original first
  const removeCopies = async (list: ImageEntry[]) => {
    const copies = list.filter((i) => i.copy);
    const cur = imagesRef.current.find((i) => isOpen(i));
    if (cur && copies.some((i) => i.imgid === cur.imgid)) await openFile(cur.path);
    const gone = new Set<number>();
    let problem: string | null = null;
    for (const c of copies) {
      try {
        const trashed = await invoke<string | null>("remove_virtual_copy", { imgid: c.imgid });
        gone.add(c.imgid);
        if (trashed) problem = `the sidecar of ${c.filename} (copy ${c.version}) could not go to the ${TRASH}: ${trashed}`;
      } catch (e) {
        problem = `remove virtual copy: ${e}`;
        break;
      }
    }
    updateImages(imagesRef.current.filter((i) => !gone.has(i.imgid)));
    setStatus(problem ?? (gone.size === 1 ? `removed virtual copy ${copies[0].version} of ${copies[0].filename}`
      : `removed ${gone.size} virtual copies`));
  };

  // no photo open: the last one was deleted
  const closePhoto = async () => {
    const s = session.current;
    if (!s) return;
    await s.close();
    session.current = null;
    currentRef.current = null;
    setCurrent(null);
    setOpenCell(null);
    setValues({});
    for (const c of [canvas.current, baseCanvas.current, navThumb.current, clipBase.current, clipSharp.current]) if (c) c.width = 0;
  };

  // Edit In: photos handed to another application (plugins.ts), which is
  // then watched for the files it saves (plugins.rs). each comes back beside
  // its photo, and the first of a hand-off opens
  const [plugins, setPluginsState] = useState<PluginConfig[]>(loadPlugins);
  const setPlugins = (list: PluginConfig[]) => { setPluginsState(list); storePlugins(list); };
  // the files taken back, by path, for the settings of their first open
  const returns = useRef(new Map<string, PluginReturn>());
  useEffect(() => { void loadReturns().then((l) => { for (const r of l) returns.current.set(r.result, r); }); }, []);
  // the hand-offs still waiting, by token
  type Waiting = { token: number; name: string; back: number; total: number; opened: boolean };
  const [waiting, setWaiting] = useState<Waiting[]>([]);
  const waitingRef = useRef(waiting);
  waitingRef.current = waiting;
  const editIn = async (cfg: PluginConfig, targets: ImageEntry[]) => {
    const kind = kindOf(cfg.kind);
    if (!kind) return;
    // a virtual copy sends its file, once
    const photos = [...new Map(targets.map((t) => [t.remote?.localPath ?? t.path, t])).entries()];
    const originals = photos.map(([path]) => path);
    let send = originals;
    try {
      // TIFFs with the edit, beside each photo as Lightroom's "-Edit" files;
      // a result named from one is still named from its photo
      if (kind.send === "tiff" || (kind.send === "choice" && cfg.send === "tiff")) {
        setStatus(`${cfg.name}: writing TIFFs…`);
        send = [];
        for (const [path, t] of photos) {
          const r = await track(invoke<{ written: string[]; failed: { error: string }[] }>("export_images", {
            items: [{ imgid: t.imgid, stem: `${baseName(path).replace(/\.[^.]+$/, "")}-Edit` }],
            options: { dir: parentDir(path), format: "tiff", bpp: 16, colorSpace: "prophoto", conflict: "unique" },
          }));
          if (r.failed.length) throw new Error(r.failed[0].error);
          send.push(...r.written);
        }
      }
      const token = Date.now();
      await invoke("plugin_watch", { watch: {
        token, plugin: cfg.id, sources: originals, exts: kind.returns.exts, match: kind.returns.match,
        subfolders: kind.returns.subfolders, outputDir: cfg.outputDir || null, ignore: send.filter((p) => !originals.includes(p)),
      } });
      setWaiting((w) => [...w, { token, name: cfg.name, back: 0,
                                 total: kind.returns.match === "any" ? 1 : originals.length, opened: false }]);
      try {
        await invoke("plugin_launch", { appPath: cfg.app, files: send });
      } catch (e) {
        void invoke("plugin_cancel", { token });
        throw e;
      }
      setStatus(`sent ${send.length === 1 ? baseName(send[0]) : `${send.length} photos`} to ${cfg.name}`);
    } catch (e) {
      setStatus(`${cfg.name}: ${e instanceof Error ? e.message : e}`);
    }
  };
  // a file is back: shown beside its photo (open_folder puts it there), and
  // the hand-off's first opened
  const pluginReturned = useRef<(r: PluginReturn & { token: number }) => void>(() => {});
  pluginReturned.current = async (r) => {
    returns.current.set(r.result, { original: r.original, result: r.result, plugin: r.plugin, applied: false });
    const w = waitingRef.current.find((x) => x.token === r.token);
    setWaiting((all) => all.map((x) => (x.token === r.token ? { ...x, back: x.back + 1, opened: true } : x)));
    if (folderRef.current && !immichRef.current && imagesRef.current.some((i) => i.path === r.original))
      await showFolder(folderRef.current, true);
    if (w && !w.opened) {
      await openFile(r.result);
      setStatus(`${w.name}: opened ${baseName(r.result)}`);
    } else {
      setStatus(`${w?.name ?? "plugin"}: ${baseName(r.result)} is back`);
    }
  };
  useEffect(() => {
    const offs = [
      listen<PluginReturn & { token: number }>("plugin-returned", (e) => pluginReturned.current(e.payload)),
      listen<{ token: number; reason: string }>("plugin-watch-end", (e) => {
        const w = waitingRef.current.find((x) => x.token === e.payload.token);
        setWaiting((all) => all.filter((x) => x.token !== e.payload.token));
        if (w && e.payload.reason === "timeout")
          setStatus(`${w.name}: stopped waiting after 3 hours; ${w.back} of ${w.total} came back`);
      }),
    ];
    return () => { for (const off of offs) void off.then((f) => f()); };
  }, []);

  // the photo the arrow keys would open next, its raw decoded ahead by the
  // engine once this one is up (main.c, _prefetch): a compressed raw's
  // decode, some 300 ms, is then gone from opening it
  const stepDir = useRef<1 | -1>(1);
  const prefetched = useRef<number | null>(null);
  const prefetchNext = (s: Session) => {
    const list = shownRef.current, at = list.findIndex((i) => i.imgid === s.imgid);
    const next = at >= 0 ? list[at + stepDir.current] : undefined;
    if (!next || isRemote(next) || next.imgid === prefetched.current) return;
    prefetched.current = next.imgid;
    invoke("prefetch", { imgid: next.imgid }).catch(() => {});
  };

  // `imgid` picks one of the file's versions (a virtual copy); without it,
  // the original
  const openFile = async (path: string, imgid: number | null = null) => {
    const id = imgid ?? imagesRef.current.find((i) => i.path === path && !i.copy)?.imgid ?? null;
    const cur = currentRef.current;
    if (cur && cur.path === path && (id === null || cur.imgid === id)) return;
    if (!(await invoke<boolean>("path_exists", { path }))) {
      setStatus(`file not found: ${baseName(path)}. it was moved or deleted outside Immage`);
      if (folderRef.current && !immichRef.current) void showFolder(folderRef.current, true);
      return;
    }
    try {
      if (session.current) {
        const o = session.current;
        previous.current = { values: { ...o.values }, look: { name: o.look, path: o.lookPath, amount: o.lookAmount },
                             masks: structuredClone(o.masks) };
        await o.close();
      }
      setStatus("opening…");
      const opening = { path, imgid: id };
      setCurrent(opening);
      currentRef.current = opening;
      // a new image opens fitted, as in Lightroom, with both layers cleared
      zoomRef.current = "fit";
      setZoomState("fit");
      center.current = { x: 0.5, y: 0.5 };
      full.current = null;
      viewZ.current = 0;
      baseMeta.current = null;
      sharpMeta.current = null;
      copyMeta.current = null;
      copyGen.current++;
      setCopyOn(false);
      overviewHash.current = null;
      baseStale.current = true;
      for (const c of [baseCanvas.current, clipBase.current, copyCanvas.current, clipSharp.current]) if (c) c.width = 0;
      // the photo's filmstrip thumbnail, fitted, until its first frame takes
      // its place, rather than the last photo
      const thumb = id !== null ? loader.current?.get(id) : undefined, sc = canvas.current;
      if (thumb && sc) {
        const dpr = window.devicePixelRatio || 1, { w, h } = viewport(), m = 2 * MARGIN * dpr;
        const z = Math.min((w - m) / thumb.width, (h - m) / thumb.height);
        sc.width = thumb.width;
        sc.height = thumb.height;
        sc.getContext("2d")!.drawImage(thumb, 0, 0);
        sc.style.width = `${thumb.width / dpr}px`;
        sc.style.height = `${thumb.height / dpr}px`;
        sc.style.transform = `translate(${(w - z * thumb.width) / 2 / dpr}px, ${(h - z * thumb.height) / 2 / dpr}px) scale(${z})`;
      }
      const s = await track(Session.open(path, id, currentView, drawFrame, (e) => setStatus(`error: ${e}`)));
      // the engine's id, for a photo opened by its file alone
      const opened = { path, imgid: s.imgid };
      setCurrent(opened);
      currentRef.current = opened;
      setOpenCell(imagesRef.current.find((i) => isOpen(i, opened)) ?? null);
      saveLibrary({ image: path, version: imagesRef.current.find((i) => i.imgid === s.imgid)?.version ?? 0 });
      s.onThumb = (f) => {
        perf.drawStart(f.trace);
        try { showOverview(f); } finally { perf.drawEnd(); }
        baseLowRes.current = false;
        prefetchNext(s);
      };
      s.onCopy = (f) => {
        const cc = copyCanvas.current, gen = ++copyGen.current;
        if (!f) {
          copyMeta.current = null;
          if (cc) cc.width = 0;
          setCopyOn(false);
          return;
        }
        // off the main thread where the browser can: a copy is 80 MB or more
        void createImageBitmap(new ImageData(f.pixels, f.width, f.height)).then((bmp) => {
          if (session.current !== s || gen !== copyGen.current || !cc) { bmp.close(); return; }
          cc.width = f.width;
          cc.height = f.height;
          cc.getContext("2d")!.drawImage(bmp, 0, 0);
          bmp.close();
          copyMeta.current = { scale: f.view.scale!, width: f.width, height: f.height };
          placeLayers();
          setCopyOn(true);
        });
      };
      s.thumbSize = baseSize;
      s.previewMode = loadPreview;
      s.draftSize = () => (loadPreview() === "quality" ? null : viewAt(DRAFT[loadPreview()]));
      s.warmDrafts();
      // a saved edit makes the filmstrip's thumbnail stale; undone back to
      // where it started, the photo reads unedited again
      s.onSaved = (edited) => {
        loader.current!.invalidate(s.imgid);
        patchImage(s.imgid, { edited });
        void syncEditedKeywords(s.imgid, edited);
        if (edited) void fillEditedMeta(s.imgid);
      };
      s.onShapes = () => { syncMasks(); syncSpots(); };
      // a module the History panel changed: its sliders, if it has any
      s.onModules = () => {
        if (session.current !== s) return;
        setValues({ ...s.values });
        setHistoryRev((n) => n + 1);
      };
      session.current = s;
      s.lookPath = looksRef.current.find((l) => l.name === s.look)?.path ?? null;
      setMasks(s.masks);
      setSpots(s.spots);
      setSpotSel(null);
      setMaskSel(s.masks[0]?.name ?? null);
      setShapeSel(0);
      setMaskTool(null);
      setLookState(s.look);
      setLookAmount(s.lookAmount);
      setAmount(null);
      setHoverShown(false);
      previews.current!.clear();
      undo.current = { past: [], future: [], key: "", at: 0 };
      setHistoryRev((n) => n + 1);
      beforeRef.current = false;
      baModeRef.current = "off";
      setBaModeState("off");
      setHolding(false);
      beforeMeta.current = null;
      setBeforeState(false);
      // a photo never edited starts from the new-photos preset, as with
      // Lightroom's import presets; it is the starting point, not an undo step
      const preset = s.wasEdited ? null
        : [...BUILTIN_PRESETS, ...presetsRef.current].find((p) => p.id === newPhotosRef.current);
      // the History panel's stack: darktable's, then what Immage starts a
      // new photo with. AgX in place of darktable's sigmoid
      const base: HistoryItem[] = [...s.history];
      if (!s.wasEdited && s.values.tm_mode !== 1) {
        s.setMany([["tm_mode", 1]]);
        base.push({ op: "tonemapper", name: "agx", label: "tone mapper", enabled: true });
      }
      // and a raw with the profile chosen in Preferences
      const profile = loadNewPhotosProfile();
      if (!s.wasEdited && s.raw && profile !== 0 && s.values.profile !== profile) {
        s.setMany([["profile", profile]]);
        base.push({ op: "profile", name: profileLabel(profile).toLowerCase(),
                    label: "profile", enabled: true });
      }
      // and a raw with Preferences' exposure compensation, on an instance of
      // its own (exp_comp), so Exposure still reads 0 and adds to it
      const comp = loadExposureCompNew();
      if (!s.wasEdited && s.raw && comp) {
        s.setMany([["exp_comp", comp]]);
        base.push({ op: "exposure", name: "exposure",
                    label: `compensation ${comp > 0 ? "+" : ""}${comp.toFixed(2)} EV`, enabled: true });
      }
      // a raw starts with darktable's capture sharpening, and without noise
      // reduction, which the AgX workflow adds only where a photo needs it;
      // the preset or an Edit In return below may set them again
      if (!s.wasEdited && s.raw) s.setMany([["capture", 1]]);
      // a file back from Edit In starts without what its application did
      // already (Lens Corrections after PureRAW), over the preset's values
      // so they are never turned on to be turned off
      const back = returns.current.get(path);
      const plugin = !s.wasEdited && back && !back.applied
        ? returnValues(back.plugin.split(":")[0], plugins.find((p) => p.id === back.plugin)) : null;
      if (preset && (s.raw || !preset.rawOnly)) {
        s.setMany(Object.entries({ ...presetValues(preset), ...plugin?.values }));
        setStatus(`new photo: applied "${preset.name}"`);
        base.push({ op: "preset", name: preset.name, label: "new photos preset", enabled: true });
      } else if (plugin && Object.keys(plugin.values).length) {
        s.setMany(Object.entries(plugin.values));
      }
      if (back && plugin) {
        back.applied = true;
        void invoke("plugin_return_applied", { result: path });
        if (plugin.labels.length) {
          const name = kindOf(back.plugin.split(":")[0])?.label ?? "plugin";
          base.push({ op: "plugin", name, label: `${name}: ${plugin.labels.join(", ")} off`, enabled: true });
        }
      }
      // and Auto, when Preferences asks for it, once the photo has rendered
      const autoNew = !s.wasEdited && s.raw && loadAutoToneNew();
      if (autoNew) base.push({ op: "autotone", name: "auto tone", label: "auto tone", enabled: true });
      setHistoryBase(base);
      setValues({ ...s.values });
      if (autoNew) void runAutoTone(true);
    } catch (e) {
      setStatus(`error: ${e}`);
    }
  };

  // undo and redo: the edit before each change, sliders, masks and look
  // alike. a run of changes to the same thing (a slider drag, a curve or
  // shape drag, the white balance picker settling) is one step
  // `label` names the change that follows the state, for the History panel
  type Snap = { values: Values; masks: Mask[]; spots: Spot[]; look: { name: string | null; path: string | null };
                lookAmount: number; label: string;
                // the History panel's switched instances, and those deleted
                modules: Map<string, ModuleState>; deleted: Set<string> };
  const snapshot = (s: Session, label = ""): Snap => ({
    values: { ...s.values }, masks: structuredClone(s.masks), spots: structuredClone(s.spots),
    look: { name: s.look, path: s.lookPath }, lookAmount: s.lookAmount, label,
    modules: new Map(s.moduleStates), deleted: new Set(s.deleted),
  });
  const undo = useRef<{ past: Snap[]; future: Snap[]; key: string; at: number }>(
    { past: [], future: [], key: "", at: 0 });
  // set while one step makes several changes (Reset all), so they record once
  const holdRecord = useRef(false);
  // the History panel follows the stack, which is kept outside React
  const [, setHistoryRev] = useState(0);
  const [historyBase, setHistoryBase] = useState<HistoryItem[]>([]);
  const record = (ids: string[], label?: string) => {
    const s = session.current;
    if (!s || holdRecord.current) return;
    // what Immage gave a new photo stays its unedited state; this is the
    // user's own first change (auto tone's are made quietly)
    s.endBaseline();
    const key = [...ids].sort().join(","), now = performance.now(), u = undo.current;
    const step = key !== u.key || now - u.at > 1000;
    if (step) {
      u.past.push(snapshot(s, label ?? stepName(ids)));
      if (u.past.length > 200) u.past.shift();
    }
    if (step || u.future.length) setHistoryRev((n) => n + 1);
    u.key = key;
    u.at = now;
    u.future = [];
  };
  // jump to a recorded state: only what differs is sent
  const restore = (target: Snap) => {
    const s = session.current;
    if (!s) return;
    const entries = Object.entries(target.values).filter(([id, v]) => s.values[id] !== v);
    baseStale.current = true;
    setValues({ ...s.values, ...target.values });
    if (entries.length) s.setMany(entries);
    if (target.look.name !== s.look) {
      s.setLook(target.look.path, target.look.name);
      setLookState(target.look.name);
    }
    if (target.lookAmount !== s.lookAmount) s.setLookAmount(target.lookAmount);
    setLookAmount(target.lookAmount);
    setMasksTo(target.masks);
    // after the values, which Session.pump sends first. an instance whose
    // reply is still to come is restored whatever it holds
    for (const key of s.touched) {
      const want = target.modules.get(key), now = s.moduleStates.get(key);
      if (now && JSON.stringify(want ?? null) === JSON.stringify(now)) continue;
      const h = s.history.find((x) => instanceKey(x) === key);
      if (h) s.setModuleState(h, { restore: want ?? "opened" });
    }
    s.deleted = new Set(target.deleted);
    if (JSON.stringify(target.spots) !== JSON.stringify(s.spots)) {
      s.setSpots(target.spots);
      syncSpots();
      setSpotSel(null);
    }
  };
  // the image's masks made these: only what differs is sent
  const setMasksTo = (target: Mask[]) => {
    const s = session.current;
    if (!s) return;
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    for (const m of s.masks) if (!target.some((t) => t.name === m.name)) s.deleteMask(m.name);
    for (const t of target) {
      const c = s.masks.find((m) => m.name === t.name);
      if (!c) s.addMask(t.name, t.shapes);
      else if (!same(c.shapes, t.shapes)) s.setShapes(t.name, t.shapes);
      if ((c?.invert ?? false) !== t.invert) s.setInvert(t.name, t.invert);
      if ((c?.opacity ?? 100) !== (t.opacity ?? 100)) s.setOpacity(t.name, t.opacity ?? 100);
      if (!!c?.hidden !== !!t.hidden) s.setHidden(t.name, !!t.hidden);
      if (!same(c?.refine ?? NO_REFINE, t.refine ?? NO_REFINE)) s.setRefine(t.name, t.refine ?? NO_REFINE);
      for (const [id, v] of Object.entries(t.values))
        if ((c ? c.values[id] : 0) !== v) s.setLocal(t.name, id, v);
    }
    syncMasks();
    if (!target.some((t) => t.name === maskSel)) setMaskSel(target[0]?.name ?? null);
  };
  const copySettings = (on: Set<string>) => {
    const s = session.current;
    if (!s) return;
    clip.current = makeClip(on, s.values, { name: s.look, path: s.lookPath, amount: s.lookAmount }, s.masks);
    setHasClip(true);
    setStatus("settings copied");
  };
  // copied settings onto this image, as one undo step
  const pasteClip = (c: Clip | null, what: string) => {
    const s = session.current;
    if (!s || !c || croppingRef.current) return;
    leaveBefore();
    setAmount(null);
    record([what]);
    holdRecord.current = true;
    try {
      const entries = Object.entries(c.values).filter(([id, v]) => s.values[id] !== v);
      if (entries.length) changeMany(entries);
      if (c.look) {
        if (c.look.name !== s.look) {
          baseStale.current = true;
          s.setLook(c.look.path, c.look.name);
          setLookState(c.look.name);
        }
        if (c.look.amount !== s.lookAmount) s.setLookAmount(c.look.amount);
        setLookAmount(c.look.amount);
      }
      if (c.masks) setMasksTo(c.masks);
    } finally {
      holdRecord.current = false;
    }
    setStatus(keys(`${what}: ⌘Z undoes it`));
  };
  const pasteSettings = () => pasteClip(clip.current, "settings pasted");
  // Lightroom's Previous: the last photo's settings, the parts Copy Settings
  // has ticked
  const pastePrevious = () => {
    const p = previous.current;
    if (p) pasteClip(makeClip(loadCopyGroups(), p.values, p.look, p.masks ?? []), "previous settings");
  };
  // `steps` at once, as a click in the History panel: only the state
  // arrived at is sent
  const stepHistory = (back: boolean, steps = 1) => {
    const s = session.current, u = undo.current;
    // the crop tool keeps its own rectangle until Done
    if (!s || croppingRef.current) return;
    const from = back ? u.past : u.future, to = back ? u.future : u.past;
    if (!from.length) return;
    leaveBefore();
    let at = snapshot(s);
    for (let k = 0; k < steps && from.length; k++) {
      const target = from.pop()!;
      to.push({ ...at, label: target.label });
      at = target;
    }
    u.key = "";
    restore(at);
    setHistoryRev((n) => n + 1);
    setStatus(back ? "undo" : "redo");
  };
  // darktable's compress history stack: one entry per module in the photo's
  // history, which the session's steps fold into. those undone go, as in
  // darktable, and nothing is left to undo
  const compressHistory = async () => {
    const s = session.current;
    if (!s || croppingRef.current) return;
    leaveBefore();
    try {
      const base = await s.compressHistory();
      if (session.current !== s) return;
      undo.current = { past: [], future: [], key: "", at: 0 };
      setHistoryBase(base);
      setHistoryRev((n) => n + 1);
      setStatus("history compressed");
    } catch (e) {
      setStatus(`error: ${e}`);
    }
  };

  // the History panel's actions on a row of the opened stack. a module with
  // Immage's sliders is reset through them, so the next slider move cannot
  // switch it back; one darktable set beyond what they show, in the engine
  const historyAction = (h: HistoryItem): "toggle" | "reset" | null => {
    if (h.priority === undefined || h.fixed || h.masked) return null;
    return mapsFor(mapOpOf(h)).length ? "reset" : "toggle";
  };
  const historyChange = (h: HistoryItem, how: "toggle" | "delete" | "reset") => {
    const s = session.current;
    if (!s || croppingRef.current) return;
    const key = instanceKey(h), op = mapOpOf(h);
    if (how === "reset" && !s.isForeign(op)) {
      const ids = [...new Set(mapsFor(op).flatMap((m) => m.controls))];
      changeMany(ids.map((id) => [id, s.neutral[id]]), `Reset ${h.name}`);
      return;
    }
    leaveBefore();
    setBaMode("off");
    const on = s.moduleStates.get(key)?.enabled ?? h.enabled;
    record([`history:${key}`], how === "toggle" ? `${on ? "Switch off" : "Switch on"} ${h.name}`
      : how === "reset" ? `Reset ${h.name}` : `Delete ${h.name}`);
    baseStale.current = true;
    if (how === "toggle") s.setModuleState(h, { enabled: !on });
    // one darktable starts on would come back on: it goes back to its defaults
    else if (how === "reset" || h.default_enabled) s.setModuleState(h, { reset: true });
    else {
      s.deleted.add(key);
      s.setModuleState(h, { enabled: false });
    }
    setHistoryRev((n) => n + 1);
  };

  // what the Before view keeps of the edit: the crop, the modules chosen,
  // the orientation, and the exposure compensation a raw started with, which
  // corrects the camera rather than adjusting the photo
  const keptBefore = (id: string) => id.startsWith("crop_") || isModuleSetting(id) || id === "orient"
    || id === "exp_comp";
  // the before/after views (Y cycles them): the before is a render with the
  // Before view's settings, kept on a layer of its own beside the edit,
  // clipped at a divider that can be dragged, or shown while the photo is
  // held; the edit stays live
  const [baMode, setBaModeState] = useState<BaMode>("off");
  const baModeRef = useRef<BaMode>("off");
  const [splitPos, setSplitPos] = useState(0.5);
  const [holding, setHolding] = useState(false);
  const [modeFlash, setModeFlash] = useState<string | null>(null);
  const flashTimer = useRef(0);
  const [holdHint, setHoldHint] = useState(false);
  const hintTimer = useRef(0);
  const beforeCanvas = useRef<HTMLCanvasElement>(null);
  const beforeMeta = useRef<{ x: number; y: number; scale: number; width: number; height: number } | null>(null);
  const captureTimer = useRef(0);
  const captureBefore = (delay = 0) => {
    window.clearTimeout(captureTimer.current);
    captureTimer.current = window.setTimeout(() => {
      if (baModeRef.current !== "off") session.current?.showBefore(keptBefore);
    }, delay);
  };
  const setBaMode = (mode: BaMode) => {
    const was = baModeRef.current;
    if (!session.current || was === mode) return;
    if (mode !== "off") setCompare(null);
    setBefore(false);
    baModeRef.current = mode;
    setBaModeState(mode);
    setHolding(false);
    window.clearTimeout(hintTimer.current);
    setHoldHint(false);
    if (mode === "off") {
      window.clearTimeout(captureTimer.current);
      beforeMeta.current = null;
      session.current.showBefore(null);
      return;
    }
    window.clearTimeout(flashTimer.current);
    setModeFlash(BA_NAMES[mode]);
    flashTimer.current = window.setTimeout(() => setModeFlash(null), 1200);
    if (mode === "overlay" && bumpHoldHint()) {
      setHoldHint(true);
      hintTimer.current = window.setTimeout(() => setHoldHint(false), 4000);
    }
    // a change of pane size renders the view anew, and that frame asks for
    // a fresh before; the views sharing the edit's size keep the one shown
    if (was === "off") { beforeMeta.current = null; captureBefore(); }
  };
  const cycleBaMode = () => setBaMode(BA_MODES[(BA_MODES.indexOf(baModeRef.current) + 1) % BA_MODES.length]);

  // A/B compare (C), as Lightroom's Compare view: the open photo, live and
  // editable, on the left half; a candidate from the filmstrip on the right,
  // as darktable's thumbnail pipe renders it, so it stays fitted when the
  // open one zooms
  const [compare, setCompareState] = useState<number | null>(null);
  const compareRef = useRef<number | null>(null);
  const candCanvas = useRef<HTMLCanvasElement>(null);
  const [candReady, setCandReady] = useState(false);
  const setCompare = (imgid: number | null) => {
    if (compareRef.current === imgid) return;
    if (imgid !== null) setBaMode("off");
    compareRef.current = imgid;
    setCompareState(imgid);
  };
  // the candidate on entering: a photo selected besides the open one, else
  // the next photo, else the one before
  const toggleCompare = () => {
    if (compareRef.current !== null) { setCompare(null); return; }
    const list = shownRef.current;
    const at = list.findIndex((i) => isOpen(i));
    if (at < 0) return;
    const sel = selectionRef.current;
    const local = (i: ImageEntry) => !isRemote(i);
    const pick = list.find((i, k) => k !== at && sel.has(i.imgid) && local(i))
      ?? list.slice(at + 1).find(local) ?? list.slice(0, at).reverse().find(local);
    if (!pick) { setStatus("compare needs a second photo"); return; }
    setCompare(pick.imgid);
  };
  // the candidate opened some other way leaves nothing to compare; a swap
  // (the candidate opened, the open photo the candidate) is under way
  const swapping = useRef(false);
  useEffect(() => {
    if (compare !== null && !swapping.current && images.find((i) => isOpen(i, current))?.imgid === compare) setCompare(null);
  }, [compare, current, images]);
  // the candidate at the size of its pane, once the editor is idle; again
  // when the pane grows
  useEffect(() => {
    setCandReady(false);
    const c = candCanvas.current;
    if (compare === null || !c) return;
    const box = c.parentElement!;
    let gone = false, timer = 0, asked = 0;
    const load = async () => {
      const dpr = window.devicePixelRatio || 1;
      const size = Math.min(MAX_PREVIEW, Math.round(Math.max(box.clientWidth, box.clientHeight) * dpr));
      if (size <= asked) return;
      asked = size;
      while (!gone && !session.current?.idle) await new Promise((r) => setTimeout(r, 60));
      if (gone) return;
      try {
        const bitmap = await fetchThumb(compare, size);
        if (gone) return;
        c.width = bitmap.width;
        c.height = bitmap.height;
        c.getContext("2d")!.drawImage(bitmap, 0, 0);
        bitmap.close();
        setCandReady(true);
      } catch {
        if (!gone) setStatus("no preview of that photo");
      }
    };
    void load();
    const ro = new ResizeObserver(() => { window.clearTimeout(timer); timer = window.setTimeout(() => void load(), 300); });
    ro.observe(box);
    return () => { gone = true; window.clearTimeout(timer); ro.disconnect(); };
  }, [compare, current]);

  // Lightroom's Before view (\): the image at its own defaults, crop kept
  const [before, setBeforeState] = useState(false);
  const beforeRef = useRef(false);
  const setBefore = (on: boolean) => {
    if (!session.current || beforeRef.current === on) return;
    beforeRef.current = on;
    setBeforeState(on);
    baseStale.current = true;
    session.current.showBefore(on ? keptBefore : null);
  };
  const leaveBefore = () => setBefore(false);
  // the key handler is installed once; it reaches the latest of this
  const setBaModeRef = useRef<(mode: BaMode) => void>(() => {});
  const cycleBaModeRef = useRef(() => {});
  const setCompareRef = useRef<(imgid: number | null) => void>(() => {});
  const toggleCompareRef = useRef(() => {});
  const pasteSettingsRef = useRef(() => {});
  const pastePreviousRef = useRef(() => {});
  setBaModeRef.current = setBaMode;
  cycleBaModeRef.current = cycleBaMode;
  setCompareRef.current = setCompare;
  toggleCompareRef.current = toggleCompare;
  pasteSettingsRef.current = () => pasteSettings();
  pastePreviousRef.current = () => pastePrevious();

  const changeMany = (entries: [string, number][], label?: string) => {
    leaveBefore();
    setBaMode("off");
    if (entries.some(([id]) => id.startsWith("grain_"))) setGrainLast(true);
    else if (entries.some(([id]) => id.startsWith("vig_"))) {
      setGrainLast(false);
      if (entries.some(([id]) => id.startsWith("vig_") && id !== "vig_amount")) vigMoved();
    }
    if (entries.some(([id]) => id.startsWith("tf_"))) tfMoved();
    record(entries.map(([id]) => id), label);
    baseStale.current = true;
    setValues((old) => ({ ...old, ...Object.fromEntries(entries) }));
    session.current?.setMany(entries);
  };

  const change = (c: Control, v: number) => {
    leaveBefore();
    setBaMode("off");
    if (c.id.startsWith("grain_")) setGrainLast(true);
    else if (c.id.startsWith("vig_")) { setGrainLast(false); if (c.id !== "vig_amount") vigMoved(); }
    if (c.id.startsWith("tf_")) tfMoved();
    setAmount(null);
    record([c.id]);
    baseStale.current = true;
    setValues((old) => ({ ...old, [c.id]: v }));
    session.current?.set(c.id, v);
  };

  // Preferences' GUI benchmark: scripted drags of the main sliders through
  // change(), as a hand would make them, then a zoom in and out and the idle
  // base render, each frame timed by the overlay; every control ends where it
  // started. the report goes to benchmarking/results/gui in a dev build
  const benchRunning = useRef(false);
  const runGuiBenchmark = async (): Promise<string> => {
    const s = session.current;
    if (!s || benchRunning.current) throw new Error("no photo open, or a benchmark is running");
    benchRunning.current = true;
    const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
    const settle = async () => {
      await sleep(100);
      while (!s.idle) await sleep(30);
      await sleep(300);
    };
    const wasOn = perf.enabled;
    if (!wasOn) { setPerfHud(true); perf.enable(true); }
    const steps: [string, number][] = [
      ["exposure", 1.5], ["contrast", 50], ["highlights", -60], ["shadows", 60], ["whites", 40], ["blacks", -40],
      ["temp", 1500], ["tint", 30], ["texture", 40], ["clarity", 40], ["dehaze", 30], ["vibrance", 30],
      ["saturation", 30], ["nr_luminance", 40], ["vig_amount", -30], ["grain_amount", 30],
    ];
    const preview = loadPreview();
    const drafts = preview !== "quality";
    // the web view measured idle, ahead of the run and its timing
    await settle();
    const webview = await webviewInfo();
    perf.recording = [];
    const t0 = performance.now();
    try {
      await settle();
      for (const [id, delta] of steps) {
        const c = controlById.get(id);
        if (!c || session.current !== s) continue;
        const from = s.values[id] ?? c.neutral ?? 0;
        const to = Math.min(c.max, Math.max(c.min, from + delta));
        // 30 moves out and 30 back, at about 60 a second
        perf.label = `${id} drag`;
        dragging.current = drafts;
        for (let i = 1; i <= 60; i++) {
          const k = i <= 30 ? i / 30 : (60 - i) / 30;
          change(c, from + (to - from) * k);
          await sleep(16);
        }
        change(c, from);
        dragging.current = false;
        perf.label = `${id} release`;
        if (draftShown.current) s.requestRender();
        await settle();
      }
      perf.label = "zoom 100%";
      setZoom(1);
      await settle();
      perf.label = "zoom fit";
      setZoom("fit");
      await settle();
      // a drag begun while the base renders, which cancels it: the first
      // frame shows how long the base still held the engine
      const ex = controlById.get("exposure");
      const until = performance.now() + 5000;
      while (!s.baseRendering && performance.now() < until) await sleep(10);
      if (ex && s.baseRendering) {
        const from = s.values.exposure ?? ex.neutral ?? 0;
        perf.label = "drag during base";
        dragging.current = drafts;
        for (let i = 1; i <= 20; i++) {
          change(ex, from + 0.5 * (i <= 10 ? i / 10 : (20 - i) / 10));
          await sleep(16);
        }
        change(ex, from);
        dragging.current = false;
        perf.label = "drag during base, release";
        if (draftShown.current) s.requestRender();
        await settle();
      }
      // the sharper base, once editing has paused (scheduleBase)
      perf.label = "idle base";
      await sleep(2500);
      await settle();
    } finally {
      dragging.current = false;
      perf.label = "";
      benchRunning.current = false;
    }
    // a drag's last draft can finish after the label turns to its release;
    // it is the drag's, and the release is the full frame (and its wait)
    const dragOf = (l: string) => (l.endsWith(", release") ? l.slice(0, -", release".length)
                                                          : l.replace(/ release$/, " drag"));
    const samples = (perf.recording ?? []).map((x) =>
      x.draft && x.label?.endsWith(" release") ? { ...x, label: dragOf(x.label) } : x);
    perf.recording = null;
    if (!wasOn) { setPerfHud(false); perf.enable(false); }
    const labels = [...new Set(samples.map((x) => x.label ?? ""))];
    const summary = labels.map((label) => {
      const of = samples.filter((x) => (x.label ?? "") === label);
      const stages = Object.fromEntries(STAGES.map((k) => [k, percentiles(of.map((x) => x.stages[k])).p50]));
      return { label, frames: of.length, ...percentiles(of.map((x) => x.total)), stages };
    });
    const { w, h } = viewport();
    const at = new Date();
    const report = {
      immage: "gui-benchmark", version: 3, at: at.toISOString(),
      app: await invoke<{ app: string; darktable: string }>("about").catch(() => null),
      machine: await invoke<Record<string, unknown>>("perf_machine").catch(() => null),
      webview,
      photo: (currentRef.current?.path ?? "").split(/[\\/]/).pop(),
      viewport: { width: w, height: h, dpr: window.devicePixelRatio || 1 }, dragDrafts: drafts, preview,
      transport: frameTransport(), seconds: (performance.now() - t0) / 1000, displayLongFrames: perf.longFrames, summary, samples,
    };
    const stamp = at.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    return invoke<string>("perf_report_write", { name: `gui-${stamp}`, report });
  };

  // ⌥-click opens a panel alone, as Lightroom's solo mode (Preferences' focus
  // mode makes that the plain click)
  // in focus mode a plain click is the solo one, and ⌥ opens a panel
  // alongside the others; either way a click on an open panel closes it
  const togglePanel = (id: string, alt = false) =>
    setOpenPanels((old) => {
      const solo = focusMode ? !alt && !old.has(id) : alt;
      if (solo) return new Set(old.has(id) && old.size === 1 ? [] : [id]);
      const next = new Set(old);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  // all of the right panel's panels (or preset groups) shut, or all open
  const [presetGroupsOpen, setPresetGroupsOpen] = useState(true);
  const [presetFold, setPresetFold] = useState<{ open: boolean; n: number }>({ open: true, n: 0 });
  const anyOpen = rightMode === "presets" ? presetGroupsOpen : openPanels.size > 0;
  const toggleAllPanels = () => {
    if (rightMode === "presets") setPresetFold((f) => ({ open: !presetGroupsOpen, n: f.n + 1 }));
    else setOpenPanels(openPanels.size ? new Set() : new Set(panels.filter((p) => !p.hidden).map((p) => p.id)));
  };

  // click zooms to 100% on the clicked point, or back to fit; a drag pans,
  // moving the layers, and the new part is rendered on release
  // capture phase, so a straighten line wins over the crop, mask and spot
  // editors above the image
  const onStraightenDown = (e: React.PointerEvent<HTMLElement>) => {
    if (!current || !viewZ.current || pickingRef.current || previewRef.current || e.button !== 0) return;
    const armed = straighteningRef.current;
    if (!armed && !(e.shiftKey && !masksModeRef.current && !healModeRef.current)) return;
    e.stopPropagation();
    e.preventDefault();
    viewer.current!.setPointerCapture(e.pointerId);
    const v = viewer.current!.getBoundingClientRect();
    const x = e.clientX - v.left, y = e.clientY - v.top;
    lineRef.current = { x0: x, y0: y, x1: x, y1: y };
    setLine(lineRef.current);
  };
  const finishStraighten = () => {
    const l = lineRef.current;
    lineRef.current = null;
    setLine(null);
    setStraightening(false);
    if (!l || Math.hypot(l.x1 - l.x0, l.y1 - l.y0) < 10) return;
    // the line's angle off the nearest axis, -45 to 45 degrees; screen y
    // points down, so a line falling to the right reads positive and wants
    // a turn counter-clockwise, negative in Lightroom's terms
    const a = (Math.atan2(l.y1 - l.y0, l.x1 - l.x0) * 180) / Math.PI;
    const off = ((((a % 90) + 135) % 90) + 90) % 90 - 45;
    const c = controlById.get("tf_rotate")!;
    const now = session.current?.values.tf_rotate ?? 0;
    const to = Math.round(Math.min(c.max, Math.max(c.min, now - off)) / c.step) * c.step;
    if (to !== now) change(c, to);
  };

  // the photo under the pointer, for the open Tone Curve, HSL or B&W Mix
  // card, a mask's HSL or the Zone System (probe.ts): read from the base
  // layer, whose pixels are taken once per redraw, and the zones' map. in
  // black and white the color comes from a small render with the treatment
  // off, made again a moment after an edit
  const [maskHslShown, setMaskHslShown] = useState(false);
  const bwMode = values.bw_mode === 1;
  const wantProbe = !!current && !cropping && !picking && !straightening
    && (zonesOpen || rightMode === "adjust" && (openPanels.has("tonecurve") || openPanels.has(bwMode ? "bw" : "hsl"))
        || masksMode && maskHslShown);
  const wantBwColor = wantProbe && bwMode && openPanels.has("bw");
  const probeAt = useRef<{ x: number; y: number } | null>(null);
  const probeRaf = useRef(0);
  const basePixels = useRef<{ tick: number; img: ImageData } | null>(null);
  const bwColor = useRef<{ frame: Frame | null; stale: boolean; busy: boolean; timer: number }>(
    { frame: null, stale: true, busy: false, timer: 0 });
  useEffect(() => { bwColor.current.stale = true; }, [values]);
  useEffect(() => { bwColor.current.frame = null; }, [current]);
  useEffect(() => { if (!wantProbe) { probeAt.current = null; setProbe(null); } }, [wantProbe]);
  const readProbe = (clientX: number, clientY: number) => {
    const bc = baseCanvas.current;
    if (!bc || !bc.width || !full.current || !viewZ.current) { setProbe(null); return; }
    const { sx, sy } = paneXY(clientX, clientY);
    const { ix, iy } = imageAt(sx, sy);
    if (basePixels.current?.tick !== baseTick || basePixels.current.img.width !== bc.width)
      basePixels.current = { tick: baseTick, img: bc.getContext("2d")!.getImageData(0, 0, bc.width, bc.height) };
    const img = basePixels.current.img;
    const rgb = pixelAt(img.data, img.width, img.height, ix, iy);
    if (!rgb) { setProbe(null); return; }
    let orig: RGB | null = null;
    if (wantBwColor) {
      const c = bwColor.current;
      if (c.stale) refreshBwColor();
      if (c.frame) orig = pixelAt(c.frame.pixels, c.frame.width, c.frame.height, ix, iy);
    }
    setProbe({ rgb, orig, zone: zonesOpen && zoneData ? zoneAt(zoneData, ix, iy) : null });
  };
  const refreshBwColor = () => {
    const c = bwColor.current;
    if (c.busy) return;
    window.clearTimeout(c.timer);
    c.timer = window.setTimeout(async () => {
      const s = session.current;
      if (!s || c.busy) return;
      c.busy = true;
      c.stale = false;
      try {
        const f = await s.preview(512, { bw_mode: 0 });
        const fw = full.current;
        // the render must cover the same image as the view, crop and all
        const same = fw && Math.abs(f.width / f.height - fw.w / fw.h) < 0.02 * (fw.w / fw.h);
        if (session.current === s) c.frame = same ? f : null;
      } catch {
        c.stale = true;
      } finally {
        c.busy = false;
      }
      const a = probeAt.current;
      if (a) readProbe(a.x, a.y);
    }, c.frame ? 400 : 0);
  };
  const moveProbe = (e: React.PointerEvent<HTMLElement>) => {
    if (!wantProbe || drag.current?.moved || (e.target as Element).closest(".cand-pane")) {
      if (probeAt.current) { probeAt.current = null; setProbe(null); }
      return;
    }
    probeAt.current = { x: e.clientX, y: e.clientY };
    if (probeRaf.current) return;
    probeRaf.current = requestAnimationFrame(() => {
      probeRaf.current = 0;
      const a = probeAt.current;
      if (a) readProbe(a.x, a.y);
    });
  };
  const leaveProbe = () => { probeAt.current = null; setProbe(null); };
  // the zones are measured again after an edit, under a pointer at rest
  useEffect(() => {
    const a = probeAt.current;
    if (a && zonesOpen) readProbe(a.x, a.y);
  }, [zoneData]);   // eslint-disable-line react-hooks/exhaustive-deps

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (lineRef.current) return;
    if (!current || croppingRef.current || !viewZ.current) return;
    if (pickingRef.current) {
      const { sx, sy } = paneXY(e.clientX, e.clientY);
      const { ix, iy } = imageAt(sx, sy);
      if (ix >= 0 && ix <= 1 && iy >= 0 && iy <= 1) { setPicking(false); void startWB({ ix, iy }); }
      return;
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, cx: center.current.x, cy: center.current.y, moved: false };
    if (baModeRef.current === "overlay" && e.button === 0) { setHolding(true); setHoldHint(false); }
  };
  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    moveProbe(e);
    if (lineRef.current) {
      const v = viewer.current!.getBoundingClientRect();
      lineRef.current = { ...lineRef.current, x1: e.clientX - v.left, y1: e.clientY - v.top };
      setLine(lineRef.current);
      return;
    }
    const d = drag.current, f = full.current;
    if (!d || !f || zoomRef.current === "fit") return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (!d.moved) return;
    setHolding(false);
    const dpr = window.devicePixelRatio || 1;
    center.current = { x: clamp01(d.cx - (dx * dpr) / (f.w * viewZ.current)),
                       y: clamp01(d.cy - (dy * dpr) / (f.h * viewZ.current)) };
    placeLayers();
  };
  const onPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    if (lineRef.current) { finishStraighten(); return; }
    const d = drag.current;
    drag.current = null;
    setHolding(false);
    if (!d || !full.current) return;
    if (d.moved) {
      updatePlacement();
      session.current?.requestRender();
      return;
    }
    // holding the photo shows the before in the overlay view, so a click
    // there does not zoom
    if (baModeRef.current === "overlay") return;
    if (zoomRef.current !== "fit") { animateTo("fit"); return; }
    const { sx, sy } = paneXY(e.clientX, e.clientY);
    animateTo(1, { ...imageAt(sx, sy), sx, sy });
  };

  // the wheel (and a trackpad pinch, a wheel event with ctrl) zooms from fit
  // to 4:1 around the point under the cursor, eased; the sharp render comes
  // once the wheel has been still for a moment
  useEffect(() => {
    const el = viewer.current!;
    const MAX_SCALE = 4;
    const WHEEL_CAP = 50;
    const onWheel = (e: WheelEvent) => {
      if (!session.current || !full.current || !viewZ.current || croppingRef.current) return;
      e.preventDefault();
      if ((e.target as Element).closest(".cand-pane")) return;
      if (brushWheelRef.current(e)) return;
      const a = anim.current;
      const from = a.raf ? a.target : viewZ.current;
      // about 4% per wheel notch; one event's delta is capped because macOS
      // wheel acceleration can report several notches at once
      const delta = Math.max(-WHEEL_CAP, Math.min(WHEEL_CAP, e.deltaY));
      let to = Math.min(MAX_SCALE, from * Math.exp(-delta * (e.ctrlKey ? 0.006 : 0.0008)));
      // a detent at 100%: crossing it stops there, the next notch moves on
      if ((from < 1 && to > 1) || (from > 1 && to < 1)) to = 1;
      if (to <= fitScale() * 1.001) { animateTo("fit", null, 150, false); return; }
      const { sx, sy } = paneXY(e.clientX, e.clientY);
      animateTo(to, { ...imageAt(sx, sy), sx, sy }, 150, false);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const frameSize = () => {
    const p = placementRef.current;
    return p ? { w: p.fullWidth, h: p.fullHeight } : { w: 3, h: 2 };
  };

  const enterCrop = () => {
    const s = session.current;
    if (!s || croppingRef.current) return;
    setBaMode("off");
    setCompare(null);
    setZoom("fit");
    const v = s.values;
    const rect = { l: v.crop_l ?? 0, t: v.crop_t ?? 0, r: v.crop_r ?? 1, b: v.crop_b ?? 1 };
    const rd = v.crop_rd ?? 0, rn = v.crop_rn ?? 0;
    // darktable's ratio_d:ratio_n back to a preset; 1:0 is the image's own.
    // a photo never cropped (whole, with no ratio) starts at Original, as in
    // Lightroom, rather than Free
    const whole = rect.l === 0 && rect.t === 0 && rect.r === 1 && rect.b === 1;
    // a ratio no preset has is a custom: one typed in before, or the photo's own
    const same = (a: Aspect) => Array.isArray(a.ratio) && rd > 0 && rn > 0
      && a.ratio[0] * Math.min(rd, rn) === a.ratio[1] * Math.max(rd, rn);
    const own = rd > 0 && rn > 0 && !ASPECTS.some(same) && !cropCustoms.some(same) ? customAspect(rd, rn) : null;
    const preset = rd === 0 && rn === 0 ? (whole ? "original" : "free") : rn === 0 ? "original"
      : (ASPECTS.find(same) ?? cropCustoms.find(same) ?? own)?.id ?? "free";
    // the guide starts in the photo's orientation: the image shown until
    // crop is bypassed below is the crop as it stands, or the whole photo
    const p = placementRef.current;
    setCropRect(rect);
    setCropOwn(own);
    setCropEntry(null);
    setCropAspect(preset);
    setCropPortrait(!!p && p.fullHeight > p.fullWidth);
    croppingRef.current = true;
    setCropping(true);
    s.bypass("crop", true);
  };

  const leaveCrop = (apply: boolean) => {
    const s = session.current;
    if (!s || !croppingRef.current) return;
    croppingRef.current = false;
    setCropping(false);
    setStraightening(false);
    if (apply) {
      const { rect, aspect, choices } = cropRef.current;
      const a = findAspect(aspect, choices);
      const [rd, rn] = a.ratio === null ? [0, 0] : a.ratio === "original" ? [1, 0] : a.ratio;
      // one history step for the crop, not one per edge
      const v = s.values;
      const entries = ([["crop_l", rect.l], ["crop_t", rect.t], ["crop_r", rect.r], ["crop_b", rect.b],
                        ["crop_rd", rd], ["crop_rn", rn]] as [string, number][]).filter(([id, x]) => v[id] !== x);
      if (entries.length) {
        setAmount(null);
        changeMany(entries, "Crop");
      }
    }
    s.bypass("crop", false);
  };

  // Lightroom's Rotate Left and Right (⌘[ and ⌘]), Flip Horizontal and
  // Vertical: darktable's flip, with the crop carried along
  const turn = async (how: Turn) => {
    const s = session.current;
    if (!s) return;
    // a shape still on its way is sent in the frame it was drawn in
    await s.settled();
    changeMany(s.turned(how));
    s.reloadShapes();
    if (croppingRef.current) {
      setCropRect((r) => turnRect(r, how));
      if (how === "cw" || how === "ccw") setCropPortrait((p) => !p);
    }
  };

  const chooseAspect = (id: string, portrait: boolean, choices = cropRef.current.choices) => {
    setCropAspect(id);
    setCropPortrait(portrait);
    const a = pixelAspect(findAspect(id, choices), portrait, frameSize());
    if (a !== null) setCropRect((r) => fitAspect(r, a, frameSize()));
  };
  // a custom aspect typed in: kept for later, laid as it was typed
  const setCustomAspect = () => {
    if (!cropEntry) return;
    const [w, h] = cropEntry.map(Number);
    const a = customAspect(w, h);
    if (!a) { setStatus("enter two numbers above 0"); return; }
    setCropEntry(null);
    const preset = ASPECTS.find((x) => Array.isArray(x.ratio) && Array.isArray(a.ratio)
                                       && x.ratio[0] * a.ratio[1] === x.ratio[1] * a.ratio[0]);
    if (preset) { chooseAspect(preset.id, h > w); return; }
    const customs = rememberCustomAspect(a, cropCustoms);
    setCropCustoms(customs);
    if (cropOwn?.id === a.id) setCropOwn(null);
    chooseAspect(a.id, h > w, customs);
  };

  // the overlay sits exactly over the image as drawn
  useEffect(() => {
    if (!cropping || !canvas.current || !viewer.current) { setCropBox(null); return; }
    const c = canvas.current.getBoundingClientRect(), v = viewer.current.getBoundingClientRect();
    setCropBox({ left: c.left - v.left, top: c.top - v.top, width: c.width, height: c.height });
  }, [cropping, placement]);

  // a floating panel comes in at its edge of the window (on the right, the
  // rail), and goes a moment after the pointer leaves it; never while a
  // drag is under way, a field in it is being typed in, or a dialog is up.
  // the filmstrip's edge is the window's, below the toolbar: the toolbar
  // only keeps it open, so reaching for its buttons does not bring it up.
  // the pointer has to rest at the edge a moment first: one passing over it
  // on the way somewhere else leaves the panel where it is
  useEffect(() => {
    if (!autoHide) return;
    const timers: Record<keyof Pins, number> = { left: 0, right: 0, strip: 0 };
    const opening: Record<keyof Pins, number> = { left: 0, right: 0, strip: 0 };
    const cancelOpening = (k: keyof Pins) => { clearTimeout(opening[k]); opening[k] = 0; };
    const show = (k: keyof Pins, on: boolean) => {
      if (revealedRef.current[k] === on) return;
      revealedRef.current = { ...revealedRef.current, [k]: on };
      setRevealed(revealedRef.current);
    };
    const typing = (el: Element | null) => el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
      || (el instanceof HTMLInputElement && !["range", "checkbox", "button"].includes(el.type));
    const onMove = (e: PointerEvent) => {
      for (const k of ["left", "right", "strip"] as const) {
        if (!floatingRef.current[k]) { clearTimeout(timers[k]); timers[k] = 0; cancelOpening(k); show(k, false); continue; }
        const aside = (k === "left" ? leftAside : k === "right" ? rightAside : stripSlot).current;
        const r = aside?.getBoundingClientRect();
        const tr = k === "strip" ? toolbar.current?.getBoundingClientRect() : undefined;
        const inside = !!r && revealedRef.current[k] && (e.clientX >= r.left - 8 && e.clientX <= r.right + 8
          && e.clientY >= r.top - 8 && e.clientY <= r.bottom
          || !!tr && e.clientY >= tr.top && e.clientY <= tr.bottom && e.clientX >= tr.left && e.clientX <= tr.right);
        const rr = rail.current?.getBoundingClientRect();
        const edge = k === "left" ? e.clientX <= 10
          : k === "right" ? e.clientX >= (rr ? rr.left - 4 : window.innerWidth - 10)
          : e.clientY >= window.innerHeight - 10;
        const busy = revealedRef.current[k] && (e.buttons !== 0 || !!document.querySelector(".modal-backdrop")
          || (!!aside && aside.contains(document.activeElement) && typing(document.activeElement)));
        if (inside || busy || edge && revealedRef.current[k]) {
          clearTimeout(timers[k]);
          timers[k] = 0;
          cancelOpening(k);
          show(k, true);
        } else if (edge) {
          if (!opening[k]) opening[k] = window.setTimeout(() => { opening[k] = 0; show(k, true); }, 250);
        } else {
          cancelOpening(k);
          if (revealedRef.current[k] && !timers[k])
            timers[k] = window.setTimeout(() => { timers[k] = 0; show(k, false); }, 600);
        }
      }
    };
    // leaving the window over an edge is passing it too
    const onOut = (e: PointerEvent) => {
      if (!e.relatedTarget) for (const k of ["left", "right", "strip"] as const) cancelOpening(k);
    };
    window.addEventListener("pointermove", onMove);
    document.addEventListener("pointerout", onOut);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerout", onOut);
      for (const k of ["left", "right", "strip"] as const) { clearTimeout(timers[k]); cancelOpening(k); }
    };
  }, [autoHide]);

  // Lightroom's keys: Z toggles fit and the navigator's level, the arrows
  // step through the folder, 0-5 rate, 6-9 toggle the red, yellow, green and
  // blue labels, X rejects. typing in a field, or a focused slider's arrows, are left alone
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      // a dialog owns the keyboard while it is open
      if (document.querySelector(".modal-backdrop")) return;
      if (t instanceof HTMLTextAreaElement) return;
      if (t instanceof HTMLInputElement && (t.type !== "range" || e.key.startsWith("Arrow"))) return;
      // the import screen has its own keys; Preferences still opens over it
      if (importOpenRef.current && !(cmd(e) && (e.key === "," || e.code === "Slash"))) return;
      if (cmd(e) && e.shiftKey && e.code === "KeyP") {
        e.preventDefault();
        setPerfHud(!perf.enabled);
        perf.enable(!perf.enabled);
        return;
      }
      if (cmd(e) && e.shiftKey && (e.key === "e" || e.key === "E")) {
        e.preventDefault();
        setExporting(true);
        return;
      }
      // Copy Settings, Paste and Previous, as Lightroom's ⇧⌘C, ⇧⌘V and ⌥⌘V
      if (cmd(e) && (e.key === "c" || e.key === "C" || e.code === "KeyC") && e.shiftKey) {
        e.preventDefault();
        if (session.current) setCopying(true);
        return;
      }
      if (cmd(e) && e.code === "KeyV" && (e.shiftKey || e.altKey)) {
        e.preventDefault();
        if (e.altKey) pastePreviousRef.current(); else pasteSettingsRef.current();
        return;
      }
      if (cmd(e) && e.code === "Slash") {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      // Create Virtual Copy, as Lightroom's ⌘': of the selection, else the open photo
      if (cmd(e) && e.code === "Quote") {
        e.preventDefault();
        const sel = selectionRef.current, all = imagesRef.current;
        const list = sel.size ? all.filter((i) => sel.has(i.imgid)) : all.filter((i) => isOpen(i));
        void createCopiesRef.current(list);
        return;
      }
      // Preferences, as every Mac app's ⌘,
      if (cmd(e) && e.key === ",") {
        e.preventDefault();
        setPrefsOpen(true);
        return;
      }
      if (cmd(e) && e.shiftKey && (e.key === "i" || e.key === "I")) {
        e.preventDefault();
        setImportOpen(true);
        return;
      }
      if (cmd(e) && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        stepHistory(!e.shiftKey);
        return;
      }
      // zoom in and out, as Lightroom's ⌘= and ⌘-; by code, so ⇧⌘= (⌘+) zooms
      // too. marked used, so WebView2 does not zoom the page
      if (cmd(e) && (e.code === "Equal" || e.code === "Minus") && !e.altKey) {
        e.preventDefault();
        if (session.current && !croppingRef.current) stepZoom(e.code === "Equal" ? 1 : -1);
        return;
      }
      if (cmd(e) && (e.code === "BracketLeft" || e.code === "BracketRight")) {
        e.preventDefault();
        void turn(e.code === "BracketLeft" ? "ccw" : "cw");
        return;
      }
      // ⌘A selects every photo the filters leave showing
      if (cmd(e) && e.code === "KeyA" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setSelection(new Set(shownRef.current.map((i) => i.imgid)));
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // the preview is for looking: F or Escape leaves it, and only the keys
      // that look, rate or move to another photo work in it
      // the key is marked used: macOS beeps at one left unhandled while the
      // window changes style
      if (previewRef.current) {
        if (e.key === "f" || e.key === "F" || e.key === "Escape") { e.preventDefault(); setPreview(false); return; }
        if (!/^([zZyYxXiIlL\\0-9]|ArrowLeft|ArrowRight)$/.test(e.key)) return;
      } else if ((e.key === "f" || e.key === "F") && session.current) { e.preventDefault(); setPreview(true); return; }
      // I cycles the info over the photo: file, exposure, none, as Lightroom's
      if ((e.key === "i" || e.key === "I") && session.current) { setInfoMode((m) => (m + 1) % 3); return; }
      // L steps the canvas: dark, neutral gray, white. Lightroom sets it only
      // from the surround's context menu; its L (Lights Out) is the nearest key
      if ((e.key === "l" || e.key === "L") && session.current) {
        setCanvasColor((c) => {
          const next = CANVASES[(CANVASES.indexOf(c) + 1) % CANVASES.length];
          storeCanvas(next);
          return next;
        });
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        hidePanels(e.shiftKey ? ["left", "right", "strip"] : ["left", "right"]);
        return;
      }
      if ((e.key === "g" || e.key === "G") && !croppingRef.current) { setGrid(!gridRef.current); return; }
      if (e.key === "Escape" && gridRef.current) { setGrid(false); return; }
      if (e.key === "\\" && !croppingRef.current) { setBaModeRef.current("off"); setBefore(!beforeRef.current); return; }
      if ((e.key === "y" || e.key === "Y") && !croppingRef.current) { cycleBaModeRef.current(); return; }
      if ((e.key === "c" || e.key === "C") && !croppingRef.current) { toggleCompareRef.current(); return; }
      if (e.key === "Escape" && compareRef.current !== null) { setCompareRef.current(null); return; }
      if (straighteningRef.current && e.key === "Escape") { setStraightening(false); return; }
      if (guidingRef.current && e.key === "Escape") { setGuiding(false); return; }
      // the crop tool: R toggles it, Enter applies, Escape cancels, X swaps
      // the orientation of the aspect
      if (croppingRef.current) {
        if (e.key === "Enter" || e.key === "r" || e.key === "R") leaveCrop(true);
        else if (e.key === "Escape") leaveCrop(false);
        else if (e.key === "x" || e.key === "X") chooseAspect(cropRef.current.aspect, !cropRef.current.portrait);
        return;
      }
      if (pickingRef.current && e.key === "Escape") { setPicking(false); return; }
      // W picks white balance from the image, as in Lightroom
      if ((e.key === "w" || e.key === "W") && session.current) { setPicking(!pickingRef.current); return; }
      if (healModeRef.current && healKeyRef.current(e)) return;
      // O shows or hides the pinned zones' overlay, as it does a mask's
      if (zoneBoxingRef.current && e.key === "Escape") { setZoneBoxing(false); return; }
      if (zonesModeRef.current && (e.key === "o" || e.key === "O")) {
        setZoneOverlayState((o) => { const next = { ...o, show: !o.show }; saveZoneOverlay(next); return next; });
        return;
      }
      if (masksModeRef.current) {
        if (e.key === "Escape") { setMaskTool(null); return; }
        if (e.key === "o" || e.key === "O") { overlayEvent("key"); return; }
        if (e.key === "[" || e.key === "]") {
          setBrush((b) => ({ ...b, size: Math.min(0.4, Math.max(0.005, b.size * (e.key === "]" ? 1.15 : 1 / 1.15))) }));
          return;
        }
      }
      if (e.shiftKey && (e.key === "j" || e.key === "J")) { pickToolRef.current("color"); return; }
      // J shows both clipping overlays, or hides them, as in Lightroom
      if (e.key === "j" && !cmd(e) && !e.altKey) {
        setClipOn((o) => (o.low && o.high ? { low: false, high: false } : { low: true, high: true }));
        return;
      }
      if (e.shiftKey && (e.key === "q" || e.key === "Q")) { pickToolRef.current("luminance"); return; }
      if (e.key === "k" || e.key === "K") { pickToolRef.current("brush"); return; }
      if (e.key === "m" || e.key === "M") { pickToolRef.current(e.shiftKey ? "ellipse" : "gradient"); return; }
      if (e.key === "r" || e.key === "R") { enterCrop(); return; }
      if ((e.key === "q" || e.key === "Q") && session.current) { showHealRef.current(); return; }
      const list = shownRef.current;
      const at = list.findIndex((i) => isOpen(i));
      const cur = at >= 0 ? list[at] : null;
      if (e.key === "z" || e.key === "Z") setZoom(zoomRef.current === "fit" ? navZoom.current : "fit");
      else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && compareRef.current !== null) {
        // comparing, the arrows step the candidate, past the open photo
        e.preventDefault();
        const step = e.key === "ArrowRight" ? 1 : -1;
        let k = list.findIndex((i) => i.imgid === compareRef.current) + step;
        if (k === at) k += step;
        if (k >= 0 && k < list.length && !isRemote(list[k])) setCompareRef.current(list[k].imgid);
      }
      else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        stepDir.current = e.key === "ArrowRight" ? 1 : -1;
        const next = list[Math.min(list.length - 1, Math.max(0, at + stepDir.current))];
        if (next) { e.preventDefault(); void openEntry(next); }
      }
      else if (!cur) return;
      else if (e.key >= "0" && e.key <= "5") rateSelection(cur, { rating: Number(e.key), rejected: false });
      else if (e.key >= "6" && e.key <= "9") {
        const bit = 1 << (Number(e.key) - 6);
        rateSelection(cur, { labels: bit });
      }
      else if (e.key === "x" || e.key === "X") rateSelection(cur, { rejected: !cur.rejected });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // a resize keeps the view; a fitted image refits, then all renders again
  useEffect(() => {
    let t: number | undefined;
    const ro = new ResizeObserver(() => {
      if (zoomRef.current === "fit" && full.current) { viewZ.current = fitScale(); placeLayers(); }
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        baseStale.current = true;
        session.current?.requestRender();
      }, 150);
    });
    ro.observe(pane.current!);
    return () => ro.disconnect();
  }, []);

  // stacked pairs: a raw's JPEG or HEIF hides behind it, unless the
  // filters leave the raw out
  const partners = stackPairs ? pairPartners(images) : new Map<number, ImageEntry[]>();
  partnersRef.current = partners;
  const passing = images.filter((i) => passes(i, filter));
  const behind = new Set(passing.flatMap((i) => (partners.get(i.imgid) ?? []).map((p) => p.imgid)));
  const shown = passing.filter((i) => !behind.has(i.imgid));
  // the files still to be read, as empty cells after the photos: unless the
  // filters ask for what only reading tells (ratings, labels, rejects)
  const rawNames = stackPairs && reading ? pairedRaws(reading.files) : null;
  const pending = !reading || filter.minRating || filter.rejected !== "all" || filter.edited !== "all" || filter.labels
    || filter.unlabeled ? []
    : reading.files.slice(reading.done).filter((p) => !filter.kinds.length || filter.kinds.includes(fileKind(p)))
        // a raw's companions, stacked behind it
        .filter((p) => !rawNames?.has(pairKey(p)) || !isCompanion(p));
  const kindCounts = (() => {
    const m = new Map<string, number>();
    for (const i of images) { const k = fileKind(i.filename); m.set(k, (m.get(k) ?? 0) + 1); }
    // RAW first, then the rest by name
    return [...m].sort(([a], [b]) => (a === "RAW" ? -1 : b === "RAW" ? 1 : a.localeCompare(b)));
  })();
  const shownRef = useRef<ImageEntry[]>([]);
  shownRef.current = shown;
  // the open photo's cell in the filmstrip, if the filmstrip shows it, and
  // its entry whichever folder is shown
  const listedEntry = images.find((i) => isOpen(i, current)) ?? null;
  const currentEntry = listedEntry ?? (openCell && isOpen(openCell, current) ? openCell : null);
  // zoomed in, the part of the image the sharp render shows, for the overlays
  const shownRegion: Region | null = shownView && !shownView.fit && full.current
    ? [shownView.x / (shownView.scale * full.current.w), shownView.y / (shownView.scale * full.current.h),
       (shownView.x + shownView.width) / (shownView.scale * full.current.w),
       (shownView.y + shownView.height) / (shownView.scale * full.current.h)]
    : null;

  // the open image's text fields come from the engine, which read them from
  // the sidecar on import
  const currentId = currentEntry?.imgid;
  useEffect(() => {
    setMetaText(null);
    setKeywords(null);
    if (currentId === undefined) return;
    let stale = false;
    invoke<{ image: { metadata: TextFields; keywords: string[] } }>("meta", { imgid: currentId })
      .then((r) => {
        if (stale) return;
        setMetaText(r.image.metadata);
        setKeywords(r.image.keywords);
      })
      .catch((e) => setStatus(`error: ${e}`));
    invoke<string[]>("keywords").then((k) => { if (!stale) setKnownKeywords(k); }).catch(() => {});
    return () => { stale = true; };
  }, [currentId]);
  // keywords added by something other than the Keywording card: an export
  // that adds its keywords to the originals
  const reloadKeywords = () => {
    if (currentId !== undefined)
      invoke<{ image: { keywords: string[] } }>("meta", { imgid: currentId })
        .then((r) => setKeywords(r.image.keywords)).catch(() => {});
    invoke<string[]>("keywords").then(setKnownKeywords).catch(() => {});
  };
  // the open photo's keywords, for a save made after the render they came
  // from (Session.onSaved)
  const keywordsRef = useRef<{ imgid: number; list: string[] } | null>(null);
  keywordsRef.current = keywords && currentId !== undefined ? { imgid: currentId, list: keywords } : null;
  // Preferences' keywords for edited photos: on once a save finds the photo
  // edited, off again once one finds it unedited
  const syncEditedKeywords = async (imgid: number, edited: boolean) => {
    const wanted = loadEditedKeywords();
    if (!wanted.length) return;
    try {
      // the photo may be closed already, its last save made on leaving it
      const known = keywordsRef.current?.imgid === imgid ? keywordsRef.current.list
        : (await invoke<{ image: { keywords: string[] } }>("meta", { imgid })).image.keywords;
      const add = edited ? wanted.filter((k) => !known.includes(k)) : [];
      const remove = edited ? [] : wanted.filter((k) => known.includes(k));
      if (!add.length && !remove.length) return;
      const now = await invoke<string[]>("keywords_set", { imgid, add, remove });
      if (session.current?.imgid === imgid) setKeywords(now);
      if (add.length) setKnownKeywords((k) => [...new Set([...k, ...add])].sort((a, b) => a.localeCompare(b)));
    } catch (e) {
      setStatus(`error: ${e}`);
    }
  };
  // the open photo's text fields, as keywordsRef
  const metaTextRef = useRef<{ imgid: number; text: TextFields } | null>(null);
  metaTextRef.current = metaText && currentId !== undefined ? { imgid: currentId, text: metaText } : null;
  // Preferences' copyright and creator, into an edited photo's empty fields
  // only, so the camera's own copyright stays; a reset leaves them
  const fillEditedMeta = async (imgid: number) => {
    const wanted = loadEditedMeta();
    if (!wanted.rights.trim() && !wanted.creator.trim()) return;
    try {
      let text = metaTextRef.current?.imgid === imgid ? metaTextRef.current.text : null;
      let datetime = imagesRef.current.find((i) => i.imgid === imgid)?.exif?.datetime;
      if (!text) {
        const r = await invoke<{ image: { metadata: TextFields; exif?: { datetime?: string } } }>("meta", { imgid });
        text = r.image.metadata;
        datetime ??= r.image.exif?.datetime;
      }
      const year = /^\d{4}/.exec(datetime ?? "")?.[0] ?? String(new Date().getFullYear());
      const fields: Partial<TextFields> = {};
      for (const k of ["rights", "creator"] as const)
        if (wanted[k].trim() && !text[k].trim()) fields[k] = wanted[k].trim().replace(/\{year\}/g, year);
      if (!Object.keys(fields).length) return;
      await invoke("meta_set", { imgid, fields });
      if (session.current?.imgid === imgid) setMetaText((t) => (t ? { ...t, ...fields } : t));
    } catch (e) {
      setStatus(`error: ${e}`);
    }
  };
  const setPhotoKeywords = async (add: string[], remove: string[]) => {
    if (currentId === undefined || (!add.length && !remove.length)) return;
    try {
      setKeywords(await invoke<string[]>("keywords_set", { imgid: currentId, add, remove }));
      if (add.length) setKnownKeywords((k) => [...new Set([...k, ...add])].sort((a, b) => a.localeCompare(b)));
    } catch (e) {
      setStatus(`error: ${e}`);
    }
  };

  // which side panels float (auto-hide) and which take their space
  const floating: Pins = {
    left: autoHide && !touring && !preview && layout.left && !pins.left,
    right: autoHide && !touring && !preview && layout.right && !pins.right,
    strip: autoHide && !touring && !preview && layout.strip && !pins.strip && !grid,
  };
  floatingRef.current = floating;
  const docked = { left: layout.left && !floating.left, right: layout.right && !floating.right };

  // the selection follows the open photo when it moves outside it (the
  // arrow keys), and keeps to the photos still listed
  const currentImgid = currentEntry?.imgid;
  useEffect(() => {
    if (currentImgid === undefined) return;
    setSelection((old) => (old.has(currentImgid) ? old : new Set([currentImgid])));
  }, [currentImgid]);
  useEffect(() => {
    setSelection((old) => {
      const ids = new Set(shown.map((i) => i.imgid));
      const kept = [...old].filter((id) => ids.has(id));
      return kept.length === old.size ? old : new Set(kept);
    });
  }, [shown]);

  const [infoMode, setInfoMode] = useState(loadInfoMode);
  useEffect(() => { try { localStorage.setItem(INFO_MODE_KEY, String(infoMode)); } catch { /* not kept */ } }, [infoMode]);
  const fileName = current ? baseName(current.path) : null;
  const fileDir = current ? current.path.slice(0, current.path.length - (fileName?.length ?? 0) - 1) : null;
  // the folder tree opens down to the open photo's folder, once for each
  // folder it comes from, so one the user closes again stays closed
  const photoDir = current && !immich ? parentDir(current.path) : null;
  useEffect(() => {
    if (!photoDir) return;
    const root = foldersRef.current.find((r) => within(photoDir, r));
    if (!root) return;
    const want: string[] = [];
    for (let d = parentDir(photoDir); within(d, root); d = parentDir(d)) {
      want.push(d);
      if (d === root || parentDir(d) === d) break;
    }
    const open = expandedRef.current;
    if (want.every((d) => open.has(d))) return;
    setExpandedTo(new Set([...open, ...want]));
  }, [photoDir]);   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`window${preview ? " preview" : ""}`}>
    {/* the window's title bar is hidden (tauri.conf.json); this strip moves
        the window and leaves room for the traffic lights */}
    {/* full screen has no traffic lights to hold, and the photo wants the room */}
    {!fullscreen && <div className="titlebar" data-tauri-drag-region><span data-tauri-drag-region>Immage</span></div>}
    <div className={`app${sliding ? " sliding" : ""}`} style={{
      gridTemplateColumns: preview ? "0px 0px minmax(0, 1fr) 0px 0px 0px 0px"
        : `${docked.left ? layout.leftWidth : 0}px ${docked.left ? 8 : 0}px minmax(0, 1fr)`
          + ` ${docked.right ? 8 : 0}px ${docked.right ? layout.rightWidth : 0}px 8px 44px`,
    }}>
      <div className={`slot left-slot${layout.left ? "" : " closed"}${floating.left ? " floating" : ""}`
                      + `${floating.left && revealed.left ? " revealed" : ""}`}>
      <aside className="left" ref={leftAside} style={{ width: layout.leftWidth }}>
        <div className="panel-head"><h1>Library</h1>{pinButton("left")}</div>
        <Navigator thumb={navThumb} zoom={zoom} placement={placement} disabled={!current}
                   onZoom={(z) => { if (z !== "fit") navZoom.current = z; setZoom(z); }}
                   onPan={(x, y, done) => {
                     center.current = { x: clamp01(x), y: clamp01(y) };
                     placeLayers();
                     if (done) { updatePlacement(); session.current?.requestRender(); }
                   }} />
        <MetadataPanel image={currentEntry} text={metaText}
                       open={leftOpen.has("metadata")} onToggle={(alt) => toggleLeft("metadata", alt)}
                       onMeta={(fields) => currentEntry && setMeta(currentEntry.imgid, fields)}
                       onText={(field, value) => {
                         if (!currentEntry) return;
                         setMetaText((t) => (t ? { ...t, [field]: value } : t));
                         void setMeta(currentEntry.imgid, { [field]: value });
                       }} />
        <KeywordingPanel keywords={currentEntry ? keywords : null} known={knownKeywords}
                         open={leftOpen.has("keywording")} onToggle={(alt) => toggleLeft("keywording", alt)}
                         onAdd={(names) => void setPhotoKeywords(names, [])}
                         onRemove={(name) => void setPhotoKeywords([], [name])} />
        {/* a card as Metadata and Keywording are, open until folded, and
            kept as it was left */}
        <div className="panel folders-panel" data-tour="folders">
          <div className={`panel-title${foldersOpen ? " open" : ""}`} onClick={(e) => toggleLeft("folders", e.altKey)}>
            <span>Folders</span>
            <button className="refresh" title="read the folders and the open folder's photos again"
                    onClick={(e) => {
                      e.stopPropagation();
                      setFolderRefresh((n) => n + 1);
                      if (folder) void showFolder(folder, true);
                    }}><RefreshIcon /></button>
            <svg className={`chevron${foldersOpen ? " open" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 15 6-6 6 6" /></svg>
          </div>
          {foldersOpen && (
            <div className="folders-body">
              <label className="sub-toggle" title="show the photos in a folder's subfolders too">
                <span>Include subfolders</span>
                <input type="checkbox" className="switch" checked={includeSub} onChange={(e) => {
                  const on = e.target.checked;
                  setIncludeSub(on);
                  storeIncludeSubfolders(on);
                  includeSubRef.current = on;
                  if (folder) void showFolder(folder);
                }} />
              </label>
              <FolderTree roots={folders} current={immich ? null : folder} photo={photoDir} expanded={expanded} hidden={hidden}
                          refresh={folderRefresh}
                          icon={<FolderIcon />} onOpen={(d) => { void showFolder(d); setGrid(true); }} onRemove={removeFolder}
                          onToggle={(d) => {
                            const next = new Set(expanded);
                            if (next.has(d)) next.delete(d); else next.add(d);
                            setExpandedTo(next);
                          }} />
              <button className="folder add" onClick={addFolder}><span>+ Add folder…</span></button>
            </div>
          )}
        </div>
        {immichBase && (
          <ImmichPanel open={leftOpen.has("immich")} onToggle={(alt) => toggleLeft("immich", alt)}
                       active={!!immich} searching={!!immich?.busy} onSearch={(q) => void searchImmich(q)}
                       onMenu={showResultsMenu} />
        )}
        <HistoryPanel base={historyBase.filter((h) => !session.current?.deleted.has(instanceKey(h)))
                             .map((h) => {
                               const st = session.current?.moduleStates.get(instanceKey(h));
                               return st ? { ...h, enabled: st.enabled } : h;
                             })}
                      actionOf={historyAction} onChange={historyChange}
                      steps={[...undo.current.past, ...[...undo.current.future].reverse()].map((x) => x.label)}
                      at={undo.current.past.length} disabled={!current || cropping}
                      open={leftOpen.has("history")} onToggle={(alt) => toggleLeft("history", alt)}
                      onGo={(n) => {
                        const d = n - undo.current.past.length;
                        if (d) stepHistory(d < 0, Math.abs(d));
                      }}
                      onCompress={() => void compressHistory()} />
      </aside>
      </div>

      <Splitter axis="x" value={layout.leftWidth} min={220} max={560} hidden={!docked.left}
                onChange={(v) => setLayout((l) => ({ ...l, leftWidth: v }))} />
      <section className="center">
        <main data-tour="viewer" className={`viewer zoom-${zoom === "fit" ? "fit" : "in"}${picking ? " picking" : ""}${aiBusy ? " busy" : ""}${straightening || line || (shiftHeld && current && (cropping || (!masksMode && !healMode)) && !preview) ? " straightening" : ""}${canvasColor !== "dark" ? ` canvas-${canvasColor}` : ""}${baMode === "overlay" ? " hold-view" : ""}${optPreview?.kind === "gray" ? " gray-view" : ""}`} ref={viewer}
              onPointerDownCapture={onStraightenDown}
              onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
              onPointerLeave={leaveProbe}>
          <div ref={pane} className={`after-pane${baMode === "side" ? " half" : compare !== null ? " half-left" : ""}`}>
            <canvas ref={baseCanvas} className={`layer base${current ? "" : " empty"}`} />
            <canvas ref={clipBase} className={`layer clip${current && (clipShown.low || clipShown.high) ? "" : " empty"}`} />
            {/* it carries neither the Before view nor the clipping overlay */}
            <canvas ref={copyCanvas} className={`layer copy${current && copyOn && !before && baMode === "off"
                      && !clipShown.low && !clipShown.high ? "" : " empty"}`} />
            <canvas ref={canvas} className={`layer sharp${current ? "" : " empty"}`} />
            <canvas ref={clipSharp} className={`layer clip${current && (clipShown.low || clipShown.high) ? "" : " empty"}`} />
            {perfHud && current && <PerfHud onClose={() => { setPerfHud(false); perf.enable(false); }} />}
            <canvas ref={hoverCanvas} className={`hover-preview${(hoverShown === "tiles" && tilesShown)
                      || (hoverShown === "panel" && rightMode === "adjust" && !cropping) ? "" : " off"}`} />
            {masksMode && current && !cropping && !preview && full.current && (
              <div className="mask-box" ref={maskBox}>
                <MaskOverlay boxRef={maskBox} image={full.current} region={shownRegion}
                             mask={masks.find((m) => m.name === maskSel) ?? null} peek={peekMask}
                             ranges={rangeFor === (peekMask ?? selMask)?.name ? rangeMap : null}
                             final={finalMap && finalMap.session === session.current && finalMap.name === (peekMask ?? selMask)?.name
                                    && wantsFinal(peekMask ?? selMask!) ? finalMap.map : null}
                             onPick={(x, y) => void pickRange(x, y)}
                             onObject={(p) => void selectObject(p)}
                             onPickArea={(area, at) => void pickArea(area, at)}
                             color={(() => {
                               const p = selMask?.shapes[shapeSel];
                               return pmTab && p?.type === "parametric" ? channelTint(pmTab, p.channels[pmTab]) : null;
                             })()}
                             overlayColor={maskOverlayRgb(overlayColor)}
                             onHoverPick={pickShow && selMask?.shapes[shapeSel]?.type === "parametric" ? hoverPick : null}
                             tool={maskTool} brush={brush} showOverlay={(maskShown && !adjusting) || refining} adding={addingTo} shaping={refining} selected={shapeSel}
                             newMask={toolTarget === "new" && !!maskTool}
                             subtract={toolTarget === "subtract" && !!maskTool}
                             onSelect={setShapeSel}
                             onChange={(shapes) => {
                               if (!maskSel) return;
                               record([`mask:drag:${maskSel}`]);
                               session.current?.setShapes(maskSel, shapes);
                               syncMasks();
                             }}
                             onCreate={createShape} />
              </div>
            )}
            {(zoneShown || zoneBoxing) && full.current && (
              <div className="mask-box" ref={zoneBox}>
                {zoneShown && <canvas ref={zoneCanvas} className="mask-tint zone-tint" />}
                {zoneBoxing && <ObjectBox onPrompt={boxZoneObject} />}
              </div>
            )}
            {maskOp && full.current && (
              <div className="mask-box" ref={detailBox}>
                <canvas ref={detailCanvas} className="mask-tint detail-mask" />
              </div>
            )}
            {healMode && current && !cropping && !preview && full.current && (
              <div className="mask-box" ref={maskBox}>
                <SpotOverlay boxRef={maskBox} image={full.current} region={shownRegion} spots={spots} selected={spotSel} tool={spotTool}
                             visualize={visualize} base={baseCanvas} baseTick={baseTick} overlayColor={maskOverlayRgb(overlayColor)}
                             onSelect={setSpotSel} onCreate={(sp) => void createSpot(sp)}
                             onChange={(next) => editSpots(next, "spot:drag")} />
              </div>
            )}
            {transformView && full.current && (
              <div className="mask-box" ref={guideBox}>
                <GuideOverlay image={full.current} guides={guidesShown} guided={guiding} grid
                              onCommit={(i, g) => void commitGuide(i, g)} onDelete={(i) => void deleteGuide(i)} />
              </div>
            )}
            {vignetteGuides && full.current && session.current && (
              <div className="mask-box" ref={maskBox}>
                <VignetteOverlay image={full.current} values={values} ctx={session.current.context} sliding={vigSliding}
                                 onChange={(entries) => {
                                   if (entries.length === 1) change(controlById.get(entries[0][0])!, entries[0][1]);
                                   else { setAmount(null); changeMany(entries); }
                                 }} />
              </div>
            )}
          </div>
          {/* the split views and compare label their halves in this corner */}
          {current && infoMode < 2 && !cropping && compare === null && (baMode === "off" || baMode === "overlay") && (
            <InfoOverlay mode={infoMode} name={`${fileName}${copyName(currentEntry)}`} dir={fileDir ?? ""}
                         entry={currentEntry} />
          )}
          {baMode !== "off" && current && (
            <>
              <div className={`before-clip ${baMode}${baMode === "overlay" && !holding ? " hidden" : ""}`}
                   style={baMode === "vsplit" ? { width: `${splitPos * 100}%` }
                          : baMode === "hsplit" ? { height: `${splitPos * 100}%` } : undefined}>
                <canvas ref={beforeCanvas} className="layer" />
              </div>
              {(baMode === "vsplit" || baMode === "hsplit") && (
                <div className={`split-bar${baMode === "hsplit" ? " h" : ""}`}
                     style={baMode === "vsplit" ? { left: `${splitPos * 100}%` } : { top: `${splitPos * 100}%` }}
                     onPointerDown={(e) => {
                       e.stopPropagation();
                       (e.target as HTMLElement).setPointerCapture(e.pointerId);
                     }}
                     onPointerMove={(e) => {
                       if (!(e.target as HTMLElement).hasPointerCapture(e.pointerId)) return;
                       const r = viewer.current!.getBoundingClientRect();
                       const at = baMode === "vsplit" ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
                       setSplitPos(Math.min(0.98, Math.max(0.02, at)));
                     }}
                     onPointerUp={(e) => e.stopPropagation()}>
                  <span className="split-grip" />
                </div>
              )}
              {baMode === "side" && <div className="side-gap" />}
              {baMode !== "overlay" && <>
                <div className="split-label left">Before</div>
                <div className={`split-label ${baMode === "hsplit" ? "bottom" : baMode === "side" ? "pane-left" : "right"}`}>After</div>
              </>}
            </>
          )}
          {compare !== null && current && (() => {
            const cand = images.find((i) => i.imgid === compare);
            return (
              <>
                <div className="cand-pane" onPointerDown={(e) => e.stopPropagation()}>
                  <canvas ref={candCanvas} className={candReady ? "" : "loading"} />
                  {!candReady && <span className="cand-wait">rendering…</span>}
                </div>
                <div className="side-gap" />
                <div className="split-label left">A · {fileName}{copyName(currentEntry)}</div>
                <div className="split-label cand">
                  B · {cand?.filename ?? ""}{copyName(cand)}
                  {cand && <button title="edit this one, and compare against the other"
                                   onClick={() => {
                                     if (!currentEntry) return;
                                     swapping.current = true;
                                     setCompare(currentEntry.imgid);
                                     void openFile(cand.path, cand.imgid).finally(() => { swapping.current = false; });
                                   }}>⇄</button>}
                </div>
              </>
            );
          })()}
          {cropping && cropBox && !preview && (
            <CropOverlay rect={cropRect} box={cropBox} frame={frameSize()} onChange={setCropRect}
                         onOrient={setCropPortrait}
                         aspect={pixelAspect(findAspect(cropAspect, cropChoices), cropPortrait, frameSize())} />
          )}
          {(before || holding) && <div className="before-badge">Before</div>}
          {modeFlash && <div className="mode-flash">{modeFlash}</div>}
          {holdHint && <div className="hold-hint">Click and hold the photo to see the before</div>}
          {line && (
            <svg className="straighten-line">
              <line x1={line.x0} y1={line.y0} x2={line.x1} y2={line.y1} />
            </svg>
          )}
          <div className={`working${working ? " on" : ""}`} title="working…" aria-hidden={!working}><span /></div>
          <div className="status">{status}</div>
          {(() => {
            // the folder's reading, then its thumbnails
            const t = loader.current!.progress();
            if (immich?.busy) return <div className="activity"><span>Searching Immich…</span></div>;
            const w = waiting[waiting.length - 1];
            if (w && !reading) return (
              // the viewer's own pointer handling (zoom on click) stays off it
              <div className="activity waiting" onPointerDown={(e) => e.stopPropagation()}
                   onPointerUp={(e) => e.stopPropagation()}>
                <span>Waiting for {w.name}{w.total > 1 ? ` · ${w.back} of ${w.total} back` : ""}…</span>
                <button onClick={() => void invoke("plugin_cancel", { token: w.token })}>Stop waiting</button>
              </div>
            );
            const [what, done, total] = reading ? ["Reading photos", reading.done, reading.total]
              : t.done < t.total ? ["Loading thumbnails", t.done, t.total] : [null, 0, 0];
            if (!what) return null;
            return (
              <div className="activity">
                <span>{total ? `${what} ${done.toLocaleString()} of ${total.toLocaleString()}` : "Reading folder…"}</span>
                <div className="bar"><div style={{ width: `${total ? (100 * done) / total : 0}%` }} /></div>
              </div>
            );
          })()}
        </main>
        <div data-tour="filmstrip" ref={stripSlot}
             style={floating.strip || grid ? {
               bottom: toolbarSpace,
               // the grid makes way for a floating side panel shown over it, which
               // would hide its first or last column (the panels' edges are the
               // viewer's, styles.css: auto-hide), and covers the photo in the gap
               ...(grid && floating.left && revealed.left ? { left: layout.leftWidth, background: "var(--window)" } : {}),
               ...(grid && floating.right && revealed.right ? { right: layout.rightWidth, background: "var(--window)" } : {}),
             } : undefined}
             className={`strip-slot${layout.strip || grid ? "" : " closed"}${floating.strip ? " floating" : ""}`
                        + `${floating.strip && revealed.strip ? " revealed" : ""}${grid ? " grid" : ""}`}>
          <div>
            {(shown.length > 0 || pending.length > 0) && !grid && (
              <Splitter axis="y" value={layout.stripHeight} min={90} max={300} invert hidden={!layout.strip}
                        onChange={(v) => setLayout((l) => ({ ...l, stripHeight: v }))} />
            )}
            <Filmstrip images={shown} partners={partners} pending={pending}
                       empty={immich ? (immich.busy ? "searching Immich…" : "no photos in Immich match the search")
                              : reading ? "reading the folder…"
                              : images.length ? "no photos match the filters"
                              : folder ? `no photos in this folder${includeSub ? "" : " (Include subfolders shows its subfolders' photos)"}`
                              : "add a folder to start"} current={currentEntry?.imgid ?? null} loader={loader.current!} onMenu={showFileMenu}
                       height={layout.stripHeight} grid={grid} selection={selection} onPick={pickPhoto}
                       candidate={compare}
                       onDouble={(i) => { setCompare(null); void openEntry(i); setGrid(false); }}
                       more={immich?.next && !immich.busy ? () => void searchImmich(immich.search, true) : undefined}
                       onBackMenu={showResultsMenu}
                       onMeta={(i, fields) => rateSelection(i, fields)} />
          </div>
        </div>
        <Toolbar filter={filter} kinds={kindCounts} remote={!!immich} layout={layout} ref={toolbar} pin={pinButton("strip")}
                 viewTools={<>
                   <button className="tool" title={keys("undo (⌘Z)")} disabled={!current} onClick={() => stepHistory(true)}>
                     <UndoIcon /></button>
                   <button className="tool" title={keys("redo (⇧⌘Z)")} disabled={!current} onClick={() => stepHistory(false)}>
                     <UndoIcon redo /></button>
                   <span className="sep" />
                   <button className={`tool view${baMode !== "off" || before ? " on" : ""}`} disabled={!current || cropping}
                           title={`before / after: ${baMode === "off" ? "off" : BA_NAMES[baMode].toLowerCase()}, click for the next view (Y)   full before: \\`}
                           onClick={cycleBaMode}><BeforeAfterIcon /></button>
                   <button className={`tool view${compare !== null ? " on" : ""}`} disabled={!current || cropping}
                           title="compare with another photo (C): click one in the filmstrip, or step with ← →"
                           onClick={toggleCompare}><CompareIcon /></button>
                 </>}
                 grid={grid} onGrid={shown.length > 0 || pending.length > 0 || grid ? () => setGrid(!grid) : undefined}
                 zoomBar={<ZoomBar disabled={!current} register={(f) => { zoomShow.current = f; }}
                                   onZoom={(z) => setZoom(z)}
                                   onToggle={() => setZoom(zoomRef.current === "fit" ? 1 : "fit")}
                                   fit={() => fitScale()} />}
                 onFilter={setFilter}
                 onLayout={toggleSide} />
      </section>

      <Splitter axis="x" value={layout.rightWidth} min={280} max={620} invert hidden={!docked.right}
                onChange={(v) => setLayout((l) => ({ ...l, rightWidth: v }))} />
      <div className={`slot right-slot${layout.right ? "" : " closed"}${floating.right ? " floating" : ""}`
                      + `${floating.right && revealed.right ? " revealed" : ""}`}>
      <aside className="right" ref={rightAside} style={{ width: layout.rightWidth }}>
        <div className="panel-head"><h1>{cropping ? "Crop" : RIGHT_TITLES[rightMode]}</h1>
          <div className="head-tools">
            {pinButton("right")}
            {(rightMode === "adjust" || rightMode === "presets") && !cropping && (
              <button className="tool" onClick={toggleAllPanels}
                      title={anyOpen ? keys("collapse all panels (⌥-click a panel to open it alone)") : "expand all panels"}>
                <FoldIcon open={anyOpen} /></button>
            )}
            <ResetAll disabled={!current} onReset={resetAll} />
          </div></div>
        <HistogramView histogram={histogram} values={values} disabled={!current} exif={currentEntry?.exif ?? null}
                       neutral={(id) => session.current?.neutral[id] ?? controlById.get(id)?.neutral ?? 0}
                       onChange={change} clip={clipOn} onClip={(end) => setClipOn((o) => ({ ...o, [end]: !o[end] }))}
                       onClipPeek={setClipPeek} />
        <div className="panels" data-tour="panels">
          {masksMode && !cropping && (
            <MasksPanel masks={masks} selected={maskSel} shape={shapeSel} tool={maskTool} target={toolTarget}
                        brush={brush} overlay={maskShown} disabled={!current} mono={values.bw_mode === 1} photo={values}
                        renderSlider={(c, v, onChange, glow) => (
                          <Slider key={c.id} control={c} value={v} neutral={c.neutral ?? 0} disabled={!current}
                                  values={selMask?.values ?? values} onChange={onChange} glow={glow} />
                        )}
                        fresh={freshMask} onHslShown={setMaskHslShown}
                        onTool={(t, target) => {
                          if (t === "parametric") { addParametric(target); return; }
                          setMaskTool(t); setToolTarget(target);
                        }}
                        onAi={(kind, target) => void selectAi(kind, target)}
                        aiBusy={aiBusy} focusMode={focusMode}
                        onSelect={(name) => { setMaskSel(name); setShapeSel(0); }}
                        onShape={setShapeSel}
                        onShapeMode={(k) => editShapes((sh) => sh.map((x, i) => (i === k
                          ? { ...x, mode: x.mode === "subtract" ? "add" : "subtract" } : x)))}
                        onShapeDelete={(k) => {
                          const m = masks.find((x) => x.name === maskSel);
                          if (m && m.shapes.length === 1) { deleteMask(m.name); return; }
                          editShapes((sh) => sh.filter((_, i) => i !== k));
                          setShapeSel(0);
                        }}
                        onInvert={(inv) => { if (maskSel) { record(["mask:invert"]); session.current?.setInvert(maskSel, inv); syncMasks(); } }}
                        onOpacity={(v) => { if (maskSel) { adjusted(); overlayEvent("adjust"); record([`mask:${maskSel}:opacity`]); session.current?.setOpacity(maskSel, v); syncMasks(); } }}
                        onRefine={(patch: Partial<Refine>) => {
                          const m = masks.find((x) => x.name === maskSel);
                          if (!m) return;
                          refined();
                          record([`mask:${m.name}:refine:${Object.keys(patch).join()}`]);
                          session.current?.setRefine(m.name, { ...NO_REFINE, ...m.refine, ...patch });
                          syncMasks();
                        }}
                        onHidden={(name, hidden) => { record([`mask:${name}:hidden`]); session.current?.setHidden(name, hidden); syncMasks(); }}
                        onDuplicate={duplicateMask}
                        raw={session.current?.raw ?? true} image={full.current} thumbMaps={thumbMaps}
                        onDelete={deleteMask}
                        onPeek={setPeekName}
                        onRename={(from, to) => {
                          const s = session.current;
                          if (!s) return;
                          if (s.masks.some((q) => q.name === to)) { setStatus(`there is already a mask named "${to}"`); return; }
                          record(["mask:rename"]);
                          s.renameMask(from, to);
                          if (maskSel === from) setMaskSel(to);
                          syncMasks();
                        }}
                        onBrush={setBrush}
                        onOverlay={() => overlayEvent("key")}
                        onLocal={(id, v) => { if (maskSel) { adjusted(); overlayEvent("adjust"); record([`mask:${maskSel}:${id}`]); session.current?.setLocal(maskSel, id, v); syncMasks(); } }}
                        onRange={(k, patch) => { refined(); editShapes((sh) => sh.map((x, i) => (i === k ? { ...x, ...patch } as Shape : x))); }}
                        onDepth={(k, depth, feather) => { refined(); void editDepth(k, depth, feather); }}
                        onFeather={(k, patch) => { refined(); editShapes((sh) => sh.map((x, i) => (i === k ? { ...x, ...patch } as Shape : x))); }}
                        picked={picked} pickShow={pickShow} pickSet={maskTool === "picker" ? pickChan : null}
                        onParametric={(k, ch) => editParametric(k, ch)}
                        onPickShow={(on) => { setPickShow(on); if (!on) setPicked(null); }}
                        onPickTab={setPmTab}
                        onPickSet={(c) => {
                          if (c) { setPickChan(c); setMaskTool("picker"); setToolTarget("add"); }
                          else setMaskTool(null);
                        }} />
          )}
          {healMode && !cropping && (
            <HealPanel tool={spotTool} spots={spots} selected={spotSel} visualize={visualize} disabled={!current}
                       renderSlider={(c, v, onChange) => (
                         <Slider key={c.id} control={c} value={v} neutral={c.neutral ?? 0} disabled={!current}
                                 values={values} onChange={onChange} />
                       )}
                       onTool={setSpotTool}
                       onSpot={(patch) => {
                         const s = session.current;
                         if (!s || spotSel === null) return;
                         editSpots(s.spots.map((x, i) => (i === spotSel ? { ...x, ...patch } as Spot : x)), `spot:edit:${spotSel}`);
                       }}
                       onDelete={deleteSpot}
                       onClear={() => { editSpots([], "spot:clear"); setSpotSel(null); }}
                       onVisualize={setVisualize} />
          )}
          {rightMode === "zones" && !cropping && (
            <div className="panel">
              <div className="panel-title"><span>Zone System</span></div>
              {values.bw_mode === 1 ? (
                <ZoneSystem data={zoneData} unplaced={zoneUnplaced} stale={zoneStale} error={zoneError}
                            disabled={!current} pinned={zonePinned} onPin={setZonePinned} onHover={setZoneHover}
                            transition={zoneMaskOf(zonePinned)?.w ?? DEFAULT_TRANSITION} cover={zoneCover}
                            reach={placeReach}
                            overlay={zoneOverlay} onOverlay={setZoneOverlay}
                            onReset={zoneMasks.length || offsetsOf(values).some((o) => o !== 0) ? () => {
                              const s = session.current;
                              if (!s) return;
                              record(["zones:reset"], "Reset Zone System");
                              holdRecord.current = true;
                              try {
                                for (const m of zoneMasks) s.deleteMask(m.name);
                                changeMany(placeIds.map((id) => [id, 0]));
                              } finally {
                                holdRecord.current = false;
                              }
                              syncMasks();
                            } : undefined}>
                  <ZoneAdjust pinned={zonePinned} offsets={offsetsOf(values)} disabled={!current}
                              onReach={(t) => {
                                // a change of transition shows over the photo, overlay on or not
                                if (t !== null && placeReach !== null && t !== placeReach) refined();
                                setPlaceReach(t);
                              }}
                              onPlace={(next) => changeMany(placeIds.map((id, i) => [id, Math.round(next[i] * 1000) / 1000]))}
                              zoneMasks={zoneMasks} selected={zoneMaskOf(zonePinned)}
                              part={zonePart} parts={[...ZONE_PARTS, ...zoneObjects.map((k): [string, string] => [k, partLabel(k)!])]}
                              partBusy={aiBusy} onPart={pickZonePart} boxing={zoneBoxing} onBoxing={setZoneBoxing}
                              onLocal={(r, id, v) => zoneEdit(r, id, (s, n) => {
                                adjusted();
                                s.setLocal(n, id, v);
                                // contrast pivots on the zones' middle
                                if (id === "l_contrast") s.setLocal(n, "l_fulcrum", v !== 0 ? rangeCenter(r) - 5 : 0);
                              })}
                              onOpacity={(r, v) => zoneEdit(r, "opacity", (s, n) => { adjusted(); s.setOpacity(n, v); })}
                              onTransition={(r, w) => zoneEdit(r, "transition", (s, n) => {
                                refined();
                                const m = s.masks.find((x) => x.name === n)!;
                                s.setShapes(n, [zoneShape(r, w) as Shape, ...m.shapes.filter((x) => x.type !== "luminance")]);
                              })}
                              onEdge={(r, v) => zoneEdit(r, "edge", (s, n) => {
                                const m = s.masks.find((x) => x.name === n)!;
                                s.setRefine(n, { ...NO_REFINE, ...m.refine, feather: v * 2.5 });
                              })}
                              onPickMask={(r, part) => { setZonePinned(r); setZonePart(part); }}
                              onDeleteMask={deleteMask}
                              renderSlider={(c, v, onChange) => (
                                <Slider key={c.id} control={c} value={v} neutral={c.neutral ?? 0} disabled={!current}
                                        values={values} onChange={onChange} />
                              )} />
                </ZoneSystem>
              
              ) : (
                <section>
                  <p className="zone-hint">The Zone System works on black and white: it places the tones a
                    black and white photo is made of.</p>
                  <button className="btn small" disabled={!current}
                          onClick={() => change(controlById.get("bw_mode")!, 1)}>Convert to Black &amp; White</button>
                </section>
              )}
            </div>
          )}
          {rightMode === "presets" && !cropping && (
            <PresetsPanel fold={presetFold} onAnyOpen={setPresetGroupsOpen} focusMode={focusMode}
                          presets={[...BUILTIN_PRESETS, ...presets]} looks={looks} look={look} disabled={!current}
                          preview={(key) => previews.current!.get(key)}
                          onWant={(keys) => { wantedTiles.current = keys; requestTiles(); }}
                          onLook={applyLook}
                          onApply={applyPreset}
                          onHover={hoverTile}
                          lookAmount={lookAmount}
                          onLookAmount={(v) => { record(["look:amount"]); setLookAmount(v); session.current?.setLookAmount(v); }}
                          newPhotos={newPhotos}
                          onNewPhotos={(id) => { setNewPhotos(id); storeNewPhotosPreset(id); }}
                          amount={amount ? { name: amount.name, value: amount.value } : null}
                          onAmount={changeAmount}
                          onRename={(p, name) => storePresets(presets.map((q) => (q.id === p.id ? { ...q, name } : q)))}
                          onUpdate={(p) => {
                            const now = session.current?.values ?? values;
                            storePresets(presets.map((q) => (q.id === p.id ? { ...q,
                              values: Object.fromEntries(Object.keys(q.values).map((id) => [id, now[id] ?? q.values[id]])) } : q)));
                            setStatus(`updated "${p.name}"`);
                          }}
                          onCreate={() => setNewPreset("plain")}
                          onDelete={(p) => storePresets(presets.filter((q) => q.id !== p.id))}
                          onImport={() => void importShared()}
                          onExportPreset={(p) => void exportPreset(p)}
                          onExportLook={(l) => void exportLook(l)}
                          onDeleteLook={(l) => void deleteLook(l)} />
          )}
          {cropping && (
            <div className="panel crop-card">
              <div className="panel-title"><span>Crop</span></div>
              <section>
                <div className="row-label">Aspect</div>
                <div className="crop-aspect">
                  <select value={cropAspect} onChange={(e) => {
                    if (e.target.value !== "enter-custom") { chooseAspect(e.target.value, cropPortrait); return; }
                    // start from the aspect as it is, as typed for a custom
                    const a = findAspect(cropAspect, cropChoices);
                    const [s, l] = a.id.startsWith("custom:") ? a.label.split(" × ")
                      : Array.isArray(a.ratio) ? [`${a.ratio[1]}`, `${a.ratio[0]}`] : ["1", "1"];
                    setCropEntry(cropPortrait ? [s, l] : [l, s]);
                  }}>
                    {ASPECTS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                    {cropChoices.length > 0 && <option disabled>──────────</option>}
                    {cropChoices.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                    <option value="enter-custom">Enter Custom…</option>
                  </select>
                  <button className="btn" title="swap orientation (X)" disabled={cropAspect === "free"}
                          onClick={() => chooseAspect(cropAspect, !cropPortrait)}>
                    {cropPortrait ? "Portrait" : "Landscape"}
                  </button>
                </div>
                {cropEntry && (
                  <div className="crop-custom"
                       onKeyDown={(e) => {
                         if (e.key === "Enter") setCustomAspect();
                         else if (e.key === "Escape") setCropEntry(null);
                       }}>
                    <input type="number" min={0} step="any" aria-label="width" autoFocus value={cropEntry[0]}
                           onChange={(e) => setCropEntry([e.target.value, cropEntry[1]])} />
                    <span>×</span>
                    <input type="number" min={0} step="any" aria-label="height" value={cropEntry[1]}
                           onChange={(e) => setCropEntry([cropEntry[0], e.target.value])} />
                    <button className="btn" onClick={setCustomAspect}>Set</button>
                  </div>
                )}
                <div className="crop-angle">
                  <button className={`tool${straightening ? " on" : ""}`} disabled={!current}
                          title={keys("straighten: drag along a line that should be level or upright (or hold ⇧ and drag)")}
                          onClick={() => setStraightening(!straighteningRef.current)}><RulerIcon /></button>
                  <Slider control={controlById.get("tf_rotate")!} value={values.tf_rotate ?? 0} neutral={0}
                          disabled={!current} values={values}
                          onChange={(v) => change(controlById.get("tf_rotate")!, v)} />
                </div>
                <div className="row-label">Rotate &amp; Flip</div>
                <div className="crop-turn">
                  <button className="tool" title={keys("rotate left (⌘[)")} onClick={() => void turn("ccw")}><RotateIcon /></button>
                  <button className="tool" title={keys("rotate right (⌘])")} onClick={() => void turn("cw")}><RotateIcon right /></button>
                  <button className="tool" title="flip horizontal" onClick={() => void turn("h")}><FlipIcon /></button>
                  <button className="tool" title="flip vertical" onClick={() => void turn("v")}><FlipIcon vertical /></button>
                </div>
                <div className="crop-buttons">
                  <button className="btn" onClick={() => setCropRect(FULL)}>Reset</button>
                  <button className="btn" onClick={() => leaveCrop(false)}>Cancel</button>
                  <button className="btn primary" onClick={() => leaveCrop(true)}>Done</button>
                </div>
              </section>
            </div>
          )}
          {rightMode === "adjust" && !cropping && panels.filter((p) => !p.hidden && (!p.showIf || p.showIf(values))).map((p) => (
            <PanelView key={p.id} panel={p} open={openPanels.has(p.id)} onToggle={(solo) => togglePanel(p.id, solo)}
                       values={values} session={session.current} disabled={!current} onChange={change}
                       onChangeMany={changeMany} histogram={histogram} onPreview={hoverValues}
                       toneTools={p.id === "basic" ? (
                         <div className="tone-tools">
                           <button className="btn small" disabled={!current}
                                   title={values.tm_mode === 1
                                     ? "Exposure, AgX's range as darktable's auto tune levels sets it, then Contrast, Highlights, Shadows, Whites and Blacks from the photo"
                                     : "Exposure, then Contrast, Highlights, Shadows, Whites and Blacks from the photo"}
                                   onClick={() => void runAutoTone()}>Auto</button>
                         </div>
                       ) : undefined}
                       straightenTools={p.id === "transform" ? (
                         <div className="straighten-tools">
                           <button className={`btn small${straightening ? " on" : ""}`} disabled={!current}
                                   title={keys("drag along a line that should be level or upright (or hold ⇧ and drag)")}
                                   onClick={() => { setGuiding(false); setStraightening(!straighteningRef.current); }}>
                             <RulerIcon />Straighten
                           </button>
                           <span className="note-plain">{straightening ? "drag along a line that should be level or upright"
                                                                       : "or hold ⇧ and drag on the photo"}</span>
                         </div>
                       ) : undefined}
                       transformTools={p.id === "transform" ? (
                         <div className="upright-tools">
                           <div className="segmented choice upright">
                             {UPRIGHT_MODES.map((label, m) => (
                               <button key={label} disabled={!current || uprightBusy}
                                       className={(m === UPRIGHT_GUIDED ? guiding || values.tf_upright === m
                                                                       : values.tf_upright === m && !guiding) ? "active" : ""}
                                       title={`${label}: ${UPRIGHT_TITLES[m]}`} aria-label={label}
                                       onClick={() => void runUpright(m)}>
                                 {(() => { const Icon = UPRIGHT_ICONS[m]; return <Icon size={15} strokeWidth={1.8} />; })()}
                               </button>
                             ))}
                           </div>
                           {guiding && (
                             <div className="upright-guided">
                               <span className="note-plain">{`${values.tf_gn ?? 0} of ${MAX_GUIDES} guides`}</span>
                               <button className="btn small" onClick={() => setGuiding(false)}>Done</button>
                             </div>
                           )}
                           {uprightNote && <div className="note-plain">{uprightNote}</div>}
                         </div>
                       ) : undefined}
                       denoiseTools={p.id === "detail" ? (
                         session.current && !session.current.raw ? <div className="note-plain">raw photos only</div>
                         : immich ? <div className="note-plain">photos in a folder on this computer only</div>
                         : (
                           <div className="denoise-tools">
                             <button className="btn small" disabled={!current || aiBusy}
                                     onClick={() => setDenoising(true)}>Denoise…</button>
                             <span className="note-plain">writes a denoised DNG beside the raw, with this edit</span>
                           </div>
                         )
                       ) : undefined}
                       wbTools={p.id === "basic" ? (
                         <WBTools values={values} asShot={session.current
                                    ? { temp: session.current.neutral.temp, tint: session.current.neutral.tint } : null}
                                  picking={picking} disabled={!current || values.bw_mode === 1}
                                  onPick={() => setPicking(!pickingRef.current)}
                                  onAuto={() => void startWB(null)}
                                  onPreset={(wb) => changeMany([["temp", wb.temp], ["tint", wb.tint]])} />
                       ) : undefined}
                       onOptionPreview={setOptPreview}
                       onAuto={p.id === "bw" ? () => {
                         if (!session.current || autoPending.current) return;
                         autoPending.current = true;
                         baseStale.current = true;
                         session.current.bypass("colorequal", true);
                       } : undefined} />
          ))}
        </div>
        <div className="right-foot">
          <button className="btn small" disabled={!current || cropping} onClick={() => setCopying(true)}
                  title={keys("choose settings of this photo to copy (⇧⌘C)")}>Copy…</button>
          <button className="btn small" disabled={!current || cropping || !hasClip} onClick={pasteSettings}
                  title={keys("paste the copied settings onto this photo (⇧⌘V)")}>Paste</button>
          <button className="btn small" disabled={!current || cropping || !previous.current} onClick={pastePrevious}
                  title={keys("the previous photo's settings, the parts ticked in Copy Settings (⌥⌘V)")}>Previous</button>
        </div>
      </aside>
      </div>
      {/* the gap before the rail's column */}
      <div />
      <nav className="rail" ref={rail}>
        {/* in the order of the work: bring photos in, edit them, send them out */}
        <button className={`tool${importOpen ? " on" : ""}`} title={keys("import photos (⇧⌘I)")} data-tour="import"
                onClick={() => setImportOpen(true)}><ImportIcon /></button>
        <div className="rail-sep" />
        <div className="rail-group" data-tour="edit">
        <button className={`tool${layout.right && !cropping && rightMode === "adjust" ? " on" : ""}`} title="adjustments"
                data-tour="adjust" onClick={() => showRight("adjust")}>
          <SlidersIcon /></button>
        <button className={`tool${cropping ? " on" : ""}`} title="crop (R)" data-tour="crop" disabled={!currentEntry}
                onClick={() => (cropping ? leaveCrop(true) : enterCrop())}><CropIcon /></button>
        <button className={`tool${layout.right && !cropping && masksMode ? " on" : ""}`} title="masks" data-tour="masks"
                disabled={!currentEntry} onClick={() => showRight("masks")}><LayersIcon /></button>
        <button className={`tool${layout.right && !cropping && rightMode === "zones" ? " on" : ""}`} title="zone system"
                data-tour="zones" disabled={!currentEntry} onClick={() => showRight("zones")}><ZonesIcon /></button>
        <button className={`tool${layout.right && !cropping && healMode ? " on" : ""}`} title="heal and clone (Q)"
                data-tour="heal"
                disabled={!currentEntry} onClick={() => showRight("heal")}><HealIcon /></button>
        <button className={`tool${layout.right && !cropping && rightMode === "presets" ? " on" : ""}`} title="presets" data-tour="presets"
                onClick={() => showRight("presets")}><PresetsIcon /></button>
        </div>
        <div className="rail-sep" />
        <button className="tool" title={keys("export (⇧⌘E)")} data-tour="export" onClick={() => setExporting(true)}><ExportIcon /></button>
        <div className="rail-fill" />
        <button className="tool" title="quick start guide" onClick={() => setTouring(true)}><HelpIcon /></button>
        <button className="tool" title={keys("keyboard shortcuts (⌘/)")} onClick={() => setShortcutsOpen(true)}><KeyboardIcon /></button>
        <button className="tool" title={keys("preferences (⌘,)")} data-tour="prefs" onClick={() => setPrefsOpen(true)}><GearIcon /></button>
      </nav>
    </div>
    {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
    {fileMenu && (() => {
      const hit = images.find((i) => i.imgid === fileMenu.imgid);
      const local = fileMenu.targets.filter((i) => !isRemote(i));
      // a stacked JPEG or HEIF gets no virtual copy of its own; its raw does
      const behindRaw = new Set([...partners.values()].flat().map((p) => p.imgid));
      const sources = local.filter((i) => !behindRaw.has(i.imgid));
      const copies = local.filter((i) => i.copy);
      return (
        <FileMenu x={fileMenu.x} y={fileMenu.y}
                  copyable={sources.length} copies={copies.length === local.length ? copies.length : 0}
                  onCopy={() => void createCopies(sources)} onRemoveCopies={() => void removeCopies(copies)}
                  reveal={!hit ? null : hit.remote ? hit.remote.localPath ?? (isRemote(hit) ? null : hit.path) : hit.path}
                  rejected={hit && !isRemote(hit) ? local.filter((i) => i.rejected).length : null}
                  photo={immichBase && hit?.remote ? photoUrl(immichBase, hit.remote.assetId) : null}
                  results={immichBase && immich ? searchUrl(immichBase, immich.search) : null}
                  onDelete={() => void deleteRejected(local.filter((i) => i.rejected))}
                  editIn={hit && !isRemote(hit) ? plugins.map((cfg) => ({ cfg, why: unfit(cfg, sources) })) : null}
                  onEditIn={(cfg) => void editIn(cfg, sources)} onSetUpPlugins={() => setPrefsOpen("plugins")}
                  onClose={() => setFileMenu(null)} />
      );
    })()}
    {prefsOpen && (
      <PreferencesDialog presets={[...BUILTIN_PRESETS, ...presets]} newPhotos={newPhotos}
                         onNewPhotos={(id) => { setNewPhotos(id); storeNewPhotosPreset(id); }}
                         onSaveCurrent={current ? () => setNewPreset("newPhotos") : null}
                         focus={prefsOpen === true ? undefined : prefsOpen}
                         plugins={plugins} onPlugins={setPlugins}
                         canvas={canvasColor} onCanvas={(v) => { setCanvasColor(v); storeCanvas(v); }}
                         overlayColor={overlayColor} onOverlayColor={(v) => { setOverlayColor(v); storeOverlayColor(v); }}
                         focusMode={focusMode} onFocusMode={(on) => { setFocusMode(on); storeFocusMode(on); }}
                         accel={accel}
                         autoHide={autoHide} onAutoHide={(on) => { setAutoHide(on); storeAutoHide(on); }}
                         stackPairs={stackPairs} onStackPairs={(on) => { setStackPairs(on); storeStackPairs(on); }}
                         perfHud={perfHud} onPerfHud={(on) => { setPerfHud(on); perf.enable(on); }}
                         onBenchmark={current ? () => {
                           setPrefsOpen(false);
                           runGuiBenchmark().then((path) => setStatus(`benchmark saved: ${path}`))
                             .catch((e) => setStatus(`benchmark: ${e}`));
                         } : null}
                         onClose={() => setPrefsOpen(false)} />
    )}
    <UpdateBanner prepare={async () => {
      // the edit saved now, then the engine stopped, before the installer
      // replaces its files
      await session.current?.close();
      await invoke("engine_quit");
    }} />
    {newPreset && (
      <NewPresetDialog values={values} groups={[...new Set(presets.map((p) => p.group))].sort()}
                       forNewPhotos={newPreset === "newPhotos"}
                       onClose={() => setNewPreset(false)}
                       onSave={(p, forNew) => {
                         storePresets([...presets, p]);
                         if (forNew) { setNewPhotos(p.id); storeNewPhotosPreset(p.id); }
                         setNewPreset(false);
                       }} />
    )}
    {importOpen && (
      <ImportView onClose={() => setImportOpen(false)} onImportDone={importDone} onShowImported={showImported}
                  onOpenSettings={openImmichPrefs} />
    )}
    {touring && <Tour onClose={endTour} />}
    {dropping && <div className="drop-target"><span>drop a photo to edit it, or a folder to add it</span></div>}
    {copying && <CopyDialog onCopy={copySettings} onClose={() => setCopying(false)} />}
    {denoising && <DenoiseDialog thumb={navThumb} center={viewCenter()} prepare={denoiseModel}
                                 onRun={(a) => void runDenoise(a)} onClose={() => setDenoising(false)} />}
    {exporting && <ExportDialog current={currentEntry} shown={shown.filter((i) => !isRemote(i))} canUpscale={!!accel?.length}
                                selected={shown.filter((i) => selection.has(i.imgid) && !isRemote(i))}
                                onClose={() => setExporting(false)} onKeywordsChanged={reloadKeywords} />}
    </div>
  );
}

// the open photo: its file, and which version of it (a virtual copy's own
// imgid), null until the engine has opened a file named by its path alone
type Opened = { path: string; imgid: number | null };

// the folders added to the library panel, and the folder and image open
// last, with its version; remembered between launches
type Library = { folders: string[]; current: string | null; image: string | null; expanded: string[];
                 hidden: string[]; sampled?: boolean; version?: number };
function loadLibrary(): Library {
  try {
    return { folders: [], current: null, image: null, expanded: [], hidden: [],
             ...JSON.parse(localStorage.getItem("immage.library") ?? "{}") };
  } catch {
    return { folders: [], current: null, image: null, expanded: [], hidden: [] };
  }
}

function saveLibrary(change: Partial<Library>) {
  try { localStorage.setItem("immage.library", JSON.stringify({ ...loadLibrary(), ...change })); }
  catch { /* not kept */ }
}

// which panels show, and how big; remembered between launches. storage can
// be unavailable, so it is only ever a convenience
type PanelKey = "left" | "strip" | "right";
type Layout = { left: boolean; strip: boolean; right: boolean;
                leftWidth: number; rightWidth: number; stripHeight: number };
const DEFAULT_LAYOUT: Layout = { left: true, strip: true, right: true,
                                 leftWidth: 300, rightWidth: 360, stripHeight: 150 };
function loadLayout(): Layout {
  try {
    return { ...DEFAULT_LAYOUT, ...JSON.parse(localStorage.getItem("immage.layout") ?? "{}") };
  } catch {
    return DEFAULT_LAYOUT;
  }
}
function saveLayout(l: Layout) {
  try { localStorage.setItem("immage.layout", JSON.stringify(l)); } catch { /* not kept */ }
}

// a drag handle between panels. `invert` for a panel that grows as the
// handle moves left or up (the right panel, the filmstrip)
function Splitter({ axis, value, min, max, invert, hidden, onChange }: {
  axis: "x" | "y"; value: number; min: number; max: number; invert?: boolean; hidden?: boolean;
  onChange: (v: number) => void;
}) {
  const start = useRef<{ pos: number; value: number } | null>(null);
  return (
    <div className={`splitter ${axis}${hidden ? " off" : ""}`}
         onPointerDown={(e) => {
           (e.target as HTMLElement).setPointerCapture(e.pointerId);
           start.current = { pos: axis === "x" ? e.clientX : e.clientY, value };
         }}
         onPointerMove={(e) => {
           const s = start.current;
           if (!s) return;
           const d = (axis === "x" ? e.clientX : e.clientY) - s.pos;
           onChange(Math.round(Math.min(max, Math.max(min, s.value + (invert ? -d : d)))));
         }}
         onPointerUp={() => { start.current = null; }} />
  );
}

type RightMode = "adjust" | "presets" | "masks" | "heal" | "zones";
// the Library panel's foldable cards; each keeps its open state under
// immage.<id>.open
const LEFT_CARDS = ["metadata", "keywording", "folders", "immich", "history"] as const;
type LeftCard = typeof LEFT_CARDS[number];
const RIGHT_TITLES: Record<RightMode, string> = { adjust: "Adjustments", presets: "Presets", masks: "Masks", heal: "Heal",
                                                  zones: "Zone System" };

// everything back to the image's defaults, as one undo step
function ResetAll({ disabled, onReset }: { disabled: boolean; onReset: () => void }) {
  return (
    <button className="tool" disabled={disabled} onClick={onReset} aria-label="reset all"
            title={keys("reset all: take the image back to its defaults, sliders, crop, look and masks (⌘Z undoes it)")}>
      <ResetIcon />
    </button>
  );
}

// the zoom bar: Fit rests in the middle, zooming in to 400% to the right
// and out to a quarter of Fit to the left, evenly in ratio; near the middle
// it snaps to Fit, and a double-click goes between Fit and 100%
const ZOOM_MAX = 4;
const ZOOM_OUT = 4;
function ZoomBar({ disabled, register, onZoom, onToggle, fit }: {
  disabled: boolean;
  register: (show: (z: number, isFit: boolean) => void) => void;
  onZoom: (z: Zoom) => void; onToggle: () => void; fit: () => number;
}) {
  const range = useRef<HTMLInputElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const toPos = (z: number) => {
    const f = fit();
    if (z >= f) return f >= ZOOM_MAX ? 0 : (1000 * Math.log(z / f)) / Math.log(ZOOM_MAX / f);
    return Math.max(-1000, (1000 * Math.log(z / f)) / Math.log(ZOOM_OUT));
  };
  useEffect(() => register((z, isFit) => {
    if (range.current) range.current.value = String(isFit ? 0 : toPos(z));
    if (label.current) label.current.textContent = isFit ? "Fit" : `${Math.round(z * 100)}%`;
  }), []);
  return (
    <div className="tool-group zoom-bar" title="zoom: double-click for Fit or 100%" onDoubleClick={onToggle}>
      <input ref={range} type="range" min={-1000} max={1000} step={1} defaultValue={0} disabled={disabled}
             onChange={(e) => {
               const p = Number(e.target.value), f = fit();
               onZoom(Math.abs(p) < 25 ? "fit" : p > 0 ? f * (ZOOM_MAX / f) ** (p / 1000) : f * ZOOM_OUT ** (p / 1000));
             }} />
      <span ref={label} className="zoom-label">Fit</span>
    </div>
  );
}

// which images the filmstrip, the list and the arrows show
// `rejected` hides rejected photos or shows only them; `edited` picks those
// darktable counts as altered, or those it does not; `kinds` are file kinds
// as fileKind() names them, none meaning all
type Filter = { minRating: number; rejected: "all" | "hide" | "only"; edited: "all" | "edited" | "unedited";
                labels: number; unlabeled: boolean; kinds: string[] };
const NO_FILTER: Filter = { minRating: 0, rejected: "all", edited: "all", labels: 0, unlabeled: false, kinds: [] };
const passes = (i: ImageEntry, f: Filter) =>
  (f.rejected === "all" || (f.rejected === "only") === i.rejected)
  && (f.edited === "all" || (f.edited === "edited") === i.edited)
  && (!f.kinds.length || f.kinds.includes(fileKind(i.filename)))
  && (f.minRating === 0 || (!i.rejected && i.rating >= f.minRating))
  // label filters admit an image carrying any of the chosen labels
  && ((!f.labels && !f.unlabeled) || (i.labels & f.labels) !== 0 || (f.unlabeled && i.labels === 0));

// the bar under the filmstrip: rate and reject the open image, filter the
// folder, and show or hide the side panels and the filmstrip
function Toolbar({ filter: f, kinds, layout, zoomBar, viewTools, onFilter, onLayout, ref, pin, remote, grid, onGrid }: {
  ref: React.RefObject<HTMLDivElement | null>;
  viewTools: React.ReactNode;               // undo, redo, before/after, compare
  grid: boolean;
  onGrid?: () => void;                      // none while there are no photos to show
  pin: React.ReactNode;
  remote: boolean;                          // Immich results, which carry no reject flag or labels
  filter: Filter; layout: Layout; zoomBar: React.ReactNode;
  kinds: [string, number][];                // the folder's file kinds, and how many of each
  onFilter: (f: Filter) => void;
  onLayout: (k: "left" | "strip" | "right") => void;
}) {
  const filtering = f.minRating > 0 || f.rejected !== "all" || f.edited !== "all" || f.labels !== 0 || f.unlabeled
    || f.kinds.length > 0;
  // what the reject filter now shows, said for a moment above it
  // (fixed to the window: the toolbar scrolls, and would clip it)
  const [note, setNote] = useState<{ text: string; x: number; y: number } | null>(null);
  const noteTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(noteTimer.current), []);
  const say = (text: string, e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setNote({ text, x: r.left + r.width / 2, y: r.top });
    window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(null), 1600);
  };
  const clearFilters = (e: React.MouseEvent<HTMLButtonElement>) => {
    onFilter(NO_FILTER);
    say("Filters cleared", e);
  };
  const cycleRejected = (e: React.MouseEvent<HTMLButtonElement>) => {
    const next = f.rejected === "all" ? "hide" : f.rejected === "hide" ? "only" : "all";
    onFilter({ ...f, rejected: next });
    say(next === "all" ? "Showing all photos" : next === "hide" ? "Hiding rejected photos"
        : "Showing only rejected photos", e);
  };
  const cycleEdited = (e: React.MouseEvent<HTMLButtonElement>) => {
    const next = f.edited === "all" ? "edited" : f.edited === "edited" ? "unedited" : "all";
    onFilter({ ...f, edited: next });
    say(next === "all" ? "Showing all photos" : next === "edited" ? "Showing only edited photos"
        : "Showing only unedited photos", e);
  };
  return (
    <div className="toolbar" ref={ref}>
      <div className={`tool-group filter${filtering ? " active" : ""}`}>
        <button className={`tool${filtering ? " on" : ""}`} title={filtering ? "clear filters" : "no filters on"}
                onClick={clearFilters}><FilterIcon /></button>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} className="tool" title={`${n} star${n > 1 ? "s" : ""} and up`}
                  onClick={() => onFilter({ ...f, minRating: f.minRating === n ? 0 : n })}>
            <StarIcon filled={f.minRating >= n} />
          </button>
        ))}
        {!remote && <>
        <span className="sep" />
        {/* all, then without the rejected, then only them (to delete) */}
        <button className={`tool${f.rejected === "hide" ? " on" : f.rejected === "only" ? " on only-rejected" : ""}`}
                title={f.rejected === "all" ? "hide rejected photos"
                       : f.rejected === "hide" ? "rejected photos hidden: click to show only them"
                       : "only rejected photos: click to show all"}
                onClick={cycleRejected}>
          <BanIcon />
          {note && <span className="filter-note" key={note.text} style={{ left: note.x, top: note.y }}>{note.text}</span>}
        </button>
        {/* all, then the edited, then the ones still untouched */}
        <button className={`tool${f.edited === "edited" ? " on" : f.edited === "unedited" ? " on only-unedited" : ""}`}
                title={f.edited === "all" ? "show only edited photos"
                       : f.edited === "edited" ? "only edited photos: click to show only unedited ones"
                       : "only unedited photos: click to show all"}
                onClick={cycleEdited}>
          <SlidersIcon />
        </button>
        <span className="sep" />
        {LABEL_COLORS.map((c, k) => (
          <button key={c} className={`swatch${f.labels & (1 << k) ? " on" : ""}`} style={{ background: c }}
                  title="images with this label" onClick={() => onFilter({ ...f, labels: f.labels ^ (1 << k) })} />
        ))}
        <button className={`swatch${f.unlabeled ? " on" : ""}`} style={{ background: "#9ca3af" }}
                title="images without a label" onClick={() => onFilter({ ...f, unlabeled: !f.unlabeled })} />
        </>}
        <span className="sep" />
        <KindFilter kinds={kinds} chosen={f.kinds} onChange={(k) => onFilter({ ...f, kinds: k })} />
        {filtering && (
          <button className="tool clear-filters" title="show every photo again" onClick={clearFilters}>Clear</button>
        )}
      </div>

      {zoomBar}
      {/* down here rather than over the photo, where they covered the crop
          handles and whatever was being edited in that corner */}
      <div className="tool-group view-tools">
        {viewTools}
        <span className="sep" />
        {/* named, not an icon alone: new users missed the arrow it replaces, and G with it */}
        <button className={`tool grid-toggle${grid ? " on" : ""}`} disabled={!onGrid}
                title={grid ? "back to the filmstrip (G, Esc)" : "grid view (G)"} onClick={onGrid}>
          <GridIcon />Grid
        </button>
        <span className="sep" />
        <button className={`tool${layout.left ? " on" : ""}`} title="library panel"
                onClick={() => onLayout("left")}><PanelIcon side="left" /></button>
        <button className={`tool${layout.strip ? " on" : ""}`} title="filmstrip"
                onClick={() => onLayout("strip")}><PanelIcon side="bottom" /></button>
        <button className={`tool${layout.right ? " on" : ""}`} title="adjustments panel"
                onClick={() => onLayout("right")}><PanelIcon side="right" /></button>
        {/* the filmstrip's pin, after the panel switches rather than among them */}
        {pin}
      </div>
    </div>
  );
}

function GridIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
      <rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" />
    </svg>
  );
}

// the pair names (pairKey()) that have a raw among these files
const pairedRaws = (files: string[]) => new Set(files.filter((p) => isPrimaryRaw(p)).map(pairKey));

// the file type filter: a button naming what shows, opening the folder's
// kinds to tick, with how many of each
function KindFilter({ kinds, chosen, onChange }: {
  kinds: [string, number][]; chosen: string[]; onChange: (kinds: string[]) => void;
}) {
  // where the menu opens, above the button; fixed to the window, as the
  // toolbar scrolls and would clip it
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", esc, true);
    return () => { window.removeEventListener("pointerdown", away, true); window.removeEventListener("keydown", esc, true); };
  }, [open]);
  const label = !chosen.length ? "All types" : chosen.length > 2 ? `${chosen.length} types` : chosen.join(", ");
  return (
    <div className="kind-filter" ref={box}>
      <button className={`tool kind-button${chosen.length ? " on" : ""}`} title="show only these file types"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setOpen(open ? null : { x: r.left, y: r.top });
              }}>{label}</button>
      {open && (
        <div className="kind-menu" style={{ left: open.x, bottom: window.innerHeight - open.y + 6 }}>
          <button className={!chosen.length ? "on" : ""} onClick={() => onChange([])}>
            <span className="tick">{!chosen.length ? "✓" : ""}</span><span>All types</span></button>
          {kinds.map(([k, n]) => (
            <button key={k} className={chosen.includes(k) ? "on" : ""}
                    onClick={() => onChange(chosen.includes(k) ? chosen.filter((x) => x !== k) : [...chosen, k])}>
              <span className="tick">{chosen.includes(k) ? "✓" : ""}</span><span>{k}</span>
              <span className="count">{n.toLocaleString()}</span></button>
          ))}
          {!kinds.length && <div className="empty">no photos</div>}
        </div>
      )}
    </div>
  );
}

// the folder's images along the bottom, as Lightroom's filmstrip: a cell
// each with the file's name and type above its thumbnail, and its reject
// flag and stars below, shown on hover or once it has a rating
function Filmstrip({ images, partners, pending, empty, current, loader, height, grid, selection, candidate, onPick, onDouble,
                     onMenu, onMeta, more, onBackMenu }: {
  images: ImageEntry[]; current: number | null; loader: ThumbLoader; height: number;
  pending: string[];                      // files not yet read, shown as empty cells
  partners: Map<number, ImageEntry[]>;    // a stacked raw's JPEG or HEIF, by its imgid
  empty: string;                          // what an empty grid says
  grid: boolean;                          // spread over the editing area, in rows
  selection: Set<number>;
  candidate: number | null;               // the photo compared with the open one
  onPick: (i: ImageEntry, e: React.MouseEvent) => void;
  onDouble: (i: ImageEntry) => void;
  onMenu: (e: React.MouseEvent, imgid: number) => void;
  onMeta: (i: ImageEntry, fields: Partial<ImageEntry>) => void;
  more?: () => void;                      // there are more results: called as the end scrolls into view
  onBackMenu: (e: React.MouseEvent) => void; // right-click beside the photos
}) {
  const strip = useRef<HTMLDivElement>(null);
  // the cell after the last, which asks for the next page of results
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = strip.current, el = end.current;
    if (!root || !el || !more) return;
    const seen = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) more(); },
                                          { root, rootMargin: grid ? "600px 0px" : "0px 600px" });
    seen.observe(el);
    return () => seen.disconnect();
  }, [more, images, grid]);
  // keep the open image in view as the arrows step through the folder.
  // the strip alone scrolls: scrollIntoView would also scroll its
  // ancestors, and a hidden floating strip, parked below the center
  // column, then pushes the whole column up out of its overflow: hidden
  useEffect(() => {
    const root = strip.current;
    const cell = root?.querySelector(".thumb.active");
    if (!root || !cell) return;
    const r = root.getBoundingClientRect();
    const c = cell.getBoundingClientRect();
    if (c.left < r.left) root.scrollLeft -= r.left - c.left;
    else if (c.right > r.right) root.scrollLeft += c.right - r.right;
    if (c.top < r.top) root.scrollTop -= r.top - c.top;
    else if (c.bottom > r.bottom) root.scrollTop += c.bottom - r.bottom;
  }, [current, grid]);
  // thumbnails scrolled into view jump the loader's queue
  useEffect(() => {
    const root = strip.current;
    if (!root) return;
    const seen = new IntersectionObserver((entries) => {
      const ids = entries.filter((e) => e.isIntersecting)
        .map((e) => Number((e.target as HTMLElement).dataset.imgid));
      if (ids.length) loader.request(ids, true);
    }, { root, rootMargin: grid ? "300px 0px" : "0px 300px" });
    root.querySelectorAll<HTMLElement>(".thumb[data-imgid]").forEach((el) => seen.observe(el));
    return () => seen.disconnect();
  }, [images, loader, grid]);
  // a grid's cells are a fixed height, and share each row's width
  // (styles.css, .filmstrip.grid); the strip's follow its height
  const cell = grid ? { height: 200 } : { width: Math.round((height - 12) * 1.15) };
  // an empty grid still covers the photo, and says why it is empty
  if (!images.length && !pending.length) {
    return grid ? <div className="filmstrip grid empty" onContextMenu={onBackMenu}><div className="grid-empty">{empty}</div></div>
      : null;
  }
  return (
    <div className={`filmstrip${grid ? " grid" : ""}`} ref={strip} style={grid ? undefined : { height }}
         onContextMenu={onBackMenu}
         onWheel={(e) => { if (strip.current && !grid) strip.current.scrollLeft += e.deltaY + e.deltaX; }}>
      {images.map((i) => (
        <div key={i.imgid} className={`thumb${i.imgid === current ? " active" : ""}${i.rejected ? " rejected" : ""}`
                                      + `${i.rating || i.rejected ? " rated" : ""}`
                                      + `${selection.size > 1 && selection.has(i.imgid) ? " selected" : ""}`
                                      + `${i.imgid === candidate ? " candidate" : ""}`}
             style={cell}
             title={i.filename} data-imgid={i.imgid} onClick={(e) => onPick(i, e)}
             onDoubleClick={() => { if (grid || candidate !== null) onDouble(i); }}
             onContextMenu={(e) => { e.stopPropagation(); onMenu(e, i.imgid); }}>
          <div className="thumb-head">
            <span className="thumb-name">{i.filename.replace(/\.[^.]+$/, "")}</span>
            {/* altered, as darktable counts it, so its lighttable agrees */}
            {i.edited && <span className="thumb-edited" title="edited"><SlidersIcon /></span>}
            <span className="thumb-type">{[i, ...(partners.get(i.imgid) ?? [])]
              .map((f) => (f.filename.match(/\.([^.]+)$/)?.[1] ?? "").toUpperCase()).join("+")}
              {copyName(i)}</span>
          </div>
          <div className="thumb-image"><ThumbCanvas bitmap={loader.get(i.imgid)} dogEar={!!i.copy} /></div>
          {/* rated without opening the photo, as Lightroom's filmstrip does;
              an Immich result shows Immich's rating, set only once opened */}
          <div className={`thumb-foot${isRemote(i) ? " read-only" : ""}`} onClick={(e) => e.stopPropagation()}>
            {!isRemote(i) && <button className={`thumb-reject${i.rejected ? " on" : ""}`} title="reject (X)"
                    onClick={() => onMeta(i, { rejected: !i.rejected })}>✕</button>}
            <span className="thumb-stars">
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} className={!i.rejected && i.rating >= n ? "on" : ""}
                        title={isRemote(i) ? "Immich's rating: open the photo to change it" : `${n} star${n > 1 ? "s" : ""}`}
                        disabled={isRemote(i)}
                        onClick={() => onMeta(i, { rating: i.rating === n ? 0 : n, rejected: false })}>★</button>
              ))}
            </span>
            <span className="labels">
              {LABEL_COLORS.map((c, k) => (i.labels & (1 << k)
                ? <span key={k} className="dot" style={{ background: c }} /> : null))}
            </span>
          </div>
        </div>
      ))}
      {pending.map((p) => {
        const name = baseName(p);
        return (
          <div key={p} className="thumb ghost" style={cell} title={name}>
            <div className="thumb-head">
              <span className="thumb-name">{name.replace(/\.[^.]+$/, "")}</span>
              <span className="thumb-type">{(name.match(/\.([^.]+)$/)?.[1] ?? "").toUpperCase()}</span>
            </div>
            <div className="thumb-image"><ThumbCanvas bitmap={undefined} /></div>
            <div className="thumb-foot" />
          </div>
        );
      })}
      {more && <div ref={end} className="thumb ghost more" style={cell} />}
    </div>
  );
}

// `dogEar` turns the bottom left corner over, as Lightroom marks a virtual
// copy: drawn on the thumbnail, which the cell fits, so it sits on the
// photo's own corner whatever its shape
function ThumbCanvas({ bitmap, dogEar = false }: { bitmap: ImageBitmap | undefined; dogEar?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !bitmap) return;
    c.width = bitmap.width;
    c.height = bitmap.height;
    const g = c.getContext("2d")!;
    g.drawImage(bitmap, 0, 0);
    if (!dogEar) return;
    const d = Math.round(Math.max(c.width, c.height) * 0.09), h = c.height;
    // the corner cut away, showing the cell behind, and the flap folded over
    g.globalCompositeOperation = "destination-out";
    g.beginPath(); g.moveTo(0, h - d); g.lineTo(d, h); g.lineTo(0, h); g.closePath(); g.fill();
    g.globalCompositeOperation = "source-over";
    g.fillStyle = "#d9d9d9";
    g.beginPath(); g.moveTo(0, h - d); g.lineTo(d, h - d); g.lineTo(d, h); g.closePath(); g.fill();
  }, [bitmap, dogEar]);
  // a photo's outline until its thumbnail is built
  return bitmap ? <canvas ref={ref} /> : (
    <div className="placeholder">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
           strokeLinejoin="round"><rect x="3.5" y="5" width="17" height="14" rx="2" />
        <circle cx="9" cy="10" r="1.6" /><path d="m4 17 5-4.5 3.5 3 3-2.5 4.5 4" /></svg>
    </div>
  );
}

// a virtual copy's name after its file's, as Lightroom's "Copy 1"
// the info over the photo, as Lightroom's I cycles it: 0 the file (its
// folder, capture time and size), 1 the exposure and lens, 2 none
const INFO_MODE_KEY = "immage.infoMode";
function loadInfoMode(): number {
  try { const v = Number(localStorage.getItem(INFO_MODE_KEY)); return v >= 0 && v <= 2 ? v : 0; } catch { return 0; }
}
function InfoOverlay({ mode, name, dir, entry }: { mode: number; name: string; dir: string; entry: ImageEntry | null }) {
  const e = entry?.exif;
  const lines = mode === 0
    ? [dir, e?.datetime ? captureDate(e.datetime) : "",
       entry && entry.width > 0 && entry.height > 0 ? `${entry.width} × ${entry.height}` : ""]
    : [[shutter(e?.exposure ?? 0),
        e && known(e.aperture) && e.aperture > 0 ? `ƒ / ${e.aperture.toFixed(1)}` : "",
        e && known(e.iso) && e.iso > 0 ? `ISO ${Math.round(e.iso)}` : ""]
         .filter(Boolean).join(", ").replace(/^(.*sec), (ƒ)/, "$1 at $2"),
       [e && known(e.focal_length) && e.focal_length > 0 ? `${+e.focal_length.toFixed(0)} mm` : "",
        e?.lens ? `(${e.lens})` : ""].filter(Boolean).join(" ")];
  return (
    <div className="info-overlay">
      <div className="info-name">{name}</div>
      {lines.filter(Boolean).map((l, k) => <div key={k}>{l}</div>)}
    </div>
  );
}

const copyName = (i: ImageEntry | null | undefined) => (i?.copy ? ` · Copy ${i.version}` : "");

// what the system's file manager is called
const TRASH = navigator.userAgent.includes("Windows") ? "Recycle Bin" : "Trash";

// a photo's right-click menu: Edit In, Show in Finder, as Lightroom's, and
// Delete, for rejected photos only; for Immich results, the photo or the
// whole search in Immich's web app. any click elsewhere, a scroll or Escape
// closes it
function FileMenu({ x, y, copyable, copies, reveal, rejected, photo, results, editIn, onCopy, onRemoveCopies, onDelete,
                    onEditIn, onSetUpPlugins, onClose }: {
  x: number; y: number;
  copyable: number;                       // how many photos a virtual copy can be made of
  copies: number;                         // how many virtual copies it acts on, when it acts on nothing else
  reveal: string | null;                  // the file to show in the file manager
  rejected: number | null;                // how many of the photos it acts on are rejected; null, none can be
  photo: string | null;                   // the photo in Immich's web app
  results: string | null;                 // the search it came from, there
  editIn: { cfg: PluginConfig; why: string | null }[] | null;  // the plugins, and why one cannot take the photos
  onEditIn: (cfg: PluginConfig) => void; onSetUpPlugins: () => void;
  onCopy: () => void; onRemoveCopies: () => void; onDelete: () => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: Event) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("wheel", onClose, true);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("wheel", onClose, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  const go = (url: string) => { onClose(); void openUrl(url); };
  // kept inside the window
  const left = Math.min(x, window.innerWidth - 230), top = Math.min(y, window.innerHeight - 180);
  // the Edit In list opens to the left when there is no room on the right
  const flip = left + 230 + 230 > window.innerWidth;
  return (
    <div ref={ref} className={`context-menu${flip ? " flip" : ""}`} style={{ left, top }}>
      {editIn && <>
        <div className="has-sub">
          <button>Edit In</button>
          <div className="context-menu submenu">
            {editIn.map(({ cfg, why }) => (
              <button key={cfg.id} disabled={!!why} title={why ?? undefined}
                      onClick={() => { onClose(); onEditIn(cfg); }}>{cfg.name}</button>
            ))}
            {editIn.length > 0 && <div className="menu-sep" />}
            <button onClick={() => { onClose(); onSetUpPlugins(); }}>
              {editIn.length ? "Plugins…" : "Set Up Plugins…"}</button>
          </div>
        </div>
        <div className="menu-sep" />
      </>}
      {copyable > 0 && <>
        <button onClick={() => { onClose(); onCopy(); }}>
          {copyable > 1 ? `Create ${copyable} Virtual Copies` : "Create Virtual Copy"}</button>
        {copies > 0 && <button onClick={() => { onClose(); onRemoveCopies(); }}>
          {copies > 1 ? `Remove ${copies} Virtual Copies` : "Remove Virtual Copy"}</button>}
        {(reveal || photo || results || rejected !== null) && <div className="menu-sep" />}
      </>}
      {reveal && <button onClick={() => { onClose(); void revealItemInDir(reveal); }}>Show in {FILE_MANAGER}</button>}
      {photo && <button onClick={() => go(photo)}>Show in Immich</button>}
      {results && <button onClick={() => go(results)}>Show Results in Immich</button>}
      {rejected !== null && <>
        {(reveal || photo || results) && <div className="menu-sep" />}
        <button className="danger" disabled={!rejected} title={rejected ? undefined : "only rejected photos (X) can be deleted"}
                onClick={() => { onClose(); onDelete(); }}>
          {rejected > 1 ? `Delete ${rejected} Rejected Photos…` : "Delete Rejected Photo…"}</button>
      </>}
    </div>
  );
}

// outline icons in the style of the rest of the interface
const icon = (path: React.ReactNode) => (
  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
       strokeLinecap="round" strokeLinejoin="round">{path}</svg>
);
const FolderIcon = () => icon(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />);
const StarIcon = ({ filled }: { filled: boolean }) => (
  <svg className="icon" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor"
       strokeWidth="1.6" strokeLinejoin="round">
    <path d="m12 3 2.8 5.8 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 3 1.1-6.2L3 9.7l6.2-.9z" />
  </svg>
);
const RefreshIcon = () => icon(<><path d="M20 11a8 8 0 0 0-14.6-4.5L4 8" /><path d="M4 4v4h4" />
  <path d="M4 13a8 8 0 0 0 14.6 4.5L20 16" /><path d="M20 20v-4h-4" /></>);
const BanIcon = () => icon(<><circle cx="12" cy="12" r="8.5" /><path d="m6 6 12 12" /></>);
const SlidersIcon = () => icon(<><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
  <circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></>);
// a preset's values but the photo's modules: the tone mapper, which presets
// made when it was a slider may hold
const presetValues = (p: Preset): Values =>
  Object.fromEntries(Object.entries(p.values).filter(([id]) => !isModuleSetting(id)));

// the Zone System's gray scale, dark to light
const ZonesIcon = () => icon(<><rect x="3" y="8" width="18" height="8" rx="1.5" />
  <rect x="3" y="8" width="4.5" height="8" fill="currentColor" stroke="none" />
  <rect x="7.5" y="8" width="4.5" height="8" fill="currentColor" stroke="none" opacity="0.55" />
  <rect x="12" y="8" width="4.5" height="8" fill="currentColor" stroke="none" opacity="0.2" /></>);
// a sticking plaster, Lightroom's Remove tool
const HealIcon = () => icon(<><rect x="2.8" y="8.2" width="18.4" height="7.6" rx="3.8" transform="rotate(-45 12 12)" />
  <rect x="9.3" y="9.3" width="5.4" height="5.4" rx="0.8" transform="rotate(-45 12 12)" /></>);
// a card going into a tray
const ImportIcon = () => icon(<><path d="M12 3v11" /><path d="m7.5 9.5 4.5 4.5 4.5-4.5" />
  <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></>);
const GearIcon = () => icon(<><circle cx="12" cy="12" r="3" />
  <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>);
// a pushpin, filled while the panel is pinned open
const PinIcon = ({ on }: { on: boolean }) => icon(
  <><path d="M9 4h6l-1 6 3 3H7l3-3z" fill={on ? "currentColor" : "none"} /><path d="M12 13v7" /></>);
const HelpIcon = () => icon(<><circle cx="12" cy="12" r="9" /><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6" />
  <path d="M12 17h.01" /></>);
const KeyboardIcon = () => icon(<><rect x="2.5" y="6" width="19" height="12" rx="2" />
  <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" /></>);
const LayersIcon = () => icon(<><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 13 9 5 9-5" /></>);
const PresetsIcon = () => icon(<><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" />
  <rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></>);
const UndoIcon = ({ redo = false }: { redo?: boolean }) => icon(
  <g transform={redo ? "matrix(-1 0 0 1 24 0)" : undefined}>
    <path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></g>);
const BeforeAfterIcon = () => icon(<><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M12 4.5v15" />
                                      <path d="M12 4.5h6a2.5 2.5 0 0 1 2.5 2.5v10a2.5 2.5 0 0 1-2.5 2.5h-6z" fill="currentColor" /></>);
const CompareIcon = () => icon(<><rect x="2.5" y="6" width="8.5" height="12" rx="1.5" />
                                  <rect x="13" y="6" width="8.5" height="12" rx="1.5" /></>);
// two chevrons pointing in to collapse, out to expand
const FoldIcon = ({ open }: { open: boolean }) => icon(open
  ? <><path d="m7 4 5 5 5-5" /><path d="m7 20 5-5 5 5" /></>
  : <><path d="m7 9 5-5 5 5" /><path d="m7 15 5 5 5-5" /></>);
// a counter-clockwise arrow, the usual sign for back to the defaults
const ResetIcon = () => icon(<><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></>);
const PipetteIcon = () => icon(<><path d="m12 9-8.4 8.4a2 2 0 0 0-.6 1.4V21h2.2a2 2 0 0 0 1.4-.6L15 12" />
                                   <path d="m18 9 1.4-1.4a2.1 2.1 0 1 0-3-3L15 6" /><path d="m9 6 9 9" /></>);
// a ruler at a slant, as Lightroom's Straighten tool
const RulerIcon = () => icon(<g transform="rotate(-35 12 12)"><rect x="2" y="8.5" width="20" height="7" rx="1.2" />
  <path d="M6 8.5v3M10 8.5v2M14 8.5v3M18 8.5v2" /></g>);
// an arrow turning a quarter round, and a frame mirrored across its axis
const RotateIcon = ({ right = false }: { right?: boolean }) => icon(
  <g transform={right ? undefined : "matrix(-1 0 0 1 24 0)"}>
    <rect x="9" y="10" width="11" height="10" rx="1.5" /><path d="M4 13V9a4 4 0 0 1 4-4h5" /><path d="m10.5 2.5 2.5 2.5-2.5 2.5" /></g>);
const FlipIcon = ({ vertical = false }: { vertical?: boolean }) => icon(
  <g transform={vertical ? "rotate(90 12 12)" : undefined}>
    <path d="M12 3v18" strokeDasharray="2 2.5" /><path d="M9 6 3 18h6z" /><path d="M15 6l6 12h-6z" fill="currentColor" /></g>);
const CropIcon = () => icon(<><path d="M6 2v14a2 2 0 0 0 2 2h14" /><path d="M18 22V8a2 2 0 0 0-2-2H2" /></>);
const ExportIcon = () => icon(<><path d="M12 15V4" /><path d="m7.5 8.5 4.5-4.5 4.5 4.5" />
                                  <path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" /></>);
const FilterIcon = () => icon(<path d="M4 5h16l-6 7.5V19l-4 2v-8.5z" />);
const PanelIcon = ({ side }: { side: "left" | "bottom" | "right" }) => icon(<>
  <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
  {side === "left" && <path d="M9 4.5v15" />}
  {side === "right" && <path d="M15 4.5v15" />}
  {side === "bottom" && <path d="M3.5 14.5h17" />}
</>);

// the White Balance picker and Lightroom's presets
function WBTools({ values, asShot, picking, disabled, onPick, onAuto, onPreset }: {
  values: Record<string, number>; asShot: WB | null; picking: boolean; disabled: boolean;
  onPick: () => void; onAuto: () => void; onPreset: (wb: WB) => void;
}) {
  const near = (wb: WB) => Math.abs(wb.temp - values.temp) < 1 && Math.abs(wb.tint - values.tint) < 1;
  const current = asShot && near(asShot) ? "As Shot"
    : WB_PRESETS.find(([, wb]) => near(wb))?.[0] ?? "Custom";
  return (
    <div className="wb-tools">
      <button className={`tool${picking ? " on" : ""}`} disabled={disabled} onClick={onPick}
              title="pick a neutral spot in the image (W)"><PipetteIcon /></button>
      <span className="wb-label">WB</span>
      <select value={current} disabled={disabled}
              onChange={(e) => {
                const name = e.target.value;
                if (name === "Auto") onAuto();
                else if (name === "As Shot") { if (asShot) onPreset(asShot); }
                else { const p = WB_PRESETS.find(([n]) => n === name); if (p) onPreset(p[1]); }
              }}>
        <option>As Shot</option>
        <option>Auto</option>
        {WB_PRESETS.map(([n]) => <option key={n}>{n}</option>)}
        {current === "Custom" && <option>Custom</option>}
      </select>
    </div>
  );
}

// a picked spot's display color: a small square around it, averaged
function sampleSpot(px: Uint8ClampedArray, width: number, height: number,
                    ix: number, iy: number): [number, number, number] | null {
  const r = Math.max(2, Math.round(width * 0.004));
  const cx = Math.round(ix * (width - 1)), cy = Math.round(iy * (height - 1));
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = Math.max(0, cy - r); y <= Math.min(height - 1, cy + r); y++)
    for (let x = Math.max(0, cx - r); x <= Math.min(width - 1, cx + r); x++) {
      const i = 4 * (y * width + x);
      // a clipped channel no longer says what color the spot is
      if (px[i] >= 250 || px[i + 1] >= 250 || px[i + 2] >= 250) continue;
      sum[0] += px[i]; sum[1] += px[i + 1]; sum[2] += px[i + 2];
      n++;
    }
  return n ? [sum[0] / n / 255, sum[1] / n / 255, sum[2] / n / 255] : null;
}

// Lightroom's histogram regions, left to right, and how far a drag across
// the whole histogram moves each
const HIST_ZONES: { id: string; from: number; to: number; span: number }[] = [
  { id: "blacks", from: 0, to: 0.13, span: 200 },
  { id: "shadows", from: 0.13, to: 0.35, span: 200 },
  { id: "exposure", from: 0.35, to: 0.65, span: 4 },
  { id: "highlights", from: 0.65, to: 0.87, span: 200 },
  { id: "whites", from: 0.87, to: 1, span: 200 },
];

function loadScope(): ScopeSettings {
  try { return { ...DEFAULT_SCOPE, ...JSON.parse(localStorage.getItem("immage.scope") ?? "{}") }; }
  catch { return DEFAULT_SCOPE; }
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

const SCOPE_MODES: [ScopeMode, string][] = [
  ["histogram", "Histogram"], ["waveform", "Waveform"], ["parade", "RGB Parade"],
  ["vectorscope", "Vectorscope"], ["split", "Waveform + Vectorscope"],
];

// the histogram, or another of darktable's scopes chosen from the corner
// menu. on the histogram, dragging sideways in a region moves its Basic
// slider and a double-click resets it; on the RYB vectorscope, dragging
// turns the color harmony guides. the clipping triangles show their
// overlay on the photo: a click keeps it, hovering shows it for a while
function HistogramView({ histogram: h, values, disabled, exif, neutral, onChange, clip, onClip, onClipPeek }: {
  histogram: Histogram | null; values: Record<string, number>; disabled: boolean; exif: Exif | null;
  neutral: (id: string) => number; onChange: (c: Control, v: number) => void;
  clip: ClipShow; onClip: (end: "low" | "high") => void; onClipPeek: (end: "low" | "high" | null) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [scope, setScopeState] = useState<ScopeSettings>(loadScope);
  const setScope = (change: Partial<ScopeSettings>) => setScopeState((s) => {
    const next = { ...s, ...change };
    try { localStorage.setItem("immage.scope", JSON.stringify(next)); } catch { /* not kept */ }
    return next;
  });
  const [size, setSize] = useState(0);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ro = new ResizeObserver(() => setSize(c.clientWidth * 10000 + c.clientHeight));
    ro.observe(c);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { if (ref.current) drawScope(ref.current, h, scope); }, [h, scope, size]);
  const tones = scope.mode === "histogram";
  const turning = (scope.mode === "vectorscope" || scope.mode === "split")
    && scope.space === "ryb" && scope.harmony > 0;
  const [zone, setZone] = useState<number | null>(null);
  const drag = useRef<{ x: number; v0: number; width: number } | null>(null);
  const turn = useRef<{ a0: number; deg0: number } | null>(null);
  const [turnLabel, setTurnLabel] = useState(false);
  const zoneAt = (e: React.PointerEvent | React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const f = (e.clientX - r.left) / r.width;
    const k = HIST_ZONES.findIndex((z) => f < z.to);
    return k < 0 ? HIST_ZONES.length - 1 : k;
  };
  // the pointer's angle around the vectorscope's center, in degrees, the
  // way drawScope measures the guides
  const angleAt = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const cx = scope.mode === "split" ? r.left + r.width * 0.75 : r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    return (Math.atan2(-(e.clientX - cx), -(e.clientY - cy)) * 180) / Math.PI;
  };
  const z = zone === null || !tones ? null : HIST_ZONES[zone];
  const c = z ? controlById.get(z.id)! : null;
  const harmony = HARMONIES[scope.harmony];
  return (
    <div className={`histogram scope-${scope.mode}${disabled || !(tones || turning) ? "" : " live"}${turning ? " turning" : ""}`}>
      <div className="hist-area"
           onPointerDown={(e) => {
             if (disabled || !h) return;
             if (turning) {
               e.currentTarget.setPointerCapture(e.pointerId);
               turn.current = { a0: angleAt(e), deg0: scope.harmonyAngle };
               setTurnLabel(true);
               return;
             }
             if (!tones) return;
             const k = zoneAt(e);
             setZone(k);
             e.currentTarget.setPointerCapture(e.pointerId);
             drag.current = { x: e.clientX, v0: values[HIST_ZONES[k].id] ?? 0, width: ref.current!.clientWidth };
           }}
           onPointerMove={(e) => {
             if (disabled) return;
             const t = turn.current;
             if (t) {
               const deg = Math.round(t.deg0 + angleAt(e) - t.a0);
               setScope({ harmonyAngle: ((deg % 360) + 360) % 360 });
               return;
             }
             if (!tones) return;
             const d = drag.current;
             if (!d) { setZone(zoneAt(e)); return; }
             if (!z || !c) return;
             const v = d.v0 + ((e.clientX - d.x) / d.width) * z.span;
             const stepped = Math.round(v / c.step) * c.step;
             const next = Math.min(c.max, Math.max(c.min, stepped));
             if (next !== values[z.id]) onChange(c, next);
           }}
           onPointerUp={() => { drag.current = null; turn.current = null; setTurnLabel(false); }}
           onPointerLeave={() => { if (!drag.current) setZone(null); }}
           onDoubleClick={() => {
             if (disabled) return;
             if (turning) setScope({ harmonyAngle: 0 });
             else if (z && c) onChange(c, neutral(z.id));
           }}>
        <canvas ref={ref} />
        {z && c && !disabled && h && (
          <div className="hist-zone" style={{ left: `${z.from * 100}%`, width: `${(z.to - z.from) * 100}%` }} />
        )}
      </div>
      <ScopeMenu scope={scope} onChange={setScope} />
      {/* the shot's exposure, as Lightroom shows it under the histogram; the
          zone under the pointer, and its value, take its place, as do the
          harmony guides while they turn */}
      <div className="hist-info">
        {turnLabel && turning
          ? <span className="hist-label">{cap(harmony.name)} <b>{scope.harmonyAngle}°</b></span>
          : z && c && !disabled && h
            ? <span className="hist-label">{c.label} <b>{c.format(values[z.id] ?? 0)}</b></span>
            : exif && exposureLine(exif).map((t) => <span key={t}>{t}</span>)}
      </div>
      {tones && (["low", "high"] as const).map((end) => {
        // lit in the color of the channels clipping there, as Lightroom's
        const color = clipColor(h, end);
        const share = end === "low" ? h?.shadowsClipped : h?.highlightsClipped;
        const what = end === "low" ? "shadow" : "highlight";
        return (
          <button key={end} className={`clip clip-${end}${clip[end] ? " on" : ""}`} disabled={disabled}
                  style={color ? { "--clip": color } as React.CSSProperties : undefined}
                  title={`${h ? `${((share ?? 0) * 100).toFixed(2)}% of pixels clip to ${end === "low" ? "black" : "white"}; ` : ""}`
                         + `click to ${clip[end] ? "hide" : "show"} ${what} clipping on the photo (J for both)`}
                  onClick={() => onClip(end)}
                  onPointerEnter={() => onClipPeek(end)} onPointerLeave={() => onClipPeek(null)} />
        );
      })}
    </div>
  );
}

// the scope's corner button and its menu: which scope, then that scope's
// own settings, as darktable's buttons over its scopes offer them
function ScopeMenu({ scope: s, onChange }: {
  scope: ScopeSettings; onChange: (change: Partial<ScopeSettings>) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), box);
  const seg = <T,>(options: [T, string][], value: T, set: (v: T) => void) => (
    <div className="segmented small">
      {options.map(([v, label]) => (
        <button key={label} className={v === value ? "active" : ""} onClick={() => set(v)}>{label}</button>
      ))}
    </div>
  );
  const vector = s.mode === "vectorscope" || s.mode === "split";
  const wave = s.mode === "waveform" || s.mode === "parade" || s.mode === "split";
  return (
    <div className={`scope-menu${open ? " open" : ""}`} ref={box}>
      <button className="scope-button" title="choose the scope" onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 24 24" className="icon" fill="none" stroke="currentColor" strokeWidth="1.8"
             strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 20h16M6 16l3-6 3 3 3-7 3 10" /></svg>
      </button>
      {open && (
        <div className="tile-menu scope-list">
          <span className="tool-kind">Scope</span>
          {SCOPE_MODES.map(([m, label]) => (
            <button key={m} className={m === s.mode ? "on" : ""} onClick={() => onChange({ mode: m })}>{label}</button>
          ))}
          {s.mode === "histogram" && <>
            <span className="tool-kind">Scale</span>
            {seg([[false, "Linear"], [true, "Logarithmic"]], s.log, (log) => onChange({ log }))}
          </>}
          {(s.mode === "histogram" || s.mode === "waveform" || s.mode === "split") && <>
            <span className="tool-kind">Channels</span>
            <div className="segmented small channels">
              {(["R", "G", "B"] as const).map((label, k) => (
                <button key={label} className={`ch-${label.toLowerCase()}${s.channels[k] ? " active" : ""}`}
                        onClick={() => {
                          const channels = [...s.channels] as ScopeSettings["channels"];
                          channels[k] = !channels[k];
                          onChange({ channels });
                        }}>{label}</button>
              ))}
            </div>
          </>}
          {wave && <>
            <span className="tool-kind">Orientation</span>
            {seg([[false, "Horizontal"], [true, "Vertical"]], s.vertical, (vertical) => onChange({ vertical }))}
          </>}
          {vector && <>
            <span className="tool-kind">Color space</span>
            {seg<VecSpace>([["luv", "u*v*"], ["jzazbz", "AzBz"], ["ryb", "RYB"]], s.space, (space) => onChange({ space }))}
            <span className="tool-kind">Scale</span>
            {seg([[false, "Linear"], [true, "Logarithmic"]], s.vecLog, (vecLog) => onChange({ vecLog }))}
            {s.space === "ryb" && <>
              <span className="tool-kind">Color harmony</span>
              <select value={s.harmony} onChange={(e) => onChange({ harmony: Number(e.target.value) })}>
                {HARMONIES.map((m, k) => <option key={m.name} value={k}>{cap(m.name)}</option>)}
              </select>
              {s.harmony > 0 && <>
                {seg(HARMONY_WIDTHS.map(([name], k) => [k, cap(name)] as [number, string]), s.harmonyWidth,
                     (harmonyWidth) => onChange({ harmonyWidth }))}
                <span className="scope-hint">drag on the scope to turn the guides, double-click to reset</span>
              </>}
            </>}
          </>}
        </div>
      )}
    </div>
  );
}

// the whole image, the zoom levels, and a rectangle over the part the
// viewer shows; dragging the rectangle pans
function Navigator({ thumb, zoom, placement: p, disabled, onZoom, onPan }: {
  thumb: React.RefObject<HTMLCanvasElement | null>; zoom: Zoom; placement: Placement | null;
  disabled: boolean; onZoom: (z: Zoom) => void; onPan: (x: number, y: number, done: boolean) => void;
}) {
  const [live, setLive] = useState<{ x: number; y: number } | null>(null);
  const zoomed = zoom !== "fit" && p && p.scale > 0;
  // the visible window as fractions of the image
  const rect = zoomed ? {
    w: Math.min(1, p.width / (p.fullWidth * p.scale)),
    h: Math.min(1, p.height / (p.fullHeight * p.scale)),
    x: p.x / (p.fullWidth * p.scale),
    y: p.y / (p.fullHeight * p.scale),
  } : null;
  const at = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const shown = rect && live
    ? { ...rect, x: live.x - rect.w / 2, y: live.y - rect.h / 2 } : rect;
  return (
    <div className="navigator">
      <div className="nav-head">
        <span>Navigator</span>
        <span className="segmented small nav-zooms">
          {ZOOMS.map(([z, label]) => (
            <button key={label} className={z === zoom ? "active" : ""} disabled={disabled}
                    onClick={() => onZoom(z)}>{label}</button>
          ))}
        </span>
      </div>
      <div className="nav-image"
           onPointerDown={(e) => {
             if (!zoomed) return;
             (e.target as HTMLElement).setPointerCapture(e.pointerId);
             const a = at(e); setLive(a); onPan(a.x, a.y, false);
           }}
           onPointerMove={(e) => { if (live) { const a = at(e); setLive(a); onPan(a.x, a.y, false); } }}
           onPointerUp={(e) => { if (live) { const a = at(e); setLive(null); onPan(a.x, a.y, true); } }}>
        <canvas ref={thumb} />
        {shown && (
          <div className="nav-rect" style={{
            left: `${shown.x * 100}%`, top: `${shown.y * 100}%`,
            width: `${shown.w * 100}%`, height: `${shown.h * 100}%`,
          }} />
        )}
      </div>
    </div>
  );
}

// what each Upright button does, as its tooltip
const UPRIGHT_TITLES = [
  "no Upright correction: the Manual sliders alone",
  "a balanced correction: level, plumb, and the horizontal lines when the photo has enough of them",
  "draw two to four guides along lines that should be plumb or level",
  "level the photo: rotation only",
  "level the photo and make its vertical lines plumb",
  "level, plumb and square: the vertical and horizontal lines both",
];

// Upright's buttons as icons, in UPRIGHT_MODES' order: Level and Vertical
// by the axis they straighten, Full by both
const UPRIGHT_ICONS = [CircleOff, WandSparkles, PenLine, MoveHorizontal, MoveVertical, Grid2x2];

function PanelView({ panel: p, open, onToggle, values, session, disabled, onChange, onChangeMany, histogram,
                     onAuto, wbTools, toneTools, denoiseTools, straightenTools, transformTools, onPreview, onOptionPreview }: {
  panel: Panel; open: boolean; onToggle: (solo: boolean) => void; values: Record<string, number>;
  session: Session | null; disabled: boolean; onChange: (c: Control, v: number) => void;
  onChangeMany: (entries: [string, number][]) => void; histogram: Histogram | null;
  onAuto?: () => void;
  wbTools?: React.ReactNode;   // the picker and presets, above Temp
  toneTools?: React.ReactNode;   // Auto, above Exposure
  denoiseTools?: React.ReactNode;   // AI Denoise's button, its section's only content
  straightenTools?: React.ReactNode;  // the Straighten tool, its section's only content
  transformTools?: React.ReactNode;   // Upright's buttons, its section's only content
  onPreview: (values: Values | null) => void;   // a swatch under the pointer
  onOptionPreview?: (preview: OptionPreview | null) => void;   // a slider ⌥-dragged
}) {
  const pointMode = p.graph === "tonecurve" && values.tc_mode === 1;
  // which curve the point editor shows: the master, or one channel
  const [curveChannel, setCurveChannel] = useState<CurveChannel>("rgb");
  const probe = useProbe(open && (p.id === "tonecurve" || p.id === "hsl" || p.id === "bw"));
  const curveMark = p.graph === "tonecurve" && probe ? markOnCurve(probe, values, pointMode, curveChannel) : null;
  // the color bands the photo under the pointer falls in; in black and
  // white, by the color it had before the treatment
  const bandSrc = probe && (p.id === "bw" ? probe.orig : p.id === "hsl" ? probe.rgb : null);
  const weights = bandSrc ? bandWeights(bandSrc) : null;
  const glowOf = (id: string) => {
    const m = weights && /^(?:bw|hsl_(?:hue|sat|lum))_(.+)$/.exec(id);
    const k = m ? BANDS.findIndex(([b]) => b === m[1]) : -1;
    return k < 0 ? 0 : weights![k];
  };
  // to points: the parametric curve sampled where Lightroom puts its own
  const toPoints = () => {
    // points made before stay; only an empty point curve starts from the
    // parametric curve's shape
    if (!isIdentity(pointsOf(values))) { onChange(controlById.get("tc_mode")!, 1); return; }
    const pc = paramCurve(parametricOf(values));
    const flat = pc.every(([x, y]) => Math.abs(x - y) < 1e-4);
    const pts: [number, number][] = flat ? [[0, 0], [1, 1]]
      : [0, 4, 8, 12, 16].map((k) => pc[k]);
    onChangeMany([["tc_mode", 1], ...Object.entries(pointValues(pts))]);
  };
  const [closed, setClosed] = useState(loadClosedSections);
  const toggleSection = (title: string) => setClosed(toggleClosedSection(`${p.id}/${title}`));
  const [tab, setTab] = useState(0);
  const [wheels, setWheels] = useState<WheelMode>("3way");
  const sections = p.tabs ? [p.sections[tab]] : p.sections;
  const showWheels = p.graph === "colorwheels" && wheels !== "sliders";
  const controlProps = (c: Control) => ({
    control: c, value: values[c.id] ?? c.neutral ?? 0,
    neutral: session?.neutral[c.id] ?? c.neutral ?? 0,
    disabled: disabled || !mapOf.has(c.id) || (!!c.rawOnly && !session?.raw), onChange: (v: number) => onChange(c, v),
    values, glow: glowOf(c.id),
    rawOnly: !!c.rawOnly && !!session && !session.raw,
    onOption: c.optionPreview && onOptionPreview
      ? (on: boolean) => onOptionPreview(!on ? null : c.optionPreview === "gray" ? { kind: "gray" }
                                         : { kind: "mask", op: (mapsWith(c.id).find((m) => choiceOn(m, values)) ?? mapOf.get(c.id)!).op })
      : undefined,
  });
  const foreign = p.graph === "tonecurve" && [...(session?.foreign ?? [])].some((m) => m.op === "tonecurve");
  return (
    <div className="panel adjust">
      <div className={`panel-title${open ? " open" : ""}`} onClick={(e) => onToggle(e.altKey)}>
        <span>{p.title}</span>
        {curveMark && (
          <span className="probe-chip" title="the photo under the pointer: its color, and where it sits on the curve (0-255)">
            {`R ${Math.round(probe!.rgb[0])} G ${Math.round(probe!.rgb[1])} B ${Math.round(probe!.rgb[2])}`}
            <b>{`${Math.round(curveMark.x * 255)} → ${Math.round(curveMark.y * 255)}`}</b>
          </span>
        )}
        {probe && (p.id === "hsl" || p.id === "bw") && (
          <span className="probe-chip" title={p.id === "bw" ? "the color under the pointer before black and white, and its band"
                                                             : "the color under the pointer, and its band"}>
            {bandSrc && <i style={{ background: `rgb(${bandSrc.map(Math.round).join(",")})` }} />}
            {!bandSrc ? "…" : weights ? BANDS[weights.indexOf(Math.max(...weights))][1] : "neutral"}
          </span>
        )}
        <Chevron open={open} />
      </div>
      <Collapse open={open}>
        <div className="panel-body">
          {p.graph === "tonecurve" && (
            <div className="segmented tabs">
              <button className={pointMode ? "active" : ""} onClick={() => !pointMode && toPoints()}>Point</button>
              <button className={!pointMode ? "active" : ""} onClick={() => pointMode && onChange(controlById.get("tc_mode")!, 0)}>
                Parametric
              </button>
            </div>
          )}
          {p.graph === "tonecurve" && !pointMode && <CurveGraph values={values} histogram={histogram} mark={curveMark} />}
          {pointMode && (
            <div className="segmented small channels">
              {(["rgb", "r", "g", "b"] as const).map((c) => (
                <button key={c} className={`${c === curveChannel ? "active" : ""} ch-${c}`}
                        onClick={() => setCurveChannel(c)}>{c.toUpperCase()}</button>
              ))}
            </div>
          )}
          {pointMode && (
            <PointCurve key={curveChannel} points={pointsOf(values, curveChannel)} disabled={disabled}
                        histogram={histogram} mark={curveMark}
                        channel={curveChannel === "rgb" ? null : ({ r: 0, g: 1, b: 2 } as const)[curveChannel]}
                        draw={curveChannel === "rgb" ? undefined : channelCurve}
                        onChange={(pts) => onChangeMany(Object.entries(pointValues(pts, curveChannel)))} />
          )}
          {foreign && <div className="note">custom curve from darktable; moving a slider replaces it</div>}
          {p.graph === "colorwheels" && (
            <GradingWheels prefix="cg" mode={wheels} onMode={setWheels} values={values} disabled={disabled}
                           onChange={(es) => es.forEach(([id, v]) => onChange(controlById.get(id)!, v))}
                           lum={(id) => <Slider {...controlProps(controlById.get(id)!)} />} />
          )}
          {p.tabs && (
            <div className="segmented tabs">
              {p.sections.map((s, i) => (
                <button key={s.title} className={i === tab ? "active" : ""} onClick={() => setTab(i)}>
                  {s.title}
                </button>
              ))}
            </div>
          )}
          {p.presets && (
            <PresetRow presets={p.presets} disabled={disabled} onApply={onChangeMany} onPreview={onPreview}
                       before={onAuto && <button className="btn small" disabled={disabled} onClick={onAuto}>Auto</button>} />
          )}
          {!showWheels && !pointMode && sectionRuns(sections).map((run) => {
            const content = (s: Section) => (
              <>
                {s.presets && <PresetRow presets={s.presets} disabled={disabled} onApply={onChangeMany}
                                           onPreview={onPreview} />}
                {s.title === "White Balance" && wbTools}
                {s.title === "Tone" && toneTools}
                {s.title === "AI Denoise" && denoiseTools}
                {s.title === "Straighten" && straightenTools}
                {s.title === "Upright" && transformTools}
                {s.controls.filter((c) => choiceShows(c.id, values)).map((c) => {
                  const props = controlProps(c);
                  return c.kind === "toggle" ? <Toggle key={c.id} {...props} />
                    : c.kind === "choice" ? <Choice key={c.id} {...props} />
                    : <Slider key={c.id} {...props} />;
                })}
              </>
            );
            const s = run[0];
            // a tab is its own heading, and a control beside its label
            // (Treatment) needs none
            if (p.tabs || (s.controls.length && s.controls.every((c) => c.inline))) return <section key={s.title}>{content(s)}</section>;
            // sections sharing a group: one heading, a box for each
            const title = s.group ?? s.title;
            const body = s.group
              ? run.map((g) => (
                  <div className="subcard" key={g.title}>
                    <div className="subcard-head">
                      {g.subtitle ?? g.title}
                      {g.tag && <span className="tag"><Sparkles size={11} strokeWidth={2} />{g.tag}</span>}
                    </div>
                    {content(g)}
                  </div>
                ))
              : content(s);
            const shut = closed.has(`${p.id}/${title}`);
            return (
              <section key={title}>
                <h3 className="fold" onClick={() => toggleSection(title)}>
                  {title}
                  {!s.group && s.tag && <span className="tag"><Sparkles size={11} strokeWidth={2} />{s.tag}</span>}
                  <Chevron open={!shut} />
                </h3>
                <Collapse open={!shut}><div className="section-body">{body}</div></Collapse>
              </section>
            );
          })}
        </div>
      </Collapse>
    </div>
  );
}

// buttons that set several controls at once; one with a swatch shows as a
// colored circle, its label as a tooltip
// a preset under the pointer is previewed over the image; a click applies it
function PresetRow({ presets, disabled, onApply, onPreview, before }: {
  presets: ControlPreset[];
  disabled: boolean;
  onApply: (entries: [string, number][]) => void;
  onPreview: (values: Values | null) => void;
  before?: React.ReactNode;
}) {
  return (
    <div className="presets" onPointerLeave={() => onPreview(null)}>
      {before}
      {presets.map((pr) => {
        const props = {
          disabled,
          onPointerEnter: () => !disabled && onPreview(pr.values),
          onClick: () => { onPreview(null); onApply(Object.entries(pr.values)); },
        };
        return pr.swatch
          ? <button key={pr.label} className="swatch" title={pr.label} aria-label={pr.label}
                    style={{ background: pr.swatch }} {...props} />
          : <button key={pr.label} className="btn small" {...props}>{pr.label}</button>;
      })}
    </div>
  );
}

// what ⌥-dragging a slider shows over the photo
export type OptionPreview = { kind: "mask"; op: string } | { kind: "gray" };

type ControlProps = {
  control: Control; value: number; neutral: number; disabled: boolean; onChange: (v: number) => void;
  values: Record<string, number>;
  rawOnly?: boolean;   // disabled for needing a raw
  onOption?: (on: boolean) => void;   // ⌥ held while dragging, or let go
  glow?: number;   // how much the photo under the pointer belongs to this control's color band, 0-1
};

// consecutive sections of one group, together; any other section alone
function sectionRuns(sections: Section[]): Section[][] {
  const runs: Section[][] = [];
  for (const s of sections) {
    const last = runs[runs.length - 1];
    if (s.group && last?.[0].group === s.group) last.push(s);
    else runs.push([s]);
  }
  return runs;
}

// the sections folded shut, "<panel id>/<section title>", kept between sessions
const CLOSED_SECTIONS_KEY = "immage.sections.closed";
function loadClosedSections(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(CLOSED_SECTIONS_KEY) ?? "[]")); } catch { return new Set(); }
}
// read again before writing: every card keeps its own copy
function toggleClosedSection(key: string): Set<string> {
  const closed = loadClosedSections();
  if (!closed.delete(key)) closed.add(key);
  try { localStorage.setItem(CLOSED_SECTIONS_KEY, JSON.stringify([...closed])); } catch { /* not kept */ }
  return closed;
}

// a frame with no color in it: a black and white look's tile. a toned
// look (sepia, say) has some, and counts as color
function isMono(f: Frame): boolean {
  const px = f.pixels;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4)
    sum += Math.max(Math.abs(px[i] - px[i + 1]), Math.abs(px[i + 1] - px[i + 2]), Math.abs(px[i] - px[i + 2]));
  return sum / (px.length / 4) < 2;
}

// about one mouse notch of a wheel event's deltaY on macOS
const WHEEL_NOTCH = 40;

function Slider({ control: c, value, neutral, disabled, onChange, values, glow = 0, rawOnly, onOption }: ControlProps) {
  const s = c.slider;
  const track = typeof c.track === "function" ? c.track(values) : c.track;
  const reset = () => !disabled && onChange(neutral);
  const m = mapOf.get(c.id);
  const [editing, setEditing] = useState(false);
  const cancel = useRef(false);
  // the wheel over a slider moves it, a notch by Preferences' scroll amount
  // of its range; trackpads send small steps, which add up first. a notch
  // is about 40 on macOS but 100 on Windows, so one event is capped at a
  // notch. React's own wheel handler is passive and could not keep the
  // panel from scrolling
  const box = useRef<HTMLDivElement>(null);
  const live = useRef({ value, onChange, disabled });
  live.current = { value, onChange, disabled };
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let acc = 0;
    const onWheel = (e: WheelEvent) => {
      const { value: v, onChange: change, disabled: off } = live.current;
      // left to scroll the panel unless Preferences lets the wheel move sliders
      if (off || !loadSliderScroll()) return;
      e.preventDefault();
      acc += Math.max(-WHEEL_NOTCH, Math.min(WHEEL_NOTCH, e.deltaY));
      const notches = Math.trunc(acc / WHEEL_NOTCH);
      if (!notches) return;
      acc -= notches * WHEEL_NOTCH;
      const lo = s ? s.min : c.min, hi = s ? s.max : c.max, step = s ? s.step : c.step;
      const by = Math.max(step, (hi - lo) * loadSliderScrollStep());
      const pos = Math.min(hi, Math.max(lo, (s ? s.toPos(v) : v) - notches * by));
      const snapped = Math.round(pos / step) * step;
      change(s ? s.fromPos(snapped) : snapped);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [c, s]);
  // ⌥ (Alt) held during a drag shows what the slider affects, as in
  // Lightroom; pressing or letting go of it mid-drag counts too
  const optionRef = useRef(onOption);
  optionRef.current = onOption;
  // ⇧ held during a drag moves the slider a tenth as far, from where it
  // was when ⇧ went down; a click on the track with it does not jump.
  // once ⇧ has been used the rest of the drag stays relative, at full
  // speed after it is let go, so the slider does not leap to the pointer.
  // `at` is the track position of the first move after each change
  const fine = useRef<{ from: number; at: number | null; scale: number } | null>(null);
  const startFine = (e: React.PointerEvent) => {
    const anchor = (shift: boolean) => {
      const v = live.current.value;
      fine.current = { from: s ? s.toPos(v) : v, at: null, scale: shift ? 0.1 : 1 };
    };
    fine.current = null;
    if (e.shiftKey) anchor(true);
    const onKey = (k: KeyboardEvent) => {
      if (k.key === "Shift" && !k.repeat) anchor(k.type === "keydown");
    };
    const end = () => {
      fine.current = null;
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  const startDrag = (e: React.PointerEvent) => {
    startFine(e);
    if (!optionRef.current) return;
    let shown = false;
    const show = (on: boolean) => {
      if (on !== shown) { shown = on; optionRef.current?.(on); }
    };
    const onKey = (k: KeyboardEvent) => { if (k.key === "Alt") show(k.type === "keydown"); };
    const end = () => {
      show(false);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    show(e.altKey);
  };
  // a plain track shares its label's row; a colored one keeps the full
  // width under it, as does a label too long for the row
  const compact = !track && c.label.length <= 11;
  return (
    <div ref={box} className={`slider${compact ? " compact" : ""}${disabled ? " disabled" : ""}`
                              + `${glow > 0.1 ? " probed" : ""}${value === neutral ? " at-neutral" : ""}`}
         style={glow > 0.1 ? { ["--glow" as string]: glow } : undefined}
         title={rawOnly ? "needs a raw photo: darktable makes the detail mask from the raw"
                : c.note ? keys(c.note) : m ? `darktable: ${moduleName(m.op)}` : ""}>
      {/* double-click resets, as in Lightroom */}
      <label onDoubleClick={reset}>{c.label}</label>
      {editing ? (
        <input className="value-edit" autoFocus defaultValue={String(+value.toFixed(4))}
               onFocus={(e) => e.target.select()}
               onKeyDown={(e) => {
                 e.stopPropagation();
                 if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                 if (e.key === "Escape") { cancel.current = true; (e.target as HTMLInputElement).blur(); }
               }}
               onBlur={(e) => {
                 const typed = parseFloat(e.target.value.replace(/[^0-9.+-]/g, ""));
                 if (!cancel.current && Number.isFinite(typed)) {
                   const v = Math.min(c.max, Math.max(c.min, Math.round(typed / c.step) * c.step));
                   onChange(v);
                 }
                 cancel.current = false;
                 setEditing(false);
               }} />
      ) : (
        // double-click the number to type one
        <span className="value" title="double-click to type a value"
              onDoubleClick={() => { if (!disabled) setEditing(true); }}>{c.format(value)}</span>
      )}
      <input type="range" disabled={disabled} onDoubleClick={reset} onPointerDown={startDrag}
             style={track ? { ["--track" as string]: track } : undefined}
             className={track ? "custom-track" : ""}
             min={s ? s.min : c.min} max={s ? s.max : c.max} step={s ? s.step : c.step}
             value={s ? s.toPos(value) : value}
             onChange={(e) => {
               let n = Number(e.target.value);
               const f = fine.current;
               if (f) {
                 if (f.at === null) f.at = n;
                 const lo = s ? s.min : c.min, hi = s ? s.max : c.max, step = s ? s.step : c.step;
                 n = Math.min(hi, Math.max(lo, Math.round((f.from + (n - f.at) * f.scale) / step) * step));
               }
               onChange(s ? s.fromPos(n) : n);
             }} />
    </div>
  );
}

// a few named values as a segmented control (Color | Black & White)
function Choice({ control: c, value, disabled, onChange }: ControlProps) {
  if (c.menu) return (
    <div className="choice-row">
      <span>{c.label}</span>
      <select className="field" value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))}>
        {c.optionGroups
          ? c.optionGroups.map(([group, opts]) => (
            <optgroup key={group} label={group}>
              {opts.map(([label, v]) => <option key={v} value={v}>{label}</option>)}
            </optgroup>))
          : (c.options ?? []).map(([label, v]) => <option key={v} value={v}>{label}</option>)}
      </select>
    </div>
  );
  const options = (
    <div className={`${c.inline ? "pills" : "segmented"} choice${disabled ? " disabled" : ""}`}>
      {(c.options ?? []).map(([label, v]) => {
        const Icon = c.optionIcons?.[v];
        return (
          <button key={label} className={value === v ? "active" : ""} disabled={disabled}
                  title={c.optionLabels?.[v] ? label : undefined} onClick={() => onChange(v)}>
            {Icon && <Icon size={15} strokeWidth={1.8} />}{c.optionLabels?.[v] ?? label}
          </button>
        );
      })}
    </div>
  );
  return c.inline ? <div className="choice-row"><span>{c.label}</span>{options}</div> : options;
}

function Toggle({ control: c, value, disabled, onChange }: ControlProps) {
  const m = mapOf.get(c.id);
  return (
    <label className={`toggle${disabled ? " disabled" : ""}`}
           title={c.note ?? (m ? `darktable: ${moduleName(m.op)}` : "")}>
      <span>{c.label}</span>
      <input type="checkbox" className="switch" checked={value === 1} disabled={disabled}
             onChange={(e) => onChange(e.target.checked ? 1 : 0)} />
    </label>
  );
}

// the parametric curve as it will be written, over the region bands
function CurveGraph({ values: v, histogram, mark }: {
  values: Record<string, number>; histogram: Histogram | null; mark: CurveMark | null;
}) {
  const W = 260, H = 260;
  const hist = histogramPath(histogram, W, H);
  const pts = curve(parametricOf(v));
  const d = pts.map(([x, y], k) => `${k ? "L" : "M"}${(x * W).toFixed(1)},${((1 - y) * H).toFixed(1)}`).join(" ");
  const splits = [v.tc_split1 ?? 25, v.tc_split2 ?? 50, v.tc_split3 ?? 75];
  return (
    <svg className="curve" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {hist && <path d={hist} className="hist" />}
      {[0.25, 0.5, 0.75].map((g) => (
        <g key={g}>
          <line x1={g * W} y1={0} x2={g * W} y2={H} className="grid" />
          <line x1={0} y1={g * H} x2={W} y2={g * H} className="grid" />
        </g>
      ))}
      {splits.map((s, i) => <line key={i} x1={(s / 100) * W} y1={0} x2={(s / 100) * W} y2={H} className="split" />)}
      <line x1={0} y1={H} x2={W} y2={0} className="identity" />
      <path d={d} className="line" />
      {mark && <CurveMarkView mark={mark} W={W} H={H} />}
    </svg>
  );
}

// the photo under the pointer on the curve: the input that, through the
// curve shown, gives the tone on screen. the display pixel is after the
// curve, so the curve is run backwards; modules after it (vignette, grain)
// shift the answer a little
function markOnCurve(probe: Probe, v: Record<string, number>, pointMode: boolean, channel: CurveChannel): CurveMark {
  const ch = pointMode && channel !== "rgb" ? ({ r: 0, g: 1, b: 2 } as const)[channel] : null;
  const f = !pointMode ? polyline(paramCurve(parametricOf(v)))
    : ch === null ? monotone(pointsOf(v)) : channelCurve(pointsOf(v, channel));
  const x = invert(f, ch === null ? lightness(probe.rgb) : probe.rgb[ch] / 255);
  return { x, y: Math.min(1, Math.max(0, f(x))) };
}
