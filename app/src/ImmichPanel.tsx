// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the Library panel's Immich card, under Folders: a search of the server
// whose results fill the filmstrip and grid. it starts on the external
// libraries, the photos that live on disk where darktable can edit them;
// the toolbar's Filters popup narrows the search by what Immich offers
// (FilterPopup.tsx), and the stars by rating
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Chevron, Collapse } from "./Collapse";
import type { ImmichSearch } from "./immich";

type Named = { id: string; name: string };

export function ImmichPanel({ open, onToggle, active, searching, form, onChange, onSearch, onMenu }: {
  open: boolean; onToggle: (alt: boolean) => void;
  active: boolean;                        // the filmstrip shows this card's results
  searching: boolean;
  form: ImmichSearch;                     // shared with the Filters popup
  // `now` searches at once; otherwise a moment later, while the results show
  onChange: (patch: Partial<ImmichSearch>, now?: boolean) => void;
  onSearch: () => void;
  onMenu: (e: React.MouseEvent) => void;
}) {
  const [libraries, setLibraries] = useState<Named[]>([]);
  const [error, setError] = useState<string | null>(null);
  // what the key cannot do here: thumbnails and downloads take permissions
  // beyond the importer's asset.read
  const [lacks, setLacks] = useState<string[]>([]);
  // asked again after each search, so a key fixed in Immich meanwhile clears it
  useEffect(() => {
    if (open && !searching) invoke<string[]>("immich_browse_check").then(setLacks).catch(() => {});
  }, [open, searching]);

  // the server's libraries, once the card is open
  useEffect(() => {
    if (!open) return;
    invoke<Named[]>("immich_libraries").then(setLibraries).catch((e) => setError(String(e)));
  }, [open]);

  const run = () => {
    setError(null);
    onSearch();
  };

  return (
    <div className="panel immich-panel" data-tour="immich" onContextMenu={(e) => { if (active) onMenu(e); }}>
      <div className={`panel-title${open ? " open" : ""}`} onClick={(e) => onToggle(e.altKey)}>
        <span>Immich</span>
        <Chevron open={open} />
      </div>
      <Collapse open={open}>
        <div className="immich-body">
          <select className="field" value={form.library} title="which of Immich's photos to search"
                  onChange={(e) => onChange({ library: e.target.value }, true)}>
            <option value="external">External libraries</option>
            <option value="all">All photos</option>
            {libraries.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <div className="immich-search">
            <input className="field" type="search" spellCheck={false} value={form.text}
                   placeholder={form.mode === "smart" ? "search, e.g. beach at sunset" : "file name or description"}
                   onChange={(e) => onChange({ text: e.target.value })}
                   onKeyDown={(e) => { if (e.key === "Enter") run(); }} />
            <button className="btn small" disabled={searching} onClick={run}>
              {searching ? "…" : "Search"}</button>
          </div>
          <div className="segmented small" title="what the words are matched against">
            <button className={form.mode === "smart" ? "active" : ""}
                    title="what is in the photo, by Immich's machine learning"
                    onClick={() => onChange({ mode: "smart" }, form.text.trim() !== "")}>Smart</button>
            <button className={form.mode === "filename" ? "active" : ""}
                    onClick={() => onChange({ mode: "filename" }, form.text.trim() !== "")}>Filename</button>
          </div>
          {lacks.length > 0 && (
            <div className="note">
              the API key lacks {lacks.join(", ")}
              {lacks.includes("asset.view") ? ": thumbnails need asset.view" : ""}
              {lacks.includes("asset.download") ? `${lacks.includes("asset.view") ? "," : ":"} downloading originals needs asset.download` : ""}.
              Add {lacks.length > 1 ? "them" : "it"} to the key in Immich.
            </div>
          )}
          {error && <div className="note">{error}</div>}
        </div>
      </Collapse>
    </div>
  );
}
