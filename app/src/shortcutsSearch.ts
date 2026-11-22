// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { keys } from "./keys";

export type ShortcutGroup = { title: string; keys: [string, string][] };

export function normalizeShortcutSearch(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

const SYMBOL_ALIASES: [string, string][] = [
  ["⌘", "cmd command"],
  ["⌃", "ctrl control"],
  ["⌥", "opt option alt"],
  ["⇧", "shift"],
  ["←", "left arrow"],
  ["→", "right arrow"],
];

export function filterShortcutGroups(
  groups: readonly ShortcutGroup[],
  query: string,
  formatKey: (s: string) => string = keys,
): ShortcutGroup[] {
  const tokens = normalizeShortcutSearch(query).trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [...groups];

  const out: ShortcutGroup[] = [];
  for (const g of groups) {
    const matched = g.keys.filter(([k, what]) => {
      const shownKey = formatKey(k);
      const shownWhat = formatKey(what);
      const extraAliases = SYMBOL_ALIASES
        .filter(([sym]) => k.includes(sym))
        .map(([, alias]) => alias)
        .join(" ");
      const haystack = normalizeShortcutSearch(
        `${g.title} ${shownKey} ${shownKey.replace(/[+-]/g, " ")} ${extraAliases} ${shownWhat}`,
      );
      return tokens.every((tok) => haystack.includes(tok));
    });
    if (matched.length > 0) {
      out.push({ title: g.title, keys: matched });
    }
  }
  return out;
}
