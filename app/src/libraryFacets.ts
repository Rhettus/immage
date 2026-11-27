// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Find's value lists for Search in = All folders: every kind, keyword, camera,
// body, lens, month and exposure setting the library holds, counted by the
// `find_facets` command (over the local morfPhoto copy and Immage's photo cache)
// instead of from the result pages the grid has loaded. This folder keeps the
// lists of the shown photos (filter.ts `facets`).
import { useEffect, useRef, useState } from "react";
import { commands, type FacetReply } from "./commands";
import type { Facets, Filter } from "./filter";
import type { CategoryKey } from "./findModel";
import { nativeSearchArgs, type ImmichSearch } from "./immich";
import { nextRequestId } from "./localSearch";

export type LibraryFacets = Partial<Facets>;

// the lists each editor shows, so a request counts only what is open
const LISTS: Partial<Record<CategoryKey, (keyof Facets)[]>> = {
  kinds: ["kinds"], keywords: ["keywords"], cameras: ["cameras"], bodies: ["bodies"], lenses: ["lenses"],
  exposure: ["iso", "aperture", "focal", "shutter"], taken: ["months"],
};

const DEBOUNCE_MS = 250;

// The library's lists for the open editor, while Search in is All folders and
// `on`. A newer request cancels the one it replaces; the lists of the last
// reply stay until the next arrives, and `busy` says one is on its way.
export function useLibraryFacets(on: boolean, open: CategoryKey | null, f: Filter, s: ImmichSearch) {
  const [lists, setLists] = useState<LibraryFacets | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(0);
  const wanted = on && open ? LISTS[open] : undefined;
  // what a request depends on: not the words typed, which do not narrow the lists
  const args = wanted ? JSON.stringify([wanted, f, { ...nativeSearchArgs(s, null), text: "", next: null, size: null }]) : "";
  useEffect(() => {
    if (!wanted) {
      setBusy(false);
      return;
    }
    // feedback before anything is awaited
    setBusy(true);
    const [lists, filters, remote] = JSON.parse(args);
    const timer = setTimeout(() => {
      const id = nextRequestId();
      inFlight.current = id;
      commands.findFacets({ scope: "library", folder: null, recursive: false, filters, remote, lists }, id)
        .then((reply) => {
          if (inFlight.current !== id) return;
          setLists((old) => ({ ...old, ...fromReply(reply, lists) }));
          setBusy(false);
        })
        .catch(() => { if (inFlight.current === id) setBusy(false); });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      const id = inFlight.current;
      if (id) {
        inFlight.current = 0;
        void commands.localSearchCancel(id).catch(() => {});
      }
    };
  }, [args]);
  return { lists: on ? lists : null, busy: on && busy };
}

function fromReply(reply: FacetReply, lists: (keyof Facets)[]): LibraryFacets {
  const out: LibraryFacets = {};
  for (const k of lists) out[k] = reply[k];
  return out;
}

// how many values a list draws before the find box is the way to the rest
export const MOST_USED = 200;

const collator = new Intl.Collator();

// What a list draws: its values holding the find words, the chosen ones always
// among them, and past MOST_USED the most used (ties in list order). `cut` says
// values were left out. `byName` sorts what is drawn as the reader's language does.
export function shownValues(items: [string, number][], chosen: string[], words: string, show: (v: string) => string,
                            byName: boolean): { shown: [string, number][]; cut: boolean } {
  const have = new Set(items.map(([v]) => v));
  // a chosen value the photos no longer have stays to untick
  const all: [string, number][] = [...chosen.filter((c) => !have.has(c)).map((c) => [c, 0] as [string, number]), ...items]
    .filter(([v]) => !words || show(v).toLowerCase().includes(words));
  const order = (list: [string, number][]) => byName ? [...list].sort(([a], [b]) => collator.compare(a, b)) : list;
  if (all.length <= MOST_USED) return { shown: order(all), cut: false };
  const picked = new Set(chosen);
  const room = Math.max(0, MOST_USED - all.filter(([v]) => picked.has(v)).length);
  const top = all.map((x, i) => [x, i] as const).filter(([[v]]) => !picked.has(v))
    .sort(([[, a], i], [[, b], j]) => b - a || i - j).slice(0, room);
  const keep = new Set([...top.map(([, i]) => i), ...all.flatMap(([v], i) => picked.has(v) ? [i] : [])]);
  return { shown: order(all.filter((_, i) => keep.has(i))), cut: true };
}
