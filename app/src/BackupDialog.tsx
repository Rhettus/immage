// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Preferences > General > Backup: one .zip holding the parts of Immage's state
// the user chooses (backup.rs). Restore replaces the chosen parts with the
// backup's and keeps a copy of what it replaced.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { settings } from "./settings";

export type BackupMode = "create" | "restore";

type Component = { id: string; label: string; available: boolean; bytes: number; files: number };
type Summary = { version: string; created: string; newer: boolean; components: Omit<Component, "available">[] };
type Restored = { components: string[]; engineRestarted: boolean; savedTo: string };

const size = (n: number) => n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(0)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`;
const detail = (c: { bytes: number; files: number; id: string }) =>
  c.id === "looks" ? `${c.files} ${c.files === 1 ? "look" : "looks"}, ${size(c.bytes)}` : size(c.bytes);

export function BackupDialog({ mode, onClose }: { mode: BackupMode; onClose: () => void }) {
  const [items, setItems] = useState<Omit<Component, "available">[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [path, setPath] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(mode === "create");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const pick = (list: Omit<Component, "available">[]) => { setItems(list); setChosen(new Set(list.map((c) => c.id))); };

  useEffect(() => {
    if (mode !== "create") return;
    invoke<Component[]>("backup_components")
      .then((all) => pick(all.filter((c) => c.available)))
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  }, [mode]);

  const toggle = (id: string) => setChosen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const create = async () => {
    setBusy(true); setError("");
    try {
      const to = await invoke<string | null>("backup_pick_save");
      if (!to) return;
      // the backup holds what the page has, not what it has yet to send
      await settings.flush();
      await invoke("backup_create", { path: to, components: items!.filter((c) => chosen.has(c.id)).map((c) => c.id) });
      setDone(`Saved to ${to}`);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };

  const choose = async () => {
    setBusy(true); setError("");
    try {
      const from = await invoke<string | null>("backup_pick_open");
      if (!from) return;
      const s = await invoke<Summary>("backup_inspect", { path: from });
      setPath(from); setSummary(s); pick(s.components);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };

  const restore = async () => {
    setBusy(true); setError("");
    try {
      const out = await invoke<Restored>("backup_restore", { path, components: items!.filter((c) => chosen.has(c.id)).map((c) => c.id) });
      // the page's own copy must not be written over what was restored
      settings.discard();
      setDone(`Restored. A copy of what was replaced is in ${out.savedTo}`);
      window.setTimeout(() => location.reload(), 1200);
    } catch (e) { setError(String(e)); setBusy(false); }
  };

  const when = summary?.created ? new Date(summary.created) : null;
  const dated = when && !Number.isNaN(when.getTime()) ? when.toLocaleString() : "";
  const nothing = items !== null && items.length === 0;

  return <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape" && !busy) onClose(); }}>
    <div className="modal backup-dialog" role="dialog" aria-modal="true" aria-labelledby="backup-title">
      <div className="modal-head"><h2 id="backup-title">{mode === "create" ? "Back Up" : "Restore from a Backup"}</h2></div>
      <div className="modal-body">
        {mode === "create" && <p className="note-plain">Choose what to save in the backup file. API keys for Immich and map
          search stay in your system's keychain and are not included.</p>}
        {mode === "restore" && !summary && <p>Choose a backup file made with Back Up.</p>}
        {summary && <p className="note-plain">Made {dated ? `on ${dated} ` : ""}by Immage {summary.version || "(unknown version)"}.</p>}
        {summary?.newer && <p className="note-plain warn" role="alert">This backup was made by a newer Immage than this one
          ({summary.version}). Some of it may not be understood here.</p>}
        {busy && !items && mode === "create" && <p role="status">Looking…</p>}
        {nothing && mode === "create" && <p>There is nothing to back up yet.</p>}
        {items && items.length > 0 && <div role="group" aria-label="Items">
          {items.map((c) => <label key={c.id} className="row check">
            <input type="checkbox" checked={chosen.has(c.id)} disabled={busy || !!done} onChange={() => toggle(c.id)} />
            <span>{c.label}</span><span className="note-plain" style={{ marginLeft: "auto" }}>{detail(c)}</span>
          </label>)}
        </div>}
        {mode === "restore" && summary && !done && <p className="note-plain warn">The chosen items replace the current ones. A copy of
          what is replaced is kept in the backups folder in Immage's data folder. Immage reloads when it is done.</p>}
        {error && <p role="alert">{error}</p>}
        {done && <p role="status">{done}</p>}
      </div>
      <div className="modal-foot">
        <button className="btn" disabled={busy && !done} onClick={onClose}>
          {done && mode === "create" ? "Done" : "Cancel"}</button>
        {mode === "create" && !done && <button className="btn primary" disabled={busy || chosen.size === 0} onClick={() => void create()}>
          {busy && items ? "Backing up…" : "Back Up…"}</button>}
        {mode === "restore" && !summary && <button className="btn primary" disabled={busy} onClick={() => void choose()}>Choose File…</button>}
        {mode === "restore" && summary && !done && <button className="btn primary" disabled={busy || chosen.size === 0} onClick={() => void restore()}>
          {busy ? "Restoring…" : "Restore"}</button>}
      </div>
    </div>
  </div>;
}
