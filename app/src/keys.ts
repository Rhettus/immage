// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the platform's keys: the command key is ⌘ on macOS and Ctrl on Windows and
// Linux, and shortcuts are written in the interface the way each platform
// writes them

export const IS_MAC = /Mac/.test(navigator.userAgent);

// whether an event holds the command key
export const cmd = (e: { metaKey: boolean; ctrlKey: boolean }) => (IS_MAC ? e.metaKey : e.ctrlKey);

// a shortcut as written on a Mac (⇧⌘E, ⌥-click, hold ⌥, ⌃H) in this
// platform's terms: Ctrl+Shift+E, Alt-click, hold Alt, Ctrl+H
const NAMES: [string, string][] = [["⌘", "Ctrl"], ["⌃", "Ctrl"], ["⌥", "Alt"], ["⇧", "Shift"]];
export function keys(s: string): string {
  if (IS_MAC) return s;
  return s.replace(/[⇧⌥⌘⌃]+(-?)/g, (m: string, dash: string, at: number) => {
    const names = NAMES.filter(([g]) => m.includes(g)).map(([, n]) => n).join("+");
    if (dash) return `${names}-`;
    // a key follows ("⌘Z", "⌘,") or none does ("hold ⌥)", "⇧ its")
    const next = s[at + m.length];
    return next === undefined || next === " " || next === ")" ? names : `${names}+`;
  });
}

// whether a focused control keeps a key from the app's shortcuts: a text
// field every key, a slider its arrows, a switch its Space. a switch kept
// every key once, so O did nothing after one was clicked, and the overlay
// it had brought up stayed
export function fieldKeeps(t: EventTarget | null, key: string): boolean {
  const el = t as { tagName?: string; type?: string } | null;
  if (el?.tagName === "TEXTAREA") return true;
  if (el?.tagName !== "INPUT") return false;
  if (el.type === "range") return key.startsWith("Arrow");
  if (el.type === "checkbox") return key === " ";
  return true;
}
