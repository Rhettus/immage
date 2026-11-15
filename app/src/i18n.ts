// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// UI text. A language is one JSON file in locales/ (key -> text); en.json is the
// reference and the fallback, so a partial translation just shows English for
// the keys it lacks. To add a language: copy en.json, translate the values,
// import it here and add it to LOCALES (see docs/dev/i18n.md).
//
// The language is read once at start-up (settings are loaded before the app is
// imported), so t() can be called at module level; changing it reloads the page.
// "{name}" in a text is replaced from vars. With vars.n, "key_one"/"key_other"
// (Intl.PluralRules categories) are tried before "key".
import en from "./locales/en.json" with { type: "json" };
import fr from "./locales/fr.json" with { type: "json" };
import { settings } from "./settings";

type Dict = Record<string, string>;

// code -> its own name (shown as is in the selector) and texts
export const LOCALES: Record<string, { name: string; dict: Dict }> = {
  en: { name: "English", dict: en },
  fr: { name: "Français", dict: fr },
};

const KEY = "immage.language";
export const SYSTEM = "system";

export function loadLanguage(): string {
  const v = settings.get(KEY);
  return v && v in LOCALES ? v : SYSTEM;
}

export function storeLanguage(v: string) {
  try { if (v === SYSTEM) settings.remove(KEY); else settings.set(KEY, v); } catch { /* not kept */ }
}

function resolve(): string {
  const pref = loadLanguage();
  if (pref !== SYSTEM) return pref;
  const sys = (typeof navigator === "undefined" ? "" : navigator.language).toLowerCase().split("-")[0];
  return sys in LOCALES ? sys : "en";
}

export const language = resolve();
const dict = LOCALES[language].dict;
if (typeof document !== "undefined") document.documentElement.lang = language;

export function t(key: string, vars?: Record<string, unknown>): string {
  let s: string | undefined;
  if (vars && typeof vars.n === "number") {
    const k = `${key}_${new Intl.PluralRules(language).select(vars.n)}`;
    s = dict[k] ?? (en as Dict)[k];
  }
  s ??= dict[key] ?? (en as Dict)[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
}
