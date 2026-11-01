// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { ImageEntry } from "./library";

type Location = NonNullable<ImageEntry["location"]>;
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
  const [dark, setDark] = useState(true);
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const marker = useRef<L.Marker | null>(null);
  const choose = useRef((location: Location) => setDraft(`${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}`));
  const parts = draft.trim().split(/[\s,;]+/);
  const latitude = Number(parts[0]), longitude = Number(parts[1]);
  const valid = parts.length === 2 && parts.every((part) => /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(part))
    && Number.isFinite(latitude) && Number.isFinite(longitude)
    && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;

  useEffect(() => {
    let stale = false;
    invoke<{ image: ImageEntry }>("meta", { imgid: image.imgid }).then(({ image: entry }) => {
      if (stale) return;
      const location = entry.location ?? null;
      setSaved(location);
      setDraft(location ? `${location.latitude}, ${location.longitude}` : "");
      setLoaded(true);
    }).catch((e) => { if (!stale) setError(String(e)); });
    return () => { stale = true; };
  }, [image.imgid]);

  useEffect(() => {
    if (!showMap || !host.current) return;
    let active = true;
    const view = L.map(host.current, { attributionControl: false, scrollWheelZoom: false });
    map.current = view;
    view.setView(valid ? [latitude, longitude] : [20, 0], valid ? 13 : 2);
    // Only request visible tiles: no background prefetch or offline downloads.
    const Tiles = L.GridLayer.extend({
      createTile(coords: L.Coords, done: L.DoneCallback) {
        const tile = document.createElement("img");
        tile.alt = "";
        invoke<ArrayBuffer>("map_tile", { z: coords.z, x: coords.x, y: coords.y }).then((bytes) => {
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
    const observer = new ResizeObserver(() => view.invalidateSize());
    observer.observe(host.current);
    return () => { active = false; observer.disconnect(); view.remove(); map.current = null; marker.current = null; };
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

  const save = async (location: Location | null) => {
    setBusy(true); setError("");
    try {
      await invoke("meta_set", { imgid: image.imgid, fields: { location } });
      setSaved(location); setDraft(location ? `${location.latitude}, ${location.longitude}` : "");
      onSaved(location);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const disabled = !loaded || busy || !!image.remote;
  return <section className="location-editor">
    <div className="location-heading">Location</div>
    <label htmlFor={`coordinates-${image.imgid}`}>Latitude, longitude</label>
    <input id={`coordinates-${image.imgid}`} className="field" value={draft} disabled={disabled}
      placeholder="37.7749, -122.4194" onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter" && valid && !disabled) void save({ latitude, longitude }); }} />
    {draft && !valid && <p className="location-error">Enter latitude (−90 to 90), then longitude (−180 to 180).</p>}
    <div className="location-actions">
      <button className="btn" disabled={disabled || !valid} onClick={() => void save({ latitude, longitude })}>{busy ? "Saving…" : "Apply"}</button>
      <button className="btn" disabled={disabled || !saved} onClick={() => void save(null)}>Remove location</button>
      <button className="btn" disabled={disabled} onClick={() => setShowMap(!showMap)}>{showMap ? "Hide map" : "Show map"}</button>
    </div>
    {showMap && <>
      <div className="location-map-tools"><span>Click or drag the pin, then Apply</span>
        <label><input type="checkbox" checked={dark} onChange={(e) => setDark(e.target.checked)} /> Dark</label></div>
      <div ref={host} className={`location-map${dark ? " dark" : ""}`} />
      <div className="location-attribution">© <button onClick={() => void openUrl(osmCopyright)}>OpenStreetMap contributors</button></div>
    </>}
    {image.remote && <p>Open a local photo to edit its location.</p>}
    {error && <p className="location-error" role="alert">{error}</p>}
  </section>;
}
