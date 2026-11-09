// SPDX-License-Identifier: GPL-3.0-or-later

// A larger processing image retains fine detail before the viewer scales it
// down. A square bound gives portrait and landscape photos the same budget;
// the engine preserves aspect ratio and never enlarges beyond native pixels.
export function settledFitView(
  viewport: { width: number; height: number },
  profile: string,
  screenScale: number,
  settled = true,
): { width: number; height: number } {
  const size = Math.max(1, Math.round(3072 * screenScale));
  return !settled || profile === "performance"
    ? { width: Math.max(1, Math.round(viewport.width * screenScale)),
      height: Math.max(1, Math.round(viewport.height * screenScale)) }
    : { width: size, height: size };
}
