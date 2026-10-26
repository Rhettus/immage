// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the Export dialog's settings, and its presets as Lightroom keeps them:
// named sets of settings in a list. a preset stores only the settings it
// was saved with and is read over the defaults, so settings added later
// need no migration: an older preset simply lacks them
import { invoke } from "@tauri-apps/api/core";
import type { ImageEntry } from "./library";
import { expandText, type Meta } from "./exportTokens";

// one LRMogrify outer border: widths in % of the photo's short or long
// edge, or pixels of the exported file; items stack from the inside out
export type BorderItem = {
  id: string; identical: boolean;
  top: number; left: number; right: number; bottom: number;
  unit: "short" | "long" | "px"; color: string;
};

// one LRMogrify inner border: a line drawn over the photo, `inset` in from
// its edges, `size` wide; with `identical`, the top values serve every side
export type Sides = { top: number; left: number; right: number; bottom: number };
export type InnerItem = {
  id: string; identical: boolean;
  inset: Sides; insetUnit: "short" | "long" | "px";
  size: Sides; sizeUnit: "short" | "long" | "px";
  color: string; opacity: number;          // 0-100
};

// one LRMogrify text annotation: `position` is a 3x3 grid, 0 top left to
// 8 bottom right, over the whole framed image or, before borders, over
// the photo alone
export type TextItem = {
  id: string; text: string;
  font: string; weight: number; italic: boolean;
  size: number; sizeUnit: "px" | "short";
  color: string; opacity: number;          // 0-100
  background: boolean; bgColor: string; bgOpacity: number;
  position: number; insetX: number; insetY: number; insetUnit: "px" | "short";
  beforeBorders: boolean;
};

export type Settings = {
  dir: string;
  useSubfolder: boolean;
  subfolder: string;
  naming: "original" | "custom" | "template";
  customName: string;
  template: string;
  format: "jpeg" | "tiff" | "png" | "webp";
  quality: number;
  bpp: 8 | 16;
  colorSpace: "srgb" | "adobergb" | "displayp3" | "prophoto";
  resize: boolean;
  longEdge: number;
  upscale: 0 | 2 | 4;   // AI upscaling: 2 or 4 times the width and height
  // a fixed canvas, canvasW x canvasH pixels of the exported file: the
  // photo and its frame are fitted inside and centered, the rest is
  // canvasColor; canvasFlip turns it for landscape photos
  canvas: boolean;
  canvasW: number;
  canvasH: number;
  canvasColor: string;
  canvasFlip: boolean;
  borders: BorderItem[];
  inner: InnerItem[];
  texts: TextItem[];
  // what the file's metadata holds (the dialog's Metadata section); the
  // date taken and the orientation are always kept
  includeCamera: boolean;      // camera, lens and exposure settings
  includeSerials: boolean;     // serial numbers and the owner's name
  removeLocation: boolean;
  includeDescription: boolean; // title, caption, creator, copyright
  includeKeywords: boolean;
  includeHistory: boolean;     // darktable's edit history
  // added to each exported file's keywords, and with keywordsOnOriginal
  // to the original photo's too
  keywords: string[];
  keywordsOnOriginal: boolean;
  conflict: "ask" | "unique" | "overwrite" | "skip";
  reveal: boolean;    // the exported files shown in the file manager afterwards
  scope: "current" | "selected" | "shown";
  dateFormat: string; // how {datecaptured} is written
  target: "folder" | "immich";
  album: string;      // the Immich album's id, last used
};

export const DEFAULTS: Settings = {
  dir: "", useSubfolder: false, subfolder: "Export", naming: "original", customName: "",
  template: "{caption}-{datecaptured}",
  format: "jpeg", quality: 90, bpp: 8, colorSpace: "srgb", resize: false, longEdge: 2048, upscale: 0,
  canvas: false, canvasW: 1638, canvasH: 2048, canvasColor: "#ffffff", canvasFlip: false,
  borders: [], inner: [], texts: [], includeCamera: true, includeSerials: false, removeLocation: false,
  includeDescription: true, includeKeywords: true, includeHistory: false, keywords: [], keywordsOnOriginal: false,
  conflict: "ask", reveal: false, scope: "current", dateFormat: "YYYYMMDD", target: "folder", album: "",
};

export const newId = () => Math.random().toString(36).slice(2, 10);

export const newBorder = (): BorderItem => ({
  id: newId(), identical: true, top: 3, left: 3, right: 3, bottom: 3, unit: "short", color: "#ffffff",
});

const even = (v: number): Sides => ({ top: v, left: v, right: v, bottom: v });
export const newInner = (): InnerItem => ({
  id: newId(), identical: true, inset: even(0), insetUnit: "px", size: even(0.2), sizeUnit: "long",
  color: "#000000", opacity: 100,
});

export const newText = (): TextItem => ({
  id: newId(), text: "{title}", font: "Helvetica Neue", weight: 400, italic: false,
  size: 2, sizeUnit: "short", color: "#000000", opacity: 100,
  background: false, bgColor: "#000000", bgOpacity: 50,
  position: 7, insetX: 0, insetY: 1.5, insetUnit: "short", beforeBorders: false,
});

// settings kept from before presets: the single even border becomes a
// border item, and "Ask what to do" is the default for existing files
// once, whatever was chosen before
function migrate(raw: Record<string, unknown>): Partial<Settings> {
  const out = { ...raw } as Record<string, unknown>;
  if (!("borders" in raw) && raw.border === true) {
    // darktable's constant border: `p` of the longer side all round
    const p = Number(raw.borderPercent ?? 4) / 100;
    const side = Math.round((1000 * p) / (1 - p) / 2) / 10;
    out.borders = [{ ...newBorder(), top: side, left: side, right: side, bottom: side, unit: "long",
                     color: typeof raw.borderColor === "string" ? raw.borderColor : "#ffffff" }];
  }
  delete out.border; delete out.borderPercent; delete out.borderColor;
  if (!raw.askMigrated) out.conflict = "ask";
  delete out.askMigrated;
  return out as Partial<Settings>;
}

export const loadSettings = (): Settings => {
  try {
    const raw = JSON.parse(localStorage.getItem("immage.export") ?? "{}");
    const s = { ...DEFAULTS, ...migrate(raw) };
    if (!raw.askMigrated) saveSettings(s);
    return s;
  } catch { return DEFAULTS; }
};
export const saveSettings = (s: Settings) => {
  try { localStorage.setItem("immage.export", JSON.stringify({ ...s, askMigrated: true })); } catch { /* not kept */ }
};

// ------------------------------------------------------------- presets
// `icon` names the one the user chose for it (ExportDialog's PRESET_ICONS);
// without it, the dialog picks one from what the preset does
export type ExportPreset = { id: string; name: string; builtin?: boolean; icon?: string; settings: Partial<Settings> };
type PresetsFile = { version: 1; presets: ExportPreset[] };

// what a preset holds: everything but which photos are exported
export const PRESET_KEYS = (Object.keys(DEFAULTS) as (keyof Settings)[]).filter((k) => k !== "scope");

// how a photo leaves Immage, without where it goes: the builtins carry
// these, so choosing one keeps the folder or album already chosen
const OUTPUT: Partial<Settings> = {
  naming: "original", format: "jpeg", quality: 90, bpp: 8, colorSpace: "srgb", resize: false, longEdge: 2048,
  upscale: 0, canvas: false, canvasW: 1638, canvasH: 2048, canvasColor: "#ffffff", canvasFlip: false,
  borders: [], inner: [], texts: [], includeCamera: true, includeSerials: false, removeLocation: false,
  includeDescription: true, includeKeywords: true, includeHistory: false, keywords: [], keywordsOnOriginal: false,
};

const GRAY = "#9a9a9a";
export const BUILTINS: ExportPreset[] = [
  { id: "builtin:full", name: "Full Size JPEG", builtin: true, settings: { ...OUTPUT } },
  { id: "builtin:web", name: "Web 2048", builtin: true,
    settings: { ...OUTPUT, quality: 85, resize: true, longEdge: 2048, removeLocation: true } },
  { id: "builtin:frame", name: "Frame with EXIF", builtin: true,
    settings: {
      ...OUTPUT, resize: true, longEdge: 2048,
      borders: [{ id: "b1", identical: false, top: 3, left: 3, right: 3, bottom: 8, unit: "short", color: "#ffffff" }],
      texts: [
        { ...newText(), id: "t1", text: "{title}", size: 1.9, insetY: 4.2 },
        { ...newText(), id: "t2", text: "{dateCaptured}", weight: 300, size: 1.35, color: GRAY,
          position: 6, insetX: 1.2, insetY: 1.2 },
        { ...newText(), id: "t3", weight: 300, size: 1.35, color: GRAY, insetY: 1.2,
          text: "{cameraModel} · {lens} · {focalLength} - {aperture} - {shutterSpeed} - {isoSpeedRating}"
            + " · {subjectDistance, Unknown Distance}" },
      ],
    } },
  // every photo on a 4:5 portrait canvas, as Instagram shows them, with a
  // thin white edge so a photo never touches the canvas
  { id: "builtin:fixed45", name: "Fixed Ratio 4:5", builtin: true,
    settings: {
      ...OUTPUT, quality: 85, canvas: true, removeLocation: true,
      borders: [{ id: "b1", identical: true, top: 1.2, left: 1.2, right: 1.2, bottom: 1.2, unit: "long", color: "#ffffff" }],
    } },
];

export async function loadPresets(): Promise<ExportPreset[]> {
  try {
    const f = await invoke<PresetsFile | null>("export_presets_load");
    return Array.isArray(f?.presets) ? f.presets : [];
  } catch { return []; }
}
export const savePresets = (presets: ExportPreset[]) =>
  invoke("export_presets_save", { presets: { version: 1, presets } satisfies PresetsFile });

export const presetOf = (s: Settings): Partial<Settings> =>
  Object.fromEntries(PRESET_KEYS.map((k) => [k, s[k]])) as Partial<Settings>;

// settings that belong to this computer, not to how a photo looks: a
// shared preset leaves them out, and applying a preset that lacks them
// keeps the ones already chosen
export const PERSONAL_KEYS: (keyof Settings)[] = ["dir", "album", "target"];

// a preset as a file to give someone
export const sharedFile = (p: ExportPreset) => ({
  immage: "export-presets", version: 1,
  presets: [{
    name: p.name,
    ...(p.icon ? { icon: p.icon } : {}),
    settings: Object.fromEntries(Object.entries(p.settings).filter(([k]) => !PERSONAL_KEYS.includes(k as keyof Settings))),
  }],
});

// the presets in a shared file, renamed where a name is taken; settings
// this version does not know are kept, as presets keep them anyway, but
// lists that are not lists are dropped so the dialog cannot trip on them
export function readShared(file: unknown, taken: string[]): ExportPreset[] {
  const f = file as { immage?: unknown; presets?: unknown };
  if (!f || f.immage !== "export-presets" || !Array.isArray(f.presets)) throw new Error("this file is not an Immage export preset");
  const names = new Set(taken);
  return f.presets.flatMap((raw): ExportPreset[] => {
    const r = raw as { name?: unknown; icon?: unknown; settings?: unknown };
    if (typeof r?.name !== "string" || !r.settings || typeof r.settings !== "object" || Array.isArray(r.settings)) return [];
    const settings = { ...(r.settings as Record<string, unknown>) };
    for (const k of PERSONAL_KEYS) delete settings[k];
    if ("keywords" in settings && !(Array.isArray(settings.keywords)
                                    && settings.keywords.every((k) => typeof k === "string"))) delete settings.keywords;
    for (const k of ["borders", "inner", "texts"]) {
      if (k in settings && !Array.isArray(settings[k])) delete settings[k];
      else if (Array.isArray(settings[k]))
        settings[k] = (settings[k] as Record<string, unknown>[]).filter((x) => x && typeof x === "object")
          .map((x) => ({ ...x, id: newId() }));
    }
    let name = r.name.trim() || "Imported preset";
    for (let n = 2; names.has(name); n++) name = `${r.name.trim()} (${n})`;
    names.add(name);
    return [{ id: newId(), name, ...(typeof r.icon === "string" ? { icon: r.icon } : {}),
              settings: settings as Partial<Settings> }];
  });
}

// whether the dialog has moved away from the preset it last applied
export const presetEdited = (p: ExportPreset, s: Settings) =>
  (Object.keys(p.settings) as (keyof Settings)[])
    .some((k) => JSON.stringify(p.settings[k]) !== JSON.stringify(s[k]));

// ------------------------------------------------------- engine request
// the engine's frame for one photo, its texts filled in from its metadata,
// or null when there is nothing to draw
export function frameFor(s: Settings, i: ImageEntry, meta: Meta) {
  const borders = s.borders.map((b) => {
    const v = b.identical ? { top: b.top, left: b.top, right: b.top, bottom: b.top } : b;
    return { top: v.top, left: v.left, right: v.right, bottom: v.bottom, unit: b.unit, color: b.color };
  });
  const sides = (v: Sides, identical: boolean) => identical ? even(v.top) : v;
  const inner = s.inner.map((b) => ({
    inset: sides(b.inset, b.identical), insetUnit: b.insetUnit, size: sides(b.size, b.identical),
    sizeUnit: b.sizeUnit, color: b.color, opacity: b.opacity / 100,
  }));
  const texts = s.texts.map((t) => ({
    text: expandText(t.text, i, meta), font: t.font, weight: t.weight, italic: t.italic,
    size: t.size, sizeUnit: t.sizeUnit, color: t.color, opacity: t.opacity / 100,
    background: t.background ? { color: t.bgColor, opacity: t.bgOpacity / 100 } : null,
    position: t.position, insetX: t.insetX, insetY: t.insetY, insetUnit: t.insetUnit,
    relativeTo: t.beforeBorders ? "photo" : "frame",
  })).filter((t) => t.text.trim());
  const canvas = s.canvas
    ? { width: s.canvasW, height: s.canvasH, color: s.canvasColor, flip: s.canvasFlip } : null;
  return borders.length || inner.length || texts.length || canvas ? { borders, inner, texts, canvas } : null;
}
