// Preferences' Plugins tab: the applications a photo can be handed to with
// right-click > Edit In, one card each, and adding another
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { PrefCard, PrefRow, PrefSwitch } from "./PrefsUI";
import { appName, findApps, KINDS, kindOf, newPlugin, type PluginConfig, type PluginKind } from "./plugins";

const WINDOWS = navigator.userAgent.includes("Windows");

export function PluginPrefs({ plugins, onPlugins }: {
  plugins: PluginConfig[];
  onPlugins: (list: PluginConfig[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const update = (id: string, patch: Partial<PluginConfig>) =>
    onPlugins(plugins.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const add = async (kind: PluginKind) => {
    setAdding(false);
    const [app] = await findApps(kind);
    onPlugins([...plugins, newPlugin(kind, app ?? "")]);
  };
  const chooseApp = async (id: string) => {
    const app = await open(WINDOWS ? { filters: [{ name: "Applications", extensions: ["exe"] }] }
      : { defaultPath: "/Applications", filters: [{ name: "Applications", extensions: ["app"] }] });
    if (typeof app === "string") update(id, { app });
  };
  const chooseDir = async (id: string) => {
    const dir = await open({ directory: true });
    if (typeof dir === "string") update(id, { outputDir: dir });
  };

  return (
    <>
      <p className="prefs-lead">
        Applications a photo can be sent to with right-click › Edit In, for what Immage does not do itself.
        The file each one saves comes back beside its photo, ready to edit.
      </p>
      {plugins.map((p) => {
        const kind = kindOf(p.kind)!;
        return (
          <PrefCard key={p.id} title={kind.label}>
            <PrefRow label="Name" hint="as the Edit In menu shows it">
              <input className="field" value={p.name} spellCheck={false}
                     onChange={(e) => update(p.id, { name: e.target.value })}
                     onBlur={() => { if (!p.name.trim()) update(p.id, { name: kind.label }); }} />
            </PrefRow>
            <PrefRow label="Application" hint={p.app ? p.app : `${kind.label} was not found on this computer`}>
              <div className="pref-inline">
                <span className="pref-value">{p.app ? appName(p.app) : "none"}</span>
                <button className="btn small" onClick={() => void chooseApp(p.id)}>Choose…</button>
              </div>
            </PrefRow>
            {kind.send === "choice" && (
              <PrefRow label="Send" hint="TIFFs carry the edit so far; originals suit applications that read raws">
                <div className="segmented small">
                  {([["Originals", "original"], ["16-bit TIFFs", "tiff"]] as const).map(([label, v]) => (
                    <button key={v} className={p.send === v ? "active" : ""} onClick={() => update(p.id, { send: v })}>{label}</button>
                  ))}
                </div>
              </PrefRow>
            )}
            <PrefRow label="Results folder"
                     hint={`where ${appName(p.app || kind.label)} saves, if not ${kind.returns.subfolders
                       .map((s) => (s ? `a "${s}" folder beside the photo` : "beside the photo")).join(" or ")}`}>
              <div className="pref-inline">
                <input className="field" placeholder="the usual place" value={p.outputDir} spellCheck={false}
                       onChange={(e) => update(p.id, { outputDir: e.target.value })} />
                <button className="btn small" onClick={() => void chooseDir(p.id)}>Choose…</button>
              </div>
            </PrefRow>
            {kind.onReturn.map((o) => (
              <PrefRow key={o.id} label={o.label} hint={`on a returned file, the first time it opens: ${o.hint}`}>
                <PrefSwitch checked={!!p.onReturn[o.id]}
                            onChange={(on) => update(p.id, { onReturn: { ...p.onReturn, [o.id]: on } })} />
              </PrefRow>
            ))}
            <PrefRow label="" hint={kind.note}>
              <button className="btn small danger" onClick={() => onPlugins(plugins.filter((q) => q.id !== p.id))}>
                Remove</button>
            </PrefRow>
          </PrefCard>
        );
      })}
      {!plugins.length && <p className="prefs-lead">No plugins yet.</p>}
      <div className="plugin-add">
        <button className="btn small" onClick={() => setAdding(!adding)}>Add Plugin {adding ? "▴" : "▾"}</button>
        {adding && (
          <div className="context-menu plugin-kinds">
            {KINDS.map((k) => <button key={k.id} onClick={() => void add(k)}>{k.label}</button>)}
          </div>
        )}
      </div>
    </>
  );
}
