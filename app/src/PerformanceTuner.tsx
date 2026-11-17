// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import { useEffect, useRef, useState } from "react";
import { t } from "./i18n";
import { commands } from "./commands";
import { perf, observeWebview, writeReport } from "./perf";
import { loadPreview, loadBalancedPreviewSize, loadDraftSmallest, loadDraftTarget } from "./Preferences";
import { measureTuner, searchTuner, trimmedMedian, tunerChanges, type TunerSettings, type TunerRun, type TunerMeasurement, type TunerContext, type TunerTrial } from "./previewTuning";
import { tunerOptions, type TunerOption } from "./tunerOptions";
import { startTunerWork, stopTunerWork, type WorkSample } from "./tunerWorkload";
import { settings as store } from "./settings";


const PENDING = "immage.performanceTuner.pending";
type WorkResult = { settings: Record<string,string>; samples: WorkSample[]; path: string };
type Pending = { fps: number; latency: number; work: WorkResult[]; navigationPending: boolean; context?:TunerContext };
function loadPending(): Pending | null {
  try {
    const v = JSON.parse(store.get(PENDING) ?? "null");
    return v && [15,30,60].includes(v.fps) && [50,80,100,200].includes(v.latency) && Array.isArray(v.work) ? v : null;
  } catch { return null; }
}
export const hasPendingTuner = () => !!loadPending();
const settings = (): TunerSettings => ({ preview:loadPreview(), balancedSize:loadBalancedPreviewSize(), smallest:loadDraftSmallest(), draftTarget:loadDraftTarget() });
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
      throw new Error(t("dialogs.tuner.errors.relaunchContext"));
    }
    setContext(runResult.context);
    const measured = measureTuner(runResult);
    setResult(measured); setPath(runResult.path);
    setTestedSettings(settings()); setProposal(null); setChanges([]);
  };
  const startMeasure = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try { await measure(); setVerified(!!pending.current); pending.current = null; store.remove(PENDING); }
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
        for (const [id,value] of Object.entries({preview:s.preview,balancedSize:s.balancedSize,smallest:s.smallest,draftTarget:s.draftTarget})) {
          const option = all.find((o) => o.id === id);
          if (!option) throw new Error(`Missing tuner option: ${id}`);
          await option.set(String(value));
        }
      };
      const best = await searchTuner(original,{fps,latency},applySettings,run,(s,i,total) => setProgress(`Testing ${i}/${total}: ${s.preview} ${s.balancedSize*100}%, smallest draft ${s.smallest*100}%`));
      setTrials(best.trials); setResult(best.trial.measurement); setPath(best.trial.path); setTestedSettings(best.trial.settings); setVerified(false);
      const adjustments = tunerChanges(original,best.trial.settings);
      setProposal(adjustments.length ? best.trial.settings : null); setChanges(adjustments);
      if (!best.met) setError(t("dialogs.tuner.errors.targetsNotMet"));
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
        void commands.perfResourcesStop().catch(() => {});
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
    const updates = recommended && proposal ? { ...prior,preview:proposal.preview,balancedSize:String(proposal.balancedSize),smallest:String(proposal.smallest),draftTarget:String(proposal.draftTarget) } : chosen;
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
        store.set(PENDING,JSON.stringify({fps,latency,work,navigationPending:navPending,context} satisfies Pending));
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
      store.remove(PENDING); setResult(null); setVerified(false);
      setError(t("dialogs.tuner.errors.applyFailed", { error: String(e), recovery: failures.length ? t("dialogs.tuner.errors.couldNotRestore", { failures: failures.join(", ") }) : t("dialogs.tuner.errors.previousRestored") }));
      await reload();
    } finally { lock.current = false; setBusy(false); }
  };
  const record = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    let started = false;
    try {
      const all = await reload(false);
      await commands.perfResourcesStart(); started = true;
      const stopMeasurement = await perf.startMeasurement();
      perf.recording = []; startTunerWork();
      capture.current = {start:performance.now(),settings:Object.fromEntries(all.map((o) => [o.id,o.current])),stopMeasurement,stop:observeWebview(null)};
      setRecording(true);
    } catch (e) {
      if (started) await commands.perfResourcesStop().catch(() => {});
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
      const resources = await commands.perfResourcesStop();
      const currentOptions = await tunerOptions(onOverlay);
      if (currentOptions.some((o) => c.settings[o.id] !== o.current)) throw new Error(t("dialogs.tuner.errors.settingsChanged"));
      const cacheUsage = await commands.cacheUsage().catch(() => null);
      const at = new Date();
      const reportPath = await writeReport(`tuner-${at.toISOString().replace(/[:.]/g,"-")}`,{immage:"performance-tuner-workload",version:1,at:at.toISOString(),workload:"navigation",settings:c.settings,seconds:(performance.now()-c.start)/1000,samples,frames,webviewTiming,resources,cacheUsage});
      setWork((old) => [...old,{settings:c.settings,samples,path:reportPath}]);
      if (navSamples(samples).length) setNavigationPending(false);
      else setError(t("dialogs.tuner.errors.noPhotoOpens"));
    } catch (e) { setError(String(e)); }
    finally { lock.current = false; setBusy(false); }
  };
  const close = () => { store.remove(PENDING); onClose(); };
  if (recording) return <div role="status" style={{position:"fixed",bottom:24,left:24,zIndex:1000,background:"var(--panel)",padding:16,maxWidth:440,border:"1px solid currentColor"}}>
    <p>{t("dialogs.tuner.recordingHint")}</p>
    <button className="btn" onClick={() => void finish()}>{t("dialogs.tuner.stopCompare")}</button>
  </div>;
  if (busy) return <div className="modal-backdrop" style={{background:"transparent"}}><div role="status" style={{alignSelf:"flex-end",background:"var(--panel)",padding:16}}>{progress || t("dialogs.tuner.busy")} {t("dialogs.tuner.wait")}</div></div>;
  return <div className="modal-backdrop"><div className="modal tuner" role="dialog" aria-modal="true" aria-labelledby="tuner-title">
    <div className="modal-head"><h2 id="tuner-title">{t("dialogs.tuner.title")}</h2></div>
    <div className="modal-body">
      <section className="tuner-section">
        <h3>{t("dialogs.tuner.prepare")}</h3>
        <p>{t("dialogs.tuner.prepareHint")}</p>
        <div className="tuner-photo">{photo?.split(/[\\/]/).pop() ?? t("dialogs.tuner.openPhoto")}{previewArea && ` · ${Math.round(previewArea.w)} × ${Math.round(previewArea.h)} px`}</div>
        {raw === false && <p role="alert">{t("dialogs.tuner.chooseRaw")}</p>}
      </section>
      <section className="tuner-section">
        <h3>{t("dialogs.tuner.targets")}</h3>
        <div className="tuner-targets">
          <label>{t("dialogs.tuner.frameRate")} <select className="field" value={fps} onChange={(e) => {setFps(Number(e.target.value));setVerified(false);setResult(null);setProposal(null);}}>{[15,30,60].map((n) => <option key={n} value={n}>{n} FPS</option>)}</select></label>
          <label>{t("dialogs.tuner.maxLatency")} <select className="field" value={latency} onChange={(e) => {setLatency(Number(e.target.value));setVerified(false);setResult(null);setProposal(null);}}>{[50,80,100,200].map((n) => <option key={n} value={n}>{n} ms</option>)}</select></label>
        </div>
        <p>{t("dialogs.tuner.targetsHint")}</p>
      </section>
      {result && <section className="tuner-section">
        <h3>3. {verified ? t("dialogs.tuner.verification") : t("dialogs.tuner.recommendation")}</h3>
        <p role="status">{passed ? verified ? t("dialogs.tuner.verified") : proposal ? t("dialogs.tuner.readyToApply") : t("dialogs.tuner.currentMeetsTargets") : t("dialogs.tuner.targetsNotReached")}</p>
        <div className="tuner-metrics"><div><strong>{result.fps.toFixed(1)} FPS</strong><span>{t("dialogs.tuner.medianFps")}</span></div><div><strong>{Number.isFinite(result.latency) ? `${result.latency.toFixed(0)} ms` : t("dialogs.tuner.unavailable")}</strong><span>{t("dialogs.tuner.medianLatency")}</span></div></div>
        {changes.length>0 && <ul>{changes.map((c) => <li key={c}>{c}</li>)}</ul>}
        {!result.complete && <p>{t("dialogs.tuner.incomplete")}</p>}
        {testedSettings && <p className="tuner-photo">{t(`dialogs.tuner.profile.${testedSettings.preview}`)}{testedSettings.preview === "balanced" ? ` ${testedSettings.balancedSize*100}%` : ""} · {t("dialogs.tuner.minimumDraft", { size: testedSettings.smallest*100 })}</p>}
      </section>}
      {error && <p role="alert">{error}</p>}
      {navigationPending && <p role="status">{t("dialogs.tuner.navPending")}</p>}
      <details className="tuner-details"><summary>{t("dialogs.tuner.advanced")}</summary>
        <p>{t("dialogs.tuner.advancedHint")}</p>
        <button className="btn" onClick={() => void startMeasure()}>{t("dialogs.tuner.measure")}</button>
        <table><thead><tr><th>{t("dialogs.tuner.option")}</th><th>{t("dialogs.tuner.candidate")}</th><th>{t("dialogs.tuner.test")}</th></tr></thead><tbody>{options.map((o) => <tr key={o.id}><td>{o.label}{o.restart ? ` · ${t("dialogs.tuner.relaunch")}` : ""}</td><td><select aria-label={o.label} className="field" value={chosen[o.id] ?? o.current} onChange={(e) => setChosen((old) => ({...old,[o.id]:e.target.value}))}>{o.values.map((v) => <option key={v.value} value={v.value}>{v.label}{v.value === o.current ? ` (${t("dialogs.tuner.current")})` : ""}</option>)}</select></td><td>{t(`dialogs.tuner.workload.${o.workload}`)}</td></tr>)}</tbody></table>
        {selected.length>0 && <button className="btn" disabled={needsBaseline || !result} onClick={() => void apply(false)}>{restart ? t("dialogs.tuner.applyRelaunch") : t("dialogs.tuner.applySelected")}</button>}
        {selected.length>0 && !result && <p>{t("dialogs.tuner.measureFirst")}</p>}
        {needsBaseline && <p>{t("dialogs.tuner.baselineFirst")}</p>}
        <h3>{t("dialogs.tuner.navigation")}</h3>
        <p>{t("dialogs.tuner.navigationHint")}</p>
        <button className="btn" onClick={() => void record()}>{t("dialogs.tuner.recordNavigation")}</button>
        {work.length>0 && <table><thead><tr><th>{t("dialogs.tuner.run")}</th><th>{t("dialogs.tuner.operation")}</th><th>{t("dialogs.tuner.median")}</th></tr></thead><tbody>{work.flatMap((r,i) => {
          const samples=navSamples(r.samples), names=[...new Set(samples.map((v) => v.name))];
          return names.map((name) => <tr key={`${i}-${name}`}><td title={r.path}>{i+1}</td><td>{name}</td><td>{trimmedMedian(samples.filter((v) => v.name===name).map((v) => v.ms)).toFixed(1)} ms</td></tr>);
        })}</tbody></table>}
      </details>
      <details className="tuner-details"><summary>{t("dialogs.tuner.reports")}</summary>
        <p>{t("dialogs.tuner.measurementsHint")}</p>
        <p>{t("dialogs.tuner.preferencesHint")}</p>
        {trials.length>0 && <table><thead><tr><th>{t("dialogs.tuner.preview")}</th><th>{t("dialogs.tuner.minDraft")}</th><th>{t("dialogs.tuner.medianFps")}</th><th>{t("dialogs.tuner.medianLatency")}</th></tr></thead><tbody>{trials.map((trial,i) => <tr key={i}><td>{t(`dialogs.tuner.profile.${trial.settings.preview}`)}{trial.settings.preview === "balanced" ? ` ${trial.settings.balancedSize*100}%` : ""}</td><td>{trial.settings.smallest*100}%</td><td>{trial.measurement.fps.toFixed(1)}</td><td>{Number.isFinite(trial.measurement.latency) ? `${trial.measurement.latency.toFixed(0)} ms` : t("dialogs.tuner.unavailableLower")}</td></tr>)}</tbody></table>}
        {result?.modules.length ? <p>{t("dialogs.tuner.costliest", { modules: result.modules.map(([name,ms]) => `${name}: ${ms.toFixed(1)} ms`).join(", ") })}</p> : null}
        {path && <p className="tuner-report">{t("dialogs.tuner.report", { path })}</p>}
      </details>
    </div>
    <div className="modal-foot">
      <button className="btn" onClick={close}>{verified ? t("dialogs.tuner.done") : t("dialogs.tuner.cancel")}</button>
      <button className={`btn${proposal ? "" : " primary"}`} onClick={() => void search()}>{t("dialogs.tuner.findBest")}</button>
      {proposal && <button className="btn primary" onClick={() => void apply(true)}>{t("dialogs.tuner.applyVerify")}</button>}
    </div>
  </div></div>;
}
