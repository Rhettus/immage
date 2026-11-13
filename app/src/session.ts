// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// one open image: control values in Lightroom units, translated to engine
// edits. edits are coalesced: while a render is in flight, further moves
// only mark their module dirty, and the next round sends the latest values once

import { boundFields, choiceCovers, choiceOn, controlById, isModuleSetting, localControlById, localFields, localMaps, mapOf, mapsFor,
         mapsWith, MASK_MODULE_CHOICES, MODULE_CHOICES, modules, CONVERSIONS, conversionsOn, forcedChoice, turnOrientation, turnRect, type ImageContext,
         type ModuleMap, type Params, type Turn, type Values } from "./manifest";
import { loadModuleChoice } from "./moduleChoice";
import { isRefined, neutralLocal, type Mask, type Refine, type Shape } from "./masks";
import { planMerge, type MergePlan } from "./localMerge";
import type { Spot } from "./spots";
import { begin, end, progress } from "./activity";
import { perf, type Trace } from "./perf";
import { FRAME_HEAD, renderFrame } from "./sharedFrames";
import { isDetailControl } from "./detailPreview";
import { advancedCopies, pasteTarget, type AdvancedCopy } from "./advancedEdits";
import type { Preview } from "./Preferences";
import { commands, type GetReply, type HistoryItem, type Instance, type InstanceReply, type ModuleState, type Value } from "./commands";

// one Advanced card's instance: its darktable fields as the client has them
export type AdvancedState = { op: string; priority: number; enabled: boolean; params: Params; defaults: Params };
// a card instance menu action (engine session_instance()); `other` and
// `after` place a move, `name` is a rename's ("" for darktable's own)
export type InstanceAction = { action: "new" | "duplicate" | "rename" | "move" | "delete" | "restore";
                               op: string; priority: number; name?: string; other?: number; after?: boolean };
export type InstanceEntry = { op: string; priority: number; name: string };
export type { ColorProfiles, HistoryItem, ModuleState } from "./commands";
// the typed commands, traced under their Rust names as `invoke` traces the rest
const traced = <T>(command: string, call: () => Promise<T>) => perf.traced<T>(command, call);

export const wbPresets = () => traced("wb_presets", () => commands.wbPresets());
export const colorProfiles = () => traced("color_profiles", () => commands.colorProfiles());

type ModuleRequest = { enabled?: boolean; reset?: boolean; restore?: ModuleState | "opened"; preset?: string };

// the instance a history item is for, and the ModuleMap op its sliders use:
// Immage's own named instances carry their name, as manifest's "op#name"
export const instanceKey = (h: { op: string; priority?: number | null }) => `${h.op}#${h.priority}`;
export const mapOpOf = (h: HistoryItem) => h.label ? `${h.op}#${h.label}` : h.op;
type ModuleInfo = GetReply["modules"][string];

// what to render: the whole image fitted into width x height, or, with a
// scale (1 is 100%), the width x height window at (x, y) of the scaled image
export type View = {
  width: number; height: number; scale?: number; x?: number; y?: number;
  // a smaller frame while a control is dragged, shown enlarged; a full one
  // follows on release
  draft?: boolean;
  detail?: boolean;
  loupe?: boolean;
};

// left out of drag frames, every instance (masks' too), and back on the
// full frame at release: Grain costs about 200 ms a draft frame, Texture and
// Sharpening (diffuse) about 100 and 50 ms (measured with benchmarking/bench.py).
// sharpen costs a few ms, but a drag frame is soft either way, so it goes too.
// the same for every profile; they differ in draft size, not in what a draft
// leaves out
const DRAFT_SKIP: Record<Preview, string[]> = {
  quality: ["grain", "diffuse", "sharpen"],
  balanced: ["grain", "diffuse", "sharpen"],
  performance: ["grain", "diffuse", "sharpen"],
};
// a drag's draft, smaller again each way while darktable takes longer than
// the target on it: an Exposure draft was 65-70 ms of pipeline at half size
// on an M4, and about as long again waiting behind the one before, against
// 20 ms for Contrast (gui-2026-10-28T10-36-27). in fixed steps, as the pipe
// cache keys on the frame's size: a draft at a new size runs the drag pipe
// from the raw. kept by module for the app's run, so its next drag starts
// at the size it ended on
const DRAFT_STEPS = [1, 0.7, 0.5];
const draftSteps = new Map<string, number>();
export type DraftLimits = { target: number; smallest: number };

// left out of the idle base, which lies under the sharp frame and feeds the
// navigator and histogram: with a heavy edit Grain is 1.6 s of it and
// diffuse another 1.1 s on the CPU (measured with benchmarking/bench.py)
const BASE_SKIP: Record<Preview, string[]> = {
  quality: ["grain", "diffuse"],
  balanced: ["grain", "diffuse"],
  performance: ["grain", "diffuse"],
};
// the modules besides flip that move pixels: an edit to one moves the
// shown frame that masks and spots are kept in (flip is turn()'s)
const FRAMING = new Set(["crop", "ashift", "lens"]);
// mask tools whose color balance rgb option is the slider in the mask's
// shared instance, with no choice map of its own (manifest.ts,
// MASK_MODULE_CHOICES): the slider says whether the tool is used, and a mask
// with neither module's instance was made before the choice, on color
// balance rgb (1)
const MASK_SHARED_SLIDER: Record<string, string> = { contrast: "l_contrast", saturation: "l_saturation" };

export type Frame = {
  width: number;
  height: number;
  fullWidth: number;  // the image at 100%, after crops and rotation
  fullHeight: number;
  x: number;          // where the window sits in the scaled image
  y: number;
  view: View;
  pixels: Uint8ClampedArray<ArrayBuffer>;
  hash?: bigint;      // darktable's, the same for the same frame rendered again (render only)
  ms: number;
  before?: boolean;   // rendered with the Before view's settings
  trace?: Trace;      // its timings, for the performance overlay
};

// where a frame is drawn when the image is shown z times its size: k times
// the frame's size, its corner (x, y) screen pixels from the image's.
// darktable's pixel i shows the image at i / scale, at the pixel's corner
// and not its middle, so a frame drawn k times larger sits (k - 1) / 2
// screen pixels right and down of one drawn 1:1: a half-size draft was half
// a pixel off the full frame after it
export function framePlace(f: Pick<Frame, "x" | "y" | "view" | "fullWidth" | "fullHeight">, z: number) {
  // the scale _render (engine/main.c) fits a frame at: its size is rounded
  // down each way, so its width or height alone gives one a little off
  const scale = f.view.scale ?? Math.min(1, f.view.width / f.fullWidth, f.view.height / f.fullHeight);
  const k = z / scale;
  return { k, x: (f.x / scale) * z - (k - 1) / 2, y: (f.y / scale) * z - (k - 1) / 2 };
}

// the module whose instance holds a mask's refinements before it has any
// adjustment
const REFINE_CARRIER = "exposure";

export class Session {
  imgid = 0;
  values: Values = {};
  neutral: Values = {};
  // after the image's sidecar is written, so its thumbnail can be refreshed;
  // `edited` is whether darktable now counts the photo as altered
  onSaved: ((edited: boolean) => void) | null = null;
  // a background save failed (a read-only folder, a full disk): the edit is
  // not in the sidecar until a later save works. without it, onError
  onSaveError: ((error: string) => void) | null = null;
  // what the engine was last told of the Before view
  private engineBefore = false;
  // maps whose module settings the controls cannot represent, such as a tone
  // curve drawn in darktable. their fields are left alone until one of their
  // own controls moves
  foreign = new Set<ModuleMap>();
  private info: Record<string, ModuleInfo> = {};
  private ctx: ImageContext = { sensorWidth: 1, sensorHeight: 1, orientation: 0, camera: 0 };
  private dirty = new Set<string>();
  // ops sent since the last full frame: a drag of Grain or Sharpening still
  // shows them, while any other drag leaves them out (DRAFT_SKIP)
  private draftKeep = new Set<string>();
  private needRender = false;
  private busy = false;
  private backgroundFailure: string | null = null;
  private saveTimer: number | undefined;
  // edits not yet in the sidecar; saving also drops the cached thumbnail,
  // so an untouched image is not saved on close
  private unsaved = false;
  // the engine this session opened its photo in is gone (abandon)
  private dead = false;
  // modules switched off for the moment without touching their settings,
  // such as crop while the crop tool shows the whole image
  private bypassed = new Set<string>();
  // Lightroom's Before view: every control at the image's own default,
  // except those `keep` names (the crop), rendered but never saved
  private before: ((id: string) => boolean) | null = null;
  // the look (a darktable style on extra module instances), by name, and
  // the file it came from when known; the Before view takes it off
  look: string | null = null;
  lookPath: string | null = null;
  private wantLook: string | null | undefined = undefined;
  // how strongly the look applies, 0-100
  lookAmount = 100;
  private wantLookAmount: number | undefined = undefined;
  // masks: the shapes and local values the client edits, and what of them
  // the engine has yet to hear. ops lists the modules each mask has an
  // instance of, so a slider back at zero still reaches its instance
  masks: Mask[] = [];
  private maskOps = new Map<string, Set<string>>();
  private dirtyShapes = new Set<string>();
  private dirtyLocal = new Map<string, Set<string>>();
  private deletedMasks: string[] = [];
  // names the engine knows a mask by, and renames it has yet to hear
  private sentMasks = new Set<string>();
  private renames: [string, string][] = [];
  // a send under way: its queues are already emptied, but the engine has
  // not heard all of it yet
  private sendingMasks = false;
  // masks' shared instances (localMerge.ts) as last sent, by combined mask,
  // and which masks could share then. a photo's first mask edit sends every
  // mask's own instances again, which turns a photo from before sharing
  // into one that shares
  private sentShared = new Map<string, { members: string; params: string }>();
  private couldShare = new Map<string, boolean>();
  private sharing = false;
  // a mask was edited since the photo opened: until then the Before view's
  // resends leave a photo from before sharing as it was
  private edited = false;
  // the mask a drag edits, out of the combined masks on its own instances
  // until the drag ends: changing a member re-renders the whole combined
  // mask, some 9 ms a brush stroke, while the others' stays in darktable's
  // drawn mask cache and their instances' output in the pipe's
  private lifted: string | null = null;
  // heal and clone spots: all of them go whenever one changes, being few
  spots: Spot[] = [];
  // whether the image had an edit when it was opened, which decides whether
  // the new-photos defaults apply
  wasEdited = true;
  // a new photo, whose saves record those defaults as its unedited baseline
  // until the user's first change (endBaseline()), and whether the engine
  // has yet to hear that it came
  private baseline = false;
  private baselineEnd = false;
  // its darktable history when opened: the defaults darktable applies, and
  // any edit kept from before
  history: HistoryItem[] = [];
  // instances the History panel switched, by instanceKey: their state now,
  // and as the photo opened, which undo goes back to
  moduleStates = new Map<string, ModuleState>();
  private modulesOpened = new Map<string, ModuleState>();
  private modulePending: { key: string; op: string; priority: number; req: ModuleRequest }[] = [];
  private resetModulesPending = false;
  // those deleted: switched off, and gone from the history at the next save
  // (the engine's _prune_off), or reset if darktable starts them on
  deleted = new Set<string>();
  // every instance asked for, at once: moduleStates follows only the replies
  touched = new Set<string>();
  onModules: (() => void) | null = null;
  // per tool, the module values that held edits when the photo opened, and
  // the module chosen then: those edits stay flagged only while it is shown
  usedModules: Record<string, number[]> = {};
  private openedModule: Record<string, number> = {};
  // per tool, the last module shown that shares the tool's sliders
  private sharedHolder: Record<string, number> = {};
  // the tool's modules that hold adjustments, the shown one included: those
  // the photo opened with, and those whose own sliders are away from neutral
  // (switching away from them leaves those edits unapplied). A tool with its
  // own sliders hides the shared one (Contrast under the equalizer) without
  // applying it: the module that held it keeps the edit. Modules that share
  // the sliders hold them only while shown
  adjustedModules(control: string): number[] {
    const c = MODULE_CHOICES.find((x) => x.control === control);
    if (!c) return [];
    const cur = this.values[control];
    const off = (id: string) => Math.abs((this.values[id] ?? 0) - (this.neutral[id] ?? 0)) > 1e-6;
    const out = new Set<number>(this.openedModule[control] === cur ? this.usedModules[control] ?? [] : []);
    for (const o of c.options) if (o.controls.some(off)) out.add(o.value);
    const ownIds = new Set(c.options.flatMap((o) => o.controls));
    if ((c.covers ?? []).some((id) => !ownIds.has(id) && off(id))) {
      const here = c.options.find((o) => o.value === cur);
      out.add(here && !here.controls.length ? cur : this.sharedHolder[control] ?? c.options.find((o) => !o.controls.length)!.value);
    }
    return [...out];
  }
  // a raw file rather than a JPEG, HEIC or other rendered one
  raw = true;
  private spotsDirty = false;
  // whether the engine has them on: the Before view takes them off
  private spotsOn = true;
  // masks and spots are kept in the shown frame, which a turn, a crop or a
  // lens or perspective correction changes; they are read back from the
  // engine once it has the new one
  private reshape = false;
  onShapes: (() => void) | null = null;

  // the photo's white balance is set in the white balance module with color
  // calibration off: temperature on, its setting neither camera reference nor
  // as shot to reference (wb.c's wb_setting 3 and 4), channelmixerrgb off.
  // the panels note it; refreshWb keeps it current (see changed)
  wbInModule = false;
  private wbTimer: ReturnType<typeof setTimeout> | undefined;
  async refreshWb() {
    clearTimeout(this.wbTimer);
    // a batch's background session shows no panels
    if (this.dead || this.background) return;
    let now = false;
    try {
      const r = await traced("get_params", () => commands.getParams({ temperature: ["wb_setting"], channelmixerrgb: ["illuminant"] }));
      const t = r.modules.temperature, c = r.modules.channelmixerrgb;
      now = !!t?.enabled && ![3, 4].includes(t.params.wb_setting) && !c?.enabled;
    } catch { return; }
    if (now === this.wbInModule || this.dead) return;
    this.wbInModule = now;
    this.onModules?.();
  }

  constructor(
    private size: () => View,
    private onFrame: (f: Frame) => void,
    private onError: (e: string) => void,
    private background = false,
  ) {}

  // `imgid` picks one of the file's versions; without it, the original
  static async open(path: string, imgid: number | null, size: Session["size"], onFrame: Session["onFrame"],
                    onError: Session["onError"], background = false): Promise<Session> {
    const opened = await traced("open_image", () => commands.openImage(path, imgid !== null && imgid > 0 ? imgid : null));
    const s = new Session(size, onFrame, onError, background);
    s.imgid = opened.imgid;
    s.wasEdited = !opened.fresh;
    s.baseline = opened.fresh;
    s.raw = opened.raw;
    s.look = opened.look;
    s.lookAmount = opened.look_amount;
    const reply = await traced("get_params", () => commands.getParams(boundFields()));
    s.info = reply.modules;
    s.history = await traced("history", () => commands.history(null));
    // flip's own setting wins; -1 means "as the camera recorded it"
    const flip = s.info.flip;
    s.ctx = {
      sensorWidth: opened.sensor_width,
      sensorHeight: opened.sensor_height,
      orientation: flip?.enabled && flip.params.orientation >= 0 ? flip.params.orientation : opened.orientation,
      camera: opened.orientation,
    };
    // a conversion (a negative, a film simulation) keeps its modules off
    // with their settings, for when it is turned back: their sliders are
    // read as if they were on
    for (const conv of CONVERSIONS) {
      if (!s.info[conv.op]?.enabled) continue;
      // the first instance's entry carries darktable's preset label, if any
      const used = new Set(s.history.flatMap((h) => [mapOpOf(h), h.op]));
      for (const op of conv.off) if (s.info[op] && used.has(op)) s.info[op] = { ...s.info[op], enabled: true };
    }
    for (const m of modules) {
      const info = s.info[m.op];
      const fromDefaults = m.read(info.defaults, info.defaults, s.ctx);
      const current = info.enabled ? m.read(info.params, info.defaults, s.ctx, s.values) : {};
      for (const id of m.controls) {
        const c = controlById.get(id)!;
        const neutral = c.neutral ?? fromDefaults[id];
        s.neutral[id] = neutral;
        if (info.enabled && current[id] === undefined) s.foreign.add(m);
        // a control several maps share takes its value from the one whose
        // module is on
        if (current[id] !== undefined || s.values[id] === undefined)
          s.values[id] = s.snap(id, current[id] ?? neutral, neutral);
      }
    }
    await s.loadMasks();
    s.chooseModules();
    s.spots = await traced("spots", () => commands.spots(null));
    await s.refreshWb();
    s.requestRender();
    return s;
  }

  // Batch operations reopen the same engine image without starting a new UI
  // editing history. Earlier native-module undo steps still refer to the
  // original opening state, not to the freshly loaded pasted state.
  inheritUndo(from: Session) {
    if (from.imgid !== this.imgid) return;
    this.modulesOpened = new Map(from.modulesOpened);
    this.moduleStates = new Map(from.moduleStates);
    this.touched = new Set(from.touched);
    this.deleted = new Set(from.deleted);
  }

  // a tool's module: the one the photo uses, else what Preferences picks,
  // which a photo not yet edited always takes. a module that is on but
  // leaves the tool's sliders at neutral is not used: AgX is on for every
  // photo, whether or not it carries Contrast. the tool's sliders are then
  // read from the chosen module alone
  private chooseModules() {
    for (const c of MODULE_CHOICES) {
      const pick = loadModuleChoice(c.id);
      this.neutral[c.control] = pick;
      const covers = choiceCovers(c);
      const reads = (m: ModuleMap) => {
        const info = this.info[m.op];
        return info?.enabled && !this.foreign.has(m) ? m.read(info.params, info.defaults, this.ctx, this.values) : null;
      };
      const ofOption = (o: number) => modules.filter((m) => m.choice?.control === c.control && m.choice.value === o);
      const usedAll = c.options.filter((o) =>
        ofOption(o.value).some((m) => {
          const r = reads(m);
          return r && covers.some((id) => id in r && Math.abs(r[id] - (this.neutral[id] ?? 0)) > 1e-6);
        }));
      const used = usedAll[0];
      this.usedModules[c.control] = usedAll.map((o) => o.value);
      // a conversion's tools run on modules it keeps, whatever the photo holds
      const value = forcedChoice(this.values, c.control) ?? (this.wasEdited && used ? used.value : pick);
      this.values[c.control] = value;
      this.openedModule[c.control] = value;
      // only the chosen module's maps say what the shared sliders hold
      for (const id of covers) if (id in this.neutral) this.values[id] = this.neutral[id];
      for (const m of ofOption(value)) {
        const r = reads(m);
        for (const id of covers) if (r && id in r) this.values[id] = this.snap(id, r[id], this.neutral[id]);
      }
    }
  }

  // the modules Preferences picks for each tool, which Reset returns a photo to
  preferredModules(): [string, number][] {
    return MODULE_CHOICES.map((c) => [c.control, this.neutral[c.control] = loadModuleChoice(c.id)]);
  }

  // Refresh unused tools without replacing any current global or masked edits.
  refreshModuleChoices() {
    for (const c of MODULE_CHOICES) {
      const current = this.values[c.control];
      const option = c.options.find((o) => o.value === current);
      const controls = c.covers ?? option?.controls ?? [];
      const used = modules.some((m) => m.choice?.control === c.control && this.foreign.has(m))
        || controls.some((id) => Math.abs((this.values[id] ?? 0) - (this.neutral[id] ?? 0)) > 1e-6);
      const pick = loadModuleChoice(c.id);
      this.neutral[c.control] = pick;
      if (!used && forcedChoice(this.values, c.control) === undefined) this.set(c.control, pick);
    }
    this.masks = this.masks.map((mask) => {
      const values = { ...mask.values };
      for (const c of MASK_MODULE_CHOICES) {
        const maps = localMaps.filter((m) => m.choice?.control === c.control);
        const shared = MASK_SHARED_SLIDER[c.id];
        const ids = shared ? [shared, ...maps.flatMap((m) => m.controls)] : maps.flatMap((m) => m.controls);
        const used = ids.some((id) =>
          Math.abs((values[id] ?? 0) - (localControlById.get(id)?.neutral ?? 0)) > 1e-6);
        if (!used) values[c.control] = loadModuleChoice(c.id, "masks");
      }
      return { ...mask, values };
    });
    this.onShapes?.();
    this.onModules?.();
  }

  // round onto the control's step, and let float noise read as neutral
  private snap(id: string, v: number, neutral: number): number {
    const c = controlById.get(id)!;
    if (!Number.isFinite(v) || Math.abs(v - neutral) < c.step / 2) return neutral;
    const snapped = c.slider ? v : Math.round(v / c.step) * c.step;
    return c.readsPast ? snapped : Math.min(c.max, Math.max(c.min, snapped));
  }

  set(id: string, v: number, coalesce = false) {
    if (!mapOf.has(id) || this.values[id] === v) return;
    perf.input(id);
    this.activeDetailControl = this.size().draft && isDetailControl(id) ? id : null;
    this.onDetailControl?.(this.activeDetailControl);
    const choice = MODULE_CHOICES.find((c) => c.control === id);
    const was = choice?.options.find((o) => o.value === this.values[id]);
    if (was && !was.controls.length) this.sharedHolder[id] = was.value;
    this.values[id] = v;
    if (id === "orient") this.orient(v);
    this.conversionChanged(id);
    for (const m of mapsWith(id)) {
      this.foreign.delete(m);
      this.dirty.add(m.op);
    }
    this.needRender = true;
    this.submitEdits(coalesce);
  }

  private editFrame: number | null = null;
  private coalesceWait?: number;
  private submitEdits(coalesce: boolean) {
    // An in-flight job already batches input until it completes. Leave no
    // animation callback blocking its next round once the engine is free.
    // flushEdits also lets the busy pump cancel an obsolete base immediately.
    if (!coalesce || this.busy) { this.flushEdits(); return; }
    if (this.editFrame === null) this.coalesceWait = perf.begin("coalesce", { blockingPump:true });
    this.editFrame ??= window.requestAnimationFrame(() => this.flushEdits());
  }
  flushEdits() {
    perf.finish(this.coalesceWait); this.coalesceWait = undefined;
    if (this.editFrame !== null) window.cancelAnimationFrame(this.editFrame);
    this.editFrame = null;
    void this.pump();
  }

  // a conversion (a negative, a film simulation) turned on or back: the
  // modules it turns off are sent again, switched off or back as their
  // sliders have them. one darktable set beyond its sliders is switched by
  // the panel (setModuleState)
  private conversionChanged(id: string) {
    const conv = CONVERSIONS.find((c) => c.flag === id);
    if (!conv) return;
    // converting leaves a module that is already off alone: an entry
    // switching it off would read, opened again, as one the conversion holds
    // and turned back would switch it on (open)
    const converting = this.values[id] === 1;
    for (const op of conv.off)
      if (mapsFor(op).some((m) => !this.foreign.has(m)) && (!converting || this.info[op]?.enabled)) this.dirty.add(op);
  }

  // the image's frame turned: modules after flip write their values for it
  private orient(o: number) {
    this.ctx = { ...this.ctx, orientation: o };
    for (const m of modules) if (m.frame === "shown" && !this.foreign.has(m)) this.dirty.add(m.op);
  }

  // the changes that turn or mirror the image: the orientation, the crop
  // carried along, and the controls of modules ahead of flip read again in
  // the new frame, as their params stay
  turned(how: Turn): [string, number][] {
    const v = this.values;
    const orient = turnOrientation(v.orient, how);
    const next = { ...this.ctx, orientation: orient };
    const crop = turnRect({ l: v.crop_l, t: v.crop_t, r: v.crop_r, b: v.crop_b }, how);
    const out: Values = { orient, crop_l: crop.l, crop_t: crop.t, crop_r: crop.r, crop_b: crop.b };
    for (const m of modules) {
      if (m.frame !== "sensor" || this.foreign.has(m)) continue;
      const defaults = this.info[m.op].defaults;
      const read = m.read(m.write(v, defaults, this.ctx), defaults, next);
      for (const id of m.controls) out[id] = this.snap(id, read[id], this.neutral[id]);
    }
    return Object.entries(out).filter(([id, x]) => x !== v[id]);
  }

  // masks and spots read back once the engine has the frame
  reloadShapes() {
    this.reshape = true;
    void this.pump();
  }

  // the user's first change to the photo, called before it is set: the
  // engine hears of it ahead of the change, in the pump's order
  endBaseline() {
    if (!this.baseline) return;
    this.baseline = false;
    this.baselineEnd = true;
    void this.pump();
  }

  // nothing queued or in flight
  async settled() {
    while (!this.idle && !this.dead) {
      if (this.backgroundFailure && !this.busy) throw Error(this.backgroundFailure);
      await new Promise((r) => setTimeout(r, 20));
    }
    if (this.backgroundFailure) throw Error(this.backgroundFailure);
  }

  bypass(op: string, on: boolean) {
    if (on) this.bypassed.add(op); else this.bypassed.delete(op);
    this.dirty.add(op);
    this.needRender = true;
    void this.pump();
  }

  // the open photo's sensor and orientation, as the module maps read them
  get context() { return this.ctx; }

  // nothing queued or rendering: the engine is free for other work
  get idle() {
    return !this.busy && !this.dirty.size && !this.needRender && !this.needThumb && !this.needCopy && !this.needWarm
      && !this.fitView && this.wantLook === undefined && !this.masksPending && this.wantLookAmount === undefined
      && !this.spotsPending && !this.reshapeDue && !this.baselineEnd && !this.baseInFlight
      && !this.modulePending.length && !this.resetModulesPending;
  }

  // not while crop is bypassed or the Before view is up: the one changes
  // the frame, the other the mask values read back
  private get reshapeDue() {
    return this.reshape && !this.bypassed.size && !this.before;
  }

  private get spotsPending() {
    return this.spotsDirty || this.spotsOn !== !this.before;
  }

  // the engine's view changed with no edit (the soft proof): the frames
  // shown so far are of the view before
  redraw() {
    this.changed();
    this.needRender = true;
    void this.pump();
  }

  setSpots(spots: Spot[]) {
    this.spots = spots;
    this.spotsDirty = true;
    this.needRender = true;
    void this.pump();
  }

  // mask changes the engine has yet to hear
  get masksPending() {
    return this.sendingMasks || this.dirtyShapes.size > 0 || this.dirtyLocal.size > 0 || this.deletedMasks.length > 0
      || this.renames.length > 0 || (this.lifted !== null && !this.size().draft);
  }

  // the masks the image's history holds, as the client shows them
  private async loadMasks() {
    const raw = await traced("masks", () => commands.masks(localFields()));
    // the combined masks the photo has, sent again (or emptied) on its
    // first mask edit
    for (const r of raw) for (const g of r.merged_in ?? []) this.sentShared.set(g, { members: "", params: "" });
    this.masks = raw.map((r) => {
      const values = neutralLocal();
      const neutral = { ...values };
      for (const c of MASK_MODULE_CHOICES) {
        const hasOption = (value: number, enabled: boolean) => localMaps.some((m) =>
          m.choice?.control === c.control && m.choice.value === value
          && r.instances[m.op] && (!enabled || r.instances[m.op].enabled));
        const used = c.options.find((o) => hasOption(o.value, true))
          ?? c.options.find((o) => hasOption(o.value, false));
        values[c.control] = used?.value ?? (MASK_SHARED_SLIDER[c.id] ? 1 : loadModuleChoice(c.id, "masks"));
      }
      // an instance that is off holds neutral values, unless its mask is
      // hidden or shares instances: then all are off and some still hold
      // the mask's settings
      for (const m of localMaps) {
        const inst = r.instances[m.op];
        if (inst) Object.assign(values, m.read(inst.params, {}, this.ctx));
      }
      for (const [id, v] of Object.entries(values)) values[id] = /^(l_detail_|ce_|sc_|sb_)/.test(id) ? v : Math.round(v * 100) / 100;
      const insts = Object.values(r.instances);
      const hidden = insts.length > 0 && insts.every((i) => !i.enabled) && !r.merged_in?.length
        && Object.entries(values).some(([id, v]) => id in neutral && v !== neutral[id]);
      this.maskOps.set(r.name, new Set(Object.keys(r.instances)));
      this.sentMasks.add(r.name);
      return { name: r.name, shapes: r.shapes as Shape[], invert: r.invert, opacity: Math.round(r.opacity ?? 100),
               ...(hidden ? { hidden } : {}), ...(r.refine ? { refine: r.refine } : {}), values };
    });
  }

  private mask(name: string) { return this.masks.find((m) => m.name === name); }

  addMask(name: string, shapes: Shape[]) {
    this.masks = [...this.masks, { name, shapes, invert: false, values: { ...neutralLocal(), ...Object.fromEntries(
      MASK_MODULE_CHOICES.map((c) => [c.control, loadModuleChoice(c.id, "masks")])) } }];
    this.edited = true;
    this.dirtyShapes.add(name);
    this.needRender = true;
    void this.pump();
  }

  setShapes(name: string, shapes: Shape[]) {
    this.masks = this.masks.map((m) => (m.name === name ? { ...m, shapes } : m));
    this.edited = true;
    this.dirtyShapes.add(name);
    this.needRender = true;
    void this.pump();
  }

  // every map of the control: Highlights and Shadows have one per module the
  // photo's tool can be on, and pump() sends only the chosen one
  setLocal(name: string, id: string, v: number) {
    this.activeDetailControl = this.size().draft && isDetailControl(id) ? id : null;
    this.onDetailControl?.(this.activeDetailControl);
    const ops = localMaps.filter((m) => m.controls.includes(id) || m.choice?.control === id
      || ((id === "mod_contrast" || id === "mod_saturation") && m.op === "colorbalancergb")).map((m) => m.op);
    if (!ops.length) return;
    this.masks = this.masks.map((m) => (m.name === name ? { ...m, values: { ...m.values, [id]: v } } : m));
    this.markLocal(name, ops);
  }

  setInvert(name: string, invert: boolean) {
    this.masks = this.masks.map((m) => (m.name === name ? { ...m, invert } : m));
    this.markLocal(name, [...(this.maskOps.get(name) ?? [])]);
  }

  setOpacity(name: string, opacity: number) {
    this.masks = this.masks.map((m) => (m.name === name ? { ...m, opacity } : m));
    this.markLocal(name, [...(this.maskOps.get(name) ?? [])]);
  }

  setHidden(name: string, hidden: boolean) {
    this.masks = this.masks.map((m) => (m.name === name ? { ...m, hidden } : m));
    // a module first adjusted while hidden was never sent, being off: showing
    // the mask goes over every module, and sendMaskQueues skips those that
    // stay off and it never had
    this.markLocal(name, [...new Set([...(this.maskOps.get(name) ?? []), ...localMaps.map((l) => l.op)])]);
  }

  setRefine(name: string, refine: Refine) {
    this.masks = this.masks.map((m) => (m.name === name ? { ...m, refine } : m));
    const ops = this.maskOps.get(name);
    this.markLocal(name, ops?.size ? [...ops] : [REFINE_CARRIER]);
  }

  // a copy of mask `name` as `to`, with its own instances. without
  // `adjustments` only the mask is copied (shape, invert, opacity, refine),
  // its adjustments starting as those of a new mask
  duplicateMask(name: string, to: string, adjustments = true) {
    const m = this.mask(name);
    if (!m) return;
    if (adjustments) {
      this.masks = [...this.masks, { ...structuredClone(m), name: to }];
      this.dirtyShapes.add(to);
      this.markLocal(to, [...(this.maskOps.get(name) ?? [])]);
      return;
    }
    const { shapes, invert, opacity, refine } = structuredClone(m);
    this.masks = [...this.masks, { name: to, shapes, invert, opacity, ...(refine ? { refine } : {}),
      values: { ...neutralLocal(), ...Object.fromEntries(
        MASK_MODULE_CHOICES.map((c) => [c.control, loadModuleChoice(c.id, "masks")])) } }];
    this.edited = true;
    this.dirtyShapes.add(to);
    // the refinement rides on an instance's blend parameters
    if (isRefined(m)) { this.markLocal(to, [REFINE_CARRIER]); return; }
    this.needRender = true;
    void this.pump();
  }

  // every adjustment of the mask back to neutral, its tool choices, shape,
  // invert, opacity, refine and hidden kept
  resetMaskAdjustments(name: string) {
    const m = this.mask(name);
    if (!m) return;
    const keep = Object.fromEntries(MASK_MODULE_CHOICES.map((c) => [c.control, m.values[c.control]]));
    this.masks = this.masks.map((x) => (x.name === name ? { ...x, values: { ...neutralLocal(), ...keep } } : x));
    this.markLocal(name, [...(this.maskOps.get(name) ?? [])]);
  }

  // a mask under a new name; one the engine has not yet heard of is only
  // renamed here
  renameMask(name: string, to: string) {
    this.masks = this.masks.map((m) => (m.name === name ? { ...m, name: to } : m));
    const move = <V>(map: Map<string, V>) => {
      const v = map.get(name);
      if (v !== undefined) { map.delete(name); map.set(to, v); }
    };
    move(this.maskOps);
    move(this.dirtyLocal);
    if (this.lifted === name) this.lifted = to;
    if (this.dirtyShapes.delete(name)) this.dirtyShapes.add(to);
    if (this.sentMasks.delete(name)) {
      this.edited = true;
      this.sentMasks.add(to);
      this.renames.push([name, to]);
      this.needRender = true;
      void this.pump();
    }
  }

  deleteMask(name: string) {
    this.masks = this.masks.filter((m) => m.name !== name);
    this.dirtyShapes.delete(name);
    this.dirtyLocal.delete(name);
    this.maskOps.delete(name);
    if (this.lifted === name) this.lifted = null;
    // one the engine never had needs no word to it
    if (this.sentMasks.has(name)) this.deletedMasks.push(name);
    this.edited = true;
    this.needRender = true;
    void this.pump();
  }

  private markLocal(name: string, ops: string[]) {
    const set = this.dirtyLocal.get(name) ?? new Set<string>();
    ops.forEach((op) => set.add(op));
    this.dirtyLocal.set(name, set);
    this.edited = true;
    this.needRender = true;
    void this.pump();
  }

  // the engine calls for a mask's pending changes; false when nothing went
  private async sendMasks(): Promise<boolean> {
    this.sendingMasks = true;
    try {
      return await this.sendMaskQueues();
    } finally {
      this.sendingMasks = false;
    }
  }

  private async sendMaskQueues(): Promise<boolean> {
    let sent = false;
    const reshaped = new Set<string>();
    // renames first: what follows is sent under the new names. again until
    // none is left, so a mask added or renamed while these await the engine
    // is there before the instances below attach to it
    do {
      for (const [name, to] of this.renames.splice(0)) {
        await traced("mask_rename", () => commands.maskRename(name, to));
        sent = true;
      }
      for (const name of this.deletedMasks.splice(0)) {
        this.sentMasks.delete(name);
        await traced("mask_delete", () => commands.maskDelete(name));
        sent = true;
      }
      for (const name of [...this.dirtyShapes]) {
        this.dirtyShapes.delete(name);
        const m = this.mask(name);
        if (!m) continue;
        reshaped.add(name);
        await traced("mask_shapes", () => commands.maskShapes(name, m.shapes as unknown as Value[]));
        this.sentMasks.add(name);
        sent = true;
      }
    } while (this.renames.length || this.deletedMasks.length || this.dirtyShapes.size);
    const touched = [...new Set([...this.dirtyLocal.keys(), ...reshaped])];
    // which masks share instances now. one that can share no more (a range
    // added), or now can, sends its own instances of merged modules again;
    // on the first edit, every mask does. a photo from before sharing,
    // its masks unedited, keeps its own instances
    // a drag's mask is lifted out (`lifted`) and joins again when it ends
    if (!this.size().draft) this.lifted = null;
    else if (touched.length === 1) this.lifted = touched[0];
    const old = !this.sharing && !this.edited && !this.sentShared.size;
    const plan: MergePlan = old ? { merged: new Map(), shared: [] }
      : planMerge(this.masks.map((m) => (m.name === this.lifted ? { ...m, hidden: true } : m)),
                  this.values, !!this.before, this.ctx);
    if (this.lifted) plan.merged.delete(this.lifted);
    const mergedOps = localMaps.filter((l) => l.merge).map((l) => l.op);
    for (const m of old ? [] : this.masks) {
      const can = plan.merged.has(m.name);
      if (this.sharing && this.couldShare.get(m.name) === can) continue;
      this.couldShare.set(m.name, can);
      const have = this.maskOps.get(m.name);
      const ops = mergedOps.filter((op) => have?.has(op) || localMaps.some((l) => l.op === op
        && l.controls.some((id) => m.values[id] !== 0)));
      if (ops.length) {
        const set = this.dirtyLocal.get(m.name) ?? new Set<string>();
        ops.forEach((op) => set.add(op));
        this.dirtyLocal.set(m.name, set);
      }
    }
    this.sharing ||= !old;
    // the changes the plan saw: one made while this round awaits the engine
    // stays for the next, which plans again
    const local = [...this.dirtyLocal];
    this.dirtyLocal.clear();
    for (const [name, ops] of local) {
      const m = this.mask(name);
      if (!m) continue;
      const have = this.maskOps.get(name) ?? new Set<string>();
      for (const op of ops) {
        // an instance no control maps any more, such as sharpen from before
        // Sharpness moved to diffuse, is left as it is
        const map = localMaps.find((l) => l.op === op);
        if (!map) continue;
        // the Before view shows the image without its masks
        // a module the photo's tool no longer runs on (MODULE_CHOICES) stays
        // off
        // a mask sharing an instance keeps its own off, holding its settings
        const holds = map.enabled ? map.enabled(m.values)
          : map.controls.some((id) => m.values[id] !== (localControlById.get(id)?.neutral ?? 0));
        const shares = plan.merged.get(name)?.has(op) ?? false;
        const on = !shares && !this.before && !m.hidden && choiceOn(map, { ...this.values, ...m.values }) && holds;
        // refinements live in an instance's blend parameters: a mask with
        // none yet gets one that is off to hold them, which the overlay's
        // mask_map then uses
        const carrier = !have.size && op === REFINE_CARRIER && isRefined(m);
        if (!on && !(shares && holds) && !have.has(op) && !carrier) continue;
        // "op#tag" is the mask's instance named "<mask>#tag"
        const [real, tag] = op.split("#");
        this.draftKeep.add(real);
        await traced("set_params", () => commands.setParams({
          op: real, params: map.write(m.values, {}, this.ctx), enabled: on,
          instance: tag ? `${name}#${tag}` : name, mask: name, invert: m.invert,
          opacity: m.opacity ?? 100, refine: m.refine ?? null }));
        have.add(op);
        sent = true;
      }
      this.maskOps.set(name, have);
    }
    // the shared instances, after the masks' own: what changed of them. a
    // combined mask left with no masks switches its instance off
    const want = new Set(plan.shared.map((s) => s.group));
    for (const group of [...this.sentShared.keys()]) {
      if (want.has(group)) continue;
      await traced("combine", () => commands.combine(group, [], null));
      this.sentShared.delete(group);
      sent = true;
    }
    for (const s of plan.shared) {
      const was = this.sentShared.get(s.group);
      const members = JSON.stringify([s.members, s.ranges]), params = JSON.stringify([s.params, s.refine]);
      // the members first: the instance's mask must be there to attach to
      if (was?.members !== members)
        await traced("combine", () => commands.combine(s.group, s.members, s.ranges as unknown as Value[]));
      if (was?.params !== params) {
        const [real] = s.op.split("#");
        this.draftKeep.add(real);
        await traced("set_params", () => commands.setParams({
          op: real, params: s.params, enabled: true, instance: s.instance,
          mask: s.group, invert: false, opacity: 100, refine: s.refine }));
      }
      sent ||= was?.members !== members || was?.params !== params;
      this.sentShared.set(s.group, { members, params });
    }
    return sent;
  }

  setLookAmount(v: number) {
    this.lookAmount = v;
    this.wantLookAmount = v;
    this.needRender = true;
    void this.pump();
  }

  // put a look on, or with null take it off
  setLook(path: string | null, name: string | null) {
    this.look = name;
    this.lookPath = path;
    this.lookAmount = 100;
    if (this.before) return;
    this.wantLook = path;
    this.needRender = true;
    void this.pump();
  }

  // a small render of the image with `values` changed and, when `look` is
  // given, that look (a path, or null for none) in place of the current
  // one. the edit itself is untouched
  async preview(size: number, values: Values, look?: string | null): Promise<Frame> {
    const changed = Object.keys(values).filter((id) => mapOf.has(id));
    const merged = { ...this.sent(), ...values };
    const touched = new Set(changed.flatMap((id) => mapsWith(id)));
    const ops = [...new Set([...touched].map((m) => m.op))];
    // a named instance is made and placed as for an edit, if the preview
    // switches it on
    const edits = ops.map((op) => this.moduleEdit(op, merged, (m) => this.foreign.has(m) && !touched.has(m)));
    const t0 = performance.now();
    const buf = await traced("preview", () => commands.preview(size, edits, look !== undefined, look ?? null));
    const head = new DataView(buf, 0, 8);
    const width = head.getUint32(0, true), height = head.getUint32(4, true);
    return { width, height, fullWidth: width, fullHeight: height, x: 0, y: 0, view: { width, height },
             pixels: new Uint8ClampedArray(buf, 8), ms: performance.now() - t0 };
  }

  // show the image as it was before any edit, or back as edited
  showBefore(keep: ((id: string) => boolean) | null) {
    this.before = keep;
    // the look goes with the edit; without its file it cannot come back
    if (this.look && this.lookPath) this.wantLook = keep ? null : this.lookPath;
    for (const [name, ops] of this.maskOps) this.dirtyLocal.set(name, new Set(ops));
    for (const m of modules) this.dirty.add(m.op);
    this.needRender = true;
    void this.pump();
  }

  // the values the engine is sent: in the Before view, the neutral ones
  private sent(): Values {
    const keep = this.before;
    if (!keep) return this.values;
    return Object.fromEntries(Object.keys(this.values).map((id) =>
      [id, keep(id) ? this.values[id] : this.neutral[id]]));
  }

  // edits not yet rendered
  get pending() {
    return this.dirty.size > 0 || this.needRender;
  }

  // several controls at once, as one round of edits (a point curve drag)
  setMany(entries: [string, number][], coalesce = false) {
    entries = [...new Map(entries)].filter(([id, v]) => mapOf.has(id) && this.values[id] !== v);
    if (!entries.length) return;
    perf.input(entries.map(([id]) => id));
    this.activeDetailControl = null;
    this.onDetailControl?.(null);
    for (const [id, v] of entries) {
      if (!mapOf.has(id)) continue;
      this.values[id] = v;
      if (id === "orient") this.orient(v);
      this.conversionChanged(id);
      for (const m of mapsWith(id)) {
        this.foreign.delete(m);
        this.dirty.add(m.op);
      }
    }
    this.needRender = true;
    this.submitEdits(coalesce);
  }

  onDetailControl: ((id:string|null) => void) | null = null;
  private activeDetailControl: string | null = null;
  requestRender() {
    if (this.editFrame !== null) window.cancelAnimationFrame(this.editFrame);
    perf.finish(this.coalesceWait, "interrupted"); this.coalesceWait = undefined;
    this.editFrame = null;
    this.activeDetailControl = null;
    this.onDetailControl?.(null);
    this.needRender = true;
    void this.pump();
  }

  // Reset native parameters too: slider writes cover only part of a module.
  // Replay all mapped controls afterwards, including the settings Reset keeps.
  resetModules() {
    this.resetModulesPending = true;
    this.needRender = true;
    void this.pump();
  }

  // a history item's instance switched, reset, or restored for undo
  // ("opened": as the photo opened)
  setModuleState(h: { op: string; priority?: number | null }, req: ModuleRequest) {
    if (h.priority == null) return;
    this.touched.add(instanceKey(h));
    this.modulePending.push({ key: instanceKey(h), op: h.op, priority: h.priority, req });
    void this.pump();
  }

  // Advanced mode's module cards: the open photo's instances (pipe order),
  // and the settings of each card loaded, by instanceKey, as darktable's own
  // introspection fields. kept here rather than in React so undo snapshots
  // them like `values`, and edits reach the engine through the pump
  instances: Instance[] = [];
  advanced = new Map<string, AdvancedState>();
  private advancedFields = new Map<string, string[]>();
  private advancedDirty = new Map<string, { op: string; priority: number; params: Params }>();
  // cards whose instance another edit changed (a Simple slider on the same
  // module, a reset): read back once the engine has it
  private advancedStale = new Set<string>();

  // once per photo, however many groups ask
  private instancesLoad: Promise<Instance[]> | null = null;
  loadInstances() {
    return this.instancesLoad ??= traced("instances", () => commands.instances()).then((list) => this.instances = list);
  }

  // a card's settings from the engine; fields are the schema's paths
  async loadAdvanced(op: string, priority: number, fields: string[]) {
    const key = `${op}#${priority}`;
    this.advancedFields.set(key, fields);
    const reply = await traced("get_params", () => commands.getParams({ [`${op}@${priority}`]: fields }));
    const info = reply.modules[`${op}@${priority}`];
    if (info) this.advanced.set(key, { op, priority, enabled: info.enabled, params: { ...info.params }, defaults: { ...info.defaults } });
    return this.advanced.get(key);
  }

  // darktable fields of an instance, as one card edit sets them (editOf in
  // advancedLayout.ts); an edit switches the module on, as in darktable
  setFields(op: string, priority: number, params: Params, coalesce = false) {
    this.setAdvanced(op, priority, params, true, coalesce);
  }

  setAdvancedEnabled(op: string, priority: number, on: boolean) {
    this.setAdvanced(op, priority, {}, on);
  }

  // undo: put the cards back as a snapshot had them, after any module
  // state it restores (the pump sends module_state first)
  restoreAdvanced(target: Map<string, AdvancedState>) {
    for (const [key, want] of target) {
      const now = this.advanced.get(key);
      if (!now) continue;
      const params = Object.fromEntries(Object.entries(want.params).filter(([p, x]) => now.params[p] !== x));
      if (Object.keys(params).length || want.enabled !== now.enabled)
        this.setAdvanced(want.op, want.priority, params, want.enabled);
    }
  }

  // cards that stay shown for this photo though their module is off and not
  // in the history yet: added from Add module, or changed in this session
  cardsShown = new Set<string>();

  // Add module: the module's first instance, switched on, as darktable's
  // module groups do when you enable one
  addModule(op: string) {
    this.cardsShown.add(`${op}#0`);
    this.lastAdded = `${op}#0`;
    this.setAdvanced(op, 0, {}, true);
  }

  // a shared card's module switch (the tone mappers): this instance off,
  // the other module's first instance on; the old one keeps its settings
  switchModule(op: string, priority: number, to: string) {
    this.cardsShown.add(`${to}#0`);
    this.lastAdded = `${to}#0`;
    this.setAdvanced(op, priority, {}, false);
    this.setAdvanced(to, 0, {}, true);
  }

  private setAdvanced(op: string, priority: number, params: Params, enabled: boolean, coalesce = false) {
    const key = `${op}#${priority}`;
    this.cardsShown.add(key);
    const card = this.advanced.get(key);
    if (card) this.advanced.set(key, { ...card, enabled, params: { ...card.params, ...params } });
    const queued = this.advancedDirty.get(key);
    this.advancedDirty.set(key, { op, priority, params: { ...queued?.params, ...params } });
    this.needRender = true;
    this.submitEdits(coalesce);
  }

  // a card's instance reset to darktable's defaults: module_state, so the
  // History panel's undo bookkeeping (modulesOpened) covers it. it stays on,
  // as darktable's reset button leaves it (imageop.c, _gui_reset_callback);
  // default_enabled would switch off exposure, which an auto preset turns on
  resetAdvanced(op: string, priority: number) {
    this.setModuleState({ op, priority }, { reset: true, enabled: true });
  }

  // darktable's presets of a card's instance, in darktable's menu order
  loadPresets(op: string, priority: number) {
    return traced("presets", () => commands.presets(op, priority)).then((r) => r.presets);
  }

  // apply a preset by its raw darktable name: module_state, so undo restores
  // the instance as it was. the engine refuses it on an instance with a drawn
  // mask or one a mask, look or shared tool owns; that reaches onError
  applyPreset(op: string, priority: number, name: string) {
    this.setModuleState({ op, priority }, { preset: name });
  }

  // the card instance menu's actions (the engine's `instance`), sent in order
  // ahead of module states and card fields, so that an undo has made or
  // deleted the instances before it restores their settings
  private instancePending: InstanceAction[] = [];
  // instances deleted this session: the engine keeps them, switched off, so
  // undo brings one back with its priority (engine session_instance())
  // (by key, with the name it had)
  private instancesDeleted = new Map<string, string>();

  instanceAction(a: InstanceAction) {
    const key = `${a.op}#${a.priority}`;
    if (a.action === "delete") {
      const i = this.instances.find((x) => `${x.op}#${x.priority}` === key);
      this.instancesDeleted.set(key, i?.hand_edited ? i.name : "");
      const card = this.advanced.get(key);
      if (card) this.advanced.set(key, { ...card, enabled: false });
      // a card edit still queued would switch it back on after the delete
      this.advancedDirty.delete(key);
    }
    if (a.action === "restore") this.instancesDeleted.delete(key);
    this.instancePending.push(a);
    this.needRender = true;
    this.submitEdits(false);
  }

  // the user's own instances as undo keeps them: pipe order, and their names
  instanceLayout(): InstanceEntry[] | null {
    if (!this.instancesLoad) return null;
    return this.instances.filter((i) => i.owner === null)
      .map((i) => ({ op: i.op, priority: i.priority, name: i.hand_edited ? i.name : "" }));
  }

  // undo: make, delete, rename and reorder instances to match `target`.
  // a key the engine never made cannot come back; one made since is deleted
  restoreInstances(target: InstanceEntry[] | null) {
    const now = this.instanceLayout();
    if (!target || !now) return;
    const key = (i: { op: string; priority: number }) => `${i.op}#${i.priority}`;
    const want = new Map(target.map((i) => [key(i), i]));
    const have = new Map(now.map((i) => [key(i), i]));
    // the names first read, before a delete records them
    const renamed = target.filter((i) => {
      const name = have.get(key(i))?.name ?? this.instancesDeleted.get(key(i));
      return name !== undefined && name !== i.name;
    });
    for (const i of now) if (!want.has(key(i)) && i.priority > 0) this.instanceAction({ action: "delete", op: i.op, priority: i.priority });
    for (const i of target) if (!have.has(key(i)) && this.instancesDeleted.has(key(i))) this.instanceAction({ action: "restore", op: i.op, priority: i.priority });
    for (const i of renamed) this.instanceAction({ action: "rename", op: i.op, priority: i.priority, name: i.name });
    // each module's instances in the target's order, one after another
    const ops = new Set(target.map((i) => i.op));
    for (const op of ops) {
      const t = target.filter((i) => i.op === op).map((i) => i.priority);
      const n = now.filter((i) => i.op === op && want.has(key(i))).map((i) => i.priority);
      if (t.length < 2 || (t.length === n.length && t.every((p, k) => p === n[k]))) continue;
      for (let k = 1; k < t.length; k++) this.instanceAction({ action: "move", op, priority: t[k], other: t[k - 1], after: true });
    }
  }

  private async sendInstance(a: InstanceAction) {
    let r: InstanceReply;
    try {
      r = await this.pumpTyped("instance", () =>
        commands.instance(a.action, a.op, a.priority, a.name ?? null, a.other ?? null, a.after ?? null));
    } catch (e) {
      // a refused action (an instance with a drawn mask to duplicate) leaves
      // the photo as it was; the menu's state follows the engine's list again
      if (a.action === "delete") this.instancesDeleted.delete(`${a.op}#${a.priority}`);
      this.instances = (await commands.instances().catch(() => this.instances));
      this.onError(String(e));
      return;
    }
    this.instances = r.instances;
    await this.loadNewCards();
    if (a.action === "new" || a.action === "duplicate") this.lastAdded = `${a.op}#${r.priority}`;
  }
  // the instance the menu added last, whose card opens when it first shows
  lastAdded: string | null = null;

  // after a Simple slider sent its module: cards on that module read back
  // a new instance's card reads the fields its module's other cards read
  private async loadNewCards() {
    for (const i of this.instances) {
      const k = `${i.op}#${i.priority}`;
      if (this.advanced.has(k)) continue;
      const fields = [...this.advancedFields].find(([f]) => f.startsWith(`${i.op}#`))?.[1];
      if (fields && i.owner === null) await this.loadAdvanced(i.op, i.priority, fields);
    }
  }

  private staleAdvanced(op: string) {
    const [real, name] = op.split("#");
    for (const [key, card] of this.advanced) if (card.op === real) this.advancedStale.add(key);
    // a named instance the edit makes: its card needs the list read again
    if (name && this.instancesLoad && !this.instances.some((i) => i.op === real && i.hand_edited && i.name === name))
      this.instancesStale = true;
  }
  private instancesStale = false;

  // Copy Settings' Advanced modules: the whole state of each instance the
  // user changed that Simple's sliders do not show (advancedCopies)
  async copyAdvanced(): Promise<AdvancedCopy[]> {
    await this.settled();
    const out: AdvancedCopy[] = [];
    for (const i of advancedCopies(await commands.instances())) {
      const r = await traced("module_state", () => commands.moduleState(i.op, i.priority, null, null, null, null));
      out.push({ op: i.op, priority: i.priority, name: i.hand_edited ? i.name : "", state: r.now });
    }
    return out;
  }

  // paste them: each restores the instance darktable's paste would pick
  // (pasteTarget), else a new one after the module's last, named as the copy
  async pasteAdvanced(copies: AdvancedCopy[]) {
    if (!copies.length) return;
    await this.settled();
    let list = await commands.instances();
    const used = new Set<string>();
    for (const c of copies) {
      let priority = pasteTarget(list, c, used)?.priority;
      if (priority === undefined) {
        const last = list.filter((i) => i.op === c.op).at(-1);
        if (!last) continue;   // not a module of this photo's pipe
        const r = await commands.instance("new", c.op, last.priority, null, null, null);
        priority = r.priority;
        list = r.instances;
        if (c.name) list = (await commands.instance("rename", c.op, priority, c.name, null, null)).instances;
        this.unsaved = true;
      }
      used.add(`${c.op}#${priority}`);
      this.cardsShown.add(`${c.op}#${priority}`);
      this.setModuleState({ op: c.op, priority }, { restore: c.state });
    }
    this.instances = list;
    this.instancesLoad = null;
    await this.settled();
  }

  // whether darktable set the module in a way its sliders cannot show
  isForeign(op: string) {
    return mapsFor(op).some((m) => this.foreign.has(m));
  }

  // a mapped module's sliders read again after the engine changed it
  // (setModuleState), as Session.open reads them
  private async reread(op: string) {
    const fields = boundFields()[op];
    if (!fields) return;
    const reply = await traced("get_params", () => commands.getParams({ [op]: fields }));
    const info = this.info[op] = reply.modules[op];
    for (const m of mapsFor(op)) {
      // a tool's other module (Blacks on exposure while it runs on the tone
      // mapper) does not hold its sliders: read, it would claim the tool, as
      // chooseModules avoids at open
      if (!choiceOn(m, this.values)) continue;
      this.foreign.delete(m);
      const current = info.enabled ? m.read(info.params, info.defaults, this.ctx, this.values) : {};
      for (const id of m.controls) {
        if (info.enabled && current[id] === undefined) this.foreign.add(m);
        this.values[id] = this.snap(id, current[id] ?? this.neutral[id], this.neutral[id]);
      }
    }
  }

  // every map that shares the module contributes its fields to one edit
  private moduleEdit(op: string, values: Values = this.sent(),
                     skip: (m: ModuleMap) => boolean = (m) => this.foreign.has(m)) {
    const info = this.info[op];
    let params: Params = {};
    let on = false;
    let keepOn = false;
    let after: string | undefined, before: string | undefined;
    for (const m of mapsFor(op)) {
      after ??= m.after;
      before ??= m.before;
      if (skip(m)) continue;
      // a module the tool does not run on (MODULE_CHOICES) gets its sliders
      // at neutral, so that it adds nothing to the module it shares
      const chosen = choiceOn(m, values);
      const v = chosen ? values : { ...values, ...Object.fromEntries(m.controls
        .filter((id) => !isModuleSetting(id)).map((id) => [id, this.neutral[id]])) };
      params = { ...params, ...m.write(v, info.defaults, this.ctx) };
      keepOn ||= m.keepOn;
      on ||= chosen && (m.enabled ? m.enabled(values)
                                     : m.controls.some((id) => values[id] !== this.neutral[id]));
    }
    const enabled = this.bypassed.has(op) || conversionsOn(values).some((c) => c.off.has(op)) ? false
      : keepOn ? info.enabled || on : on;
    // "op#name" is the instance of op so named, made on first use
    const [real, instance] = op.split("#");
    return { op: real, params, enabled, ...(instance ? { instance } : {}), ...(after ? { after } : {}),
             ...(before ? { before } : {}) };
  }

  // the whole image, small, for the histogram and the navigator while the
  // viewer shows only part of it; rendered once edits and the viewer are idle
  onThumb: ((f: Frame) => void) | null = null;
  // the box the whole image is fitted into for it
  thumbSize: () => { width: number; height: number } = () => ({ width: 512, height: 512 });
  // the Preview preference, read at each render
  previewMode: () => Preview = () => "balanced";
  // a drag's view, or null when drags have none (Quality)
  draftSize: () => View | null = () => null;
  // the pipeline time a draft aims for, in ms, and its smallest step
  draftLimits: () => DraftLimits = () => ({ target: 60, smallest: 0.7 });
  // the modules the drag's edits are for, and the size of its last draft
  private draftKey = "";
  private draftWas = "";
  private needWarm = false;

  // native detail previews keep every module and the display scale in a loupe
  detailView: (() => View | null) = () => null;
  // Full resolution of the visible view, before preview quality reductions.
  exactView: (() => View | null) = () => null;
  private needLoupe = false;
  requestLoupe() {
    this.needLoupe = true;
    void this.pump();
  }
  private detailOps = "";

  private draftView(view: View, ops: string[]): View {
    if (!view.draft) { perf.event("preview.decision", { reason:"exact-view" }); return view; }
    if (ops.length) this.detailOps = [...new Set(ops.map((op) => op.split("#")[0]))].sort().join();
    const detail = this.detailView();
    const eligible = !!this.activeDetailControl && this.detailOps.split(",").every((op) =>
      ["diffuse", "sharpen", "contrastntexture", "denoiseprofile", "bilat", "grain", "hazeremoval"].includes(op));
    if (detail && eligible) {
      // full-size probes block newer inputs before the loupe can appear
      perf.event("preview.decision", { reason:"detail-loupe" });
      return { ...detail, draft: true, detail: true, loupe: true };
    }
    if (eligible) {
      const exact = this.exactView();
      if (exact) {
        perf.event("preview.decision", { reason:"detail-whole-view" });
        return { ...exact, draft: true, detail: true };
      }
    }

    if (ops.length) this.draftKey = [...new Set(ops.map((op) => op.split("#")[0]))].sort().join();
    const steps = DRAFT_STEPS.filter((k) => k >= this.draftLimits().smallest);
    const k = steps[Math.min(draftSteps.get(this.draftKey) ?? 0, steps.length - 1)];
    perf.event("preview.decision", { reason:k === 1 ? "selected-draft-size" : "adaptive-draft-size", factor:k, modules:this.draftKey, target:this.draftLimits().target });
    if (k === 1) return view;
    const at = (v: number | undefined) => v === undefined ? undefined : Math.round(v * k);
    return { ...view, width: at(view.width)!, height: at(view.height)!, x: at(view.x), y: at(view.y),
             scale: view.scale === undefined ? undefined : view.scale * k };
  }

  // a step down when a draft took longer than the target, and back up when
  // the size above would take well under it. not on the first draft at a
  // size, which ran from the raw, nor on one darktable found in its cache
  // (0 ms), as a drag back over values just shown does
  private draftTimed(f: Frame, edits: number) {
    if (f.view.detail) return;
    const size = `${f.width}x${f.height}`, first = size !== this.draftWas;
    this.draftWas = size;
    const ms = f.trace?.rust[2] ?? 0;
    if (first || !edits || ms < 1) {
      perf.event("preview.adaptation", { reason:first ? "first-frame-at-size" : !edits ? "no-edits" : "pipeline-cache-hit", ms, size });
      return;
    }
    const { target, smallest } = this.draftLimits();
    const steps = DRAFT_STEPS.filter((k) => k >= smallest);
    const i = Math.min(draftSteps.get(this.draftKey) ?? 0, steps.length - 1);
    if (ms > target && i < steps.length - 1) draftSteps.set(this.draftKey, i + 1);
    else if (i > 0 && ms * (steps[i - 1] / steps[i]) ** 2 < 0.8 * target) draftSteps.set(this.draftKey, i - 1);
    perf.event("preview.adaptation", { ms, target, modules:this.draftKey, previousStep:i, nextStep:draftSteps.get(this.draftKey) ?? 0 });
  }

  // one drag frame, thrown away, once the photo is up: the engine's drag
  // pipe starts empty, and filling it made a drag's first frame some 250 ms
  warmDrafts() {
    this.needWarm = true;
    void this.pump();
  }
  private needThumb = false;
  // a base is rendering, and nothing has asked it to stop yet: `stale` is
  // then set, and `wake` lets the pump go on without it
  private base: { stale: boolean; wake: () => void; copy: number | null } | null = null;
  // until the base's render is over, stopped or not
  private baseInFlight: Promise<void> | null = null;
  get baseRendering() { return !!this.base && !this.base.stale; }
  // a base in flight stopped, as an edit stops it, for work the user waits
  // on: true when one was, so the caller asks for it again after
  stopBase(): boolean {
    if (!this.base || this.base.stale) return false;
    this.base.stale = true;
    this.base.wake();
    traced("cancel_base", () => commands.cancelBase()).catch(() => {});
    return true;
  }

  requestThumb() {
    this.needThumb = true;
    void this.pump();
  }

  // the header (main.rs, render): the frame's geometry, then timings
  // `have`: frames held here, one of which the engine may name rather than
  // render again (a frame of no size, with its hash)
  private async renderView(view: View, kind: Trace["kind"],
                           cycle?: Pick<Trace, "inputAt" | "latestInputAt" | "edits" | "setStart" | "diagnostic">, every = false,
                           have: Frame[] = [], edits: ReturnType<Session["moduleEdit"]>[] = []): Promise<Frame> {
    perf.count("nativeFramesRequested");
    const t0 = performance.now();
    const measurement = perf.measurement;
    const { width, height, scale, x, y } = view;
    const preview = this.previewMode();
    const skip = view.detail ? null : view.draft ? DRAFT_SKIP[preview].filter((op) => !this.draftKeep.has(op))
      : kind === "base" && !every ? BASE_SKIP[preview] : null;
    if (!view.draft) this.draftKeep.clear();
    const hex = (f: Frame) => f.hash!.toString(16).padStart(16, "0");
    const requestLabel = cycle?.diagnostic?.label ?? perf.label;
    const requestId = perf.request({ kind, draft: !!view.draft, width, height, blockingPump:kind !== "base", detail: !!view.detail, loupe: !!view.loupe, ...cycle?.diagnostic });
    let buf: ArrayBuffer;
    try { buf = await renderFrame({ width, height, scale, x, y, skip, draft: !!view.draft,
                                    base: kind === "base" && !view.draft,
                                    have: have.length ? have.map(hex) : null,
                                    edits: edits.length ? edits : null, diagnosticRequest: requestId });
      perf.finish(requestId);
    } catch (error) {
      perf.finish(requestId, /cancel/i.test(String(error)) ? "cancelled" : "failed");
      throw error;
    }
    perf.count("nativeFramesCompleted");
    const head = new DataView(buf, 0, 24);
    const u = (k: number) => head.getUint32(4 * k, true);
    const hash = new DataView(buf).getBigUint64(48, true);
    const kept = !u(0) && !u(1) ? have.find((f) => f.hash === hash) : undefined;
    const trace = perf.rendered({ measurement, diagnostic: measurement === perf.measurement ? perf.frame({ ...cycle?.diagnostic, label: requestLabel, requestId }, kept ? "engine-reuse" : "native") : undefined, kind, draft: !!view.draft, inputAt: cycle?.inputAt ?? null, latestInputAt: cycle?.latestInputAt ?? null, edits: cycle?.edits ?? 0,
                                  setStart: cycle?.setStart ?? t0, setEnd: t0, r0: t0,
                                  width: kept?.width ?? u(0), height: kept?.height ?? u(1) }, buf);
    if (kept) return { ...kept, view, ms: performance.now() - t0, trace };
    return {
      width: u(0), height: u(1), fullWidth: u(2), fullHeight: u(3), x: u(4), y: u(5),
      view, pixels: new Uint8ClampedArray(buf, FRAME_HEAD), hash,
      ms: performance.now() - t0, trace,
    };
  }

  // full frames shown, by view and darktable's hash, oldest first. the
  // engine's pipe cache already holds the latest one's pixels, but a 100%
  // frame on a 5K screen (41 MB) still took 150-300 ms to write, read and
  // send, and zooming back and forth brought up the busy indicator. a frame
  // from before the image changed comes back when the image does (the
  // Before view and back, undo): the engine names it by its hash instead of
  // rendering it (`have`, _render in engine/main.c)
  private frames = new Map<string, Frame>();
  private framesBytes = 0;
  // the memory budget's frame cache, in bytes, read at each frame kept
  frameBudget: () => number = () => 256 * 1048576;
  // the frame each view shows, until the image changes: shown without
  // asking the engine
  private current = new Map<string, Frame>();
  private frameKey(v: View, before: boolean) {
    return `${v.width},${v.height},${v.scale},${v.x},${v.y},${before}`;
  }
  private keepFrame(key: string, f: Frame) {
    const at = `${key}|${f.hash}`;
    if (this.frames.has(at)) this.frames.delete(at);
    else this.framesBytes += f.pixels.byteLength;
    this.frames.set(at, f);
    // delete first so the newest frame is last, which trimFrames keeps
    this.current.delete(key);
    this.current.set(key, f);
    for (const [k, old] of this.frames) {
      if (this.framesBytes <= this.frameBudget() || old === f) break;
      this.frames.delete(k);
      this.framesBytes -= old.pixels.byteLength;
      const shown = k.slice(0, k.lastIndexOf("|"));
      if (this.current.get(shown) === old) this.current.delete(shown);
    }
  }
  // the computer is short of memory: every kept frame goes but the one
  // shown last (the one on screen); the engine names the others by their
  // hash again, or renders them, when a view comes back
  trimFrames() {
    const last = [...this.current.entries()].pop();
    this.frames.clear();
    this.current.clear();
    this.framesBytes = 0;
    if (!last) return;
    const [key, f] = last;
    this.frames.set(`${key}|${f.hash}`, f);
    this.current.set(key, f);
    this.framesBytes = f.pixels.byteLength;
  }
  private heldFor(key: string) {
    return [...this.frames].filter(([k]) => k.startsWith(`${key}|`)).map(([, f]) => f);
  }
  // what the engine renders changed: no frame shown is known to show it.
  // the copy is put aside, for the engine to name if the image comes back
  private changed() {
    // every path that edits the photo ends here (Simple and card edits, module
    // switches, undo and redo, History jumps, paste), so the white balance note
    // is checked once the edits pause; a pump in flight is long over by then
    clearTimeout(this.wbTimer);
    if (!this.background) this.wbTimer = setTimeout(() => void this.refreshWb(), 300);
    this.current.clear();
    if (this.copy) {
      this.putAside = this.copy;
      this.copy = null;
      this.onCopy?.(null);
    }
  }

  // the whole image at the zoom's scale, rendered once the viewer is idle
  // zoomed in: a pan's windows are cut from it rather than rendered, since
  // the pipe cache holds only the window it last rendered. null when gone
  onCopy: ((f: Frame | null) => void) | null = null;
  private copy: Frame | null = null;
  // the copy from before the image last changed, until an After frame is
  // rendered anew (the image is then most likely another), or a copy is
  private putAside: Frame | null = null;
  private copyScale: number | null = null;
  private copySize = { width: 0, height: 0 };
  private needCopy = false;
  // a copy and the window it is shown in come to twice its pixels; past
  // this a large raw keeps rendering its windows
  private static COPY_PIXELS = 64e6;

  requestCopy(scale: number, full: { w: number; h: number }) {
    if (this.before || this.copy?.view.scale === scale || this.copyScale === scale) return;
    if (Math.floor(full.w * scale) * Math.floor(full.h * scale) > Session.COPY_PIXELS) return;
    this.copyScale = scale;
    // the engine trims the box to the image at that scale
    this.copySize = { width: Math.ceil(full.w * scale), height: Math.ceil(full.h * scale) };
    this.needCopy = true;
    void this.pump();
  }

  // zoomed in, the fitted view, rendered on the base pipe once the viewer is
  // idle and kept as the frame that view shows: zooming back out is then
  // instant. the main pipe keeps its cache of the window shown
  private fitView: View | null = null;
  requestFit(view: View) {
    if (this.before || this.current.has(this.frameKey(view, false))) return;
    this.fitView = view;
    void this.pump();
  }

  // the window the engine would render (_render in engine/main.c), cut
  // from the copy
  private cut(c: Frame, view: View, cycle?: Parameters<typeof perf.cached>[2]): Frame {
    const W = c.width, H = c.height;
    const w = Math.min(view.width, W), h = Math.min(view.height, H);
    const x = Math.min(Math.max(view.x ?? 0, 0), W - w), y = Math.min(Math.max(view.y ?? 0, 0), H - h);
    const pixels = new Uint8ClampedArray(4 * w * h);
    for (let r = 0; r < h; r++) {
      const from = 4 * ((y + r) * W + x);
      pixels.set(c.pixels.subarray(from, from + 4 * w), 4 * r * w);
    }
    return { width: w, height: h, fullWidth: c.fullWidth, fullHeight: c.fullHeight, x, y, view, pixels, ms: 0,
             trace: perf.cached(w, h, cycle) };
  }

  // a render on the base pipe, which an edit stops (cancel_base). one asked
  // to stop is not waited for: the cancel cannot reach a frame already on
  // its way here, some 90 ms on Windows, and the edit that stopped it would
  // sit behind that; it is dropped instead
  private async idleRender(view: View, every: boolean, use: (f: Frame) => void, have: Frame[] = []) {
    let wake = () => {};
    const woken = new Promise<void>((r) => { wake = r; });
    const run = { stale: false, wake, copy: every ? view.scale ?? null : null };
    this.base = run;
    const done = this.renderView(view, "base", undefined, every, have)
      .then((f) => { if (!run.stale) use(f); else perf.discard(f.trace, "base-obsolete-after-cancel"); })
      .catch((e) => { if (String(e) !== "canceled") this.onError(String(e)); })
      .finally(() => { if (this.baseInFlight === done) this.baseInFlight = null; });
    this.baseInFlight = done;
    const wait = perf.begin("base.wait", { copy: every });
    await Promise.race([done, woken]);
    perf.finish(wait);
    this.base = null;
  }

  // work for the shown frame, which a base in flight would hold up
  private get editPending() {
    return this.needRender || this.imagePending;
  }
  // the part of it that changes the image, rather than only the view
  private get imagePending() {
    return this.dirty.size > 0 || this.wantLook !== undefined || this.masksPending
      || this.wantLookAmount !== undefined || this.spotsPending || this.reshapeDue;
  }
  // a pan while the copy renders: the copy is let finish and the window cut
  // from it, since a stopped copy is never done while panning goes on. the
  // wait is the user's, so it shows the busy indicator
  private copyWait: ReturnType<typeof begin> | null = null;

  // a command run by the pump, traced under its Rust name
  private pumpTyped<T>(command: string, call: () => Promise<T>) {
    return perf.traced<T>(command, call, { blockingPump:true });
  }

  private async pump() {
    if (this.backgroundFailure || this.dead) return;
    if (this.busy) {
      perf.event("pump.busy", { base: !!this.base, editPending: this.editPending });
      // the base can take seconds and would be stale: stopped, it is
      // rendered again once editing pauses (App.tsx, scheduleBase)
      if (this.base && !this.base.stale && this.editPending) {
        const v = this.size();
        if (!this.imagePending && !this.before && !v.draft && v.scale === this.base.copy) {
          this.copyWait ??= begin();
          return;
        }
        this.base.stale = true;
        this.base.wake();
        const requestIds = perf.activeRenderIds("base");
        perf.event("base.cancelRequested", { requestIds });
        traced("cancel_base", () => commands.cancelBase()).then(() => perf.event("base.cancelSignalSent", { requestIds }))
          .catch(() => perf.event("base.cancelSignalFailed", { requestIds }));
      }
      return;
    }
    if (this.editFrame !== null) return;
    this.busy = true;
    // the viewer's busy indicator: from now until a frame is back
    let job = begin();
    try {
      while (this.dirty.size || this.needRender || this.needThumb || this.needCopy || this.needWarm || this.needLoupe
             || this.fitView || this.wantLook !== undefined
             || this.masksPending || this.wantLookAmount !== undefined || this.spotsPending
             || this.reshapeDue || this.baselineEnd || this.modulePending.length || this.resetModulesPending
             || this.advancedDirty.size || this.advancedStale.size || this.instancesStale || this.instancePending.length) {
        if (this.editFrame !== null) break;
        // before the change that ended it; a save it makes is the one due
        if (this.baselineEnd) {
          this.baselineEnd = false;
          if (this.unsaved && !this.before) {
            window.clearTimeout(this.saveTimer);
            this.unsaved = false;
          }
          await this.pumpTyped("baseline_end", () => commands.baselineEnd());
          continue;
        }
        // the engine saves on quitting, but never the Before view's settings:
        // it hears of the view before they go
        if (this.before && !this.engineBefore) {
          await this.pumpTyped("before_view", () => commands.beforeView(true));
          this.engineBefore = true;
          this.changed();
        }
        // Capture the native state before reset controls (including framing)
        // are written; undo restores this state after its mapped values.
        if (this.resetModulesPending) {
          this.resetModulesPending = false;
          const seen = new Set<string>();
          for (const h of this.history) {
            const priority = h.priority;
            if (priority == null) continue;
            const key = instanceKey(h);
            if (seen.has(key)) continue;
            seen.add(key);
            const legacy = ["filmicrgb", "filmic", "basecurve"].includes(h.op);
            const r = await this.pumpTyped("module_state", () =>
              commands.moduleState(h.op, priority, legacy ? false : null, true, null, null));
            this.touched.add(key);
            if (!this.modulesOpened.has(key)) this.modulesOpened.set(key, r.was);
            this.moduleStates.set(key, r.now);
          }
          this.foreign.clear();
          for (const m of modules) this.dirty.add(m.op);
          this.deleted.clear();
          this.changed();
          this.onModules?.();
          if (!this.before) { this.unsaved = true; this.scheduleSave(); }
          this.needRender = true;
          continue;
        }
        // a turn or a reframing goes first: masks and spots restored with
        // it (undo) are in its frame
        const framing = [...this.dirty].some((op) => FRAMING.has(op.split("#")[0]));
        if (this.dirty.has("flip") || framing) {
          const ops = [...this.dirty];
          this.dirty.clear();
          for (const op of ops) await this.pumpTyped("set_params", () => commands.setParams(this.moduleEdit(op)));
          this.changed();
          if (framing) this.reshape = true;
          if (!this.before) { this.unsaved = true; this.scheduleSave(); }
          this.needRender = true;
          continue;
        }
        if (this.spotsPending) {
          const dirty = this.spotsDirty, on = !this.before;
          this.spotsDirty = false;
          if (dirty) await this.pumpTyped("spots", () => commands.spots(this.spots));
          // a new set of spots comes on with them; the Before view turns
          // them off after
          if (dirty || on !== this.spotsOn) await this.pumpTyped("spots_enable", () => commands.spotsEnable(on));
          this.spotsOn = on;
          this.changed();
          if (dirty && !this.before) { this.unsaved = true; this.scheduleSave(); }
          this.needRender = true;
          continue;
        }
        if (this.wantLookAmount !== undefined && this.wantLook === undefined) {
          const amount = this.wantLookAmount;
          this.wantLookAmount = undefined;
          await this.pumpTyped("look_amount", () => commands.lookAmount(amount));
          this.changed();
          if (!this.before) { this.unsaved = true; this.scheduleSave(); }
          this.needRender = true;
          continue;
        }
        if (this.masksPending) {
          const task = perf.begin("pump.task", { operation:"sendMasks", blockingPump:true });
          let sent: boolean;
          try { sent = await this.sendMasks(); } finally { perf.finish(task); }
          this.changed();
          if (sent && !this.before) { this.unsaved = true; this.scheduleSave(); }
          this.needRender = true;
          continue;
        }
        if (this.wantLook !== undefined) {
          const path = this.wantLook;
          this.wantLook = undefined;
          await this.pumpTyped("look_apply", () => commands.lookApply(path));
          this.changed();
          if (!this.before) { this.unsaved = true; this.scheduleSave(); }
          this.needRender = true;
          continue;
        }
        // instances made, deleted or moved before any state for them is sent
        if (this.instancePending.length && !this.dirty.size) {
          await this.sendInstance(this.instancePending.shift()!);
          this.changed();
          this.onModules?.();
          if (!this.before) { this.unsaved = true; this.scheduleSave(); }
          this.needRender = true;
          continue;
        }
        // after the sliders' edits, so an undo's values cannot overwrite the
        // state it restores
        if (this.modulePending.length && !this.dirty.size) {
          const { key, op, priority, req } = this.modulePending.shift()!;
          const restore = req.restore === "opened" ? this.modulesOpened.get(key) : req.restore;
          if (req.restore === "opened" && !restore) continue;
          const r = await this.pumpTyped("module_state", () =>
            commands.moduleState(op, priority, req.enabled ?? null, req.reset ?? null, restore ?? null, req.preset ?? null));
          this.changed();
          if (!this.modulesOpened.has(key)) this.modulesOpened.set(key, r.was);
          this.moduleStates.set(key, r.now);
          // darktable relabels an instance from its preset, and an undo
          // restores the label with it
          if (req.preset !== undefined || restore) {
            this.instancesLoad = null;
            await this.loadInstances();
          }
          // an instance first set from an Advanced card is not in the
          // history read at open; its first instance is what Simple maps
          const item = this.history.find((h) => instanceKey(h) === key);
          const mapOp = item ? mapOpOf(item) : priority === 0 ? op : null;
          if (mapOp) {
            const task = perf.begin("pump.task", { operation:"reread", blockingPump:true });
            try { await this.reread(mapOp); } finally { perf.finish(task); }
          }
          if (this.advanced.has(key)) this.advancedStale.add(key);
          this.onModules?.();
          if (!this.before) { this.unsaved = true; this.scheduleSave(); }
          this.needRender = true;
          continue;
        }
        // Advanced cards' edits: after the sliders' and module states, so an
        // undo restores whole instances first and the cards' fields last
        if (this.advancedDirty.size && !this.dirty.size) {
          const sent = [...this.advancedDirty.values()];
          this.advancedDirty.clear();
          for (const { op, priority, params } of sent) {
            const key = `${op}#${priority}`;
            const enabled = this.advanced.get(key)?.enabled ?? true;
            this.draftKeep.add(op);
            await this.pumpTyped("set_params", () => commands.setParams({ op, priority, params, enabled }));
            // Simple's sliders on the same instance read it again
            if (priority === 0 && boundFields()[op]) await this.reread(op);
            // a lens pick also sets the lens method and geometry, which the card reads back
            if ("lens_pick" in params) this.advancedStale.add(key);
            // white balance's temperature and tint set the coefficients, and
            // an edit of the coefficients moves them
            if (op === "temperature") this.advancedStale.add(key);
          }
          this.changed();
          this.onModules?.();
          if (!this.before) { this.unsaved = true; this.scheduleSave(); }
          this.needRender = true;
          continue;
        }
        if ((this.advancedStale.size || this.instancesStale) && !this.dirty.size && !this.advancedDirty.size) {
          if (this.instancesStale) {
            this.instancesStale = false;
            this.instancesLoad = null;
            await this.loadInstances();
            await this.loadNewCards();
          }
          const keys = [...this.advancedStale];
          this.advancedStale.clear();
          for (const key of keys) {
            const card = this.advanced.get(key), fields = this.advancedFields.get(key);
            if (card && fields) await this.loadAdvanced(card.op, card.priority, fields);
          }
          this.onModules?.();
          continue;
        }
        if (this.reshapeDue && !this.dirty.size) {
          this.reshape = false;
          const task = perf.begin("pump.task", { operation:"loadMasks", blockingPump:true });
          try { await this.loadMasks(); } finally { perf.finish(task); }
          this.spots = await this.pumpTyped("spots", () => commands.spots(null));
          this.onShapes?.();
          continue;
        }
        if (!this.dirty.size && !this.needRender && this.needLoupe) {
          this.needLoupe = false;
          const view = this.before ? null : this.detailView();
          if (view) {
            end(job);
            await this.idleRender({ ...view, detail: true, loupe: true }, true, (f) => {
              const now = this.detailView();
              if (!this.before && now && this.frameKey(now, false) === this.frameKey(view, false)) this.onFrame(f);
            });
            job = begin();
          }
          continue;
        }
        if (!this.dirty.size && !this.needRender && this.needWarm) {
          this.needWarm = false;
          const view = this.draftSize();
          if (view) {
            const warm = await this.renderView(view, "view");
            perf.event("frame.notPresented", { ...warm.trace?.diagnostic, reason:"warmup-only" });
          }
          continue;
        }
        if (!this.dirty.size && !this.needRender && this.needThumb) {
          this.needThumb = false;
          await this.idleRender(this.thumbSize(), false, (thumb) => this.onThumb?.(thumb));
          continue;
        }
        if (!this.dirty.size && !this.needRender && this.fitView) {
          const view = this.fitView, key = this.frameKey(view, false);
          this.fitView = null;
          if (this.before || this.current.has(key)) continue;
          end(job);
          await this.idleRender(view, true, (f) => {
            if (!this.before && !this.current.has(key)) this.keepFrame(key, f);
          }, this.heldFor(key));
          job = begin();
          continue;
        }
        if (!this.dirty.size && !this.needRender && this.needCopy) {
          this.needCopy = false;
          const scale = this.copyScale!;
          // nothing on screen waits for it: it takes seconds, and the busy
          // indicator would come up for each
          end(job);
          const aside = this.putAside?.view.scale === scale ? [this.putAside] : [];
          await this.idleRender({ ...this.copySize, scale, x: 0, y: 0 }, true, (f) => {
            if (this.before) return;
            this.putAside = null;
            this.copy = f;
            this.onCopy?.(f);
          }, aside);
          this.copyScale = null;
          if (this.copyWait) end(this.copyWait);
          this.copyWait = null;
          job = begin();
          continue;
        }
        const ops = [...this.dirty];
        this.dirty.clear();
        const cycle = perf.cycle();
        // sent with the render rather than one call each: on Linux a call
        // took 20 ms or more while the page drew (FINDINGS, "KDE on AMD")
        const edits = ops.map((op) => {
          this.draftKeep.add(op.split("#")[0]);
          this.staleAdvanced(op);
          return this.moduleEdit(op);
        });
        if (ops.length) this.changed();
        // the Before view is only for looking: nothing of it reaches the sidecar
        if (ops.length && !this.before) { this.unsaved = true; this.scheduleSave(); }
        this.needRender = false;
        // Batch edits use the same module maps and mask transport, without
        // rendering previews for photos that are not on screen.
        if (this.background) {
          for (const edit of edits) await this.pumpTyped("set_params", () => commands.setParams(edit));
          continue;
        }
        // what the render shows is settled by now, whatever changes during it
        const before = !!this.before;
        const requestedView = this.size();
        const requestedKey = this.frameKey(requestedView, before);
        const view = this.draftView(requestedView, ops), key = this.frameKey(view, before);
        perf.event("preview.selected", { requested:{...requestedView}, selected:{...view}, controls:ops });
        const kept = view.draft || edits.length ? undefined : this.current.get(key);
        if (kept) {
          this.keepFrame(key, kept);
          this.onFrame({ ...kept, before, trace: perf.cached(kept.width, kept.height, cycle) });
        } else if (!view.draft && !edits.length && !before && this.copy && view.scale === this.copy.view.scale) {
          const reused = this.cut(this.copy, view, cycle);
          this.onFrame({ ...reused, before });
        } else {
          const have = view.draft ? [] : this.heldFor(key);
          const f = await this.renderView(view, ops.length ? "edit" : "view", cycle, false, have, edits);
          if (!view.draft) this.keepFrame(key, f);
          else this.draftTimed(f, edits.length);
          if (!before && !have.some((h) => h.hash === f.hash)) this.putAside = null;
          const now = this.size();
          const stale = requestedKey !== this.frameKey(now, !!this.before)
            || !!requestedView.draft !== !!now.draft
            || this.reshapeDue || [...this.dirty].some((op) => op === "flip" || FRAMING.has(op.split("#")[0]));
          if (stale) {
            perf.count("nativeFramesDiscarded");
            perf.event("frame.discarded", { ...f.trace?.diagnostic, viewportChanged: requestedKey !== this.frameKey(now, !!this.before), draftChanged: !!requestedView.draft !== !!now.draft, reshape: this.reshapeDue });
            // the photo still waits for this edit: render it again for the
            // view as it is now. a click on a slider's track let go while
            // its draft rendered, and the draft, no longer wanted once the
            // drag was over, was dropped with nothing asking for the final
            // frame, so the photo kept its old look until the next input
            this.needRender = true;
          }
          if (!stale) this.onFrame({ ...f, before });
        }
        progress(job);
      }
      // and that it is over only once the edit is back in it
      if (!this.before && this.engineBefore) {
        await this.pumpTyped("before_view", () => commands.beforeView(false));
        this.engineBefore = false;
        this.changed();
      }
    } catch (e) {
      if (this.background) this.backgroundFailure = String(e);
      this.onError(String(e));
    } finally {
      this.busy = false;
      end(job);
    }
  }

  private scheduleSave() {
    if (this.background || this.dead) return; // the batch explicitly saves/checks each target
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      // the engine holds the Before view's settings; save once it is gone
      if (this.before) { this.scheduleSave(); return; }
      this.unsaved = false;
      traced("save", () => commands.save()).then((r) => this.onSaved?.(r.edited))
        .catch((e) => this.onSaveError ? this.onSaveError(String(e)) : this.onError(String(e)));
    }, 600);
  }

  // darktable's compress history stack: the edit saved now, which compresses
  // what is stored, and that history read back to stand for the opened one
  async compressHistory() {
    if (this.before) this.showBefore(null);
    await this.settled();
    window.clearTimeout(this.saveTimer);
    this.unsaved = false;
    const r = await traced("save", () => commands.save());
    this.onSaved?.(r.edited);
    this.history = await traced("history", () => commands.history(true));
    // nothing is left to undo, and a deleted instance is gone from it
    this.moduleStates.clear();
    this.modulesOpened.clear();
    this.deleted.clear();
    this.touched.clear();
    return this.history;
  }

  // the engine restarted: this session's photo is not open in the new one,
  // so nothing more is sent for it, and closing it asks the engine nothing.
  // what was not yet saved is lost
  abandon() {
    this.dead = true;
    window.clearTimeout(this.saveTimer);
    this.unsaved = false;
  }

  async close() {
    if (this.dead) return;
    this.requestRender();
    window.clearTimeout(this.saveTimer);
    if (this.before) this.showBefore(null);
    await this.settled();
    if (!this.unsaved) return;
    this.unsaved = false;
    const r = await traced("save", () => commands.save());
    this.onSaved?.(r.edited);
  }
}
