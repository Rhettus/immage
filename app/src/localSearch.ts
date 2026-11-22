// SPDX-License-Identifier: GPL-3.0-or-later
import { commands } from "./commands";
import { nativeSearchArgs, type ImmichSearch } from "./immich";
import type { Filter } from "./filter";
import type { ImageEntry } from "./library";
// the prefix of the error the engine side returns when the index is written
// during a scan or a cursor is stale (INDEX_CHANGED in local_search.rs)
export const INDEX_CHANGED = "index-changed";
export const indexChanged = (error: unknown) => String(error).includes(INDEX_CHANGED);
let requestId = 0;
export async function localSearch(q: ImmichSearch, filters: Filter, folder: string, recursive: boolean,
                                  next: string | null, signal: AbortSignal, imageVariant?: string, pendingMetadata?: Promise<unknown>[]) {
  if (pendingMetadata?.length) await Promise.allSettled(pendingMetadata);
  if (signal.aborted) throw new Error("Search cancelled");
  const id = ++requestId;
  const cancel = () => { void commands.localSearchCancel(id).catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const page = await commands.localSearch({ text: imageVariant ? "" : q.text, mode: imageVariant ? "smart" : q.mode,
      imageVariant, subject: "edited", scope: q.scope, folder: folder || null, recursive,
      filters, remote: nativeSearchArgs(q, null), next, size: 250, immichSearched: q.source === "both" }, id);
    if (signal.aborted) throw new Error("Search cancelled");
    return {
      items: page.items.map(hit => ({
        ...hit.image,
        localIndex: hit.asset_id && hit.variant_id
          ? { assetId: hit.asset_id, variantId: hit.variant_id, subject: hit.subject }
          : undefined,
      } satisfies ImageEntry)),
      next: page.next,
    };
  } finally { signal.removeEventListener("abort", cancel); }
}

export function similarSearch(form: ImmichSearch): ImmichSearch {
  return { ...form, source: "local", scope: "library", mode: "smart", text: "" };
}
