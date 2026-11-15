// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the Library panel's Immich card, under Folders: a search of the server
// whose results fill the filmstrip and grid. it starts on the external
// libraries, the photos that live on disk where darktable can edit them;
// the toolbar's Filters popup narrows the search by what Immich offers
// (FilterPopup.tsx), and the stars by rating
import { useEffect, useState } from "react";
import { commands, type Named } from "./commands";
import { Chevron, Collapse } from "./Collapse";
import type { ImmichSearch } from "./immich";
import { t } from "./i18n";

export function ImmichPanel({ open, onToggle, active, searching, form, onChange, onSearch, onMenu, immichAvailable = false }: {
  immichAvailable?: boolean;
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
    if (immichAvailable && form.source !== "local" && open && !searching) commands.immichBrowseCheck().then(setLacks).catch(() => {});
  }, [open, searching, immichAvailable, form.source]);

  // the server's libraries, once the card is open
  useEffect(() => {
    if (!open || !immichAvailable || form.source === "local") return;
    commands.immichLibraries().then(setLibraries).catch((e) => setError(String(e)));
  }, [open, immichAvailable, form.source]);

  const run = () => {
    setError(null);
    onSearch();
  };

  return (
    <div className="panel immich-panel" data-tour="immich" onContextMenu={(e) => { if (active) onMenu(e); }}>
      <div className={`panel-title${open ? " open" : ""}`} onClick={(e) => onToggle(e.altKey)}>
        <span>{t("library.search.title")}</span>
        <Chevron open={open} />
      </div>
      <Collapse open={open}>
        <div className="immich-body">
          <select className="field" aria-label={t("library.search.source")} value={immichAvailable ? form.source : "local"}
                  onChange={e => onChange({ source: e.target.value as ImmichSearch["source"] }, true)}>
            <option value="local">{t("library.search.local")}</option>
            {immichAvailable && <><option value="immich">Immich</option><option value="both">{t("library.search.both")}</option></>}
          </select>
          {(form.source !== "immich" || !immichAvailable) && <>
            <select className="field" aria-label={t("library.search.scope")} value={form.scope}
                    onChange={e => onChange({ scope: e.target.value as ImmichSearch["scope"] }, true)}>
              <option value="library">{t("library.search.allFolders")}</option><option value="folder">{t("library.search.currentFolder")}</option>
            </select>
            <select className="field" aria-label={t("library.search.subject")} value={form.subject}
                    onChange={e => onChange({ subject: e.target.value as ImmichSearch["subject"] }, true)}>
              <option value="original">{t("library.search.original")}</option><option value="edited">{t("library.search.edited")}</option>
            </select>
          </>}
          {immichAvailable && form.source !== "local" && <select className="field" value={form.library} title={t("library.search.immichLibrary")}
                  onChange={(e) => onChange({ library: e.target.value }, true)}>
            <option value="external">{t("library.search.externalLibraries")}</option>
            <option value="all">{t("library.search.allPhotos")}</option>
            {libraries.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>}
          <div className="immich-search">
            <input className="field" type="search" spellCheck={false} value={form.text}
                   placeholder={t("library.search.example")}
                   onChange={(e) => onChange({ text: e.target.value })}
                   onKeyDown={(e) => { if (e.key === "Enter") run(); }} />
            <button className="btn small" disabled={searching} onClick={run}>
              {searching ? "…" : t("library.search.search")}</button>
          </div>
          <div className="segmented small" title={t("library.search.matchAgainst")}>
            <button className={form.mode === "smart" ? "active" : ""}
                    title={t("library.search.photoContent")}
                    onClick={() => onChange({ mode: "smart" }, form.text.trim() !== "")}>{t("library.search.smart")}</button>
            <button className={form.mode === "filename" ? "active" : ""}
                    onClick={() => onChange({ mode: "filename" }, form.text.trim() !== "")}>{t("library.search.filename")}</button>
          </div>
          {lacks.length > 0 && (
            <div className="note">{t("library.search.missingPermissions", {
              permissions: lacks.join(", "),
              details: [lacks.includes("asset.view") ? t("library.search.thumbnailsPermission") : "",
                lacks.includes("asset.download") ? t("library.search.downloadPermission") : ""].filter(Boolean).join(", "),
              pronoun: lacks.length > 1 ? t("library.search.them") : t("library.search.it"),
            })}</div>
          )}
          {error && <div className="note">{error}</div>}
        </div>
      </Collapse>
    </div>
  );
}
