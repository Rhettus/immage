// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { useEffect, useRef, useState } from "react";
import type { ImageEntry } from "./library";
import { captureMillis, captureShift, captureStamp, type CaptureTimeEntry } from "./captureTime";
import { t, formatNumber } from "./i18n";

export function CaptureTimeDialog({ targets, reference, undo, onApply, onClose }: {
  targets: ImageEntry[];
  reference: ImageEntry;
  undo?: CaptureTimeEntry[];
  onApply: (entries: CaptureTimeEntry[]) => Promise<string>;
  onClose: () => void;
}) {
  const eligible = targets.filter((i) => Number.isFinite(captureMillis(i.exif.datetime)));
  const original = reference.exif.datetime;
  const [corrected, setCorrected] = useState(original.replace(/^(\d{4}):(\d{2}):(\d{2}) /, "$1-$2-$3T"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>("input, button")?.focus();
    return () => previous?.focus();
  }, []);
  const delta = captureMillis(corrected) - captureMillis(original);
  let entries: CaptureTimeEntry[] = undo ?? [];
  let validation = "";
  if (!undo) {
    if (!Number.isFinite(delta)) validation = t("dialogs.captureTime.invalidDate");
    else if (!delta) validation = t("dialogs.captureTime.enterCorrectTime");
    else {
      try { entries = eligible.map((i) => ({ imgid: i.imgid, before: i.exif.datetime, after: captureStamp(captureMillis(i.exif.datetime) + delta) })); }
      catch (e) { validation = String(e); }
    }
  }
  const count = undo?.length ?? eligible.length;
  const photos = t("dialogs.captureTime.photos", { count: formatNumber(count) });
  const close = () => { if (!busy) onClose(); };
  const apply = async () => {
    if (busy || validation || !count || result) return;
    setBusy(true); setError("");
    try { setResult(await onApply(entries)); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}
    onKeyDown={(e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); close(); }
      if (e.key === "Tab") {
        const focusable = Array.from(box.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)") ?? []);
        const first = focusable[0], last = focusable.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }}>
    <div ref={box} className="modal capture-time" role="dialog" aria-modal="true" aria-labelledby="capture-time-title">
      <div className="modal-head"><h2 id="capture-time-title">{undo ? t("dialogs.captureTime.undoTitle") : t("dialogs.captureTime.title")}</h2></div>
      <div className="modal-body">
        {!undo && <>
          <p>{t("dialogs.captureTime.adjustFor", { photos })}</p>
          <p>{t("dialogs.captureTime.reference", { filename: reference.filename })}</p>
          <p>{t("dialogs.captureTime.recorded", { time: original.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3") })}</p>
          <label className="row">{t("dialogs.captureTime.correctTime")} <input className="field" type="datetime-local" step="0.001"
            min="0001-01-01T00:00:00" max="9999-12-31T23:59:59.999" value={corrected} disabled={busy || !!result}
            onChange={(e) => { setCorrected(e.target.value.length === 16 ? `${e.target.value}:00` : e.target.value); setError(""); }} /></label>
          {targets.length > eligible.length && <p>{t("dialogs.captureTime.invalidSkipped", { count: formatNumber(targets.length - eligible.length) })}</p>}
        </>}
        {validation ? <p className="note-plain">{validation}</p> : <p>
          {undo ? t("dialogs.captureTime.restoreConfirm", { photos }) : t("dialogs.captureTime.adjustConfirm", { shift: captureShift(delta), photos })}
          {!undo && ` ${t("dialogs.captureTime.keepRelativeTiming")}`}
        </p>}
        <p className="note-plain">{t("dialogs.captureTime.savedSidecars")}</p>
        {error && <p role="alert">{error}</p>}
        {result && <p role="status">{result}</p>}
      </div>
      <div className="modal-foot">
        <button className="btn" disabled={busy} onClick={close}>{result ? t("dialogs.common.done") : t("dialogs.common.cancel")}</button>
        {!result && <button className="btn primary" disabled={busy || !!validation || !count} onClick={() => void apply()}>
          {busy ? t("dialogs.common.saving") : t(undo ? "dialogs.captureTime.restore" : "dialogs.captureTime.adjust", { photos })}
        </button>}
      </div>
    </div>
  </div>;
}
