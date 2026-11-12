// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the application menus, written once: macOS builds its native menu bar from
// nativeSpec() (sent to Rust as JSON), Windows and Linux draw a menu strip
// from MENUS. shortcuts are in the Mac notation of Shortcuts.tsx; keys()
// renders them per platform

import type { NativeItem, NativeMenu } from "./commands";

export type ActionId =
  | "import" | "add-folder" | "export" | "print" | "quit"
  | "undo" | "redo" | "cut" | "copy" | "paste" | "select-all"
  | "copy-settings" | "paste-settings" | "paste-previous" | "preferences"
  | "virtual-copy" | "rotate-left" | "rotate-right" | "hdr-merge" | "pano-merge"
  | "crop" | "heal" | "wb-picker"
  | "rate-0" | "rate-1" | "rate-2" | "rate-3" | "rate-4" | "rate-5"
  | "label-red" | "label-yellow" | "label-green" | "label-blue" | "reject"
  | "zoom-in" | "zoom-out" | "zoom-toggle" | "fullscreen-preview" | "grid" | "before-after" | "compare"
  | "hide-panels" | "clipping" | "next-scope" | "info-overlay" | "canvas" | "soft-proof" | "perf-overlay"
  | "shortcuts" | "user-guide" | "support-bundle" | "about";

export type Platform = "mac" | "other";
export type Role = "about" | "services" | "hide" | "hideOthers" | "showAll" | "quit" | "closeWindow" | "cut" | "copy" | "paste" | "minimize" | "zoom" | "fullscreen";

export type MenuItem =
  | { kind: "item"; id: ActionId; label: string; shortcut?: string; platform?: Platform }
  | { kind: "separator"; platform?: Platform }
  | { kind: "submenu"; label: string; items: MenuItem[]; platform?: Platform }
  | { kind: "role"; role: Role; platform?: Platform }; // macOS predefined items only (always platform "mac")
export type Menu = { label: string; items: MenuItem[]; platform?: Platform };

export const ACTION_IDS: readonly ActionId[] = [
  "import", "add-folder", "export", "print", "quit",
  "undo", "redo", "cut", "copy", "paste", "select-all",
  "copy-settings", "paste-settings", "paste-previous", "preferences",
  "virtual-copy", "rotate-left", "rotate-right", "hdr-merge", "pano-merge",
  "crop", "heal", "wb-picker",
  "rate-0", "rate-1", "rate-2", "rate-3", "rate-4", "rate-5",
  "label-red", "label-yellow", "label-green", "label-blue", "reject",
  "zoom-in", "zoom-out", "zoom-toggle", "fullscreen-preview", "grid", "before-after", "compare",
  "hide-panels", "clipping", "next-scope", "info-overlay", "canvas", "soft-proof", "perf-overlay",
  "shortcuts", "user-guide", "support-bundle", "about",
];

const item = (id: ActionId, label: string, shortcut?: string, platform?: Platform): MenuItem =>
  ({ kind: "item", id, label, ...(shortcut ? { shortcut } : {}), ...(platform ? { platform } : {}) });
const sep = (platform?: Platform): MenuItem => ({ kind: "separator", ...(platform ? { platform } : {}) });
const role = (r: Role): MenuItem => ({ kind: "role", role: r, platform: "mac" });

export const MENUS: Menu[] = [
  {
    label: "Immage", platform: "mac", items: [
      role("about"), sep(),
      item("preferences", "Preferences…", "⌘,"), sep(),
      role("services"), sep(),
      role("hide"), role("hideOthers"), role("showAll"), sep(),
      role("quit"),
    ],
  },
  {
    label: "File", items: [
      item("import", "Import Photos…", "⇧⌘I"),
      item("add-folder", "Add Folder…"), sep(),
      item("export", "Export…", "⇧⌘E"),
      item("print", "Print…", "⌘P"), sep("mac"),
      role("closeWindow"),
      sep("other"), item("quit", "Quit", "⌘Q", "other"),
    ],
  },
  {
    label: "Edit", items: [
      item("undo", "Undo", "⌘Z"),
      item("redo", "Redo", "⇧⌘Z"), sep(),
      role("cut"), role("copy"), role("paste"),
      item("cut", "Cut", "⌘X", "other"), item("copy", "Copy", "⌘C", "other"), item("paste", "Paste", "⌘V", "other"),
      item("select-all", "Select All", "⌘A"), sep(),
      item("copy-settings", "Copy Settings…", "⇧⌘C"),
      item("paste-settings", "Paste Settings", "⇧⌘V"),
      item("paste-previous", "Paste Previous Settings", "⌥⌘V"),
      sep("other"), item("preferences", "Preferences…", "⌘,", "other"),
    ],
  },
  {
    label: "Photo", items: [
      item("virtual-copy", "Create Virtual Copy", "⌘'"),
      item("rotate-left", "Rotate Left", "⌘["),
      item("rotate-right", "Rotate Right", "⌘]"), sep(),
      item("hdr-merge", "HDR Merge…", "⌃H"),
      item("pano-merge", "Panorama Merge…", "⌃M"), sep(),
      item("crop", "Crop", "R"),
      item("heal", "Heal", "Q"),
      item("wb-picker", "White Balance Picker", "W"), sep(),
      {
        kind: "submenu", label: "Rating", items: [
          item("rate-0", "No Stars", "0"), item("rate-1", "1 Star", "1"), item("rate-2", "2 Stars", "2"),
          item("rate-3", "3 Stars", "3"), item("rate-4", "4 Stars", "4"), item("rate-5", "5 Stars", "5"),
        ],
      },
      {
        kind: "submenu", label: "Label", items: [
          item("label-red", "Red", "6"), item("label-yellow", "Yellow", "7"),
          item("label-green", "Green", "8"), item("label-blue", "Blue", "9"),
        ],
      },
      item("reject", "Reject", "X"),
    ],
  },
  {
    label: "View", items: [
      item("zoom-in", "Zoom In", "⌘="),
      item("zoom-out", "Zoom Out", "⌘-"),
      item("zoom-toggle", "Fit / Zoom", "Z"), sep(),
      item("fullscreen-preview", "Full Screen Preview", "F"),
      item("grid", "Grid View", "G"),
      item("before-after", "Before / After", "Y"),
      item("compare", "Compare", "C"), sep(),
      item("hide-panels", "Hide Panels", "Tab"),
      item("clipping", "Show Clipping", "J"),
      item("next-scope", "Next Scope", "H"),
      item("info-overlay", "Info Overlay", "I"),
      item("canvas", "Next Canvas Color", "L"),
      item("soft-proof", "Soft Proof", "S"), sep(),
      item("perf-overlay", "Performance Overlay", "⇧⌘P"),
    ],
  },
  {
    label: "Window", platform: "mac", items: [role("minimize"), role("zoom"), sep(), role("fullscreen")],
  },
  {
    label: "Help", items: [
      item("shortcuts", "Keyboard Shortcuts", "⌘/"),
      item("user-guide", "User Guide"),
      item("support-bundle", "Create Support Bundle…"),
      sep("other"), item("about", "About Immage", undefined, "other"),
    ],
  },
];

const tidy = (items: MenuItem[]): MenuItem[] => {
  const out: MenuItem[] = [];
  for (const it of items) {
    if (it.kind === "separator" && (!out.length || out[out.length - 1].kind === "separator")) continue;
    out.push(it);
  }
  while (out.length && out[out.length - 1].kind === "separator") out.pop();
  return out;
};

const pick = (items: MenuItem[], want: Platform): MenuItem[] =>
  tidy(items.filter((m) => !m.platform || m.platform === want).map((m) =>
    m.kind === "submenu" ? { ...m, items: pick(m.items, want) } : m));

// the menus for one platform: other platform's entries dropped, separators
// collapsed so none leads, trails or doubles
export function forPlatform(menus: Menu[], mac: boolean): Menu[] {
  const want: Platform = mac ? "mac" : "other";
  return menus.filter((m) => !m.platform || m.platform === want)
    .map((m) => ({ ...m, items: pick(m.items, want) }));
}

// a key that works bare (F, Tab, 0, ⇧H): without ⌘, ⌃ or ⌥
export function isSingleKey(shortcut: string): boolean {
  return !/[⌘⌃⌥]/.test(shortcut);
}

// "⇧⌘E" -> "CmdOrCtrl+Shift+E"; single keys give none, since a bare-key
// accelerator would fire while typing in a field
export function nativeAccel(shortcut: string): string | undefined {
  if (isSingleKey(shortcut)) return undefined;
  const m = /^([⇧⌘⌃⌥]+)(.+)$/.exec(shortcut);
  if (!m) return undefined;
  const parts: string[] = [];
  if (m[1].includes("⌘")) parts.push("CmdOrCtrl");
  if (m[1].includes("⌃")) parts.push("Ctrl");
  if (m[1].includes("⌥")) parts.push("Alt");
  if (m[1].includes("⇧")) parts.push("Shift");
  return [...parts, m[2]].join("+");
}

export type { NativeItem, NativeMenu };

const native = (m: MenuItem): NativeItem => {
  switch (m.kind) {
    case "separator": return { type: "separator" };
    case "role": return { type: "predefined", role: m.role };
    case "submenu": return { type: "submenu", label: m.label, items: m.items.map(native) };
    case "item": {
      if (!m.shortcut) return { type: "item", id: m.id, label: m.label };
      const accel = nativeAccel(m.shortcut);
      return accel
        ? { type: "item", id: m.id, label: m.label, accel }
        : { type: "item", id: m.id, label: `${m.label} (${m.shortcut})` };
    }
  }
};

// the macOS menu bar as plain data for the Rust side
export function nativeSpec(menus: Menu[]): NativeMenu[] {
  return forPlatform(menus, true).map((m) => ({ label: m.label, items: m.items.map(native) }));
}
