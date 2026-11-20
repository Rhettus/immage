// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the grid's Find panel, in the right-hand column: the words to search for and
// where to look, then every filter as a row that opens its editor right beneath
// it (an accordion, one open at a time, in one scroll region), and a footer with
// the count and the saved filters. Every change applies at once (the state is
// findModel.ts's; App.tsx runs it). The rows are FindFilters.tsx's, the editors
// FindEditors.tsx's
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { commands, type Named } from "./commands";
import {
  chips, clearAll, clearCategory, GROUPS, reach, searchIn, serverPickers, visibleCategories, withSearchIn,
  type CategoryKey, type FindState, type SearchIn,
} from "./findModel";
import type { ImageEntry } from "./library";
import { AnalysisStatus } from "./AnalysisStatus";
import { ResetIcon } from "./icons";
import type { ImmichSearch } from "./immich";
import { formatNumber, t } from "./i18n";
import { FilterEditor } from "./FindEditors";
import { categoryTitle, editorId, FilterGroup, FilterRow, GROUP_TITLE, rowId, summarize } from "./FindFilters";

export function FindPanel({ state, onChange, images, immichAvailable, count, busy, notes, saved, savedLine,
                            onSaveNew, focusToken, pin, smart, clipTip }: {
  state: FindState;
  // `now`: run at once (ticks, selects, Enter); otherwise App runs it after 400 ms (typing)
  onChange: (next: FindState, now?: boolean) => void;
  images: ImageEntry[];         // photos to list facets from (folder, or local results)
  immichAvailable: boolean;     // Immich configured
  smart: boolean;               // photo-content search can run (CLIP model or Immich); else file names only
  count: number | null;         // live result count, null while unknown
  busy: boolean;                // a search is running
  notes: string[];              // extra notes from App (e.g. Immich skipped)
  saved?: React.ReactNode;      // the Load filter menu button, footer
  savedLine?: React.ReactNode;  // the saved-filter name line, in the search header
  onSaveNew?: () => void;       // footer Save filter…
  clipTip?: { onSetUp: () => void; onDismiss: () => void };   // the tip about the CLIP model; none to hide it
  pin?: React.ReactNode;        // the right panel's pin button (auto-hide), in the title row
  focusToken?: number;          // a change focuses the search box (the toolbar's Find button)
}) {
  const pop = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  // the filter whose editor is open; values do not depend on it
  const [expanded, setExpanded] = useState<CategoryKey | null>(null);
  const { search: s, filter: f } = state;
  const r = reach(s, immichAvailable);
  const server = serverPickers(s, immichAvailable);
  const cats = visibleCategories(s, immichAvailable);
  // one no longer shown (the source changed) counts as closed
  const openKey = cats.some((c) => c.key === expanded) ? expanded : null;
  const active = chips(state, immichAvailable);

  // the clicked row stays where it is on screen, whatever closes above it, then the
  // new editor is scrolled into view by the least that shows it, the row never
  // pushed out of the top
  const pinned = useRef<{ key: CategoryKey; top: number } | null>(null);
  const toggle = (key: CategoryKey) => {
    const row = document.getElementById(rowId(key));
    pinned.current = row ? { key, top: row.getBoundingClientRect().top } : null;
    setExpanded(openKey === key ? null : key);
  };
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  const openRef = useRef(openKey);
  openRef.current = openKey;
  useLayoutEffect(() => {
    const a = pinned.current;
    pinned.current = null;
    const box = scroll.current, row = a && document.getElementById(rowId(a.key));
    if (!a || !box || !row) return;
    box.scrollTop += row.getBoundingClientRect().top - a.top;
    const ed = document.getElementById(editorId(a.key));
    if (!ed) return;
    const b = box.getBoundingClientRect();
    const over = ed.getBoundingClientRect().bottom + 10 - b.bottom;
    const room = Math.max(0, row.getBoundingClientRect().top - b.top);
    if (over > 0 && room > 0) {
      const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      box.scrollBy({ top: Math.min(over, room), behavior: calm ? "auto" : "smooth" });
    }
  }, [openKey]);

  // Escape closes an open editor first, except from the search box, and only
  // while the user is in the panel: otherwise it leaves the grid, as it does elsewhere
  const touched = useRef(false);
  useEffect(() => {
    // a click does not focus a button in macOS's web view, so the last press says
    // whether a key with nothing focused is the panel's
    const touch = (e: PointerEvent) => { touched.current = !!pop.current?.contains(e.target as Node); };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector(".select-menu, .context-menu, .modal-backdrop")) return;
      const open = openRef.current;
      const from = e.target as Node;
      const ours = pop.current?.contains(from) || (from === document.body && touched.current);
      if (open && from !== text.current && ours) {
        e.preventDefault();
        e.stopImmediatePropagation();
        toggleRef.current(open);
        document.getElementById(rowId(open))?.focus();
      }
    };
    window.addEventListener("keydown", esc, true);
    window.addEventListener("pointerdown", touch, true);
    return () => {
      window.removeEventListener("pointerdown", touch, true);
      window.removeEventListener("keydown", esc, true);
    };
  }, []);

  useEffect(() => {
    if (!focusToken) return;
    text.current?.focus();
    text.current?.select();
  }, [focusToken]);

  // the server's names and libraries, once Immich is in the search; a key
  // without the permission for one just leaves it empty
  const [people, setPeople] = useState<Named[]>([]);
  const [tags, setTags] = useState<Named[]>([]);
  const [albums, setAlbums] = useState<Named[]>([]);
  const [libraries, setLibraries] = useState<Named[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!r.immich) return;
    commands.immichPeople().then(setPeople).catch(() => {});
    commands.immichTags().then(setTags).catch(() => {});
    commands.immichAlbums().then(setAlbums).catch(() => {});
    setError(null);
    commands.immichLibraries().then(setLibraries).catch((e) => setError(String(e)));
  }, [r.immich]);
  // what the key cannot do here: thumbnails and downloads take permissions
  // beyond the importer's asset.read; asked again after each search, so a
  // key fixed in Immich meanwhile clears it
  const [lacks, setLacks] = useState<string[]>([]);
  useEffect(() => {
    if (r.immich && !busy) commands.immichBrowseCheck().then(setLacks).catch(() => {});
  }, [r.immich, busy]);

  const send = (next: FindState, now = true) => onChange(next, now);
  const patchSearch = (p: Partial<ImmichSearch>) => send({ ...state, search: { ...s, ...p } });
  const names = { people, tags, albums };

  const notice = [
    ...(lacks.length > 0 && r.immich ? [t("library.search.missingPermissions", {
      permissions: lacks.join(", "),
      details: [lacks.includes("asset.view") ? t("library.search.thumbnailsPermission") : "",
        lacks.includes("asset.download") ? t("library.search.downloadPermission") : ""].filter(Boolean).join(", "),
      pronoun: lacks.length > 1 ? t("library.search.them") : t("library.search.it"),
    })] : []),
    ...(error && r.immich ? [error] : []),
    ...notes,
  ];

  const where = searchIn(s);
  // without Smart search the segmented control shows Filename; the stored mode is left alone
  const modeShown = smart ? s.mode : "filename";
  const countText = <>
    <span className="find-count-text">{count === null ? "…" : t("library.find.count", { n: count, count: formatNumber(count) })}</span>
    {busy && <span className="find-spin" role="status" aria-label={t("library.find.searching")} />}
  </>;
  return (
    <div className="find-pop" ref={pop} role="search" aria-label={t("library.find.title")}>
      <div className="panel-head"><h1>{t("library.find.title")}</h1>
        <div className="head-tools">
          {pin}
          <button type="button" className="tool find-clear" disabled={!active.length && !s.text} onClick={() => send(clearAll(state))}
                  aria-label={t("library.find.clearAll")} title={t("library.find.clearAll")}><ResetIcon /></button>
        </div></div>
      <div className="find-head">
        <div className="find-row">
          <input className="field find-text" type="search" spellCheck={false} ref={text} value={s.text}
                 aria-label={t("library.search.title")}
                 placeholder={smart ? t("library.search.example") : t("library.search.filenameExample")}
                 onChange={(e) => send({ ...state, search: { ...s, text: e.target.value } }, false)}
                 onKeyDown={(e) => {
                   if (e.key === "Enter") send(state, true);
                   // Escape only leaves the box: the next one leaves the grid, as it does elsewhere
                   else if (e.key === "Escape") e.currentTarget.blur();
                 }} />
          <AnalysisStatus />
        </div>
        {clipTip && (
          <div className="find-tip" role="note">
            <span className="find-tip-text">{t("library.find.clipTip")}</span>
            <button className="btn small find-tip-setup" onClick={clipTip.onSetUp}>{t("library.find.clipTipSetUp")}</button>
            <button className="find-tip-close" aria-label={t("library.find.clipTipDismiss")} title={t("library.find.clipTipDismiss")}
                    onClick={clipTip.onDismiss}>×</button>
          </div>
        )}
        <div className="find-row find-modewhere">
          <div className="segmented small" role="group" aria-label={t("library.search.matchAgainst")} title={t("library.search.matchAgainst")}>
            <button className={modeShown === "smart" ? "active" : ""} aria-pressed={modeShown === "smart"}
                    aria-disabled={smart ? undefined : "true"} title={smart ? t("library.search.photoContent") : t("library.search.smartUnavailable")}
                    onClick={() => { if (smart) send({ ...state, search: { ...s, mode: "smart" } }, s.text.trim() !== ""); }}>{t("library.search.smart")}</button>
            <button className={modeShown === "filename" ? "active" : ""} aria-pressed={modeShown === "filename"}
                    onClick={() => send({ ...state, search: { ...s, mode: "filename" } }, s.text.trim() !== "")}>{t("library.search.filename")}</button>
          </div>
          <div className="find-where">
            <span className="find-where-label">{t("library.find.searchIn")}</span>
            <select className="field" aria-label={t("library.find.searchIn")} value={where}
                    onChange={(e) => send({ ...state, search: withSearchIn(s, e.target.value as SearchIn) })}>
              <option value="folder">{t("library.find.thisFolder")}</option>
              <option value="library">{t("library.find.allFolders")}</option>
              {immichAvailable && <><option value="immich">Immich</option><option value="both">{t("library.find.both")}</option></>}
            </select>
          </div>
        </div>
        {r.immich && (
          <div className="find-row find-where">
            <span className="find-where-label">{t("library.search.immichLibrary")}</span>
            <select className="field" value={s.library} title={t("library.search.immichLibrary")}
                    aria-label={t("library.search.immichLibrary")} onChange={(e) => patchSearch({ library: e.target.value })}>
              <option value="external">{t("library.search.externalLibraries")}</option>
              <option value="all">{t("library.search.allPhotos")}</option>
              {libraries.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
        )}
        {savedLine}
      </div>
      <div className="find-filters-head">
        <h2>{t("library.find.filters")}</h2>
        <span className="find-active" aria-live="polite">{active.length ? t("library.find.activeCount", { n: active.length, count: formatNumber(active.length) }) : ""}</span>
      </div>
      <div className="find-scroll" ref={scroll}>
        {GROUPS.map((g) => {
          const rows = cats.filter((c) => c.group === g);
          return rows.length ? (
            <FilterGroup key={g} title={GROUP_TITLE[g]()}>
              {rows.map((c) => {
                const title = categoryTitle(c.key);
                return (
                  <FilterRow key={c.key} cat={c.key} title={title} summary={summarize(c.key, state, server, names)} open={openKey === c.key}
                             tag={c.only === "immich" && r.local && r.immich ? t("library.find.group.immich") : undefined}
                             excludes={active.find((a) => a.key === c.key)?.excludes}
                             onToggle={() => toggle(c.key)} onClear={() => send(clearCategory(state, c.key))}>
                    <FilterEditor cat={c.key} state={state} send={send} images={images} local={r.local} server={server} {...names} />
                  </FilterRow>
                );
              })}
            </FilterGroup>
          ) : null;
        })}
      </div>
      {notice.length > 0 && <div className="find-notes">{notice.map((n, i) => <div key={i} className="find-note">{n}</div>)}</div>}
      <div className="find-foot">
        <span className="find-count" aria-live="polite">{countText}</span>
        {saved}
        {onSaveNew && <button className="btn small find-save" onClick={onSaveNew}>{t("library.find.saveFilter")}</button>}
      </div>
    </div>
  );
}
