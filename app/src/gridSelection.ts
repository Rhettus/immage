// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Pure helpers for Grid browsing without eagerly opening photos in the darkroom.
// Clicking or stepping with arrow keys in Grid view updates selection and the
// inspected photo (Metadata, Keywording, Copy/Paste, Export); the full darkroom
// session opens only when leaving Grid view or editing a photo.

export function gridActivePhoto<T extends { imgid: number }>(
  shown: readonly T[],
  selection: ReadonlySet<number>,
  anchor: number | null,
): T | null {
  if (!selection.size) return null;
  if (anchor !== null && selection.has(anchor)) {
    const hit = shown.find((i) => i.imgid === anchor);
    if (hit) return hit;
  }
  return shown.find((i) => selection.has(i.imgid)) ?? null;
}

export function stepGridSelection<T extends { imgid: number }>(
  shown: readonly T[],
  selection: ReadonlySet<number>,
  anchor: number | null,
  currentImgid: number | null,
  step: 1 | -1,
): T | null {
  if (!shown.length) return null;
  const activeId = gridActivePhoto(shown, selection, anchor)?.imgid ?? currentImgid;
  const at = activeId === null ? -1 : shown.findIndex((i) => i.imgid === activeId);
  if (at < 0) return step > 0 ? shown[0] : shown[shown.length - 1];
  return shown[Math.min(shown.length - 1, Math.max(0, at + step))] ?? null;
}

export function shouldOpenOnPick(grid: boolean): boolean {
  return !grid;
}

export function photoToOpenOnLeaveGrid<T extends { imgid: number }>(
  grid: boolean,
  shown: readonly T[],
  selection: ReadonlySet<number>,
  anchor: number | null,
  isOpen: (item: T) => boolean,
): T | null {
  if (!grid) return null;
  const focus = gridActivePhoto(shown, selection, anchor);
  return focus && !isOpen(focus) ? focus : null;
}
