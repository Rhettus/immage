// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the key chords (a command or Ctrl key held) that run a menu action, as a
// table. App's keydown handler asks chordAction for the action and runs it,
// with preventDefault unless the rule says `keep` (⇧⌘P never had one); the
// menu runs the same actions by id. rules are tried in order and the first
// match wins, as the if chain they replace did

import { cmd } from "./keys";
import type { ActionId } from "./menu";

type Chord = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

const isKey = (e: Chord, k: string) => e.key === k.toLowerCase() || e.key === k.toUpperCase();
// Ctrl alone, on every platform: ⌃H and ⌃M
const ctrlOnly = (e: Chord) => e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;

const CHORDS: [(e: Chord) => boolean, (e: Chord) => ActionId, "keep"?][] = [
  [(e) => cmd(e) && e.shiftKey && e.code === "KeyP", () => "perf-overlay", "keep"],
  [(e) => cmd(e) && e.shiftKey && isKey(e, "e"), () => "export"],
  // ⌘P: the Print panel, as Lightroom's Print module
  [(e) => cmd(e) && !e.shiftKey && !e.altKey && isKey(e, "p"), () => "print"],
  // Copy Settings, Paste and Previous, as Lightroom's ⇧⌘C, ⇧⌘V and ⌥⌘V
  [(e) => cmd(e) && (isKey(e, "c") || e.code === "KeyC") && e.shiftKey, () => "copy-settings"],
  [(e) => cmd(e) && e.code === "KeyV" && (e.shiftKey || e.altKey), (e) => (e.altKey ? "paste-previous" : "paste-settings")],
  [(e) => cmd(e) && e.code === "Slash", () => "shortcuts"],
  // Create Virtual Copy, as Lightroom's ⌘': of the selection, else the open photo
  [(e) => cmd(e) && e.code === "Quote", () => "virtual-copy"],
  // HDR Merge, as Lightroom's ⌃H: of the selection's raws, two or more
  [(e) => ctrlOnly(e) && e.code === "KeyH", () => "hdr-merge"],
  // Panorama Merge, as Lightroom's ⌃M: of the selection, two or more
  [(e) => ctrlOnly(e) && e.code === "KeyM", () => "pano-merge"],
  // Preferences, as every Mac app's ⌘,
  [(e) => cmd(e) && e.key === ",", () => "preferences"],
  [(e) => cmd(e) && e.shiftKey && isKey(e, "i"), () => "import"],
  [(e) => cmd(e) && isKey(e, "z"), (e) => (e.shiftKey ? "redo" : "undo")],
  // zoom in and out, as Lightroom's ⌘= and ⌘-; by code, so ⇧⌘= (⌘+) zooms
  // too. marked used, so WebView2 does not zoom the page
  [(e) => cmd(e) && (e.code === "Equal" || e.code === "Minus") && !e.altKey, (e) => (e.code === "Equal" ? "zoom-in" : "zoom-out")],
  [(e) => cmd(e) && (e.code === "BracketLeft" || e.code === "BracketRight"), (e) => (e.code === "BracketLeft" ? "rotate-left" : "rotate-right")],
  // ⌘A selects every photo the filters leave showing
  [(e) => cmd(e) && e.code === "KeyA" && !e.shiftKey && !e.altKey, () => "select-all"],
];

export function chordAction(e: Chord): { id: ActionId; keep: boolean } | null {
  for (const [match, id, keep] of CHORDS) if (match(e)) return { id: id(e), keep: keep === "keep" };
  return null;
}
