// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// A photo's id belongs to one listing: a refresh, a lazy import or a rename can
// hand the same photo another id. The selection and the pick anchor follow the
// photo by its identity (path and version) so the grid cursor stays on it.

type Listed = { imgid: number; path: string; version?: number };

export const photoKey = (photo: { path: string; version?: number }) => JSON.stringify([photo.path, photo.version ?? 0]);

export type Followed = { keys: Map<number, string>; wanted: Map<string, number>; anchorKey: string | null };

export const NO_FOLLOW: Followed = { keys: new Map(), wanted: new Map(), anchorKey: null };

// `wanted` holds identities a rename moved the selection to, with the time
// they stop being waited for, in case the listing has not reached them yet
export function followSelection(
  shown: readonly Listed[], selection: ReadonlySet<number>, anchor: number | null, followed: Followed, now: number,
): { selection: Set<number>; anchor: number | null; followed: Followed; changed: boolean } {
  const ids = new Set(shown.map((i) => i.imgid));
  const byKey = new Map(shown.map((i) => [photoKey(i), i.imgid]));
  const keyOf = (id: number) => followed.keys.get(id);
  const resolve = (id: number) => ids.has(id) ? id : byKey.get(keyOf(id) ?? "") ?? null;
  const next = new Set<number>();
  for (const id of selection) {
    const to = resolve(id);
    if (to !== null) next.add(to);
  }
  const wanted = new Map<string, number>();
  for (const [key, until] of followed.wanted) {
    const id = byKey.get(key);
    if (id !== undefined) next.add(id);
    else if (until > now) wanted.set(key, until);
  }
  let nextAnchor = anchor;
  if (anchor !== null) {
    nextAnchor = resolve(anchor);
    if (nextAnchor === null && followed.anchorKey && wanted.has(followed.anchorKey)) nextAnchor = null;
  }
  if (nextAnchor === null && followed.anchorKey) nextAnchor = byKey.get(followed.anchorKey) ?? null;
  const keys = new Map<number, string>();
  for (const photo of shown) if (next.has(photo.imgid) || photo.imgid === nextAnchor) keys.set(photo.imgid, photoKey(photo));
  const anchorKey = nextAnchor !== null ? keys.get(nextAnchor) ?? null : wanted.size ? followed.anchorKey : null;
  const same = next.size === selection.size && [...next].every((id) => selection.has(id)) && nextAnchor === anchor;
  return { selection: next, anchor: nextAnchor, followed: { keys, wanted, anchorKey }, changed: !same };
}

// the identities the selection moves to when a rename moves its files
export function followRename(
  followed: Followed, selected: readonly Listed[], anchor: Listed | undefined,
  moved: ReadonlyMap<string, string>, until: number,
): Followed {
  const target = (photo: Listed) => photoKey({ path: moved.get(photo.path) ?? photo.path, version: photo.version });
  const wanted = new Map(followed.wanted);
  for (const photo of selected) wanted.set(target(photo), until);
  return { keys: followed.keys, wanted, anchorKey: anchor ? target(anchor) : null };
}
