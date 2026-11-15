// SPDX-License-Identifier: GPL-3.0-or-later
import type { ImageEntry } from "./library";
import type { Filter } from "./filter";
// Native Immich mapping canonicalizes an existing file inside its mapped root.
// Merge only an exact indexed path, and keep virtual copies separate. This is
// identity of a local path, not proof that server and local bytes are equal.
export function searchIdentity(source: "local" | "immich", image: ImageEntry): string | null {
  if (source === "immich") return image.remote?.localPath ? `path:${image.remote.localPath}`
    : image.remote ? `immich:${image.remote.assetId}` : null;
  if (!image.localIndex) return null;
  return image.copy ? `variant:${image.localIndex.variantId}` : `path:${image.path}`;
}
export function remoteFieldsKnown(f: Filter): boolean {
  return f.rejected === "all" && f.edited === "all" && f.labels === 0 && !f.unlabeled
    && f.bodies.length === 0 && f.keywords.length === 0;
}

// Source pagination must preserve a cell already opened/resolved or edited in
// this query. Starting a new query publishes an empty list first, clearing it.
export function preserveSearchEntries(incoming: ImageEntry[], current: ImageEntry[]): ImageEntry[] {
  const key=(i:ImageEntry)=>i.localIndex ? `local:${i.localIndex.variantId}`
    : i.remote ? `immich:${i.remote.assetId}` : `session:${i.imgid}`;
  const known=new Map(current.map(i=>[key(i),i]));
  return incoming.map(i=>known.get(key(i)) ?? i);
}
