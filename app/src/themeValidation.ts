// SPDX-License-Identifier: GPL-3.0-or-later

const dark = { window: '#0e0e0e', panel: '#181818', card: '#1f1f1f', inset: '#262626', hover: '#2a2a2a', text: '#f0f0f0', 'text-2': '#a3a3a3', 'text-3': '#6b6b6b', track: '#2e2e2e', thumb: '#f5f5f5', accent: '#ffffff', border: '#333333', 'on-accent': '#111111', focus: '#a3a3a3', error: '#ef7777', success: '#78bb87', 'graph-bg': '#181818', 'graph-grid': '#262626' };
export const THEME_TOKENS = Object.keys(dark) as (keyof typeof dark)[];
export type Theme = { version: 1; name: string; colorScheme: 'dark' | 'light'; colors: typeof dark };
export const THEME_MAX_BYTES = 65536;

export function validateTheme(value: unknown): Theme {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!object(value)) throw Error('Theme must be an object');
  for (const key of Object.keys(value)) if (!['version','name','colorScheme','colors'].includes(key)) throw Error(`Unknown field: ${key}`);
  if (value.version !== 1) throw Error('version must be 1');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80 || /[\x00-\x1f]/.test(value.name)) throw Error('name must contain 1–80 printable characters');
  if (value.colorScheme !== 'light' && value.colorScheme !== 'dark') throw Error('colorScheme must be light or dark');
  if (!object(value.colors)) throw Error('colors must be an object');
  for (const key of Object.keys(value.colors)) if (!THEME_TOKENS.includes(key as keyof typeof dark)) throw Error(`Unknown colors.${key}`);
  const colors = {} as typeof dark;
  for (const key of THEME_TOKENS) { const color = value.colors[key]; if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) throw Error(`colors.${key} must be a six-digit hexadecimal color`); colors[key] = color.toLowerCase(); }
  return { version: 1, name: value.name.trim(), colorScheme: value.colorScheme, colors };
}

export function parseTheme(text: string): Theme {
  if (new TextEncoder().encode(text).length > THEME_MAX_BYTES) throw Error('Theme exceeds 64 KiB');
  let value: unknown; try { value = JSON.parse(text); } catch { throw Error('Invalid JSON'); }
  return validateTheme(value);
}
