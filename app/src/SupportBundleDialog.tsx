// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { immichUrl } from "./immich";
import { settings } from "./settings";

// what only the page knows and the scrubber must find in the text: folders,
// photo names, the Immich server, and the preferences the user has set
export type SupportValues = { folders: string[]; photos: string[]; extra: string[]; prefs: Record<string, unknown> };

// storage keys that could hold a credential are never read
const SECRET = /token|password|passwd|secret|api[-_.]?key|credential|auth/i;

export async function supportValues(known: { folders: (string | null | undefined)[]; photos: string[] }): Promise<SupportValues> {
  const prefs: Record<string, unknown> = {};
  try {
    for (const k of settings.keys()) {
      if (!k.startsWith("immage.") || SECRET.test(k)) continue;
      const v = settings.get(k);
      if (v === null) continue;
      let parsed: unknown = v;
      try { parsed = JSON.parse(v); } catch { /* a plain string */ }
      prefs[k.slice("immage.".length)] = parsed;
    }
  } catch { /* storage unavailable */ }
  const extra: string[] = [];
  const url = await immichUrl();
  if (url) {
    try { extra.push(new URL(url).host, url); } catch { extra.push(url); }
  }
  const folders = new Set<string>(known.folders.filter((f): f is string => !!f));
  const lib = prefs["library"] as { folders?: string[]; recent?: string[]; current?: string | null; image?: string | null } | undefined;
  for (const f of [...(lib?.folders ?? []), ...(lib?.recent ?? []), lib?.current, lib?.image]) if (f) folders.add(f);
  return { folders: [...folders], photos: known.photos.slice(0, 5000), extra, prefs };
}

type BundleFile = { name: string; lines: string[] };
type Bundle = { files: BundleFile[]; counts: Record<string, number> };

const KINDS: Record<string, string> = {
  home: "home folder", user: "user name", host: "computer name", folder: "folder", photo: "photo name", extra: "server",
  email: "email address", url: "web address", path: "path", serial: "serial number",
};
const ROW = 18;
const VIEW = 300;

export function SupportBundleDialog({ values, onClose }: { values: SupportValues; onClose: () => void }) {
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [tab, setTab] = useState(0);
  const [removed, setRemoved] = useState<Record<string, Set<number>>>({});
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [top, setTop] = useState(0);
  const last = useRef<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    invoke<Bundle>("support_bundle_preview", { page: values })
      .then((b) => { if (live) setBundle(b); })
      .catch((e) => { if (live) setError(String(e)); })
      .finally(() => { if (live) setBusy(false); });
    const previous = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>("button")?.focus();
    return () => { live = false; previous?.focus(); };
  }, [values]);

  const close = () => {
    if (busy) return;
    if (!saved) void invoke("support_bundle_discard").catch(() => {});
    onClose();
  };
  // on the window, not the backdrop: opened from the menu, focus is not in
  // the dialog yet, and Escape should not also reach the editor's shortcuts
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); e.stopPropagation();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const file = bundle?.files[tab];
  const gone = (file && removed[file.name]) || new Set<number>();
  const select = (i: number, shift: boolean) => {
    if (!file || saved) return;
    setRemoved((r) => {
      const next = new Set(r[file.name] ?? []);
      const from = shift && last.current !== null ? Math.min(last.current, i) : i;
      const to = shift && last.current !== null ? Math.max(last.current, i) : i;
      const on = !next.has(i);
      for (let n = from; n <= to; n++) { if (on) next.add(n); else next.delete(n); }
      return { ...r, [file.name]: next };
    });
    last.current = i;
  };
  const switchTab = (n: number) => {
    setTab(n); setTop(0); last.current = null;
    if (scroller.current) scroller.current.scrollTop = 0;
  };
  const addBenchmark = async () => {
    setBusy(true); setError("");
    try {
      const b = await invoke<Bundle | null>("support_bundle_add_benchmark");
      if (b) { setBundle(b); switchTab(b.files.findIndex((f) => f.name === "benchmark.json")); }
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setError("");
    try {
      const out: Record<string, number[]> = {};
      for (const [name, set] of Object.entries(removed)) if (set.size) out[name] = [...set];
      const path = await invoke<string | null>("support_bundle_save", { removed: out });
      if (path) setSaved(path);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const total = Object.values(removed).reduce((n, s) => n + s.size, 0);
  const counts = useMemo(() => Object.entries(bundle?.counts ?? {}).filter(([, n]) => n > 0), [bundle]);
  const lines = file?.lines ?? [];
  const first = Math.max(0, Math.floor(top / ROW) - 10);
  const end = Math.min(lines.length, first + Math.ceil(VIEW / ROW) + 20);

  return <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}
    onKeyDown={(e) => e.stopPropagation()}>
    <div ref={box} className="modal support-bundle" role="dialog" aria-modal="true" aria-labelledby="support-bundle-title">
      <div className="modal-head"><h2 id="support-bundle-title">Create Support Bundle</h2></div>
      <div className="modal-body">
        <p>Private information, such as your user name, computer name, folders and photo names, has been replaced
          in the text below. Nothing is uploaded: you save a file and decide where it goes.</p>
        {bundle && <p className="note-plain">{counts.length
          ? `Replaced: ${counts.map(([k, n]) => `${n} ${KINDS[k] ?? k}${n === 1 ? "" : "s"}`).join(", ")}.`
          : "Nothing needed replacing."} Click a line to leave it out; Shift-click leaves out a range.</p>}
        {busy && !bundle && <p role="status">Collecting…</p>}
        {bundle && <>
          <div className="sb-tabs" role="tablist">
            {bundle.files.map((f, n) => <button key={f.name} role="tab" aria-selected={n === tab}
              className={`sb-tab${n === tab ? " on" : ""}`} onClick={() => switchTab(n)}>
              {f.name}{removed[f.name]?.size ? ` (${removed[f.name].size} left out)` : ""}</button>)}
          </div>
          <div ref={scroller} className="sb-lines" style={{ height: VIEW }} onScroll={(e) => setTop(e.currentTarget.scrollTop)}>
            <div style={{ height: lines.length * ROW, position: "relative" }}>
              {lines.slice(first, end).map((l, k) => {
                const i = first + k;
                return <div key={i} className={`sb-line${gone.has(i) ? " gone" : ""}`} title={l}
                  style={{ top: i * ROW, height: ROW }} onClick={(e) => select(i, e.shiftKey)}>{l || " "}</div>;
              })}
            </div>
          </div>
        </>}
        {error && <p role="alert">{error}</p>}
        {saved && <p role="status">Saved to {saved}</p>}
      </div>
      <div className="modal-foot">
        <button className="btn" disabled={busy || !bundle || !!saved} onClick={() => void addBenchmark()}
          style={{ marginRight: "auto" }}>Add GUI Benchmark Report…</button>
        <button className="btn" disabled={busy} onClick={close}>{saved ? "Done" : "Cancel"}</button>
        {!saved && <button className="btn primary" disabled={busy || !bundle} onClick={() => void save()}>
          {busy && bundle ? "Saving…" : total ? `Save (${total} left out)…` : "Save…"}</button>}
      </div>
    </div>
  </div>;
}
