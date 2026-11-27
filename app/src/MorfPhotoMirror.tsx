// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { useEffect, useState } from "react";
import { commands, type MirrorStatus } from "./commands";
import { formatDate, formatNumber, t } from "./i18n";
import { PrefCard, PrefRow } from "./PrefsUI";
import "./morfPhotoMirror.css";

const POLL_MS = 5_000;

// Preferences > Immage Accelerator: the local copy of the server's catalog.
// The status is the sync thread's in-memory report, so polling it is cheap;
// it stops while the window is hidden.
export function MorfPhotoMirror() {
  const [status, setStatus] = useState<MirrorStatus | null>(null);
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      clearTimeout(timer);
      if (document.visibilityState === "hidden") return;
      try {
        const next = await commands.morfMirrorStatus();
        if (!disposed) setStatus(next);
      } catch {
        // keep the last report
      }
      if (!disposed) timer = setTimeout(refresh, POLL_MS);
    };
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const resync = async () => {
    setAsked(true);
    setStatus(current => current && { ...current, phase: "syncing", done: 0, total: 0, error: null, diskFull: false });
    try {
      await commands.morfMirrorResync();
      setStatus(await commands.morfMirrorStatus());
    } catch {
      // the next poll reports the outcome
    }
  };

  if (!status || status.phase === "off") return null;
  const syncing = status.phase === "syncing";
  const unavailable = status.phase === "unavailable";
  const progress = syncing
    ? status.total > 0
      ? t("morfphoto.mirror.progress", { done: formatNumber(Math.min(status.done, status.total)), total: formatNumber(status.total) })
      : t("morfphoto.mirror.progressUnknown", { n: status.done, count: formatNumber(status.done) })
    : null;
  const lastSynced = status.syncedAt != null
    ? formatDate(status.syncedAt * 1000, { dateStyle: "medium", timeStyle: "short" })
    : t("morfphoto.mirror.never");
  return <PrefCard title={t("morfphoto.mirror.title")}>
    <p className="pref-hint">{t("morfphoto.mirror.hint")}</p>
    {unavailable
      ? <PrefRow label={t("morfphoto.mirror.unavailable")} children={null} />
      : <>
        <PrefRow label={t("morfphoto.mirror.lastSynced")}><span className="mirror-value">{lastSynced}</span></PrefRow>
        <PrefRow label={t("morfphoto.mirror.photos")}>
          <span className="mirror-value">{formatNumber(status.photos)}</span>
        </PrefRow>
        {progress && <PrefRow label={t("morfphoto.mirror.syncing")}><span className="mirror-value" role="status">{progress}</span></PrefRow>}
        {status.phase === "error" && <PrefRow label={t("morfphoto.mirror.error")}>
          <span className="mirror-error warn" role="status">
            {status.diskFull ? t("morfphoto.mirror.diskFull") : status.error ?? t("morfphoto.mirror.errorUnknown")}
          </span>
        </PrefRow>}
        <PrefRow label={t("morfphoto.mirror.resync")} hint={t("morfphoto.mirror.resyncHint")}>
          <button className="btn" disabled={syncing && asked} onClick={() => void resync()}>
            {t("morfphoto.mirror.resyncButton")}
          </button>
        </PrefRow>
      </>}
  </PrefCard>;
}
