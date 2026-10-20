// Preferences' Cache card: how much disk the thumbnail and Immich caches
// may take (src-tauri/src/cache.rs), what each holds, and emptying one
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PrefCard, PrefRow } from "./PrefsUI";

type Limits = { thumbs: number; immichThumbs: number; immichOriginals: number };
type Which = keyof Limits;

const MB = 1024 * 1024;
const GB = 1024 * MB;
// the same as cache.rs's DEFAULT_LIMITS, which apply until these are sent
const DEFAULTS: Limits = { thumbs: GB, immichThumbs: 512 * MB, immichOriginals: 10 * GB };
const SIZES: Record<Which, number[]> = {
  thumbs: [256 * MB, 512 * MB, GB, 2 * GB, 5 * GB, 10 * GB],
  immichThumbs: [128 * MB, 256 * MB, 512 * MB, GB, 2 * GB],
  immichOriginals: [2 * GB, 5 * GB, 10 * GB, 20 * GB, 50 * GB],
};
const ROWS: [Which, string, string][] = [
  ["thumbs", "Library thumbnails",
   "so a folder seen before opens at once; a thumbnail is made again after an edit. none is kept with under 5 GB free"],
  ["immichThumbs", "Immich thumbnails", "search results scrolled through. none is kept with under 5 GB free"],
  ["immichOriginals", "Immich originals",
   "photos opened from Immich; one you have edited is kept whatever the limit, as its edit is beside it"],
];

const LIMITS_KEY = "immage.cacheLimits";
function loadLimits(): Limits {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LIMITS_KEY) ?? "{}") }; } catch { return DEFAULTS; }
}

// the stored limits to the caches; at startup and on each change
export function applyCacheLimits(limits = loadLimits()) {
  invoke("cache_limits", { limits }).catch(() => {});
}

const size = (n: number) => (n >= GB ? `${+(n / GB).toFixed(1)} GB` : `${Math.round(n / MB)} MB`);

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
  return (
    <PrefCard title="Cache">
      {ROWS.map(([which, label, hint]) => (
        <PrefRow key={which} label={label}
                 hint={`${usage ? `${size(usage[which])} used: ` : ""}${hint}`}>
          <select className="field" style={{ width: "auto" }} value={limits[which]} onChange={(e) => choose(which, Number(e.target.value))}>
            {[...new Set([...SIZES[which], limits[which]])].sort((a, b) => a - b)
              .map((v) => <option key={v} value={v}>{size(v)}</option>)}
          </select>
          <button className="btn small" style={{ marginLeft: 8 }} disabled={!usage?.[which]}
                  onClick={() => void invoke("cache_clear", { which }).then(measure)}>Clear</button>
        </PrefRow>
      ))}
    </PrefCard>
  );
}
