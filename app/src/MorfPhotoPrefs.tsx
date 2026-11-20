// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { commands } from "./commands";
import { PrefCard, PrefRow, PrefSwitch } from "./PrefsUI";
import { t } from "./i18n";
import { MorfPhotoMetrics } from "./MorfPhotoMetrics";

type Status = Awaited<ReturnType<typeof commands.morfPhotoStatus>>;
type Settings = Required<Status["settings"]>;

function formSettings({ enabled = false, url = "", serverPath = "", localPath = "" }: Status["settings"]): Settings {
  return { enabled, url, serverPath, localPath };
}

function origin(url: string) {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) && !parsed.username && !parsed.password
      && !parsed.search && !parsed.hash ? parsed.origin : "";
  } catch {
    return "";
  }
}

export function MorfPhotoPrefs() {
  const [saved, setSaved] = useState<Status | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [key, setKey] = useState("");
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | "forget" | "choose" | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    let mounted = true;
    void commands.morfPhotoStatus().then(status => {
      if (!mounted) return;
      setSaved(status);
      setForm(formSettings(status.settings));
    }, () => {
      if (mounted) setMessage({ text: t("morfphoto.loadFailed"), error: true });
    });
    return () => { mounted = false; };
  }, []);

  if (!form || !saved) {
    return <p className={message?.error ? "warn" : "pref-hint"} role="status">
      {message?.text ?? t("morfphoto.loading")}
    </p>;
  }

  const settings = {
    ...form,
    url: form.url.trim(),
    serverPath: form.serverPath.trim(),
    localPath: form.localPath.trim(),
  };
  const serverOrigin = origin(settings.url);
  const savedSettings = formSettings(saved.settings);
  const storedForOrigin = saved.hasKey && !!serverOrigin && serverOrigin === origin(savedSettings.url);
  const ready = !!(serverOrigin && settings.serverPath && settings.localPath && (storedForOrigin || key.trim()));
  const changed = Object.keys(settings).some(field => {
    const name = field as keyof Settings;
    return settings[name] !== savedSettings[name];
  }) || !!key.trim();

  function update(patch: Partial<Settings>) {
    setForm(current => current && ({ ...current, ...patch }));
    setMessage(null);
  }

  function updateUrl(url: string) {
    if (serverOrigin && origin(url.trim()) !== serverOrigin) {
      setKey("");
      setReplace(false);
    }
    update({ url });
  }

  async function run(action: NonNullable<typeof busy>) {
    setBusy(action);
    setMessage(null);
    try {
      if (action === "choose") {
        const directory = await open({ directory: true });
        if (typeof directory === "string") update({ localPath: directory });
        return;
      }
      if (action === "test") {
        await commands.morfPhotoTest(settings, key.trim() || null);
        setMessage({ text: t("morfphoto.testPassed") });
        return;
      }
      if (action === "save") await commands.morfPhotoSave(settings, key.trim() || null);
      else await commands.morfPhotoForget();
      const status = await commands.morfPhotoStatus();
      setSaved(status);
      const nextSettings = formSettings(status.settings);
      if (action === "save") setForm(nextSettings);
      else setForm(current => current && ({ ...current, enabled: nextSettings.enabled }));
      setKey("");
      setReplace(false);
      setMessage({ text: t(action === "save" ? "morfphoto.saved" : "morfphoto.forgotten") });
    } catch {
      setMessage({
        text: t(action === "test" ? "morfphoto.testFailed" : action === "choose" ? "morfphoto.chooseFailed"
          : action === "forget" ? "morfphoto.forgetFailed" : "morfphoto.saveFailed"),
        error: true,
      });
    } finally {
      setBusy(null);
    }
  }

  return <>
    <p className="prefs-lead">{t("morfphoto.lead")}</p>
    <p className="pref-hint">{t("morfphoto.credit")}</p>
    <PrefCard title={t("morfphoto.server")}>
      <PrefRow id="Use morfPhoto" label={t("morfphoto.enable")}>
        <PrefSwitch checked={form.enabled} onChange={enabled => update({ enabled })} disabled={!!busy}
                    aria-label={t("morfphoto.enable")} />
      </PrefRow>
      <PrefRow label={t("immich.row.url")} hint={/^http:\/\//i.test(settings.url)
        ? <span className="warn">{t("immich.row.url.hint")}</span> : undefined}>
        <input className="field" type="url" aria-label={t("immich.row.url")} disabled={!!busy}
               value={form.url} spellCheck={false} onChange={event => updateUrl(event.target.value)} />
      </PrefRow>
      <PrefRow label={t("immich.row.key")} hint={t("morfphoto.keyHint")}>
        <div className="pref-inline">
          {storedForOrigin && !replace
            ? <><span className="pill ok">{t("immich.key.stored")}</span>
                <button className="btn small" disabled={!!busy} onClick={() => setReplace(true)}>{t("immich.key.replace")}</button></>
            : <input className="field" type="password" autoComplete="new-password" aria-label={t("immich.row.key")}
                     disabled={!!busy} value={key} onChange={event => { setKey(event.target.value); setMessage(null); }} />}
          {saved.hasStoredKey && <button className="btn small" disabled={!!busy} onClick={() => void run("forget")}>
            {t("immich.key.forget")}
          </button>}
        </div>
      </PrefRow>
    </PrefCard>
    <PrefCard title={t("morfphoto.mapping")}>
      <PrefRow label={t("morfphoto.serverPath")} hint={t("morfphoto.serverPathHint")}>
        <input className="field" aria-label={t("morfphoto.serverPath")} disabled={!!busy} spellCheck={false}
               value={form.serverPath} onChange={event => update({ serverPath: event.target.value })} />
      </PrefRow>
      <PrefRow label={t("immich.row.local")} hint={t("morfphoto.localPathHint")}>
        <div className="pref-inline">
          <input className="field" aria-label={t("immich.row.local")} disabled={!!busy} spellCheck={false}
                 value={form.localPath} onChange={event => update({ localPath: event.target.value })} />
          <button className="btn small" disabled={!!busy} onClick={() => void run("choose")}>{t("prefs.choose")}</button>
        </div>
      </PrefRow>
      <PrefRow label={t("immich.row.connection")}>
        <div className="pref-inline">
          <button className="btn" disabled={!!busy || !ready} onClick={() => void run("test")}>
            {busy === "test" ? t("immich.test.testing") : t("immich.test.run")}
          </button>
          <button className="btn" disabled={!!busy || !changed || (settings.enabled && !ready) || (!!key.trim() && !serverOrigin)} onClick={() => void run("save")}>
            {busy === "save" ? t("morfphoto.saving") : t("morfphoto.save")}
          </button>
        </div>
      </PrefRow>
    </PrefCard>
    {saved.settings.enabled && <MorfPhotoMetrics key={saved.settings.url} />}
    {message && <div role="status" className={`prefs-status${message.error ? " warn" : ""}`}>{message.text}</div>}
  </>;
}
