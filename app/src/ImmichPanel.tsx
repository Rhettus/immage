// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the Library panel's Immich card, under Folders: a search of the server
// whose results fill the filmstrip and grid. it starts on the external
// libraries, the photos that live on disk where darktable can edit them;
// Advanced narrows by what Immich's search offers
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Chevron, Collapse } from "./Collapse";
import { loadSearch, NO_SEARCH, storeSearch, type ImmichSearch } from "./immich";

type Named = { id: string; name: string };
type Kind = "camera-make" | "camera-model" | "camera-lens-model" | "country" | "city";

const ADVANCED_KEY = "immage.immichAdvanced";

export function ImmichPanel({ open, onToggle, active, searching, onSearch, onMenu }: {
  open: boolean; onToggle: (alt: boolean) => void;
  active: boolean;                        // the filmstrip shows this card's results
  searching: boolean;
  onSearch: (s: ImmichSearch) => void;
  onMenu: (e: React.MouseEvent, s: ImmichSearch) => void;
}) {
  const [form, setForm] = useState<ImmichSearch>(loadSearch);
  const [advanced, setAdvanced] = useState(() => { try { return localStorage.getItem(ADVANCED_KEY) === "1"; } catch { return false; } });
  const [libraries, setLibraries] = useState<Named[]>([]);
  const [people, setPeople] = useState<Named[]>([]);
  const [tags, setTags] = useState<Named[]>([]);
  const [albums, setAlbums] = useState<Named[]>([]);
  const [values, setValues] = useState<Partial<Record<Kind, string[]>>>({});
  const [error, setError] = useState<string | null>(null);
  // what the key cannot do here: thumbnails and downloads take permissions
  // beyond the importer's asset.read
  const [lacks, setLacks] = useState<string[]>([]);
  // asked again after each search, so a key fixed in Immich meanwhile clears it
  useEffect(() => {
    if (open && !searching) invoke<string[]>("immich_browse_check").then(setLacks).catch(() => {});
  }, [open, searching]);

  // the server's lists, once the card is open; a key without the
  // permission for one just leaves it empty
  useEffect(() => {
    if (!open) return;
    invoke<Named[]>("immich_libraries").then(setLibraries).catch((e) => setError(String(e)));
  }, [open]);
  useEffect(() => {
    if (!open || !advanced) return;
    invoke<Named[]>("immich_people").then(setPeople).catch(() => {});
    invoke<Named[]>("immich_tags").then(setTags).catch(() => {});
    invoke<Named[]>("immich_albums").then(setAlbums).catch(() => {});
  }, [open, advanced]);
  // camera and place values, each narrowed by the field before it
  const suggest = (kind: Kind, within: Record<string, string> = {}) =>
    invoke<string[]>("immich_suggestions", { kind, within }).then((v) => setValues((o) => ({ ...o, [kind]: v })))
      .catch(() => {});
  useEffect(() => { if (open && advanced) { void suggest("camera-make"); void suggest("country"); } }, [open, advanced]);
  useEffect(() => { if (open && advanced) void suggest("camera-model", { make: form.make }); }, [open, advanced, form.make]);
  useEffect(() => {
    if (open && advanced) void suggest("camera-lens-model", { make: form.make, model: form.model });
  }, [open, advanced, form.make, form.model]);
  useEffect(() => { if (open && advanced) void suggest("city", { country: form.country }); }, [open, advanced, form.country]);

  // a filter change searches again a moment later; the words wait for Enter
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const run = (s: ImmichSearch) => {
    window.clearTimeout(timer.current);
    setError(null);
    onSearch(s);
  };
  const update = (patch: Partial<ImmichSearch>, now = false) => {
    const next = { ...form, ...patch };
    setForm(next);
    storeSearch(next);
    window.clearTimeout(timer.current);
    if (now) run(next);
    else if (active) timer.current = window.setTimeout(() => run(next), 400);
  };
  const filtering = form.takenFrom || form.takenTo || form.minRating || form.favorites || form.rawOnly || form.make
    || form.model || form.lens || form.country || form.city || form.personIds.length || form.tagIds.length
    || form.albumIds.length;

  const pick = (label: string, value: string, options: string[] | undefined, set: (v: string) => void) => (
    <>
      <span className="k">{label}</span>
      <select className="field" value={value} onChange={(e) => set(e.target.value)}>
        <option value="">Any</option>
        {/* a stored value the server no longer lists stays choosable */}
        {value && !options?.includes(value) && <option value={value}>{value}</option>}
        {options?.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </>
  );
  const chips = (label: string, ids: string[], all: Named[], set: (ids: string[]) => void) => (
    <>
      <span className="k">{label}</span>
      <div className="v">
        {ids.length > 0 && (
          <div className="kw-chips">
            {ids.map((id) => (
              <span key={id} className="kw-chip">{all.find((x) => x.id === id)?.name ?? "…"}
                <button title="remove" onClick={() => set(ids.filter((x) => x !== id))}>×</button></span>
            ))}
          </div>
        )}
        <select className="field" value="" onChange={(e) => { if (e.target.value) set([...ids, e.target.value]); }}>
          <option value="">{all.length ? "Add…" : "None"}</option>
          {all.filter((x) => !ids.includes(x.id)).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </div>
    </>
  );

  return (
    <div className="panel immich-panel" data-tour="immich" onContextMenu={(e) => { if (active) onMenu(e, form); }}>
      <div className={`panel-title${open ? " open" : ""}`} onClick={(e) => onToggle(e.altKey)}>
        <span>Immich</span>
        <Chevron open={open} />
      </div>
      <Collapse open={open}>
        <div className="immich-body">
          <select className="field" value={form.library} title="which of Immich's photos to search"
                  onChange={(e) => update({ library: e.target.value }, true)}>
            <option value="external">External libraries</option>
            <option value="all">All photos</option>
            {libraries.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <div className="immich-search">
            <input className="field" type="search" spellCheck={false} value={form.text}
                   placeholder={form.mode === "smart" ? "search, e.g. beach at sunset" : "file name or description"}
                   onChange={(e) => update({ text: e.target.value })}
                   onKeyDown={(e) => { if (e.key === "Enter") run(form); }} />
            <button className="btn small" disabled={searching} onClick={() => run(form)}>
              {searching ? "…" : "Search"}</button>
          </div>
          <div className="segmented small" title="what the words are matched against">
            <button className={form.mode === "smart" ? "active" : ""}
                    title="what is in the photo, by Immich's machine learning"
                    onClick={() => update({ mode: "smart" }, form.text.trim() !== "")}>Smart</button>
            <button className={form.mode === "filename" ? "active" : ""}
                    onClick={() => update({ mode: "filename" }, form.text.trim() !== "")}>Filename</button>
          </div>
          <div className={`immich-advanced-title${advanced ? " open" : ""}`} onClick={() => {
            const next = !advanced;
            setAdvanced(next);
            try { localStorage.setItem(ADVANCED_KEY, next ? "1" : "0"); } catch { /* not kept */ }
          }}>
            <span>Advanced{filtering ? " ·" : ""}</span>
            {filtering ? (
              <button className="link" onClick={(e) => {
                e.stopPropagation();
                update({ ...NO_SEARCH, mode: form.mode, text: form.text, library: form.library });
              }}>Clear</button>
            ) : null}
            <Chevron open={advanced} />
          </div>
          <Collapse open={advanced}>
            <div className="meta-grid immich-filters">
              <span className="k">Taken from</span>
              <input className="field" type="date" value={form.takenFrom} onChange={(e) => update({ takenFrom: e.target.value })} />
              <span className="k">to</span>
              <input className="field" type="date" value={form.takenTo} onChange={(e) => update({ takenTo: e.target.value })} />
              <span className="k">Rating</span>
              <span className="v stars-edit">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} className={form.minRating >= n ? "on" : ""} title={`${n} star${n > 1 ? "s" : ""} and up`}
                          onClick={() => update({ minRating: form.minRating === n ? 0 : n })}>★</button>
                ))}
              </span>
              <span className="k">Favorites</span>
              <input type="checkbox" className="switch" checked={form.favorites} onChange={(e) => update({ favorites: e.target.checked })} />
              <span className="k">RAW only</span>
              <input type="checkbox" className="switch" checked={form.rawOnly} onChange={(e) => update({ rawOnly: e.target.checked })} />
              <span className="gap" />
              {pick("Camera", form.make, values["camera-make"], (v) => update({ make: v, model: "", lens: "" }))}
              {pick("Model", form.model, values["camera-model"], (v) => update({ model: v, lens: "" }))}
              {pick("Lens", form.lens, values["camera-lens-model"], (v) => update({ lens: v }))}
              <span className="gap" />
              {pick("Country", form.country, values.country, (v) => update({ country: v, city: "" }))}
              {pick("City", form.city, values.city, (v) => update({ city: v }))}
              <span className="gap" />
              {chips("People", form.personIds, people, (ids) => update({ personIds: ids }))}
              {chips("Tags", form.tagIds, tags, (ids) => update({ tagIds: ids }))}
              {chips("Albums", form.albumIds, albums, (ids) => update({ albumIds: ids }))}
            </div>
          </Collapse>
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
