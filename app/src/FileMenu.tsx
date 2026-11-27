// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { FILE_MANAGER } from "./ExportDialog";
import { type ImageEntry, LABEL_COLORS, fileKind } from "./library";
import { type EditInAction } from "./plugins";
import { isRemote } from "./immich";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { parentDir } from "./paths";
import { useEffect, useLayoutEffect, useRef } from "react";
import { t } from "./i18n";

// what the system's file manager is called
export const TRASH = navigator.userAgent.includes("Windows") ? "Recycle Bin" : "Trash";

// the raws an HDR merge takes of `list`: each file once, as the merge reads
// the raw alone, whichever version's edit it has
export const hdrBrackets = (list: ImageEntry[]) => {
  const seen = new Set<string>();
  return list.filter((i) => !isRemote(i) && fileKind(i.filename) === "RAW" && !seen.has(i.path) && !!seen.add(i.path));
};
// Panorama Merge takes local photos, each source file once.
export const panoFrames = (list: ImageEntry[]) => {
  const seen = new Set<string>();
  return list.filter((i) => !isRemote(i) && !seen.has(i.path) && !!seen.add(i.path));
};

// a right-click menu's ref: any click outside it, a scroll, Escape or the
// window losing focus closes it
export function useMenuClose(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: Event) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("wheel", onClose, true);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("wheel", onClose, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  return ref;
}

// a photo's right-click menu: Edit In, Show in Finder, as Lightroom's, and
// Delete, for rejected photos only; for Immich results, the photo or the
// whole search in Immich's web app. any click elsewhere, a scroll or Escape
// closes it
export function FileMenu({ onSimilar, onKeywords, onMoveTo, onRename, rate, captureCount, onCaptureTime, canUndoCapture, onUndoCapture, resetCount, onReset, x, y, copyable, copies, mergeable, stitchable, reveal, rejected, photo, results, parentFolder, onImportParent, editIn, onCopy,
                    onRemoveCopies, onMergeHdr, onMergePano, onDelete, onEditIn, onSetUpPlugins, onShowInLibrary, onClose }: {
  onSimilar?: () => void;
  onKeywords?: () => void;
  onRename?: () => void;
  onMoveTo?: (copy: boolean) => void;     // Move to Folder… (false) or Copy to Folder… (true)
  // the photos it rates: the rating and the label bits all of them share, whether all are rejected;
  // null when none can be rated (Immich results)
  rate: { rating: number | null; labels: number; rejected: boolean;
          setRating: (n: number) => void; toggleLabel: (bit: number) => void; toggleReject: () => void } | null;
  captureCount: number; onCaptureTime: () => void;
  canUndoCapture: boolean; onUndoCapture: () => void;
  resetCount?: number; onReset?: () => void;
  x: number; y: number;
  copyable: number;                       // how many photos a virtual copy can be made of
  mergeable: number;                      // how many raws an HDR merge would take
  stitchable: number;                     // how many photos a panorama would take
  copies: number;                         // how many virtual copies it acts on, when it acts on nothing else
  reveal: string | null;                  // the file to show in the file manager
  rejected: number | null;                // how many of the photos it acts on are rejected; null, none can be
  photo: string | null;                   // the photo in Immich's web app
  results: string | null;                 // the search it came from, there
  parentFolder: string | null | undefined; // local Immich file; undefined for ordinary folder entries
  onImportParent: (path: string) => void;
  editIn: { action: EditInAction; label: string; why: string | null }[] | null;  // the plugins, and why one cannot take the photos
  onEditIn: (action: EditInAction) => void; onSetUpPlugins: () => void;
  onCopy: () => void; onRemoveCopies: () => void; onMergeHdr: () => void; onMergePano: () => void;
  onDelete: () => void; onShowInLibrary?: () => void; onClose: () => void;
}) {
  const ref = useMenuClose(onClose);
  const go = (url: string) => { onClose(); void openUrl(url); };
  // kept inside the window
  const left = Math.min(x, window.innerWidth - 230);
  // the menu's real height keeps it inside the window; its first submenu
  // starts near the top, so it fits when the menu does
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - el.offsetHeight - 8))}px`;
  });
  const top = y;
  // the Edit In list opens to the left when there is no room on the right
  const flip = left + 230 + 230 > window.innerWidth;
  return (
    <div ref={ref} className={`context-menu${flip ? " flip" : ""}`} style={{ left, top }}>
      {onSimilar && <button onClick={() => { onClose(); onSimilar(); }}>{t("library.menu.similar")}</button>}
      {(rate || onKeywords) && <>
        {rate && <>
          <div className="has-sub">
            <button>{t("library.menu.rating")}</button>
            <div className="context-menu submenu">
              {[5, 4, 3, 2, 1].map((n) => (
                <button key={n} className="hinted" aria-label={t(`menu.rate-${n}`)} onClick={() => { onClose(); rate.setRating(n); }}>
                  <span className="check tick">{rate.rating === n ? "✓" : ""}</span>
                  <span className="name stars">{"★".repeat(n)}{"☆".repeat(5 - n)}</span>
                  <span className="hint key">{n}</span>
                </button>
              ))}
              <button className="hinted" onClick={() => { onClose(); rate.setRating(0); }}>
                <span className="check tick">{rate.rating === 0 ? "✓" : ""}</span>
                <span className="name">{t("library.menu.noRating")}</span>
                <span className="hint key">0</span>
              </button>
            </div>
          </div>
          <div className="has-sub">
            <button>{t("library.menu.colorLabel")}</button>
            <div className="context-menu submenu">
              {(["red", "yellow", "green", "blue", "purple"] as const).map((name, n) => (
                <button key={name} className="hinted" data-label={name} onClick={() => { onClose(); rate.toggleLabel(1 << n); }}>
                  <span className="check tick">{rate.labels & (1 << n) ? "✓" : ""}</span>
                  <span className="dot" style={{ background: LABEL_COLORS[n] }} />
                  <span className="name">{t(`library.menu.label-${name}`)}</span>
                  <span className="hint key">{n < 4 ? n + 6 : ""}</span>
                </button>
              ))}
            </div>
          </div>
          <button className="hinted" onClick={() => { onClose(); rate.toggleReject(); }}>
            <span className="name">{rate.rejected ? t("library.menu.unreject") : t("library.menu.reject")}</span>
            <span className="hint key">X</span>
          </button>
        </>}
        {onKeywords && <button className="hinted" onClick={() => { onClose(); onKeywords(); }}>
          <span className="name">{t("library.menu.keywords")}</span><span className="hint key">K</span></button>}
        <div className="menu-sep" />
      </>}
      {editIn && <>
        <div className="has-sub">
          <button>{t("library.menu.editIn")}</button>
          <div className="context-menu submenu">
            {editIn.map(({ action, label, why }) => (
              <button key={action.cfg.id + (action.mode ?? "")} disabled={!!why} title={why ?? undefined}
                      onClick={() => { onClose(); onEditIn(action); }}>{label}</button>
            ))}
            {editIn.length > 0 && <div className="menu-sep" />}
            <button onClick={() => { onClose(); onSetUpPlugins(); }}>
              {editIn.length ? t("library.menu.plugins") : t("library.menu.setupPlugins")}</button>
          </div>
        </div>
        <div className="menu-sep" />
      </>}
      {onMoveTo && <>
        <button onClick={() => { onClose(); onMoveTo(false); }}>{t("menu.move-to-folder")}</button>
        <button onClick={() => { onClose(); onMoveTo(true); }}>{t("menu.copy-to-folder")}</button>
      </>}
      {onRename && <button onClick={() => { onClose(); onRename(); }}>{t("library.menu.rename")}</button>}
      {captureCount > 0 && <button onClick={() => { onClose(); onCaptureTime(); }}>{t("library.menu.adjustCapture")}</button>}
      {canUndoCapture && <button onClick={() => { onClose(); onUndoCapture(); }}>{t("library.menu.undoCapture")}</button>}
      {!!resetCount && resetCount > 0 && onReset && <button onClick={() => { onClose(); onReset(); }}>
        {resetCount > 1 ? t("library.menu.resetPhotosMany", { count: resetCount }) : t("library.menu.resetPhotoOne")}</button>}
      {copyable > 0 && <>
        <button onClick={() => { onClose(); onCopy(); }}>
          {copyable > 1 ? t("library.menu.createCopies", { count: copyable }) : t("library.menu.createCopy")}</button>
        {copies > 0 && <button onClick={() => { onClose(); onRemoveCopies(); }}>
          {copies > 1 ? t("library.menu.removeCopies", { count: copies }) : t("library.menu.removeCopy")}</button>}
        {(onShowInLibrary || reveal || photo || results || rejected !== null) && <div className="menu-sep" />}
      </>}
      {(mergeable > 1 || stitchable > 1) && <>
        {mergeable > 1 && <button onClick={() => { onClose(); onMergeHdr(); }}>{t("library.menu.hdr")}</button>}
        {stitchable > 1 && <button onClick={() => { onClose(); onMergePano(); }}>{t("library.menu.panorama")}</button>}
        <div className="menu-sep" />
      </>}
      {onShowInLibrary && <button onClick={() => { onClose(); onShowInLibrary(); }}>{t("library.menu.showInLibrary")}</button>}
      {reveal && <button onClick={() => { onClose(); void revealItemInDir(reveal); }}>{t("library.menu.showIn", { manager: FILE_MANAGER })}</button>}
      {parentFolder !== undefined && <button disabled={!parentFolder}
        title={parentFolder ? parentDir(parentFolder) : t("library.menu.parentHint")}
        onClick={() => { onClose(); if (parentFolder) onImportParent(parentFolder); }}>{t("library.menu.importParent")}</button>}
      {photo && <button onClick={() => go(photo)}>{t("library.menu.showImmich")}</button>}
      {results && <button onClick={() => go(results)}>{t("library.menu.showResults")}</button>}
      {rejected !== null && <>
        {(onShowInLibrary || reveal || photo || results) && <div className="menu-sep" />}
        <button className="danger" disabled={!rejected} title={rejected ? undefined : t("library.menu.deleteHint")}
                onClick={() => { onClose(); onDelete(); }}>
          {rejected > 1 ? t("library.menu.deleteRejectedMany", { count: rejected }) : t("library.menu.deleteRejectedOne")}</button>
      </>}
    </div>
  );
}
