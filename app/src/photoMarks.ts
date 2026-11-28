// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { isRemote } from "./immich";
import { isPicked, LABEL_COLORS, type ImageEntry } from "./library";

export const MARK_STARS = [1, 2, 3, 4, 5];
export type PhotoMark = { type: "rating" | "label"; value: number } | { type: "pick" } | { type: "reject" };
export type MarkState = boolean | "mixed";

export function markTargets(
  photos: readonly ImageEntry[],
  companions: ReadonlyMap<number, readonly ImageEntry[]>,
) {
  const targets = new Map<number, ImageEntry>();
  for (const photo of photos) {
    if (isRemote(photo)) continue;
    targets.set(photo.imgid, photo);
    for (const partner of companions.get(photo.imgid) ?? []) {
      if (!isRemote(partner)) targets.set(partner.imgid, partner);
    }
  }
  return [...targets.values()];
}

function ratingIs(photo: ImageEntry, value: number) {
  return !photo.rejected && photo.rating === value;
}

function state(total: number, matching: number): MarkState {
  return matching === 0 ? false : matching === total ? true : "mixed";
}

export function summarizeMarks(photos: readonly ImageEntry[]) {
  const ratings = [0, 0, 0, 0, 0, 0];
  const labels = LABEL_COLORS.map(() => 0);
  let picked = 0;
  let rejected = 0;
  for (const photo of photos) {
    if (photo.rejected) rejected++;
    else if (photo.rating >= 1 && photo.rating <= 5 && Number.isInteger(photo.rating)) ratings[photo.rating]++;
    if (isPicked(photo)) picked++;
    for (let k = 0; k < labels.length; k++) {
      if (photo.labels & (1 << k)) labels[k]++;
    }
  }
  const total = photos.length;
  return {
    disabled: total === 0,
    stars: MARK_STARS.map((n) => ({
      exact: state(total, ratings[n]),
      fill: state(total, ratings.slice(n).reduce((sum, count) => sum + count, 0)),
    })),
    labels: labels.map((count) => state(total, count)),
    picked: state(total, picked),
    rejected: state(total, rejected),
  };
}
export type MarkSummary = ReturnType<typeof summarizeMarks>;

export function markEdits(photos: readonly ImageEntry[], mark: Exclude<PhotoMark, { type: "pick" }>) {
  const patch: (photo: ImageEntry) => Partial<ImageEntry> = (() => {
    switch (mark.type) {
      case "rating": {
        const rating = photos.every((photo) => ratingIs(photo, mark.value)) ? 0 : mark.value;
        return () => ({ rating, rejected: false });
      }
      case "label": {
        const bit = mark.value;
        const clear = photos.every((photo) => (photo.labels & bit) !== 0);
        return (photo) => ({ labels: clear ? photo.labels & ~bit : photo.labels | bit });
      }
      case "reject": {
        const rejected = !photos.every((photo) => photo.rejected);
        return () => ({ rejected });
      }
    }
  })();
  return photos.map((photo) => ({ imgid: photo.imgid, fields: patch(photo) }));
}
