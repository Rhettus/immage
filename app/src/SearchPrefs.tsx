// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import { useEffect, useState } from "react";
import { commands, type SearchStatus } from "./commands";
import { PrefCard, PrefRow } from "./PrefsUI";
import { t } from "./i18n";

function useSearchStatus() {
  const [status, setStatus] = useState<SearchStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
  return { status, busy, error, setError, run };
}

export function SearchPrefs() {
  const { status, busy, error, run } = useSearchStatus();
  const queue = status?.queue;
  const count = status?.counts;
  const providerByPath = new Map((status?.clip_providers ?? []).map(p => [p.path, p.provider]));
  const rootByPath = new Map((status?.roots ?? []).map(r => [r.path, r]));
  const dirPaths = [...new Set([...rootByPath.keys(), ...providerByPath.keys()])].sort();
  return <PrefCard title={t("library.cache.title")}>
    <PrefRow label={t("library.cache.metadata")} summary={count ? t("library.cache.count", { photos: count.assets.toLocaleString(), versions: count.variants.toLocaleString(), records: count.metadata.toLocaleString(), analyses: count.analyses.toLocaleString() }) : status ? t("library.cache.unavailable") : t("library.cache.reading")}
      hint={t("library.cache.hint")}>
      <button className="btn small" disabled={busy || !count} onClick={() => void run(() => commands.searchCacheClear(false))}>{t("library.cache.clear")}</button>
      <button className="btn small" disabled={busy || !count} onClick={() => void run(() => commands.searchCacheClear(true))}>{t("library.cache.rebuild")}</button>
    </PrefRow>
    <PrefRow label={t("library.cache.background")} summary={queue ? t(queue.paused ? "library.cache.queuePaused" : "library.cache.queueRunning", { active: queue.active, queued: queue.queued }) : t("library.cache.reading")}
      hint={t("library.cache.backgroundHint")}>
      <button className="btn small" disabled={busy || !queue} onClick={() => void run(() => commands.searchPause(!queue!.paused))}>{queue?.paused ? t("library.cache.resume") : t("library.cache.pause")}</button>
    </PrefRow>
    <PrefRow label={t("library.cache.analysis")} summary={count ? t("library.cache.analysedPhotos", { photos: count.analysed_photos.toLocaleString(), analyses: count.analyses.toLocaleString() }) : status ? t("library.cache.unavailable") : t("library.cache.reading")} children={null} />
    {!!dirPaths.length && <div className="cache-directories" role="region" aria-label={t("library.cache.directories")} tabIndex={0}>
      {dirPaths.map(path => {
        const root = rootByPath.get(path);
        const provider = providerByPath.get(path);
        const providerLabel = provider ? t(`library.cache.provider.${provider}`) : null;
        const connected = !root || root.state === "online";
        const label = !root ? t("library.folders.connected")
          : root.state === "online" || root.state === "offline"
          ? t(connected ? "library.folders.connected" : "library.folders.offline")
          : t("library.cache.lastCheck", { state: root.state, error: "" });
        return <div className="cache-directory" key={path}>
          <span className="cache-directory-path" title={path}>{path}</span>
          {providerLabel && <span className={`cache-directory-provider${provider !== "local" ? " remote" : ""}`}
            title={t("library.cache.providerTitle", { provider: providerLabel })}>{providerLabel}</span>}
          <span className="cache-directory-status" role="img" aria-label={label}
            title={`${label}${root?.error ? ` — ${root.error}` : ""}`}>
            <span className={`drive-dot${connected ? "" : " off"}`} />
          </span>
        </div>;
      })}
    </div>}
    {error && <p role="alert" className="prefs-error">{error}</p>}
  </PrefCard>;
}

export function ClipPrefs() {
  const { status, busy, error, setError, run } = useSearchStatus();
  const [probe, setProbe] = useState("");
  const model = status?.model;
  const queue = status?.queue;
  const downloading = !!model?.downloading;
  const size = model ? `${Math.ceil(model.bytes / 1_000_000)} MB` : "608 MB";
  return <PrefCard title={t("library.clip.title")} card="local-search">
    <PrefRow label={t("library.cache.model")} summary={downloading ? t("library.cache.downloading") : model?.verified ? t("library.cache.verified") : t("library.cache.notVerified")}
      hint={t("library.cache.modelHint", { size })}>
      <button className="btn small" disabled={busy || downloading || !model} onClick={() => void run(() => commands.searchModelDownload(true))}>{t("library.cache.download", { size })}</button>
      {downloading && <button className="btn small" onClick={() => void commands.searchModelCancel().catch(e => setError(String(e)))}>{t("library.cache.cancel")}</button>}
    </PrefRow>
    <PrefRow label={t("library.cache.modelCheck")} summary={probe || t("library.cache.modelCheckHint")}>
      <button className="btn small" disabled={busy || downloading || !model?.verified || !!queue?.paused} onClick={() => void run(async () => {
        setProbe(""); const result = await commands.searchModelProbe();
        setProbe(t("library.cache.probe", { text: result.dimensions, image: result.image_dimensions, timing: result.elapsed_ms === null ? t("library.cache.timingUnavailable") : t("library.cache.elapsed", { ms: Math.round(result.elapsed_ms) }) }));
      })}>{t("library.cache.check")}</button>
    </PrefRow>
    <p className="pref-hint">{t("library.clip.precedence")}</p>
    <p className="prefs-status warn">{t("library.clip.warning")}</p>
    {(error || model?.error) && <p role="alert" className="prefs-error">{error || model?.error}</p>}
  </PrefCard>;
}
