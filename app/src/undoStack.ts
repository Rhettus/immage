// SPDX-License-Identifier: GPL-3.0-or-later
// The undo stack's pure steps, kept apart from App.tsx so they can be tested.
// Each returns the steps it dropped, which the caller releases.

export type UndoStack<T> = { past: T[]; future: T[]; key: string; at: number };

export const UNDO_LIMIT = 200;

// darktable's truncate (ctrl+click compress): the steps above the current one
// (redo) go, those below stay undoable
export function truncateRedo<T>(u: UndoStack<T>): T[] {
  const dropped = u.future;
  u.future = [];
  u.key = "";
  return dropped;
}

// Start over: one step carrying a batch snapshot, which redo no longer
// follows. past is kept to UNDO_LIMIT
export function pushBatchStep<T extends { batch?: { token: number; recovery: boolean } }>(
  u: UndoStack<T>, before: T, batch: { token: number; recovery: boolean }): T[] {
  const dropped = truncateRedo(u);
  before.batch = batch;
  u.past.push(before);
  if (u.past.length > UNDO_LIMIT) dropped.push(...u.past.splice(0, 1));
  return dropped;
}
