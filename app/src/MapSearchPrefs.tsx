// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { PrefCard, PrefRow } from "./PrefsUI";

export function MapSearchPrefs() {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refresh() {
    try {
      setHasKey(await invoke<boolean>("map_search_key_status"));
      setError("");
    } catch (e) {
      setHasKey(null);
      setError(`Could not read the saved search key: ${String(e)}`);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function save() {
    if (!key.trim()) return;
    setBusy(true);
    setError("");
    try {
      await invoke("map_search_key_save", { key: key.trim() });
      setKey("");
      await refresh();
    } catch (e) {
      setError(`Could not save the search key: ${String(e)}`);
    } finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true);
    setError("");
    try {
      await invoke("map_search_key_remove");
      setKey("");
      await refresh();
    } catch (e) {
      setError(`Could not remove the saved search key: ${String(e)}`);
    } finally { setBusy(false); }
  }

  return <PrefCard title="Map search">
    <PrefRow label="Place search" summary={hasKey === null ? (error ? "Keyring unavailable." : "Checking saved key…") : hasKey ? "Geoapify key saved." : "No search key saved."}
             hint="Search by place name in the map's location picker. Search results move the map; they do not set photo coordinates. Map tiles and manual pin placement work without a key.">
      <div className="pref-inline">
        <input className="field" type="password" autoComplete="new-password" aria-label="Geoapify API key"
               placeholder="Geoapify API key" value={key} onChange={(e) => setKey(e.target.value)} />
        <button className="btn" disabled={busy || !key.trim()} onClick={() => void save()}>{hasKey ? "Replace" : "Save"}</button>
        {hasKey && <button className="btn" disabled={busy} onClick={() => void remove()}>Remove</button>}
      </div>
    </PrefRow>
    <div className="prefs-legal">
      <p>Stored in your system keyring; never shown after saving. <button className="btn small" onClick={() => void openUrl("https://www.geoapify.com/")}>Get a Geoapify key</button></p>
      {error && <p role="alert" style={{ color: "var(--error, #ef7777)" }}>{error}</p>}
    </div>
  </PrefCard>;
}
