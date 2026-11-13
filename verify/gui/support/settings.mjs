// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import { until } from './webdriver.mjs';

// The app keeps its settings in settings.json in the runtime directory (the web
// view's localStorage is only read once, at the first start). Values are the
// strings localStorage held, under the same keys. Changes reach the file after
// a short batch delay, so a case that checks a saved value must wait for it.

export const SETTINGS = 'settings.json';

// the whole file as a map; null while absent or unreadable (a write in flight
// is not expected, as it is renamed into place, so retry)
export async function settingsFile(t) {
  const text = await t.runtimeRead(SETTINGS);
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// the stored string for a key, or null
export async function readSetting(t, key) {
  const map = await settingsFile(t);
  return map && typeof map[key] === 'string' ? map[key] : null;
}

// polls until ok(value) holds for the key's stored string (null if unset); returns the value
export async function waitSetting(t, key, ok, label, timeout = 15000) {
  const box = await until(async () => { const v = await readSetting(t, key); return ok(v) && { v }; }, label, timeout);
  return box.v;
}

// polls until ok(map) holds for the whole file; returns the map
export const waitSettings = (t, label, ok, timeout = 15000) =>
  until(async () => { const m = await settingsFile(t); return m && ok(m) && m; }, label, timeout);
