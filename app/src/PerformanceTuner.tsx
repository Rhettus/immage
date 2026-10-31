// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { perf, observeWebview, percentiles } from "./perf";
import { loadPreview, loadBalancedPreviewSize, loadDraftSmallest, loadDraftTarget, loadCachedExposurePreview } from "./Preferences";
import { measureTuner, searchTuner, tunerChanges, type TunerSettings, type TunerRun, type TunerMeasurement, type TunerContext, type TunerTrial } from "./previewTuning";
import { tunerOptions, type TunerOption } from "./tunerOptions";
import { startTunerWork, stopTunerWork, type WorkSample } from "./tunerWorkload";

const PENDING = "immage.performanceTuner.pending";
type WorkResult = { settings: Record<string,string>; samples: WorkSample[]; path: string };
type Pending = { fps: number; latency: number; work: WorkResult[]; navigationPending: boolean; context?:TunerContext };
function loadPending(): Pending | null {
  try {
    const v = JSON.parse(localStorage.getItem(PENDING) ?? "null");
    return v && [15,30,60].includes(v.fps) && [50,100,200].includes(v.latency) && Array.isArray(v.work) ? v : null;
  } catch { return null; }
}
export const hasPendingTuner = () => !!loadPending();
const settings = (): TunerSettings => ({ preview:loadPreview(), balancedSize:loadBalancedPreviewSize(), smallest:loadDraftSmallest(), draftTarget:loadDraftTarget(), cachedExposure:loadCachedExposurePreview() });
const navSamples = (samples: WorkSample[]) => samples.filter((s) => s.ok && (s.name === "Photo open" || s.name === "Immich original resolve"));

export function PerformanceTuner({ run, onClose, onRelaunch, onOverlay, photo, raw, previewArea }: {
  photo?:string; raw?:boolean; previewArea?:{w:number;h:number};
  run: () => Promise<TunerRun>; onClose: () => void; onRelaunch: () => Promise<void>; onOverlay: (on: boolean) => void;
}) {
  const pending = useRef(loadPending());
  const [fps, setFps] = useState(pending.current?.fps ?? 30);
  const [latency, setLatency] = useState(pending.current?.latency ?? 100);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const lock = useRef(false);
  const [progress, setProgress] = useState("");
  const [trials, setTrials] = useState<TunerTrial[]>([]);
  const [testedSettings, setTestedSettings] = useState<TunerSettings | null>(null);
  const [result, setResult] = useState<TunerMeasurement | null>(null);
  const [proposal, setProposal] = useState<TunerSettings | null>(null);
  const [changes, setChanges] = useState<string[]>([]);
  const [context, setContext] = useState<TunerContext | undefined>(pending.current?.context);
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [verified, setVerified] = useState(false);
  const [options, setOptions] = useState<TunerOption[]>([]);
  const [chosen, setChosen] = useState<Record<string,string>>({});
  const [work, setWork] = useState<WorkResult[]>(pending.current?.work ?? []);
  const [navigationPending, setNavigationPending] = useState(pending.current?.navigationPending ?? false);
  const capture = useRef<{ start:number; settings:Record<string,string>; stopMeasurement:()=>void; stop:ReturnType<typeof observeWebview> } | null>(null);
  const mounted = useRef(true);
  const reload = async (resetCandidates = true) => {
    const all = await tunerOptions(onOverlay);
    if (mounted.current) { setOptions(all); if (resetCandidates) setChosen(Object.fromEntries(all.map((o) => [o.id,o.current]))); }
    return all;
  };
  const measure = async () => {
    const runResult = await run();
    if (pending.current?.context && JSON.stringify(runResult.context) !== JSON.stringify(pending.current.context)) {
      throw new Error("Relaunch verification needs the same photo, window size and display scale. Restore them and run the tuner again.");
    }
    setContext(runResult.context);
    const measured = measureTuner(runResult);
    setResult(measured); setPath(runResult.path);
    setTestedSettings(settings()); setProposal(null); setChanges([]);
  };
  const startMeasure = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try { await measure(); setVerified(!!pending.current); pending.current = null; localStorage.removeItem(PENDING); }
    catch (e) { setError(String(e)); }
    finally { lock.current = false; setBusy(false); }
  };
  const search = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); setTrials([]);
    const original = settings();
    try {
      const all = await reload();
      const applySettings = async (s:TunerSettings) => {
        for (const [id,value] of Object.entries({preview:s.preview,balancedSize:s.balancedSize,smallest:s.smallest,draftTarget:s.draftTarget,cachedExposure:s.cachedExposure})) {
          const option = all.find((o) => o.id === id);
          if (!option) throw new Error(`Missing tuner option: ${id}`);
          await option.set(String(value));
        }
      };
      const best = await searchTuner(original,{fps,latency},applySettings,run,(s,i,total) => setProgress(`Testing ${i}/${total}: ${s.preview}${s.preview === "balanced" ? ` ${s.balancedSize*100}%` : ""}, smallest draft ${s.smallest*100}%`));
      setTrials(best.trials); setResult(best.trial.measurement); setPath(best.trial.path); setTestedSettings(best.trial.settings); setVerified(false);
      const adjustments = tunerChanges(original,best.trial.settings);
      setProposal(adjustments.length ? best.trial.settings : null); setChanges(adjustments);
      if (!best.met) setError("No tested preview configuration reached both targets. The best measured result is shown; consider a smaller window or lower targets.");
    } catch (e) { setResult(null); setProposal(null); setError(String(e)); }
    finally {
      try { await reload(); } finally { lock.current = false; setBusy(false); setProgress(""); }
    }
  };
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void reload().then(() => { if (!cancelled && pending.current) void startMeasure(); }).catch((e) => setError(String(e)));
    return () => {
      cancelled = true; mounted.current = false;
      if (capture.current) {
        capture.current.stop(); stopTunerWork(); perf.recording = null;
        capture.current.stopMeasurement();
        void invoke("perf_resources_stop").catch(() => {});
        capture.current = null;
      }
    };
  }, []);
  const passed = result?.complete && result.fps >= fps && result.latency <= latency;
  const selected = options.filter((o) => chosen[o.id] !== o.current);
  const restart = selected.some((o) => o.restart);
  const needsBaseline = selected.some((o) => o.workload === "navigation") && !work.some((r) => navSamples(r.samples).length);
  const apply = async (recommended: boolean) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    const prior = Object.fromEntries(options.map((o) => [o.id,o.current]));
    // recommendations change only their named fields, never other unreviewed candidates
    const updates = recommended && proposal ? { ...prior,preview:proposal.preview,balancedSize:String(proposal.balancedSize),smallest:String(proposal.smallest),draftTarget:String(proposal.draftTarget),cachedExposure:String(proposal.cachedExposure) } : chosen;
    const changed = options.filter((o) => updates[o.id] !== o.current);
    const applied: TunerOption[] = [];
    try {
      for (const option of changed) {
        if (!option.values.some((v) => v.value === updates[option.id])) throw new Error(`Invalid value for ${option.label}`);
        applied.push(option); await option.set(updates[option.id]);
      }
      const navPending = changed.some((o) => o.workload === "navigation");
      setNavigationPending(navPending);
      if (changed.some((o) => o.restart)) {
        localStorage.setItem(PENDING,JSON.stringify({fps,latency,work,navigationPending:navPending,context} satisfies Pending));
        await onRelaunch(); return;
      }
      const appliedOptions = await reload();
      for (const o of changed) if (appliedOptions.find((p) => p.id === o.id)?.current !== updates[o.id]) throw new Error(`Could not persist ${o.label}`);
      await measure(); setVerified(true);
    } catch (e) {
      const failures: string[] = [];
      for (const option of [...applied].reverse()) {
        try { await option.set(prior[option.id]); } catch { failures.push(option.label); }
      }
      localStorage.removeItem(PENDING); setResult(null); setVerified(false);
      setError(`${e}. ${failures.length ? `Could not restore: ${failures.join(", ")}` : "Previous settings restored."}`);
      await reload();
    } finally { lock.current = false; setBusy(false); }
  };
  const record = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    let started = false;
    try {
      const all = await reload(false);
      await invoke("perf_resources_start"); started = true;
      const stopMeasurement = await perf.startMeasurement();
      perf.recording = []; startTunerWork();
      capture.current = {start:performance.now(),settings:Object.fromEntries(all.map((o) => [o.id,o.current])),stopMeasurement,stop:observeWebview(null)};
      setRecording(true);
    } catch (e) {
      if (started) await invoke("perf_resources_stop").catch(() => {});
      lock.current = false; setError(String(e));
    } finally { setBusy(false); }
  };
  const finish = async () => {
    const c = capture.current;
    if (!c) return;
    capture.current = null; setRecording(false); setBusy(true);
    const samples = stopTunerWork(), frames = perf.recording ?? [], webviewTiming = c.stop();
    perf.recording = null;
    c.stopMeasurement();
    try {
      const resources = await invoke("perf_resources_stop");
      const currentOptions = await tunerOptions(onOverlay);
      if (currentOptions.some((o) => c.settings[o.id] !== o.current)) throw new Error("Settings changed during recording. Repeat the workload without changing preferences.");
      const cacheUsage = await invoke("cache_usage").catch(() => null);
      const at = new Date();
      const reportPath = await invoke<string>("perf_report_write", {name:`tuner-${at.toISOString().replace(/[:.]/g,"-")}`,report:{immage:"performance-tuner-workload",version:1,at:at.toISOString(),workload:"navigation",settings:c.settings,seconds:(performance.now()-c.start)/1000,samples,frames,webviewTiming,resources,cacheUsage}});
      setWork((old) => [...old,{settings:c.settings,samples,path:reportPath}]);
      if (navSamples(samples).length) setNavigationPending(false);
      else setError("No completed photo opens were captured. Repeat the recording and finish opening photos before stopping.");
    } catch (e) { setError(String(e)); }
    finally { lock.current = false; setBusy(false); }
  };
  const close = () => { localStorage.removeItem(PENDING); onClose(); };
  if (recording) return <div role="status" style={{position:"fixed",bottom:24,left:24,zIndex:1000,background:"var(--panel)",padding:16,maxWidth:440,border:"1px solid currentColor"}}>
    <p>Recording navigation. Step through the same photos in both directions, pausing for read ahead. Reopen the same Immich originals to compare their disk cache.</p>
    <button className="btn" onClick={() => void finish()}>Stop and compare</button>
  </div>;
  if (busy) return <div className="modal-backdrop" style={{background:"transparent"}}><div role="status" style={{alignSelf:"flex-end",background:"var(--panel)",padding:16}}>{progress || "Performance tuner: measuring or applying settings…"} Leave the app in front and wait.</div></div>;
  return <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="tuner-title" style={{width:820,maxWidth:"95vw",maxHeight:"90vh"}}>
    <div className="modal-head"><h2 id="tuner-title">Performance tuner</h2></div>
    <div className="modal-body" style={{overflowY:"auto"}}>
      <p><strong>Before running: load a representative RAW file from your typical work, and size the window as you normally use it.</strong> Use a copy with a typical edit, including the modules and masks you normally use. Camera resolution, edits and preview area affect the result.</p>
      {photo && <p>Current photo: {photo.split(/[\\/]/).pop()}{raw === false ? " (not a RAW file; choose a representative RAW for useful recommendations)" : ""}. {previewArea ? `Preview area: ${Math.round(previewArea.w)} × ${Math.round(previewArea.h)} pixels.` : ""}</p>}
      <p>Starts with full-quality previews and tests progressively lighter settings on the open photo at this window size. Stops at the highest-quality tested setup that meets both targets. Your settings are restored until you choose Apply. Sliders return to their starting values, but the benchmark adds history; use a copy of a photo you care about.</p>
      <label>Target FPS <select className="field" value={fps} onChange={(e) => {setFps(Number(e.target.value));setVerified(false);}}>{[15,30,60].map((n) => <option key={n}>{n}</option>)}</select></label>{" "}
      <label>Maximum latency <select className="field" value={latency} onChange={(e) => {setLatency(Number(e.target.value));setVerified(false);}}>{[50,100,200].map((n) => <option key={n} value={n}>{n} ms</option>)}</select></label>
      <p>Editing targets apply to the slowest slider: rendered photo FPS per drag and the worst drag's 95th percentile input-to-paint latency.</p>
      {result && <>
        <p role="status">{passed ? verified ? "Verified: editing targets reached." : proposal ? "The highest-quality passing preview is ready to apply." : "Current settings meet the editing targets." : "Editing targets not reached."} Slowest drag: {result.fps.toFixed(1)} FPS; worst latency: {Number.isFinite(result.latency) ? `${result.latency.toFixed(0)} ms` : "unavailable"}.</p>
        {!result.complete && <p>The run had too few frames, was backgrounded, or the viewport changed. Repeat it with the app visible at the same window size.</p>}
        {changes.length > 0 && <><p>Recommended next adjustments in Preferences → Performance:</p><ul>{changes.map((c) => <li key={c}>{c}</li>)}</ul><p>Smaller previews are softer while dragging. Apply measures again to check the targets.</p></>}
        {!passed && !proposal && <p>Compare the other options below or lower the targets.</p>}
        {result.modules.length > 0 && <p>Costliest measured modules: {result.modules.map(([n,ms]) => `${n} (${ms.toFixed(1)} ms per execution)`).join(", ")}. Module alternatives can change the image: compare them on a copy in Preferences → Modules.</p>}
        {path && <p style={{overflowWrap:"anywhere"}}>Editing report: {path}</p>}
      </>}
      {testedSettings && <p>Tested preview: {testedSettings.preview}{testedSettings.preview === "balanced" ? ` ${testedSettings.balancedSize*100}%` : ""}; smallest draft: {testedSettings.smallest*100}%.</p>}
      {trials.length > 0 && <details><summary>Quality search: {trials.length} measured configurations</summary><table><thead><tr><th>Preview</th><th>Smallest draft</th><th>FPS</th><th>Latency p95</th></tr></thead><tbody>{trials.map((t,i) => <tr key={i}><td>{t.settings.preview}{t.settings.preview === "balanced" ? ` ${t.settings.balancedSize*100}%` : ""}</td><td>{t.settings.smallest*100}%</td><td>{t.measurement.fps.toFixed(1)}</td><td>{Number.isFinite(t.measurement.latency) ? `${t.measurement.latency.toFixed(0)} ms` : "unavailable"}</td></tr>)}</tbody></table></details>}
      <details><summary>Performance options: measure and change</summary>
        <p>Choose candidates, then Apply and verify. Editing options rerun the GUI benchmark. Navigation options require recording the same work before and after applying. Warm caches and different photos affect comparisons. Reducing the originals cache can evict downloaded originals; edited originals are retained.</p>
        <table style={{width:"100%"}}><thead><tr><th>Option</th><th>Candidate</th><th>Measurement</th></tr></thead><tbody>{options.map((o) => <tr key={o.id}><td>{o.label}{o.restart ? " (relaunch)" : ""}</td><td><select aria-label={o.label} className="field" value={chosen[o.id] ?? o.current} onChange={(e) => setChosen((old) => ({...old,[o.id]:e.target.value}))}>{o.values.map((v) => <option key={v.value} value={v.value}>{v.label}{v.value === o.current ? " (current)" : ""}</option>)}</select></td><td>{o.workload}</td></tr>)}</tbody></table>
        <p>Unavailable hardware options are omitted. Balanced size affects Balanced only; full-size Balanced disables smaller drafts. Memory and cache limits need workloads large enough to exercise their limits. AI acceleration and thumbnail caches are excluded.</p>
      </details>
      <p><button className="btn" onClick={() => void record()}>Record navigation workload</button> Step through the same photos in both directions, pausing for read ahead. To test Immich originals, reopen the same Immich photos.</p>
      <p>Recording includes frame timing and resource usage. Reports retain settings and cache usage. This measures photo opening separately from slider FPS.</p>
      {selected.length > 0 && !result && <p>Run the editing benchmark before applying candidates, to keep a baseline.</p>}
      {needsBaseline && <p>Record a navigation baseline before applying the selected navigation settings.</p>}
      {navigationPending && <p>Navigation verification pending. Record the same navigation workload again before judging the changed settings.</p>}
      {work.length > 0 && <table style={{width:"100%"}}><thead><tr><th>Navigation run</th><th>Completed operations</th><th>Operation p95</th></tr></thead><tbody>{work.map((r,i) => {
        const samples = navSamples(r.samples), names = [...new Set(samples.map((s) => s.name))];
        return <tr key={i}><td title={r.path}>{i+1}</td><td>{names.map((n) => `${n}: ${samples.filter((s) => s.name === n).length}`).join("; ") || "Unmeasured"}</td><td>{names.map((n) => `${n}: ${percentiles(samples.filter((s) => s.name === n).map((s) => s.ms)).p95.toFixed(1)} ms`).join("; ")}</td></tr>;
      })}</tbody></table>}
      {error && <p role="alert">{error}</p>}
    </div>
    <div className="modal-foot" style={{flexWrap:"wrap"}}>
      <button className="btn" onClick={close}>{result ? "Cancel remaining adjustments" : "Cancel"}</button>
      <button className="btn" onClick={() => void search()}>Find best preview</button>
      <button className="btn" onClick={() => void startMeasure()}>Measure current settings</button>
      {proposal && <button className="btn primary" onClick={() => void apply(true)}>Apply recommendation and verify</button>}
      {selected.length > 0 && <button className="btn primary" disabled={needsBaseline || !result} onClick={() => void apply(false)}>{restart ? "Apply, relaunch and verify" : "Apply selected and verify"}</button>}
    </div>
  </div></div>;
}
