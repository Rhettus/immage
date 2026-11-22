// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Preferences' Plugins tab: the applications a photo can be handed to with
// right-click > Edit In, one card each, and adding another
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { PrefCard, PrefRow, PrefSwitch } from "./PrefsUI";
import { t } from "./i18n";
import { appName, choosePluginApp, findApps, KINDS, kindOf, newPlugin, setPluginApp, storePlugins,
         type PluginConfig, type PluginKind } from "./plugins";

export function PluginPrefs({ plugins, onPlugins }: {
  plugins: PluginConfig[];
  onPlugins: (list: PluginConfig[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [findingApp, setFindingApp] = useState(false);
  const integrations = KINDS.filter((kind) => kind.handoff === "photocraft" || kind.handoff === "helicon");
  const addable = KINDS.filter((kind) => kind.handoff === "files" || kind.handoff === "macrostudio");
  const update = (id: string, patch: Partial<PluginConfig>) =>
    onPlugins(plugins.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const add = async (kind: PluginKind) => {
    setAdding(false);
    setFindingApp(true);
    const plugin = newPlugin(kind, "");
    try {
      const [app] = await findApps(kind);
      const saved = await storePlugins([...plugins, plugin]);
      if (saved) onPlugins((app && await setPluginApp(plugin.id, app)) || saved);
    } finally {
      setFindingApp(false);
    }
  };
  const chooseApp = async (id: string) => {
    const set = await choosePluginApp(id);
    if (set) onPlugins(set);
  };
  const chooseDir = async (id: string) => {
    const dir = await open({ directory: true });
    if (typeof dir === "string") update(id, { outputDir: dir });
  };

  return (
    <div inert={findingApp}>
      <p className="prefs-lead">{t("plugins.lead")}</p>
      {integrations.length > 0 && (
        <PrefCard title={t("plugins.editIn")}>
          {integrations.map((kind) => (
            <PrefRow key={kind.id} id={kind.label} label={t(`plugins.kind.${kind.id}`)} hint={t(`plugins.kind.${kind.id}.note`)}>
              <PrefSwitch checked={plugins.some((p) => p.kind === kind.id)} aria-label={t(`plugins.kind.${kind.id}`)}
                          onChange={(enabled) => {
                if (enabled) void add(kind);
                else onPlugins(plugins.filter((p) => p.kind !== kind.id));
              }} />
            </PrefRow>
          ))}
        </PrefCard>
      )}
      {plugins.map((p) => {
        const kind = kindOf(p.kind)!;
        const kindLabel = t(`plugins.kind.${kind.id}`);
        const integrated = kind.handoff === "helicon" || kind.handoff === "photocraft";
        return (
          <PrefCard key={p.id} title={kindLabel}>
            {!integrated && <PrefRow id="Name" label={t("plugins.row.name")} hint={t("plugins.row.name.hint")}>
              <input className="field" value={p.name} spellCheck={false}
                     onChange={(e) => update(p.id, { name: e.target.value })}
                     onBlur={() => { if (!p.name.trim()) update(p.id, { name: kind.label }); }} />
            </PrefRow>}
            <PrefRow id="Application" label={t("plugins.row.app")} hint={p.app ? p.app : t("plugins.notfound", { name: kindLabel })}>
              <div className="pref-inline">
                <span className="pref-value">{p.app ? appName(p.app) : t("plugins.none")}</span>
                <button className="btn small" onClick={() => void chooseApp(p.id)}>{t("prefs.choose")}</button>
              </div>
            </PrefRow>
            {kind.send === "choice" && (
              <PrefRow id="Send" label={t("plugins.row.send")} summary={kind.rawOriginals
                ? t("plugins.send.raw.summary")
                : t("plugins.send.orig.summary")}
                hint={kind.rawOriginals
                ? t("plugins.send.raw.hint")
                : t("plugins.send.orig.hint")}>
                <div className="segmented small">
                  {([[kind.rawOriginals ? t("plugins.send.raws") : t("plugins.send.originals"), "original"], [t("plugins.send.tiff"), "tiff"]] as const).map(([label, v]) => (
                    <button key={v} className={p.send === v ? "active" : ""} onClick={() => update(p.id, { send: v })}>{label}</button>
                  ))}
                </div>
              </PrefRow>
            )}
            {kind.handoff === "macrostudio" && (
              <PrefRow id="Look" label={t("plugins.row.look")} summary={t("plugins.row.look.summary")}
                       hint={t("plugins.row.look.hint")}>
                <div className="segmented small">
                  {([[t("plugins.look.natural"), "natural"], [t("plugins.look.enhanced"), "enhanced"], [t("plugins.look.default"), ""]] as const).map(([label, v]) => (
                    <button key={v} className={(p.look ?? "") === v ? "active" : ""} onClick={() => update(p.id, { look: v })}>{label}</button>
                  ))}
                </div>
              </PrefRow>
            )}
            {kind.handoff === "files" && <PrefRow id="Results folder" label={t("plugins.row.results")} summary={t("plugins.row.results.summary")}
                     hint={t("plugins.results.hint", { app: appName(p.app || kind.label), list: kind.returns.subfolders
                       .map((s) => (s ? t("plugins.results.sub", { name: s }) : t("plugins.results.beside"))).join(t("plugins.results.or")) })}>
              <div className="pref-inline">
                <input className="field" placeholder={t("plugins.usual")} value={p.outputDir} spellCheck={false}
                       onChange={(e) => update(p.id, { outputDir: e.target.value })} />
                <button className="btn small" onClick={() => void chooseDir(p.id)}>{t("prefs.choose")}</button>
              </div>
            </PrefRow>}
            {kind.onReturn.map((o) => (
              <PrefRow key={o.id} label={t(`plugins.kind.${kind.id}.return.${o.id}.label`)}
                       summary={t("plugins.onreturn.summary", { hint: t(`plugins.kind.${kind.id}.return.${o.id}.hint`) })}
                       hint={t("plugins.onreturn.hint", { hint: t(`plugins.kind.${kind.id}.return.${o.id}.hint`) })}>
                <PrefSwitch checked={!!p.onReturn[o.id]}
                            onChange={(on) => update(p.id, { onReturn: { ...p.onReturn, [o.id]: on } })} />
              </PrefRow>
            ))}
            {!integrated && <PrefRow label="" summary={t(kind.handoff === "files" ? "plugins.pureraw" : "plugins.bracket")}
              hint={t(`plugins.kind.${kind.id}.note`)}>
              <button className="btn small danger" onClick={() => onPlugins(plugins.filter((q) => q.id !== p.id))}>
                {t("plugins.remove")}</button>
            </PrefRow>}
          </PrefCard>
        );
      })}
      {!plugins.length && <p className="prefs-lead">{t("plugins.empty")}</p>}
      <div className="plugin-add">
        <button className="btn small" onClick={() => setAdding(!adding)}>{t("plugins.add")} {adding ? "▴" : "▾"}</button>
        {adding && (
          <div className="context-menu plugin-kinds">
            {addable.map((k) => <button key={k.id} onClick={() => void add(k)}>{t(`plugins.kind.${k.id}`)}</button>)}
          </div>
        )}
      </div>
    </div>
  );
}
