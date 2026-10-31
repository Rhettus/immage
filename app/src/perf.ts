// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Preferences' performance overlay: how long an edit takes from the control
// moving to its pixels on screen, stage by stage, and the GUI benchmark's
// recordings. while the overlay is off every hook returns at once
import { PerfDiagnostics } from "./perfDiagnostics";
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
  "set",       // the module edits sent with the render, one set each (main.rs, render)
  "lock",      // waiting for the engine behind another command
  "pipeline",  // darktable's pixelpipe
  "write",     // the engine writing the frame, and its reply
  "read",      // reading the frame back in Rust
  "probe",     // collecting the per-module timings
  "ipc",       // the frame crossing to the page
  "handoff",   // from the frame arriving to its drawing starting
  "draw",      // canvas upload or GPU draw and frame placement
  "histogram",
  "paint",     // next animation callback; does not measure compositor presentation
] as const;
export type Stage = typeof STAGES[number];

export type FrameDiagnostic = { frameId?: number; source?: "native" | "engine-reuse" | "local-reuse" | "estimated"; requestId?: number; firstInputId?: number; firstInputAt?: number; latestInputId?: number; label: string };
export type Sample = {
  diagnostic?: FrameDiagnostic;
  oldestInputLatency?: number;
  latestInputLatency?: number;
  estimated?: boolean;
  previewBackend?: "cpu" | "webgl";
  anchorUploads?: number;
  textureBytes?: number;
  at: number;                  // performance.now() at paint
  kind: "edit" | "view" | "base";
  draft: boolean;
  width: number;
  height: number;
  edits: number;               // control moves this frame carries
  total: number;               // input (or request) to paint, ms
  stages: Record<Stage, number>;
  modules: Timing[];
  moduleTimings?: { status:"pending" | "complete" | "unavailable" };
  label?: string;              // the GUI benchmark's step
};

// what renderView and drawFrame learn of one frame on its way
export type Trace = {
  measurement?: number;
  diagnostic?: FrameDiagnostic;
  oldestInputLatency?: number;
  latestInputLatency?: number;
  estimated?: boolean;
  previewBackend?: "cpu" | "webgl";
  anchorUploads?: number;
  textureBytes?: number;
  kind: Sample["kind"];
  draft: boolean;
  latestInputAt?: number | null;
  inputAt: number | null;
  edits: number;
  setStart: number;
  setEnd: number;
  r0: number;                  // the render invoke made
  r1: number;                  // and back
  rust: number[];              // lock, request, pipeline, write, read, probe, set (main.rs, render)
  width: number;
  height: number;
  drawStart?: number;
  drawOperationId?: number;
  histogram: number;
  modules: Timing[];
  moduleTimings?: { status:"pending" | "complete" | "unavailable" };
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
  private diagnostics = new PerfDiagnostics();
  private diagnosticsEnabled = true;
  measurement = 0;
  private shutdown: Promise<unknown> = Promise.resolve();
  get tracing() { return this.measuring && this.diagnosticsEnabled; }
  private firstInputId?: number;
  private latestInputId?: number;
  event(name: string, data?: Record<string, unknown>, id?: number) {
    if (this.tracing) this.diagnostics.record({ at: performance.now(), label: this.label, name, id, data });
  }
  begin(name: string, data?: Record<string, unknown>) {
    return this.tracing ? this.diagnostics.begin(performance.now(), this.label, name, data) : undefined;
  }
  finish(id: number | undefined, outcome = "end", data?: Record<string, unknown>) {
    if (this.tracing) this.diagnostics.finish(performance.now(), id, outcome, data);
  }
  request(data: Record<string, unknown>) { return this.begin("render", data); }
  command<T>(command: string, args?: Parameters<typeof invoke>[1], details?: Record<string, unknown>): Promise<T> {
    if (!this.tracing) return invoke<T>(command, args);
    const id = this.begin("command", { command, ...details });
    return invoke<T>(command, args).then(result => {
      this.finish(id); return result;
    }, error => {
      this.finish(id, "failed"); throw error;
    });
  }
  activeRenderIds(kind: string) {
    return this.tracing ? this.diagnostics.activeEvents().filter(e => e.name === "render.start" && e.data?.kind === kind).map(e => e.id) : [];
  }
  attribution(): FrameDiagnostic | undefined {
    return this.tracing ? { firstInputId: this.firstInputId, firstInputAt:this.inputAt ?? undefined, latestInputId: this.latestInputId, label: this.label } : undefined;
  }
  frame(diagnostic: FrameDiagnostic | undefined, source: FrameDiagnostic["source"]): FrameDiagnostic | undefined {
    if (!this.tracing) return undefined;
    const result = { ...diagnostic, label: diagnostic?.label ?? this.label, frameId: this.diagnostics.next(), source };
    this.event("frame.created", result);
    return result;
  }
  diagnosticReport() { const report = this.diagnostics.report(); return { ...report, enabled:this.diagnosticsEnabled, capabilities:this.diagnosticsEnabled ? report.capabilities : [] }; }
  enabled = loadPerfHud();
  measuring = false;
  samples: Sample[] = [];
  // the GUI benchmark's, with its step names
  recording: Sample[] | null = null;
  label = "";
  session = newSession();
  private inputAt: number | null = null;
  private edits = 0;
  private latestInputAt: number | null = null;
  private workSamples: { name: string; ms: number; label: string }[] = [];
  private counters: Record<string, Record<string, number>> = {};
  private droppedWorkSamples = 0;

  count(name: string, amount = 1) {
    if (!this.measuring) return;
    const step = this.counters[this.label] ??= {};
    step[name] = (step[name] ?? 0) + amount;
  }
  work(name: string, ms: number, label = this.label) {
    if (!this.measuring) return;
    if (this.workSamples.length < 30000) this.workSamples.push({ name, ms, label });
    else this.droppedWorkSamples++;
  }
  time<T>(name: string, fn: () => T): T {
    if (!this.measuring) return fn();
    const start = performance.now();
    try { return fn(); } finally { this.work(name, performance.now() - start); }
  }
  reactCommit = (id: string, phase: string, actualDuration: number, baseDuration: number,
                 startTime: number, commitTime: number) => {
    this.count(`react.${id}.${phase}`);
    this.work(`react.${id}.render`, actualDuration);
    this.work(`react.${id}.baseRender`, baseDuration);
    this.work(`react.${id}.renderToCommit`, commitTime - startTime);
  };
  resetFrontend() { this.workSamples = []; this.counters = {}; this.droppedWorkSamples = 0; }
  frontendReport() {
    const summarize = (xs: typeof this.workSamples) => Object.fromEntries(
      [...new Set(xs.map(x => x.name))].map(name => {
        const values = xs.filter(x => x.name === name).map(x => x.ms);
        return [name, { ...roundTrips(values), total: values.reduce((a, b) => a + b, 0) }];
      }));
    return { reactProfiling: true, note: "Work timings can overlap; worker compute is off-thread. React renderToCommit is elapsed scheduling time, not commit execution. Input-to-rAF is a callback proxy, not compositor presentation.",
      droppedWorkSamples: this.droppedWorkSamples, timings: summarize(this.workSamples),
      byStep: [...new Set([...Object.keys(this.counters), ...this.workSamples.map(x => x.label)])]
        .map(label => ({ label, counts: this.counters[label] ?? {}, timings: summarize(this.workSamples.filter(x => x.label === label)) })) };
  }
  private drawing: Trace | null = null;
  // the display's own frame rate, and frames that took over 50 ms
  fps = 0;
  longFrames = 0;
  private raf = 0;
  frameObserver: ((at: number, ms: number) => void) | null = null;

  enable(on: boolean) {
    this.enabled = on;
    storePerfHud(on);
    void invoke("perf_set", { on: on || this.measuring }).catch(() => {});
    window.cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (on || this.measuring) this.watchFrames();
    else this.samples = [];
  }

  // collect timings without changing the user's overlay preference
  async startMeasurement(diagnostics?: boolean): Promise<() => void> {
    if (this.measuring) throw new Error("another performance measurement is running");
    try { this.diagnosticsEnabled = diagnostics ?? (localStorage.getItem("immage.perfDiagnostics") !== "0"); }
    catch { this.diagnosticsEnabled = diagnostics ?? true; }
    this.measurement++;
    this.measuring = true;
    this.resetFrontend();
    this.diagnostics.reset();
    this.firstInputId = this.latestInputId = undefined;
    this.inputAt = this.latestInputAt = null; this.edits = 0;
    try {
      await this.shutdown;
      await invoke("perf_set", { on: true });
      await invoke(this.diagnosticsEnabled ? "perf_trace_start" : "perf_trace_stop");
    }
    catch (error) {
      this.measuring = false;
      void invoke("perf_set", { on:this.enabled }).catch(() => {});
      throw error;
    }
    if (!this.enabled) this.watchFrames();
    return () => {
      this.measuring = false;
      this.inputAt = this.latestInputAt = null; this.edits = 0;
      this.firstInputId = this.latestInputId = undefined;
      this.shutdown = invoke("perf_trace_stop").catch(() => {}).then(() => invoke("perf_set", { on: this.enabled })).catch(() => {});
      if (!this.enabled) { window.cancelAnimationFrame(this.raf); this.raf = 0; }
    };
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
      this.frameObserver?.(t, t - last);
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
  input(control?: string | string[]) {
    if (!this.enabled && !this.measuring) return;
    this.latestInputAt = performance.now();
    this.inputAt ??= this.latestInputAt;
    if (this.tracing) {
      this.latestInputId = this.diagnostics.next();
      this.firstInputId ??= this.latestInputId;
      this.event("input", { control, activeOperations: this.diagnostics.activeIds() }, this.latestInputId);
    }
    this.count("sliderInputs");
    this.edits++;
  }

  // a round of edits about to go to the engine: the moves it carries
  cycle(): Pick<Trace, "inputAt" | "latestInputAt" | "edits" | "setStart" | "diagnostic"> {
    const c = { diagnostic: this.attribution(), inputAt: this.inputAt, latestInputAt: this.latestInputAt, edits: this.edits, setStart: performance.now() };
    this.firstInputId = this.latestInputId = undefined;
    this.inputAt = null;
    this.edits = 0; this.latestInputAt = null;
    return c;
  }

  // the render's header (main.rs, render) and its timings
  rendered(t: Omit<Trace, "rust" | "modules" | "histogram" | "r1">, buf: ArrayBuffer): Trace {
    const r1 = performance.now();
    const head = new DataView(buf, 24, 24);
    const rust = [0, 1, 2, 3, 4, 5].map((k) => head.getFloat32(4 * k, true));
    rust.push(new DataView(buf).getFloat32(56, true));
    const trace: Trace = { measurement:this.measurement, ...t, r1, rust, histogram: 0, modules: [] };
    if (this.enabled || this.measuring) {
      // set in Rust before the frame came back, so already this frame's; the
      // sample made at paint shares the array
      trace.moduleTimings = { status:"pending" };
      void invoke<Timing[]>("perf_modules", { request:t.diagnostic?.requestId }).then((m) => {
        trace.modules.push(...m); this.foldModules(m); trace.moduleTimings!.status="complete";
      }).catch(() => { trace.moduleTimings!.status="unavailable"; });
    }
    return trace;
  }

  // a frame shown again from Session's kept frames: no engine time
  cached(width: number, height: number, cycle?: Pick<Trace, "diagnostic" | "inputAt" | "latestInputAt" | "edits" | "setStart">, source: FrameDiagnostic["source"] = "local-reuse"): Trace {
    const now = performance.now();
    return { measurement:this.measurement, diagnostic: this.frame(cycle?.diagnostic, source), kind: cycle?.edits ? "edit" : "view", draft: false, inputAt: cycle?.inputAt ?? null, latestInputAt: cycle?.latestInputAt, edits: cycle?.edits ?? 0, setStart: cycle?.setStart ?? now, setEnd: now, r0: now, r1: now,
             rust: [0, 0, 0, 0, 0, 0, 0], width, height, histogram: 0, modules: [] };
  }

  discard(t: Trace | undefined, reason: string) {
    if (this.measuring && t?.measurement !== undefined && t.measurement !== this.measurement) return;
    this.event("frame.discarded", { ...t?.diagnostic, reason });
  }

  drawStart(t: Trace | undefined) {
    if ((!this.enabled && !this.measuring) || !t) return;
    if (this.measuring && t.measurement !== undefined && t.measurement !== this.measurement) return;
    t.drawStart = performance.now();
    t.drawOperationId = this.begin("draw", { ...t.diagnostic });
    this.drawing = t;
  }

  // a histogram computed for the frame being drawn
  histogram<T>(f: () => T): T {
    const t0 = performance.now();
    const out = f();
    if (this.drawing) this.drawing.histogram += performance.now() - t0;
    return out;
  }

  drawEnd(shown = true) {
    const t = this.drawing;
    this.drawing = null;
    if (!t || t.drawStart === undefined) return;
    this.finish(t.drawOperationId, shown ? "end" : "skipped", { ...t.diagnostic });
    if (!shown) return;
    this.count(t.estimated ? "estimatedFramesDrawn" : "nativeFramesDrawn");
    const drawEnd = performance.now();
    const label = this.label;
    const measurement = this.measurement;
    window.requestAnimationFrame(() => {
      if (this.measurement !== measurement) return;
      const paint = performance.now();
      if (t.kind === "edit") this.work("inputToRaf.latestCarriedInput", paint - (t.latestInputAt ?? t.inputAt ?? t.setStart), label);
      const [lock, request, pipeline, write, read, probe, sent] = t.rust;
      const start = t.kind === "edit" ? (t.inputAt ?? t.setStart) : t.setStart;
      const stages: Record<Stage, number> = {
        queue: t.kind === "edit" && t.inputAt !== null ? t.setStart - t.inputAt : 0,
        set: t.setEnd - t.setStart + sent,
        lock,
        pipeline,
        write: Math.max(0, request - pipeline),
        read,
        probe,
        ipc: Math.max(0, t.r1 - t.r0 - lock - sent - request - read - probe),
        handoff: t.drawStart! - t.r1,
        draw: drawEnd - t.drawStart! - t.histogram,
        histogram: t.histogram,
        paint: paint - drawEnd,
      };
      this.event("frame.raf", { ...t.diagnostic });
      const s: Sample = { diagnostic: t.diagnostic, oldestInputLatency:t.diagnostic?.firstInputAt != null ? paint-t.diagnostic.firstInputAt : undefined, latestInputLatency: t.latestInputAt != null ? paint - t.latestInputAt : undefined, estimated:t.estimated, previewBackend:t.previewBackend,
                          anchorUploads:t.anchorUploads, textureBytes:t.textureBytes,
                          at: paint, kind: t.kind, draft: t.draft, width: t.width, height: t.height,
                          edits: t.edits, total: paint - start, stages, modules: t.modules, moduleTimings:t.moduleTimings,
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

// round trips of a call that does nothing (main.rs, perf_ping), ms: what
// the web view's IPC costs apart from any work. slow while the page is
// idle, the IPC itself is slow; slow only during drags, the page's drawing
// holds it up
export type RoundTrips = { n: number; p50: number; p95: number; min: number; max: number };
export function roundTrips(ms: number[]): RoundTrips {
  const r = (x: number) => Math.round(x * 100) / 100;
  const { p50, p95 } = percentiles(ms);
  return { n: ms.length, p50: r(p50), p95: r(p95), min: r(ms.length ? Math.min(...ms) : 0),
           max: r(ms.length ? Math.max(...ms) : 0) };
}
export async function pingOnce(): Promise<number> {
  const t = performance.now();
  await invoke("perf_ping");
  return performance.now() - t;
}

// the web view a GUI benchmark ran in: its user agent and WebGL renderer
// (this identifies the WebGL context, not the compositor),
// and how often it runs animation frames, which bounds the paint stage: the
// display's refresh rate, or less where WebKit throttles them (macOS' Low
// Power Mode halves them). measured idle, before the benchmark
export async function webviewInfo(): Promise<Record<string, unknown>> {
  let gpu: { vendor: string; renderer: string; version: string } | null = null;
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const dbg = gl?.getExtension("WEBGL_debug_renderer_info");
    if (gl) gpu = { vendor: String(gl.getParameter(dbg ? dbg.UNMASKED_VENDOR_WEBGL : gl.VENDOR)),
                    renderer: String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
                    version: String(gl.getParameter(gl.VERSION)) };
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch { /* no WebGL: gpu stays null */ }
  // the median of 60 animation frames' intervals. a hidden window has none,
  // so it waits 2 s at most
  const at: number[] = [];
  await new Promise<void>((done) => {
    const tick = (t: number) => { at.push(t); if (at.length > 60) done(); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    window.setTimeout(done, 2000);
  });
  const gaps = at.slice(1).map((t, i) => t - at[i]);
  const hz = gaps.length >= 10 ? Math.round(1000 / percentiles(gaps).p50) : NaN;
  return { userAgent: navigator.userAgent, gpu, frameRateHz: Number.isFinite(hz) ? hz : null };
}

// reuse the overlay's rAF callback; timers measure scheduling delay without driver queries
export function observeWebview(refreshHz: number | null) {
  type Observation = { atUnixMs: number; ms: number; label: string; hidden: boolean };
  const frames: Observation[] = [], loop: Observation[] = [];
  const start = performance.now();
  const visibilityChanges: { atUnixMs: number; hidden: boolean }[] = [];
  const visibility = () => visibilityChanges.push({ atUnixMs: Date.now(), hidden: document.hidden });
  visibility();
  document.addEventListener("visibilitychange", visibility);
  const observation = (ms: number): Observation => ({ atUnixMs: Date.now(), ms, label: perf.label, hidden: document.hidden });
  perf.frameObserver = (at, ms) => { if (at - ms >= start) frames.push(observation(ms)); };
  let due = performance.now() + 100;
  let timer = window.setTimeout(tick, 100);
  function tick() {
    loop.push(observation(Math.max(0, performance.now() - due)));
    due = performance.now() + 100;
    timer = window.setTimeout(tick, 100);
  }
  const stats = (values: number[]) => {
    if (!values.length) return { n: 0, p50: null, p95: null, p99: null, max: null };
    const sorted = [...values].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    return { n: sorted.length, p50: at(.5), p95: at(.95), p99: at(.99), max: sorted.at(-1) };
  };
  return () => {
    perf.frameObserver = null;
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", visibility);
    const budget = refreshHz && refreshHz > 0 ? 1000 / refreshHz : null;
    const summarize = (fs: Observation[], ls: Observation[]) => {
      const visible = fs.filter((x) => !x.hidden);
      return { frameIntervalMs: stats(visible.map((x) => x.ms)),
        eventLoopDelayMs: stats(ls.filter((x) => !x.hidden).map((x) => x.ms)),
        longFrames50ms: visible.filter((x) => x.ms > 50).length,
        missedRefreshSlots: budget ? visible.reduce((n, x) => n + Math.max(0, Math.round(x.ms / budget) - 1), 0) : null };
    };
    return { refreshHz, frameBudgetMs: budget, timerIntervalMs: 100,
      note: "rAF measures callback pacing, not compositor presentation; missed slots are estimates against the idle callback rate",
      ...summarize(frames, loop),
      byStep: [...new Set([...frames, ...loop].map((x) => x.label))].map((label) => ({ label,
        ...summarize(frames.filter((x) => x.label === label), loop.filter((x) => x.label === label)) })),
      frames, eventLoop: loop, visibilityChanges, backgrounded: visibilityChanges.some((x) => x.hidden) };
  };
}
