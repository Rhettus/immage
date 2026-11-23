// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Preferences' Cache card: how much disk the thumbnail and Immich caches
// may take (src-tauri/src/cache.rs), a bar of what each holds, and
// emptying one
import { useEffect, useState } from "react";
import { commands, type Limits, type Usage } from "./commands";
import { Trash } from "lucide-react";
import { PrefCard, PrefRow } from "./PrefsUI";
import { settings } from "./settings";
import { t } from "./i18n";

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
// the row's stable English name (the GUI checks find a row by it), its label and its help
const ROWS: [Which, string, string, string][] = [
  ["thumbs", "Library thumbnails", t("cache.thumbs"), t("cache.thumbs.hint")],
  ["immichThumbs", "Immich thumbnails", t("cache.immichThumbs"), t("cache.immichThumbs.hint")],
  ["immichOriginals", "Immich originals", t("cache.immichOriginals"), t("cache.immichOriginals.hint")],
];

const LIMITS_KEY = "immage.cacheLimits";
export function loadLimits(): Limits {
  try { return { ...DEFAULTS, ...JSON.parse(settings.get(LIMITS_KEY) ?? "{}") }; } catch { return DEFAULTS; }
}

export async function storeLimits(limits: Limits) {
  await commands.cacheLimits(limits);
  settings.set(LIMITS_KEY, JSON.stringify(limits));
}

// the stored limits to the caches; at startup and on each change
export function applyCacheLimits(limits = loadLimits()) {
  commands.cacheLimits(limits).catch(() => {});
}

const size = (n: number) => (n >= GB ? `${+(n / GB).toFixed(1)} ${t("unit.gb")}` : `${Math.round(n / MB)} ${t("unit.mb")}`);

// a cache past nine tenths is full and letting its oldest entries go to
// make room: cache.rs evicts down to that, so one in use sits above it
const FULL = 0.9;

// `edited` is the part of `used` that is edited photos' previews, drawn as
// a second segment at the start of the bar
function UsageBar({ used, limit, title, edited = 0 }: { used: number | null; limit: number; title: string; edited?: number }) {
  const part = used === null ? 0 : Math.min(1, used / limit);
  const share = used ? Math.min(1, edited / used) : 0;
  return (
    <span className={`cache-bar${used !== null && used >= FULL * limit ? " full" : ""}`} title={title}>
      <span style={{ width: `${part * 100}%` }}>
        {share > 0 && <span className="cache-edited" style={{ width: `${share * 100}%` }} />}
      </span>
    </span>
  );
}

export function CachePrefs() {
  const [limits, setLimits] = useState(loadLimits);
  const [usage, setUsage] = useState<Usage | null>(null);
  const measure = () => commands.cacheUsage().then(setUsage).catch(() => {});
  useEffect(() => { void measure(); }, []);
  const choose = (which: Which, v: number) => {
    const next = { ...limits, [which]: v };
    setLimits(next);
    try { settings.set(LIMITS_KEY, JSON.stringify(next)); } catch { /* not kept */ }
    // a lower limit evicts at once, which the usage then shows
    void commands.cacheLimits(next).then(measure).catch(() => {});
  };
  // what the cache holds of its limit, then what it is for
  const tip = (which: Which, hint: string) =>
    `${usage ? t("cache.usage", { used: size(usage[which]), limit: size(limits[which]) }) : t("cache.measuring")}. ${hint}`;
  return (
    <PrefCard title={t("cache.title")}>
      <div className="cache-rows">
        {ROWS.map(([which, id, label, hint]) => (
          <PrefRow key={which} id={id} label={label} summary={usage ? t("cache.usage", { used: size(usage[which]), limit: size(limits[which]) }) : t("cache.measuring")} hint={hint}>
            <UsageBar used={usage?.[which] ?? null} limit={limits[which]} title={tip(which, hint)}
                      edited={which === "thumbs" ? usage?.thumbsEdited : 0} />
            <select className="field cache-size" value={limits[which]} onChange={(e) => choose(which, Number(e.target.value))}>
              {[...new Set([...SIZES[which], limits[which]])].sort((a, b) => a - b)
                .map((v) => <option key={v} value={v}>{size(v)}</option>)}
            </select>
            <button className="tool" style={{ marginLeft: 8 }} disabled={!usage?.[which]} title={t("cache.clear", { name: label })}
                    onClick={() => void commands.cacheClear(which).then(measure)}>
              <Trash className="icon" strokeWidth={1.8} /></button>
          </PrefRow>
        ))}
        {usage && usage.thumbsEdited > 0 && (
          <div className="cache-edited-note" title={t("cache.edited.hint")}>
            <span className="cache-edited-swatch" />{t("cache.edited", { size: size(usage.thumbsEdited) })}
          </div>
        )}
      </div>
    </PrefCard>
  );
}
