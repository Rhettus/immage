
import { AgxPresetLoader } from "./AgxPresetDialog";
import { settings } from "./settings";
import { useAgxProfiles } from "./agxProfiles";
import { profileSelection, AGX_USER_FIRST } from "./manifest";



import { AdvancedToggle, advancedEdited, useAdvanced } from "./advanced";
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { newPhotoPresetValues, preparePastePhoto } from "./pasteDefaults";
import { pasteTargets, replaceMasks, restorePaste, runPaste, type PasteUpdate } from "./batchPaste";
import { CaptureTimeDialog } from "./CaptureTimeDialog";
import { captureMillis, type CaptureTimeEntry, type CaptureTimeUpdate } from "./captureTime";
import { Fragment, Profiler, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { controlById, GUIDE_IDS, guidesOf, isModuleSetting, MAX_GUIDES, UPRIGHT_GUIDED, UPRIGHT_MODES, uprightAspect, rotateOf, mapsFor, NEG_CHOICES, NEG_OFF, NEG_OFF_UNMAPPED, SF_CHOICES, SF_OFF, SF_OFF_UNMAPPED, panels, profileLabel, turnPath, turnRect, type Control, type Values, type Turn } from "./manifest";
import { autoArea, autoBlack, autoDmax, autoDmin, autoExposure as autoPrintExposure, autoOffset, autoWbHigh, autoWbLow,
         FILM_BW, FILM_COLOR, fromValues, PRESETS, toValues, type Stats } from "./negadoctor";
import { NegativePanel, negAdvancedIds, type NegPick } from "./NegativePanel";
import { FilmPanel, filmAdvancedIds } from "./FilmPanel";

import { PrintPanel } from "./PrintPanel";
import { applyProof, cellsLayout, defaultPrintSettings, hasPrintSettings, LABEL_POINTS, layout as printLayout,
         loadPrintSettings, NO_PROOF, PDF, PDF_PAPERS, printerInfo, printRequest, sheetPages, sheetRequest,
         storePrintSettings, type Paper, type Printer, type PrinterInfo, type PrintSettings, type Profile, type Proof,
         type SheetPhoto } from "./print";
import { PositiveFooter } from "./PositiveFooter";
import { filmChanges, paperChanges, presetValues as sfPresetValues, SF_PRESETS, type FetchStatus,
         type Stocks } from "./spektrafilm";
import { Pipette } from "lucide-react";

import { FrameUpdates, Snapshot } from "./uiUpdates";
import { PixelCadence, PixelWorker } from "./pixelWorker";
import { CanvasFrames, FrameGeneration, layerStyle, placeCanvas, resizeCanvas } from "./canvasLayers";
import { KEY_ZOOMS, ZOOMS, type Placement, type Zoom } from "./zoom";
import { Session, colorProfiles, framePlace, instanceKey, mapOpOf, type Frame, type HistoryItem, type ModuleState, type View } from "./session";
import { AUTO_TONE_IDS, autoExposure, autoTone, type SceneKey } from "./autoTone";

import { type ClipShow, type Histogram, type ScopeSettings } from "./histogram";
import { applyCacheLimits } from "./CachePrefs";
import { fetchThumb, fileKind, isCompanion, isPrimaryRaw, loadIncludeSubfolders, openFolder, pairKey, pairPartners, storeIncludeSubfolders, ThumbLoader, byCaptureTime, knownKey, withKnown, type ImageEntry, type Known } from "./library";
import { known, MetadataPanel, type TextFields } from "./MetadataPanel";
import { HistoryPanel, stepName } from "./HistoryPanel";
import { VignetteOverlay } from "./VignetteOverlay";
import { GuideOverlay } from "./GuideOverlay";
import { autoMix } from "./bwauto";
import { begin, end, track, useWorking } from "./activity";
import { runInBackground, runMerge, useJobs } from "./background";
import { withModel } from "./aiModel";
import { invert, pixelAt, setProbe, type RGB } from "./probe";
import { anchored, neutralize, whitePatch, type WB } from "./wb";



import { ExportDialog } from "./ExportDialog";
import { CopyDialog, loadCopyGroups, makeClip, type Clip } from "./CopySettings";
import { DenoiseDialog } from "./DenoiseDialog";
import { HdrDialog } from "./HdrDialog";
import { PanoDialog, type Projection } from "./PanoDialog";
import { Tour, tourSeen } from "./Tour";
import { UpdateBanner } from "./UpdateBanner";
import { autoCheck, relaunch } from "./updates";

import { loadFrameCacheMb, loadThumbMemoryMb, refreshMemoryBudget } from "./memoryBudget";
import { loadOpenGenerated, storeOpenGenerated, loadLoupe, storeLoupe, loadAutoHide, loadAutoToneNew, loadExposureCompNew, loadCanvas, loadEditedKeywords, loadEditedMeta, loadFocusMode, loadNewPhotosNonRaw, loadNewPhotosProfile, loadOverlayColor, loadGuideColor, guideRgb, loadPins, maskOverlayRgb, loadPreview, loadBalancedPreviewSize, loadDraftTarget, loadDraftSmallest, loadSliderScroll, loadStackPairs, PreferencesDialog, storeOverlayColor, storeGuideColor, storeStackPairs, storeAutoHide, storeCanvas, CANVASES, storeFocusMode, storePins, type AccelProvider, type Canvas, loadNegWarn, loadNegProfiles, storeNegProfile, loadNegativeExportFormat, loadReadAhead, storeNegWarn, storeNegativeExportFormat, type Pins, type PrefsTab, type Preview } from "./Preferences";
import { kindOf, loadPlugins, loadReturns, returnValues, storePlugins, unfit, type PluginConfig,
         type PluginReturn } from "./plugins";
import { FolderTree, type Volume } from "./FolderTree";
import { baseName, parentDir, within } from "./paths";
import { isEngineExit, reopenPlan, reopening, START as ENGINE_START, step as engineStep, wait as engineWait,
         type EngineEvent, type EngineState, type Notice as EngineNotice } from "./engineState";
import { ImportView } from "./ImportView";
import type { ImportResult } from "@immporter/embed";
import { MaskOverlay, type BrushSettings, type MaskTool, type ObjectPrompt } from "./MaskOverlay";
import { MasksPanel, type AiKind, type ToolTarget } from "./MasksPanel";

import { HealPanel } from "./HealPanel";
import { LOCAL_TRANSITION, ObjectBox, ZoneAdjust, ZoneSystem, type ZoneMaskInfo } from "./ZoneSystem";
import { DEFAULT_TRANSITION, loadZoneOverlay, offsetsOf, overlayRgb, paintRange, paintWeights, parseZones, placeIds,
         placeTable, nextObjectKind, partLabel,
         rangeCenter, samePart, saveZoneOverlay, ZONE_PARTS, zoneAt, zoneMaskName, zoneOfMask, zonePartOf, zoneShape,
         type ZoneData, type ZoneOverlay, type ZonePart, type ZoneRange } from "./zones";
import { SpotOverlay, type SpotTool } from "./SpotOverlay";
import type { NewSpot, Spot } from "./spots";
import { aiRefine, type Backdrop, flipMode, isRange, isRefined, maskAt, readsBackdrop, maskKindName, nextMaskName, NO_REFINE, overlayShown, overlayStep, rangeChannels,
         type BlendifChannel, type ChannelRange, type Mask, type ObjectShape, type OverlayToggle, type ParametricRange, type Range,
         type RangeMap, type Refine, type Region, type Shape } from "./masks";
import { channelTint, type Picked } from "./ParametricEditor";
import { BUILTIN_PRESETS, loadLooks, loadNewPhotosPreset, loadPresets, NewPresetDialog, PresetsPanel, PreviewCache,
         readSharedPresets, savePresets, sharedPresets, storeNewPhotosPreset, type Look, type Preset } from "./Presets";
import { ASPECTS, CropOverlay, customAspect, findAspect, fitAspect, FULL, loadCustomAspects, pixelAspect,
         rememberCustomAspect, type Aspect, type CropRect } from "./CropTool";
import { ShortcutsDialog } from "./Shortcuts";
import { SupportBundleDialog, supportValues, type SupportValues } from "./SupportBundleDialog";
import { cmd, fieldKeeps, IS_MAC, keys } from "./keys";
import { chordAction } from "./actions";
import { MenuBar } from "./MenuBar";
import { forPlatform, MENUS, nativeSpec, type ActionId } from "./menu";
import { perf } from "./perf";
import { renderDimensions } from "./renderDimensions";
import { draftScale, settledScale } from "./pixelRatio";
import { settledFitView } from "./fitPreview";
import { runGuiBenchmark as runGuiBenchmarkDriver, runGpuCheck as runGpuCheckDriver, type BenchContext } from "./benchDrivers";
import { timeTunerWork } from "./tunerWorkload";
import { hasPendingTuner } from "./PerformanceTuner";
import { PerformanceTuner } from "./PerformanceTuner";
import type { TunerRun } from "./previewTuning";
import { PerfHud } from "./PerfHud";
import { KeywordingPanel } from "./Keywording";
import { ImmichPanel } from "./ImmichPanel";
import { immichUrl, isRemote, loadSearch, photoUrl, resolve, search as searchImmichPage, searchUrl, storeSearch, type ImmichSearch } from "./immich";
import { needsRead, NO_FILTER, passes, type Filter } from "./filter";
import { Layout, Library, PanelKey, loadLayout, loadLibrary, saveLayout, saveLibrary } from "./layoutPrefs";
import { ResetAll, Splitter, Toolbar, ZoomBar } from "./Toolbar";
import { CellCanvas, Filmstrip, INFO_MODE_KEY, InfoOverlay, ThumbCanvas, ThumbProgress, copyName, loadInfoMode, pairedRaws } from "./Filmstrip";
import { ActivityBar, JobActivity } from "./ActivityBar";
import { FileMenu, TRASH, hdrBrackets, panoFrames } from "./FileMenu";
import { BeforeAfterIcon, CompareIcon, CropIcon, DriveIcon, ExportIcon, FilmIcon, FilmSimIcon, FlipIcon, FoldIcon, FolderIcon, GearIcon, HealIcon, HelpIcon, ImportIcon, KeyboardIcon, LayersIcon, NetworkIcon, PinIcon, PresetsIcon, PrintIcon, RefreshIcon, RotateIcon, RulerIcon, SlidersIcon, UndoIcon, ZonesIcon, icon } from "./icons";
import { HistogramView, SCOPE_MODES, loadScope } from "./HistogramView";
import { Navigator } from "./Navigator";
import { PanelView, UPRIGHT_ICONS, UPRIGHT_TITLES, WBTools, isMono, presetValues, sampleSpot } from "./PanelView";
import { Choice, OptionPreview, Slider, Toggle } from "./Controls";
import { commands, type PrintReply, type Value } from "./commands";

const MAX_PREVIEW = 2560;
const OTHER_MENUS = forPlatform(MENUS, false);
// what a layer keeps of its frame to be placed (framePlace)
type Placed = Pick<Frame, "x" | "y" | "view" | "fullWidth" | "fullHeight" | "width" | "height">;
const placed = (f: Frame): Placed => ({ x: f.x, y: f.y, view: f.view, fullWidth: f.fullWidth, fullHeight: f.fullHeight,
                                        width: f.width, height: f.height });

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
    const n = Number(settings.get("immage.holdHintSeen") ?? 0);
    if (n >= 3) return false;
    settings.set("immage.holdHintSeen", String(n + 1));
  } catch { /* shown every time */ }
  return true;
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export default function App() {
  useAgxProfiles();
  perf.count("react.appRenderAttempts");
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
  // the drive each folder is on, for the tree's headings; kept between
  // launches, so a folder on a share not mounted stays under its share
  const [volumes, setVolumes] = useState<Map<string, Volume>>(
    () => new Map(Object.entries(loadLibrary().volumes ?? {}).map(([p, v]) => [p, { ...v, online: true }])));
  const volumesRef = useRef(volumes);
  volumesRef.current = volumes;
  const [foldedVolumes, setFoldedVolumes] = useState<Set<string>>(() => new Set(loadLibrary().foldedVolumes));
  const [hostNames, setHostNames] = useState<Record<string, string>>(() => loadLibrary().hostNames ?? {});
  useEffect(() => { void refreshMemoryBudget(); }, []);
  // read again every few seconds, for the drive headings' dots: a share
  // that comes back has its folders' subfolders read again
  useEffect(() => {
    let stale = false;
    const read = () => void commands.folderVolumes(folders).then((list) => {
      if (stale) return;
      const next = new Map<string, Volume>();
      let back = false;
      for (const v of list) {
        const seen = volumesRef.current.get(v.path);
        if (v.online && seen?.online === false) back = true;
        next.set(v.path, !v.online && seen ? { ...seen, online: false } : v);
      }
      if (JSON.stringify([...next]) === JSON.stringify([...volumesRef.current])) return;
      setVolumes(next);
      saveLibrary({ volumes: Object.fromEntries(next) });
      if (back) setFolderRefresh((n) => n + 1);
    });
    read();
    const timer = setInterval(read, 10000);
    return () => { stale = true; clearInterval(timer); };
  }, [folders, folderRefresh]);
  const [images, setImages] = useState<ImageEntry[]>([]);
  // the key handler and the loader outlive renders, so they read these refs
  const imagesRef = useRef<ImageEntry[]>([]);
  const currentRef = useRef<Opened | null>(null);
  // whether a listed photo is the open one: by imgid, as a file's virtual
  // copies share its path; until the engine has said, the file's original
  const isOpen = (i: ImageEntry, o = currentRef.current) =>
    !!o && (o.imgid !== null ? i.imgid === o.imgid : i.path === o.path && !i.copy);
  const loader = useRef<ThumbLoader | null>(null);
  if (!loader.current)
    loader.current = new ThumbLoader((imgid) => imagesRef.current.find((i) => i.imgid === imgid),
                                     () => loadThumbMemoryMb() * 1024 * 1024,
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
  const [values, publishValues] = useState<Record<string, number>>({});
  const valueUpdates = useRef<FrameUpdates<Record<string, number>> | null>(null);
  valueUpdates.current ??= new FrameUpdates(publishValues);
  const setValues = (update: React.SetStateAction<Record<string, number>>) =>
    valueUpdates.current!.immediate(old => typeof update === "function" ? update(old) : update);
  useEffect(() => () => valueUpdates.current?.dispose(), []);
  const [status, setStatusRaw] = useState("open a folder to start");
  // a command the engine's exit cut off reports it as an error; while the
  // engine restarts, and just after, that goes to the console: the restart
  // has its own words (engineEvent)
  const quietUntil = useRef(0);
  const setStatus = useCallback((s: React.SetStateAction<string>) => {
    if (typeof s === "string" && isEngineExit(s) && performance.now() < quietUntil.current) {
      console.warn(s);
      return;
    }
    setStatusRaw(s);
  }, []);
  // how far the open folder's reading has got, while it is read
  // `files` lists them all, in the order they are read, once `listed`;
  // `known` are the photos the folder's last read found, shown until read
  const [reading, setReading] = useState<{ done: number; total: number; files: string[]; listed: boolean;
                                           known: Known[] } | null>(null);
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
  const [tunerOpen, setTunerOpen] = useState(false);
  useEffect(() => { if (current && hasPendingTuner()) setTunerOpen(true); }, [current]);
  const [prefsOpen, setPrefsOpen] = useState<false | true | PrefsTab>(false);
  // the Immich card: shown once Immich is set up (checked again as
  // Preferences closes), with the server's URL for links into its web app.
  // with `immich` set, the filmstrip holds that search's results, not a folder
  const [immichBase, setImmichBase] = useState<string | null>(null);
  useEffect(() => { if (!prefsOpen) void immichUrl().then(setImmichBase); }, [prefsOpen]);
  const [immich, setImmichState] = useState<{ search: ImmichSearch; next: string | null; busy: boolean } | null>(null);
  const immichRef = useRef(immich);
  const setImmich = (v: typeof immich) => { immichRef.current = v; setImmichState(v); };
  // the Immich search as the card, the Filters popup and the stars set it.
  // a change searches again a moment later while its results show
  const [immichForm, setImmichForm] = useState<ImmichSearch>(loadSearch);
  const immichFormRef = useRef(immichForm);
  const immichTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(immichTimer.current), []);
  const updateImmich = (patch: Partial<ImmichSearch>, now = false) => {
    const next = { ...immichFormRef.current, ...patch };
    immichFormRef.current = next;
    setImmichForm(next);
    storeSearch(next);
    window.clearTimeout(immichTimer.current);
    if (now) void searchImmich(next);
    else if (immichRef.current) immichTimer.current = window.setTimeout(() => void searchImmich(next), 400);
  };
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // the filmstrip's selection, by image: ratings, labels and rejects apply
  // to all of it, as in Lightroom; the open photo is the active one
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [pasting, setPasting] = useState<string | null>(null);
  const pastingRef = useRef(false);
  const menuActionsRef = useRef<Partial<Record<ActionId, () => void>>>({});
  const [supportBundle, setSupportBundle] = useState<SupportValues | null>(null);
  const openSupportBundleRef = useRef<() => Promise<void>>(async () => {});
  // the dialog scrubs the engine's log, so it is told the folders and photo names the app has shown
  openSupportBundleRef.current = async () => {
    setSupportBundle(await supportValues({
      folders: [folder, ...folders],
      photos: images.flatMap((i) => [i.filename, i.path]),
    }));
  };
  const lastKeyActionRef = useRef<{ id: ActionId; t: number } | null>(null);
  const addFolderRef = useRef<() => void | Promise<void>>(() => {});
  const pasteUndoSession = useRef<Session | null>(null);
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
  useEffect(() => { commands.aiAccel().then(setAccel).catch(() => setAccel([])); }, []);
  // Preferences' cache limits, which the app's caches start without
  useEffect(() => { applyCacheLimits(); }, []);
  // a photo's right-click menu, where it was clicked
  // the photos it acts on are the selection when the click is in it, else
  // that photo alone
  const [captureDialog, setCaptureDialog] = useState<{ targets: ImageEntry[]; reference: ImageEntry; undo?: CaptureTimeEntry[] } | null>(null);
  const [captureUndo, setCaptureUndo] = useState<CaptureTimeEntry[]>([]);
  const startCaptureAdjustment = (targets: ImageEntry[], preferred?: ImageEntry) => {
    const local = targets.filter((i) => !isRemote(i));
    const valid = (i: ImageEntry) => Number.isFinite(captureMillis(i.exif.datetime));
    const reference = preferred && local.some((i) => i.imgid === preferred.imgid) && valid(preferred)
      ? preferred : local.find(valid);
    if (reference) setCaptureDialog({ targets: local, reference });
    else setStatus("no selected photos have a recorded capture time");
  };
  const startCaptureUndo = () => {
    const reference = imagesRef.current.find((i) => i.imgid === captureUndo[0]?.imgid);
    if (reference) setCaptureDialog({ targets: [], reference, undo: captureUndo.map((e) => ({ imgid: e.imgid, before: e.after, after: e.before })) });
    else setStatus("open the folder containing the adjusted photos to undo their capture times");
  };
  const applyCaptureTimes = async (entries: CaptureTimeEntry[]) => {
    const reply = await commands.captureTimes(entries);
    const changed = reply.updates.filter((e) => !e.error);
    const times = new Map(changed.map((e) => [e.imgid, e.after]));
    updateImages(byCaptureTime(imagesRef.current.map((i) => times.has(i.imgid)
      ? { ...i, exif: { ...i.exif, datetime: times.get(i.imgid)! } } : i)));
    setOpenCell((i) => i && times.has(i.imgid) ? { ...i, exif: { ...i.exif, datetime: times.get(i.imgid)! } } : i);
    if (captureDialog?.undo) {
      const restored = new Set(changed.map((e) => e.imgid));
      setCaptureUndo((old) => old.filter((e) => !restored.has(e.imgid)));
    } else if (changed.length) setCaptureUndo(changed);
    const failures = reply.updates.filter((e) => e.error);
    const message = `${changed.length} photo${changed.length === 1 ? "" : "s"} ${captureDialog?.undo ? "restored" : "adjusted"}.`
      + (failures.length ? ` ${failures.length} could not be saved; their capture times were left unchanged. ${failures[0].error}.` : "")
      + (!captureDialog?.undo && changed.length ? " Undo Capture Time Adjustment is available in the photo context menu." : "");
    setStatus(message);
    return message;
  };
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
  // the guides' color, for the stylesheet (styles.css, --guide)
  const [guideColor, setGuideColor] = useState(loadGuideColor);
  useEffect(() => { document.documentElement.style.setProperty("--guide", guideRgb(guideColor).join(", ")); }, [guideColor]);
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
  const [zonesAdvanced, toggleZonesAdvanced] = useAdvanced("zones");
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
  const rangeInteracting = useRef(false);
  const refined = () => {
    setRefining(true);
    window.clearTimeout(refineTimer.current);
    refineTimer.current = window.setTimeout(() => { if (!rangeInteracting.current) setRefining(false); }, 1500);
  };
  const maskBox = useRef<HTMLDivElement>(null);
  const masksMode = rightMode === "masks";
  useEffect(() => {
    rangeInteracting.current = false;
    window.clearTimeout(refineTimer.current);
    setRefining(false);
    return () => { rangeInteracting.current = false; window.clearTimeout(refineTimer.current); };
  }, [maskSel, current, masksMode]);
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
  // the film panel's tiles share the cache: only one of the two panels is on
  // show, and each asks for its own keys when it opens
  const sfStocksRef = useRef<Stocks | null>(null);
  // a film or paper tile's edit: what choosing the stock would change, on
  // the edit as it is (film:<hash>, paper:<film hash>:<pick>)
  const isStockKey = (key: string) => key.startsWith("film:") || key.startsWith("paper:");
  const stockValues = (s: Session, key: string): Values | null => {
    const stocks = sfStocksRef.current?.stocks;
    if (!stocks) return null;
    const parts = key.split(":");
    if (key.startsWith("paper:")) return Object.fromEntries(paperChanges(stocks, s.values, Number(parts[2])));
    const film = stocks.find((x) => !x.printing && x.hash === Number(parts[1]));
    return film ? Object.fromEntries(filmChanges(stocks, s.values, film)) : null;
  };
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
      if (isStockKey(key)) {
        const v = stockValues(s, key);
        return v ? [{ key, run: () => s.preview(PREVIEW_SIZE, v) }] : [];
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
      const { sx, sy } = await commands.spotSource(spot);
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
      const v = await commands.sample(x, y, null, null);
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
      const v = await commands.sample(x, y, area, null);
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
          const v = await commands.sample(x, y, null, null);
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
  // added as an object shape. the engine runs the model beside editing,
  // so the photo may have been left by the time it answers: the outline
  // is then dropped
  const runAi = async (model: string, working: string, run: () => Promise<ObjectShape["paths"]>,
                       done: (paths: ObjectShape["paths"]) => void) => {
    const s = session.current;
    if (!s || aiBusy) return;
    setAiBusy(true);
    const stop = await listen<{ stage: string; mb?: number }>("ai-model", (e) => {
      const p = e.payload;
      setStatus(p.stage === "downloading" ? `downloading the AI model (${p.mb ?? "?"} MB), first use only…`
              : p.stage === "installing" ? "installing the AI model…" : working);
    });
    try {
      const paths = await withModel(model, () => { setStatus(working); return run(); });
      if (session.current !== s) setStatus("");
      else if (!paths.length) setStatus("nothing found");
      else { done(paths); setStatus(""); }
    } catch (e) {
      setStatus(session.current === s ? `AI mask: ${e}` : "");
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
  const backgroundJobs = useJobs();
  // AI Denoise: darktable's raw denoise writes a DNG beside the raw with its
  // edit as it was asked for (the engine's ai_denoise), shown after it in
  // the folder as an Edit In result. it runs in the background, one at a
  // time, and the DNG first opens with noise reduction off, as the model
  // did that (openFile)
  const [denoising, setDenoising] = useState(false);
  const [denoiseRunning, setDenoiseRunning] = useState(false);
  // the brackets Merge to HDR's dialog is asking about
  const [hdrMerging, setHdrMerging] = useState<ImageEntry[] | null>(null);
  // the photos Panorama Merge's dialog is asking about
  const [panoMerging, setPanoMerging] = useState<ImageEntry[] | null>(null);
  // its model, downloaded on first use, for the dialog's preview
  const denoiseModel = async () => {
    const stop = await listen<{ stage: string; mb?: number }>("ai-model", (e) => {
      const p = e.payload;
      setStatus(p.stage === "downloading" ? `downloading the AI model (${p.mb ?? "?"} MB), first use only…`
              : p.stage === "installing" ? "installing the AI model…" : "");
    });
    try {
      await commands.aiModelEnsure("rawdenoise-nind");
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
  // a background job's result, opened from the activity line as a double
  // click in the grid opens a photo: out of the grid and Compare, which
  // would otherwise cover it
  const openResult = (path: string, imgid?: number) => {
    setCompare(null);
    // Generated files are local and cannot appear in an Immich search.
    // Show their folder so returning to the grid also reveals the result.
    if (immichRef.current) {
      window.clearTimeout(immichTimer.current);
      void showFolder(parentDir(path));
    }
    void openFile(path, imgid);
    setGrid(false);
  };
  // Use the current preference when a background result arrives.
  const generatedAction = (path: string, imgid?: number, auto = true) => {
    if (auto && loadOpenGenerated()) {
      openResult(path, imgid);
      return undefined;
    }
    return { label: "Open", run: () => openResult(path, imgid) };
  };
  const runDenoise = (amount: number) => {
    const from = currentRef.current?.path;
    if (!session.current || !from || denoiseRunning) return;
    setDenoiseRunning(true);
    void runInBackground(`AI Denoise: ${baseName(from)}`, async () => {
      const stop = await listen<{ stage: string; mb?: number }>("ai-model", (e) => {
        const p = e.payload;
        setStatus(p.stage === "downloading" ? `downloading the AI model (${p.mb ?? "?"} MB), first use only…`
                : p.stage === "installing" ? "installing the AI model…" : "");
      });
      try {
        return await withModel("rawdenoise-nind", () => commands.aiDenoise(amount / 100));
      } finally {
        stop();
      }
    }, (r) => {
      returns.current.set(r.path, { original: r.original, result: r.path, plugin: "ai-denoise", applied: false });
      // in the folder after the raw, if that is still the one shown
      if (folderRef.current && !immichRef.current && parentDir(r.path) === folderRef.current)
        void showFolder(folderRef.current, true);
      return { text: `AI Denoise: wrote ${baseName(r.path)}`, ok: true,
               action: generatedAction(r.path, r.image.imgid) };
    }, "AI Denoise").finally(() => setDenoiseRunning(false));
  };
  // Export to Library in the Negative and Film Simulation panels: the edit
  // baked into a positive beside the photo (positive_export in main.rs)
  const [positiveExporting, setPositiveExporting] = useState(false);
  const positiveExportRunning = useRef(false);
  const [positiveFormat, setPositiveFormat] = useState(loadNegativeExportFormat);
  const exportPositive = (kind: "negative" | "film") => {
    const s = session.current, from = currentRef.current?.path;
    const flag = kind === "negative" ? "neg_on" : "sf_on";
    if (!s || !from || s.values[flag] !== 1 || positiveExportRunning.current) return;
    positiveExportRunning.current = true;
    setPositiveExporting(true);
    const format = loadNegativeExportFormat();
    const title = kind === "negative" ? "Converted positive" : "Film simulation";
    void runInBackground(`${title}: ${baseName(from)}`, async () => {
      s.flushEdits();
      await s.settled();
      if (session.current !== s) throw new Error("the open photo changed; export it again");
      return await commands.positiveExport(s.imgid, from, format, kind);
    }, (r) => {
      returns.current.set(r.path, { original: r.original, result: r.path,
                                    plugin: kind === "negative" ? "negative-positive" : "film-positive", applied: true });
      if (folderRef.current && !immichRef.current && parentDir(r.path) === folderRef.current)
        void showFolder(folderRef.current, true);
      return { text: `${title}: wrote ${baseName(r.path)}`, ok: true,
               action: generatedAction(r.path, r.image.imgid) };
    }, kind === "negative" ? "Export converted negative" : "Export film simulation").finally(() => {
      positiveExportRunning.current = false;
      setPositiveExporting(false);
    });
  };
  // Lightroom's Photo Merge › HDR on darktable's HDR merge: a float DNG
  // beside the first bracket, listed in the folder after it, opened from
  // the activity line. the engine merges on its export thread
  const runHdrMerge = (list: ImageEntry[], align: boolean) => {
    const first = list[0];
    void runMerge("HDR Merge", list.length, (job) => commands.hdrMerge(job, list.map((i) => i.imgid), align),
    (r) => {
      if (folderRef.current && !immichRef.current && parentDir(r.path) === folderRef.current)
        void showFolder(folderRef.current, true);
      return { text: `HDR Merge: wrote ${baseName(r.path)}`, ok: true,
               action: generatedAction(r.path, r.image.imgid) };
    }, `HDR Merge of ${first?.filename ?? "the photos"}`);
  };
  // Lightroom's Photo Merge › Panorama, stitched by the engine with OpenCV:
  // a DNG beside the first raw, listed in the folder after it as an Edit In
  // result, opened from the activity line. the engine stitches on its
  // export thread
  const runPanoMerge = (list: ImageEntry[], projection: Projection, crop: boolean) => {
    const first = list[0];
    void runMerge("Panorama Merge", list.length,
      (job) => commands.panoMerge(job, list.map((i) => i.imgid), projection, crop),
    (r) => {
      returns.current.set(r.path, { original: r.original, result: r.path, plugin: "panorama", applied: false });
      if (folderRef.current && !immichRef.current && parentDir(r.path) === folderRef.current)
        void showFolder(folderRef.current, true);
      const left = r.frames - r.used;
      return { text: `Panorama Merge: wrote ${baseName(r.path)}${left ? `, without ${left} photo${left > 1 ? "s" : ""} that overlapped no other` : ""}`,
               ok: true, action: generatedAction(r.path, r.image.imgid) };
    }, `Panorama Merge of ${first?.filename ?? "the photos"}`);
  };
  // an outline the mask adds is traced inside its edge, so its feather ends
  // there; one it takes away, or inverts (Background), on its edge, its
  // feather already on the selected side (main.c, _trace_json). one that
  // starts a mask over a plain, colorful background comes with that color
  // and its edge outline too, which end the feather at the color
  // (masks.ts, ObjectShape): the engine uses them in a mask's first shape
  const startsMask = (target: ToolTarget) =>
    target === "new" || (target !== "subtract" && !session.current?.masks.some((m) => m.name === maskSel));
  // `select` runs the AI command with the `backdrop` flag it is given
  const outline = async (select: (backdrop: boolean | null) => Promise<Value>, backdrop: boolean,
                         got: (b: Backdrop | undefined) => void) => {
    if (!backdrop) return await select(null) as ObjectShape["paths"];
    const r = await select(true) as { paths: ObjectShape["paths"]; backdrop: Backdrop | null };
    got(r.backdrop ? { range: r.backdrop.range, paths: r.backdrop.paths, plain: r.backdrop.plain } : undefined);
    return r.paths;
  };
  const selectObject = (prompt: ObjectPrompt) => {
    let backdrop: Backdrop | undefined;
    return runAi("mask-object-sam21-small", "finding the object…",
      () => outline((bd) => commands.aiObject(prompt.points ?? [], prompt.box ?? null, toolTarget !== "subtract", bd),
                    startsMask(toolTarget), (b) => { backdrop = b; }),
      (paths) => aiShown(createShape({ type: "object", paths, ai: { kind: "object", ...structuredClone(prompt), inset: toolTarget !== "subtract", backdrop: startsMask(toolTarget) }, ...(backdrop && { backdrop }) })));
  };
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
  // Subject and People only: the Landscape kinds are the background
  const selectAi = (k: AiKind, target: ToolTarget) => {
    const a = AI_KINDS[k];
    let backdrop: Backdrop | undefined;
    return runAi(a.model, a.working,
      () => outline((bd) => commands.aiMask(a.kind, null, k !== "background" && target !== "subtract", bd),
                    (k === "subject" || k === "people") && startsMask(target), (b) => { backdrop = b; }),
      (paths) => {
        const had = new Set(session.current?.masks.map((m) => m.name));
        const name = createShape({ type: "object", paths, ai: { kind: a.kind, inset: k !== "background" && target !== "subtract", backdrop: (k === "subject" || k === "people") && startsMask(target) }, ...(backdrop && { backdrop }) },
                                 k === "background" ? "new" : target, a.label);
        if (k === "background" && name) session.current?.setInvert(name, true);
        const refine = aiRefine(k);
        if (name && !had.has(name) && refine) session.current?.setRefine(name, refine);
        syncMasks();
        aiShown(name);
      });
  };
  // Depth Range: the depth where the image was clicked, give or take, as a
  // shape traced by the engine around that band of its depth map
  const DEPTH_MODEL = "mask-depth-da2-small";
  const pickDepth = (x: number, y: number) => {
    let depth: [number, number] = [0, 1];
    void runAi(DEPTH_MODEL, "finding depth…", async () => {
      const map = await track(commands.aiDepth(256));
      const i = Math.min(map.width - 1, Math.floor(x * map.width)), j = Math.min(map.height - 1, Math.floor(y * map.height));
      const d = map.data[j * map.width + i] / 255;
      depth = [Math.max(0, d - 0.15), Math.min(1, d + 0.15)];
      return commands.aiMask("depth", depth, null, null).then((r) => r as ObjectShape["paths"]);
    }, (paths) => aiShown(createShape({ type: "object", paths, depth, feather: 0.01 })));
  };
  // a Depth Range's sliders: the band traced again (a few ms once the
  // depth map is made); a reply overtaken by a newer move is dropped
  const depthToken = useRef(0);
  const editDepth = async (k: number, depth: [number, number], feather: number) => {
    const s = session.current, name = maskSel;
    if (!s || !name) return;
    const token = ++depthToken.current;
    try {
      const paths = await commands.aiMask("depth", depth, null, null) as ObjectShape["paths"];
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
  const duplicateMask = (name: string, invert: boolean, adjustments = true) => {
    const s = session.current;
    if (!s) return;
    record(["mask:create"]);
    const to = nextMaskName(s.masks, `${name} copy`);
    s.duplicateMask(name, to, adjustments);
    if (invert) s.setInvert(to, !s.masks.find((m) => m.name === to)!.invert);
    syncMasks();
    setMaskSel(to);
    setShapeSel(0);
  };
  // a mask's adjustments back to neutral, the mask itself kept
  const resetMaskAdjustments = (name: string) => {
    const s = session.current;
    if (!s) return;
    record([`mask:reset:${name}`], "Reset Mask Adjustments");
    s.resetMaskAdjustments(name);
    syncMasks();
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
      // Capture native state before any reset slider writes, so undo has
      // the pre-reset conversion and profiles as well as unexposed params.
      s.resetModules();
      // the profile, tone mapper and exposure compensation are the photo's
      // own, not adjustments; the orientation stays too, as in Lightroom.
      // each tool goes back to the module Preferences picks
      changeMany([...Object.entries(s.neutral).filter(([id]) => !isModuleSetting(id) && id !== "profile"
                                                             && id !== "exp_comp" && id !== "orient"),
                  ...s.preferredModules()]);
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
    showHover(!key ? null : "tiles", (s, size) => {
      if (key!.startsWith("l:")) return s.preview(size, lookValues(key!.slice(2)), key!.slice(2));
      if (isStockKey(key!)) { const v = stockValues(s, key!); return v ? s.preview(size, v) : null; }
      return p ? s.preview(size, p.values) : null;
    }, !!key && isStockKey(key));
  };
  const hoverValues = (values: Values | null) =>
    showHover(values && "panel", (s, size) => s.preview(size, values!), true);
  const showHover = (from: "tiles" | "panel" | null,
                     render: (s: Session, size: number) => Promise<Frame> | null,
                     sharp: boolean) => {
    const token = ++hoverToken.current;
    if (!from) { setHoverShown(false); return; }
    window.setTimeout(async () => {
      const s = session.current;
      if (!s || token !== hoverToken.current) return;
      const { w, h } = viewport();
      // tiles stay small except film and paper tiles, which like a panel's
      // swatches (grain above all, whose look depends on the pixels) render
      // at the size the image is shown at, so the hover is as sharp as the
      // edit and not stretched
      const f0 = full.current, z0 = viewZ.current;
      const shown = sharp && f0 && z0 ? Math.round(Math.max(f0.w, f0.h) * z0) : 0;
      const size = Math.min(sharp ? 3200 : 1600, Math.max(shown, Math.min(1600, Math.max(w, h))));
      try {
        const r = render(s, size);
        const f = r && await track(r);
        const c = hoverCanvas.current;
        if (!f || !c || token !== hoverToken.current) return;
        c.width = f.width;
        c.height = f.height;
        perf.time("pixels.canvasUpload", () => c.getContext("2d")!.putImageData(new ImageData(f.pixels, f.width, f.height), 0, 0));
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
    await commands.exportPresetsExport(sharedPresets([p]), safeName(p.name), "Immage preset")
      .then((saved) => { if (saved) setStatus(`exported "${p.name}"`); }, (e) => setStatus(`export preset: ${e}`));
  };
  const exportLook = async (l: Look) => {
    await commands.lookExport(l.path, safeName(l.name))
      .then((saved) => { if (saved) setStatus(`exported "${l.name}"`); }, (e) => setStatus(`export look: ${e}`));
  };
  const deleteLook = async (l: Look) => {
    try {
      await commands.lookDelete(l.path);
      // a photo wearing it keeps it, as its edit holds the look; only putting
      // it back on after the Before view needs the file
      if (session.current?.lookPath === l.path) session.current.lookPath = null;
      await reloadLooks();
    } catch (e) { setStatus(`delete look: ${e}`); }
  };
  const importShared = async () => {
    const got = await commands.sharedImport()
      .catch((e) => ({ presets: [], looks: 0, failed: [String(e)] }));
    let added: Preset[] = [];
    const looksIn = got.looks;
    const failed = [...got.failed];
    for (const doc of got.presets) {
      try {
        const more = readSharedPresets(doc, [...BUILTIN_PRESETS, ...presets, ...added]);
        if (!more.length) throw new Error("it has no presets this version can use");
        added = [...added, ...more];
      } catch (e) {
        failed.push(`preset file: ${e instanceof Error ? e.message : e}`);
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
  // the side panel scrolls once for every tool: each tool keeps its own
  // place, and a tool opened for the first time starts at the top
  const panelsRef = useRef<HTMLDivElement>(null);
  const panelScroll = useRef(new Map<string, number>());
  const panelKey = cropping ? "crop" : rightMode;
  const shownKey = useRef(panelKey);
  useLayoutEffect(() => {
    const el = panelsRef.current;
    if (!el || shownKey.current === panelKey) return;
    shownKey.current = panelKey;
    el.scrollTop = panelScroll.current.get(panelKey) ?? 0;
  }, [panelKey]);
  // WebKitGTK keeps the panel's scroll offset when its content shrinks (a
  // fold or Advanced closed) without clamping it: the top of the panel then
  // sits out of reach, with no scrollbar to bring it back. Clamp whenever a
  // panel changes size
  useEffect(() => {
    const el = panelsRef.current;
    if (!el) return;
    const clamp = () => {
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      if (el.scrollTop > max) el.scrollTop = max;
    };
    const ro = new ResizeObserver(clamp);
    const watch = () => {
      ro.disconnect();
      ro.observe(el);
      for (const c of el.children) ro.observe(c);
    };
    watch();
    const mo = new MutationObserver(watch);
    mo.observe(el, { childList: true });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, []);
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
  const maskSelRef = useRef<string | null>(null);
  maskSelRef.current = masksMode ? maskSel : null;
  const maskShown = overlayShown(maskOverlay, addingTo, maskSelRef.current);
  const overlayEvent = (ev: "key" | "adjust" | "stroke") =>
    setMaskOverlay((t) => overlayStep(t, addingRef.current, ev, maskSelRef.current));
  // a mask an AI selection just made: its overlay shows (overlayShown)
  const aiShown = (name: string | null) => setMaskOverlay((t) => ({ ...t, fresh: name }));
  useEffect(() => setMaskOverlay((t) => (t.fresh && t.fresh !== maskSel ? { ...t, fresh: null } : t)), [maskSel]);
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
      let stopped = false;
      while (!s.idle && !stale) {
        stopped = s.stopBase() || stopped;
        await new Promise((r) => setTimeout(r, 60));
      }
      if (stale) {
        if (stopped) resumeBase();
        return;
      }
      const width = 320, height = Math.max(1, Math.round((width * f.h) / f.w));
      try {
        const buf = await track(commands.rangeMap(ranges as unknown as Value[], width, height));
        if (!stale) {
          setRangeMap({ width, height, data: new Uint8Array(buf, 8) });
          setRangeFor(target!.name);
        }
      } catch (e) {
        setStatus(`range map: ${e}`);
      } finally {
        if (stopped) resumeBase();
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
  const wantsFinal = (m: Mask) => isRefined(m) || readsBackdrop(m) || (!!shownView && !shownView.fit && m.shapes.some(isRange));
  const [finalMap, setFinalMap] = useState<{ name: string; map: RangeMap; session: Session } | null>(null);
  // the mask whose map the engine could not make, which its shapes show instead
  const [finalMissing, setFinalMissing] = useState<string | null>(null);
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
          const stopped = s.stopBase();
          // the window the sharp render shows, at its scale, so the
          // refinements come out as they did in it
          try {
            const buf = await track(commands.maskMap(name, null, v.width, v.height, { x: v.x, y: v.y, scale: v.scale }));
            const head = new DataView(buf, 0, 8);
            const width = head.getUint32(0, true), height = head.getUint32(4, true);
            const fw = v.scale * f.w, fh = v.scale * f.h;
            const at: Region = [v.x / fw, v.y / fh, (v.x + width) / fw, (v.y + height) / fh];
            setFinalMap({ name, map: { width, height, data: new Uint8Array(buf, 8), at }, session: s });
            setFinalMissing(null);
            // keep showing it a moment once it is in
            if (refiningRef.current) refined();
          } catch {
            // a mask with no adjustment yet drives nothing: the shapes' overlay serves
            setFinalMap(null);
            setFinalMissing(name);
          } finally {
            if (stopped) resumeBase();
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
          const buf = await track(commands.rangeMap(ranges as unknown as Value[], width, height));
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
  const tilesShown = layout.right && (rightMode === "presets" || rightMode === "film") && !cropping;
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
        void commands.previewFullscreen(true);
      });
    } else if (madeFullscreen.current) {
      madeFullscreen.current = false;
      void commands.previewFullscreen(false);
    }
  };
  const cropRef = useRef({ rect: FULL, aspect: "original", portrait: false, choices: [] as Aspect[] });
  cropRef.current = { rect: cropRect, aspect: cropAspect, portrait: cropPortrait, choices: cropChoices };
  const [zoom, setZoomState] = useState<Zoom>("fit");
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [histograms] = useState(() => new Snapshot<Histogram | null>(null));
  const pixelWorker = useRef<PixelWorker | null>(null);
  const pixelsWorker = () => pixelWorker.current ??= new PixelWorker();
  const [frameGenerations] = useState(() => ({ sharp: new FrameGeneration(), base: new FrameGeneration(), histogram: new FrameGeneration() }));
  const [canvasFrames] = useState(() => new CanvasFrames());
  const [navigatorUpdates] = useState(() => new PixelCadence<{ frame: Frame; owner: Session | null }>(({ frame: f, owner }) => {
    const t = navThumb.current, bc = baseCanvas.current;
    if (session.current !== owner || !t || !bc || !canvasFrames.matches(bc, f)) return;
    resizeCanvas(t, 400, Math.round(400 * f.height / f.width));
    const ctx = t.getContext("2d")!;
    ctx.clearRect(0, 0, t.width, t.height);
    ctx.drawImage(bc, 0, 0, t.width, t.height);
  }));
  const resetCanvases = () => {
    navigatorUpdates.cancel(); canvasFrames.clear();
    frameGenerations.sharp.next(); frameGenerations.base.next(); frameGenerations.histogram.next();
  };
  const histogramWorker = useRef<PixelWorker | null>(null);
  const [histogramUpdates] = useState(() => new PixelCadence<{ frame: Frame; owner: Session | null; generation: number }>(({ frame: f, owner, generation }) => {
    if (session.current !== owner || !frameGenerations.histogram.matches(generation)) return;
    (histogramWorker.current ??= new PixelWorker()).submit("histogram",
      { kind: "histogram", pixels: f.pixels, width: f.width, height: f.height }, result => {
        if (session.current === owner && frameGenerations.histogram.matches(generation)) histograms.set(result as Histogram);
      });
  }));
  const resetHistogram = () => {
    frameGenerations.histogram.next();
    histogramUpdates.cancel();
    histogramWorker.current?.dispose(); histogramWorker.current = null;
  };
  useEffect(() => () => {
    pixelWorker.current?.dispose(); pixelWorker.current = null;
    resetHistogram();
    resetCanvases();
  }, []);
  useEffect(() => {
    pixelWorker.current?.dispose(); pixelWorker.current = null;
    resetHistogram();
    histograms.set(null);
  }, [current]);
  const updateHistogram = (f: Frame) => {
    const generation = frameGenerations.histogram.next();
    histogramUpdates.submit({ frame: f, owner: session.current, generation }, dragging.current);
  };
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
  const copyMeta = useRef<Placed | null>(null);
  const [copyOn, setCopyOn] = useState(false);
  // a copy dropped while its bitmap was being made is not drawn
  const copyGen = useRef(0);
  // Lightroom's clipping overlay, one layer over each image layer: shown
  // while its triangle is on (or J), or while the pointer rests on it
  const clipBase = useRef<HTMLCanvasElement>(null);
  const clipSharp = useRef<HTMLCanvasElement>(null);
  const [clipOn, setClipOn] = useState<ClipShow>({ low: false, high: false });
  const [scope, setScopeState] = useState<ScopeSettings>(loadScope);
  const setScope = useCallback((change: Partial<ScopeSettings> | ((s: ScopeSettings) => Partial<ScopeSettings>)) => setScopeState((s) => {
    const next = { ...s, ...(typeof change === "function" ? change(s) : change) };
    try { settings.set("immage.scope", JSON.stringify(next)); } catch { /* not kept */ }
    return next;
  }), []);
  const [clipPeek, setClipPeek] = useState<"low" | "high" | null>(null);
  const clipShown: ClipShow = { low: clipOn.low || clipPeek === "low", high: clipOn.high || clipPeek === "high" };
  const clipRef = useRef(clipShown);
  clipRef.current = clipShown;
  const invalidateClip = (layer: "base" | "sharp") => {
    frameGenerations[layer].next();
    pixelWorker.current?.cancel(layer === "base" ? "clipBase" : "clipSharp");
    const dst = layer === "base" ? clipBase.current : clipSharp.current;
    if (dst) dst.getContext("2d")!.clearRect(0, 0, dst.width, dst.height);
  };
  const paintClip = (layer: "base" | "sharp" | "both", frame?: Frame) => {
    const pairs: [HTMLCanvasElement | null, HTMLCanvasElement | null][] = [];
    if (layer !== "sharp") pairs.push([baseCanvas.current, clipBase.current]);
    if (layer !== "base") pairs.push([canvas.current, clipSharp.current]);
    for (const [src, dst] of pairs) if (src && dst) {
      const key = dst === clipBase.current ? "clipBase" : "clipSharp";
      pixelsWorker().cancel(key);
      const sourceGeneration = dst === clipBase.current ? frameGenerations.base : frameGenerations.sharp;
      const generation = sourceGeneration.capture();
      if (dst.width !== src.width || dst.height !== src.height) { dst.width = src.width; dst.height = src.height; }
      dst.getContext("2d")!.clearRect(0, 0, dst.width, dst.height);
      const show = { ...clipRef.current }, width = src.width, height = src.height, owner = session.current;
      if (!width || !height || (!show.low && !show.high)) continue;
      const pixels = frame?.pixels ?? perf.time("pixels.canvasReadback", () => src.getContext("2d")!.getImageData(0, 0, width, height).data);
      pixelsWorker().submit(key, { kind: "clipping", pixels, width, height, show }, result => {
        if (session.current !== owner || !sourceGeneration.matches(generation) || src.width !== width || src.height !== height
            || show.low !== clipRef.current.low || show.high !== clipRef.current.high) return;
        perf.time("pixels.clippingUpload", () => dst.getContext("2d")!.putImageData(new ImageData(result as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0));
      });
    }
  };
  useEffect(() => {
    paintClip("both");
  }, [clipShown.low, clipShown.high]);
  const baseMeta = useRef<Placed | null>(null);
  // a control in the panels, the histogram or the mask editor held down (or
  // a wheel turning one): frames are drafts until it lets go, and then one
  // full frame follows if a draft was shown
  const dragging = useRef(false);
  const draftShown = useRef(false);
  const [loupeShown, setLoupeShown] = useState(false);
  const [openGenerated, setOpenGenerated] = useState(loadOpenGenerated);
  const [loupeEnabled, setLoupeEnabled] = useState(loadLoupe);
  const [loupePicking, setLoupePicking] = useState(false);
  const loupeEnabledRef = useRef(true);
  loupeEnabledRef.current = loupeEnabled;
  const [loupePosition, setLoupePosition] = useState({ x: 0.5, y: 0.5 });
  const loupePositionRef = useRef(loupePosition);
  loupePositionRef.current = loupePosition;
  const loupeCanvas = useRef<HTMLCanvasElement>(null);
  const loupeDisplays = useRef(new Map<string, HTMLCanvasElement>());

  useEffect(() => {
    if (grid) {
      setLoupePicking(false);
      return;
    }
    if (loupeEnabled) session.current?.requestLoupe();
  }, [grid, loupeEnabled, loupePosition]);
  useEffect(() => {
    if (!loupePicking) return;
    const cancel = (e: KeyboardEvent) => {
      if (document.querySelector(".location-map-region.expanded")) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); setLoupePicking(false); }
    };
    window.addEventListener("keydown", cancel, true);
    return () => window.removeEventListener("keydown", cancel, true);
  }, [loupePicking]);

  useEffect(() => {
    const DRAG_AREAS = ".panels, .histogram, .mask-box";
    let wheelTimer = 0;
    const end = () => {
      if (!dragging.current) return;
      valueUpdates.current?.flush();
      dragging.current = false;
      histogramUpdates.flush();
      if (draftShown.current || session.current?.pending) session.current?.requestRender();
      else session.current?.flushEdits();
    };
    const down = (e: PointerEvent) => {
      // a <select>'s native menu takes the pointer on macOS: its pointerup
      // never reaches the page, so a drag begun there would never end
      if ((e.target as Element).closest?.("select")) return;
      if (e.button === 0 && (e.target as Element).closest?.(DRAG_AREAS)) dragging.current = true;
    };
    const wheel = (e: WheelEvent) => {
      if (!(e.target as Element).closest?.(".panels, .histogram") || !loadSliderScroll()) return;
      dragging.current = true;
      window.clearTimeout(wheelTimer);
      wheelTimer = window.setTimeout(end, 250);
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    window.addEventListener("blur", end);
    window.addEventListener("wheel", wheel, { capture: true, passive: true });
    return () => {
      window.clearTimeout(wheelTimer);
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      window.removeEventListener("blur", end);
      window.removeEventListener("wheel", wheel, true);
    };
  }, []);
  const sharpMeta = useRef<Placed | null>(null);
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
  // the whole image at the zoom's scale (100% above it), once the base and
  // the edits are done with; the session keeps one. fitted, it is the 100%
  // one, ready for the first zoom in; zoomed in, the fitted frame is
  // rendered too, ready for the zoom back out
  const copyTimer = useRef(0);
  const scheduleCopy = (delay: number) => {
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => {
      const s = session.current, f = full.current;
      if (!s || !f || anim.current.raf) return;
      if (!s.idle) { scheduleCopy(400); return; }
      if (zoomRef.current === "fit") {
        // a photo that fits at 100% already shows every pixel
        if (fitScale() < 1) s.requestCopy(1, f);
        return;
      }
      s.requestFit(settledFit());
      s.requestCopy(Math.min(1, scaleFor(zoomRef.current)), f);
    }, delay);
  };
  // the idle base, or zoomed in the copy, holds the engine for seconds: an
  // overlay the user waits on stops it (Session.stopBase), and asks for it
  // again once its own request is in
  const resumeBase = () => { scheduleBase(0); scheduleCopy(0); };
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

  // the fitted view's box, the engine fitting the whole image into it
  const fitView = (): View => {
    const { w, h } = viewport();
    const m = 2 * MARGIN * (window.devicePixelRatio || 1);
    return renderDimensions(w - m, h - m, MAX_PREVIEW);
  };
  const settledFit = (): View => settledFitView(fitView(), loadPreview(), settledScale());
  // the view at k times the full frame's size each way, k < 1 a drag's
  // during a zoom that renders ahead (animateTo), the view it ends on
  const viewAt = (k: number, draft = false): View => {
    const { w, h } = viewport();
    const f = full.current;
    const a = anim.current;
    const ahead = !!a.raf && !!a.end;
    const zoom = ahead ? a.zoom : zoomRef.current, c = ahead ? a.end! : center.current;
    if (zoom === "fit" || !f) {
      const { width, height } = fitView();
      if (k === 1) {
        return draft ? settledFitView(fitView(), loadPreview(), settledScale(), false) : settledFit();
      }
      return { width: Math.round(width * k), height: Math.round(height * k), draft: true };
    }
    const scale = scaleFor(zoom) * k;
    const view = {
      width: Math.round(w * k), height: Math.round(h * k), scale,
      x: Math.round(c.x * f.w * scale - (w * k) / 2),
      y: Math.round(c.y * f.h * scale - (h * k) / 2),
    };
    return k === 1 ? view : { ...view, draft: true };
  };
  // a drag's frames, as a share of the full frame's width and height, by the
  // preview size preference. reduced previews also follow the screen scale on
  // displays drawn larger than they show, full-size drafts too (the detail
  // sliders' whole-view draft); Quality keeps every pixel
  const fullDraftK = () => loadPreview() === "quality" ? 1 : draftScale();
  const draftK = () => {
    const k = loadBalancedPreviewSize();
    return k < 1 ? k * draftScale() : 1;
  };
  const currentView = useCallback((): View => dragging.current
    ? { ...viewAt(draftK(), true), draft: true } : viewAt(1), []);

  const follow = (layer: HTMLCanvasElement, clip: HTMLCanvasElement | null) => {
    if (!clip) return;
    layerStyle(clip, "width", layer.style.width);
    layerStyle(clip, "height", layer.style.height);
    layerStyle(clip, "transform", layer.style.transform);
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
      let stopped = false;
      while ((!s.idle || s.masksPending) && !stale) {
        stopped = s.stopBase() || stopped;
        await new Promise((r) => setTimeout(r, 60));
      }
      if (stale) {
        if (stopped) resumeBase();
        return;
      }
      const width = 512, height = Math.max(1, Math.round((width * f.h) / f.w));
      try {
        const buf = await track(commands.zones(width, height, DEFAULT_TRANSITION, "before"));
        const placed = offsetsOf(s.values).some((o) => o !== 0);
        const unplaced = placed
          ? await track(commands.zones(width, height, DEFAULT_TRANSITION, "unplaced"))
          : null;
        if (stale || s !== session.current) return;
        setZoneData(parseZones(buf));
        setZoneUnplaced(unplaced ? parseZones(unplaced) : null);
        setZoneError(null);
        setZoneStale(false);
      } catch (e) {
        if (!stale) setZoneError(`${e}`);
      } finally {
        if (stopped) resumeBase();
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
    void runAi(a.model, a.working, () => commands.aiMask(a.kind, null, null, null).then((r) => r as ObjectShape["paths"]), (paths) => {
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
      () => commands.aiObject(prompt.points ?? [], prompt.box ?? null, null, null).then((r) => r as ObjectShape["paths"]),
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
            data = new Uint8Array(await commands.maskMap(null, maskOp, width, height, null), 8);
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
    // A crop/rotation changes the image coordinate system. The old overview
    // cannot sit underneath the new frame while its replacement renders.
    const baseCompatible = !!b && b.fullWidth === f.w && b.fullHeight === f.h;
    if (bc) layerStyle(bc, "visibility", baseCompatible ? "" : "hidden");
    if (clipBase.current) layerStyle(clipBase.current, "visibility", baseCompatible ? "" : "hidden");
    if (b && bc) {
      const p = framePlace(b, z);
      placeCanvas(bc, b.width, b.height, { x: ox + p.x, y: oy + p.y, k: p.k }, dpr);
      follow(bc, clipBase.current);
    }
    const cm = copyMeta.current, cc = copyCanvas.current;
    if (cm && cc) {
      const p = framePlace(cm, z);
      placeCanvas(cc, cm.width, cm.height, { x: ox + p.x, y: oy + p.y, k: p.k }, dpr);
    }
    const s = sharpMeta.current, sc = canvas.current;
    if (s && sc) {
      const p = framePlace(s, z);
      placeCanvas(sc, s.width, s.height, { x: ox + p.x, y: oy + p.y, k: p.k }, dpr);
      follow(sc, clipSharp.current);
    }
    const bm = beforeMeta.current, bcv = beforeCanvas.current;
    if (bm && bcv) {
      // the Before view leaves out lens corrections and Transform, which
      // change the size of the whole image: it is fitted into the edit's
      const k = Math.min(f.w / bm.fullWidth, f.h / bm.fullHeight);
      const bx = ox + ((f.w - bm.fullWidth * k) * z) / 2, by = oy + ((f.h - bm.fullHeight * k) * z) / 2;
      const sx = bx + (bm.x / bm.scale) * k * z, sy = by + (bm.y / bm.scale) * k * z;
      placeCanvas(bcv, bm.width, bm.height, { x: sx, y: sy, k: (z * k) / bm.scale }, dpr);
    }
    zoomShow.current?.(z, zoomRef.current === "fit");
    const hc = hoverCanvas.current;
    if (hc) {
      layerStyle(hc, "left", `${ox / dpr}px`);
      layerStyle(hc, "top", `${oy / dpr}px`);
      layerStyle(hc, "width", `${(f.w * z) / dpr}px`);
      layerStyle(hc, "height", `${(f.h * z) / dpr}px`);
    }
    // the mask editor and the zone overlay cover the whole image, wherever it is
    for (const mb of [maskBox.current, zoneBox.current, detailBox.current, guideBox.current, negBox.current]) {
      if (!mb) continue;
      layerStyle(mb, "left", `${ox / dpr}px`);
      layerStyle(mb, "top", `${oy / dpr}px`);
      layerStyle(mb, "width", `${(f.w * z) / dpr}px`);
      layerStyle(mb, "height", `${(f.h * z) / dpr}px`);
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
    const old = placementRef.current;
    if (old && (Object.keys(pl) as (keyof Placement)[]).every(key => old[key] === pl[key])) return;
    placementRef.current = pl;
    setPlacement(pl);
  };

  const paintFrame = useCallback((f: Frame) => {
    draftShown.current = !!f.view.draft;
    // a draft back after the control let go (a short drag, or a slow draft
    // zoomed in) came too late for the release to ask for its full frame
    if (f.view.draft && !dragging.current) session.current?.requestRender();
    // the split view's before side: drawn on its own layer, and the session
    // goes back to the edit at once
    if (f.before && baModeRef.current !== "off") {
      const bc = beforeCanvas.current;
      if (bc) {
        resizeCanvas(bc, f.width, f.height);
        perf.time("pixels.canvasUpload", () => bc.getContext("2d")!.putImageData(new ImageData(f.pixels, f.width, f.height), 0, 0));
        const scale = f.view.scale ?? f.width / f.fullWidth;
        beforeMeta.current = { x: f.x, y: f.y, scale, width: f.width, height: f.height,
                               fullWidth: f.fullWidth, fullHeight: f.fullHeight, edit: editKey.current };
      }
      session.current?.showBefore(null);
      placeLayers();
      return;
    }
    if (f.view.loupe) {
      document.documentElement.dataset.loupeFrames = String(Number(document.documentElement.dataset.loupeFrames ?? 0) + 1);
      // a late draft must not cover the final frame after release
      if (gridRef.current || !loupeEnabledRef.current) return;
      setLoupeShown(true);
      const lc = loupeCanvas.current ?? (loupeCanvas.current = document.createElement("canvas"));
      if (lc) {
        resizeCanvas(lc, f.width, f.height);
        perf.time("pixels.canvasUpload", () => lc.getContext("2d")!.putImageData(new ImageData(f.pixels, f.width, f.height), 0, 0));
        for (const display of loupeDisplays.current.values()) {
          resizeCanvas(display, f.width, f.height);
          display.getContext("2d")!.drawImage(lc, 0, 0);
        }
      }
      return;
    }
    invalidateClip("sharp");
    frameGenerations.histogram.next();
    if (!gridRef.current && loupeEnabledRef.current && !f.view.draft) session.current?.requestLoupe();
    const c = canvas.current!;
    // Read-only observation for visible-app verification: distinguish a drag
    // draft from the final frame without exposing application commands.
    c.dataset.renderQuality = f.view.draft ? "draft" : "final";
    perf.time("pixels.canvasUpload", () => canvasFrames.draw(c, f));
    if (clipRef.current.low || clipRef.current.high) paintClip("sharp", f);
    full.current = { w: f.fullWidth, h: f.fullHeight };
    const scale = f.view.scale ?? f.width / f.fullWidth;
    sharpMeta.current = placed(f);
    // a drag's frame is drawn once and placed; the histogram follows it. the
    // base, navigator, split view and fade wait for the full frame after
    if (f.view.draft) {
      if (f.view.scale === undefined && zoomRef.current === "fit" && !anim.current.raf) {
        viewZ.current = fitScale();
        center.current = { x: 0.5, y: 0.5 };
      }
      placeLayers();
      if (f.view.scale === undefined) updateHistogram(f);
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
      // compared by the edit frame it was captured for: the before frame
      // may differ in size (a crop), and comparing it would capture forever
      const key = `${f.x},${f.y},${f.view.scale ?? f.width / f.fullWidth},${f.width},${f.height}`;
      editKey.current = key;
      const b = beforeMeta.current;
      if (!b || b.edit !== key) captureBefore(300);
    }
    // Present completed edits immediately; fading reveals an older overview
    // and makes each render flash back to the previous image.
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
      // Keep this completed frame as the overview when it already meets
      // the background preview's resolution, including native-size photos.
      const box = baseSize();
      const scale = Math.min(1, box.width / f.fullWidth, box.height / f.fullHeight);
      baseLowRes.current = loadPreview() !== "performance"
        && (f.width + 1 < Math.floor(f.fullWidth * scale)
          || f.height + 1 < Math.floor(f.fullHeight * scale));
      scheduleBase(500);
    } else if (f.view.scale === undefined) {
      updateHistogram(f);
    } else if (baseStale.current) {
      scheduleBase(300);
    }
    if (!f.before) scheduleCopy(600);
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
      const z = parseZones(await commands.zones(320, 320, DEFAULT_TRANSITION, "after"));
      if (gone()) return;
      const { exposure, ...key } = autoExposure(s.values.exposure, z);
      if (exposure !== s.values.exposure) quietly(() => changeMany([["exposure", exposure]]));
      let range: [string, number][] = [];
      if (s.values.tm_mode === 1) {
        await s.settled();
        if (gone()) return;
        const r = await commands.agxAuto();
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
  const negBox = useRef<HTMLDivElement>(null);
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
      const r = await commands.upright(UPRIGHT_FITS[mode], null, uprightAspect(s.values, s.context));
      if (session.current !== s) return;
      changeMany([["tf_upright", mode], ...baseOf(r), ["tf_gn", 0],
                  ["tf_vertical", 0], ["tf_horizontal", 0], ["tf_rotate", 0]], `Upright ${UPRIGHT_MODES[mode]}`);
    } catch (e) {
      if (session.current === s) setUprightNote(String(e));
    } finally {
      busyUpright(false);
    }
  };

  // the crop tool's Auto, as Lightroom's: Upright's Level fit, kept in
  // Rotate alone, so the Upright section stays Off
  const [autoAngleNote, setAutoAngleNote] = useState<string | null>(null);
  const runAutoStraighten = async () => {
    const s = session.current;
    if (!s || uprightBusyRef.current || (s.values.tf_upright ?? 0) !== 0) return;
    setAutoAngleNote(null);
    busyUpright(true);
    try {
      await s.settled();
      if (session.current !== s) return;
      const r = await commands.upright("level", null, uprightAspect(s.values, s.context));
      if (session.current !== s) return;
      const c = controlById.get("tf_rotate")!;
      const to = Math.round(Math.min(c.max, Math.max(c.min, rotateOf(r.rotation, s.values.tf_base_r ?? 0, s.context)))
                            / c.step) * c.step;
      if (to !== (s.values.tf_rotate ?? 0)) changeMany([["tf_rotate", to]], "Auto Straighten");
    } catch (e) {
      if (session.current === s) setAutoAngleNote(String(e));
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
        base = baseOf(await commands.upright("guided", next.flat(), uprightAspect(s.values, s.context)));
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
      const p = await commands.points(shown, "input") as number[];
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
      const p = await commands.points(g.flat(), "shown") as number[];
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
      const m = await commands.meta(s.imgid)
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
      const changed = perf.time("pixels.canvasUpload", () => canvasFrames.draw(bc, f, canvas.current));
      if (changed) invalidateClip("base");
      if (clipRef.current.low || clipRef.current.high) paintClip("base", f);
      baseMeta.current = placed(f);
      if (changed) setBaseTick((t) => t + 1);
    }
    full.current = { w: f.fullWidth, h: f.fullHeight };
    if (!viewZ.current) viewZ.current = fitScale();
    placeLayers();
    navigatorUpdates.submit({ frame: f, owner: session.current }, false);
    updateHistogram(f);
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

  // the Print panel's page shows the whole photo in its place: no zoom
  const printViewRef = useRef(false);
  const animateTo = (z: Zoom, anchor: Anchor | null = null, settleDelay = 0, ahead = true) => {
    if (printViewRef.current && z !== "fit") return;
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

  // Refreshes must not restore thumbnails while their Trash job runs.
  const pendingDeletes = useRef(new Set<(image: ImageEntry) => boolean>());
  const updateImages = (next: ImageEntry[]) => {
    next = next.filter((image) => ![...pendingDeletes.current].some((gone) => gone(image)));
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
      const v = settings.get(`immage.${id}.open`);
      return id === "folders" || id === "immich" ? v !== "0" : v === "1";
    } catch { return id === "folders" || id === "immich"; }
  })));
  // focus mode and ⌥ as for the right panel's panels (togglePanel)
  const toggleLeft = (id: LeftCard, alt = false) => setLeftOpen((old) => {
    const solo = focusMode ? !alt && !old.has(id) : alt;
    let next: Set<LeftCard>;
    if (solo) next = new Set(old.has(id) && old.size === 1 ? [] : [id]);
    else { next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); }
    try { for (const c of LEFT_CARDS) settings.set(`immage.${c}.open`, next.has(c) ? "1" : "0"); } catch { /* not kept */ }
    return next;
  });
  const foldersOpen = leftOpen.has("folders");
  // Lightroom's Include Photos from Subfolders, for every folder shown
  const [includeSub, setIncludeSub] = useState(loadIncludeSubfolders);
  const includeSubRef = useRef(includeSub);
  includeSubRef.current = includeSub;
  // a folder's photos, shown batch by batch as they are read. `again` reads
  // the open folder anew (Refresh): its thumbnails stay, and the list is
  // swapped whole at the end rather than shrinking and growing back.
  // `seen` has the photos listed so far, after each batch. null when the
  // folder could not be read
  const shownGen = useRef(0);
  const showFolder = async (dir: string, again = false,
                            seen?: (got: ImageEntry[]) => void): Promise<ImageEntry[] | null> => {
    setImmich(null);
    immichToken.current++;
    setFolder(dir);
    saveLibrary({ current: dir });
    if (!again) {
      shownGen.current++;
      loader.current!.clear();
      // a new folder starts unfiltered: one left on Rejected only looked empty
      setFilter(NO_FILTER);
      // the last folder's photos go at once: listing a folder on a network
      // share can take seconds before its first batch
      updateImages([]);
    }
    let got: ImageEntry[] = [];
    let files: string[] = [];
    let listed = false;
    let known: Known[] = [];
    try {
      setReading({ done: 0, total: 0, files, listed, known });
      const list = await openFolder(dir, includeSubRef.current, [...hiddenRef.current], (batch, done, total, all, last) => {
        // an Immich search took the filmstrip while this was read
        if (immichRef.current) return;
        // a refresh's photos are on show already
        if (last && !again) {
          known = last;
          loader.current!.request(byCaptureTime(known).map(knownKey));
        }
        if (all) {
          files = all;
          listed = true;
        }
        got = byCaptureTime([...got, ...batch]);
        if (!again && batch.length) { updateImages(got); seen?.(got); }
        loader.current!.request(batch.map((i) => i.imgid));
        setReading({ done, total, files: again ? [] : files, listed, known });
      });
      if (immichRef.current) return list;
      setReading(null);
      const sorted = byCaptureTime(list);
      updateImages(sorted);
      setStatus(`${list.length} images`);
      if (!again) saveLibrary({ recent: [dir, ...(loadLibrary().recent ?? []).filter((d) => d !== dir)].slice(0, 10) });
      return sorted;
    } catch (e) {
      // another folder was opened meanwhile, and shows its own progress
      if (String(e) === "superseded") return [];
      setReading(null);
      if (String(e).startsWith("Reading photos timed out")) {
        setStatus(`error: ${e}`);
      } else if (!(await commands.pathExists(dir))) {
        updateImages([]);
        setFolderRefresh((n) => n + 1);
        setStatus(`folder not found: ${dir}. it was moved or deleted outside Immage`);
      } else setStatus(`error: ${e}`);
      return null;
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
      const m = await commands.meta(s.imgid).then((x) => x.image).catch(() => null);
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

  const importImmichParent = (path: string) => {
    const dir = parentDir(path);
    window.clearTimeout(immichTimer.current);
    addPathToLibrary(dir);
    setLeftOpen((old) => new Set([...old, "folders"]));
    try { settings.set("immage.folders.open", "1"); } catch { /* not kept */ }
    setLayout((old) => ({ ...old, left: true }));
    setGrid(true);
    void showFolder(dir);
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
      const photo = list?.find((i) => i.path === first) ?? list?.[0];
      if (photo) void openFile(photo.path);
    });
  };

  // a photo handed over from outside (the command line, or macOS's open
  // and Finder): its folder is shown and kept in the list, and it opens
  const openLaunched = async (path: string) => {
    const dir = parentDir(path);
    addPathToLibrary(dir);
    const list = await showFolder(dir);
    if (!list) return;
    if (list.some((i) => i.path === path)) await openFile(path);
    else setStatus(`not a photo Immage can open: ${path}`);
  };

  // files dragged onto the window from Finder or Explorer: folders join the
  // library and the first shows as a grid; otherwise the first photo opens,
  // as one handed over does. the import screen is left alone
  const [dropping, setDropping] = useState(false);
  const dropped = async (paths: string[]) => {
    const kinds = await Promise.all(paths.map((path) => commands.pathKind(path)));
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

  addFolderRef.current = addFolder;

  // the application menus: a drawn strip on Windows and Linux, the native
  // menu bar on macOS; both run the same actions as the keys
  const runMenuAction = useCallback((id: ActionId) => {
    if (pastingRef.current) return;
    const el = document.activeElement as HTMLInputElement | null;
    if (fieldKeeps(el, "a")) {
      const editing = ["undo", "redo", "select-all", "cut", "copy", "paste"];
      if (editing.includes(id)) {
        if (id === "undo") document.execCommand("undo");
        else if (id === "redo") document.execCommand("redo");
        else if (id === "select-all") el?.select?.();
        else menuActionsRef.current[id]?.();
        return;
      }
    }
    if (document.querySelector(".modal-backdrop") && id !== "quit" && id !== "about" && id !== "user-guide") return;
    if (importOpenRef.current && !["preferences", "shortcuts", "quit", "about", "user-guide"].includes(id)) return;
    const last = lastKeyActionRef.current;
    if (last && last.id === id && performance.now() - last.t < 150) return;
    menuActionsRef.current[id]?.();
  }, []);
  useEffect(() => {
    if (!IS_MAC) return;
    void commands.menuSet(nativeSpec(MENUS)).catch(() => {});
    const off = listen<string>("menu", (e) => runMenuAction(e.payload as ActionId));
    return () => { void off.then((f) => f()); };
  }, [runMenuAction]);

  // the engine's supervision (Rust's engine-state): a wait past its deadline
  // offers Wait and Restart; a restart gives a new engine with an empty
  // library, so the page reads the folder, the soft proof, the open photo and
  // the Before view into it again, in that order. the undo history is lost
  const engine = useRef<EngineState>(ENGINE_START);
  const [engineNotice, setEngineNotice] = useState<EngineNotice>(null);
  // the last background save's failure, until a save works
  const [saveError, setSaveError] = useState<string | null>(null);
  // what the page had open when the engine went down, until a restore is done
  const lost = useRef<{ path: string | null; copy: number | null; before: boolean; proof: Proof;
                        folder: string | null; search: ImmichSearch | null; filter: Filter } | null>(null);
  const restoreGen = useRef(0);
  const engineEventRef = useRef<(e: EngineEvent) => void>(() => {});
  engineEventRef.current = (e) => {
    const now = Date.now();
    if (e.state === "down") {
      quietUntil.current = Infinity;
      const cur = currentRef.current;
      lost.current ??= {
        path: cur?.path ?? null,
        copy: cur && imagesRef.current.find((i) => isOpen(i, cur))?.copy ? imagesRef.current.find((i) => isOpen(i, cur))?.version ?? null : null,
        before: beforeRef.current, proof: proofRef.current, folder: folderRef.current, search: immichRef.current?.search ?? null, filter,
      };
      // nothing more goes to an engine that is gone
      session.current?.abandon();
      restoreGen.current++;
      setStatusRaw("Restarting the engine…");
    }
    if (e.state === "failed") quietUntil.current = 0;
    const r = engineStep(engine.current, e, now);
    engine.current = r.state;
    setEngineNotice(r.state.notice);
    if (r.restore) void restoreEngine();
  };
  const restoreEngine = async () => {
    const gen = ++restoreGen.current;
    const l = lost.current;
    // a newer death or restart took over
    const stale = () => gen !== restoreGen.current;
    if (!l) { quietUntil.current = performance.now() + 3000; return; }
    setStatusRaw("Restarting the engine…");
    // every image id the page holds is of the old library
    setSelection(new Set());
    setCompare(null);
    try {
      if (l.search) await searchImmich(l.search);
      else if (l.folder) {
        await showFolder(l.folder);
        // a new folder starts unfiltered; this is the same one, read again
        setFilter(l.filter);
      }
      if (stale()) return;
      if (l.proof.mode !== "off") {
        await applyProof(l.proof);
        if (stale()) return;
        setProofApplied(`${l.proof.mode}|${l.proof.profile}|${l.proof.intent}`);
      }
      const plan = reopenPlan(engine.current, l.path);
      let reopened = false;
      if (plan.reopen) {
        engine.current = reopening(engine.current, plan.reopen, Date.now());
        // the photo is not open in this engine, though the page still shows it
        currentRef.current = null;
        const copy = l.copy;
        const id = copy === null ? null
          : imagesRef.current.find((i) => i.path === plan.reopen && i.version === copy)?.imgid ?? null;
        reopened = await openFile(plan.reopen, id);
        if (stale()) return;
        if (reopened && l.before) setBefore(true);
      } else if (plan.refused) {
        await closePhoto();
        setStatusRaw(`The engine stopped again while opening ${baseName(plan.refused)}. It was not reopened.`);
      }
      if (plan.reopen) {
        if (reopened) setStatusRaw("The engine restarted. The photo was reopened from its last save; undo history was cleared.");
      } else if (!plan.refused) setStatusRaw("The engine restarted.");
    } catch (e) {
      if (stale()) return;
      setStatusRaw(`The engine restarted, but the library could not be read again: ${e}`);
    }
    lost.current = null;
    quietUntil.current = performance.now() + 3000;
  };
  useEffect(() => {
    const off = listen<EngineEvent>("engine-state", (e) => engineEventRef.current(e.payload));
    return () => { void off.then((f) => f()); };
  }, []);
  const hideEngineNotice = () => {
    engine.current = engineWait(engine.current);
    setEngineNotice(engine.current.notice);
  };

  // at start, a photo or folder handed over, or else the folder and image
  // open when the app last closed; later, one handed to the running app.
  // both go the way a drop does: a folder shows as a grid
  // the computer is short of memory (memory_budget.rs): let go of the views
  // already shown and the thumbnails off screen, keeping what is on show
  useEffect(() => {
    const off = listen("memory-pressure", () => {
      session.current?.trimFrames();
      loader.current?.release();
    });
    return () => { void off.then((f) => f()); };
  }, []);

  const started = useRef(false);
  useEffect(() => {
    const off = listen("launch-file", async () => {
      const path = await commands.launchFile();
      if (path) void droppedRef.current([path]);
    });
    // once: React's development mode runs effects twice, which listed the
    // folder twice while the engine was still starting
    if (started.current) return () => { void off.then((f) => f()); };
    started.current = true;
    void commands.launchFile().then((path) => {
      if (path) { void droppedRef.current([path]); return; }
      const lib = loadLibrary();
      // the very first start: a sample photo, so there is something to edit
      // and the quick start has something to point at. once only, so a
      // removed sample stays removed
      if (!lib.folders.length && !lib.sampled) {
        saveLibrary({ sampled: true });
        void commands.sampleFolder().then((dir) => {
          addPathToLibrary(dir);
          return showFolder(dir);
        }).then((list) => { if (list?.[0]) void openFile(list[0].path); })
          .catch((e) => setStatus(`sample photo: ${e}`));
        return;
      }
      void restoreLast(lib);
    });
    return () => { void off.then((f) => f()); };
  }, []);
  // the folder and photo open when the app last closed, as they were left:
  // in the grid, or the photo in the editor, opened once its folder lists
  // it rather than after the whole folder. a photo that does not open
  // leaves its folder's grid, and a folder that cannot be read the grid of
  // the last one read that can, rather than an empty viewer
  const restoreLast = async (lib: Library) => {
    const dirs = [...new Set([lib.current, ...(lib.recent ?? []), ...lib.folders])].filter((d): d is string => !!d);
    for (const dir of dirs) {
      const want = dir === lib.current && !lib.grid ? lib.image : null;
      const pick = (list: ImageEntry[]) => list.find((i) => i.path === want && (i.version ?? 0) === (lib.version ?? 0))
        ?? list.find((i) => i.path === want && !i.copy);
      const opened: { p: Promise<boolean> | null } = { p: null };
      const tryOpen = (list: ImageEntry[]) => {
        // not over a photo picked while the folder is read
        const last = want && !opened.p && !currentRef.current ? pick(list) : undefined;
        if (last) opened.p = openFile(last.path, last.imgid);
      };
      const shown = showFolder(dir, false, tryOpen);
      const gen = shownGen.current;
      const list = await shown;
      // another folder or photo was opened meanwhile, and stays
      if (shownGen.current !== gen) return;
      if (!list) continue;
      tryOpen(list);
      if (opened.p && await opened.p) return;
      if (lib.current && dir !== lib.current) setStatus(`could not read ${lib.current}; showing ${dir}`);
      if (!currentRef.current && !gridRef.current) {
        autoGrid.current = true;
        setGrid(true);
      }
      return;
    }
  };
  // the grid or the editor, for the next start; not the grid a photo that
  // did not open there left, so the next start tries it again
  const autoGrid = useRef(false);
  const lastGrid = useRef(grid);
  useEffect(() => {
    if (lastGrid.current === grid) return;
    lastGrid.current = grid;
    if (autoGrid.current) autoGrid.current = false;
    else saveLibrary({ grid });
  }, [grid]);

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
  // last clicked (else the open) photo to it; neither opens anything
  // the last cell clicked is the run's start, since the open photo only
  // follows once its open finishes and a quick second click would find it stale
  const pickAnchor = useRef<number | null>(null);
  const pickPhoto = (i: ImageEntry, e: React.MouseEvent) => {
    const from = e.shiftKey && !cmd(e) ? (pickAnchor.current ?? listedEntry?.imgid ?? null) : null;
    if (!(from !== null && shownRef.current.some((x) => x.imgid === from))) pickAnchor.current = i.imgid;
    if (cmd(e)) {
      setSelection((old) => {
        const next = new Set(old.size ? old : listedEntry ? [listedEntry.imgid] : []);
        if (next.has(i.imgid)) next.delete(i.imgid); else next.add(i.imgid);
        return next;
      });
      return;
    }
    if (from !== null) {
      const list = shownRef.current;
      const a = list.findIndex((x) => x.imgid === from), b = list.findIndex((x) => x.imgid === i.imgid);
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
      await commands.metaSet(imgid, fields as { [key in string]: Value });
    } catch (e) {
      setStatus(`error: ${e}`);
    }
  };

  // Hide confirmed deletions immediately while the Trash job runs. The
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
    const dir = folderRef.current;
    pendingDeletes.current.add(gone);
    updateImages(imagesRef.current);
    try {
      if (cur && gone(cur)) {
        const shownNow = shownRef.current, at = shownNow.findIndex((i) => isOpen(i));
        const next = [...shownNow.slice(at + 1), ...shownNow.slice(0, Math.max(0, at)).reverse()]
          .find((i) => !gone(i));
        if (next) {
          if (!await openFile(next.path, next.imgid)) throw new Error("could not leave the open photo");
        } else await closePhoto();
      }
      await commands.trashFiles(list.map((i) => i.imgid));
      setStatus(`moved ${n === 1 ? list[0].filename : `${n} photos`} to the ${TRASH}`);
    } catch (e) {
      // Re-read disk: a failed batch may already have moved some files.
      pendingDeletes.current.delete(gone);
      if (dir && folderRef.current === dir && !immichRef.current) await showFolder(dir, true);
      setStatus(`delete: ${e}`);
    } finally {
      pendingDeletes.current.delete(gone);
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
        const copy = await commands.createVirtualCopy(src.imgid);
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
        const trashed = await commands.removeVirtualCopy(c.imgid);
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
    resetCanvases();
    for (const c of [canvas.current, baseCanvas.current, navThumb.current, clipBase.current, clipSharp.current]) if (c) c.width = 0;
  };

  // Edit In: photos handed to another application (plugins.ts), which is
  // then watched for the files it saves (plugins.rs). each comes back beside
  // its photo, and the first of a hand-off opens
  const [plugins, setPluginsState] = useState<PluginConfig[]>([]);
  useEffect(() => { void loadPlugins().then(setPluginsState); }, []);
  const setPlugins = (list: PluginConfig[]) => { setPluginsState(list); void storePlugins(list); };
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
          const r = await track(commands.exportImages(Date.now(),
            [{ imgid: t.imgid, stem: `${baseName(path).replace(/\.[^.]+$/, "")}-Edit` }],
            { dir: parentDir(path), format: "tiff", bpp: 16, colorSpace: "prophoto", conflict: "unique" }));
          if (r.failed.length) throw new Error(r.failed[0].error);
          send.push(...r.written);
        }
      }
      const token = Date.now();
      if (kind.handoff === "macrostudio") {
        // a TIFF names its photo, so the stack is named and placed from it
        const tiffs = send !== originals;
        await commands.pluginJob({
          token, plugin: cfg.id, mode: tiffs ? "rendered" : "original-raw",
          files: send.map((path, i) => ({ path, origin_path: tiffs ? originals[i] : null })),
          look: cfg.look || null,
        });
        setWaiting((w) => [...w, { token, name: cfg.name, back: 0, total: 1, opened: false }]);
        setStatus(`sent ${send.length} photos to ${cfg.name}`);
        return;
      }
      await commands.pluginWatch({
        token, plugin: cfg.id, sources: originals, exts: kind.returns.exts, match: kind.returns.match,
        subfolders: kind.returns.subfolders, outputDir: cfg.outputDir || null, ignore: send.filter((p) => !originals.includes(p)),
      });
      setWaiting((w) => [...w, { token, name: cfg.name, back: 0,
                                 total: kind.returns.match === "any" ? 1 : originals.length, opened: false }]);
      try {
        await commands.pluginLaunch(cfg.id, send);
      } catch (e) {
        void commands.pluginCancel(token);
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
    // Claim the first result before awaiting the folder refresh or another return.
    waitingRef.current = waitingRef.current.map((x) =>
      x.token === r.token ? { ...x, back: x.back + 1, opened: true } : x);
    setWaiting(waitingRef.current);
    if (folderRef.current && !immichRef.current && imagesRef.current.some((i) => i.path === r.original))
      await showFolder(folderRef.current, true);
    void runInBackground(`${w?.name ?? "Plugin"}: result`, async () => r, () => ({
      text: `${w?.name ?? "Plugin"}: ${baseName(r.result)} is back`, ok: true,
      action: generatedAction(r.result, undefined, !!w && !w.opened),
    }), "Plugin result");
  };
  useEffect(() => {
    const offs = [
      listen<PluginReturn & { token: number }>("plugin-returned", (e) => pluginReturned.current(e.payload)),
      listen<{ token: number; reason: string; message?: string }>("plugin-watch-end", (e) => {
        const w = waitingRef.current.find((x) => x.token === e.payload.token);
        setWaiting((all) => all.filter((x) => x.token !== e.payload.token));
        if (!w) return;
        const { reason, message } = e.payload;
        // Macro Studio's job (plugins.rs, plugin_job): a stack saved after
        // the wait ends still comes back, the next time its folder is read
        const later = "a stack saved there later still comes back";
        if (reason === "timeout")
          setStatus(`${w.name}: stopped waiting after 3 hours; ${w.back} of ${w.total} came back`);
        else if (reason === "startup") setStatus(`${w.name} did not start, or never took the photos`);
        else if (reason === "stalled") setStatus(`${w.name} stopped responding; ${later}`);
        else if (reason === "stopped") setStatus(`${w.name}: ${message || "stopped"}`);
        else if (reason === "error" || reason === "protocol") setStatus(`${w.name}: ${message || "failed"}`);
        else if (reason === "done" && !w.back) setStatus(`${w.name}: nothing was saved`);
      }),
    ];
    return () => { for (const off of offs) void off.then((f) => f()); };
  }, []);

  // the photos the arrow keys would open next, their raws decoded ahead by
  // the engine once this one is up (main.c, _prefetch): a compressed raw's
  // decode, some 300 ms, is then gone from opening them. Preferences' Read
  // ahead says how many, in the direction last stepped and then behind
  const stepDir = useRef<1 | -1>(1);
  const prefetched = useRef("");
  const prefetchNext = (s: Session) => {
    const list = shownRef.current, at = list.findIndex((i) => i.imgid === s.imgid);
    if (at < 0) return;
    const { count, both } = loadReadAhead();
    const ids: number[] = [];
    for (const dir of both ? [stepDir.current, -stepDir.current] : [stepDir.current]) {
      for (let k = 1; k <= count; k++) {
        const e = list[at + dir * k];
        if (e && !isRemote(e)) ids.push(e.imgid);
      }
    }
    if (ids.join() === prefetched.current) return;
    prefetched.current = ids.join();
    commands.prefetch(ids).catch(() => {});
  };

  // `imgid` picks one of the file's versions (a virtual copy); without it,
  // the original. false when it did not open
  const openFile = async (path: string, imgid: number | null = null, reload = false): Promise<boolean> => {
    if (pastingRef.current && !reload) return false;
    const id = imgid ?? imagesRef.current.find((i) => i.path === path && !i.copy)?.imgid ?? null;
    const cur = currentRef.current;
    if (!reload && session.current && cur && cur.path === path && (id === null || cur.imgid === id)) return true;
    if (!(await commands.pathExists(path))) {
      setStatus(`file not found: ${baseName(path)}. it was moved or deleted outside Immage`);
      if (folderRef.current && !immichRef.current) void showFolder(folderRef.current, true);
      return false;
    }
    try {
      if (session.current) {
        const o = session.current;
        previous.current = { values: { ...o.values }, look: { name: o.look, path: o.lookPath, amount: o.lookAmount },
                             masks: structuredClone(o.masks) };
        await o.close();
      }
      setLoupeShown(false);
      if (loupeCanvas.current) loupeCanvas.current.style.display = "none";
      setStatus("opening…");
      const opening = { path, imgid: id };
      setCurrent(opening);
      currentRef.current = opening;
      // masks, heal and zones belong to the last photo, so a new one opens on
      // the adjustments; presets stay, for applying one photo after another
      setRightMode((m) => (m === "presets" ? m : "adjust"));
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
      resetCanvases();
      baseStale.current = true;
      for (const c of [baseCanvas.current, clipBase.current, copyCanvas.current, clipSharp.current]) if (c) c.width = 0;
      // the photo's filmstrip thumbnail, fitted, until its first frame takes
      // its place, rather than the last photo
      const thumb = id !== null ? loader.current?.get(id) : undefined, sc = canvas.current;
      if (thumb?.width && sc) {
        const dpr = window.devicePixelRatio || 1, { w, h } = viewport(), m = 2 * MARGIN * dpr;
        const z = Math.min((w - m) / thumb.width, (h - m) / thumb.height);
        sc.width = thumb.width;
        sc.height = thumb.height;
        sc.getContext("2d")!.drawImage(thumb, 0, 0);
        placeCanvas(sc, thumb.width, thumb.height,
          { x: (w - z * thumb.width) / 2, y: (h - z * thumb.height) / 2, k: z }, dpr);
      }
      const s = await timeTunerWork("Photo open", () => track(Session.open(path, id, currentView, drawFrame, (e) => setStatus(`error: ${e}`))));
      // the engine's id, for a photo opened by its file alone
      const opened = { path, imgid: s.imgid };
      setCurrent(opened);
      currentRef.current = opened;
      const entry = imagesRef.current.find((i) => isOpen(i, opened))
        ?? (await commands.meta(s.imgid)).image;
      setOpenCell(entry);
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
        const bitmapWork = perf.begin("copy.bitmap", { ...f.trace?.diagnostic });
        void createImageBitmap(new ImageData(f.pixels, f.width, f.height)).then((bmp) => {
          perf.finish(bitmapWork);
          if (session.current !== s || gen !== copyGen.current || !cc) {
            bmp.close(); perf.discard(f.trace, "copy-bitmap-obsolete"); return;
          }
          perf.drawStart(f.trace);
          try {
            cc.width = f.width;
            cc.height = f.height;
            cc.getContext("2d")!.drawImage(bmp, 0, 0);
            copyMeta.current = placed(f);
            placeLayers();
            setCopyOn(true);
          } finally { bmp.close(); perf.drawEnd(); }
        }).catch(() => {
          perf.finish(bitmapWork, "failed"); perf.discard(f.trace, "copy-bitmap-failed");
        });
      };
      s.thumbSize = baseSize;
      s.previewMode = loadPreview;
      // at fit, the settled frame's own size: detail modules are scale
      // dependent, and a viewer-sized draft looks softer than the 3072-pixel
      // frame that replaces it
      s.exactView = () => {
        const a = anim.current;
        const zoom = a.raf && a.end ? a.zoom : zoomRef.current;
        return zoom === "fit" || !full.current ? settledFit() : viewAt(fullDraftK(), true);
      };
      s.detailView = () => {
        if (gridRef.current || !loupeEnabledRef.current || beforeRef.current || baModeRef.current !== "off" || !full.current) return null;
        const f = full.current;
        const side = 160;
        const width = Math.min(side, f.w), height = Math.min(side, f.h);
        const pos = loupePositionRef.current;
        return { width, height, scale: 1,
          x: Math.round(Math.max(0, Math.min(f.w - width, pos.x * f.w - width / 2))),
          y: Math.round(Math.max(0, Math.min(f.h - height, pos.y * f.h - height / 2))) };
      };
      s.frameBudget = () => loadFrameCacheMb() * 1048576;
      s.draftSize = () => ({ ...viewAt(draftK(), true), draft: true });
      s.draftLimits = () => ({ target: loadDraftTarget(), smallest: loadBalancedPreviewSize() === 1 ? 1 : loadDraftSmallest() });
      s.warmDrafts();
      // a saved edit makes the filmstrip's thumbnail stale; undone back to
      // where it started, the photo reads unedited again
      s.onSaved = (edited) => {
        setSaveError(null);
        loader.current!.invalidate(s.imgid);
        patchImage(s.imgid, { edited });
        void syncEditedKeywords(s.imgid, edited);
        if (edited) void fillEditedMeta(s.imgid);
      };
      // kept on screen until a save works: the status line is cleared by the
      // next frame painted, which follows a failed save within a second
      s.onSaveError = (e) => {
        if (session.current !== s) return;
        const why = e.replace(/^error:\s*/i, "");
        setSaveError(why.charAt(0).toUpperCase() + why.slice(1));
      };
      s.onShapes = () => { syncMasks(); syncSpots(); };
      // a module the History panel changed: its sliders, if it has any
      s.onModules = () => {
        if (session.current !== s) return;
        setValues({ ...s.values });
        setHistoryRev((n) => n + 1);
      };
      if (reload && pasteUndoSession.current) s.inheritUndo(pasteUndoSession.current);
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
      if (!reload) {
        discardPastes([...undo.current.past, ...undo.current.future]);
        undo.current = { past: [], future: [], key: "", at: 0 };
      }
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
      // a file back from Edit In, AI Denoise or Panorama Merge
      const back = returns.current.get(path);
      // a panorama's DNG takes a raw's defaults, as its frames would: to
      // darktable it is a demosaiced raw (sraw), which the engine does not
      // call raw, as it has no mosaic for capture sharpening or hot pixels
      const pano = back?.plugin === "panorama" && !back.applied && !s.wasEdited;
      // and so does a stack Macro Studio made from raws
      const backCfg = back && plugins.find((p) => p.id === back.plugin);
      const stacked = !!back && !back.applied && !s.wasEdited && /\.dng$/i.test(path)
        && !!kindOf(back.plugin.split(":")[0])?.linearDng && backCfg?.send !== "tiff";
      const raw = s.raw || pano || stacked;
      if (!s.wasEdited && s.values.tm_mode !== 1) {
        s.setMany([["tm_mode", 1]]);
        base.push({ op: "tonemapper", name: "agx", label: "tone mapper", enabled: true });
      }
      // and a raw with the profile chosen in Preferences
      const profile = loadNewPhotosProfile();
      if (!s.wasEdited && raw && profile !== 0 && s.values.profile !== profile) {
        s.setMany(Object.entries(profileSelection(profile)));
        base.push({ op: "profile", name: profileLabel(profile).toLowerCase(),
                    label: "profile", enabled: true });
      }
      // and a raw with Preferences' exposure compensation, on an instance of
      // its own (exp_comp), so Exposure still reads 0 and adds to it
      const comp = loadExposureCompNew();
      if (!s.wasEdited && raw && comp) {
        s.setMany([["exp_comp", comp]]);
        base.push({ op: "exposure", name: "exposure",
                    label: `compensation ${comp > 0 ? "+" : ""}${comp.toFixed(2)} EV`, enabled: true });
      }
      // a raw starts without capture sharpening or noise reduction, which
      // the AgX workflow adds only where a photo needs it; the preset below
      // may set them
      // a file back from Edit In starts without what its application did
      // already (Lens Corrections after PureRAW), over the preset's values
      // so they are never turned on to be turned off; a panorama, without
      // the lens corrections its frames had
      // a DNG from AI Denoise has the raw's edit, so it is edited already
      const denoised = back?.plugin === "ai-denoise" && !back.applied;
      const plugin = pano ? { values: { lens_profile: 0, lens_ca: 0 }, labels: [] }
        : !denoised && !s.wasEdited && back && !back.applied
        ? returnValues(back.plugin.split(":")[0], plugins.find((p) => p.id === back.plugin)) : null;
      const presetVals = preset && (raw || !preset.rawOnly)
        ? newPhotoPresetValues(presetValues(preset), raw, loadNewPhotosNonRaw()) : null;
      if (preset && presetVals) {
        s.setMany(Object.entries({ ...presetVals, ...plugin?.values }));
        setStatus(`new photo: applied "${preset.name}"`);
        base.push({ op: "preset", name: preset.name, label: "new photos preset", enabled: true });
      } else if (plugin && Object.keys(plugin.values).length) {
        s.setMany(Object.entries(plugin.values));
      }
      if (back && plugin) {
        back.applied = true;
        void commands.pluginReturnApplied(path);
        if (plugin.labels.length) {
          const name = kindOf(back.plugin.split(":")[0])?.label ?? "plugin";
          base.push({ op: "plugin", name, label: `${name}: ${plugin.labels.join(", ")} off`, enabled: true });
        }
      }
      // and Auto, when Preferences asks for it, once the photo has rendered
      const autoNew = !s.wasEdited && raw && loadAutoToneNew();
      if (autoNew) base.push({ op: "autotone", name: "auto tone", label: "auto tone", enabled: true });
      setHistoryBase(base);
      setValues({ ...s.values });
      if (autoNew) void runAutoTone(true);
      // and without the noise reduction its model did, the first time it
      // opens, as an undo step
      if (back && denoised && session.current === s) {
        back.applied = true;
        void commands.pluginReturnApplied(path);
        changeMany([["nr_luminance", 0], ["nr_color", 0]], "AI Denoise: noise reduction off");
      }
      return true;
    } catch (e) {
      setStatus(`error: ${e}`);
      return false;
    }
  };

  // undo and redo: the edit before each change, sliders, masks and look
  // alike. a run of changes to the same thing (a slider drag, a curve or
  // shape drag, the white balance picker settling) is one step
  // `label` names the change that follows the state, for the History panel
  type Snap = { values: Values; masks: Mask[]; spots: Spot[]; look: { name: string | null; path: string | null };
                lookAmount: number; label: string;
                // the History panel's switched instances, and those deleted
                modules: Map<string, ModuleState>; deleted: Set<string>; batch?: { token: number; recovery: boolean } };
  const snapshot = (s: Session, label = ""): Snap => ({
    values: { ...s.values }, masks: structuredClone(s.masks), spots: structuredClone(s.spots),
    look: { name: s.look, path: s.lookPath }, lookAmount: s.lookAmount, label,
    modules: new Map(s.moduleStates), deleted: new Set(s.deleted),
  });
  const undo = useRef<{ past: Snap[]; future: Snap[]; key: string; at: number }>(
    { past: [], future: [], key: "", at: 0 });
  // set while one step makes several changes (Reset all), so they record once
  const discardPastes = (steps: Snap[]) => {
    for (const token of new Set(steps.flatMap(s => s.batch ? [s.batch.token] : [])))
      void commands.pasteBatch("release", token, null).catch(() => {});
  };
  const holdRecord = useRef(false);
  // the History panel follows the stack, which is kept outside React
  const [historyRev, setHistoryRev] = useState(0);
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
      if (u.past.length > 200) discardPastes(u.past.splice(0, 1));
    }
    if (step || u.future.length) setHistoryRev((n) => n + 1);
    u.key = key;
    u.at = now;
    discardPastes(u.future);
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
  // an undo or redo in the crop tool, whose guide stays its own until
  // Done: a turn undone turns the guide back, keeping how it was dragged;
  // a crop undone puts back the guide and aspect it had
  const followCrop = (was: Values, now: Values) => {
    const rectOf = (v: Values) => ({ l: v.crop_l ?? 0, t: v.crop_t ?? 0, r: v.crop_r ?? 1, b: v.crop_b ?? 1 });
    const path = turnPath(was.orient ?? 0, now.orient ?? 0);
    const carried = path.reduce(turnRect, rectOf(was)), to = rectOf(now);
    const quarter = path.filter((h) => h === "cw" || h === "ccw").length % 2 === 1;
    if ((["l", "t", "r", "b"] as const).every((e) => Math.abs(carried[e] - to[e]) < 1e-6)
        && (was.crop_rd ?? 0) === (now.crop_rd ?? 0) && (was.crop_rn ?? 0) === (now.crop_rn ?? 0)) {
      if (!path.length) return;
      setCropRect((r) => path.reduce(turnRect, r));
      if (quarter) setCropPortrait((p) => !p);
      return;
    }
    loadCrop(now);
    const f = frameSize();
    setCropPortrait((to.b - to.t) * f.h > (to.r - to.l) * f.w);
  };
  // the image's masks made these: only what differs is sent
  const setMasksTo = (target: Mask[]) => {
    const s = session.current;
    if (!s) return;
    replaceMasks(s, target);
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
  const pasteSaved = (i: PasteUpdate) => {
    loader.current?.invalidate(i.imgid);
    patchImage(i.imgid, { edited: i.edited });
    void syncEditedKeywords(i.imgid, i.edited);
    if (i.edited) void fillEditedMeta(i.imgid);
  };
  const pauseForPaste = async () => {
    window.clearTimeout(baseTimer.current);
    window.clearTimeout(copyTimer.current);
    leaveBefore();
    setBaMode("off");
    setAmount(null);
    await session.current?.close();
    pasteUndoSession.current = session.current;
    session.current = null;
  };
  const pasteSettings = async (previousClip?: Clip) => {
    const c = previousClip ?? clip.current, active = currentRef.current;
    if (!c || !active || !session.current || croppingRef.current || pastingRef.current || aiBusy) return;
    const entry = imagesRef.current.find(i => isOpen(i, active)) ?? openCell;
    const { targets, skipped } = pasteTargets(imagesRef.current, previousClip ? new Set<number>() : selectionRef.current, entry, isRemote);
    if (!targets.length) { setStatus("paste: no local photos selected"); return; }
    const frozen = structuredClone(c);
    const preset = [...BUILTIN_PRESETS, ...presetsRef.current].find(p => p.id === newPhotosRef.current);
    const defaults = { profile: loadNewPhotosProfile(), compensation: loadExposureCompNew(), auto: loadAutoToneNew(),
      preset: preset ? { values: presetValues(preset), rawOnly: preset.rawOnly, nonRaw: loadNewPhotosNonRaw() } : null };
    const before = snapshot(session.current, `Paste settings on ${targets.length} photo${targets.length === 1 ? "" : "s"}`);
    pastingRef.current = true;
    setPasting("Preparing paste…");
    let message = "";
    try {
      await pauseForPaste();
      const result = await runPaste(targets, frozen,
        (done, total) => setPasting(`Pasting settings: ${done} / ${total}`), pasteSaved, s => preparePastePhoto(s, defaults));
      if (result.token !== null) {
        discardPastes(undo.current.future);
        undo.current.future = [];
        undo.current.key = "";
        before.batch = { token: result.token, recovery: result.recovery };
        undo.current.past.push(before);
        if (undo.current.past.length > 200) discardPastes(undo.current.past.splice(0, 1));
      }
      message = result.error ? `paste: ${result.error}`
        : keys(`settings pasted onto ${targets.length} photo${targets.length === 1 ? "" : "s"}${skipped ? `; ${skipped} remote photo(s) skipped` : ""}: ⌘Z undoes it`);
    } catch (e) { message = `paste: ${e}`; }
    finally {
      // No normal navigation: preserve selection and both undo stacks.
      if (!session.current && !await openFile(active.path, active.imgid, true))
        message += "; could not reopen the active photo";
      pastingRef.current = false;
      setPasting(null);
      setHistoryRev(n => n + 1);
      setStatus(message);
    }
  };
  // Lightroom's Previous: the last photo's settings, the parts Copy Settings
  // has ticked
  const pastePrevious = () => {
    const p = previous.current;
    if (p) void pasteSettings(makeClip(loadCopyGroups(), p.values, p.look, p.masks ?? []));
  };
  // `steps` at once, as a click in the History panel: only the state
  // arrived at is sent
  const stepHistory = async (back: boolean, steps = 1) => {
    if (!session.current || pastingRef.current) return;
    const u = undo.current, from = back ? u.past : u.future, to = back ? u.future : u.past;
    if (!from.length) return;
    leaveBefore();
    for (let k = 0; k < steps && from.length; k++) {
      const s = session.current;
      if (!s) break;
      const target = from[from.length - 1];
      // a paste is undone by reopening the photo, which would end the crop
      if (target.batch && croppingRef.current) {
        setStatus(`finish cropping to ${back ? "undo" : "redo"} the paste`);
        break;
      }
      const at = snapshot(s, target.label);
      if (target.batch) {
        const active = currentRef.current!;
        pastingRef.current = true;
        setPasting(back ? "Undoing paste…" : "Redoing paste…");
        let message = back ? "paste undone" : "paste redone";
        let ok = false;
        try {
          await pauseForPaste();
          const updates = await restorePaste(target.batch.token, target.batch.recovery ? "abort" : back ? "undo" : "redo");
          updates.forEach(pasteSaved);
          const failures = updates.filter(i => i.error);
          if (failures.length) throw Error(`${failures.length} photo(s) could not be restored; Undo/Redo retries`);
          from.pop();
          if (target.batch.recovery) discardPastes([target]);
          else { at.batch = target.batch; to.push(at); }
          ok = true;
        } catch (e) { message = `paste: ${e}`; }
        finally {
          if (!session.current && !await openFile(active.path, active.imgid, true)) message += "; could not reopen the active photo";
          pastingRef.current = false;
          setPasting(null);
          setStatus(message);
        }
        if (!ok) break;
      } else {
        from.pop();
        to.push(at);
        let next = target;
        // Ordinary spans still jump straight to their final state. Native
        // batch edges must be crossed separately, after pending edits settle.
        while (k + 1 < steps && from.length && !from[from.length - 1].batch) {
          const following = from.pop()!;
          to.push({ ...next, label: following.label });
          next = following;
          k++;
        }
        const was = { ...s.values };
        restore(next);
        if (croppingRef.current) followCrop(was, { ...was, ...next.values });
        setStatus(back ? "undo" : "redo");
      }
    }
    u.key = "";
    setHistoryRev(n => n + 1);
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
      discardPastes([...undo.current.past, ...undo.current.future]);
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
    if (h.priority == null || h.fixed || h.masked) return null;
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

  // the Negative panel (NegativePanel.tsx): the box being picked on the
  // photo, the photo area the auto values are read from, and the warning
  // ahead of a first conversion
  const [negPick, setNegPick] = useState<NegPick | null>(null);
  const negPickRef = useRef<NegPick | null>(null);
  negPickRef.current = negPick;
  const [negArea, setNegArea] = useState<[number, number, number, number] | null>(null);
  const [negBusy, setNegBusy] = useState(false);
  const [negNote, setNegNote] = useState<string | null>(null);
  const [negWarning, setNegWarning] = useState(false);
  const [negNoWarn, setNegNoWarn] = useState(false);
  const negView = !!current && layout.right && rightMode === "negative";
  useEffect(() => { setNegPick(null); setNegArea(null); setNegNote(null); }, [current]);
  useEffect(() => { if (!negView) setNegPick(null); }, [negView]);
  // its layer may come without the others, which place it otherwise
  useEffect(() => { if (negView) placeLayers(); }, [negView, negPick, negArea]);   // eslint-disable-line react-hooks/exhaustive-deps
  // the whole frame while a box is picked and read, as the crop tool shows
  // it, so the film border can be reached; the crop otherwise. the crop
  // tool, opened over it, does the same and puts the crop back itself
  const negWhole = negView && (negPick !== null || negBusy);
  useEffect(() => {
    const s = session.current;
    if (!s || !negWhole || cropping) return;
    s.bypass("crop", true);
    return () => { if (!croppingRef.current) s.bypass("crop", false); };
  }, [negWhole, cropping, current]);   // eslint-disable-line react-hooks/exhaustive-deps
  const openNegative = () => {
    const shown = layout.right && rightMode === "negative" && !croppingRef.current;
    if (!shown && session.current && session.current.values.neg_on !== 1 && loadNegWarn()) {
      setNegNoWarn(false);
      setNegWarning(true);
      return;
    }
    showRight("negative");
  };
  // what a box holds at negadoctor's input, once the edits ahead of it are in
  const negSample = async (box: [number, number, number, number]): Promise<Stats> => {
    const s = session.current!;
    let stopped = false;
    while (!s.idle && session.current === s) {
      stopped = s.stopBase() || stopped;
      await new Promise((r) => setTimeout(r, 30));
    }
    try {
      return (await commands.sample((box[0] + box[2]) / 2, (box[1] + box[3]) / 2, box, "negadoctor")).picker!;
    } finally {
      if (stopped) resumeBase();
    }
  };
  // tone mappers from darktable that no slider covers, and modules a
  // conversion turns off (NEG_OFF, SF_OFF) that darktable set beyond their
  // sliders, which the session cannot switch through them
  const offUnmapped = (s: Session, off: Set<string>, unmapped: Set<string>) => {
    const done = new Set<string>();
    for (const h of s.history) {
      const key = instanceKey(h), op = mapOpOf(h);
      if (done.has(key) || h.priority == null || h.masked) continue;
      if (!unmapped.has(h.op) && !(off.has(op) && s.isForeign(op))) continue;
      done.add(key);
      if (s.moduleStates.get(key)?.enabled ?? h.enabled) s.setModuleState(h, { enabled: false });
    }
    setHistoryRev((n) => n + 1);
  };
  // the profiles last chosen in the panel, for a conversion: each only where
  // the photo is still on its default and the profile is still installed
  const negRemembered = async (s: Session): Promise<[string, number][]> => {
    const last = loadNegProfiles();
    if (last.input === undefined && last.working === undefined) return [];
    const available = await colorProfiles().catch(() => null);
    if (!available) return [];
    return (["input", "working"] as const).flatMap((role): [string, number][] => {
      const id = `neg_${role}_profile`, v = last[role];
      return v !== undefined && v !== 0 && s.values[id] === s.neutral[id] && s.values[id] !== v
        && available[role].some(([, p]) => p === v) ? [[id, v]] : [];
    });
  };
  // a box picked for the panel. the first film border converts the photo:
  // the modules a negative turns off go off first, as negadoctor's input is
  // read without them, then the border and the photo area set its params,
  // all one undo step
  const negPicked = async (kind: NegPick, box: [number, number, number, number], swap = false) => {
    const s = session.current;
    setNegPick(null);
    if (!s) return;
    if (kind === "area") setNegArea(box);
    const converting = kind === "border" && s.values.neg_on !== 1;
    // before the conversion the photo area is only kept, for it
    if (!converting && s.values.neg_on !== 1) return;
    // a photo is a film simulation or a converted negative, not both
    if (converting && s.values.sf_on === 1 && !swap) {
      setExclusive({ title: "Convert Negative",
                     body: "Converting the negative turns off this photo's film simulation, which works on a positive.",
                     go: () => void negPicked(kind, box, true) });
      return;
    }
    setNegBusy(true);
    setNegNote(null);
    try {
      if (converting) {
        const film = s.values.neg_film === FILM_BW ? FILM_BW : FILM_COLOR;
        const profiles = await negRemembered(s);
        if (session.current !== s) return;
        changeMany([...(s.values.sf_on === 1 ? sfOffEntries(s) : []), ...profiles,
                    ["neg_on", 1], ...toValues(PRESETS[film]), ...Object.entries(NEG_CHOICES),
                    ...(film === FILM_BW ? [["bw_mode", 1] as [string, number]] : [])], "Negative conversion");
        offUnmapped(s, NEG_OFF, NEG_OFF_UNMAPPED);
      }
      let p = fromValues(s.values);
      if (kind === "border") {
        const border = await negSample(box);
        p = autoArea(autoDmin(p, border), await negSample(negArea ?? NEG_AREA));
      } else if (kind === "area") p = autoArea(p, await negSample(box));
      else p = NEG_AUTO[kind as keyof typeof NEG_AUTO](p, await negSample(box));
      if (session.current !== s) return;
      const entries = toValues(p).filter(([id, v]) => s.values[id] !== v);
      if (converting) quietly(() => changeMany(entries));
      else if (entries.length) changeMany(entries, NEG_PICK_LABELS[kind]);
    } catch (e) {
      setNegNote(`${e}`);
    } finally {
      setNegBusy(false);
    }
  };
  // black and white film is shown in black and white, as Treatment does it
  const negFilm = (v: number) => {
    const s = session.current;
    if (!s || v === s.values.neg_film) return;
    changeMany([["neg_film", v], ["bw_mode", v === FILM_BW ? 1 : 0]], "Film Type");
    if (s.values.neg_on === 1) setNegNote("pick the film border again for this film type");
  };
  const negTurnOff = () => {
    const s = session.current;
    if (!s) return;
    changeMany(negOffEntries(s), "Turn off negative conversion");
  };

  // the Film Simulation panel (FilmPanel.tsx): the data pack's films and
  // papers, read when the panel opens, and its download, followed while it
  // runs. a photo is a film simulation or a converted negative, not both;
  // switching asks first
  const [sfStocks, setSfStocks] = useState<Stocks | null>(null);
  sfStocksRef.current = sfStocks;
  const [sfFetch, setSfFetch] = useState<FetchStatus | null>(null);
  const [exclusive, setExclusive] = useState<{ title: string; body: string; go: () => void } | null>(null);
  const filmView = !!current && layout.right && rightMode === "film";
  useEffect(() => {
    if (!filmView || sfStocks?.pack) return;
    void commands.spektraStocks().then(setSfStocks).catch((e) => setStatus(`film data: ${e}`));
  }, [filmView]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (sfFetch?.state !== "running") return;
    const t = window.setTimeout(() => {
      void commands.spektraFetch("status").then((f) => {
        setSfFetch(f);
        if (f.state === "done") {
          void commands.spektraStocks().then(setSfStocks);
          // the module renders with the pack from its next frame
          session.current?.requestRender();
        }
      }).catch((e) => setSfFetch({ state: "failed", message: `${e}`, progress: -1 }));
    }, 400);
    return () => window.clearTimeout(t);
  }, [sfFetch]);
  const sfDownload = () => void commands.spektraFetch("start").then((f) =>
    setSfFetch(f.started === false && f.state !== "running"
      ? { ...f, state: "failed", message: f.message || "downloads are turned off in darktable's settings" } : f))
    .catch((e) => setSfFetch({ state: "failed", message: `${e}`, progress: -1 }));
  const sfCancel = () => void commands.spektraFetch("cancel").then(setSfFetch);
  // turning a film simulation off: its tools back on the modules
  // Preferences picks
  const sfOffEntries = (s: Session): [string, number][] =>
    [["sf_on", 0], ...Object.keys(SF_CHOICES).map((id): [string, number] => [id, s.neutral[id]])];
  const negOffEntries = (s: Session): [string, number][] =>
    [["neg_on", 0], ...Object.keys(NEG_CHOICES).map((id): [string, number] => [id, s.neutral[id]])];
  // on, with the module's defaults or a preset's settings, as one undo step
  const sfTurnOn = (preset?: string, swap = false) => {
    const s = session.current;
    if (!s) return;
    if (s.values.neg_on === 1 && !swap) {
      setExclusive({ title: "Film Simulation",
                     body: "Film simulation turns off this photo's negative conversion: the film is exposed from "
                       + "the photo as a positive.",
                     go: () => sfTurnOn(preset, true) });
      return;
    }
    // without a preset, the settings it had when last turned off
    const p = SF_PRESETS.find((x) => x.name === preset);
    const settings = p ? sfPresetValues(p) : [];
    changeMany([...(s.values.neg_on === 1 ? negOffEntries(s) : []), ["sf_on", 1], ...settings,
                ...Object.entries(SF_CHOICES)], p ? `Film Simulation: ${p.name.split("|").pop()}` : "Film Simulation");
    offUnmapped(s, SF_OFF, SF_OFF_UNMAPPED);
  };
  const sfFilm = (hash: number) => {
    const s = session.current, stock = sfStocks?.stocks.find((x) => !x.printing && x.hash === hash);
    if (!s || !stock || !sfStocks) return;
    changeMany(filmChanges(sfStocks.stocks, s.values, stock), "Film Stock");
  };
  const sfPaper = (pick: number) => {
    const s = session.current;
    if (!s || !sfStocks) return;
    changeMany(paperChanges(sfStocks.stocks, s.values, pick), "Print Paper");
  };
  const sfTurnOff = () => {
    const s = session.current;
    if (s) changeMany(sfOffEntries(s), "Turn off film simulation");
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
  const beforeMeta = useRef<{ x: number; y: number; scale: number; width: number; height: number;
                              fullWidth: number; fullHeight: number; edit: string } | null>(null);
  // the last edit frame's placement, which the before side is captured for
  const editKey = useRef("");
  // the Print panel (PrintPanel.tsx) and the soft proof, which stays on in
  // the other panels until turned off (print.ts)
  const [printSettings, setPrintSettingsState] = useState<PrintSettings>(loadPrintSettings);
  const setPrintSettings = (next: PrintSettings) => {
    setPrintSettingsState(next);
    storePrintSettings(next);
  };
  const [printAvailable, setPrintAvailable] = useState<boolean | null>(null);
  const [printers, setPrinters] = useState<Printer[] | null>(null);
  const [printInfo, setPrintInfo] = useState<{ name: string; info: PrinterInfo | null; error: string | null } | null>(null);
  const [printProfiles, setPrintProfiles] = useState<Profile[]>([]);
  const [printBusy, setPrintBusy] = useState(false);
  const [printNote, setPrintNote] = useState<{ text: string; error: boolean } | null>(null);
  // the page of the Cells layout the viewer shows
  const [sheetPageNo, setSheetPageNo] = useState(0);
  const [proof, setProof] = useState<Proof>(NO_PROOF);
  const proofRef = useRef(proof);
  proofRef.current = proof;
  const printOpen = layout.right && !cropping && rightMode === "print";
  // choosing Cells leaves the grid, which covers the sheet; G brings it back to pick other photos
  const cellsChosen = printOpen && printSettings.layout === "cells";
  useEffect(() => { if (cellsChosen) setGrid(false); }, [cellsChosen]);
  // the proof the engine has taken up: the Cells sheet fetches its photos
  // once it has, not while the old proof is still in force
  const [proofApplied, setProofApplied] = useState("off");
  const changeProof = (next: Proof) => {
    const p = next.profile ? next : NO_PROOF;
    setProof(p);
    // the badge names the profile, though the panel may not have listed them yet
    if (p.mode !== "off" && !printProfiles.some((q) => q.file === p.profile))
      commands.printProfiles().then(setPrintProfiles).catch(() => {});
    applyProof(p).then((changed) => {
      if (proofRef.current === p) setProofApplied(p.mode === "off" ? "off" : `${p.mode}|${p.profile}|${p.intent}`);
      if (!changed || proofRef.current !== p) return;
      session.current?.redraw();
      if (baModeRef.current !== "off") captureBefore();
    }).catch((e) => setStatus(`Soft proof: ${e}`));
  };
  const toggleProofRef = useRef(() => {});
  toggleProofRef.current = () => {
    if (proof.mode !== "off") { changeProof({ ...proof, mode: "off" }); return; }
    if (!printSettings.profile) {
      showRight("print");
      setStatus("Soft proof: choose a printer profile under Color Management");
      return;
    }
    changeProof({ mode: "proof", profile: printSettings.profile, intent: printSettings.intent });
  };
  const showRightRef = useRef(showRight);
  showRightRef.current = showRight;
  // the proof follows the panel's profile and intent
  useEffect(() => {
    if (proof.mode === "off") return;
    if (proof.profile !== printSettings.profile || proof.intent !== printSettings.intent)
      changeProof({ ...proof, profile: printSettings.profile, intent: printSettings.intent });
  }, [printSettings.profile, printSettings.intent]);
  // printers and profiles, each time the panel opens
  useEffect(() => {
    if (!printOpen) return;
    let live = true;
    commands.printers().then((r) => {
      if (!live) return;
      setPrintAvailable(r.available);
      setPrinters(r.printers);
      setPrintSettingsState((s) => {
        const known = r.printers.some((p) => p.name === s.printer);
        // a printer gone, or the first visit with one to print on: the default
        const pick = (s.printer !== PDF && !known) || (s.printer === PDF && !hasPrintSettings());
        if (!pick) return s;
        const next = { ...s, printer: (r.printers.find((p) => p.default) ?? r.printers[0])?.name ?? PDF };
        storePrintSettings(next);
        return next;
      });
    }).catch((e) => { if (live) { setPrintAvailable(true); setPrinters([]); setStatus(`Printers: ${e}`); } });
    commands.printProfiles().then((p) => { if (live) setPrintProfiles(p); })
      .catch((e) => setStatus(`Printer profiles: ${e}`));
    return () => { live = false; };
  }, [printOpen]);
  // the chosen printer's papers; a paper it lacks becomes its own
  useEffect(() => {
    if (!printOpen) return;
    const name = printSettings.printer;
    if (name === PDF) {
      if (!PDF_PAPERS.some((p) => p.name === printSettings.paper))
        setPrintSettings({ ...printSettings, paper: defaultPrintSettings().paper });
      return;
    }
    if (printInfo?.name === name && printInfo.info) return;
    let live = true;
    setPrintInfo({ name, info: null, error: null });
    printerInfo(name).then((info) => {
      if (!live) return;
      setPrintInfo({ name, info, error: null });
      setPrintSettingsState((s) => {
        if (s.printer !== name || info.papers.some((p) => p.name === s.paper)) return s;
        const paper = info.papers.find((p) => p.name === info.defaultPaper) ?? info.papers[0];
        if (!paper) return s;
        const next = { ...s, paper: paper.name };
        storePrintSettings(next);
        return next;
      });
    }).catch((e) => { if (live) setPrintInfo({ name, info: null, error: String(e) }); });
    return () => { live = false; };
  }, [printOpen, printSettings.printer]);
  const addPrintProfile = async () => {
    try {
      const added = await commands.printProfileAdd();
      if (!added) return;
      setPrintProfiles(await commands.printProfiles());
      setPrintSettings({ ...printSettings, profile: added.file });
    } catch (e) {
      setPrintNote({ text: String(e), error: true });
    }
  };
  const printNow = async () => {
    const s = session.current;
    const settings = printSettings;
    const pdf = settings.printer === PDF;
    const papers = pdf ? PDF_PAPERS : printInfo?.info?.papers ?? [];
    const paper = papers.find((p) => p.name === settings.paper) ?? papers[0];
    if (settings.layout === "cells") return printSheetNow(s, settings, paper, pdf);
    if (!s || !current) return;
    if (!paper || !placement) return;
    const l = printLayout(paper, settings, placement.fullWidth / placement.fullHeight,
                          pdf ? undefined : printInfo?.info?.margins);
    if (!l.fits) return;
    const stem = baseName(current.path).replace(/\.[^.]+$/, "");
    setPrintBusy(true);
    setPrintNote(null);
    try {
      // the edits still on their way go in first: the print renders the photo as the library has it
      await s.settled();
      // Rust asks where the PDF goes; null is the dialog cancelled
      const done = await commands.printPhoto(s.imgid,
        printRequest(settings, paper, l, baseName(current.path), settings.medium, pdf) as { [key in string]: Value },
        pdf ? `${stem}.pdf` : null);
      if (!done) return;
      const where = printers?.find((p) => p.name === settings.printer)?.description ?? settings.printer;
      setPrintNote({ text: pdf ? `Saved ${done.pdf}` : `Sent to ${where}.`, error: false });
    } catch (e) {
      setPrintNote({ text: String(e), error: true });
    } finally {
      setPrintBusy(false);
    }
  };
  // the Cells layout: the selected photos, each as its edit is now, on pages
  // of cells (print_sheet in engine/print.c); one that is open has its
  // pending edits saved first
  const printSheetNow = async (s: Session | null, settings: PrintSettings, paper: Paper | undefined, pdf: boolean) => {
    const photos = sheetPhotosRef.current;
    if (!photos.length || !paper) return;
    const l = cellsLayout(paper, settings, photos.length, pdf ? undefined : printInfo?.info?.margins);
    if (!l.fits) return;
    setPrintBusy(true);
    setPrintNote(null);
    try {
      await s?.settled();
      const where = printers?.find((p) => p.name === settings.printer)?.description ?? settings.printer;
      const pages = `${l.pages} ${l.pages === 1 ? "page" : "pages"}`;
      // the activity line under the photo counts the photos placed, and can stop the sheet
      // Rust asks where the PDF goes; null is the dialog cancelled, which leaves quietly
      const text = (r: PrintReply) => pdf ? `Saved ${r.pdf} (${pages})` : `Sent ${pages} to ${where}.`;
      const done = await runMerge("Printing contact sheet", photos.length, (job) => commands.printSheet(job,
        photos.map((p) => p.imgid),
        sheetRequest(settings, paper, l, photos, photos.length > 1 ? "Contact sheet" : photos[0].name,
                     settings.medium, pdf) as { [key in string]: Value },
        pdf ? `${photos.length > 1 ? "Contact sheet" : photos[0].name.replace(/\.[^.]+$/, "")}.pdf` : null),
        (r) => r ? { text: text(r), ok: true } : null, "Print failed");
      if (done) setPrintNote({ text: text(done), error: false });
    } catch (e) {
      setPrintNote({ text: String(e), error: true });
    } finally {
      setPrintBusy(false);
    }
  };
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
  // the grid covers the viewer, where the two show side by side
  const setCompare = (imgid: number | null) => {
    if (compareRef.current === imgid) return;
    if (imgid !== null) { setBaMode("off"); setGrid(false); }
    compareRef.current = imgid;
    setCompareState(imgid);
  };
  // the Print panel lays the page out in the viewer, the photo rendered into
  // its place on it: the edit's pane is sized to the photo's rectangle (plus
  // the fit margin), so the usual fitted render fills it, soft proof and all.
  // the page replaces the split views and compare, which turn off on entering
  const [viewerBox, setViewerBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    printViewRef.current = printOpen;
    if (!printOpen) return;
    if (baModeRef.current !== "off") setBaMode("off");
    if (compareRef.current !== null) setCompare(null);
    if (zoomRef.current !== "fit") animateTo("fit");
    const el = viewer.current!;
    const ro = new ResizeObserver(() => setViewerBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [printOpen]);
  const printPdf = printSettings.printer === PDF;
  const printPapers = printPdf ? PDF_PAPERS
    : (printInfo?.name === printSettings.printer ? printInfo.info?.papers : undefined) ?? [];
  const printPaper = printPapers.find((p) => p.name === printSettings.paper) ?? printPapers[0] ?? null;
  const printPage = printOpen && current && placement && printPaper && printAvailable !== false
                    && baMode === "off" && compare === null && printSettings.layout === "single"
    ? printLayout(printPaper, printSettings, placement.fullWidth / placement.fullHeight,
                  printPdf ? undefined : printInfo?.info?.margins)
    : null;
  const PAGE_PAD = 28; // CSS pixels between the page and the viewer's edge
  const sheet = (() => {
    if (!printPage || viewerBox.w <= 0) return null;
    const { width: W, height: H } = printPage.page;
    const k = Math.min((viewerBox.w - 2 * PAGE_PAD) / W, (viewerBox.h - 2 * PAGE_PAD) / H);
    if (!(k > 0)) return null;
    const x = (viewerBox.w - W * k) / 2, y = (viewerBox.h - H * k) / 2;
    const at = (r: { x: number; y: number; width: number; height: number }) =>
      ({ left: x + r.x * k, top: y + r.y * k, width: r.width * k, height: r.height * k });
    return { page: at({ x: 0, y: 0, width: W, height: H }), area: at(printPage.area), image: at(printPage.image),
             fits: printPage.fits };
  })();
  // the candidate on entering: a photo selected besides the open one, else
  // the next photo, else the one before. two selected (in the grid), neither
  // of them open: the first is opened, the second its candidate
  const toggleCompare = () => {
    if (compareRef.current !== null) { setCompare(null); return; }
    const list = shownRef.current;
    const sel = selectionRef.current;
    const local = (i: ImageEntry) => !isRemote(i);
    const picked = list.filter((i) => sel.has(i.imgid) && local(i));
    if (picked.length >= 2 && !picked.some((i) => isOpen(i))) {
      setCompare(picked[1].imgid);
      void openEntry(picked[0]);
      return;
    }
    const at = list.findIndex((i) => isOpen(i));
    if (at < 0) return;
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
    const s = session.current;
    entries = [...new Map(entries)];
    if (!entries.length || entries.every(([id, v]) => s?.values[id] === v)) return;
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
    session.current?.setMany(entries, dragging.current);
  };

  const change = (c: Control, v: number) => perf.time("slider.handler", () => {
    if (c.id === "profile" && v >= AGX_USER_FIRST) {
      changeMany(Object.entries(profileSelection(v)), "Profile");
      return;
    }
    if (session.current?.values[c.id] === v) return;
    leaveBefore();
    setBaMode("off");
    if (c.id.startsWith("grain_")) setGrainLast(true);
    else if (c.id.startsWith("vig_")) { setGrainLast(false); if (c.id !== "vig_amount") vigMoved(); }
    if (c.id.startsWith("tf_")) tfMoved();
    setAmount(null);
    record([c.id]);
    baseStale.current = true;
    valueUpdates.current!.enqueue(old => old[c.id] === v ? old : ({ ...old, [c.id]: v }));
    perf.time("slider.sessionSet", () => session.current?.set(c.id, v, dragging.current));
  });

  const benchRunning = useRef(false);
  const benchCtx = (): BenchContext => ({ session, benchRunning, zoomRef, currentRef, dragging, draftShown,
    viewport, setPerfHud, setZoom, setStatus, change, changeMany });
  const runGuiBenchmark = (): Promise<TunerRun> => runGuiBenchmarkDriver(benchCtx());
  const runGpuCheck = () => runGpuCheckDriver(benchCtx());

  // ⌥-click opens a panel alone, as Lightroom's solo mode (Preferences' focus
  // mode makes that the plain click)
  // in focus mode a plain click is the solo one, and ⌥ opens a panel
  // alongside the others; either way a click on an open panel closes it
  const renderLoupe = (id: string) => loupeEnabled ? (
    <div className="detail-loupe" style={{ padding: "8px 12px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <span>100%</span>
        <button className={`tool${loupePicking ? " on" : ""}`} disabled={!current || cropping || before || baMode !== "off"}
          aria-label={`Pick ${id} loupe point`} aria-pressed={loupePicking} title="Pick a point on the photo"
          onClick={() => setLoupePicking((v) => !v)}><Pipette size={16} /></button>
      </div>
      <div style={{ width: 160, height: 160, margin: "0 auto", display: "grid", placeItems: "center", background: "#121212", overflow: "hidden", position: "relative" }}>
        <canvas ref={(display) => {
          if (!display) { loupeDisplays.current.delete(id); return; }
          loupeDisplays.current.set(id, display);
          const source = loupeCanvas.current;
          if (loupeShown && source) {
            resizeCanvas(display, source.width, source.height);
            display.getContext("2d")!.drawImage(source, 0, 0);
          }
        }} style={{ display: loupeShown ? "block" : "none" }} />
        {!loupeShown && <span style={{ position: "absolute", padding: 8, textAlign: "center" }}>{current ? "Preparing preview…" : "Open a photo to preview detail"}</span>}
      </div>
      {loupePicking && <div role="status">Click a point on the photo · Escape to cancel</div>}
    </div>
  ) : undefined;

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
    // the grid covers the photo: ⇧ there belongs to selecting a range
    if (!current || !viewZ.current || pickingRef.current || previewRef.current || gridRef.current || e.button !== 0) return;
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

  // in the capture phase, so a mask tool or handle under the pointer
  // (MaskOverlay stops propagation) cannot take the loupe's click
  const onLoupePickDown = (e: React.PointerEvent<HTMLElement>) => {
    if (!(loupePicking && loupeEnabled)) return false;
    e.stopPropagation();
    e.preventDefault();
    const { sx, sy } = paneXY(e.clientX, e.clientY);
    const { ix, iy } = imageAt(sx, sy);
    if (ix >= 0 && ix <= 1 && iy >= 0 && iy <= 1) {
      loupePositionRef.current = { x: ix, y: iy };
      setLoupePosition({ x: ix, y: iy });
      setLoupePicking(false);
      session.current?.requestLoupe();
    }
    return true;
  };
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

  const prepareCropView = () => {
    resetCanvases();
    resetHistogram();
    pixelWorker.current?.dispose(); pixelWorker.current = null;
    // Crop bypass changes coordinates. Discard every old image surface before
    // asking for the replacement, including clipping.
    for (const layer of [canvas, baseCanvas, clipSharp, clipBase, loupeCanvas]) {
      const c = layer.current;
      if (c) c.getContext("2d")?.clearRect(0, 0, c.width, c.height);
    }
    for (const display of loupeDisplays.current.values())
      display.getContext("2d")?.clearRect(0, 0, display.width, display.height);
    sharpMeta.current = baseMeta.current = null;
    overviewHash.current = null;
    setCropBox(null);
    // The replacement must publish its placement even when bypassing crop
    // leaves the image dimensions unchanged, so the cleared guides return.
    placementRef.current = null;
    // Do not animate using the cropped frame's dimensions: the next fitted
    // frame must choose its scale from the uncropped dimensions immediately.
    const a = anim.current;
    if (a.raf !== null) cancelAnimationFrame(a.raf);
    a.raf = null;
    a.end = a.asked = null;
    zoomRef.current = "fit";
    setZoomState("fit");
    center.current = { x: 0.5, y: 0.5 };
  };

  const enterCrop = () => {
    const s = session.current;
    if (!s || croppingRef.current) return;
    setBaMode("off");
    setCompare(null);
    // Preserve the displayed crop orientation before clearing its placement.
    const p = placementRef.current;
    prepareCropView();
    loadCrop(s.values);
    // the guide starts in the photo's orientation: the image shown until
    // crop is bypassed below is the crop as it stands, or the whole photo
    setCropPortrait(!!p && p.fullHeight > p.fullWidth);
    croppingRef.current = true;
    setCropping(true);
    s.bypass("crop", true);
  };

  // the crop tool's guide and aspect from the photo's crop settings
  const loadCrop = (v: Values) => {
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
    setCropRect(rect);
    setCropOwn(own);
    setCropEntry(null);
    setCropAspect(preset);
  };

  const leaveCrop = (apply: boolean) => {
    const s = session.current;
    if (!s || !croppingRef.current) return;
    prepareCropView();
    croppingRef.current = false;
    setCropping(false);
    setStraightening(false);
    setAutoAngleNote(null);
    if (apply) {
      const { rect, aspect, choices } = cropRef.current;
      const a = findAspect(aspect, choices);
      const v = s.values;
      // a photo left whole at Original keeps its "no ratio": entering the
      // tool reads that as Original anyway, and the change alone would be
      // a Crop step that changes nothing an undo can show
      const whole = rect.l === 0 && rect.t === 0 && rect.r === 1 && rect.b === 1;
      const unset = !(v.crop_rd ?? 0) && !(v.crop_rn ?? 0);
      const [rd, rn] = a.ratio === null || (a.ratio === "original" && whole && unset) ? [0, 0]
        : a.ratio === "original" ? [1, 0] : a.ratio;
      // one history step for the crop, not one per edge
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
    if (!cropping || !sharpMeta.current || !canvas.current || !viewer.current) { setCropBox(null); return; }
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
  // blue labels, X rejects. typing in a field, a focused slider's arrows, or a switch's Space, are left alone
  useEffect(() => {
    // the open photo among those showing, for the keys and menu items that rate it
    const openPhoto = () => shownRef.current.find((i) => isOpen(i)) ?? null;
    const rate = (n: number) => () => { const cur = openPhoto(); if (cur) rateSelection(cur, { rating: n, rejected: false }); };
    const label = (n: number) => () => { const cur = openPhoto(); if (cur) rateSelection(cur, { labels: 1 << n }); };
    const actions: Record<ActionId, () => void> = {
      "perf-overlay": () => {
        setPerfHud(!perf.enabled);
        perf.enable(!perf.enabled);
      },
      "export": () => { setExporting(true); },
      "print": () => { showRightRef.current("print"); },
      "copy-settings": () => { if (session.current) setCopying(true); },
      "paste-settings": () => { pasteSettingsRef.current(); },
      "paste-previous": () => { pastePreviousRef.current(); },
      "shortcuts": () => { setShortcutsOpen(true); },
      "virtual-copy": () => {
        const sel = selectionRef.current, all = imagesRef.current;
        const list = sel.size ? all.filter((i) => sel.has(i.imgid)) : all.filter((i) => isOpen(i));
        void createCopiesRef.current(list);
      },
      "hdr-merge": () => {
        const sel = selectionRef.current;
        const list = hdrBrackets(imagesRef.current.filter((i) => sel.has(i.imgid)));
        if (list.length > 1) setHdrMerging(list);
        else setStatus("HDR Merge: select two raw exposures or more");
      },
      "pano-merge": () => {
        const sel = selectionRef.current;
        const list = panoFrames(imagesRef.current.filter((i) => sel.has(i.imgid)));
        if (list.length > 1) setPanoMerging(list);
        else setStatus("Panorama Merge: select two raw photos or more");
      },
      "preferences": () => { setPrefsOpen(true); },
      "import": () => { setImportOpen(true); },
      "undo": () => { stepHistory(true); },
      "redo": () => { stepHistory(false); },
      "zoom-in": () => { if (session.current && !croppingRef.current) stepZoom(1); },
      "zoom-out": () => { if (session.current && !croppingRef.current) stepZoom(-1); },
      "rotate-left": () => { void turn("ccw"); },
      "rotate-right": () => { void turn("cw"); },
      "select-all": () => { setSelection(new Set(shownRef.current.map((i) => i.imgid))); },
      "fullscreen-preview": () => {
        if (previewRef.current) setPreview(false);
        else if (session.current) setPreview(true);
      },
      "info-overlay": () => { if (session.current) setInfoMode((m) => (m + 1) % 3); },
      "canvas": () => {
        if (!session.current) return;
        setCanvasColor((c) => {
          const next = CANVASES[(CANVASES.indexOf(c) + 1) % CANVASES.length];
          storeCanvas(next);
          return next;
        });
      },
      "hide-panels": () => { hidePanels(["left", "right"]); },
      "grid": () => { if (!croppingRef.current) setGrid(!gridRef.current); },
      "before-after": () => { if (!croppingRef.current) cycleBaModeRef.current(); },
      "compare": () => { if (!croppingRef.current) toggleCompareRef.current(); },
      "wb-picker": () => {
        if (session.current && session.current.values.neg_on !== 1) setPicking(!pickingRef.current);
      },
      "next-scope": () => {
        if (!session.current) return;
        const n = SCOPE_MODES.length;
        setScope((s) => ({ mode: SCOPE_MODES[(SCOPE_MODES.findIndex(([m]) => m === s.mode) + 1) % n][0] }));
      },
      "soft-proof": () => { if (session.current) toggleProofRef.current(); },
      "clipping": () => {
        setClipOn((o) => (o.low && o.high ? { low: false, high: false } : { low: true, high: true }));
      },
      "crop": () => { enterCrop(); },
      "heal": () => { if (session.current) showHealRef.current(); },
      "zoom-toggle": () => { setZoom(zoomRef.current === "fit" ? navZoom.current : "fit"); },
      "rate-0": rate(0), "rate-1": rate(1), "rate-2": rate(2), "rate-3": rate(3), "rate-4": rate(4), "rate-5": rate(5),
      "label-red": label(0), "label-yellow": label(1), "label-green": label(2), "label-blue": label(3),
      "reject": () => { const cur = openPhoto(); if (cur) rateSelection(cur, { rejected: !cur.rejected }); },
      // menu-only items
      "add-folder": () => { void addFolderRef.current(); },
      "user-guide": () => { void openUrl("https://immage.photo/guide/"); },
      "support-bundle": () => { void openSupportBundleRef.current(); },
      "about": () => { setPrefsOpen("about"); },
      "quit": () => { void settings.flush().finally(() => getCurrentWindow().close()); },
      "cut": () => { document.execCommand("cut"); },
      "copy": () => { document.execCommand("copy"); },
      "paste": () => {
        if (document.execCommand("paste")) return;
        const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
        if (!el?.setRangeText) return;
        void navigator.clipboard.readText().then((text) => {
          el.setRangeText(text, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, "end");
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }).catch(() => {});
      },
    };
    menuActionsRef.current = actions;
    // a key that runs an action is noted, so the native menu's echo of it is ignored
    const run = (id: ActionId) => {
      lastKeyActionRef.current = { id, t: performance.now() };
      actions[id]();
    };
    const onKey = (e: KeyboardEvent) => {
      if (pastingRef.current) { e.preventDefault(); return; }
      const t = e.target;
      // a dialog owns the keyboard while it is open
      if (document.querySelector(".modal-backdrop")) return;
      if (fieldKeeps(t, e.key)) return;
      // the import screen has its own keys; Preferences still opens over it
      if (importOpenRef.current && !(cmd(e) && (e.key === "," || e.code === "Slash"))) return;
      const chord = chordAction(e);
      if (chord) {
        if (!chord.keep) e.preventDefault();
        run(chord.id);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // the preview is for looking: F or Escape leaves it, and only the keys
      // that look, rate or move to another photo work in it
      // the key is marked used: macOS beeps at one left unhandled while the
      // window changes style
      if (previewRef.current) {
        if (e.key === "f" || e.key === "F" || e.key === "Escape") { e.preventDefault(); e.key === "Escape" ? setPreview(false) : run("fullscreen-preview"); return; }
        if (!/^([zZyYxXiIlL\\0-9]|ArrowLeft|ArrowRight)$/.test(e.key)) return;
      } else if ((e.key === "f" || e.key === "F") && session.current) { e.preventDefault(); run("fullscreen-preview"); return; }
      // I cycles the info over the photo: file, exposure, none, as Lightroom's
      if ((e.key === "i" || e.key === "I") && session.current) { run("info-overlay"); return; }
      // L steps the canvas: dark, neutral gray, white. Lightroom sets it only
      // from the surround's context menu; its L (Lights Out) is the nearest key
      if ((e.key === "l" || e.key === "L") && session.current) {
        run("canvas");
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        if (e.shiftKey) hidePanels(["left", "right", "strip"]); else run("hide-panels");
        return;
      }
      if ((e.key === "g" || e.key === "G") && !croppingRef.current) { run("grid"); return; }
      if (e.key === "Escape" && gridRef.current) { setGrid(false); return; }
      if (e.key === "\\" && !croppingRef.current) { setBaModeRef.current("off"); setBefore(!beforeRef.current); return; }
      if ((e.key === "y" || e.key === "Y") && !croppingRef.current) { run("before-after"); return; }
      if ((e.key === "c" || e.key === "C") && !croppingRef.current) { run("compare"); return; }
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
      if ((e.key === "w" || e.key === "W") && session.current && session.current.values.neg_on !== 1) {
        run("wb-picker");
        return;
      }
      if (healModeRef.current && healKeyRef.current(e)) return;
      // O shows or hides the pinned zones' overlay, as it does a mask's
      if (zoneBoxingRef.current && e.key === "Escape") { setZoneBoxing(false); return; }
      if (negPickRef.current && e.key === "Escape") { setNegPick(null); return; }
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
      // H steps the scope as its corner menu lists them, ⇧H back
      if ((e.key === "h" || e.key === "H") && !cmd(e) && !e.altKey && session.current) {
        if (e.shiftKey) {
          const n = SCOPE_MODES.length;
          setScope((s) => ({ mode: SCOPE_MODES[(SCOPE_MODES.findIndex(([m]) => m === s.mode) + n - 1) % n][0] }));
        } else run("next-scope");
        return;
      }
      // S turns the soft proof on or off, as in Lightroom
      if ((e.key === "s" || e.key === "S") && !cmd(e) && !e.altKey && !e.shiftKey && session.current) {
        run("soft-proof");
        return;
      }
      // J shows both clipping overlays, or hides them, as in Lightroom
      if (e.key === "j" && !cmd(e) && !e.altKey) {
        run("clipping");
        return;
      }
      if (e.shiftKey && (e.key === "q" || e.key === "Q")) { pickToolRef.current("luminance"); return; }
      if (e.key === "k" || e.key === "K") { pickToolRef.current("brush"); return; }
      if (e.key === "m" || e.key === "M") { pickToolRef.current(e.shiftKey ? "ellipse" : "gradient"); return; }
      if (e.key === "r" || e.key === "R") { run("crop"); return; }
      if ((e.key === "q" || e.key === "Q") && session.current) { run("heal"); return; }
      const list = shownRef.current;
      const at = list.findIndex((i) => isOpen(i));
      const cur = at >= 0 ? list[at] : null;
      if (e.key === "z" || e.key === "Z") run("zoom-toggle");
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
      else if (e.key >= "0" && e.key <= "5") run(`rate-${e.key}` as ActionId);
      else if (e.key >= "6" && e.key <= "9") run((["label-red", "label-yellow", "label-green", "label-blue"] as const)[Number(e.key) - 6]);
      else if (e.key === "x" || e.key === "X") run("reject");
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
  // the photos the folder's last read found that this one has not reached:
  // shown as they were, through the filters, until they are read. once the
  // folder is listed, those no longer in it go
  const knownPaths = reading?.known.length ? new Set(reading.known.map((k) => k.path)) : null;
  const readPaths = knownPaths && new Set(images.map((i) => i.path));
  const listedPaths = knownPaths && reading!.listed ? new Set(reading!.files) : null;
  const unread = !readPaths ? []
    : reading!.known.filter((k) => !readPaths.has(k.path) && (!listedPaths || listedPaths.has(k.path)) && passes(k, filter));
  // a raw not yet read stacks its companions too, read or not
  const stackRaw = (i: Known) => !i.copy && isPrimaryRaw(i.filename);
  const unreadRaws = stackPairs ? new Set(unread.filter(stackRaw).map((k) => pairKey(k.path))) : null;
  const stacked = (i: Known) => !i.copy && isCompanion(i.filename) && !!unreadRaws?.has(pairKey(i.path));
  const shown = passing.filter((i) => !behind.has(i.imgid) && !stacked(i));
  const passingRaws = stackPairs ? new Set(passing.filter(stackRaw).map((i) => pairKey(i.path))) : null;
  const provisional = unread.filter((k) => !stacked(k) && !(!k.copy && isCompanion(k.filename) && passingRaws?.has(pairKey(k.path))));
  const cells: (ImageEntry | Known)[] = provisional.length ? withKnown(shown, provisional) : shown;
  // the files still to be read and not known, as empty cells after the
  // photos: unless the filters ask for what only reading tells (ratings,
  // labels, rejects)
  const rawNames = stackPairs && reading ? pairedRaws(reading.files) : null;
  const pending = !reading || needsRead(filter) ? []
    : reading.files.slice(reading.done).filter((p) => !filter.kinds.length || filter.kinds.includes(fileKind(p)))
        .filter((p) => !knownPaths?.has(p))
        // a raw's companions, stacked behind it
        .filter((p) => !rawNames?.has(pairKey(p)) || !isCompanion(p));
  const shownRef = useRef<ImageEntry[]>([]);
  shownRef.current = shown;
  // the open photo's cell in the filmstrip, if the filmstrip shows it, and
  // its entry whichever folder is shown
  const listedEntry = images.find((i) => isOpen(i, current)) ?? null;
  const currentEntry = listedEntry ?? (openCell && isOpen(openCell, current) ? openCell : null);
  // the Print panel's Cells layout prints the photos selected, in the filmstrip's order, else the open one
  const sheetPhotos: SheetPhoto[] = (() => {
    if (!printOpen || printSettings.layout !== "cells") return [];
    const picked = shown.filter((i) => selection.has(i.imgid) && !isRemote(i));
    const list: ImageEntry[] = picked.length ? picked
      : currentEntry && "imgid" in currentEntry && !isRemote(currentEntry as ImageEntry) ? [currentEntry as ImageEntry] : [];
    return list.map((i) => ({ imgid: i.imgid, name: `${i.filename}${copyName(i)}` }));
  })();
  const sheetPhotosRef = useRef<SheetPhoto[]>([]);
  sheetPhotosRef.current = sheetPhotos;
  const sheetKey = sheetPhotos.map((p) => p.imgid).join(",");
  const cellsPage = printOpen && printSettings.layout === "cells" && printPaper && printAvailable !== false
    ? cellsLayout(printPaper, printSettings, sheetPhotos.length, printPdf ? undefined : printInfo?.info?.margins) : null;
  const cellPageNo = cellsPage ? Math.min(sheetPageNo, cellsPage.pages - 1) : 0;
  // their thumbnails, asked for as the sheet shows them
  useEffect(() => {
    if (cellsPage && sheetKey) loader.current?.request(sheetKey.split(",").map(Number));
  }, [!!cellsPage, sheetKey]);
  const cellsSheet = (() => {
    if (!cellsPage || viewerBox.w <= 0) return null;
    const { width: W, height: H } = cellsPage.page;
    const k = Math.min((viewerBox.w - 2 * PAGE_PAD) / W, (viewerBox.h - 2 * PAGE_PAD - 28) / H);
    if (!(k > 0)) return null;
    const x = (viewerBox.w - W * k) / 2, y = (viewerBox.h - 28 - H * k) / 2 + 0;
    const cells = sheetPages(cellsPage, sheetPhotos)[cellPageNo] ?? [];
    const filled = new Set(cells.map((c) => cellsPage.slots.indexOf(c.slot)));
    return { page: { left: x, top: y, width: W * k, height: H * k }, k, cells, filled };
  })();
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
    commands.meta(currentId)
      .then((r) => {
        if (stale) return;
        setMetaText(r.image.metadata);
        setKeywords(r.image.keywords);
      })
      .catch((e) => setStatus(`error: ${e}`));
    commands.keywords().then((k) => { if (!stale) setKnownKeywords(k); }).catch(() => {});
    return () => { stale = true; };
  }, [currentId]);
  // keywords added by something other than the Keywording card: an export
  // that adds its keywords to the originals
  const reloadKeywords = () => {
    if (currentId !== undefined)
      commands.meta(currentId)
        .then((r) => setKeywords(r.image.keywords)).catch(() => {});
    commands.keywords().then(setKnownKeywords).catch(() => {});
  };
  // the open photo's keywords, for a save made after the render they came
  // from (Session.onSaved)
  const keywordsRef = useRef<{ imgid: number; list: string[] } | null>(null);
  keywordsRef.current = keywords && currentId !== undefined ? { imgid: currentId, list: keywords } : null;
  // into the filmstrip's entry too, which the Filters popup reads
  useEffect(() => {
    if (!keywords || currentId === undefined) return;
    const e = imagesRef.current.find((i) => i.imgid === currentId);
    if (e && e.keywords?.join("\n") !== keywords.join("\n")) patchImage(currentId, { keywords });
  }, [keywords]);
  // Preferences' keywords for edited photos: on once a save finds the photo
  // edited, off again once one finds it unedited
  const syncEditedKeywords = async (imgid: number, edited: boolean) => {
    const wanted = loadEditedKeywords();
    if (!wanted.length) return;
    try {
      // the photo may be closed already, its last save made on leaving it
      const known = keywordsRef.current?.imgid === imgid ? keywordsRef.current.list
        : (await commands.meta(imgid)).image.keywords;
      const add = edited ? wanted.filter((k) => !known.includes(k)) : [];
      const remove = edited ? [] : wanted.filter((k) => known.includes(k));
      if (!add.length && !remove.length) return;
      const now = await commands.keywordsSet(imgid, add, remove);
      if (session.current?.imgid === imgid) setKeywords(now);
      patchImage(imgid, { keywords: now });
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
        const r = await commands.meta(imgid);
        text = r.image.metadata;
        datetime ??= r.image.exif?.datetime;
      }
      const year = /^\d{4}/.exec(datetime ?? "")?.[0] ?? String(new Date().getFullYear());
      const fields: Partial<TextFields> = {};
      for (const k of ["rights", "creator"] as const)
        if (wanted[k].trim() && !text[k].trim()) fields[k] = wanted[k].trim().replace(/\{year\}/g, year);
      if (!Object.keys(fields).length) return;
      await commands.metaSet(imgid, fields);
      if (session.current?.imgid === imgid) setMetaText((t) => (t ? { ...t, ...fields } : t));
    } catch (e) {
      setStatus(`error: ${e}`);
    }
  };
  const setPhotoKeywords = async (add: string[], remove: string[]) => {
    if (currentId === undefined || (!add.length && !remove.length)) return;
    try {
      setKeywords(await commands.keywordsSet(currentId, add, remove));
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
  useEffect(() => { try { settings.set(INFO_MODE_KEY, String(infoMode)); } catch { /* not kept */ } }, [infoMode]);
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
    <div className={`window${preview ? " preview" : ""}`} data-module-choices={JSON.stringify(Object.fromEntries(Object.entries(values).filter(([id]) => id.startsWith("mod_"))))}>
    {pasting && <div className="modal-backdrop" data-batch-paste="busy" role="dialog" aria-modal="true" aria-label="Pasting settings"
      onKeyDownCapture={e => { e.preventDefault(); e.stopPropagation(); }} tabIndex={-1} ref={el => el?.focus()}>
      <div className="modal"><div className="modal-head"><h2>{pasting}</h2></div></div>
    </div>}
    {/* the window's title bar is hidden (tauri.conf.json); this strip moves
        the window and leaves room for the traffic lights */}
    {/* full screen has no traffic lights to hold, and the photo wants the room */}
    {!fullscreen && <div className={`titlebar${!IS_MAC ? " with-menus" : ""}`} data-tauri-drag-region><span data-tauri-drag-region>Immage</span>{!IS_MAC && <MenuBar menus={OTHER_MENUS} onAction={runMenuAction} />}</div>}
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
                       onLocationSaved={(location) => currentEntry && patchImage(currentEntry.imgid, { location })}
                       onCaptureTime={() => { if (currentEntry) {
                         const sel = selectionRef.current;
                         startCaptureAdjustment(withPartners(sel.size > 1 && sel.has(currentEntry.imgid)
                           ? imagesRef.current.filter((i) => sel.has(i.imgid)) : [currentEntry]), currentEntry);
                       } }}
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
              <FolderTree roots={folders} volumes={volumes} hostNames={hostNames} folded={foldedVolumes}
                          current={immich ? null : folder} photo={photoDir} expanded={expanded} hidden={hidden}
                          refresh={folderRefresh}
                          icon={<FolderIcon />} driveIcon={<DriveIcon />} networkIcon={<NetworkIcon />}
                          onFold={(m) => {
                            const next = new Set(foldedVolumes);
                            if (next.has(m)) next.delete(m); else next.add(m);
                            setFoldedVolumes(next);
                            saveLibrary({ foldedVolumes: [...next] });
                          }}
                          onOpen={(d) => { void showFolder(d); setGrid(true); }} onRemove={removeFolder}
                          onRenameHost={(host, name) => {
                            const next = { ...hostNames, [host]: name };
                            if (!name) delete next[host];
                            setHostNames(next);
                            saveLibrary({ hostNames: next });
                          }}
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
                       active={!!immich} searching={!!immich?.busy} form={immichForm} onChange={updateImmich}
                       onSearch={() => { window.clearTimeout(immichTimer.current); void searchImmich(immichFormRef.current); }}
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
        <main data-tour="viewer" className={`viewer zoom-${zoom === "fit" ? "fit" : "in"}${picking || loupePicking ? " picking" : ""}${aiBusy ? " busy" : ""}${straightening || line || (shiftHeld && current && !grid && (cropping || (!masksMode && !healMode)) && !preview) ? " straightening" : ""}${canvasColor !== "dark" ? ` canvas-${canvasColor}` : ""}${baMode === "overlay" ? " hold-view" : ""}${optPreview?.kind === "gray" ? " gray-view" : ""}${sheet ? " print-view" : ""}`} ref={viewer}
              onPointerDownCapture={(e) => { if (!onLoupePickDown(e)) onStraightenDown(e); }}
              onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
              onPointerLeave={leaveProbe}>
          {sheet && (
            <div className="print-sheet" data-print-page={`${printPage!.page.width}x${printPage!.page.height}`}
                 style={sheet.page}>
              {sheet.fits && <div className="print-area" style={{ left: sheet.area.left - sheet.page.left,
                                                                    top: sheet.area.top - sheet.page.top,
                                                                    width: sheet.area.width, height: sheet.area.height }} />}
            </div>
          )}
          {cellsSheet && cellsPage && (
            <div className="print-sheet" data-print-page={`${cellsPage.page.width}x${cellsPage.page.height}`}
                 data-print-cells={`${cellsPage.columns}x${cellsPage.rows}`} style={cellsSheet.page}>
              <div className="print-area" style={{ left: cellsPage.area.x * cellsSheet.k, top: cellsPage.area.y * cellsSheet.k,
                                                   width: cellsPage.area.width * cellsSheet.k,
                                                   height: cellsPage.area.height * cellsSheet.k }} />
              {cellsPage.slots.map((slot, n) => {
                const cell = cellsSheet.cells.find((c) => c.slot === slot);
                const k = cellsSheet.k;
                return (
                  <Fragment key={n}>
                    <div className={`print-cell${cell ? "" : " empty"}${slot.label ? " named" : ""}`} data-print-cell={cell?.photo.imgid}
                         style={{ left: slot.box.x * k, top: slot.box.y * k, width: slot.box.width * k, height: slot.box.height * k }}>
                      {cell && (cell.photo.imgid >= 0
                        ? <CellCanvas loader={loader.current ?? undefined} imgid={cell.photo.imgid} proof={proofApplied !== "off"} proofKey={proofApplied}
                                      pixels={Math.max(slot.box.width, slot.box.height) * k * (window.devicePixelRatio || 1)} />
                        : <ThumbCanvas loader={loader.current ?? undefined} imgid={cell.photo.imgid} />)}
                    </div>
                    {cell && slot.label && (
                      <div className="print-label" style={{ left: slot.label.x * k, top: slot.label.y * k,
                                                           width: slot.label.width * k, height: slot.label.height * k,
                                                           fontSize: LABEL_POINTS * 25.4 / 72 * k,
                                                           lineHeight: `${slot.label.height * k}px` }}>
                        {cell.photo.name}
                      </div>
                    )}
                  </Fragment>
                );
              })}
            </div>
          )}
          {cellsPage && cellsPage.pages > 1 && (
            <div className="print-pager" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
              <button aria-label="previous page" disabled={cellPageNo <= 0}
                      onClick={() => setSheetPageNo(cellPageNo - 1)}>‹</button>
              <span data-print-pager>Page {cellPageNo + 1} of {cellsPage.pages}</span>
              <button aria-label="next page" disabled={cellPageNo >= cellsPage.pages - 1}
                      onClick={() => setSheetPageNo(cellPageNo + 1)}>›</button>
            </div>
          )}
          <div ref={pane} className={`after-pane${sheet ? " on-page" : baMode === "side" ? " half" : compare !== null ? " half-left" : ""}`}
               style={sheet ? (sheet.fits ? { left: sheet.image.left - MARGIN, top: sheet.image.top - MARGIN,
                                              width: sheet.image.width + 2 * MARGIN, height: sheet.image.height + 2 * MARGIN }
                                          : { left: 0, top: 0, width: "100%", height: "100%", visibility: "hidden" })
                             : cellsPage ? { visibility: "hidden" } : undefined}>
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
                             awaitFinal={(() => {
                               const t = peekMask ?? selMask;
                               return !!t && (isRefined(t) || readsBackdrop(t)) && !t.hidden && finalMissing !== t.name
                                 && !(finalMap && finalMap.session === session.current && finalMap.name === t.name);
                             })()}
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
            {negWhole && !cropping && full.current && (
              <div className="mask-box" ref={negBox}>
                {negArea && (
                  <div className="neg-area" style={{
                    left: `${negArea[0] * 100}%`, top: `${negArea[1] * 100}%`,
                    width: `${(negArea[2] - negArea[0]) * 100}%`, height: `${(negArea[3] - negArea[1]) * 100}%`,
                  }} />
                )}
                {negPick && (
                  <ObjectBox onPrompt={(pr) => {
                    // a click reads a small box round it, as darktable's picker does
                    const [x, y] = pr.points?.[0] ?? [0.5, 0.5];
                    void negPicked(negPick, pr.box ?? [Math.max(0, x - 0.01), Math.max(0, y - 0.01),
                                                       Math.min(1, x + 0.01), Math.min(1, y + 0.01)]);
                  }} />
                )}
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
          {sheet?.fits && (
            <div className="print-align" style={sheet.area}>
              {Array.from({ length: 9 }, (_, k) => (
                <button key={k} className={k === printSettings.alignment ? "on" : ""}
                        aria-label={`place the photo ${PRINT_PLACES[k]}`} title={`place the photo ${PRINT_PLACES[k]}`}
                        onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}
                        onClick={() => setPrintSettings({ ...printSettings, alignment: k })} />
              ))}
            </div>
          )}
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
          {current && proof.mode !== "off" && !printOpen && (
            <div className="proof-badge" data-proof-badge>
              Soft Proof: {printProfiles.find((p) => p.file === proof.profile)?.name ?? "printer profile"}
              {proof.mode === "gamut" ? ", gamut warning" : ""}</div>
          )}
          {modeFlash && <div className="mode-flash">{modeFlash}</div>}
          {holdHint && <div className="hold-hint">Click and hold the photo to see the before</div>}
          {line && (
            <svg className="straighten-line">
              <line x1={line.x0} y1={line.y0} x2={line.x1} y2={line.y1} />
            </svg>
          )}
          <div className={`working${working ? " on" : ""}`} title="working…" aria-hidden={!working}><span /></div>
          <div className="status">{status}{isEngineExit(status) && <button className="status-action"
            onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}
            onClick={() => void openSupportBundleRef.current()}>Create Support Bundle…</button>}</div>
          <div className="activities">
          {backgroundJobs.map((j) => <JobActivity key={j.id} job={j} />)}
          {engineNotice?.kind === "slow" && (
            <div className="activity waiting" onPointerDown={(e) => e.stopPropagation()}
                 onPointerUp={(e) => e.stopPropagation()}>
              <span>The engine is not answering.</span>
              <button onClick={hideEngineNotice}>Wait</button>
              <button onClick={() => { hideEngineNotice(); void commands.engineRestart().catch((e) => setStatusRaw(`error: ${e}`)); }}>Restart</button>
            </div>
          )}
          {saveError && (
            <div className="activity" data-save-error><span className="failed">Edits are not being saved. {saveError}</span></div>
          )}
          {engineNotice?.kind === "failed" && (
            <div className="activity"><span className="failed">The engine keeps stopping. Restart Immage to continue editing.</span>
              <button className="status-action" onClick={() => void openSupportBundleRef.current()}>Create Support Bundle…</button></div>
          )}
          {(() => {
            // the folder's reading, then its thumbnails
            if (immich?.busy) return <div className="activity"><span>Searching Immich…</span></div>;
            const w = waiting[waiting.length - 1];
            if (w && !reading) return (
              // the viewer's own pointer handling (zoom on click) stays off it
              <div className="activity waiting" onPointerDown={(e) => e.stopPropagation()}
                   onPointerUp={(e) => e.stopPropagation()}>
                <span>Waiting for {w.name}{w.total > 1 ? ` · ${w.back} of ${w.total} back` : ""}…</span>
                <button onClick={() => void commands.pluginCancel(w.token)}>Stop waiting</button>
              </div>
            );
            return reading ? <ActivityBar what="Reading photos" done={reading.done} total={reading.total} />
              : <ThumbProgress loader={loader.current!} />;
          })()}
          </div>
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
            {(cells.length > 0 || pending.length > 0) && !grid && (
              <Splitter axis="y" value={layout.stripHeight} min={90} max={300} invert hidden={!layout.strip}
                        onChange={(v) => setLayout((l) => ({ ...l, stripHeight: v }))} />
            )}
            <Filmstrip images={cells} partners={partners} pending={pending}
                       empty={immich ? (immich.busy ? "searching Immich…" : "no photos in Immich match the search")
                              : reading ? "reading the folder…"
                              : images.length ? "no photos match the filters"
                              : folder ? `no photos in this folder${includeSub ? "" : " (Include subfolders shows its subfolders' photos)"}`
                              : "add a folder to start"} current={currentEntry?.imgid ?? null} loader={loader.current!} onMenu={showFileMenu}
                       height={layout.stripHeight} grid={grid} selection={selection} onPick={pickPhoto}
                       candidate={compare}
                       onDouble={(i) => { setCompare(null); void openEntry(i); setGrid(false); }}
                       onOpenKnown={(k, double) => {
                         // a comparison's candidate waits for its photo to be read, and so
                         // does a virtual copy: by its path alone, the original would open
                         if ((compare !== null && !double) || k.copy) return;
                         if (double) { setCompare(null); setGrid(false); }
                         setSelection(new Set());
                         void openFile(k.path);
                       }}
                       more={immich?.next && !immich.busy ? () => void searchImmich(immich.search, true) : undefined}
                       onBackMenu={showResultsMenu}
                       onMeta={(i, fields) => rateSelection(i, fields)} />
          </div>
        </div>
        <Toolbar filter={filter} images={images} immich={immich ? { form: immichForm, update: updateImmich } : null} layout={layout} ref={toolbar} pin={pinButton("strip")}
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
                 filterBounds={() => {
                   // across the filmstrip, below the top of the photo area, and
                   // clear of a side panel shown over it (auto-hide)
                   const s = stripSlot.current?.getBoundingClientRect();
                   if (!s) return undefined;
                   const l = leftAside.current?.getBoundingClientRect(), r = rightAside.current?.getBoundingClientRect();
                   return {
                     left: l && l.width && l.right > 0 ? Math.max(s.left, l.right) : s.left,
                     right: r && r.width && r.left < window.innerWidth ? Math.min(s.right, r.left) : s.right,
                     top: viewer.current?.parentElement?.getBoundingClientRect().top ?? 0,
                   };
                 }}
                 onFiltered={() => setGrid(true)}
                 grid={grid} onGrid={cells.length > 0 || pending.length > 0 || grid ? () => setGrid(!grid) : undefined}
                 zoomBar={<ZoomBar disabled={!current || !!sheet} register={(f) => { zoomShow.current = f; }}
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
        <Profiler id="histogram" onRender={perf.reactCommit}><HistogramView histograms={histograms} values={values} disabled={!current} exif={currentEntry?.exif ?? null}
                       neutral={(id) => session.current?.neutral[id] ?? controlById.get(id)?.neutral ?? 0}
                       onChange={change} clip={clipOn} onClip={(end) => setClipOn((o) => ({ ...o, [end]: !o[end] }))}
                       onClipPeek={setClipPeek} scope={scope} onScope={setScope} /></Profiler>
        <div className="panels" data-tour="panels" ref={panelsRef}
             onScroll={(e) => panelScroll.current.set(shownKey.current, e.currentTarget.scrollTop)}>
          {masksMode && !cropping && (
            <MasksPanel masks={masks} selected={maskSel} shape={shapeSel} tool={maskTool} target={toolTarget}
                        brush={brush} overlay={maskShown} disabled={!current} mono={values.bw_mode === 1} photo={values}
                        renderSlider={(c, v, onChange, glow, module) => (
                          <div key={c.id}
                               onPointerDownCapture={() => { if (c.id.startsWith("r_c")) { rangeInteracting.current = true; refined(); } }}
                               onPointerUpCapture={() => { if (c.id.startsWith("r_c")) { rangeInteracting.current = false; refined(); } }}
                               onPointerCancelCapture={() => { rangeInteracting.current = false; refined(); }}
                               onFocusCapture={() => { if (c.id.startsWith("r_c")) { rangeInteracting.current = true; refined(); } }}
                               onBlurCapture={() => { if (c.id.startsWith("r_c")) { rangeInteracting.current = false; refined(); } }}>
                          <Slider control={c} value={v} neutral={c.neutral ?? 0} disabled={!current}
                                  values={selMask?.values ?? values} onChange={onChange} glow={glow}
                                  moduleChoice={module?.choice} moduleValue={module?.value} onModule={module?.onPick}
                                  moduleScope="masks" /></div>
                        )}
                        fresh={freshMask} onHslShown={setMaskHslShown}
                        onTool={(t, target) => {
                          if (t === "parametric") { addParametric(target); return; }
                          setMaskTool(t); setToolTarget(target);
                        }}
                        onAi={(kind, target) => void selectAi(kind, target)}
                        aiBusy={aiBusy} focusMode={focusMode} presenceLoupe={renderLoupe("mask-presence")}
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
                        onResetAdjustments={resetMaskAdjustments}
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
              <div className="panel-title"><span>Zone System</span>
                {values.bw_mode === 1 && <AdvancedToggle on={zonesAdvanced} onToggle={toggleZonesAdvanced} />}
              </div>
              {values.bw_mode === 1 ? (
                <ZoneSystem advanced={zonesAdvanced} data={zoneData} unplaced={zoneUnplaced} stale={zoneStale} error={zoneError}
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
          {rightMode === "negative" && !cropping && (
            <NegativePanel fineColorChanged={advancedEdited(negAdvancedIds(values), values, session.current?.neutral ?? {})}
                           footer={<PositiveFooter format={positiveFormat} exporting={positiveExporting} disabled={negBusy || !!negPick}
                                     onFormat={(f) => { setPositiveFormat(f); storeNegativeExportFormat(f); }}
                                     onExport={() => exportPositive("negative")} onTurnOff={negTurnOff}
                                     turnOffLabel="Turn Off Conversion"
                                     turnOffTitle="the photo back as a negative, with Basic's tools as they were" />} photo={session.current} values={values} disabled={!current} converted={values.neg_on === 1} picking={negPick}
                           busy={negBusy} hasArea={!!negArea} note={negNote} onPick={setNegPick}
                           onResetColor={() => changeMany(["wbl", "wbh"].flatMap((k) => ["r", "g", "b"]
                             .map((c): [string, number] => [`neg_${k}_${c}`, 1])), "Reset Color")}
                           renderControl={(id, options) => {
                             const c = { ...controlById.get(id)!, ...(options ? { options } : {}) };
                             const profile = id === "neg_input_profile" || id === "neg_working_profile";
                             const props = { control: c, value: values[id] ?? c.neutral ?? 0,
                                             neutral: session.current?.neutral[id] ?? c.neutral ?? 0,
                                             disabled: !current || negBusy || (profile ? !options?.length : id !== "neg_film" && values.neg_on !== 1),
                                             values, onChange: (v: number) => {
                                               if (id === "neg_film") negFilm(v);
                                               else {
                                                 change(c, v);
                                                 if (profile) {
                                                   storeNegProfile(id === "neg_input_profile" ? "input" : "working", v);
                                                   setNegPick(null); setNegArea(null);
                                                   setNegNote("Profile changed: pick the film border and photo area again.");
                                                 }
                                               }
                                             } };
                             return c.kind === "choice" ? <Choice key={id} {...props} /> : <Slider key={id} {...props} />;
                           }} />
          )}
          {rightMode === "film" && !cropping && (
            <FilmPanel darkroomChanged={advancedEdited(filmAdvancedIds(values), values, session.current?.neutral ?? {})} values={values} disabled={!current} on={values.sf_on === 1} stocks={sfStocks} fetch={sfFetch}
                       onDownload={sfDownload} onCancel={sfCancel} onTurnOn={() => sfTurnOn()}
                       onPreset={(name) => sfTurnOn(name)} onFilm={sfFilm} onPaper={sfPaper}
                       preview={(key) => previews.current!.get(key)}
                       onWant={(keys) => { wantedTiles.current = keys; requestTiles(); }} onHover={hoverTile}
                       renderControl={(id, override, onChange, value) => {
                         const c = { ...controlById.get(id)!, ...override };
                         const props = { control: c, value: value ?? values[id] ?? c.neutral ?? 0,
                                         neutral: session.current?.neutral[id] ?? c.neutral ?? 0,
                                         disabled: !current, values,
                                         onChange: onChange ?? ((v: number) => change(c, v)) };
                         return c.kind === "choice" ? <Choice key={id} {...props} />
                           : c.kind === "toggle" ? <Toggle key={id} {...props} /> : <Slider key={id} {...props} />;
                       }} />
          )}
          {rightMode === "print" && !cropping && (
            <PrintPanel settings={printSettings} onSettings={setPrintSettings} available={printAvailable}
                        printers={printers} info={printInfo?.name === printSettings.printer ? printInfo.info : null}
                        infoError={printInfo?.name === printSettings.printer ? printInfo.error : null}
                        profiles={printProfiles} onAddProfile={() => void addPrintProfile()}
                        aspect={placement ? placement.fullWidth / placement.fullHeight : 1.5}
                        pixelWidth={placement?.fullWidth ?? 0} photos={sheetPhotos.length}
                        proof={proof}
                        onProof={(mode) => changeProof({ mode, profile: printSettings.profile, intent: printSettings.intent })}
                        busy={printBusy} note={printNote} onPrint={() => void printNow()} disabled={!current} />
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
                  <button className="btn small" disabled={!current || uprightBusy || (values.tf_upright ?? 0) !== 0}
                          title={(values.tf_upright ?? 0) !== 0 ? "Upright sets the angle: turn Upright off to level from here"
                                                                : "level the photo from its straight lines"}
                          onClick={() => void runAutoStraighten()}>Auto</button>
                </div>
                {autoAngleNote && <div className="note-plain">{autoAngleNote}</div>}
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
            <Profiler key={p.id} id={`panel.${p.id}`} onRender={perf.reactCommit}><PanelView sessionRevision={historyRev} panel={p} open={openPanels.has(p.id)} onToggle={(solo) => togglePanel(p.id, solo)}
                       values={values} session={session.current} disabled={!current} onChange={change}
                       detailLoupe={p.id === "detail" ? renderLoupe("detail") : undefined}
                       presenceLoupe={p.id === "basic" ? renderLoupe("presence") : undefined}
                       onChangeMany={changeMany} histograms={histograms} onPreview={hoverValues}
                       toneTools={p.id === "basic" ? (
                         <div className="tone-tools">
                           <button className="btn small" disabled={!current || values.neg_on === 1}
                                   title={values.neg_on === 1 ? "set in Negative: a converted negative has no tone mapper for Auto to set"
                                     : values.tm_mode === 1
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
                             <button className="btn small" disabled={!current || aiBusy || denoiseRunning}
                                     title={denoiseRunning ? "a denoise is still running" : undefined}
                                     onClick={() => setDenoising(true)}>Denoise…</button>
                             <span className="note-plain">writes a denoised DNG beside the raw, with this edit</span>
                           </div>
                         )
                       ) : undefined}
                       wbTools={p.id === "basic" ? (
                         <WBTools values={values} asShot={session.current
                                    ? { temp: session.current.neutral.temp, tint: session.current.neutral.tint } : null}
                                  picking={picking} disabled={!current || values.bw_mode === 1 || values.neg_on === 1}
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
                       } : undefined} /></Profiler>
          ))}
        </div>
        {!cropping && current && rightMode === "film" && values.sf_on === 1 && (
          <PositiveFooter format={positiveFormat} exporting={positiveExporting} disabled={negBusy || !!negPick}
                          onFormat={(f) => { setPositiveFormat(f); storeNegativeExportFormat(f); }}
                          onExport={() => exportPositive("film")}
                          onTurnOff={sfTurnOff}
                          turnOffLabel="Turn Off Film Simulation"
                          turnOffTitle="the photo back on its tone mapper, with Basic's tools as they were" />
        )}
        <div className="right-foot">
          <button className="btn small" disabled={!current || cropping} onClick={() => setCopying(true)}
                  data-action="copy-settings" title={keys("choose settings of this photo to copy (⇧⌘C)")}>Copy…</button>
          <button className="btn small" disabled={!current || cropping || !hasClip} onClick={() => void pasteSettings()}
                  data-action="paste-settings" title={keys("paste the copied settings onto the selected photos (⇧⌘V)")}>Paste</button>
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
        {/* the tools work on the open photo, not its cell: one opened before
            its folder listed it, or from elsewhere, has none */}
        <button className={`tool${layout.right && !cropping && rightMode === "adjust" ? " on" : ""}`} title="adjustments"
                data-tour="adjust" onClick={() => showRight("adjust")}>
          <SlidersIcon /></button>
        <button className={`tool${cropping ? " on" : ""}`} title="crop (R)" data-tour="crop" disabled={!current}
                onClick={() => (cropping ? leaveCrop(true) : enterCrop())}><CropIcon /></button>
        <button className={`tool${layout.right && !cropping && masksMode ? " on" : ""}`} title="masks" data-tour="masks"
                disabled={!current} onClick={() => showRight("masks")}><LayersIcon /></button>
        <button className={`tool${layout.right && !cropping && healMode ? " on" : ""}`} title="heal and clone (Q)"
                data-tour="heal"
                disabled={!current} onClick={() => showRight("heal")}><HealIcon /></button>
        <button className={`tool${layout.right && !cropping && rightMode === "zones" ? " on" : ""}`} title="zone system"
                data-tour="zones" disabled={!current} onClick={() => showRight("zones")}><ZonesIcon /></button>
        <button className={`tool${layout.right && !cropping && rightMode === "film" ? " on" : ""}`}
                title="film simulation" data-tour="film" disabled={!current} onClick={() => showRight("film")}><FilmSimIcon /></button>
        <button className={`tool${layout.right && !cropping && rightMode === "negative" ? " on" : ""}`}
                title="film negative" data-tour="negative" disabled={!current} onClick={openNegative}><FilmIcon /></button>
        <button className={`tool${layout.right && !cropping && rightMode === "presets" ? " on" : ""}`} title="presets" data-tour="presets"
                onClick={() => showRight("presets")}><PresetsIcon /></button>
        </div>
        <div className="rail-sep" />
        <button className="tool" title={keys("export (⇧⌘E)")} data-tour="export" onClick={() => setExporting(true)}><ExportIcon /></button>
        <button className={`tool${layout.right && !cropping && rightMode === "print" ? " on" : ""}`} title={keys("print (⌘P)")}
                data-tour="print" onClick={() => showRight("print")}><PrintIcon /></button>
        <div className="rail-fill" />
        <button className="tool" title="quick start guide" onClick={() => setTouring(true)}><HelpIcon /></button>
        <button className="tool" title={keys("keyboard shortcuts (⌘/)")} onClick={() => setShortcutsOpen(true)}><KeyboardIcon /></button>
        <button className="tool" title={keys("preferences (⌘,)")} data-tour="prefs" onClick={() => setPrefsOpen(true)}><GearIcon /></button>
      </nav>
    </div>
    {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
    {supportBundle && <SupportBundleDialog values={supportBundle} onClose={() => setSupportBundle(null)} />}
    {captureDialog && <CaptureTimeDialog {...captureDialog} onApply={applyCaptureTimes} onClose={() => setCaptureDialog(null)} />}
    {fileMenu && (() => {
      const hit = images.find((i) => i.imgid === fileMenu.imgid);
      const local = fileMenu.targets.filter((i) => !isRemote(i));
      // a stacked JPEG or HEIF gets no virtual copy of its own; its raw does
      const behindRaw = new Set([...partners.values()].flat().map((p) => p.imgid));
      const sources = local.filter((i) => !behindRaw.has(i.imgid));
      const copies = local.filter((i) => i.copy);
      return (
        <FileMenu x={fileMenu.x} y={fileMenu.y}
                  captureCount={local.length} onCaptureTime={() => startCaptureAdjustment(local, hit)}
                  canUndoCapture={captureUndo.length > 0} onUndoCapture={startCaptureUndo}
                  copyable={sources.length} copies={copies.length === local.length ? copies.length : 0}
                  onCopy={() => void createCopies(sources)} onRemoveCopies={() => void removeCopies(copies)}
                  mergeable={hdrBrackets(local).length} onMergeHdr={() => setHdrMerging(hdrBrackets(local))}
                  stitchable={panoFrames(sources).length} onMergePano={() => setPanoMerging(panoFrames(sources))}
                  reveal={!hit ? null : hit.remote ? hit.remote.localPath ?? (isRemote(hit) ? null : hit.path) : hit.path}
                  rejected={hit && !isRemote(hit) ? local.filter((i) => i.rejected).length : null}
                  photo={immichBase && hit?.remote ? photoUrl(immichBase, hit.remote.assetId) : null}
                  results={immichBase && immich ? searchUrl(immichBase, immich.search) : null}
                  parentFolder={immichBase && hit?.remote ? hit.remote.localPath : undefined}
                  onImportParent={importImmichParent}
                  onDelete={() => void deleteRejected(local.filter((i) => i.rejected))}
                  editIn={hit && !isRemote(hit) ? plugins.map((cfg) => ({ cfg, why: unfit(cfg, sources) })) : null}
                  onEditIn={(cfg) => void editIn(cfg, sources)} onSetUpPlugins={() => setPrefsOpen("plugins")}
                  onClose={() => setFileMenu(null)} />
      );
    })()}
    <AgxPresetLoader ready={!!current} onPick={(v) => change(controlById.get("profile")!, v)} />
    {prefsOpen && (
      <PreferencesDialog openGenerated={openGenerated} onOpenGenerated={(on) => { storeOpenGenerated(on); setOpenGenerated(on); }} loupe={loupeEnabled} onLoupe={(on) => { storeLoupe(on); setLoupeEnabled(on); loupeEnabledRef.current = on; setLoupePicking(false); setLoupeShown(false); if (on && !gridRef.current) session.current?.requestLoupe(); }} presets={[...BUILTIN_PRESETS, ...presets]} newPhotos={newPhotos}
                         onNewPhotos={(id) => { setNewPhotos(id); storeNewPhotosPreset(id); }}
                         onSaveCurrent={current ? () => setNewPreset("newPhotos") : null}
                         focus={prefsOpen === true ? undefined : prefsOpen}
                         plugins={plugins} onPlugins={setPlugins}
                         canvas={canvasColor} onCanvas={(v) => { setCanvasColor(v); storeCanvas(v); }}
                         overlayColor={overlayColor} onOverlayColor={(v) => { setOverlayColor(v); storeOverlayColor(v); }}
                         guideColor={guideColor} onGuideColor={(v) => { setGuideColor(v); storeGuideColor(v); }}
                         focusMode={focusMode} onFocusMode={(on) => { setFocusMode(on); storeFocusMode(on); }}
                         accel={accel}
                         autoHide={autoHide} onAutoHide={(on) => { setAutoHide(on); storeAutoHide(on); }}
                         stackPairs={stackPairs} onStackPairs={(on) => { setStackPairs(on); storeStackPairs(on); }}
                         perfHud={perfHud} onPerfHud={(on) => { setPerfHud(on); perf.enable(on); }}
                         onBenchmark={current ? () => {
                           setPrefsOpen(false);
                           runGuiBenchmark().then(({ path }) => setStatus(`benchmark saved: ${path}`))
                             .catch((e) => setStatus(`benchmark: ${e}`));
                         } : null}
                         onGpuCheck={current ? () => {
                           setPrefsOpen(false);
                           runGpuCheck().then(({ path, passed, total }) => setStatus(`GPU check saved: ${path} (${passed} of ${total} passed)`))
                             .catch((e) => setStatus(`GPU check: ${e}`));
                         } : null}
                         onTune={current ? () => { setPrefsOpen(false); setTunerOpen(true); } : null}
                         onRelaunch={async () => {
                           await session.current?.close();
                           await commands.engineQuit();
                           await relaunch();
                         }}
                         onClose={() => { session.current?.refreshModuleChoices(); setPrefsOpen(false); }} />
    )}
    {tunerOpen && <PerformanceTuner run={runGuiBenchmark} photo={current?.path} raw={session.current?.raw} previewArea={viewport()}
      onOverlay={setPerfHud}
      onRelaunch={async () => { await session.current?.close(); await commands.engineQuit(); await relaunch(); }}
      onClose={() => { setTunerOpen(false); setPrefsOpen("performance"); }} />}
    <UpdateBanner prepare={async () => {
      // the edit saved now, then the engine stopped, before the installer
      // replaces its files
      await session.current?.close();
      await commands.engineQuit();
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
    {hdrMerging && <HdrDialog count={hdrMerging.length} onRun={(align) => runHdrMerge(hdrMerging, align)}
                              onClose={() => setHdrMerging(null)} />}
    {panoMerging && <PanoDialog photos={panoMerging}
                                onRun={(projection, crop) => runPanoMerge(panoMerging, projection, crop)}
                                onClose={() => setPanoMerging(null)} />}
    {denoising && <DenoiseDialog thumb={navThumb} center={viewCenter()} prepare={denoiseModel}
                                 onRun={(a) => void runDenoise(a)} onClose={() => setDenoising(false)} />}
    {negWarning && (
      <div className="modal-backdrop">
        <div className="modal neg-warn">
          <div className="modal-head"><h2>Film Negative</h2></div>
          <div className="modal-body">
            <p>Converting a negative turns off the tools that work on the photo before it is inverted, or that
              negadoctor's print takes the place of: Temp and Tint, Exposure, Whites, Blacks, Dehaze, Profile and
              Auto, with the tone mapper. The Negative panel's own Exposure, White Point, Blacks and Neutral
              Highlights stand in for them.</p>
            <p>Contrast and Saturation move to color balance rgb, and Highlights and Shadows to shadows and
              highlights, which work after the conversion. Turning the conversion off brings them all back as
              they were.</p>
            <label className="row check">
              <input type="checkbox" checked={negNoWarn} onChange={(e) => setNegNoWarn(e.target.checked)} />
              Don't warn me again
            </label>
          </div>
          <div className="modal-foot">
            <button className="btn" onClick={() => setNegWarning(false)}>Cancel</button>
            <button className="btn primary" autoFocus onClick={() => {
              if (negNoWarn) storeNegWarn(false);
              setNegWarning(false);
              showRight("negative");
            }}>Continue</button>
          </div>
        </div>
      </div>
    )}
    {exclusive && (
      <div className="modal-backdrop">
        <div className="modal neg-warn">
          <div className="modal-head"><h2>{exclusive.title}</h2></div>
          <div className="modal-body"><p>{exclusive.body}</p></div>
          <div className="modal-foot">
            <button className="btn" onClick={() => setExclusive(null)}>Cancel</button>
            <button className="btn primary" autoFocus onClick={() => { const go = exclusive.go; setExclusive(null); go(); }}>
              Continue</button>
          </div>
        </div>
      </div>
    )}
    {exporting && <ExportDialog current={currentEntry} shown={shown.filter((i) => !isRemote(i))} canUpscale={!!accel?.length}
                                selected={shown.filter((i) => selection.has(i.imgid) && !isRemote(i))}
                                onClose={() => setExporting(false)} onKeywordsChanged={reloadKeywords} />}
    </div>
  );
}

// the open photo: its file, and which version of it (a virtual copy's own
// imgid), null until the engine has opened a file named by its path alone
type Opened = { path: string; imgid: number | null };


const PRINT_PLACES = ["top left", "at the top", "top right", "on the left", "in the middle", "on the right",
                      "bottom left", "at the bottom", "bottom right"];

type RightMode = "adjust" | "presets" | "masks" | "heal" | "zones" | "film" | "negative" | "print";
// the photo area a film border pick reads before one is picked: darktable's
// default picker box
const NEG_AREA: [number, number, number, number] = [0.02, 0.02, 0.98, 0.98];
// the Negative panel's eyedroppers for one control each
const NEG_AUTO = { dmax: autoDmax, offset: autoOffset, black: autoBlack, exposure: autoPrintExposure,
                   shadows: autoWbLow, highlights: autoWbHigh };
const NEG_PICK_LABELS: Record<NegPick, string> = {
  border: "Film border", area: "Photo area", dmax: "White Point", offset: "Black Point", black: "Blacks",
  exposure: "Negative Exposure", shadows: "Neutral Shadows", highlights: "Neutral Highlights",
};
// the Library panel's foldable cards; each keeps its open state under
// immage.<id>.open
const LEFT_CARDS = ["metadata", "keywording", "folders", "immich", "history"] as const;
type LeftCard = typeof LEFT_CARDS[number];
const RIGHT_TITLES: Record<RightMode, string> = { adjust: "Adjustments", presets: "Presets", masks: "Masks", heal: "Heal",
                                                  zones: "Zone System", film: "Film Simulation", negative: "Negative",
                                                  print: "Print" };

