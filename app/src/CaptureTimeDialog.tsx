// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { useEffect, useRef, useState } from "react";
import type { ImageEntry } from "./library";
import { captureMillis, captureShift, captureStamp, type CaptureTimeEntry } from "./captureTime";

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
    if (!Number.isFinite(delta)) validation = "Enter a valid date and time, including seconds.";
    else if (!delta) validation = "Enter the correct time to calculate an adjustment.";
    else {
      try { entries = eligible.map((i) => ({ imgid: i.imgid, before: i.exif.datetime, after: captureStamp(captureMillis(i.exif.datetime) + delta) })); }
      catch (e) { validation = String(e); }
    }
  }
  const count = undo?.length ?? eligible.length;
  const photos = `${count} photo${count === 1 ? "" : "s"}`;
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
      <div className="modal-head"><h2 id="capture-time-title">{undo ? "Undo Capture Time Adjustment" : "Adjust Capture Time"}</h2></div>
      <div className="modal-body">
        {!undo && <>
          <p>Adjust capture time for <strong>{photos}</strong>.</p>
          <p>Reference photo: <strong>{reference.filename}</strong></p>
          <p>Recorded time: {original.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3")}</p>
          <label className="row">Correct time <input className="field" type="datetime-local" step="0.001"
            min="0001-01-01T00:00:00" max="9999-12-31T23:59:59.999" value={corrected} disabled={busy || !!result}
            onChange={(e) => { setCorrected(e.target.value.length === 16 ? `${e.target.value}:00` : e.target.value); setError(""); }} /></label>
          {targets.length > eligible.length && <p>{targets.length - eligible.length} photo{targets.length - eligible.length === 1 ? "" : "s"} without a valid recorded capture time will be skipped.</p>}
        </>}
        {validation ? <p className="note-plain">{validation}</p> : <p>
          {undo ? `Restore the previous capture times for ${photos}?` : `Move capture times ${captureShift(delta)} for ${photos}?`}
          {!undo && " All photos keep their relative timing."}
        </p>}
        <p className="note-plain">Changes are saved to XMP sidecars. Original image files are unchanged.</p>
        {error && <p role="alert">{error}</p>}
        {result && <p role="status">{result}</p>}
      </div>
      <div className="modal-foot">
        <button className="btn" disabled={busy} onClick={close}>{result ? "Done" : "Cancel"}</button>
        {!result && <button className="btn primary" disabled={busy || !!validation || !count} onClick={() => void apply()}>
          {busy ? "Saving…" : `${undo ? "Restore" : "Adjust"} ${photos}`}
        </button>}
      </div>
    </div>
  </div>;
}
