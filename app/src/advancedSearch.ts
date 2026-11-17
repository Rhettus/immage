// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Advanced mode's module search: which cards a typed text finds, by module
// title or by the label of one of its settings. pure, so the layout table and
// the group order come in as arguments
import type { ModuleLayout } from "./advancedLayout";

export type SearchHit = {
  op: string;
  group: string;
  groupTitle: string;
  title: string;
  // the first setting whose label matched, when the title did not
  setting?: string;
};

export const SEARCH_MIN = 2;
export const SEARCH_LIMIT = 12;

// titles first, then settings; each in the groups' order, and in a group the
// curated card order (the layout table's). one hit per card
export function searchModules(layouts: ModuleLayout[], groups: { id: string; title: string }[], query: string,
                              limit = SEARCH_LIMIT): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (q.length < SEARCH_MIN) return [];
  const rank = (id: string) => { const i = groups.findIndex((g) => g.id === id); return i < 0 ? groups.length : i; };
  const ordered = layouts.map((l, index) => ({ l, index }))
    .filter(({ l }) => groups.some((g) => g.id === l.group))
    .sort((a, b) => rank(a.l.group) - rank(b.l.group) || a.index - b.index);
  const byTitle: SearchHit[] = [], bySetting: SearchHit[] = [];
  for (const { l } of ordered) {
    const groupTitle = groups.find((g) => g.id === l.group)!.title;
    const hit = { op: l.op, group: l.group, groupTitle, title: l.title };
    if (l.title.toLowerCase().includes(q)) { byTitle.push(hit); continue; }
    const f = l.fields.find((x) => x.label.toLowerCase().includes(q));
    if (f) bySetting.push({ ...hit, setting: f.label });
  }
  return [...byTitle, ...bySetting].slice(0, limit);
}
