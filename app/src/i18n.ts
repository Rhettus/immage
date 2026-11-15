// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// One UTF-8 JSON catalog per BCP 47 language tag. Vite includes new files automatically.
// Settings are loaded before this module; language changes apply on the next app start.
import { settings } from "./settings";
import { canonicalLocale, createTranslator, resolveLanguage, SYSTEM, textDirection, type Dict } from "./i18nCore";
export { SYSTEM } from "./i18nCore";

const files = import.meta.glob<Dict>("./locales/*.json", { eager: true, import: "default" });
export const LOCALES: Record<string, { name: string; dict: Dict }> = Object.fromEntries(
  Object.entries(files).map(([path, dict]) => {
    const tag = path.slice(path.lastIndexOf("/") + 1, -5);
    const code = canonicalLocale(tag);
    if (!code || code !== tag) throw new Error(`Invalid locale filename: ${path}`);
    const name = new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
    return [code, { name, dict }];
  }),
);
const catalogs = Object.fromEntries(Object.entries(LOCALES).map(([code, locale]) => [code, locale.dict]));
const KEY = "immage.language";

export function loadLanguage(): string {
  const value = settings.get(KEY);
  return value && Object.hasOwn(LOCALES, value) ? value : SYSTEM;
}

export function storeLanguage(value: string) {
  if (value !== SYSTEM && !Object.hasOwn(LOCALES, value)) throw new Error(`Unknown language: ${value}`);
  if (value === SYSTEM) settings.remove(KEY); else settings.set(KEY, value);
}

export const startupLanguage = loadLanguage();
const systemLanguages = typeof navigator === "undefined" ? []
  : navigator.languages?.length ? [...navigator.languages] : [navigator.language];
export const language = resolveLanguage(startupLanguage, systemLanguages, catalogs);
export const direction = textDirection(language);
if (typeof document !== "undefined") {
  document.documentElement.lang = language;
  document.documentElement.dir = direction;
}
export const t = createTranslator(language, catalogs);
// Use these for localized display only; protocol values, paths and saved numbers stay unchanged.
export const formatNumber = (value: number, options?: Intl.NumberFormatOptions) =>
  new Intl.NumberFormat(language, options).format(value);
export const formatDate = (value: Date | number, options?: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(language, options).format(value);
