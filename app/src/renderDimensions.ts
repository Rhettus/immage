// Dimensions passed to Rust's render command must be positive integer pixels.
export function renderDimensions(width: number, height: number, max: number): { width: number; height: number } {
  const w = Number.isFinite(width) ? width : 1;
  const h = Number.isFinite(height) ? height : 1;
  return {
    width: Math.max(1, Math.min(max, Math.round(w))),
    height: Math.max(1, Math.min(max, Math.round(h))),
  };
}

export function normalizeRenderArgs<T extends Record<string, unknown>>(args: T, max: number): T {
  const width = Number(args.width);
  const height = Number(args.height);
  const dimensions = renderDimensions(width, height, max);
  return { ...args, ...dimensions };
}
