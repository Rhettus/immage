// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlignLeft, Trash2 } from "lucide-react";
import { menuKeys, useCardMenu } from "./cardMenu";
import type { DtPreset } from "./commands";
import type { ModulePresetChange } from "./session";
import { presetLabel } from "./presetName";
import { t } from "./i18n";
import { fieldText } from "./fieldText";

export function PresetMenu({ name, load, importPreset, onPick }: {
  name: string;
  load: (change?: ModulePresetChange) => Promise<DtPreset[]>;
  importPreset: (xml: string) => Promise<DtPreset[]>;
  onPick: (rawName: string) => void;
}) {
  const [list, setList] = useState<DtPreset[] | null>(null);
  const [dialog, setDialog] = useState<ModulePresetChange | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const { at, close, toggle, box, menu } = useCardMenu(list ?? error);

  const open = (e: React.MouseEvent<HTMLButtonElement>) => {
    const id = ++request.current;
    if (!toggle(e)) return;
    setList(null);
    setError("");
    load().then((presets) => {
      if (request.current === id) setList(presets);
    }, (e) => {
      if (request.current === id) setError(t("fields.preset.loadError", { error: String(e) }));
    });
  };
  const start = (change: ModulePresetChange) => {
    close();
    setError("");
    setDialog(change);
  };
  const finish = () => {
    setDialog(null);
    trigger.current?.focus();
  };
  const presetName = dialog?.action === "save" ? dialog.name.trim() : dialog?.name ?? "";
  const duplicate = dialog?.action === "save" && list?.some((p) => p.applicable && p.name === presetName);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!dialog || !presetName || duplicate || busy) return;
    setBusy(true);
    setError("");
    try {
      setList(await load(dialog.action === "save" ? { ...dialog, name: presetName } : dialog));
      finish();
    } catch (e) {
      setError(t("fields.preset.changeError", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  };
  const readFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      if (file.size > 1024 * 1024) throw Error(t("fields.preset.fileTooLarge"));
      setList(await importPreset(await file.text()));
    } catch (e) {
      setError(t("fields.preset.importError", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  };
  const item = (p: DtPreset) => {
    const label = p.builtin ? presetLabel(p.name) : p.name;
    return (
      <div key={JSON.stringify([p.name, p.version])} className="module-preset-row" role="none">
        <button type="button" role="menuitemradio" aria-checked={p.active} data-preset={p.name}
                disabled={busy || !p.applicable} title={p.applicable ? fieldText(p.description || "") || undefined : t("fields.preset.notApplicable")}
                onClick={(e) => { e.stopPropagation(); close(); onPick(p.name); }}>
          <span className="check">{p.active ? "✓" : ""}</span><span className="name">{label}</span>
        </button>
        {!p.builtin && <button type="button" role="menuitem" className="module-preset-delete" disabled={busy}
          aria-label={t("dialogs.presets.deleteNamed", { name: label })} title={t("dialogs.presets.deleteNamed", { name: label })}
          onClick={(e) => { e.stopPropagation(); start({ action: "delete", name: p.name, version: p.version }); }}>
          <Trash2 size={14} />
        </button>}
      </div>
    );
  };
  const builtin = list?.filter((p) => p.builtin) ?? [];
  const own = list?.filter((p) => !p.builtin) ?? [];
  return (
    <span className="preset-menu" ref={box}>
      <button ref={trigger} type="button" className={`module-card-menu${at ? " on" : ""}`} aria-haspopup="menu" aria-expanded={!!at}
              aria-label={t("fields.preset.for", { name })} title={t("fields.preset.title")} disabled={busy} onClick={open}>
        <AlignLeft size={14} strokeWidth={1.8} />
      </button>
      {at && createPortal(
        <div ref={menu} className="context-menu module-menu" role="menu"
             style={{ position: "fixed", left: at.x, top: at.y, maxHeight: "60vh", overflowY: "auto" }}
             onKeyDown={menuKeys}>
          <div className="menu-label">{t("fields.preset.title")}</div>
          {error && <div className="menu-label" role="alert">{error}</div>}
          {builtin.map(item)}
          {builtin.length > 0 && own.length > 0 && <div className="menu-sep" />}
          {own.map(item)}
          {list && <>
            {list.length > 0 && <div className="menu-sep" />}
            <input ref={fileInput} type="file" accept=".dtpreset" hidden onChange={readFile}
                   onClick={(e) => e.stopPropagation()} />
            <button type="button" role="menuitem" disabled={busy}
                    onClick={(e) => { e.stopPropagation(); fileInput.current?.click(); }}>{t("fields.preset.import")}</button>
            <button type="button" role="menuitem" disabled={busy} onClick={(e) => {
              e.stopPropagation();
              start({ action: "save", name: "" });
            }}>{t("fields.preset.saveNew")}</button>
          </>}
        </div>, document.body)}
      {dialog && createPortal(
        <div className="modal-backdrop" onClick={(e) => e.stopPropagation()}
             onPointerDown={(e) => { e.stopPropagation(); if (!busy && e.target === e.currentTarget) finish(); }}
             onKeyDown={(e) => { e.stopPropagation(); if (!busy && e.key === "Escape") finish(); }}>
          <form className="modal new-preset" role="dialog" aria-modal="true"
                aria-label={dialog.action === "save" ? t("dialogs.presets.newTitle") : t("fields.preset.deleteTitle", { name: dialog.name })}
                onSubmit={submit}>
            <div className="modal-head">
              <h2>{dialog.action === "save" ? t("dialogs.presets.newTitle") : t("fields.preset.deleteTitle", { name: dialog.name })}</h2>
            </div>
            <div className="modal-body">
              {dialog.action === "save" && <label className="row">
                <span className="k">{t("dialogs.presets.name")}</span>
                <input autoFocus className="field" value={dialog.name} disabled={busy}
                       onChange={(e) => setDialog({ action: "save", name: e.target.value })} />
              </label>}
              {duplicate && <p role="alert">{t("fields.preset.duplicate")}</p>}
              {error && <p role="alert">{error}</p>}
            </div>
            <div className="modal-foot">
              <button type="button" autoFocus={dialog.action === "delete"} className="btn" disabled={busy} onClick={finish}>
                {t("dialogs.common.cancel")}
              </button>
              <button type="submit" className="btn primary" disabled={busy || !presetName || !!duplicate}>
                {t(dialog.action === "save" ? "dialogs.presets.create" : "dialogs.presets.delete")}
              </button>
            </div>
          </form>
        </div>, document.body)}
    </span>
  );
}
