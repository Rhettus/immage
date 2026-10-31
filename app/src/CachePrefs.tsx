// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Preferences' Cache card: how much disk the thumbnail and Immich caches
// may take (src-tauri/src/cache.rs), a bar of what each holds, and
// emptying one
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Trash } from "lucide-react";
import { PrefCard, PrefRow } from "./PrefsUI";

type Limits = { thumbs: number; immichThumbs: number; immichOriginals: number };
type Which = keyof Limits;

const MB = 1024 * 1024;
const GB = 1024 * MB;
// the same as cache.rs's DEFAULT_LIMITS, which apply until these are sent
const DEFAULTS: Limits = { thumbs: GB, immichThumbs: 512 * MB, immichOriginals: 10 * GB };
export const SIZES: Record<Which, number[]> = {
  thumbs: [256 * MB, 512 * MB, GB, 2 * GB, 5 * GB, 10 * GB],
  immichThumbs: [128 * MB, 256 * MB, 512 * MB, GB, 2 * GB],
  immichOriginals: [2 * GB, 5 * GB, 10 * GB, 20 * GB, 50 * GB],
};
const ROWS: [Which, string, string][] = [
  ["thumbs", "Library thumbnails",
   "so a folder seen before opens at once; a thumbnail is made again after an edit. past the limit, those not looked at longest go first. none is kept with under 5 GB free"],
  ["immichThumbs", "Immich thumbnails",
   "search results scrolled through. past the limit, those not looked at longest go first. none is kept with under 5 GB free"],
  ["immichOriginals", "Immich originals",
   "photos opened from Immich; one you have edited is kept whatever the limit, as its edit is beside it"],
];

const LIMITS_KEY = "immage.cacheLimits";
export function loadLimits(): Limits {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LIMITS_KEY) ?? "{}") }; } catch { return DEFAULTS; }
}

export async function storeLimits(limits: Limits) {
  await invoke("cache_limits", { limits });
  localStorage.setItem(LIMITS_KEY, JSON.stringify(limits));
}

// the stored limits to the caches; at startup and on each change
export function applyCacheLimits(limits = loadLimits()) {
  invoke("cache_limits", { limits }).catch(() => {});
}

const size = (n: number) => (n >= GB ? `${+(n / GB).toFixed(1)} GB` : `${Math.round(n / MB)} MB`);

// a cache past nine tenths is full and letting its oldest entries go to
// make room: cache.rs evicts down to that, so one in use sits above it
const FULL = 0.9;

function UsageBar({ used, limit, title }: { used: number | null; limit: number; title: string }) {
  const part = used === null ? 0 : Math.min(1, used / limit);
  return (
    <span className={`cache-bar${used !== null && used >= FULL * limit ? " full" : ""}`} title={title}>
      <span style={{ width: `${part * 100}%` }} />
    </span>
  );
}

export function CachePrefs() {
  const [limits, setLimits] = useState(loadLimits);
  const [usage, setUsage] = useState<Limits | null>(null);
  const measure = () => invoke<Limits>("cache_usage").then(setUsage).catch(() => {});
  useEffect(() => { void measure(); }, []);
  const choose = (which: Which, v: number) => {
    const next = { ...limits, [which]: v };
    setLimits(next);
    try { localStorage.setItem(LIMITS_KEY, JSON.stringify(next)); } catch { /* not kept */ }
    // a lower limit evicts at once, which the usage then shows
    void invoke("cache_limits", { limits: next }).then(measure).catch(() => {});
  };
  // what the cache holds of its limit, then what it is for
  const tip = (which: Which, hint: string) =>
    `${usage ? `${size(usage[which])} of ${size(limits[which])}` : "measuring…"}. ${hint}`;
  return (
    <PrefCard title="Cache">
      <div className="cache-rows">
        {ROWS.map(([which, label, hint]) => (
          <PrefRow key={which} label={label} title={tip(which, hint)}>
            <UsageBar used={usage?.[which] ?? null} limit={limits[which]} title={tip(which, hint)} />
            <select className="field cache-size" value={limits[which]} onChange={(e) => choose(which, Number(e.target.value))}>
              {[...new Set([...SIZES[which], limits[which]])].sort((a, b) => a - b)
                .map((v) => <option key={v} value={v}>{size(v)}</option>)}
            </select>
            <button className="tool" style={{ marginLeft: 8 }} disabled={!usage?.[which]} title={`clear ${label.toLowerCase()}`}
                    onClick={() => void invoke("cache_clear", { which }).then(measure)}>
              <Trash className="icon" strokeWidth={1.8} /></button>
          </PrefRow>
        ))}
      </div>
    </PrefCard>
  );
}
