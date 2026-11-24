// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Where a folder under the morfPhoto mapping got its photos, and when the
// local copy of the catalog changed under the open folder. Pure, for tests.

// the engine's "folder-source" event, sent after the photos are published:
// the mapped root, whether its drive is known to be offline, and whether the
// photos are the local copy of the catalog because the server did not answer
// (`syncedAt`, seconds since the epoch, says how fresh it is)
export type FolderSource = { root: string; offline: boolean; localCopy: boolean; syncedAt: number | null };

// the engine's "mirror-changed" event: the local directories whose photos
// changed, or `all` when there were too many to name
export type MirrorChange = { dirs: string[]; all?: boolean };

const SEPARATORS = /[\\/]/;
const trimmed = (path: string) => (path.length > 1 ? path.replace(/[\\/]+$/, "") : path);

// whether `path` is `parent` or lies below it, by whole path parts: "/a/bc"
// is not inside "/a/b"
export function within(parent: string, path: string): boolean {
  const base = trimmed(parent);
  if (path === base) return true;
  if (!path.startsWith(base)) return false;
  return SEPARATORS.test(path.charAt(base.length)) || SEPARATORS.test(base.charAt(base.length - 1));
}

// a photo of a folder whose drive is offline, by its path
export const isOffline = (path: string, source: Pick<FolderSource, "root" | "offline"> | null): boolean =>
  !!source?.offline && within(source.root, path);

// whether a change of the local copy touches the folder shown: its own
// directory, or with its subfolders (`recursive`) a directory below it. `all`
// touches whatever is shown from the mapped root (`root`), above or below.
export function mirrorChangeTouches(folder: string | null, recursive: boolean, root: string | null,
                                    change: MirrorChange): boolean {
  if (!folder || !root) return false;
  if (change.all) return within(root, folder) || (recursive && within(folder, root));
  return change.dirs.some((dir) => trimmed(dir) === trimmed(folder) || (recursive && within(folder, dir)));
}
