// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { ImageEntry } from "./library";
import { commands } from "./commands";

type Location = NonNullable<ImageEntry["location"]>;
type Place = { label: string; latitude: number; longitude: number; bounds?: [number, number, number, number] };
const osmCopyright = "https://www.openstreetmap.org/copyright";
const pin = L.divIcon({ className: "location-pin", html: "<span></span>", iconSize: [20, 20], iconAnchor: [10, 10] });

export function LocationEditor({ image, onSaved }: {
  image: ImageEntry; onSaved: (location: Location | null) => void;
}) {
  const [saved, setSaved] = useState<Location | null>(null);
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showMap, setShowMap] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [dark, setDark] = useState(true);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [places, setPlaces] = useState<Place[]>([]);
  const [mapBounds, setMapBounds] = useState<React.CSSProperties>({});
  const host = useRef<HTMLDivElement>(null);
  const mapRegion = useRef<HTMLDivElement>(null);
  const inlineSlot = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const marker = useRef<L.Marker | null>(null);
  const placeRequest = useRef(0);
  const expandButton = useRef<HTMLButtonElement>(null);
  const collapseButton = useRef<HTMLButtonElement>(null);
  const focusAfterCollapse = useRef(false);
  const [portalRoot] = useState(() => document.createElement("div"));
  const choose = useRef((location: Location) => setDraft(`${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}`));
  const parts = draft.trim().split(/[\s,;]+/);
  const latitude = Number(parts[0]), longitude = Number(parts[1]);
  const valid = parts.length === 2 && parts.every((part) => /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(part))
    && Number.isFinite(latitude) && Number.isFinite(longitude)
    && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;

  useEffect(() => {
    portalRoot.className = "location-map-portal";
    return () => { portalRoot.remove(); };
  }, [portalRoot]);

  useEffect(() => {
    let stale = false;
    setLoaded(false);
    setSaved(null);
    setDraft("");
    setError("");
    commands.meta(image.imgid).then(({ image: entry }) => {
      if (stale) return;
      const location = entry.location ?? null;
      setSaved(location);
      setDraft(location ? `${location.latitude}, ${location.longitude}` : "");
      setLoaded(true);
    }).catch((e) => { if (!stale) setError(String(e)); });
    return () => { stale = true; placeRequest.current++; };
  }, [image.imgid]);

  const updateBounds = useCallback(() => {
    if (!expanded) { setMapBounds({}); requestAnimationFrame(() => map.current?.invalidateSize()); return; }
    const rect = document.querySelector<HTMLElement>('[data-tour="viewer"]')?.getBoundingClientRect();
    if (!rect) return;
    setMapBounds({
      position: "fixed", left: rect.left, top: rect.top, width: rect.width, height: rect.height,
      zIndex: 35,
    });
    requestAnimationFrame(() => map.current?.invalidateSize());
  }, [expanded]);

  useLayoutEffect(() => {
    const parent = expanded ? document.body : inlineSlot.current;
    if (showMap && parent && portalRoot.parentElement !== parent) parent.appendChild(portalRoot);
    if (!showMap) portalRoot.remove();
    updateBounds();
  }, [expanded, showMap, portalRoot, updateBounds]);

  useEffect(() => {
    if (!showMap) return;
    updateBounds();
    const observer = new ResizeObserver(updateBounds);
    const watched = expanded ? document.querySelector<HTMLElement>('[data-tour="viewer"]') : mapRegion.current;
    if (watched) observer.observe(watched);
    window.addEventListener("resize", updateBounds);
    window.addEventListener("scroll", updateBounds, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateBounds);
      window.removeEventListener("scroll", updateBounds, true);
    };
  }, [showMap, expanded, updateBounds]);

  useEffect(() => {
    if (!showMap || !host.current) return;
    let active = true;
    const view = L.map(host.current, { attributionControl: false, scrollWheelZoom: true, keyboard: false });
    map.current = view;
    view.setView(valid ? [latitude, longitude] : [20, 0], valid ? 13 : 2);
    const Tiles = L.GridLayer.extend({
      createTile(coords: L.Coords, done: L.DoneCallback) {
        const tile = document.createElement("img");
        tile.alt = "";
        commands.mapTile(coords.z, coords.x, coords.y).then((bytes) => {
          if (!active) return;
          const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
          tile.onload = () => { URL.revokeObjectURL(url); done(undefined, tile); };
          tile.onerror = () => { URL.revokeObjectURL(url); done(new Error("map tile unavailable"), tile); };
          tile.src = url;
        }).catch(() => { if (!active) return; done(new Error("map tile unavailable"), tile); setError("Map unavailable. Coordinate editing still works offline."); });
        return tile;
      },
    });
    const tiles = new Tiles() as L.GridLayer;
    L.setOptions(tiles, { maxZoom: 19, keepBuffer: 0, updateWhenIdle: true });
    tiles.addTo(view);
    view.on("click", (event: L.LeafletMouseEvent) => choose.current({ latitude: event.latlng.lat, longitude: event.latlng.wrap().lng }));
    return () => { active = false; view.remove(); map.current = null; marker.current = null; };
  }, [showMap]);

  useEffect(() => {
    const view = map.current;
    if (!view) return;
    if (!valid) { marker.current?.remove(); marker.current = null; return; }
    const point: L.LatLngTuple = [latitude, longitude];
    if (marker.current) marker.current.setLatLng(point);
    else {
      marker.current = L.marker(point, { icon: pin, draggable: true }).addTo(view);
      marker.current.on("dragend", () => {
        const p = marker.current!.getLatLng().wrap();
        choose.current({ latitude: p.lat, longitude: p.lng });
      });
    }
    if (!view.getBounds().contains(point)) view.panTo(point);
  }, [showMap, valid, latitude, longitude]);

  useEffect(() => {
    if (focusAfterCollapse.current && !expanded) {
      focusAfterCollapse.current = false;
      collapseButton.current?.focus();
    }
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    const key = (event: KeyboardEvent) => {
      if (document.querySelector(".modal-backdrop")) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); focusAfterCollapse.current = true; setExpanded(false); }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [expanded]);

  const save = async (location: Location | null) => {
    setBusy(true); setError("");
    try {
      await commands.metaSet(image.imgid, { location });
      setSaved(location); setDraft(location ? `${location.latitude}, ${location.longitude}` : "");
      onSaved(location);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const search = async () => {
    const term = query.trim();
    if (!term || searching) return;
    const request = ++placeRequest.current;
    setSearching(true); setError("");
    try {
      const results = await invoke<Place[]>("map_search", { query: term });
      if (request !== placeRequest.current) return;
      setPlaces(results);
      if (!results.length) setError("No places found.");
    } catch (e) {
      if (request !== placeRequest.current) return;
      const message = String(e);
      setError(/(?:missing|required|add).*(?:geoapify|api.?key)|(?:geoapify|api.?key).*(?:missing|required|settings)/i.test(message)
        ? "Place search needs a Geoapify API key. Add it in Preferences → General."
        : `Place search failed: ${message}`);
    } finally { if (request === placeRequest.current) setSearching(false); }
  };

  const disabled = !loaded || busy || !!image.remote;
  const mapUi = showMap && createPortal(<div ref={mapRegion} className={`location-map-region${expanded ? " expanded" : ""}${dark ? " dark" : ""}`} style={mapBounds}
    onWheel={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
    <div className="location-map-toolbar">
      <span>Click or drag the pin, then Apply</span>
      <form className="location-search" onSubmit={(event) => { event.preventDefault(); void search(); }}>
        <input aria-label="Search places" value={query} onChange={(event) => { placeRequest.current++; setSearching(false); setPlaces([]); setQuery(event.target.value); }} placeholder="Search places" />
        <button className="btn" type="submit" disabled={!query.trim() || searching}>{searching ? "Searching…" : "Find places"}</button>
      </form>
      <label><input type="checkbox" checked={dark} onChange={(event) => setDark(event.target.checked)} /> Dark</label>
      {!expanded && <button className="btn" disabled={disabled || !valid} onClick={() => void save({ latitude, longitude })}>{busy ? "Saving…" : "Apply"}</button>}
      <button ref={collapseButton} className="btn" aria-label={expanded ? "Collapse map" : "Expand map"}
        onClick={() => { focusAfterCollapse.current = false; setExpanded(!expanded); }}>{expanded ? "Collapse" : "Expand"}</button>
    </div>
    {places.length > 0 && <div className="location-search-results" role="group" aria-label="Place search results">
      {places.map((place, index) => <button className="location-search-result" key={`${place.label}-${index}`}
        onClick={() => {
          if (place.bounds) map.current?.fitBounds([[place.bounds[0], place.bounds[1]], [place.bounds[2], place.bounds[3]]], { maxZoom: 14 });
          else map.current?.setView([place.latitude, place.longitude], 13);
          setPlaces([]);
        }}>{place.label}</button>)}
    </div>}
    {expanded && error && <p className="location-map-error" role="alert">{error}</p>}
    {expanded && <div className="location-map-overlay-actions">
      <label htmlFor={`map-coordinates-${image.imgid}`}>Latitude, longitude</label>
      <input id={`map-coordinates-${image.imgid}`} className="field" value={draft} disabled={disabled}
        placeholder="37.7749, -122.4194" onChange={(event) => setDraft(event.target.value)} />
      <button className="btn" disabled={disabled || !valid} onClick={() => void save({ latitude, longitude })}>{busy ? "Saving…" : "Apply"}</button>
      <button className="btn" disabled={disabled || !saved} onClick={() => void save(null)}>Remove location</button>
    </div>}
    <div ref={host} className="location-map" data-map-zoom={map.current?.getZoom() ?? ""}
      aria-label="Location map" />
    <div className="location-attribution">© <button onClick={() => void openUrl(osmCopyright)}>OpenStreetMap contributors</button>
      <span> · Search by <button onClick={() => void openUrl("https://www.geoapify.com/")}>Geoapify</button></span></div>
  </div>, portalRoot);

  useEffect(() => {
    const node = host.current;
    const view = map.current;
    if (!node || !view) return;
    const updateZoom = () => node.setAttribute("data-map-zoom", String(view.getZoom()));
    view.on("zoomend", updateZoom);
    updateZoom();
    return () => { view.off("zoomend", updateZoom); };
  }, [showMap]);

  return <section className="location-editor">
    <div className="location-heading">Location</div>
    <label htmlFor={`coordinates-${image.imgid}`}>Latitude, longitude</label>
    <input id={`coordinates-${image.imgid}`} className="field" value={draft} disabled={disabled}
      placeholder="37.7749, -122.4194" onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Enter" && valid && !disabled) void save({ latitude, longitude }); }} />
    {draft && !valid && <p className="location-error">Enter latitude (−90 to 90), then longitude (−180 to 180).</p>}
    <div className="location-actions">
      <button className="btn" disabled={disabled || !valid} onClick={() => void save({ latitude, longitude })}>{busy ? "Saving…" : "Apply"}</button>
      <button className="btn" disabled={disabled || !saved} onClick={() => void save(null)}>Remove location</button>
      <button ref={expandButton} className="btn" aria-label={showMap ? "Hide map" : "Show map"} disabled={disabled}
        onClick={() => { setShowMap(!showMap); setExpanded(false); }}>{showMap ? "Hide map" : "Show map"}</button>
    </div>
    {showMap && <div ref={inlineSlot} className="location-map-inline-slot" />}
    {mapUi}
    {image.remote && <p>Open a local photo to edit its location.</p>}
    {error && <p className="location-error" role="alert">{error}</p>}
  </section>;
}
