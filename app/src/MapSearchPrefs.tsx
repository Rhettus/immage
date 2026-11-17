// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { useEffect, useState } from "react";
import { commands } from "./commands";
import { openUrl } from "@tauri-apps/plugin-opener";
import { PrefCard, PrefRow } from "./PrefsUI";
import { t } from "./i18n";

export function MapSearchPrefs() {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refresh() {
    try {
      setHasKey(await commands.mapSearchKeyStatus());
      setError("");
    } catch (e) {
      setHasKey(null);
      setError(t("mapkey.read", { error: String(e) }));
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function save() {
    if (!key.trim()) return;
    setBusy(true);
    setError("");
    try {
      await commands.mapSearchKeySave(key.trim());
      setKey("");
      await refresh();
    } catch (e) {
      setError(t("mapkey.save", { error: String(e) }));
    } finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true);
    setError("");
    try {
      await commands.mapSearchKeyRemove();
      setKey("");
      await refresh();
    } catch (e) {
      setError(t("mapkey.remove", { error: String(e) }));
    } finally { setBusy(false); }
  }

  return <PrefCard title={t("mapkey.card")}>
    <PrefRow id="Place search" label={t("mapkey.row")} summary={hasKey === null ? (error ? t("mapkey.unavailable") : t("mapkey.checking")) : hasKey ? t("mapkey.saved") : t("mapkey.none")}
             hint={t("mapkey.hint")}>
      <div className="pref-inline">
        <input className="field" type="password" autoComplete="new-password" aria-label={t("mapkey.apikey")}
               placeholder={t("mapkey.apikey")} value={key} onChange={(e) => setKey(e.target.value)} />
        <button className="btn" disabled={busy || !key.trim()} onClick={() => void save()}>{hasKey ? t("immich.key.replace") : t("mapkey.btn.save")}</button>
        {hasKey && <button className="btn" disabled={busy} onClick={() => void remove()}>{t("mapkey.btn.remove")}</button>}
      </div>
    </PrefRow>
    <div className="prefs-legal">
      <p>{t("mapkey.stored")} <button className="btn small" onClick={() => void openUrl("https://www.geoapify.com/")}>{t("mapkey.get")}</button></p>
      {error && <p role="alert" style={{ color: "var(--error, #ef7777)" }}>{error}</p>}
    </div>
  </PrefCard>;
}
