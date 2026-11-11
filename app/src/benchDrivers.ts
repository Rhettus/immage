// SPDX-License-Identifier: GPL-3.0-or-later
// the Preferences GUI benchmark and GPU check, driven through the editor's own
// change path. App() passes what they touch in a BenchContext: refs are the
// ref objects themselves, so every read during a run sees the live value.
import type { MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { choiceShows, controlById, type Control } from "./manifest";
import { perf, percentiles, pingOnce, roundTrips, STAGES, webviewInfo, observeWebview } from "./perf";
import { frameTransport } from "./sharedFrames";
import { draftScale } from "./pixelRatio";
import { loadPreview } from "./Preferences";
import { tunerOptions } from "./tunerOptions";
import { GPU_CASES, resolveCase, verdict, cpuInGpuPass, tiledInGpuPass, type Parity } from "./gpuCheck";
import type { TunerRun } from "./previewTuning";
import type { Session } from "./session";
import type { Zoom } from "./zoom";

export type BenchContext = {
  session: MutableRefObject<Session | null>;
  benchRunning: MutableRefObject<boolean>;
  zoomRef: MutableRefObject<Zoom>;
  currentRef: MutableRefObject<{ path: string } | null>;
  dragging: MutableRefObject<boolean>;
  draftShown: MutableRefObject<boolean>;
  viewport: () => { w: number; h: number };
  setPerfHud: (on: boolean) => void;
  setZoom: (z: Zoom) => void;
  setStatus: (s: string) => void;
  change: (c: Control, v: number) => void;
  changeMany: (entries: [string, number][], label?: string) => void;
};

// Preferences' GUI benchmark: scripted drags of the main sliders through
// change(), as a hand would make them, then a zoom in and out and the idle
// base render, each frame timed by the overlay; every control ends where it
// started. the report goes to benchmarking/results/gui in a dev build
export const runGuiBenchmark = async (ctx: BenchContext): Promise<TunerRun> => {
  const { session, benchRunning, zoomRef, currentRef, dragging, draftShown, viewport, setPerfHud, setZoom, change } = ctx;
  const s = session.current;
  if (!s || benchRunning.current || perf.measuring) throw new Error("no photo open, or a benchmark is running");
  benchRunning.current = true;
  const originalZoom = zoomRef.current;
  const originalValues = new Map<string, number>();
  let stopMeasurement: (() => void) | null = null;
  try {
    stopMeasurement = await perf.startMeasurement();
    const initialViewport = viewport();
    const context = { photo:currentRef.current?.path ?? "", width:initialViewport.w, height:initialViewport.h, dpr:window.devicePixelRatio || 1 };
    const configuration = (await tunerOptions(setPerfHud)).map(({id,current,running}) => ({id,value:current,...(running === undefined ? {} : {running})}));
    const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
    const settle = async () => {
      await sleep(100);
      const deadline = performance.now() + 120000;
      while (!s.idle) {
        if (session.current !== s) throw new Error("photo changed during benchmark");
        if (performance.now() > deadline) throw new Error("benchmark timed out waiting for the renderer");
        await sleep(30);
      }
      if (session.current !== s) throw new Error("photo changed during benchmark");
      await sleep(300);
    };
    const steps: [string, number][] = [
      ["exposure", 1.5], ["contrast", 50], ["highlights", -60], ["shadows", 60], ["whites", 40], ["blacks", -40],
      ["temp", 1500], ["tint", 30], ["texture", 40], ["clarity", 40], ["dehaze", 30], ["vibrance", 30],
      ["saturation", 30], ["nr_luminance", 40], ["vig_amount", -30], ["grain_amount", 30],
    ];
    const preview = loadPreview();
    const drafts = true;
    // the web view measured idle, ahead of the run and its timing
    setZoom("fit");
    await settle();
    const webview = await webviewInfo();
    const idlePings: number[] = [];
    for (let i = 0; i < 100; i++) idlePings.push(await pingOnce());
    perf.resetFrontend();
    perf.recording = [];
    const t0 = performance.now();
    const longFramesBefore = perf.longFrames;
    // one call in flight at a time while the sliders drag, beside the renders
    const dragPings: number[] = [];
    let pinging = false;
    let pinger: Promise<void> = Promise.resolve();
    let resources: Record<string, unknown> | null = null;
    let stopWebview: ReturnType<typeof observeWebview> | null = null;
    let webviewTiming: ReturnType<ReturnType<typeof observeWebview>> | null = null;
    let resourceRecording = false;
    const phases: { atUnixMs: number; atMs: number; label: string }[] = [];
    const phase = (label: string) => { perf.label = label; phases.push({ atUnixMs: Date.now(), atMs: performance.now(), label }); };
    try {
      await invoke("perf_resources_start").then(() => { resourceRecording = true; })
        .catch((error) => { resources = { error: String(error) }; });
      stopWebview = observeWebview(typeof webview.frameRateHz === "number" ? webview.frameRateHz : null);
      phase("settling");
      await settle();
      pinging = true;
      pinger = (async () => {
        while (pinging) { dragPings.push(await pingOnce().catch(() => NaN)); await sleep(50); }
      })();
      for (const [baseId, delta] of steps) {
        const id = baseId === "clarity" && s.values.mod_clarity === 1 ? "detail_clarity_gain_medium"
          : baseId === "texture" && s.values.mod_texture === 1 ? "detail_texture_gain_fine" : baseId;
        const c = controlById.get(id);
        if (!c || !choiceShows(id, s.values)) continue;
        if (session.current !== s) throw new Error("photo changed during benchmark");
        const from = s.values[id] ?? c.neutral ?? 0;
        originalValues.set(id, from);
        const to = Math.min(c.max, Math.max(c.min, from + (id === baseId ? delta : (c.max - c.min) * 0.2)));
        // 30 moves out and 30 back, at about 60 a second
        phase(`${id} drag`);
        dragging.current = drafts;
        for (let i = 1; i <= 60; i++) {
          const k = i <= 30 ? i / 30 : (60 - i) / 30;
          if (session.current !== s) throw new Error("photo changed during benchmark");
          change(c, from + (to - from) * k);
          await sleep(16);
        }
        change(c, from);
        dragging.current = false;
        phase(`${id} release`);
        if (draftShown.current || s.pending) s.requestRender();
        await settle();
      }
      pinging = false;
      await pinger;
      phase("zoom 100%");
      setZoom(1);
      await settle();
      phase("zoom fit");
      setZoom("fit");
      await settle();
      // a drag begun while the base renders, which cancels it: the first
      // frame shows how long the base still held the engine
      const ex = controlById.get("exposure");
      const until = performance.now() + 5000;
      while (!s.baseRendering && performance.now() < until) await sleep(10);
      if (ex && s.baseRendering) {
        const from = s.values.exposure ?? ex.neutral ?? 0;
        phase("drag during base");
        dragging.current = drafts;
        for (let i = 1; i <= 20; i++) {
          if (session.current !== s) throw new Error("photo changed during benchmark");
          change(ex, from + 0.5 * (i <= 10 ? i / 10 : (20 - i) / 10));
          await sleep(16);
        }
        change(ex, from);
        dragging.current = false;
        phase("drag during base, release");
        if (draftShown.current || s.pending) s.requestRender();
        await settle();
      }
      // the sharper base, once editing has paused (scheduleBase)
      phase("idle base");
      await sleep(2500);
      await settle();
    } catch (error) {
      perf.recording = null;
      throw error;
    } finally {
      webviewTiming = stopWebview?.() ?? null;
      if (resourceRecording) {
        resources = await invoke<Record<string, unknown>>("perf_resources_stop")
          .catch((error) => ({ error: String(error) }));
      }
      pinging = false;
      await pinger;
      dragging.current = false;
      perf.label = "";
    }
    const seconds = (performance.now() - t0) / 1000;
    // a drag's last draft can finish after the label turns to its release;
    // it is the drag's, and the release is the full frame (and its wait)
    const dragOf = (l: string) => (l.endsWith(", release") ? l.slice(0, -", release".length)
                                                          : l.replace(/ release$/, " drag"));
    const samples = (perf.recording ?? []).map((x) =>
      x.draft && x.label?.endsWith(" release") ? { ...x, label: dragOf(x.label) } : x);
    perf.recording = null;
    const labels = [...new Set(samples.map((x) => x.label ?? ""))];
    const summary = labels.map((label) => {
      const of = samples.filter((x) => (x.label ?? "") === label);
      const stages = Object.fromEntries(STAGES.map((k) => [k, percentiles(of.map((x) => x.stages[k])).p50]));
      return { label, frames: of.length, ...percentiles(of.map((x) => x.total)), stages };
    });
    const { w, h } = viewport();
    const at = new Date();
    const report = {
      immage: "gui-benchmark", version: 9, at: at.toISOString(),
      app: await invoke<{ app: string; commit: string | null; darktable: string }>("about").catch(() => null),
      machine: await invoke<Record<string, unknown>>("perf_machine").catch(() => null),
      frontend: perf.frontendReport(), diagnostics: perf.diagnosticReport(),
      webview, webviewTiming, resources: { ...resources, phases },
      photo: (currentRef.current?.path ?? "").split(/[\\/]/).pop(),
      viewport: { width: w, height: h, dpr: window.devicePixelRatio || 1, draftScale: draftScale() }, dragDrafts: drafts, preview,
      configuration, transport: frameTransport(), seconds, displayLongFrames: perf.longFrames - longFramesBefore,
      invokeMs: { idle: roundTrips(idlePings), drag: roundTrips(dragPings.filter(Number.isFinite)) }, summary, samples,
    };
    const stamp = at.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const path = await invoke<string>("perf_report_write", { name: `gui-${stamp}`, report });
    return { path, samples, phases, context, valid: !webviewTiming?.backgrounded && w === context.width && h === context.height && (window.devicePixelRatio || 1) === context.dpr };
  } finally {
    if (session.current === s) {
      for (const [id, value] of originalValues) {
        const c = controlById.get(id);
        if (c && s.values[id] !== value) change(c, value);
      }
      setZoom(originalZoom);
    }
    dragging.current = false;
    perf.recording = null;
    perf.label = "";
    stopMeasurement?.();
    benchRunning.current = false;
  }
};

// Preferences' GPU check (gpuCheck.ts): each case's edit made through
// changeMany(), then the engine's CPU and GPU renders of it compared; a
// canceled GPU base, then the edit compared again. every control ends
// where it started. the report goes beside the GUI benchmark's
export const runGpuCheck = async (ctx: BenchContext): Promise<{ path: string; passed: number; total: number }> => {
  const { session, benchRunning, currentRef, dragging, draftShown, setPerfHud, setZoom, setStatus, change, changeMany } = ctx;
  const s = session.current;
  if (!s || benchRunning.current || perf.measuring) throw new Error("no photo open, or a benchmark is running");
  benchRunning.current = true;
  const original = { ...s.values };
  const touched = new Set<string>();
  const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
  const settle = async () => {
    await sleep(100);
    const deadline = performance.now() + 120000;
    while (!s.idle) {
      if (session.current !== s) throw new Error("photo changed during the GPU check");
      if (performance.now() > deadline) throw new Error("GPU check timed out waiting for the renderer");
      await sleep(30);
    }
  };
  const at = new Date();
  const stamp = at.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const opencl = () => invoke<Record<string, unknown>>("perf_machine").then((m) => m.opencl as Record<string, unknown> | null)
    .catch(() => null);
  const parity = async (name: string) => {
    try {
      return { parity: await invoke<Parity>("gpu_check_parity", { size: 1024, diff: `gpu-${stamp}-${name}` }) };
    } catch (e) { return { error: String(e) }; }
  };
  const restore = async () => {
    const back = [...touched].filter((id) => s.values[id] !== original[id]).map((id) => [id, original[id]] as [string, number]);
    if (back.length) { changeMany(back); await settle(); }
  };
  try {
    setZoom("fit");
    await settle();
    const before = await opencl();
    const machine = await invoke<Record<string, unknown>>("perf_machine").catch(() => null);
    const cases: Record<string, unknown>[] = [];
    if (before?.running) {
      for (const c of GPU_CASES) {
        if (session.current !== s) throw new Error("photo changed during the GPU check");
        setStatus(`GPU check: ${c.label}`);
        const r = resolveCase(c, s.values, (id) => controlById.get(id) ?? (id.startsWith("mod_") ? { min: 0, max: 9 } : undefined), choiceShows);
        if ("skipped" in r) { cases.push({ id: c.id, label: c.label, op: c.op, skipped: r.skipped }); continue; }
        if (r.entries.length) {
          r.entries.forEach(([id]) => touched.add(id));
          changeMany(r.entries);
          await settle();
        }
        const out = await parity(c.id);
        cases.push({ id: c.id, label: c.label, op: c.op, edits: r.entries, ...out,
          ...(out.parity ? { ...verdict(out.parity, c.op), cpuModules: cpuInGpuPass(out.parity),
                             tiledModules: tiledInGpuPass(out.parity) } : { pass: false, reasons: [out.error] }) });
        await restore();
      }
    }
    // a base render begun on the GPU and canceled by a drag, as
    // the GUI benchmark's "drag during base": the engine flushes the base
    // pipe's cache after a GPU stop (main.c, render). the edit compared
    // again afterwards shows whether the device still renders it alike
    let cancel: Record<string, unknown> | null = null;
    const ex = controlById.get("exposure");
    if (before?.running && ex) {
      setStatus("GPU check: canceling a GPU render");
      const from = s.values.exposure ?? ex.neutral ?? 0;
      touched.add("exposure");
      change(ex, from + 0.3);
      await settle();
      const until = performance.now() + 8000;
      while (!s.baseRendering && performance.now() < until) await sleep(10);
      const started = s.baseRendering;
      dragging.current = true;
      for (let i = 1; i <= 20; i++) { change(ex, from + 0.3 + 0.5 * (i <= 10 ? i / 10 : (20 - i) / 10)); await sleep(16); }
      dragging.current = false;
      change(ex, from + 0.3);
      if (draftShown.current || s.pending) s.requestRender();
      await settle();
      await sleep(2500);
      await settle();
      await restore();
      const out = await parity("after-cancel");
      const first = cases.find((c) => c.id === "edit")?.parity as Parity | undefined;
      cancel = { baseStarted: started, ...out,
        sameAsBefore: first && out.parity ? Math.abs(first.de.p99 - out.parity.de.p99) < 0.5 : null,
        ...(out.parity ? verdict(out.parity, "") : { pass: false, reasons: [out.error] }) };
    }
    const after = await opencl();
    const run = cases.filter((c) => !c.skipped);
    const report = {
      immage: "gpu-check", version: 1, at: at.toISOString(),
      app: await invoke<{ app: string; commit: string | null; darktable: string }>("about").catch(() => null),
      machine, configuration: (await tunerOptions(setPerfHud)).map(({ id, current, running }) => ({ id, value: current, ...(running === undefined ? {} : { running }) })),
      photo: (currentRef.current?.path ?? "").split(/[\\/]/).pop(), size: 1024,
      opencl: { before, after }, cases, cancel,
      passed: run.filter((c) => c.pass).length, total: run.length,
      ...(before?.running ? {} : { error: "no OpenCL device: darktable found none, or OpenCL is off" }),
    };
    const path = await invoke<string>("perf_report_write", { name: `gpu-${stamp}`, report });
    return { path, passed: report.passed, total: report.total };
  } finally {
    if (session.current === s) await restore().catch(() => {});
    dragging.current = false;
    benchRunning.current = false;
  }
};
