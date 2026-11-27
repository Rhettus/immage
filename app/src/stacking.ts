// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

export type StackItem = { imgid: number; path: string; filename: string };

export type StackBadge = {
  key: string;             // lowercase path without extension (same as pairKey)
  expanded: boolean;
  count: number;           // total files in this stack (head + companions >= 2)
  position: "collapsed" | "head" | "member" | "tail";
  headId: number;          // primary RAW's imgid
  memberIds: number[];     // [head.imgid, ...companions.map(c => c.imgid)]
  types: string;           // e.g. "ORF+JPG" when collapsed, "ORF" or "JPG" when expanded
};

export const stackKey = (path: string) => path.replace(/\.[^./\\]+$/, "").toLowerCase();

export const fileExtUpper = (filename: string) => (filename.match(/\.([^.]+)$/)?.[1] ?? "").toUpperCase();

export function buildStackView<T extends StackItem>(
  passing: readonly T[],
  allPartners: ReadonlyMap<number, readonly T[]>,
  expandedStacks: ReadonlySet<string>,
  isStackedUnread: (item: T) => boolean = () => false,
): {
  shown: T[];
  collapsedPartners: Map<number, T[]>;
  badges: Map<number, StackBadge>;
} {
  const shown: T[] = [];
  const collapsedPartners = new Map<number, T[]>();
  const badges = new Map<number, StackBadge>();

  const handledCompanionIds = new Set<number>();
  for (const item of passing) {
    const companions = allPartners.get(item.imgid);
    if (companions && companions.length > 0) {
      for (const c of companions) {
        handledCompanionIds.add(c.imgid);
      }
    }
  }

  for (const item of passing) {
    if (handledCompanionIds.has(item.imgid) || isStackedUnread(item)) {
      continue;
    }
    const companions = allPartners.get(item.imgid);
    if (companions && companions.length > 0) {
      const key = stackKey(item.path);
      const members = [item, ...companions];
      const memberIds = members.map((m) => m.imgid);

      if (expandedStacks.has(key)) {
        shown.push(item);
        for (const c of companions) {
          shown.push(c);
        }
        badges.set(item.imgid, {
          key,
          expanded: true,
          count: members.length,
          position: "head",
          headId: item.imgid,
          memberIds,
          types: fileExtUpper(item.filename),
        });
        for (let idx = 0; idx < companions.length; idx++) {
          const c = companions[idx];
          const position = idx === companions.length - 1 ? "tail" : "member";
          badges.set(c.imgid, {
            key,
            expanded: true,
            count: members.length,
            position,
            headId: item.imgid,
            memberIds,
            types: fileExtUpper(c.filename),
          });
        }
      } else {
        shown.push(item);
        collapsedPartners.set(item.imgid, [...companions]);
        badges.set(item.imgid, {
          key,
          expanded: false,
          count: members.length,
          position: "collapsed",
          headId: item.imgid,
          memberIds,
          types: members.map((m) => fileExtUpper(m.filename)).join("+"),
        });
      }
    } else {
      shown.push(item);
    }
  }

  return { shown, collapsedPartners, badges };
}

export function toggleStackKey(expanded: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(expanded);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
}

export function selectionAfterCollapse(
  selection: ReadonlySet<number>,
  anchor: number | null,
  memberIds: readonly number[],
  headId: number,
): { selection: Set<number>; anchor: number | null } {
  const companions = new Set(memberIds.filter((id) => id !== headId));
  const next = new Set(selection);
  let hasCompanionSelected = false;
  for (const id of companions) {
    if (next.has(id)) {
      hasCompanionSelected = true;
      break;
    }
  }

  let nextAnchor = anchor;
  if (hasCompanionSelected) {
    for (const id of companions) {
      next.delete(id);
    }
    next.add(headId);
    if (anchor !== null && companions.has(anchor)) {
      nextAnchor = headId;
    }
  } else {
    if (anchor !== null && companions.has(anchor)) {
      nextAnchor = headId;
    }
  }

  return { selection: next, anchor: nextAnchor };
}

// the stacked companions among photos about to be moved or copied: those
// that came only as a collapsed raw's partners. they go too when any of them
// passes the file-type filter, so filtering to raws leaves them behind
export function movedCompanions<T extends StackItem>(
  all: readonly T[],
  collapsedPartners: ReadonlyMap<number, readonly T[]>,
  passesKinds: (item: T) => boolean,
): { companions: T[]; include: boolean } {
  const behind = new Set(all.flatMap((i) => collapsedPartners.get(i.imgid) ?? []).map((p) => p.imgid));
  const companions = all.filter((i) => behind.has(i.imgid));
  return { companions, include: companions.some(passesKinds) };
}
