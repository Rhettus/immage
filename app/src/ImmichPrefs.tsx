// the Immich connection in Preferences: what the importer checks duplicates
// against, and where exports can go. the key is kept in the system's key
// store by the importer's backend and never comes back to the page. like the rest of
// Preferences it applies as it is changed: saved a moment after each edit,
// and when the dialog closes
import { useEffect, useRef, useState } from "react";
import { api, type ImmichSettings, type ImmichTestResult } from "@immporter/api";
import { EMPTY, insecureRemote, suggestPrefix } from "@immporter/immich-form";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { importerPathMap, storedPathMap, storePathMap, type PathMap } from "./immich";
import { PrefCard, PrefRow, PrefSwitch } from "./PrefsUI";

// where the importer's backend keeps the key on each system (the keyring
// crate's stores): named as the system names it
const KEY_STORE = /Mac/.test(navigator.userAgent) ? "the macOS Keychain"
  : /Windows/.test(navigator.userAgent) ? "the Windows Credential Manager"
  : "the system keyring (Secret Service)";

export function ImmichPrefs() {
  const [form, setForm] = useState<ImmichSettings>(EMPTY);
  const [hasKey, setHasKey] = useState(false);
  const [permission, setPermission] = useState("asset.read");
  const [apiKey, setApiKey] = useState("");
  const [replacingKey, setReplacingKey] = useState(false);
  const [test, setTest] = useState<ImmichTestResult | null>(null);
  const [busy, setBusy] = useState<"" | "testing">("");
  const [message, setMessage] = useState<string | null>(null);
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
      setHasKey(hasKey);
      setPermission(requiredPermission);
    }).catch((e) => setMessage(String(e)));
    // the path a photo would have in Immich, from the importer's templates
    api.getSettings().then((s) => api.examplePath(s?.folderTpl ?? "{YYYY}/{MMMM}", s?.nameTpl ?? "{original}", null))
      .then((e) => setExampleRel(e.path.replace(/\\/g, "/"))).catch(() => {});
  }, []);

  const keyInput = !hasKey || replacingKey;
  const keyToSend = keyInput && apiKey.trim() ? apiKey.trim() : null;

  const persist = async (p: { form: ImmichSettings; key: string | null }) => {
    pending.current = null;
    try {
      await api.saveImmichSettings(p.form, p.key);
      if (p.key) setHasKey(true);
      setMessage("saved");
      // an importer already loaded checks the connection again
      void import("@immporter/embed").then((m) => m.reloadImmich());
    } catch (e) {
      setMessage(`not saved: ${e}`);
    }
  };
  const schedule = (form: ImmichSettings, key: string | null) => {
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
    setMessage(null);
    schedule(next, keyToSend);
  };
  const updateKey = (key: string) => {
    // the field stays open while it is typed in, saved or not
    setReplacingKey(true);
    setApiKey(key);
    setMessage(null);
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
      const t = await api.testImmich(form, keyToSend);
      setTest(t);
      if (t.ok) {
        const [ex, br] = await Promise.all([invoke<string[]>("immich_export_check").catch(() => null),
                                            invoke<string[]>("immich_browse_check").catch(() => null)]);
        setExportMissing(ex);
        setBrowseMissing(br);
      }
    } finally {
      setBusy("");
    }
  };
  const testLine = !test ? "check the server and the key"
    : !test.ok ? <span className="warn">could not connect: {test.error ?? "unknown error"}</span>
    : <>
        <span className={test.hasAssetRead ? "good" : "warn"}>
          Immich {test.version ?? ""}{test.keyName ? `, key "${test.keyName}"` : ""}
          {test.hasAssetRead ? "" : `: the key lacks ${permission}`}
        </span>
        {exportMissing && exportMissing.length > 0 && (
          <span className="warn"> exporting needs {exportMissing.join(", ")}</span>
        )}
        {browseMissing && browseMissing.length > 0 && (
          <span className="warn"> searching from the Library panel needs {browseMissing.join(", ")}</span>
        )}
      </>;
  const forget = async () => {
    await api.forgetImmichKey();
    setHasKey(false);
    setReplacingKey(false);
    setMessage(`key removed from ${KEY_STORE}`);
  };

  return (
    <>
      <p className="prefs-lead">
        Immage checks new photos against your Immich library while importing, can export to its albums, and
        searches it from the Library panel.
      </p>
      <PrefCard title="Server">
        <PrefRow label="Use Immich" hint="look photos up on the server during an import">
          <PrefSwitch checked={form.enabled} onChange={(v) => update({ enabled: v })} />
        </PrefRow>
        <PrefRow label="Server URL"
                 hint={insecureRemote(form.url) ? <span className="warn">plain http sends the key unencrypted</span> : undefined}>
          <input className="field" placeholder="https://photos.example.com" value={form.url} spellCheck={false}
                 onChange={(e) => update({ url: e.target.value })} />
        </PrefRow>
        <PrefRow label="API key" hint={`kept in ${KEY_STORE}; needs ${permission}`}>
          {keyInput ? (
            <input className="field" type="password" placeholder="paste the key from Immich" value={apiKey}
                   onChange={(e) => updateKey(e.target.value)} />
          ) : (
            <div className="pref-inline">
              <span className="pill ok">stored</span>
              <button className="btn small" onClick={() => setReplacingKey(true)}>Replace</button>
              <button className="btn small" onClick={() => void forget()}>Forget</button>
            </div>
          )}
        </PrefRow>
        <PrefRow label="Self-signed certificate" hint="accept a server certificate no authority signed">
          <PrefSwitch checked={form.acceptInvalidCerts} onChange={(v) => update({ acceptInvalidCerts: v })} />
        </PrefRow>
        <PrefRow label="Connection" hint={testLine}>
          <button className="btn small" disabled={!!busy || !form.url.trim()} onClick={() => void runTest()}>
            {busy === "testing" ? "Testing…" : "Test"}</button>
        </PrefRow>
      </PrefCard>
      <PrefCard title="Duplicates">
        <PrefRow label="Match the folder path" hint="a photo only counts as in Immich at the path the import gives it">
          <PrefSwitch checked={form.matchPath} onChange={(v) => update({ matchPath: v })} />
        </PrefRow>
        {form.matchPath && (
          <PrefRow label="Path prefix"
                   hint={exampleRel ? <>expected as <code>{prefix || "…"}/{exampleRel}</code></> : "where the library sits inside Immich"}>
            <div className="pref-inline">
              <input className="field" placeholder="/mnt/photos" value={form.pathPrefix} spellCheck={false}
                     onChange={(e) => update({ pathPrefix: e.target.value })} />
              {suggestion && suggestion !== prefix && (
                <button className="btn small" onClick={() => update({ pathPrefix: suggestion })}
                        title="taken from a photo on the server">Use {suggestion}</button>
              )}
            </div>
          </PrefRow>
        )}
      </PrefCard>
      <PrefCard title="Opening photos">
        <PrefRow label="Path in Immich" hint="where an external library's folder sits on the server">
          <input className="field" placeholder={mapDefault.immich || "/mnt/photos"} value={map.immich ?? ""} spellCheck={false}
                 onChange={(e) => updateMap({ immich: e.target.value })} />
        </PrefRow>
        <PrefRow label="On this computer"
                 hint="the same folder here: a search result found in it opens directly, anything else is downloaded first">
          <div className="pref-inline">
            <input className="field" placeholder={mapDefault.local || "/Volumes/photos"} value={map.local ?? ""} spellCheck={false}
                   onChange={(e) => updateMap({ local: e.target.value })} />
            <button className="btn small" onClick={async () => {
              const dir = await open({ directory: true });
              if (typeof dir === "string") updateMap({ local: dir });
            }}>Choose…</button>
          </div>
        </PrefRow>
      </PrefCard>
      {message && <div className={`prefs-status${message.startsWith("not saved") ? " warn" : ""}`}>{message}</div>}
    </>
  );
}
