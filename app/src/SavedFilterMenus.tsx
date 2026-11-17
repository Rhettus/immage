// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the Find popup's saved filters: the Saved menu (also the toolbar's Find
// split button), the name line of an applied one, the name prompt and the
// Manage dialog. the list is savedFilters.ts
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { menuKeys, useCardMenu } from "./cardMenu";
import { keys } from "./keys";
import { sameFind, type FindState, type SavedFilter } from "./findModel";
import { deleteSaved, moveSaved, renameSaved, useSaved } from "./savedFilters";
import { t } from "./i18n";

export function SavedMenu({ current, onApply, onManage, button }: {
  current: string | null;
  onApply: (f: SavedFilter) => void;
  onManage: () => void;
  button?: ReactNode;
}) {
  const saved = useSaved();
  const { at, close, toggle, box, menu } = useCardMenu(saved.length);
  const run = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); close(); fn(); };
  return (
    <span className="saved-menu" ref={box}>
      <button type="button" className={`saved-menu-button${at ? " on" : ""}`} aria-haspopup="menu" aria-expanded={!!at}
              onClick={(e) => { toggle(e, true); }}>
        {button ?? <>{t("library.find.saved.button")}<ChevronDown size={12} strokeWidth={1.8} /></>}
      </button>
      {at && createPortal(
        <div ref={menu} className="context-menu module-menu saved-list" role="menu" style={{ position: "fixed", left: at.x, top: at.y }}
             onKeyDown={menuKeys}>
          {saved.length === 0 && <div className="menu-label saved-empty">{t("library.find.saved.empty")}</div>}
          {saved.map((f, i) => (
            <button key={f.id} type="button" role="menuitemradio" aria-checked={f.id === current} className="saved-item"
                    onClick={run(() => onApply(f))}>
              <span className="check">{f.id === current ? "✓" : ""}</span>
              <span className="name" title={f.name}>{f.name}</span>
              {i < 9 && <span className="tag">{keys(`⌥${i + 1}`)}</span>}
            </button>
          ))}
          {saved.length > 0 && <div className="menu-sep" />}
          <button type="button" role="menuitem" onClick={run(onManage)}>
            <span className="check" /><span className="name">{t("library.find.saved.manage")}</span>
          </button>
        </div>, document.body)}
    </span>
  );
}

export function SavedLine({ saved, state, onUpdate, onSaveNew, onDetach }: {
  saved: SavedFilter; state: FindState;
  onUpdate: () => void; onSaveNew: () => void; onDetach: () => void;
}) {
  const changed = !sameFind(saved.state, state);
  return (
    <div className="saved-line">
      <span className="saved-name" title={saved.name}>{saved.name}</span>
      {changed && <span className="saved-changed">{t("library.find.saved.changed")}</span>}
      {changed && <button type="button" className="btn small" onClick={onUpdate}>{t("library.find.saved.update")}</button>}
      <button type="button" className="btn small" onClick={onSaveNew}>{t("library.find.saved.saveAsNew")}</button>
      <button type="button" className="saved-detach" aria-label={t("library.find.saved.detach")} title={t("library.find.saved.detach")} onClick={onDetach}>
        <X size={12} strokeWidth={1.8} />
      </button>
    </div>
  );
}

export function SaveDialog({ initial, onSave, onCancel }: {
  initial: string; onSave: (name: string) => void; onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  const ok = !!name.trim();
  const save = () => { if (ok) onSave(name.trim()); };
  return <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    onKeyDown={(e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      // Enter on a focused button (Cancel) presses that button
      if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); save(); }
    }}>
    <div className="modal save-filter" role="dialog" aria-modal="true" aria-labelledby="save-filter-title">
      <div className="modal-head"><h2 id="save-filter-title">{t("library.find.saved.saveTitle")}</h2></div>
      <div className="modal-body">
        <label className="row">
          <span className="k">{t("library.find.saved.name")}</span>
          <input ref={input} type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      </div>
      <div className="modal-foot">
        <button type="button" className="btn" onClick={onCancel}>{t("dialogs.common.cancel")}</button>
        <button type="button" className="btn primary" disabled={!ok} onClick={save}>{t("library.find.saved.save")}</button>
      </div>
    </div>
  </div>;
}

export function ManageSavedDialog({ onClose }: { onClose: () => void }) {
  const saved = useSaved();
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  // set when the rename is over (committed or discarded), so the blur that follows the input's removal does nothing
  const done = useRef(false);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    if (renaming) renameSaved(renaming.id, renaming.text);
    setRenaming(null);
  };
  const discard = () => { done.current = true; setRenaming(null); };
  return <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    onKeyDown={(e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        if (renaming) discard(); else if (confirm) setConfirm(null); else onClose();
      }
    }}>
    <div className="modal saved-manage" role="dialog" aria-modal="true" aria-labelledby="saved-manage-title">
      <div className="modal-head"><h2 id="saved-manage-title">{t("library.find.saved.manageTitle")}</h2></div>
      <div className="modal-body">
        {saved.length === 0 && <p className="note-plain">{t("library.find.saved.empty")}</p>}
        <ul className="saved-rows">
          {saved.map((f, i) => (
            <li key={f.id} className="row">
              {renaming?.id === f.id
                ? <input type="text" autoFocus value={renaming.text} aria-label={t("library.find.saved.name")}
                         onChange={(e) => setRenaming({ id: f.id, text: e.target.value })}
                         onBlur={commit}
                         onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); commit(); } }} />
                : <span className="name" title={f.name}>{f.name}</span>}
              {confirm === f.id ? <>
                <span className="note-plain">{t("library.find.saved.confirmDelete")}</span>
                <button type="button" className="btn small" onClick={() => { deleteSaved(f.id); setConfirm(null); }}>{t("library.find.saved.delete")}</button>
                <button type="button" className="btn small" onClick={() => setConfirm(null)}>{t("dialogs.common.cancel")}</button>
              </> : <>
                <button type="button" className="btn small" onMouseDown={(e) => e.preventDefault()}
                        onClick={() => { done.current = false; setRenaming({ id: f.id, text: f.name }); }}>{t("library.find.saved.rename")}</button>
                <button type="button" className="btn small icon" aria-label={t("library.find.saved.moveUp")} title={t("library.find.saved.moveUp")}
                        disabled={i === 0} onClick={() => moveSaved(f.id, i - 1)}><ChevronUp size={12} strokeWidth={1.8} /></button>
                <button type="button" className="btn small icon" aria-label={t("library.find.saved.moveDown")} title={t("library.find.saved.moveDown")}
                        disabled={i === saved.length - 1} onClick={() => moveSaved(f.id, i + 1)}><ChevronDown size={12} strokeWidth={1.8} /></button>
                <button type="button" className="btn small" onClick={() => setConfirm(f.id)}>{t("library.find.saved.delete")}</button>
              </>}
            </li>
          ))}
        </ul>
      </div>
      <div className="modal-foot">
        <button type="button" className="btn primary" onClick={onClose}>{t("dialogs.common.done")}</button>
      </div>
    </div>
  </div>;
}
