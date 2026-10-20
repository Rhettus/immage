// Edit In: what darktable does not do is handed to another application (DxO
// PureRAW now; panorama, HDR and focus stacking later), and the file it
// writes comes back to be edited, as with Lightroom's plug-ins. a kind says
// what an application takes and gives back; a plugin is one the user set up
// in Preferences, with its application and choices
import { invoke } from "@tauri-apps/api/core";
import type { Values } from "./manifest";
import { fileKind, type ImageEntry } from "./library";

export type PluginKind = {
  id: string;
  label: string;
  accepts: "raw" | "any";
  minPhotos: number;
  maxPhotos?: number;
  // what is sent: the original files, 16-bit TIFFs with the edit, or the
  // user's choice of the two (sendDefault)
  send: "original" | "tiff" | "choice";
  sendDefault: "original" | "tiff";
  // where the application is installed, as patterns with * under
  // /Applications or Program Files (plugins.rs, plugin_find_apps)
  appHints: { mac: string[]; win: string[] };
  // what it writes: "prefix" is one file per photo named from it, "any" one
  // file for the lot; looked for beside each photo, in these subfolders
  returns: { exts: string[]; match: "prefix" | "any"; subfolders: string[] };
  // settings a returned file starts with, the first time it is opened
  onReturn: { id: string; label: string; hint: string; values: Values; default: boolean }[];
  // what Preferences says about using it
  note: string;
};

export const KINDS: PluginKind[] = [
  {
    id: "dxo-pureraw",
    label: "DxO PureRAW",
    accepts: "raw",
    minPhotos: 1,
    send: "original",
    sendDefault: "original",
    appHints: { mac: ["DxO PureRAW*.app"], win: ["DxO/DxO PureRAW*/*PureRaw*.exe"] },
    // PureRAW names its DNG after the raw with a suffix of the user's
    // choosing, in a "DxO" folder beside it unless told otherwise
    returns: { exts: ["dng"], match: "prefix", subfolders: ["DxO", ""] },
    onReturn: [
      { id: "lens", label: "Turn off lens corrections", hint: "PureRAW has corrected the lens already",
        values: { lens_profile: 0, lens_ca: 0 }, default: true },
      { id: "noise", label: "Turn off noise reduction", hint: "PureRAW has removed the noise already",
        values: { nr_luminance: 0, nr_color: 0 }, default: true },
      { id: "sharpen", label: "Turn off sharpening", hint: "if PureRAW's lens sharpness was on",
        values: { sharp_amount: 0, usm_amount: 0, capture: 0 }, default: false },
    ],
    note: "set PureRAW to save DNG files. Immage waits while PureRAW works, and opens each DNG as it is saved",
  },
];

export const kindOf = (id: string) => KINDS.find((k) => k.id === id);

export type PluginConfig = {
  id: string;
  kind: string;
  name: string;
  app: string;                         // the application's path; "" until chosen
  send: "original" | "tiff";
  outputDir: string;                   // looked in too, besides the kind's folders; "" for none
  onReturn: Record<string, boolean>;
};

const PLUGINS_KEY = "immage.plugins";
export function loadPlugins(): PluginConfig[] {
  try {
    const v = JSON.parse(localStorage.getItem(PLUGINS_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((p) => p && kindOf(p.kind)) : [];
  } catch { return []; }
}
export function storePlugins(list: PluginConfig[]) {
  try { localStorage.setItem(PLUGINS_KEY, JSON.stringify(list)); } catch { /* not kept */ }
}

export function newPlugin(kind: PluginKind, app: string): PluginConfig {
  return {
    id: `${kind.id}:${Date.now().toString(36)}`, kind: kind.id, name: kind.label, app,
    send: kind.sendDefault, outputDir: "",
    onReturn: Object.fromEntries(kind.onReturn.map((o) => [o.id, o.default])),
  };
}

export const findApps = (kind: PluginKind) =>
  invoke<string[]>("plugin_find_apps", { patterns: navigator.userAgent.includes("Windows") ? kind.appHints.win : kind.appHints.mac })
    .catch(() => [] as string[]);

// an application's name from its path: "DxO PureRAW 4"
export const appName = (path: string) => path.split(/[\\/]/).pop()?.replace(/\.(app|exe)$/i, "") ?? path;

// why a plugin cannot take these photos, or null when it can
export function unfit(cfg: PluginConfig, targets: ImageEntry[]): string | null {
  const kind = kindOf(cfg.kind);
  if (!kind) return "unknown plugin";
  if (!cfg.app) return "choose its application in Preferences";
  const local = targets.filter((t) => !t.remote || t.remote.localPath);
  if (local.length < targets.length) return "only photos on this computer";
  if (kind.accepts === "raw" && targets.some((t) => fileKind(t.filename) !== "RAW")) return "raw files only";
  if (targets.length < kind.minPhotos) return kind.minPhotos > 1 ? `select at least ${kind.minPhotos} photos` : "no photo";
  if (kind.maxPhotos && targets.length > kind.maxPhotos) return `at most ${kind.maxPhotos} photos`;
  return null;
}

// what a returned file starts with: the ticked settings, or the kind's
// defaults once its plugin has been removed
export function returnValues(kindId: string, cfg: PluginConfig | undefined): { values: Values; labels: string[] } {
  const kind = kindOf(kindId);
  const values: Values = {};
  const labels: string[] = [];
  for (const o of kind?.onReturn ?? []) {
    if (cfg ? cfg.onReturn[o.id] : o.default) {
      Object.assign(values, o.values);
      labels.push(o.label.replace(/^Turn off /, ""));
    }
  }
  return { values, labels };
}

// a file taken back, with its original (plugins.rs, Return)
export type PluginReturn = { original: string; result: string; plugin: string; applied: boolean };
export const loadReturns = () => invoke<PluginReturn[]>("plugin_returns").catch(() => [] as PluginReturn[]);
