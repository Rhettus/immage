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
