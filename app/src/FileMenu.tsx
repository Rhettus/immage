// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { FILE_MANAGER } from "./ExportDialog";
import { type ImageEntry, fileKind } from "./library";
import { type PluginConfig } from "./plugins";
import { isRemote } from "./immich";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { parentDir } from "./paths";
import { useEffect, useRef } from "react";

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

// a photo's right-click menu: Edit In, Show in Finder, as Lightroom's, and
// Delete, for rejected photos only; for Immich results, the photo or the
// whole search in Immich's web app. any click elsewhere, a scroll or Escape
// closes it
export function FileMenu({ captureCount, onCaptureTime, canUndoCapture, onUndoCapture, x, y, copyable, copies, mergeable, stitchable, reveal, rejected, photo, results, parentFolder, onImportParent, editIn, onCopy,
                    onRemoveCopies, onMergeHdr, onMergePano, onDelete, onEditIn, onSetUpPlugins, onClose }: {
  captureCount: number; onCaptureTime: () => void;
  canUndoCapture: boolean; onUndoCapture: () => void;
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
  editIn: { cfg: PluginConfig; why: string | null }[] | null;  // the plugins, and why one cannot take the photos
  onEditIn: (cfg: PluginConfig) => void; onSetUpPlugins: () => void;
  onCopy: () => void; onRemoveCopies: () => void; onMergeHdr: () => void; onMergePano: () => void;
  onDelete: () => void; onClose: () => void;
}) {
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
  const go = (url: string) => { onClose(); void openUrl(url); };
  // kept inside the window
  const left = Math.min(x, window.innerWidth - 230), top = Math.min(y, window.innerHeight - 180);
  // the Edit In list opens to the left when there is no room on the right
  const flip = left + 230 + 230 > window.innerWidth;
  return (
    <div ref={ref} className={`context-menu${flip ? " flip" : ""}`} style={{ left, top }}>
      {editIn && <>
        <div className="has-sub">
          <button>Edit In</button>
          <div className="context-menu submenu">
            {editIn.map(({ cfg, why }) => (
              <button key={cfg.id} disabled={!!why} title={why ?? undefined}
                      onClick={() => { onClose(); onEditIn(cfg); }}>{cfg.name}</button>
            ))}
            {editIn.length > 0 && <div className="menu-sep" />}
            <button onClick={() => { onClose(); onSetUpPlugins(); }}>
              {editIn.length ? "Plugins…" : "Set Up Plugins…"}</button>
          </div>
        </div>
        <div className="menu-sep" />
      </>}
      {captureCount > 0 && <button onClick={() => { onClose(); onCaptureTime(); }}>Adjust Capture Time…</button>}
      {canUndoCapture && <button onClick={() => { onClose(); onUndoCapture(); }}>Undo Capture Time Adjustment…</button>}
      {copyable > 0 && <>
        <button onClick={() => { onClose(); onCopy(); }}>
          {copyable > 1 ? `Create ${copyable} Virtual Copies` : "Create Virtual Copy"}</button>
        {copies > 0 && <button onClick={() => { onClose(); onRemoveCopies(); }}>
          {copies > 1 ? `Remove ${copies} Virtual Copies` : "Remove Virtual Copy"}</button>}
        {(reveal || photo || results || rejected !== null) && <div className="menu-sep" />}
      </>}
      {(mergeable > 1 || stitchable > 1) && <>
        {mergeable > 1 && <button onClick={() => { onClose(); onMergeHdr(); }}>HDR Merge…</button>}
        {stitchable > 1 && <button onClick={() => { onClose(); onMergePano(); }}>Panorama Merge…</button>}
        <div className="menu-sep" />
      </>}
      {reveal && <button onClick={() => { onClose(); void revealItemInDir(reveal); }}>Show in {FILE_MANAGER}</button>}
      {parentFolder !== undefined && <button disabled={!parentFolder}
        title={parentFolder ? parentDir(parentFolder) : "Set up Opening photos in Preferences > Immich so this file is available on this computer"}
        onClick={() => { onClose(); if (parentFolder) onImportParent(parentFolder); }}>Import Parent Folder</button>}
      {photo && <button onClick={() => go(photo)}>Show in Immich</button>}
      {results && <button onClick={() => go(results)}>Show Results in Immich</button>}
      {rejected !== null && <>
        {(reveal || photo || results) && <div className="menu-sep" />}
        <button className="danger" disabled={!rejected} title={rejected ? undefined : "only rejected photos (X) can be deleted"}
                onClick={() => { onClose(); onDelete(); }}>
          {rejected > 1 ? `Delete ${rejected} Rejected Photos…` : "Delete Rejected Photo…"}</button>
      </>}
    </div>
  );
}
