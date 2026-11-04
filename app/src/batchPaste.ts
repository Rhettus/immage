// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import { invoke } from "@tauri-apps/api/core";
import type { Clip } from "./CopySettings";
import { Session, instanceKey, mapOpOf } from "./session";
import { CONVERSIONS } from "./manifest";
import { NO_REFINE, type Mask } from "./masks";

export type PasteTarget = { imgid: number; path: string };
export type PasteUpdate = { imgid: number; edited: boolean; error: string | null };

// Deliberately do not expand RAW/JPEG partners: a paste changes exactly the
// selected versions. Remote results without a local engine id are skipped.
export function pasteTargets<T extends PasteTarget>(images: T[], selection: Set<number>, current: T | null,
                                                   remote: (image: T) => boolean) {
  const chosen = selection.size ? images.filter(i => selection.has(i.imgid)) : current ? [current] : [];
  return { targets: [...new Map(chosen.filter(i => !remote(i)).map(i => [i.imgid, i])).values()],
    skipped: chosen.filter(remote).length };
}

export function replaceMasks(s: Session, target: Mask[]) {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  for (const m of s.masks) if (!target.some(t => t.name === m.name)) s.deleteMask(m.name);
  for (const t of target) {
    const c = s.masks.find(m => m.name === t.name);
    if (!c) s.addMask(t.name, t.shapes);
    else if (!same(c.shapes, t.shapes)) s.setShapes(t.name, t.shapes);
    if ((c?.invert ?? false) !== t.invert) s.setInvert(t.name, t.invert);
    if ((c?.opacity ?? 100) !== (t.opacity ?? 100)) s.setOpacity(t.name, t.opacity ?? 100);
    if (!!c?.hidden !== !!t.hidden) s.setHidden(t.name, !!t.hidden);
    if (!same(c?.refine ?? NO_REFINE, t.refine ?? NO_REFINE)) s.setRefine(t.name, t.refine ?? NO_REFINE);
    for (const id of new Set([...Object.keys(c?.values ?? {}), ...Object.keys(t.values)]))
      if ((c?.values[id] ?? 0) !== (t.values[id] ?? 0)) s.setLocal(t.name, id, t.values[id] ?? 0);
  }
}

// Both single-image paste and batches use the same mappings and special cases.
export function applyClip(s: Session, c: Clip, reapplyLook = false) {
  if (c.look?.name && !c.look.path && (reapplyLook || c.look.name !== s.look))
    throw Error(`the look "${c.look.name}" is unavailable; restore its style file before pasting`);
  s.endBaseline();
  // a negative's conversion or a film simulation, pasted onto a photo
  // without it, turns off the modules it replaces that no slider covers
  const converts = CONVERSIONS.filter((v) => c.values[v.flag] === 1 && s.values[v.flag] !== 1);
  s.setMany(Object.entries(c.values));
  if (converts.length) {
    const done = new Set<string>();
    for (const h of s.history) {
      const key = instanceKey(h), op = mapOpOf(h);
      if (done.has(key) || h.priority === undefined || h.masked) continue;
      if (!converts.some((v) => v.unmapped.has(h.op) || (v.off.has(op) && s.isForeign(op)))) continue;
      done.add(key);
      if (s.moduleStates.get(key)?.enabled ?? h.enabled) s.setModuleState(h, { enabled: false });
    }
  }
  if (c.look) {
    if (c.look.name !== s.look || reapplyLook && c.look.name !== null) s.setLook(c.look.path, c.look.name);
    if (c.look.amount !== s.lookAmount) s.setLookAmount(c.look.amount);
  }
  if (c.masks) replaceMasks(s, c.masks);
}

export async function restorePaste(token: number, action: "undo" | "redo" | "abort") {
  const r = await invoke<{ updates: PasteUpdate[] }>("paste_batch", { action, token });
  return r.updates;
}

// The caller must quiesce the viewer session, block editing/navigation, and
// reopen it in finally. A failed batch rolls back all targets; failed recovery
// writes retain their snapshots so Undo can retry instead of discarding edits.
export async function runPaste(targets: PasteTarget[], clip: Clip,
                               progress: (done: number, total: number) => void,
                               saved: (update: PasteUpdate) => void,
                               prepare?: (s: Session) => Promise<void>) {
  const c = structuredClone(clip);
  if (prepare) {
    for (const [n, target] of targets.entries()) {
      progress(n, targets.length);
      const s = await Session.open(target.path, target.imgid, () => ({ width: 1, height: 1 }), () => {}, () => {}, true);
      try { await prepare(s); }
      finally { await s.close(); }
    }
  }
  const { token } = await invoke<{ token: number }>("paste_batch", { action: "begin", imgids: targets.map(i => i.imgid) });
  try {
    for (const [n, target] of targets.entries()) {
      progress(n, targets.length);
      let failure: string | null = null;
      const s = await Session.open(target.path, target.imgid, () => ({ width: 1, height: 1 }),
        () => {}, e => { failure ??= e; }, true);
      try { applyClip(s, c, true); }
      finally { await s.settled(); }
      if (failure) throw Error(failure);
      await s.close();
      if (failure) throw Error(failure);
      // close() only writes when changed. Reading the metadata covers no-op pastes too.
      const r = await invoke<{ image: { edited: boolean } }>("meta", { imgid: s.imgid });
      saved({ imgid: s.imgid, edited: r.image.edited, error: null });
    }
    await invoke("paste_batch", { action: "commit", token });
    progress(targets.length, targets.length);
    return { token, error: null as string | null, recovery: false };
  } catch (e) {
    try {
      const updates = await restorePaste(token, "abort");
      updates.forEach(saved);
      const failures = updates.filter(i => i.error);
      if (failures.length) return { token, error: `${e}; recovery failed for ${failures.length} photo(s). Undo retries recovery.`, recovery: true };
      await invoke("paste_batch", { action: "release", token });
      return { token: null, error: `${e}; batch rolled back`, recovery: false };
    } catch (recovery) {
      return { token, error: `${e}; recovery failed: ${recovery}. Undo retries recovery.`, recovery: true };
    }
  }
}
