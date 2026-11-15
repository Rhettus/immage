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
