// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import { useEffect, useState } from "react";
import { commands, type SearchStatus } from "./commands";
import { PrefCard, PrefRow } from "./PrefsUI";

export function SearchPrefs() {
  const [status, setStatus] = useState<SearchStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [probe, setProbe] = useState("");
  useEffect(() => {
    let alive = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try { const next = await commands.searchStatus(); if (alive) setStatus(next); }
      catch (e) { if (alive) setError(String(e)); }
      finally { polling = false; }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await action(); setStatus(await commands.searchStatus()); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const model = status?.model;
  const queue = status?.queue;
  const count = status?.counts;
  const downloading = !!model?.downloading;
  const size = model ? `${Math.ceil(model.bytes / 1_000_000)} MB` : "608 MB";
  return <PrefCard title="Local photo cache">
    <PrefRow label="Metadata" summary={count ? `${count.assets.toLocaleString()} photos, ${count.variants.toLocaleString()} versions; ${count.metadata.toLocaleString()} metadata records, ${count.analyses.toLocaleString()} analyses.` : status ? "Unavailable for this session." : "Reading status…"}
      hint="Disposable cached metadata speeds up repeated folder visits. Clear removes cached records. Rebuild also checks your saved folders again; metadata is filled as photos are browsed. Your photos and sidecars stay in place. Offline drives retain their last known identity.">
      <button className="btn small" disabled={busy || !count} onClick={() => void run(() => commands.searchCacheClear(false))}>Clear</button>
      <button className="btn small" disabled={busy || !count} onClick={() => void run(() => commands.searchCacheClear(true))}>Rebuild</button>
    </PrefRow>
    <PrefRow label="Background work" summary={queue ? `${queue.paused ? "Paused" : "Running"}; ${queue.active} active, ${queue.queued} queued.` : "Reading status…"}
      hint="Pause stops new background file checks and analysis from starting. Active work finishes. Folder browsing stays available. The pause setting is remembered; model downloads have their own Cancel button.">
      <button className="btn small" disabled={busy || !queue} onClick={() => void run(() => commands.searchPause(!queue!.paused))}>{queue?.paused ? "Resume" : "Pause"}</button>
    </PrefRow>
    {status?.roots.map(root => <PrefRow key={root.path} label={root.path} summary={`Last check: ${root.state}${root.error ? ` — ${root.error}` : ""}`} children={null} />)}
    <PrefRow label="CLIP model (optional)" summary={downloading ? "Downloading and checking model files…" : model?.verified ? "Model files verified. CPU analysis stays on this computer." : "No model files verified in this session."}
      hint={`Download ${size} of matched CLIP ViT-B/32 models and tokenizer files from Hugging Face. This is optional and starts only when you press Download or repair. Existing valid files are reused. Model files are kept when the metadata cache is cleared.`}>
      <button className="btn small" disabled={busy || downloading || !model} onClick={() => void run(() => commands.searchModelDownload(true))}>Download or repair ({size})</button>
      {downloading && <button className="btn small" onClick={() => void commands.searchModelCancel().catch(e => setError(String(e)))}>Cancel</button>}
    </PrefRow>
    <PrefRow label="Model check" summary={probe || "Checks both CPU inference towers using a test prompt and a synthetic image."}>
      <button className="btn small" disabled={busy || downloading || !model?.verified || !!queue?.paused} onClick={() => void run(async () => {
        setProbe(""); const result = await commands.searchModelProbe();
        setProbe(`Text: ${result.dimensions} values; image: ${result.image_dimensions} values. ${result.elapsed_ms === null ? "Timing unavailable." : `${Math.round(result.elapsed_ms)} ms including model loading.`}`);
      })}>Check</button>
    </PrefRow>
    {(error || model?.error) && <p role="alert" className="prefs-error">{error || model?.error}</p>}
  </PrefCard>;
}
