// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the saved filters of the Find popup: a name and the whole Find state, kept
// as a settings list (so Preferences' backup already covers them) and read
// live by every component that shows them
import { useSyncExternalStore } from "react";
import { settings } from "./settings";
import { normalizeFind, type FindState, type Reach, type SavedFilter } from "./findModel";

const KEY = "immage.savedFilters";

let cache: { raw: string | null; list: SavedFilter[] } = { raw: null, list: [] };
const listeners = new Set<() => void>();

export function loadSaved(): SavedFilter[] {
  let raw: string | null;
  try { raw = settings.get(KEY); } catch { raw = null; }
  if (raw === cache.raw) return cache.list;
  const list: SavedFilter[] = [];
  try {
    const v = JSON.parse(raw ?? "[]");
    if (Array.isArray(v)) for (const e of v) {
      if (!e || typeof e !== "object" || typeof e.id !== "string" || !e.id || typeof e.name !== "string" || !e.name.trim()) continue;
      list.push({ id: e.id, name: e.name.trim(), state: normalizeFind(e.state) });
    }
  } catch { /* none saved */ }
  cache = { raw, list };
  return list;
}

export function storeSaved(list: SavedFilter[]) {
  try { settings.set(KEY, JSON.stringify(list)); } catch { /* not kept */ }
  for (const l of [...listeners]) l();
}

// calls back when the list changes; returns the way to stop
export function subscribeSaved(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export const useSaved = (): SavedFilter[] => useSyncExternalStore(subscribeSaved, loadSaved);

const newId = () => globalThis.crypto?.randomUUID?.() ?? `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function addSaved(name: string, state: FindState): SavedFilter {
  const f: SavedFilter = { id: newId(), name: name.trim() || "Filter", state: normalizeFind(state) };
  storeSaved([...loadSaved(), f]);
  return f;
}

const change = (id: string, fn: (f: SavedFilter) => SavedFilter) =>
  storeSaved(loadSaved().map((f) => (f.id === id ? fn(f) : f)));

export const updateSaved = (id: string, state: FindState) => change(id, (f) => ({ ...f, state: normalizeFind(state) }));

export function renameSaved(id: string, name: string) {
  const n = name.trim();
  if (n) change(id, (f) => ({ ...f, name: n }));
}

export const deleteSaved = (id: string) => storeSaved(loadSaved().filter((f) => f.id !== id));

export function moveSaved(id: string, toIndex: number) {
  const list = [...loadSaved()];
  const from = list.findIndex((f) => f.id === id);
  if (from < 0) return;
  const [f] = list.splice(from, 1);
  list.splice(Math.max(0, Math.min(list.length, toIndex)), 0, f);
  storeSaved(list);
}

// Alt+1 to Alt+9: by code, as Option types characters on macOS
export function savedForDigit(code: string): SavedFilter | undefined {
  const m = /^Digit([1-9])$/.exec(code);
  return m ? loadSaved()[Number(m[1]) - 1] : undefined;
}

// the locale key of the note to show when a saved filter's Immich part was
// skipped because the server is not available
export const skippedNote = (r: Reach): string | null => (r.skipped ? "library.find.saved.immichSkipped" : null);
