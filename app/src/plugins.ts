// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Edit In: what darktable does not do is handed to another application (DxO
// PureRAW, Macro Studio's focus stacking), and the file it
// writes comes back to be edited, as with Lightroom's plug-ins. a kind says
// what an application takes and gives back; a plugin is one the user set up
// in Preferences, with its application and choices
import { commands, type PluginConfig as StoredPlugin, type PluginReturn, type HeliconMode } from "./commands";
import type { Values } from "./manifest";
import { fileKind, type ImageEntry } from "./library";
import { settings } from "./settings";
import { IS_MAC } from "./keys";
import { t } from "./i18n";

const IS_WINDOWS = navigator.userAgent.includes("Windows");

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
  // originals it takes only as raws, though a TIFF can be of any photo
  rawOriginals?: boolean;
  // what comes back from raws is a demosaiced raw, a linear DNG, and starts
  // with a raw's new-photo defaults, as a panorama does
  linearDng?: boolean;
  appHints: { mac: string[]; win: string[]; linux?: string[] };
  // settings a returned file starts with, the first time it is opened
  onReturn: { id: string; label: string; hint: string; values: Values; default: boolean }[];
  // what Preferences says about using it
  note: string;
} & (
  | { handoff: "files"; returns: { exts: string[]; match: "prefix" | "any"; subfolders: string[] } }
  | { handoff: "macrostudio" }
  | { handoff: "photocraft" }
  | { handoff: "helicon" }
);

const kinds: PluginKind[] = [
  {
    id: "dxo-pureraw",
    label: "DxO PureRAW",
    accepts: "raw",
    minPhotos: 1,
    send: "original",
    sendDefault: "original",
    handoff: "files",
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
  {
    id: "macro-studio",
    label: "Macro Studio",
    accepts: "any",
    minPhotos: 2,
    send: "choice",
    sendDefault: "original",
    rawOriginals: true,
    handoff: "macrostudio",
    linearDng: true,
    appHints: { mac: ["Macro Studio.app"], win: ["Macro Studio/MacroStudio.exe"] },
    onReturn: [],
    note: "select a focus bracket. Each stack opens in Macro Studio to check and retouch, and comes back here when it is saved there, as a DNG for the most latitude",
  },
  {
    id: "helicon-focus",
    label: "Helicon Focus",
    accepts: "any",
    minPhotos: 2,
    send: "original",
    sendDefault: "original",
    handoff: "helicon",
    linearDng: true,
    appHints: { mac: ["HeliconFocus.app", "Helicon Focus*.app"], win: ["Helicon Software/Helicon Focus*/HeliconFocus.exe", "Helicon Focus/HeliconFocus.exe"] },
    onReturn: [],
    note: "Choose RAW, 16-bit TIFFs, or Auto DNG from Edit In.",
  },
  {
    id: "photocraft",
    label: "PhotoCraft",
    accepts: "any",
    minPhotos: 1,
    send: "tiff",
    sendDefault: "tiff",
    handoff: "photocraft",
    appHints: { mac: ["PhotoCraft.app"], win: ["PhotoCraft/photocraft.exe"], linux: ["photocraft"] },
    onReturn: [],
    note: "Each selected photo opens as a 16-bit ProPhoto RGB layer in a TIFF or PSB beside the first photo.",
  },
];

export const KINDS = kinds.filter((kind) => kind.handoff !== "helicon" || IS_MAC || IS_WINDOWS);

export const kindOf = (id: string) => KINDS.find((k) => k.id === id);

// the generated type marks every field optional, as plugins.rs reads a
// missing one as empty; it always sends them all, and `send` and `look` take
// the values the page offers
export type PluginConfig = Required<Omit<StoredPlugin, "send" | "look">> & {
  send: "original" | "tiff";
  look?: "" | "natural" | "enhanced";  // Macro Studio's Look; "" for its own default
};
const whole = (list: StoredPlugin[]) => list as PluginConfig[];

// the plugins live in plugins.json, which only Rust writes (plugins.rs). the
// page keeps edits to names and choices; the application of each is set by
// chooseApp and setApp alone, so a path the page names is never launched
const LEGACY_KEY = "immage.plugins";
function legacyPlugins(): PluginConfig[] | null {
  try {
    const v = JSON.parse(settings.get(LEGACY_KEY) ?? "null");
    return Array.isArray(v) ? v.filter((p) => p && kindOf(p.kind)) : null;
  } catch { return null; }
}
// the first start after plugins moved to Rust hands over what localStorage
// held; Rust takes it only when it has no plugins.json yet, and it is
// dropped here once that is answered
export async function loadPlugins(): Promise<PluginConfig[]> {
  try {
    const list = whole(await commands.pluginConfig(legacyPlugins())).filter((p) => kindOf(p.kind));
    try { settings.remove(LEGACY_KEY); } catch { /* not kept */ }
    return list;
  } catch { return []; }
}
export const storePlugins = (list: PluginConfig[]) =>
  commands.pluginConfigSave(list).then(whole).catch(() => null);
// an application plugin_find_apps returned, or the one the user picks in the
// dialog Rust opens (null if cancelled); the plugins as stored after
export const setPluginApp = (id: string, path: string) =>
  commands.pluginSetApp(id, path).then(whole).catch(() => null);
export const choosePluginApp = (id: string) =>
  commands.pluginChooseApp(id).then((l) => l && whole(l)).catch(() => null);

export function newPlugin(kind: PluginKind, app: string): PluginConfig {
  return {
    id: `${kind.id}:${Date.now().toString(36)}`, kind: kind.id, name: kind.label, app,
    send: kind.sendDefault, outputDir: "",
    onReturn: Object.fromEntries(kind.onReturn.map((o) => [o.id, o.default])),
  };
}

export const findApps = (kind: PluginKind) =>
  commands.pluginFindApps(IS_MAC ? kind.appHints.mac : IS_WINDOWS ? kind.appHints.win : kind.appHints.linux ?? [])
    .catch(() => [] as string[]);

// an application's name from its path: "DxO PureRAW 4"
export const appName = (path: string) => path.split(/[\\/]/).pop()?.replace(/\.(app|exe|appimage)$/i, "") ?? path;

export type EditInAction = { cfg: PluginConfig; mode?: HeliconMode };

export function unfit({ cfg, mode }: EditInAction, targets: ImageEntry[]): string | null {
  const kind = kindOf(cfg.kind);
  if (!kind) return "unknown plugin";
  if (!cfg.app) return "choose its application in Preferences";
  const local = targets.filter((t) => !t.remote || t.remote.localPath);
  if (local.length < targets.length) return "only photos on this computer";
  const rawOnly = mode === "raw" || mode === "auto-dng"
    || kind.accepts === "raw" || (kind.rawOriginals && cfg.send === "original");
  if (rawOnly && targets.some((t) => fileKind(t.filename) !== "RAW")) return "raw files only";
  // Helicon is handed the raw files themselves, so a virtual copy adds nothing
  if ((mode === "raw" || mode === "auto-dng")
      && new Set(targets.map((p) => p.remote?.localPath ?? p.path)).size < targets.length)
    return t("plugins.helicon.distinctRaws");
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
export type { PluginReturn };
export const loadReturns = () => commands.pluginReturns().catch(() => [] as PluginReturn[]);
