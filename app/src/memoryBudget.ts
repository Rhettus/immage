import { invoke } from "@tauri-apps/api/core";

// the sizes Immage's page-side caches may use, from the computer's memory and
// the Memory level (Preferences); the numbers come from the Rust layer, so
// the render caches, the viewer's frames and the thumbnails share one budget.
// until the first answer, the sizes the app used before there was a budget
export interface MemoryBudget {
  totalMb: number; level: string; budgetMb: number; frameCacheMb: number; thumbMemoryMb: number;
}

let budget: MemoryBudget | null = null;

export function refreshMemoryBudget(): Promise<MemoryBudget | null> {
  return invoke<MemoryBudget>("memory_budget").then((b) => (budget = b)).catch(() => budget);
}
export const loadFrameCacheMb = () => budget?.frameCacheMb ?? 256;
export const loadThumbMemoryMb = () => budget?.thumbMemoryMb ?? 1024;
export const currentMemoryBudget = () => budget;
