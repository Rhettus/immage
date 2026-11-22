// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { parentDir, within } from "./paths";

export type LibraryJumpTarget = { path: string; dir: string; version: number };

export function showInLibraryTarget(
  hit: { imgid: number; path: string; version?: number; remote?: { localPath: string | null } } | null | undefined,
  ctx: { activeSearch: boolean; currentFolder: string | null; grid: boolean; roots: readonly string[] }
): LibraryJumpTarget | null {
  if (!hit) return null;
  let target: LibraryJumpTarget;
  if (hit.imgid < 0) {
    const localPath = hit.remote?.localPath;
    if (!localPath) return null;
    const dir = parentDir(localPath);
    if (!dir) return null;
    if (!ctx.roots.some((r) => within(dir, r))) return null;
    target = { path: localPath, dir, version: 0 };
  } else {
    const dir = parentDir(hit.path);
    if (!dir) return null;
    target = { path: hit.path, dir, version: hit.version ?? 0 };
  }

  if (!ctx.activeSearch && ctx.grid && ctx.currentFolder === target.dir) {
    return null;
  }
  return target;
}

export function canShowResultsMenu(
  immichBase: string | null,
  immichSearch: { source: "local" | "immich" | "both" } | null | undefined
): boolean {
  return Boolean(immichBase && immichSearch && immichSearch.source !== "local");
}

export function immichMenuState(args: {
  immichBase: string | null;
  immichSearch: { source: "local" | "immich" | "both" } | null | undefined;
  hit: { remote?: { assetId: string; localPath: string | null } } | null | undefined;
  photoUrl: (base: string, id: string) => string;
  searchUrl: (base: string, s: any) => string;
}): { photo: string | null; results: string | null; parentFolder: string | null | undefined } {
  return {
    photo: args.immichBase && args.hit?.remote ? args.photoUrl(args.immichBase, args.hit.remote.assetId) : null,
    results: canShowResultsMenu(args.immichBase, args.immichSearch) ? args.searchUrl(args.immichBase!, args.immichSearch!) : null,
    parentFolder: args.immichBase && args.hit?.remote ? args.hit.remote.localPath : undefined,
  };
}

export function findTargetEntry<T extends { path: string; version?: number }>(
  list: readonly T[],
  path: string,
  version: number
): T | undefined {
  return (
    list.find((i) => i.path === path && (i.version ?? 0) === version) ||
    list.find((i) => i.path === path)
  );
}
