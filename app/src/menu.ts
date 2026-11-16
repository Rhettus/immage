// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the application menus, written once: macOS builds its native menu bar from
// nativeSpec() (sent to Rust as JSON), Windows and Linux draw a menu strip
// from MENUS. shortcuts are in the Mac notation of Shortcuts.tsx; keys()
// renders them per platform

import type { NativeItem, NativeMenu } from "./commands";
import { t } from "./i18n";

export type ActionId =
  | "import" | "add-folder" | "export" | "print" | "quit"
  | "undo" | "redo" | "cut" | "copy" | "paste" | "select-all"
  | "copy-settings" | "paste-settings" | "paste-previous" | "preferences"
  | "virtual-copy" | "start-over" | "rotate-left" | "rotate-right" | "hdr-merge" | "pano-merge"
  | "crop" | "heal" | "wb-picker"
  | "rate-0" | "rate-1" | "rate-2" | "rate-3" | "rate-4" | "rate-5"
  | "label-red" | "label-yellow" | "label-green" | "label-blue" | "reject"
  | "zoom-in" | "zoom-out" | "zoom-toggle" | "fullscreen-preview" | "culling-preview" | "grid" | "before-after" | "compare"
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
  "virtual-copy", "start-over", "rotate-left", "rotate-right", "hdr-merge", "pano-merge",
  "crop", "heal", "wb-picker",
  "rate-0", "rate-1", "rate-2", "rate-3", "rate-4", "rate-5",
  "label-red", "label-yellow", "label-green", "label-blue", "reject",
  "zoom-in", "zoom-out", "zoom-toggle", "fullscreen-preview", "culling-preview", "grid", "before-after", "compare",
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
      item("preferences", t("menu.preferences"), "⌘,"), sep(),
      role("services"), sep(),
      role("hide"), role("hideOthers"), role("showAll"), sep(),
      role("quit"),
    ],
  },
  {
    label: t("menu.title.file"), items: [
      item("import", t("menu.import"), "⇧⌘I"),
      item("add-folder", t("menu.add-folder")), sep(),
      item("export", t("menu.export"), "⇧⌘E"),
      item("print", t("menu.print"), "⌘P"), sep("mac"),
      role("closeWindow"),
      sep("other"), item("quit", t("menu.quit"), "⌘Q", "other"),
    ],
  },
  {
    label: t("menu.title.edit"), items: [
      item("undo", t("menu.undo"), "⌘Z"),
      item("redo", t("menu.redo"), "⇧⌘Z"), sep(),
      role("cut"), role("copy"), role("paste"),
      item("cut", t("menu.cut"), "⌘X", "other"), item("copy", t("menu.copy"), "⌘C", "other"), item("paste", t("menu.paste"), "⌘V", "other"),
      item("select-all", t("menu.select-all"), "⌘A"), sep(),
      item("copy-settings", t("menu.copy-settings"), "⇧⌘C"),
      item("paste-settings", t("menu.paste-settings"), "⇧⌘V"),
      item("paste-previous", t("menu.paste-previous"), "⌥⌘V"),
      sep("other"), item("preferences", t("menu.preferences"), "⌘,", "other"),
    ],
  },
  {
    label: t("menu.title.photo"), items: [
      item("virtual-copy", t("menu.virtual-copy"), "⌘'"),
      item("start-over", t("menu.start-over")),
      item("rotate-left", t("menu.rotate-left"), "⌘["),
      item("rotate-right", t("menu.rotate-right"), "⌘]"), sep(),
      item("hdr-merge", t("menu.hdr-merge"), "⌃H"),
      item("pano-merge", t("menu.pano-merge"), "⌃M"), sep(),
      item("crop", t("menu.crop"), "R"),
      item("heal", t("menu.heal"), "Q"),
      item("wb-picker", t("menu.wb-picker"), "W"), sep(),
      {
        kind: "submenu", label: t("menu.title.rating"), items: [
          item("rate-0", t("menu.rate-0"), "0"), item("rate-1", t("menu.rate-1"), "1"), item("rate-2", t("menu.rate-2"), "2"),
          item("rate-3", t("menu.rate-3"), "3"), item("rate-4", t("menu.rate-4"), "4"), item("rate-5", t("menu.rate-5"), "5"),
        ],
      },
      {
        kind: "submenu", label: t("menu.title.label"), items: [
          item("label-red", t("menu.label-red"), "6"), item("label-yellow", t("menu.label-yellow"), "7"),
          item("label-green", t("menu.label-green"), "8"), item("label-blue", t("menu.label-blue"), "9"),
        ],
      },
      item("reject", t("menu.reject"), "X"),
    ],
  },
  {
    label: t("menu.title.view"), items: [
      item("zoom-in", t("menu.zoom-in"), "⌘="),
      item("zoom-out", t("menu.zoom-out"), "⌘-"),
      item("zoom-toggle", t("menu.zoom-toggle"), "Z"), sep(),
      item("fullscreen-preview", t("menu.fullscreen-preview"), "F"),
      item("culling-preview", t("menu.culling-preview"), "F"),
      item("grid", t("menu.grid"), "G"),
      item("before-after", t("menu.before-after"), "Y"),
      item("compare", t("menu.compare"), "C"), sep(),
      item("hide-panels", t("menu.hide-panels"), "Tab"),
      item("clipping", t("menu.clipping"), "J"),
      item("next-scope", t("menu.next-scope"), "H"),
      item("info-overlay", t("menu.info-overlay"), "I"),
      item("canvas", t("menu.canvas"), "L"),
      item("soft-proof", t("menu.soft-proof"), "S"), sep(),
      item("perf-overlay", t("menu.perf-overlay"), "⇧⌘P"),
    ],
  },
  {
    label: t("menu.title.window"), platform: "mac", items: [role("minimize"), role("zoom"), sep(), role("fullscreen")],
  },
  {
    label: t("menu.title.help"), items: [
      item("shortcuts", t("menu.shortcuts"), "⌘/"),
      item("user-guide", t("menu.user-guide")),
      item("support-bundle", t("menu.support-bundle")),
      sep("other"), item("about", t("menu.about"), undefined, "other"),
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
