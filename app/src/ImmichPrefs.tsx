// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the Immich connection in Preferences: what the importer checks duplicates
// against, and where exports can go. the key is kept in the system's key
// store by the importer's backend and never comes back to the page. like the rest of
// Preferences it applies as it is changed: saved a moment after each edit,
// and when the dialog closes
import { useEffect, useRef, useState } from "react";
import { api, type ImmichSettings, type ImmichTestResult } from "@immporter/api";
import { EMPTY, insecureRemote, serverChanged, suggestPrefix } from "@immporter/immich-form";
import { commands } from "./commands";
import { open } from "@tauri-apps/plugin-dialog";
import { importerPathMap, storedPathMap, storePathMap, type PathMap } from "./immich";
import { PrefCard, PrefRow, PrefSwitch } from "./PrefsUI";
import { t } from "./i18n";

// where the importer's backend keeps the key on each system (the keyring
// crate's stores): named as the system names it
const KEY_STORE = /Mac/.test(navigator.userAgent) ? t("immich.store.mac")
  : /Windows/.test(navigator.userAgent) ? t("immich.store.windows")
  : t("immich.store.other");

export function ImmichPrefs() {
  const [form, setForm] = useState<ImmichSettings>(EMPTY);
  const [hasKey, setHasKey] = useState(false);
  // the URL the saved key belongs to
  const [savedUrl, setSavedUrl] = useState("");
  const [savedCerts, setSavedCerts] = useState(false);
  const [permission, setPermission] = useState("asset.read");
  const [apiKey, setApiKey] = useState("");
  const [replacingKey, setReplacingKey] = useState(false);
  const [test, setTest] = useState<ImmichTestResult | null>(null);
  const [busy, setBusy] = useState<"" | "testing">("");
  const [message, setMessage] = useState<string | null>(null);
  const [messageWarn, setMessageWarn] = useState(false);
  const say = (text: string | null, warn = false) => { setMessage(text); setMessageWarn(warn); };
  const [exampleRel, setExampleRel] = useState("");
  // where the server's paths are here, for opening search results; blank
  // fields fall back to the importer's (shown as placeholders)
  const [map, setMap] = useState<Partial<PathMap>>(storedPathMap);
  const [mapDefault, setMapDefault] = useState<PathMap>({ immich: "", local: "" });
  useEffect(() => { void importerPathMap().then(setMapDefault); }, []);
  const updateMap = (patch: Partial<PathMap>) => {
    const next = { ...map, ...patch };
    setMap(next);
    storePathMap(next);
  };
  // edits not yet saved, for the save on close
  const pending = useRef<{ form: ImmichSettings; key: string | null } | null>(null);
  const timer = useRef(0);

  useEffect(() => {
    api.getImmichSettings().then(({ hasKey, requiredPermission, ...s }) => {
      setForm(s);
      setSavedUrl(s.url);
      setSavedCerts(s.acceptInvalidCerts);
      setHasKey(hasKey);
      setPermission(requiredPermission);
    }).catch((e) => setMessage(String(e)));
    // the path a photo would have in Immich, from the importer's templates
    api.getSettings().then((s) => api.examplePath(s?.folderTpl ?? "{YYYY}/{MMMM}", s?.nameTpl ?? "{original}", null))
      .then((e) => setExampleRel(e.path.replace(/\\/g, "/"))).catch(() => {});
  }, []);

  const newServer = hasKey && serverChanged(savedUrl, form.url);
  const newCerts = hasKey && form.acceptInvalidCerts !== savedCerts;
  const keyRequired = newServer || newCerts;
  const keyInput = !hasKey || replacingKey || keyRequired;
  const keyToSend = keyInput && apiKey.trim() ? apiKey.trim() : null;

  const persist = async (p: { form: ImmichSettings; key: string | null }) => {
    pending.current = null;
    try {
      await api.saveImmichSettings(p.form, p.key);
      if (p.key) setHasKey(true);
      setSavedUrl(p.form.url);
      if (p.key) setSavedCerts(p.form.acceptInvalidCerts);
      say(t("immich.saved"));
      // an importer already loaded checks the connection again
      void import("@immporter/embed").then((m) => m.reloadImmich());
    } catch (e) {
      say(t("immich.notsaved", { error: String(e) }), true);
    }
  };
  const schedule = (form: ImmichSettings, key: string | null) => {
    // the saved key is not sent to a new server: wait for the key of that one
    const moved = serverChanged(savedUrl, form.url);
    if (!key && hasKey && (moved || form.acceptInvalidCerts !== savedCerts)) {
      pending.current = null;
      window.clearTimeout(timer.current);
      say(moved ? t("immich.needkey.server") : t("immich.needkey.certs"));
      return;
    }
    pending.current = { form, key };
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { if (pending.current) void persist(pending.current); }, 700);
  };
  // closing Preferences saves what is still waiting
  useEffect(() => () => {
    window.clearTimeout(timer.current);
    if (pending.current) void persist(pending.current);
  }, []);
  const update = (patch: Partial<ImmichSettings>) => {
    const next = { ...form, ...patch };
    setForm(next);
    say(null);
    schedule(next, keyToSend);
  };
  const updateKey = (key: string) => {
    // the field stays open while it is typed in, saved or not
    setReplacingKey(true);
    setApiKey(key);
    say(null);
    schedule(form, key.trim() || null);
  };
  const prefix = form.pathPrefix.trim().replace(/\/+$/, "");
  const suggestion = test?.samplePath && exampleRel ? suggestPrefix(test.samplePath, exampleRel) : null;

  // a test also checks what exporting needs, which reads the saved
  // settings: anything waiting is saved first
  const [exportMissing, setExportMissing] = useState<string[] | null>(null);
  const [browseMissing, setBrowseMissing] = useState<string[] | null>(null);
  const runTest = async () => {
    setBusy("testing");
    setTest(null);
    setExportMissing(null);
    setBrowseMissing(null);
    try {
      window.clearTimeout(timer.current);
      if (pending.current) await persist(pending.current);
      const res = await api.testImmich(form, keyToSend);
      setTest(res);
      if (res.ok) {
        const [ex, br] = await Promise.all([commands.immichExportCheck().catch(() => null),
                                            commands.immichBrowseCheck().catch(() => null)]);
        setExportMissing(ex);
        setBrowseMissing(br);
      }
    } finally {
      setBusy("");
    }
  };
  const testLine = !test ? t("immich.test.idle")
    : !test.ok ? <span className="warn">{t("immich.test.failed", { error: test.error ?? t("immich.test.unknown") })}</span>
    : <>
        <span className={test.hasAssetRead ? "good" : "warn"}>
          {t("immich.test.version", { version: test.version ?? "" })}{test.keyName ? t("immich.test.key", { name: test.keyName }) : ""}
          {test.hasAssetRead ? "" : t("immich.test.nopermission", { permission })}
        </span>
        {exportMissing && exportMissing.length > 0 && (
          <span className="warn"> {t("immich.test.export", { list: exportMissing.join(", ") })}</span>
        )}
        {browseMissing && browseMissing.length > 0 && (
          <span className="warn"> {t("immich.test.browse", { list: browseMissing.join(", ") })}</span>
        )}
      </>;
  const forget = async () => {
    await api.forgetImmichKey();
    setHasKey(false);
    setReplacingKey(false);
    say(t("immich.keyremoved", { store: KEY_STORE }));
  };

  return (
    <>
      <p className="prefs-lead">{t("immich.lead")}</p>
      <PrefCard title={t("immich.card.server")}>
        <PrefRow id="Use Immich" label={t("immich.row.use")} hint={t("immich.row.use.hint")}>
          <PrefSwitch checked={form.enabled} onChange={(v) => update({ enabled: v })} />
        </PrefRow>
        <PrefRow id="Server URL" label={t("immich.row.url")}
                 hint={insecureRemote(form.url) ? <span className="warn">{t("immich.row.url.hint")}</span> : undefined}>
          <input className="field" placeholder="https://photos.example.com" value={form.url} spellCheck={false}
                 onChange={(e) => update({ url: e.target.value })} />
        </PrefRow>
        <PrefRow id="API key" label={t("immich.row.key")} hint={t("immich.row.key.hint", { store: KEY_STORE, permission })}>
          {keyInput ? (
            <input className="field" type="password" placeholder={keyRequired ? t("immich.key.again") : t("immich.key.paste")} value={apiKey}
                   onChange={(e) => updateKey(e.target.value)} />
          ) : (
            <div className="pref-inline">
              <span className="pill ok">{t("immich.key.stored")}</span>
              <button className="btn small" onClick={() => setReplacingKey(true)}>{t("immich.key.replace")}</button>
              <button className="btn small" onClick={() => void forget()}>{t("immich.key.forget")}</button>
            </div>
          )}
        </PrefRow>
        <PrefRow id="Self-signed certificate" label={t("immich.row.certs")} hint={t("immich.row.certs.hint")}>
          <PrefSwitch checked={form.acceptInvalidCerts} onChange={(v) => update({ acceptInvalidCerts: v })} />
        </PrefRow>
        <PrefRow id="Connection" label={t("immich.row.connection")} hint={testLine}>
          <button className="btn small" disabled={!!busy || !form.url.trim() || (keyRequired && !keyToSend)} onClick={() => void runTest()}>
            {busy === "testing" ? t("immich.test.testing") : t("immich.test.run")}</button>
        </PrefRow>
      </PrefCard>
      <PrefCard title={t("immich.card.duplicates")}>
        <PrefRow id="Match the folder path" label={t("immich.row.matchpath")} hint={t("immich.row.matchpath.hint")}>
          <PrefSwitch checked={form.matchPath} onChange={(v) => update({ matchPath: v })} />
        </PrefRow>
        {form.matchPath && (
          <PrefRow id="Path prefix" label={t("immich.row.prefix")}
                   hint={exampleRel ? <>{t("immich.row.prefix.expected")} <code>{prefix || "…"}/{exampleRel}</code></> : t("immich.row.prefix.hint")}>
            <div className="pref-inline">
              <input className="field" placeholder="/mnt/photos" value={form.pathPrefix} spellCheck={false}
                     onChange={(e) => update({ pathPrefix: e.target.value })} />
              {suggestion && suggestion !== prefix && (
                <button className="btn small" onClick={() => update({ pathPrefix: suggestion })}
                        title={t("immich.use.title")}>{t("immich.use", { path: suggestion })}</button>
              )}
            </div>
          </PrefRow>
        )}
      </PrefCard>
      <PrefCard title={t("immich.card.opening")}>
        <PrefRow id="Path in Immich" label={t("immich.row.path")} hint={t("immich.row.path.hint")}>
          <input className="field" placeholder={mapDefault.immich || "/mnt/photos"} value={map.immich ?? ""} spellCheck={false}
                 onChange={(e) => updateMap({ immich: e.target.value })} />
        </PrefRow>
        <PrefRow id="On this computer" label={t("immich.row.local")}
                 summary={t("immich.row.local.summary")}
                 hint={t("immich.row.local.hint")}>
          <div className="pref-inline">
            <input className="field" placeholder={mapDefault.local || "/Volumes/photos"} value={map.local ?? ""} spellCheck={false}
                   onChange={(e) => updateMap({ local: e.target.value })} />
            <button className="btn small" onClick={async () => {
              const dir = await open({ directory: true });
              if (typeof dir === "string") updateMap({ local: dir });
            }}>{t("prefs.choose")}</button>
          </div>
        </PrefRow>
      </PrefCard>
      {message && <div className={`prefs-status${messageWarn ? " warn" : ""}`}>{message}</div>}
    </>
  );
}
