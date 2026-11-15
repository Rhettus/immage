// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Preferences > General > Backup: one .zip holding the parts of Immage's state
// the user chooses (backup.rs). Restore replaces the chosen parts with the
// backup's and keeps a copy of what it replaced.
import { useEffect, useState } from "react";
import { commands, type BackupComponent as Component, type BackupSummary as Summary } from "./commands";
import { settings } from "./settings";
import { formatDate, formatNumber, t } from "./i18n";

export type BackupMode = "create" | "restore";


const size = (n: number) => n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(0)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`;
const detail = (c: { bytes: number; files: number; id: string }) =>
  c.id === "looks" ? t("dialogs.backup.looksDetail", { count: formatNumber(c.files), size: size(c.bytes) }) : size(c.bytes);
const componentLabel = (id: string, fallback: string) => {
  const key: Record<string, string> = { settings: "settings", presets: "presets", export_presets: "exportPresets", looks: "looks", plugins: "plugins", darktable: "darktable" };
  return key[id] ? t(`dialogs.backup.component.${key[id]}`) : fallback;
};

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
    commands.backupComponents()
      .then((all) => pick(all.filter((c) => c.available)))
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  }, [mode]);

  const toggle = (id: string) => setChosen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const create = async () => {
    setBusy(true); setError("");
    try {
      const to = await commands.backupPickSave();
      if (!to) return;
      // the backup holds what the page has, not what it has yet to send
      await settings.flush();
      await commands.backupCreate(to, items!.filter((c) => chosen.has(c.id)).map((c) => c.id));
      setDone(t("dialogs.backup.saved", { path: to }));
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };

  const choose = async () => {
    setBusy(true); setError("");
    try {
      const from = await commands.backupPickOpen();
      if (!from) return;
      const s = await commands.backupInspect(from);
      setPath(from); setSummary(s); pick(s.components);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };

  const restore = async () => {
    setBusy(true); setError("");
    try {
      const out = await commands.backupRestore(path, items!.filter((c) => chosen.has(c.id)).map((c) => c.id));
      // the page's own copy must not be written over what was restored
      settings.discard();
      setDone(t("dialogs.backup.restored", { path: out.savedTo }));
      window.setTimeout(() => location.reload(), 1200);
    } catch (e) { setError(String(e)); setBusy(false); }
  };

  const when = summary?.created ? new Date(summary.created) : null;
  const dated = when && !Number.isNaN(when.getTime()) ? formatDate(when, { dateStyle: "medium", timeStyle: "short" }) : "";
  const nothing = items !== null && items.length === 0;

  return <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape" && !busy) onClose(); }}>
    <div className="modal backup-dialog" role="dialog" aria-modal="true" aria-labelledby="backup-title">
      <div className="modal-head"><h2 id="backup-title">{mode === "create" ? t("dialogs.backup.title") : t("dialogs.backup.restoreTitle")}</h2></div>
      <div className="modal-body">
        {mode === "create" && <p className="note-plain">{t("dialogs.backup.description")}</p>}
        {mode === "restore" && !summary && <p>{t("dialogs.backup.chooseExisting")}</p>}
        {summary && <p className="note-plain">{t("dialogs.backup.madeBy", { date: dated ? t("dialogs.backup.onDate", { date: dated }) : "", version: summary.version || t("dialogs.backup.unknownVersion") })}</p>}
        {summary?.newer && <p className="note-plain warn" role="alert">{t("dialogs.backup.newerVersion", { version: summary.version })}</p>}
        {busy && !items && mode === "create" && <p role="status">{t("dialogs.common.looking")}</p>}
        {nothing && mode === "create" && <p>{t("dialogs.backup.nothingToBackUp")}</p>}
        {items && items.length > 0 && <div role="group" aria-label={t("dialogs.backup.items")}>
          {items.map((c) => <label key={c.id} className="row check">
            <input type="checkbox" checked={chosen.has(c.id)} disabled={busy || !!done} onChange={() => toggle(c.id)} />
            <span>{componentLabel(c.id, c.label)}</span><span className="note-plain" style={{ marginLeft: "auto" }}>{detail(c)}</span>
          </label>)}
        </div>}
        {mode === "restore" && summary && !done && <p className="note-plain warn">{t("dialogs.backup.restoreWarning")}</p>}
        {error && <p role="alert">{error}</p>}
        {done && <p role="status">{done}</p>}
      </div>
      <div className="modal-foot">
        <button className="btn" disabled={busy && !done} onClick={onClose}>
          {done && mode === "create" ? t("dialogs.common.done") : t("dialogs.common.cancel")}</button>
        {mode === "create" && !done && <button className="btn primary" disabled={busy || chosen.size === 0} onClick={() => void create()}>
          {busy && items ? t("dialogs.backup.backingUp") : t("dialogs.backup.action")}</button>}
        {mode === "restore" && !summary && <button className="btn primary" disabled={busy} onClick={() => void choose()}>{t("dialogs.common.chooseFile")}</button>}
        {mode === "restore" && summary && !done && <button className="btn primary" disabled={busy || chosen.size === 0} onClick={() => void restore()}>
          {busy ? t("dialogs.backup.restoring") : t("dialogs.backup.restoreAction")}</button>}
      </div>
    </div>
  </div>;
}
