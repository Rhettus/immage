// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Find's photo-analysis indicator, at the end of the search row: the number of
// photos still waiting for Smart search analysis beside a spinner (animated
// while photos are being analysed, still while they wait, for a network drive
// to answer or the next batch), a pause glyph while paused, a check when every
// photo is analysed. A click pauses or resumes, the same pause as Preferences >
// General > Background work (`search_pause`). Without the CLIP model it stays,
// dimmed. It reads `search_analysis_status`, which only copies in-memory
// state (the service counts the backlog on its own thread), every 2 s while
// mounted and the page is visible, one read at a time, and never waits on a search.
import { useEffect, useRef, useState } from "react";
import { commands } from "./commands";
import type { AnalysisProgress } from "./bindings";
import { AnalysisCheckIcon, AnalysisPauseIcon, AnalysisSpinnerIcon } from "./icons";
import { formatNumber, t } from "./i18n";

const POLL_MS = 2000;
const COMPACT_FROM = 10000;

export function AnalysisStatus() {
  const [status, setStatus] = useState<AnalysisProgress | null>(null);
  const alive = useRef(true);
  const polling = useRef(false);
  const poll = async () => {
    if (polling.current) return;
    polling.current = true;
    try { const next = await commands.searchAnalysisStatus(); if (alive.current) setStatus(next); }
    catch { /* keep the last reading; the next poll tries again */ }
    finally { polling.current = false; }
  };
  useEffect(() => {
    alive.current = true;
    void poll();
    const tick = () => { if (document.visibilityState === "visible") void poll(); };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => { alive.current = false; clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, []);

  const installed = status?.installed ?? false;
  const paused = status?.paused ?? false;
  const pending = status?.pending ?? null;
  const running = status?.running ?? 0;
  const working = !paused && (running > 0 || (pending !== null && pending > 0 && !!status?.active));
  const waiting = !paused && !working && pending !== null && pending > 0;
  const checking = installed && !paused && pending === null && running === 0;
  const toggle = async () => {
    if (!installed) return;
    const next = !paused;
    // the icon changes before the first await; a failure is put right by the re-read
    setStatus((s) => s && { ...s, paused: next });
    try { await commands.searchPause(next); }
    catch { /* reverted by the poll below */ }
    finally { void poll(); }
  };

  const exact = pending === null ? "" : formatNumber(pending);
  const shown = pending === null || pending === 0 ? ""
    : pending < COMPACT_FROM ? exact : formatNumber(pending, { notation: "compact", maximumFractionDigits: 1 });
  let label: string;
  let kind: string;
  if (!installed) { label = t("library.analysis.notInstalled"); kind = "off"; }
  else if (paused) {
    label = pending ? t("library.analysis.paused", { n: pending, count: exact }) : t("library.analysis.pausedEmpty");
    kind = "paused";
  }
  else if (working) {
    label = pending ? t("library.analysis.working", { n: pending, count: exact }) : t("library.analysis.workingUnknown");
    kind = "working";
  }
  else if (waiting) { label = t("library.analysis.waiting", { n: pending ?? 0, count: exact }); kind = "waiting"; }
  else if (checking) { label = t("library.analysis.checking"); kind = "checking"; }
  else { label = t("library.analysis.idle"); kind = "idle"; }
  return (
    <button type="button" className="analysis-status" data-state={kind} title={label} aria-label={label}
            aria-disabled={!installed || undefined} onClick={() => void toggle()}>
      {!installed ? <AnalysisSpinnerIcon still /> : paused ? <AnalysisPauseIcon />
        : working ? <AnalysisSpinnerIcon /> : waiting || checking ? <AnalysisSpinnerIcon still /> : <AnalysisCheckIcon />}
      {installed && shown && <span className="analysis-count" aria-hidden="true">{shown}</span>}
    </button>
  );
}
