// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Find's photo-analysis indicator, at the end of the search row: a spinner with
// the queued count while Smart search analyses photos, a pause glyph while it is
// paused, a check when every photo is analysed. A click pauses or resumes, the
// same pause as Preferences > General > Background work (`search_pause`).
// It reads `search_queue`, which only copies in-memory counts, every 2 s while
// mounted and the page is visible, one read at a time, and never waits on a search.
import { useEffect, useRef, useState } from "react";
import { commands } from "./commands";
import type { Status } from "./bindings";
import { AnalysisCheckIcon, AnalysisPauseIcon, AnalysisSpinnerIcon } from "./icons";
import { formatNumber, t } from "./i18n";

const POLL_MS = 2000;
const BADGE_MAX = 99;

export function AnalysisStatus() {
  const [status, setStatus] = useState<Status | null>(null);
  const alive = useRef(true);
  const polling = useRef(false);
  const poll = async () => {
    if (polling.current) return;
    polling.current = true;
    try { const next = await commands.searchQueue(); if (alive.current) setStatus(next); }
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
  if (!status) return null;

  const { queued, active, paused } = status;
  const working = !paused && queued + active > 0;
  const toggle = async () => {
    const next = !paused;
    // the icon changes before the first await; a failure is put right by the re-read
    setStatus((s) => s && { ...s, paused: next });
    try { await commands.searchPause(next); }
    catch { /* reverted by the poll below */ }
    finally { void poll(); }
  };
  const label = paused
    ? queued > 0 ? t("library.analysis.paused", { n: queued, queued: formatNumber(queued) }) : t("library.analysis.pausedEmpty")
    : working ? t("library.analysis.working", { n: queued, active: formatNumber(active), queued: formatNumber(queued) })
    : t("library.analysis.idle");
  const badge = queued > BADGE_MAX ? `${formatNumber(BADGE_MAX)}+` : formatNumber(queued);
  return (
    <button type="button" className={`analysis-status ${paused ? "paused" : working ? "working" : "idle"}`}
            title={label} aria-label={label} onClick={() => void toggle()}>
      {paused ? <AnalysisPauseIcon /> : working ? <AnalysisSpinnerIcon /> : <AnalysisCheckIcon />}
      {queued > 0 && (paused || working) && <span className="analysis-badge" aria-hidden="true">{badge}</span>}
    </button>
  );
}
