// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Pure locale negotiation and message formatting; no settings or browser access.
export type Dict = Record<string, string>;
export type Catalogs = Record<string, Dict>;
export const SYSTEM = "system";
const own = (obj: object, key: string) => Object.hasOwn(obj, key);

export function canonicalLocale(tag: string): string | undefined {
  try { return Intl.getCanonicalLocales(tag)[0]; } catch { return undefined; }
}

function parents(tag: string): string[] {
  const parts = tag.split("-");
  const result: string[] = [];
  while (parts.length) {
    result.push(parts.join("-"));
    parts.pop();
    // BCP 47 extensions start with a singleton, which cannot stand alone.
    if (parts.at(-1)?.length === 1) parts.pop();
  }
  return result;
}

export function resolveLanguage(preference: string, system: readonly string[], catalogs: Catalogs): string {
  const supported = new Map(Object.keys(catalogs).map((code) => [code.toLowerCase(), code]));
  const match = (tag: string) => {
    const canonical = canonicalLocale(tag);
    if (!canonical) return undefined;
    const exact = supported.get(canonical.toLowerCase());
    if (exact) return exact;
    const locale = new Intl.Locale(canonical).maximize();
    // A script-specific translation can serve a regional system locale (zh-TW -> zh-Hant).
    const candidates = [locale.toString(), `${locale.language}-${locale.script}`, ...parents(canonical)];
    return candidates.map((c) => supported.get(c.toLowerCase())).find(Boolean);
  };
  if (preference !== SYSTEM) {
    const explicit = match(preference);
    if (explicit) return explicit;
  }
  for (const tag of system) {
    const found = match(tag);
    if (found) return found;
  }
  return "en";
}

export function textDirection(code: string): "ltr" | "rtl" {
  const script = new Intl.Locale(code).maximize().script ?? "";
  return ["Arab", "Hebr", "Thaa", "Nkoo", "Adlm", "Rohg", "Syrc", "Samr", "Mand"].includes(script) ? "rtl" : "ltr";
}

export function createTranslator(language: string, catalogs: Catalogs) {
  const chain = [...new Set([...parents(language).filter((c) => own(catalogs, c)), "en"])];
  const rules = new Map(chain.map((code) => [code, new Intl.PluralRules(code)]));
  return (key: string, vars?: Record<string, unknown>): string => {
    let message: string | undefined;
    for (const code of chain) {
      const dict = catalogs[code];
      if (!dict) continue;
      const plural = typeof vars?.n === "number" && Number.isFinite(vars.n)
        ? `${key}_${rules.get(code)!.select(vars.n)}` : undefined;
      // Each fallback language chooses its own plural category, not the selected language's.
      const keys = plural ? [plural, key, `${key}_other`] : [key];
      const found = keys.find((k) => own(dict, k));
      if (found !== undefined) { message = dict[found]; break; }
    }
    message ??= key;
    return vars ? message.replace(/\{(\w+)\}/g, (original, name: string) =>
      own(vars, name) ? String(vars[name]) : original) : message;
  };
}
