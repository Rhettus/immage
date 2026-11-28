// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { useEffect, useId, useRef, useState, type PointerEvent } from "react";
import { ChevronUp, X } from "lucide-react";
import type { SavedFilter } from "./findModel";
import { deleteSaved, loadSaved, moveSaved, renameSaved, useSaved } from "./savedFilters";
import { t } from "./i18n";

// The webview does not expose the system double-click interval.
const CLICK_DELAY = 500;
const DRAG_SLOP = 6;

type Drop = { id: string; after: boolean };
type Press = { id: string; pointerId: number; x: number; y: number; dragging: boolean };

export function SavedFiltersPanel({ current, open, onToggle, onApply }: {
  current: string | null; open: boolean;
  onToggle: (alt: boolean) => void;
  onApply: (filter: SavedFilter) => void;
}) {
  const title = useRef<HTMLButtonElement>(null);
  const listId = useId();
  return <div className="panel saved-filters-panel" onKeyDown={(e) => {
    // Keep button navigation and activation inside the card.
    if (e.code === "Tab" || e.code === "Space" || e.code === "Enter" || e.code === "NumpadEnter") e.stopPropagation();
  }}>
    <button ref={title} type="button" className={`panel-title${open ? " open" : ""}`}
            aria-expanded={open} aria-controls={open ? listId : undefined} onClick={(e) => onToggle(e.altKey)}>
      <span>{t("library.find.saved.manageTitle")}</span>
      <ChevronUp className={`chevron${open ? " open" : ""}`} aria-hidden="true" />
    </button>
    {open && <SavedFilterRows id={listId} current={current} onApply={onApply} focusTitle={() => title.current?.focus()} />}
  </div>;
}

function SavedFilterRows({ id, current, onApply, focusTitle }: {
  id: string; current: string | null; onApply: (filter: SavedFilter) => void; focusTitle: () => void;
}) {
  const saved = useSaved();
  const [edit, setEdit] = useState<SavedFilter | null>(null);
  const [confirm, setConfirm] = useState<SavedFilter | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const press = useRef<Press | null>(null);
  const pending = useRef<number | undefined>(undefined);
  const apply = useRef({ current, onApply });
  apply.current = { current, onApply };
  const cancelClick = () => window.clearTimeout(pending.current);
  useEffect(() => () => window.clearTimeout(pending.current), []);

  // If another view replaces the row being edited, discard its draft.
  const editing = edit && saved.some((f) => f.id === edit.id && f.name === edit.name) ? edit : null;
  const focusRow = (filterId: string | undefined) => {
    const row = Array.from(list.current?.children ?? []).find((el) => (el as HTMLElement).dataset.savedFilterId === filterId);
    const button = row?.querySelector<HTMLButtonElement>(".saved-filter-name");
    if (button) button.focus();
    else focusTitle();
  };

  const applyFilter = (filterId: string) => {
    const filter = loadSaved().find((f) => f.id === filterId);
    if (filter && filter.id !== apply.current.current) apply.current.onApply(filter);
  };

  const targetAt = (e: PointerEvent<HTMLUListElement>): Drop | null => {
    const row = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-saved-filter-id]");
    if (!row || row.parentElement !== e.currentTarget || row.dataset.savedFilterId === press.current?.id) return null;
    const box = row.getBoundingClientRect();
    return { id: row.dataset.savedFilterId!, after: e.clientY >= box.top + box.height / 2 };
  };

  const move = (e: PointerEvent<HTMLUListElement>) => {
    const active = press.current;
    if (!active || active.pointerId !== e.pointerId) return;
    if (!active.dragging) {
      if (Math.hypot(e.clientX - active.x, e.clientY - active.y) < DRAG_SLOP) return;
      active.dragging = true;
      cancelClick();
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    const target = targetAt(e);
    setDrop((previous) => previous?.id === target?.id && previous?.after === target?.after ? previous : target);
  };

  const resetDrag = () => { press.current = null; setDrop(null); };
  const finish = (e: PointerEvent<HTMLUListElement>) => {
    const active = press.current;
    if (!active || active.pointerId !== e.pointerId) return;
    const target = active.dragging ? targetAt(e) : null;
    resetDrag();
    if (!target) return;
    const order = loadSaved();
    const from = order.findIndex((f) => f.id === active.id);
    const to = order.findIndex((f) => f.id === target.id);
    if (from < 0 || to < 0) return;
    const index = to + Number(target.after) - Number(from < to);
    if (from !== index) moveSaved(active.id, index);
  };

  const askDelete = (filter: SavedFilter) => {
    cancelClick();
    resetDrag();
    setConfirm(filter);
  };

  return <div id={id} className="saved-filter-body">
    {saved.length === 0 && <p>{t("library.find.saved.panelEmpty")}</p>}
    <ul ref={list} className="saved-filter-rows" onPointerMove={move} onPointerUp={finish}
        onPointerCancel={resetDrag} onLostPointerCapture={resetDrag}
        onPointerLeave={() => { if (!press.current?.dragging) resetDrag(); }}>
      {saved.map((f, i) => <li key={f.id} data-saved-filter-id={f.id}
          className={drop?.id === f.id ? (drop.after ? "drop-after" : "drop-before") : undefined}>
        {editing?.id === f.id
          ? <FilterNameInput key={f.name} filter={f} close={(name, restoreFocus) => {
              if (name !== undefined && loadSaved().some((latest) => latest.id === f.id && latest.name === f.name)) {
                renameSaved(f.id, name);
              }
              setEdit(null);
              if (restoreFocus) requestAnimationFrame(() => focusRow(f.id));
            }} />
          : <button type="button" className="saved-filter-name" title={f.name} aria-pressed={current === f.id}
                    onPointerDown={(e) => {
                      if (e.button === 0 && e.isPrimary && e.pointerType !== "touch" && !editing) {
                        press.current = { id: f.id, pointerId: e.pointerId, x: e.clientX, y: e.clientY, dragging: false };
                      }
                    }}
                    onClick={(e) => {
                      cancelClick();
                      if (e.detail === 0) applyFilter(f.id);
                      else if (e.detail === 1) pending.current = window.setTimeout(() => applyFilter(f.id), CLICK_DELAY);
                    }}
                    onDoubleClick={() => { cancelClick(); setEdit(f); }}
                    onKeyDown={(e) => {
                      if (e.code === "F2" || e.code === "Delete") {
                        e.preventDefault();
                        e.stopPropagation();
                        cancelClick();
                        if (e.code === "F2") setEdit(f);
                        else askDelete(f);
                      }
                    }}>
              <span className="saved-filter-check" aria-hidden="true">{current === f.id ? "✓" : ""}</span>
              <span className="saved-filter-label">{f.name}</span>
            </button>}
        <button type="button" className="saved-filter-delete"
                title={t("library.find.saved.deleteNamed", { name: f.name })}
                aria-label={t("library.find.saved.deleteNamed", { name: f.name })}
                onClick={() => askDelete(f)}><X size={14} aria-hidden="true" /></button>
        {confirm?.id === f.id && <DeleteFilterDialog name={f.name} onClose={() => {
          setConfirm(null);
          requestAnimationFrame(() => focusRow(f.id));
        }} onConfirm={() => {
          const next = saved[i + 1] ?? saved[i - 1];
          deleteSaved(f.id);
          setConfirm(null);
          requestAnimationFrame(() => focusRow(next?.id));
        }} />}
      </li>)}
    </ul>
  </div>;
}

function FilterNameInput({ filter, close }: {
  filter: SavedFilter; close: (name: string | undefined, restoreFocus: boolean) => void;
}) {
  const [text, setText] = useState(filter.name);
  const done = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  const finish = (name: string | undefined, restoreFocus: boolean) => {
    if (done.current) return;
    done.current = true;
    close(name, restoreFocus);
  };
  return <input ref={input} className="saved-filter-input" type="text" value={text}
                aria-label={t("library.find.saved.name")} onChange={(e) => setText(e.target.value)}
                onBlur={() => finish(text, false)} onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.nativeEvent.isComposing) return;
                  if (e.code === "Enter" || e.code === "NumpadEnter" || e.code === "Escape") {
                    e.preventDefault();
                    finish(e.code === "Escape" ? undefined : text, true);
                  }
                }} />;
}

function DeleteFilterDialog({ name, onClose, onConfirm }: {
  name: string; onClose: () => void; onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    cancel.current?.focus();
    return () => element.close();
  }, []);
  return <dialog ref={dialog} className="modal saved-filter-confirm"
                 aria-labelledby={titleId} aria-describedby={messageId}
                 onKeyDown={(e) => e.stopPropagation()}
                 onCancel={(e) => { e.preventDefault(); onClose(); }}>
    <div className="modal-head"><h2 id={titleId}>{t("library.find.saved.delete")}</h2></div>
    <div className="modal-body"><p id={messageId}>{t("library.find.saved.confirmDeleteNamed", { name })}</p></div>
    <div className="modal-foot">
      <button ref={cancel} type="button" className="btn" onClick={onClose}>{t("dialogs.common.cancel")}</button>
      <button type="button" className="btn primary" onClick={onConfirm}>{t("library.find.saved.delete")}</button>
    </div>
  </dialog>;
}
