// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// one open image: control values in Lightroom units, translated to engine
// edits. edits are coalesced: while a render is in flight, further moves
// only mark their module dirty, and the next round sends the latest values once
import { invoke } from "@tauri-apps/api/core";
import { boundFields, choiceCovers, choiceOn, controlById, isModuleSetting, localControlById, localFields, localMaps, mapOf, mapsFor,
         mapsWith, MODULE_CHOICES, modules, NEG_CHOICES, NEG_OFF, turnOrientation, turnRect, type ImageContext,
         type ModuleMap, type Params, type Turn, type Values } from "./manifest";
import { loadModuleChoice } from "./moduleChoice";
import { isRefined, neutralLocal, type Mask, type Refine, type Shape } from "./masks";
import { planMerge, type MergePlan } from "./localMerge";
import type { Spot } from "./spots";
import { begin, end, progress } from "./activity";
import { perf, type Trace } from "./perf";
import { FRAME_HEAD, renderFrame } from "./sharedFrames";
import { detailMix, mixDetailPixels, interpolateDetail, isDetailControl, isCachedControl, predictionError, previewTiming, anchorInterval } from "./cachedDetail";
import type { Preview } from "./Preferences";


export type CachedPreview = { a:Frame; b:Frame; mix:number; frame:Frame };

type OpenReply = { imgid: number; sensor_width: number; sensor_height: number; orientation: number;
                   look: string | null; look_amount: number; edited: boolean; raw: boolean;
                   fresh?: boolean };

// an item of the image's darktable history, as darktable's history module
// names it. `priority` picks the instance; `fixed` ones have no switch in
// darktable, and `masked` ones are the Masks panel's. the new-photo rows
// Immage adds have none of these
export type HistoryItem = {
  op: string; name: string; label: string | null; enabled: boolean;
  priority?: number; default_enabled?: boolean; fixed?: boolean; masked?: boolean;
};

// an instance's whole state as the engine's `module_state` gives it, for
// undoing the History panel's switches
export type ModuleState = { enabled: boolean; params: string; blend: string | null };
type ModuleRequest = { enabled?: boolean; reset?: boolean; restore?: ModuleState | "opened" };

// the instance a history item is for, and the ModuleMap op its sliders use:
// Immage's own named instances carry their name, as manifest's "op#name"
export const instanceKey = (h: HistoryItem) => `${h.op}#${h.priority}`;
export const mapOpOf = (h: HistoryItem) => h.label ? `${h.op}#${h.label}` : h.op;
type ModuleInfo = {
  enabled: boolean;
  default_enabled: boolean;
  params: Params;
  defaults: Params;
};

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
// Performance also leaves out denoise and HSL (color equalizer)
const DRAFT_SKIP: Record<Preview, string[]> = {
  quality: [],
  balanced: ["grain", "diffuse", "sharpen"],
  performance: ["grain", "diffuse", "sharpen", "denoiseprofile", "colorequal"],
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
  quality: [],
  balanced: ["grain", "diffuse"],
  performance: ["grain", "diffuse"],
};
// the modules besides flip that move pixels: an edit to one moves the
// shown frame that masks and spots are kept in (flip is turn()'s)
const FRAMING = new Set(["crop", "ashift", "lens"]);

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
  private saveTimer: number | undefined;
  // edits not yet in the sidecar; saving also drops the cached thumbnail,
  // so an untouched image is not saved on close
  private unsaved = false;
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
  // those deleted: switched off, and gone from the history at the next save
  // (the engine's _prune_off), or reset if darktable starts them on
  deleted = new Set<string>();
  // every instance asked for, at once: moduleStates follows only the replies
  touched = new Set<string>();
  onModules: (() => void) | null = null;
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

  constructor(
    private size: () => View,
    private onFrame: (f: Frame) => void,
    private onError: (e: string) => void,
  ) {}

  // `imgid` picks one of the file's versions; without it, the original
  static async open(path: string, imgid: number | null, size: Session["size"], onFrame: Session["onFrame"],
                    onError: Session["onError"]): Promise<Session> {
    const opened = await invoke<OpenReply>("open_image", { path, imgid: imgid !== null && imgid > 0 ? imgid : null });
    const s = new Session(size, onFrame, onError);
    s.imgid = opened.imgid;
    // an engine without "fresh" knows only whether the photo is altered
    s.wasEdited = opened.fresh === undefined ? opened.edited : !opened.fresh;
    s.baseline = opened.fresh ?? false;
    s.raw = opened.raw ?? true;
    s.look = opened.look;
    s.lookAmount = opened.look_amount ?? 100;
    const reply = await invoke<{ modules: Record<string, ModuleInfo> }>("get_params",
      { modules: boundFields() });
    s.info = reply.modules;
    s.history = await invoke<HistoryItem[]>("history");
    // flip's own setting wins; -1 means "as the camera recorded it"
    const flip = s.info.flip;
    s.ctx = {
      sensorWidth: opened.sensor_width,
      sensorHeight: opened.sensor_height,
      orientation: flip?.enabled && flip.params.orientation >= 0 ? flip.params.orientation : opened.orientation,
      camera: opened.orientation,
    };
    // a negative keeps NEG_OFF's modules off with their settings, for when
    // it is turned back: their sliders are read as if they were on
    if (s.info.negadoctor?.enabled) {
      // the first instance's entry carries darktable's preset label, if any
      const used = new Set(s.history.flatMap((h) => [mapOpOf(h), h.op]));
      for (const op of NEG_OFF) if (s.info[op] && used.has(op)) s.info[op] = { ...s.info[op], enabled: true };
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
    s.spots = await invoke<Spot[]>("spots", {});
    s.requestRender();
    return s;
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
      const used = c.options.find((o) =>
        ofOption(o.value).some((m) => {
          const r = reads(m);
          return r && covers.some((id) => id in r && Math.abs(r[id] - (this.neutral[id] ?? 0)) > 1e-6);
        })
        || localMaps.some((m) => m.choice?.control === c.control && m.choice.value === o.value
                             && [...this.maskOps.values()].some((ops) => ops.has(m.op))));
      // a negative's tools run after negadoctor, whatever its modules hold
      const value = this.values.neg_on === 1 && c.control in NEG_CHOICES ? NEG_CHOICES[c.control]
        : this.wasEdited && used ? used.value : pick;
      this.values[c.control] = value;
      // only the chosen module's maps say what the shared sliders hold
      for (const id of covers) if (id in this.neutral) this.values[id] = this.neutral[id];
      for (const m of ofOption(value)) {
        const r = reads(m);
        for (const id of covers) if (r && id in r) this.values[id] = this.snap(id, r[id], this.neutral[id]);
      }
    }
  }

  // round onto the control's step, and let float noise read as neutral
  private snap(id: string, v: number, neutral: number): number {
    const c = controlById.get(id)!;
    if (!Number.isFinite(v) || Math.abs(v - neutral) < c.step / 2) return neutral;
    const snapped = c.slider ? v : Math.round(v / c.step) * c.step;
    return c.readsPast ? snapped : Math.min(c.max, Math.max(c.min, snapped));
  }

  set(id: string, v: number) {
    if (!mapOf.has(id)) return;
    perf.input();
    const inputAt = performance.now();
    const from = this.values[id];
    this.activeDetailControl = this.size().draft && isDetailControl(id) ? id : null;
    this.onDetailControl?.(this.activeDetailControl);
    const eligible = this.size().draft && isCachedControl(id) && this.cachedDetailPreview() && !this.before && !this.masksPending;
    if (eligible) {
      const key = this.frameKey(this.fullView(),false), c = controlById.get(id)!;
      if (this.detailCache?.id !== id || this.detailCache.key !== key) {
        const frame = !this.busy && !this.dirty.size ? this.current.get(key) : undefined;
        this.detailCache = {id,key,range:c.max-c.min,b:frame ? {frame,value:from} : undefined,
          lastStart:0,nativeMs:previewTiming().native,blocked:false,direction:0};
      }
    } else this.detailCache = null;
    if (this.detailCache) {
      const direction = Math.sign(v-from);
      if (direction && this.detailCache.direction && direction !== this.detailCache.direction) this.detailCache.a = undefined;
      if (direction) this.detailCache.direction = direction;
      this.detailCache.predictedValue = undefined;
    }
    this.values[id] = v;
    if (id === "orient") this.orient(v);
    if (id === "neg_on") this.negChanged();
    for (const m of mapsWith(id)) {
      this.foreign.delete(m);
      this.dirty.add(m.op);
    }
    const cache = this.detailCache;
    if (cache?.a && cache.b && !cache.blocked) {
      const mix = detailMix({pixels:cache.a.frame.pixels,value:cache.a.value},
        {pixels:cache.b.frame.pixels,value:cache.b.value},v,cache.range);
      if (mix !== null) {
        const trace = perf.cached(cache.b.frame.width,cache.b.frame.height);
        trace.estimated = true; trace.draft = true; trace.previewBackend = "cpu";
        trace.kind = "edit"; trace.edits = 1; trace.inputAt = inputAt;
        const frame = {...cache.b.frame,hash:undefined,trace,ms:0,
          view:{...cache.b.frame.view,draft:true,detail:true}};
        // the GPU consumer draws from anchors; other consumers retain CPU feedback
        const shown = this.onCachedPreview?.({a:cache.a.frame,b:cache.b.frame,mix,frame});
        if (shown) cache.predictedValue = v;
        else {
          const pixels = mixDetailPixels(cache.a.frame.pixels,cache.b.frame.pixels,mix);
          if (performance.now()-inputAt <= previewTiming().target) {
            cache.predictedValue = v;
            this.onFrame({...frame,pixels});
          } else cache.blocked = true;
        }
      }
    }
    this.needRender = true;
    void this.pump();
  }

  // a negative converted or turned back: the modules it turns off are sent
  // again, switched off or back as their sliders have them. one darktable
  // set beyond its sliders is switched by the panel (setModuleState)
  private negChanged() {
    for (const op of NEG_OFF) if (mapsFor(op).some((m) => !this.foreign.has(m))) this.dirty.add(op);
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
    while (!this.idle) await new Promise((r) => setTimeout(r, 20));
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
      && this.wantLook === undefined && !this.masksPending && this.wantLookAmount === undefined
      && !this.spotsPending && !this.reshapeDue && !this.baselineEnd && !this.baseInFlight;
  }

  // not while crop is bypassed or the Before view is up: the one changes
  // the frame, the other the mask values read back
  private get reshapeDue() {
    return this.reshape && !this.bypassed.size && !this.before;
  }

  private get spotsPending() {
    return this.spotsDirty || this.spotsOn !== !this.before;
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
    type Raw = { name: string; shapes: Shape[]; invert: boolean; opacity: number; refine?: Refine;
                 instances: Record<string, { enabled: boolean; params: Params }>; merged_in?: string[] };
    const raw = await invoke<Raw[]>("masks", { fields: localFields() });
    // the combined masks the photo has, sent again (or emptied) on its
    // first mask edit
    for (const r of raw) for (const g of r.merged_in ?? []) this.sentShared.set(g, { members: "", params: "" });
    this.masks = raw.map((r) => {
      const values = neutralLocal();
      const neutral = { ...values };
      // an instance that is off holds neutral values, unless its mask is
      // hidden or shares instances: then all are off and some still hold
      // the mask's settings
      for (const m of localMaps) {
        const inst = r.instances[m.op];
        if (inst) Object.assign(values, m.read(inst.params, {}, this.ctx));
      }
      for (const [id, v] of Object.entries(values)) values[id] = id.startsWith("l_detail_") ? v : Math.round(v * 100) / 100;
      const insts = Object.values(r.instances);
      const hidden = insts.length > 0 && insts.every((i) => !i.enabled) && !r.merged_in?.length
        && Object.entries(values).some(([id, v]) => v !== neutral[id]);
      this.maskOps.set(r.name, new Set(Object.keys(r.instances)));
      this.sentMasks.add(r.name);
      return { name: r.name, shapes: r.shapes, invert: r.invert, opacity: Math.round(r.opacity ?? 100),
               ...(hidden ? { hidden } : {}), ...(r.refine ? { refine: r.refine } : {}), values };
    });
  }

  private mask(name: string) { return this.masks.find((m) => m.name === name); }

  addMask(name: string, shapes: Shape[]) {
    this.masks = [...this.masks, { name, shapes, invert: false, values: neutralLocal() }];
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
    this.detailCache = null;
    this.activeDetailControl = this.size().draft && isDetailControl(id) ? id : null;
    this.onDetailControl?.(this.activeDetailControl);
    const ops = localMaps.filter((m) => m.controls.includes(id)).map((m) => m.op);
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
    this.markLocal(name, [...(this.maskOps.get(name) ?? [])]);
  }

  setRefine(name: string, refine: Refine) {
    this.masks = this.masks.map((m) => (m.name === name ? { ...m, refine } : m));
    const ops = this.maskOps.get(name);
    this.markLocal(name, ops?.size ? [...ops] : [REFINE_CARRIER]);
  }

  // a copy of mask `name` as `to`, with its own instances
  duplicateMask(name: string, to: string) {
    const m = this.mask(name);
    if (!m) return;
    this.masks = [...this.masks, { ...structuredClone(m), name: to }];
    this.dirtyShapes.add(to);
    this.markLocal(to, [...(this.maskOps.get(name) ?? [])]);
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
        await invoke("mask_rename", { name, to });
        sent = true;
      }
      for (const name of this.deletedMasks.splice(0)) {
        this.sentMasks.delete(name);
        await invoke("mask_delete", { name });
        sent = true;
      }
      for (const name of [...this.dirtyShapes]) {
        this.dirtyShapes.delete(name);
        const m = this.mask(name);
        if (!m) continue;
        reshaped.add(name);
        await invoke("mask_shapes", { name, shapes: m.shapes });
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
        const on = !shares && !this.before && !m.hidden && choiceOn(map, this.values) && holds;
        // refinements live in an instance's blend parameters: a mask with
        // none yet gets one that is off to hold them, which the overlay's
        // mask_map then uses
        const carrier = !have.size && op === REFINE_CARRIER && isRefined(m);
        if (!on && !(shares && holds) && !have.has(op) && !carrier) continue;
        // "op#tag" is the mask's instance named "<mask>#tag"
        const [real, tag] = op.split("#");
        this.draftKeep.add(real);
        await invoke("set_params", { op: real, params: map.write(m.values, {}, this.ctx), enabled: on,
                                     instance: tag ? `${name}#${tag}` : name, mask: name, invert: m.invert,
                                     opacity: m.opacity ?? 100, refine: m.refine ?? null });
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
      await invoke("combine", { name: group, members: [] });
      this.sentShared.delete(group);
      sent = true;
    }
    for (const s of plan.shared) {
      const was = this.sentShared.get(s.group);
      const members = JSON.stringify([s.members, s.ranges]), params = JSON.stringify([s.params, s.refine]);
      // the members first: the instance's mask must be there to attach to
      if (was?.members !== members) await invoke("combine", { name: s.group, members: s.members, ranges: s.ranges });
      if (was?.params !== params) {
        const [real] = s.op.split("#");
        this.draftKeep.add(real);
        await invoke("set_params", { op: real, params: s.params, enabled: true, instance: s.instance,
                                     mask: s.group, invert: false, opacity: 100, refine: s.refine });
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
    const buf = await invoke<ArrayBuffer>("preview", {
      size, edits, withLook: look !== undefined, look: look ?? null,
    });
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
  setMany(entries: [string, number][]) {
    perf.input();
    this.detailCache = null;
    this.activeDetailControl = null;
    this.onDetailControl?.(null);
    for (const [id, v] of entries) {
      if (!mapOf.has(id)) continue;
      this.values[id] = v;
      if (id === "orient") this.orient(v);
      if (id === "neg_on") this.negChanged();
      for (const m of mapsWith(id)) {
        this.foreign.delete(m);
        this.dirty.add(m.op);
      }
    }
    this.needRender = true;
    void this.pump();
  }

  onCachedPreview: ((preview:CachedPreview) => boolean) | null = null;
  cachedDetailPreview: () => boolean = () => false;
  fullView: () => View = () => this.size();
  onDetailControl: ((id:string|null) => void) | null = null;
  private activeDetailControl: string | null = null;
  private previewTimer: ReturnType<typeof setTimeout> | undefined;
  private detailCache: { id:string; key:string; range:number; lastStart:number; nativeMs:number; blocked:boolean; direction:number; predictedValue?:number; a?:{frame:Frame;value:number}; b?:{frame:Frame;value:number} } | null = null;

  requestRender() {
    clearTimeout(this.previewTimer);
    this.previewTimer = undefined;
    this.detailCache = null;
    this.activeDetailControl = null;
    this.onDetailControl?.(null);
    this.needRender = true;
    void this.pump();
  }

  // a history item's instance switched, reset, or restored for undo
  // ("opened": as the photo opened)
  setModuleState(h: HistoryItem, req: ModuleRequest) {
    if (h.priority === undefined) return;
    this.touched.add(instanceKey(h));
    this.modulePending.push({ key: instanceKey(h), op: h.op, priority: h.priority, req });
    void this.pump();
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
    const reply = await invoke<{ modules: Record<string, ModuleInfo> }>("get_params",
      { modules: { [op]: fields } });
    const info = this.info[op] = reply.modules[op];
    for (const m of mapsFor(op)) {
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
    const enabled = this.bypassed.has(op) || (values.neg_on === 1 && NEG_OFF.has(op)) ? false
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

  // detail previews keep every module and pixel; only their area adapts
  detailView: (() => View | null) = () => null;
  private detailKey = "";
  private detailSlow = 0;
  private detailOps = "";

  private draftView(view: View, ops: string[]): View {
    if (!view.draft) { this.detailKey = ""; this.detailSlow = 0; return view; }
    if (ops.length) this.detailOps = [...new Set(ops.map((op) => op.split("#")[0]))].sort().join();
    const detail = this.detailView();
    if (this.detailCache && this.cachedDetailPreview()) return {...this.fullView(),draft:true,detail:true};
    const eligible = !!this.activeDetailControl && this.detailOps.split(",").every((op) =>
      ["diffuse", "sharpen", "contrastntexture", "denoiseprofile", "bilat", "localcontrast", "agx", "sigmoid", "rgbcurve", "tonecurve", "colorbalancergb"].includes(op));
    if (detail && eligible) {
      const full = this.fullView();
      const key = `${this.detailOps}:${full.width}:${full.height}:${full.scale}`;
      if (key !== this.detailKey) { this.detailKey = key; this.detailSlow = 0; }
      return this.detailSlow >= 2 ? { ...detail, draft: true, detail: true, loupe: true }
        : { ...full, draft: true, detail: true };
    }

    if (ops.length) this.draftKey = [...new Set(ops.map((op) => op.split("#")[0]))].sort().join();
    const steps = DRAFT_STEPS.filter((k) => k >= this.draftLimits().smallest);
    const k = steps[Math.min(draftSteps.get(this.draftKey) ?? 0, steps.length - 1)];
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
    if (f.view.detail) {
      if (!f.view.loupe && edits) {
        const ms = f.ms;
        if (ms > 0) this.detailSlow = ms > this.draftLimits().target ? this.detailSlow + 1 : 0;
      }
      return;
    }
    const size = `${f.width}x${f.height}`, first = size !== this.draftWas;
    this.draftWas = size;
    const ms = f.trace?.rust[2] ?? 0;
    if (first || !edits || ms < 1) return;
    const { target, smallest } = this.draftLimits();
    const steps = DRAFT_STEPS.filter((k) => k >= smallest);
    const i = Math.min(draftSteps.get(this.draftKey) ?? 0, steps.length - 1);
    if (ms > target && i < steps.length - 1) draftSteps.set(this.draftKey, i + 1);
    else if (i > 0 && ms * (steps[i - 1] / steps[i]) ** 2 < 0.8 * target) draftSteps.set(this.draftKey, i - 1);
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
    invoke("cancel_base").catch(() => {});
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
                           cycle?: Pick<Trace, "inputAt" | "edits" | "setStart">, every = false,
                           have: Frame[] = [], edits: ReturnType<Session["moduleEdit"]>[] = []): Promise<Frame> {
    const t0 = performance.now();
    const { width, height, scale, x, y } = view;
    const preview = this.previewMode();
    const skip = view.detail ? null : view.draft ? DRAFT_SKIP[preview].filter((op) => !this.draftKeep.has(op))
      : kind === "base" && !every ? BASE_SKIP[preview] : null;
    if (!view.draft) this.draftKeep.clear();
    const hex = (f: Frame) => f.hash!.toString(16).padStart(16, "0");
    const buf = await renderFrame({ width, height, scale, x, y, skip, draft: !!view.draft,
                                    base: kind === "base" && !view.draft,
                                    have: have.length ? have.map(hex) : null,
                                    edits: edits.length ? edits : null });
    const head = new DataView(buf, 0, 24);
    const u = (k: number) => head.getUint32(4 * k, true);
    const hash = new DataView(buf).getBigUint64(48, true);
    const kept = !u(0) && !u(1) ? have.find((f) => f.hash === hash) : undefined;
    const trace = perf.rendered({ kind, draft: !!view.draft, inputAt: cycle?.inputAt ?? null, edits: cycle?.edits ?? 0,
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
  // the Frame cache preference, in bytes, read at each frame kept
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
    this.current.set(key, f);
    for (const [k, old] of this.frames) {
      if (this.framesBytes <= this.frameBudget() || old === f) break;
      this.frames.delete(k);
      this.framesBytes -= old.pixels.byteLength;
      const shown = k.slice(0, k.lastIndexOf("|"));
      if (this.current.get(shown) === old) this.current.delete(shown);
    }
  }
  private heldFor(key: string) {
    return [...this.frames].filter(([k]) => k.startsWith(`${key}|`)).map(([, f]) => f);
  }
  // what the engine renders changed: no frame shown is known to show it.
  // the copy is put aside, for the engine to name if the image comes back
  private changed(keepDetail = false) {
    if (!keepDetail) this.detailCache = null;
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

  // the window the engine would render (_render in engine/main.c), cut
  // from the copy
  private cut(c: Frame, view: View): Frame {
    const W = c.width, H = c.height;
    const w = Math.min(view.width, W), h = Math.min(view.height, H);
    const x = Math.min(Math.max(view.x ?? 0, 0), W - w), y = Math.min(Math.max(view.y ?? 0, 0), H - h);
    const pixels = new Uint8ClampedArray(4 * w * h);
    for (let r = 0; r < h; r++) {
      const from = 4 * ((y + r) * W + x);
      pixels.set(c.pixels.subarray(from, from + 4 * w), 4 * r * w);
    }
    return { width: w, height: h, fullWidth: c.fullWidth, fullHeight: c.fullHeight, x, y, view, pixels, ms: 0,
             trace: perf.cached(w, h) };
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
      .then((f) => { if (!run.stale) use(f); })
      .catch((e) => { if (String(e) !== "canceled") this.onError(String(e)); })
      .finally(() => { if (this.baseInFlight === done) this.baseInFlight = null; });
    this.baseInFlight = done;
    await Promise.race([done, woken]);
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

  private async pump() {
    if (this.busy) {
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
        invoke("cancel_base").catch(() => {});
      }
      return;
    }
    this.busy = true;
    // the viewer's busy indicator: from now until a frame is back
    let job = begin();
    try {
      while (this.dirty.size || this.needRender || this.needThumb || this.needCopy || this.needWarm
             || this.wantLook !== undefined
             || this.masksPending || this.wantLookAmount !== undefined || this.spotsPending
             || this.reshapeDue || this.baselineEnd || this.modulePending.length) {
        // before the change that ended it; a save it makes is the one due
        if (this.baselineEnd) {
          this.baselineEnd = false;
          if (this.unsaved && !this.before) {
            window.clearTimeout(this.saveTimer);
            this.unsaved = false;
          }
          await invoke("baseline_end");
          continue;
        }
        // the engine saves on quitting, but never the Before view's settings:
        // it hears of the view before they go
        if (this.before && !this.engineBefore) {
          await invoke("before_view", { on: true });
          this.engineBefore = true;
          this.changed();
        }
        // a turn or a reframing goes first: masks and spots restored with
        // it (undo) are in its frame
        const framing = [...this.dirty].some((op) => FRAMING.has(op.split("#")[0]));
        if (this.dirty.has("flip") || framing) {
          const ops = [...this.dirty];
          this.dirty.clear();
          for (const op of ops) await invoke("set_params", this.moduleEdit(op));
          this.changed();
          if (framing) this.reshape = true;
          if (!this.before) { this.unsaved = true; this.scheduleSave(); }
          this.needRender = true;
          continue;
        }
        if (this.spotsPending) {
          const dirty = this.spotsDirty, on = !this.before;
          this.spotsDirty = false;
          if (dirty) await invoke("spots", { spots: this.spots });
          // a new set of spots comes on with them; the Before view turns
          // them off after
          if (dirty || on !== this.spotsOn) await invoke("spots_enable", { on });
          this.spotsOn = on;
          this.changed();
          if (dirty && !this.before) { this.unsaved = true; this.scheduleSave(); }
          this.needRender = true;
          continue;
        }
        if (this.wantLookAmount !== undefined && this.wantLook === undefined) {
          const amount = this.wantLookAmount;
          this.wantLookAmount = undefined;
          await invoke("look_amount", { amount });
          this.changed();
          if (!this.before) { this.unsaved = true; this.scheduleSave(); }
          this.needRender = true;
          continue;
        }
        if (this.masksPending) {
          const sent = await this.sendMasks();
          this.changed();
          if (sent && !this.before) { this.unsaved = true; this.scheduleSave(); }
          this.needRender = true;
          continue;
        }
        if (this.wantLook !== undefined) {
          const path = this.wantLook;
          this.wantLook = undefined;
          await invoke("look_apply", { path });
          this.changed();
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
          const r = await invoke<{ was: ModuleState; now: ModuleState }>("module_state",
            { op, priority, enabled: req.enabled, reset: req.reset, restore });
          this.changed();
          if (!this.modulesOpened.has(key)) this.modulesOpened.set(key, r.was);
          this.moduleStates.set(key, r.now);
          const item = this.history.find((h) => instanceKey(h) === key);
          if (item) await this.reread(mapOpOf(item));
          this.onModules?.();
          if (!this.before) { this.unsaved = true; this.scheduleSave(); }
          this.needRender = true;
          continue;
        }
        if (this.reshapeDue && !this.dirty.size) {
          this.reshape = false;
          await this.loadMasks();
          this.spots = await invoke<Spot[]>("spots", {});
          this.onShapes?.();
          continue;
        }
        if (!this.dirty.size && !this.needRender && this.needWarm) {
          this.needWarm = false;
          const view = this.draftSize();
          if (view) await this.renderView(view, "view");
          continue;
        }
        if (!this.dirty.size && !this.needRender && this.needThumb) {
          this.needThumb = false;
          await this.idleRender(this.thumbSize(), false, (thumb) => this.onThumb?.(thumb));
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
        const adaptive = this.detailCache;
        if (adaptive && !adaptive.blocked && adaptive.predictedValue === this.values[adaptive.id]
            && this.size().draft && this.cachedDetailPreview() && !this.before
            && adaptive.key === this.frameKey(this.fullView(),false)) {
          const wait = anchorInterval(adaptive.nativeMs,previewTiming().target) - (performance.now()-adaptive.lastStart);
          if (wait > 1) {
            clearTimeout(this.previewTimer);
            this.previewTimer = setTimeout(() => { this.previewTimer=undefined; void this.pump(); },wait);
            break;
          }
        }
        clearTimeout(this.previewTimer);
        this.previewTimer = undefined;
        const ops = [...this.dirty];
        this.dirty.clear();
        const cycle = perf.cycle();
        // sent with the render rather than one call each: on Linux a call
        // took 20 ms or more while the page drew (FINDINGS, "KDE on AMD")
        const edits = ops.map((op) => {
          this.draftKeep.add(op.split("#")[0]);
          return this.moduleEdit(op);
        });
        if (ops.length) this.changed(true);
        // the Before view is only for looking: nothing of it reaches the sidecar
        if (ops.length && !this.before) { this.unsaved = true; this.scheduleSave(); }
        this.needRender = false;
        // what the render shows is settled by now, whatever changes during it
        const before = !!this.before;
        const view = this.draftView(this.size(), ops), key = this.frameKey(view, before);
        const kept = view.draft || edits.length ? undefined : this.current.get(key);
        if (kept) {
          this.keepFrame(key, kept);
          this.onFrame({ ...kept, before, trace: perf.cached(kept.width, kept.height) });
        } else if (!view.draft && !edits.length && !before && this.copy && view.scale === this.copy.view.scale) {
          this.onFrame({ ...this.cut(this.copy, view), before });
        } else {
          const have = view.draft ? [] : this.heldFor(key);
          const cache = this.detailCache, cacheValue = cache ? this.values[cache.id] : undefined;
          const started = performance.now();
          if (cache) cache.lastStart = started;
          // Validate against the old anchors before training on this frame.
          const predicted = cache?.a && cache.b && cacheValue !== undefined && !cache.blocked
            ? interpolateDetail({pixels:cache.a.frame.pixels,value:cache.a.value},
                {pixels:cache.b.frame.pixels,value:cache.b.value},cacheValue,cache.range) : null;
          const f = await this.renderView(view, ops.length ? "edit" : "view", cycle, false, have, edits);
          if (cache && this.detailCache === cache && view.detail && !view.loupe && !before
              && this.frameKey(view,false) === cache.key && cacheValue !== undefined && cache.b?.value !== cacheValue) {
            cache.nativeMs = cache.nativeMs*0.5 + (performance.now()-started)*0.5;
            if (predicted) {
              const error = predictionError(predicted,f.pixels);
              if (error.mean>0.02 || error.p95>0.06) cache.blocked = true;
            }
            cache.a = cache.b; cache.b = {frame:f,value:cacheValue};
          }
          if (!view.draft) this.keepFrame(key, f);
          else this.draftTimed(f, edits.length);
          if (!before && !have.some((h) => h.hash === f.hash)) this.putAside = null;
          // Completed anchors must not overwrite newer slider feedback or a
          // frame from a released drag / changed viewport.
          const stale = cache && (this.detailCache !== cache || (cache.predictedValue !== undefined && cacheValue !== this.values[cache.id]));
          if (!stale) this.onFrame({ ...f, before });
        }
        progress(job);
      }
      // and that it is over only once the edit is back in it
      if (!this.before && this.engineBefore) {
        await invoke("before_view", { on: false });
        this.engineBefore = false;
        this.changed();
      }
    } catch (e) {
      this.onError(String(e));
    } finally {
      this.busy = false;
      end(job);
    }
  }

  private scheduleSave() {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      // the engine holds the Before view's settings; save once it is gone
      if (this.before) { this.scheduleSave(); return; }
      this.unsaved = false;
      invoke<{ edited: boolean }>("save").then((r) => this.onSaved?.(r.edited))
        .catch((e) => this.onError(String(e)));
    }, 600);
  }

  // darktable's compress history stack: the edit saved now, which compresses
  // what is stored, and that history read back to stand for the opened one
  async compressHistory() {
    if (this.before) this.showBefore(null);
    await this.settled();
    window.clearTimeout(this.saveTimer);
    this.unsaved = false;
    const r = await invoke<{ edited: boolean }>("save");
    this.onSaved?.(r.edited);
    this.history = await invoke<HistoryItem[]>("history", { saved: true });
    // nothing is left to undo, and a deleted instance is gone from it
    this.moduleStates.clear();
    this.modulesOpened.clear();
    this.deleted.clear();
    this.touched.clear();
    return this.history;
  }

  async close() {
    this.requestRender();
    window.clearTimeout(this.saveTimer);
    if (this.before) this.showBefore(null);
    while (this.busy || this.dirty.size || this.baseInFlight) await new Promise((r) => setTimeout(r, 20));
    if (!this.unsaved) return;
    this.unsaved = false;
    const r = await invoke<{ edited: boolean }>("save");
    this.onSaved?.(r.edited);
  }
}
