// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Localize built-in field metadata only at presentation. The original names remain
// stable for module matching, persisted layouts and user-defined instance names.
import en from "./locales/en.json" with { type: "json" };
import { language, t } from "./i18n";
// Prefer pinned darktable wording for Advanced metadata; Immage-specific names
// are included in fields.text.*. Contextually ambiguous upstream entries are
// deliberately omitted by scripts/sync_darktable_locales.py.
const keys = new Map(Object.entries(en).filter(([key]) => key.startsWith("fields.text.") || key.startsWith("darktable."))
  .sort(([a], [b]) => Number(a.startsWith("darktable.")) - Number(b.startsWith("darktable.")))
  .map(([key, value]) => [value, key]));
const foldedKeys = new Map([...keys].map(([text, key]) => [text.toLowerCase(), key]));
export function fieldText(text: string): string {
  const exact = keys.get(text);
  if (exact) return t(exact);
  const folded = foldedKeys.get(text.toLowerCase());
  if (folded) {
    const translated = t(folded);
    return text[0] !== text[0]?.toLowerCase()
      ? translated[0]?.toLocaleUpperCase(language) + translated.slice(1) : translated;
  }
  // Generated detail controls join a tool and parameter name; preserve the
  // underlying English control label, localizing only its two display parts.
  const separator = text.indexOf(": ");
  if (separator > 0) {
    const group = text.slice(0, separator), field = text.slice(separator + 2);
    if (keys.has(group) || foldedKeys.has(group.toLowerCase())) {
      return t("fields.compositeLabel", { group: fieldText(group), field: fieldText(field) });
    }
  }
  return text;
}
