// SPDX-License-Identifier: GPL-3.0-or-later
import { useSyncExternalStore } from "react";
import { parseTheme, THEME_TOKENS, validateTheme, type Theme } from './themeValidation';
export { parseTheme, THEME_MAX_BYTES, THEME_TOKENS, validateTheme } from './themeValidation';
export type { Theme } from './themeValidation';

const dark = { window: '#0e0e0e', panel: '#181818', card: '#1f1f1f', inset: '#262626', hover: '#2a2a2a', text: '#f0f0f0', 'text-2': '#a3a3a3', 'text-3': '#6b6b6b', track: '#2e2e2e', thumb: '#f5f5f5', accent: '#ffffff', border: '#333333', 'on-accent': '#111111', focus: '#a3a3a3', error: '#ef7777', success: '#78bb87', 'graph-bg': '#181818', 'graph-grid': '#262626' };
export type ThemeEntry = Theme & { id: string };
export const BUILTIN_THEMES: ThemeEntry[] = [
  { id: 'dark', version: 1, name: 'Dark', colorScheme: 'dark', colors: dark },
  // darktable-elegant-grey: grey_45 background, grey_95 foreground,
  // grey_55 headers/buttons, grey_40 borders/graphs, grey_80 labels.
  { id: 'grey', version: 1, name: 'Darktable Grey', colorScheme: 'dark', colors: { ...dark, window: '#6a6a6a', panel: '#656565', card: '#848484', inset: '#6a6a6a', hover: '#ababab', text: '#f1f1f1', 'text-2': '#c6c6c6', 'text-3': '#9e9e9e', track: '#5e5e5e', thumb: '#f1f1f1', accent: '#f1f1f1', border: '#5e5e5e', 'on-accent': '#474747', focus: '#c6c6c6', 'graph-bg': '#5e5e5e', 'graph-grid': '#777777' } },
  { id: 'light', version: 1, name: 'Light', colorScheme: 'light', colors: { window: '#e5e5e5', panel: '#f4f4f4', card: '#ffffff', inset: '#e8e8e8', hover: '#d8d8d8', text: '#202020', 'text-2': '#505050', 'text-3': '#707070', track: '#cccccc', thumb: '#333333', accent: '#303030', border: '#bcbcbc', 'on-accent': '#ffffff', focus: '#555555', error: '#b32626', success: '#286b37', 'graph-bg': '#eeeeee', 'graph-grid': '#cccccc' } },
];
const KEY = 'immage.themes.v1';
let custom: ThemeEntry[] = [], selected = 'dark', revision = 0;
const listeners = new Set<() => void>();
export const themeEntries = () => [...BUILTIN_THEMES, ...custom];
export const selectedTheme = () => themeEntries().find(t => t.id === selected) ?? BUILTIN_THEMES[0];
export function applyTheme() {
  if (typeof document === 'undefined') return;
  const theme = selectedTheme();
  for (const token of THEME_TOKENS) document.documentElement.style.setProperty(`--${token}`, theme.colors[token]);
  document.documentElement.style.colorScheme = theme.colorScheme;
  document.documentElement.dataset.theme = theme.id;
}
function publish() { applyTheme(); revision++; listeners.forEach(l => l()); if (typeof window !== 'undefined') window.dispatchEvent(new Event('immage:theme-change')); }
export function loadThemes() {
  custom = []; selected = 'dark';
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (saved && Array.isArray(saved.custom)) for (const entry of saved.custom) {
      try { const { id, ...palette } = entry; if (typeof id !== 'string' || !id.startsWith('custom-') || custom.some(t => t.id === id)) continue; custom.push({ ...validateTheme(palette), id }); } catch { /* skip invalid saved palette */ }
    }
    if (typeof saved?.selected === 'string' && themeEntries().some(t => t.id === saved.selected)) selected = saved.selected;
  } catch { /* dark fallback */ }
  publish();
}
function commit(next: ThemeEntry[], id: string) { localStorage.setItem(KEY, JSON.stringify({ custom: next, selected: id })); custom = next; selected = id; publish(); }
export function selectTheme(id: string) { if (!themeEntries().some(t => t.id === id)) throw Error('Unknown theme'); commit(custom, id); }
export function importTheme(text: string) {
  const theme = parseTheme(text), base = theme.name; let n = 2;
  while (themeEntries().some(t => t.name === theme.name)) {
    const suffix = ` (${n++})`;
    theme.name = `${base.slice(0, 80 - suffix.length).trimEnd()}${suffix}`;
  }
  const id = `custom-${crypto.randomUUID()}`; commit([...custom, { ...theme, id }], id); return id;
}
export function removeTheme(id: string) { if (!custom.some(t => t.id === id)) throw Error('Only imported themes can be removed'); commit(custom.filter(t => t.id !== id), selected === id ? 'dark' : selected); }
export function useThemes() { return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l); }; }, () => revision); }
