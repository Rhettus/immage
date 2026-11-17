// Replace Vite's eager locale glob when app modules are loaded directly by Node tests.
import { readFileSync, readdirSync } from 'node:fs';

export function withNodeLocales(url, source) {
  if (!url.endsWith('/i18n.ts')) return source;
  const dir = new URL('./locales/', url);
  const catalogs = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.json'))
    .map((f) => [`./locales/${f}`, JSON.parse(readFileSync(new URL(f, dir), 'utf8'))]));
  return source.replace(/import\.meta\.glob<Dict>\([^;]+\)/, JSON.stringify(catalogs));
}
