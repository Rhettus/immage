// Preferences' performance overlay: how long an edit takes from the control
// moving to its pixels on screen, stage by stage, and the GUI benchmark's
// recordings. while the overlay is off every hook returns at once
import { invoke } from "@tauri-apps/api/core";

const KEY = "immage.perfHud";
export function loadPerfHud(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}
export function storePerfHud(on: boolean) {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* not kept */ }
}

// darktable's -d perf line for one module (engine.rs, Timing)
export type Timing = { label: string; kind: "module" | "colorspace" | "other"; ms: number; cpu_ms: number;
                       pipe: string; gpu: boolean; tiled: boolean };

// in the order they happen
export const STAGES = [
  "queue",     // the edit waiting for the render before it to finish
  "set",       // set_params, one per module changed
  "lock",      // waiting for the engine behind another command
  "pipeline",  // darktable's pixelpipe
  "write",     // the engine writing the frame, and its reply
  "read",      // reading the frame back in Rust
  "probe",     // collecting the per-module timings
  "ipc",       // the frame crossing to the page
  "handoff",   // from the frame arriving to its drawing starting
  "draw",      // putImageData and the rest of drawFrame
  "histogram",
  "paint",     // to the next animation frame, when it is on screen
] as const;
export type Stage = typeof STAGES[number];

export type Sample = {
  at: number;                  // performance.now() at paint
  kind: "edit" | "view" | "base";
  draft: boolean;
  width: number;
  height: number;
  edits: number;               // control moves this frame carries
  total: number;               // input (or request) to paint, ms
  stages: Record<Stage, number>;
  modules: Timing[];
  label?: string;              // the GUI benchmark's step
};

// what renderView and drawFrame learn of one frame on its way
export type Trace = {
  kind: Sample["kind"];
  draft: boolean;
  inputAt: number | null;
  edits: number;
  setStart: number;
  setEnd: number;
  r0: number;                  // the render invoke made
  r1: number;                  // and back
  rust: number[];              // lock, request, pipeline, write, read, probe (main.rs, render)
  width: number;
  height: number;
  drawStart?: number;
  histogram: number;
  modules: Timing[];
};

const MAX_SAMPLES = 400;

// one module instance in one pipe, over the session
export type ModuleStat = { label: string; pipe: string; gpu: boolean; tiled: boolean;
                           runs: number; last: number; total: number; max: number; maxAt: number };

// the session's high marks: kept while the overlay is closed, until Reset or quitting
export type Session = {
  since: number;               // Date.now()
  modules: Map<string, ModuleStat>;
  worst: Partial<Record<Sample["kind"], Sample>>;
};
const newSession = (): Session => ({ since: Date.now(), modules: new Map(), worst: {} });

class Perf {
  enabled = loadPerfHud();
  samples: Sample[] = [];
  // the GUI benchmark's, with its step names
  recording: Sample[] | null = null;
  label = "";
  session = newSession();
  private inputAt: number | null = null;
  private edits = 0;
  private drawing: Trace | null = null;
  // the display's own frame rate, and frames that took over 50 ms
  fps = 0;
  longFrames = 0;
  private raf = 0;

  enable(on: boolean) {
    this.enabled = on;
    storePerfHud(on);
    void invoke("perf_set", { on }).catch(() => {});
    window.cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (on) this.watchFrames();
    else this.samples = [];
  }

  resetSession() {
    this.session = newSession();
  }

  private foldModules(ts: Timing[]) {
    const now = Date.now();
    for (const t of ts) {
      if (t.kind === "other") continue;
      const key = `${t.label} ${t.pipe}`;
      let m = this.session.modules.get(key);
      if (!m) {
        m = { label: t.label, pipe: t.pipe, gpu: t.gpu, tiled: t.tiled, runs: 0, last: 0, total: 0, max: 0, maxAt: now };
        this.session.modules.set(key, m);
      }
      m.runs++;
      m.last = t.ms;
      m.total += t.ms;
      m.gpu = t.gpu;
      m.tiled = t.tiled;
      if (t.ms > m.max) { m.max = t.ms; m.maxAt = now; }
    }
  }

  // tell Rust at startup
  init() {
    void invoke("perf_set", { on: this.enabled }).catch(() => {});
    if (this.enabled) this.watchFrames();
  }

  private watchFrames() {
    let last = performance.now(), count = 0, since = last;
    const tick = (t: number) => {
      if (t - last > 50) this.longFrames++;
      last = t;
      count++;
      if (t - since >= 500) {
        this.fps = (1000 * count) / (t - since);
        count = 0;
        since = t;
      }
      this.raf = window.requestAnimationFrame(tick);
    };
    this.raf = window.requestAnimationFrame(tick);
  }

  // a control moved (Session.set)
  input() {
    if (!this.enabled) return;
    this.inputAt ??= performance.now();
    this.edits++;
  }

  // a round of edits about to go to the engine: the moves it carries
  cycle(): Pick<Trace, "inputAt" | "edits" | "setStart"> {
    const c = { inputAt: this.inputAt, edits: this.edits, setStart: performance.now() };
    this.inputAt = null;
    this.edits = 0;
    return c;
  }

  // the render's header (main.rs, render) and its timings
  rendered(t: Omit<Trace, "rust" | "modules" | "histogram" | "r1">, buf: ArrayBuffer): Trace {
    const r1 = performance.now();
    const head = new DataView(buf, 24, 24);
    const rust = [0, 1, 2, 3, 4, 5].map((k) => head.getFloat32(4 * k, true));
    const trace: Trace = { ...t, r1, rust, histogram: 0, modules: [] };
    if (this.enabled) {
      // set in Rust before the frame came back, so already this frame's; the
      // sample made at paint shares the array
      void invoke<Timing[]>("perf_modules").then((m) => { trace.modules.push(...m); this.foldModules(m); }).catch(() => {});
    }
    return trace;
  }

  drawStart(t: Trace | undefined) {
    if (!this.enabled || !t) return;
    t.drawStart = performance.now();
    this.drawing = t;
  }

  // a histogram computed for the frame being drawn
  histogram<T>(f: () => T): T {
    const t0 = performance.now();
    const out = f();
    if (this.drawing) this.drawing.histogram += performance.now() - t0;
    return out;
  }

  drawEnd() {
    const t = this.drawing;
    this.drawing = null;
    if (!t || t.drawStart === undefined) return;
    const drawEnd = performance.now();
    const label = this.label;
    window.requestAnimationFrame(() => {
      const paint = performance.now();
      const [lock, request, pipeline, write, read, probe] = t.rust;
      const start = t.kind === "edit" ? (t.inputAt ?? t.setStart) : t.setStart;
      const stages: Record<Stage, number> = {
        queue: t.kind === "edit" && t.inputAt !== null ? t.setStart - t.inputAt : 0,
        set: t.setEnd - t.setStart,
        lock,
        pipeline,
        write: Math.max(0, request - pipeline),
        read,
        probe,
        ipc: Math.max(0, t.r1 - t.r0 - lock - request - read - probe),
        handoff: t.drawStart! - t.r1,
        draw: drawEnd - t.drawStart! - t.histogram,
        histogram: t.histogram,
        paint: paint - drawEnd,
      };
      const s: Sample = { at: paint, kind: t.kind, draft: t.draft, width: t.width, height: t.height,
                          edits: t.edits, total: paint - start, stages, modules: t.modules,
                          ...(label ? { label } : {}) };
      this.samples.push(s);
      if (this.samples.length > MAX_SAMPLES) this.samples.shift();
      this.recording?.push(s);
      const worst = this.session.worst[s.kind];
      if (!worst || s.total > worst.total) this.session.worst[s.kind] = s;
    });
  }
}

export const perf = new Perf();

// median and 95th percentile
export function percentiles(xs: number[]): { p50: number; p95: number } {
  if (!xs.length) return { p50: 0, p95: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { p50: at(0.5), p95: at(0.95) };
}
