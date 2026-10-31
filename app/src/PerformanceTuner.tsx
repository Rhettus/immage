// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { perf, observeWebview } from "./perf";
import { loadPreview, loadBalancedPreviewSize, loadDraftSmallest, loadDraftTarget, loadCachedDetailPreview } from "./Preferences";
import { measureTuner, searchTuner, trimmedMedian, tunerChanges, type TunerSettings, type TunerRun, type TunerMeasurement, type TunerContext, type TunerTrial } from "./previewTuning";
import { tunerOptions, type TunerOption } from "./tunerOptions";
import { startTunerWork, stopTunerWork, type WorkSample } from "./tunerWorkload";

import { storePreviewTiming } from "./cachedDetail";

const PENDING = "immage.performanceTuner.pending";
type WorkResult = { settings: Record<string,string>; samples: WorkSample[]; path: string };
type Pending = { fps: number; latency: number; work: WorkResult[]; navigationPending: boolean; context?:TunerContext };
function loadPending(): Pending | null {
  try {
    const v = JSON.parse(localStorage.getItem(PENDING) ?? "null");
    return v && [15,30,60].includes(v.fps) && [50,80,100,200].includes(v.latency) && Array.isArray(v.work) ? v : null;
  } catch { return null; }
}
export const hasPendingTuner = () => !!loadPending();
const settings = (): TunerSettings => ({ preview:loadPreview(), balancedSize:loadBalancedPreviewSize(), smallest:loadDraftSmallest(), draftTarget:loadDraftTarget(), cachedDetail:loadCachedDetailPreview() });
const navSamples = (samples: WorkSample[]) => samples.filter((s) => s.ok && (s.name === "Photo open" || s.name === "Immich original resolve"));

export function PerformanceTuner({ run, onClose, onRelaunch, onOverlay, photo, raw, previewArea }: {
  photo?:string; raw?:boolean; previewArea?:{w:number;h:number};
  run: () => Promise<TunerRun>; onClose: () => void; onRelaunch: () => Promise<void>; onOverlay: (on: boolean) => void;
}) {
  const pending = useRef(loadPending());
  const [fps, setFps] = useState(pending.current?.fps ?? 30);
  const [latency, setLatency] = useState(pending.current?.latency ?? 80);
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
    const native = trimmedMedian(runResult.samples.filter(s => s.kind === "edit" && !s.estimated).map(s => s.total));
    if (measured.complete) storePreviewTiming(native,latency);
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
        for (const [id,value] of Object.entries({preview:s.preview,balancedSize:s.balancedSize,smallest:s.smallest,draftTarget:s.draftTarget,cachedDetail:s.cachedDetail})) {
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
    const updates = recommended && proposal ? { ...prior,preview:proposal.preview,balancedSize:String(proposal.balancedSize),smallest:String(proposal.smallest),draftTarget:String(proposal.draftTarget),cachedDetail:String(proposal.cachedDetail) } : chosen;
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
  return <div className="modal-backdrop"><div className="modal tuner" role="dialog" aria-modal="true" aria-labelledby="tuner-title">
    <div className="modal-head"><h2 id="tuner-title">Performance tuner</h2></div>
    <div className="modal-body">
      <section className="tuner-section">
        <h3>1. Prepare</h3>
        <p>Load a representative RAW with your usual edits. Use your normal window size and a copy of the photo.</p>
        <div className="tuner-photo">{photo?.split(/[\\/]/).pop() ?? "Open photo"}{previewArea && ` · ${Math.round(previewArea.w)} × ${Math.round(previewArea.h)} px`}</div>
        {raw === false && <p role="alert">Choose a representative RAW for useful recommendations.</p>}
      </section>
      <section className="tuner-section">
        <h3>2. Set targets</h3>
        <div className="tuner-targets">
          <label>Frame rate <select className="field" value={fps} onChange={(e) => {setFps(Number(e.target.value));setVerified(false);setResult(null);setProposal(null);}}>{[15,30,60].map((n) => <option key={n} value={n}>{n} FPS</option>)}</select></label>
          <label>Maximum latency <select className="field" value={latency} onChange={(e) => {setLatency(Number(e.target.value));setVerified(false);setResult(null);setProposal(null);}}>{[50,80,100,200].map((n) => <option key={n} value={n}>{n} ms</option>)}</select></label>
        </div>
        <p>Starts at full quality. Stops at the highest tested quality meeting both targets.</p>
      </section>
      {result && <section className="tuner-section">
        <h3>3. {verified ? "Verification" : "Recommendation"}</h3>
        <p role="status">{passed ? verified ? "Verified: targets reached." : proposal ? "Ready to apply." : "Current settings meet the targets." : "Targets not reached."}</p>
        <div className="tuner-metrics"><div><strong>{result.fps.toFixed(1)} FPS</strong><span>Median frame rate</span></div><div><strong>{Number.isFinite(result.latency) ? `${result.latency.toFixed(0)} ms` : "Unavailable"}</strong><span>Median latency</span></div></div>
        {changes.length>0 && <ul>{changes.map((c) => <li key={c}>{c}</li>)}</ul>}
        {!result.complete && <p>Incomplete measurement. Keep the app visible at the same size and retry.</p>}
        {testedSettings && <p className="tuner-photo">{testedSettings.preview}{testedSettings.preview === "balanced" ? ` ${testedSettings.balancedSize*100}%` : ""} · minimum draft {testedSettings.smallest*100}%</p>}
      </section>}
      {error && <p role="alert">{error}</p>}
      {navigationPending && <p role="status">Navigation verification pending; record the same sequence again below.</p>}
      <details className="tuner-details"><summary>Advanced comparisons</summary>
        <p>Change one option at a time, then apply and verify. AI and thumbnail caches are excluded.</p>
        <button className="btn" onClick={() => void startMeasure()}>Measure current settings</button>
        <table><thead><tr><th>Option</th><th>Candidate</th><th>Test</th></tr></thead><tbody>{options.map((o) => <tr key={o.id}><td>{o.label}{o.restart ? " · relaunch" : ""}</td><td><select aria-label={o.label} className="field" value={chosen[o.id] ?? o.current} onChange={(e) => setChosen((old) => ({...old,[o.id]:e.target.value}))}>{o.values.map((v) => <option key={v.value} value={v.value}>{v.label}{v.value === o.current ? " (current)" : ""}</option>)}</select></td><td>{o.workload}</td></tr>)}</tbody></table>
        {selected.length>0 && <button className="btn" disabled={needsBaseline || !result} onClick={() => void apply(false)}>{restart ? "Apply, relaunch and verify" : "Apply selected and verify"}</button>}
        {selected.length>0 && !result && <p>Measure current settings first.</p>}
        {needsBaseline && <p>Record a navigation baseline first.</p>}
        <h3>Navigation</h3>
        <p>Record the same photo sequence before and after changing read ahead or the originals cache. Include both directions. Smaller cache limits can evict downloaded originals; edited originals are retained.</p>
        <button className="btn" onClick={() => void record()}>Record navigation workload</button>
        {work.length>0 && <table><thead><tr><th>Run</th><th>Operation</th><th>Median</th></tr></thead><tbody>{work.flatMap((r,i) => {
          const samples=navSamples(r.samples), names=[...new Set(samples.map((v) => v.name))];
          return names.map((name) => <tr key={`${i}-${name}`}><td title={r.path}>{i+1}</td><td>{name}</td><td>{trimmedMedian(samples.filter((v) => v.name===name).map((v) => v.ms)).toFixed(1)} ms</td></tr>);
        })}</tbody></table>}
      </details>
      <details className="tuner-details"><summary>Measurements and reports</summary>
        <p>Recommendations use the median after removing the fastest and slowest 10% of drag-frame measurements. FPS comes from intervals between painted photo frames; latency measures input to paint.</p>
        <p>Sliders return to their starting values; benchmark moves add history. Original preferences are restored before Apply. Applying runs verification again.</p>
        {trials.length>0 && <table><thead><tr><th>Preview</th><th>Minimum draft</th><th>Median FPS</th><th>Median latency</th></tr></thead><tbody>{trials.map((t,i) => <tr key={i}><td>{t.settings.preview}{t.settings.preview === "balanced" ? ` ${t.settings.balancedSize*100}%` : ""}</td><td>{t.settings.smallest*100}%</td><td>{t.measurement.fps.toFixed(1)}</td><td>{Number.isFinite(t.measurement.latency) ? `${t.measurement.latency.toFixed(0)} ms` : "unavailable"}</td></tr>)}</tbody></table>}
        {result?.modules.length ? <p>Costliest modules: {result.modules.map(([name,ms]) => `${name}: ${ms.toFixed(1)} ms`).join(", ")}.</p> : null}
        {path && <p className="tuner-report">Report: {path}</p>}
      </details>
    </div>
    <div className="modal-foot">
      <button className="btn" onClick={close}>{verified ? "Done" : "Cancel"}</button>
      <button className={`btn${proposal ? "" : " primary"}`} onClick={() => void search()}>Find best preview</button>
      {proposal && <button className="btn primary" onClick={() => void apply(true)}>Apply and verify</button>}
    </div>
  </div></div>;
}
