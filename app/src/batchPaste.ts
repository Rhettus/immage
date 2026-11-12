// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import type { Clip } from "./CopySettings";
import { Session, instanceKey, mapOpOf } from "./session";
import { CONVERSIONS } from "./manifest";
import { withModel } from "./aiModel";
import { NO_REFINE, type ObjectShape, type Backdrop, type Mask } from "./masks";
import { commands, type PasteUpdate } from "./commands";

export type PasteTarget = { imgid: number; path: string };
export type { PasteUpdate } from "./commands";

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
      if (done.has(key) || h.priority == null || h.masked) continue;
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

// Recipes are required: a mask name is user-editable and cannot identify its AI tool.
export function validateAiPaste(c: Clip) {
  for (const m of c.masks ?? []) for (const shape of m.shapes)
    if (shape.type === "object" && !shape.depth && !shape.ai)
      throw Error(`mask "${m.name}" has no saved AI selection; recreate it on the source photo before copying`);
}

export async function recalculateAiMasks(c: Clip): Promise<Clip> {
  validateAiPaste(c);
  const result = structuredClone(c);
  for (const m of result.masks ?? []) for (const [i, shape] of m.shapes.entries()) {
    if (shape.type !== "object") continue;
    const recipe = shape.ai;
    const kind = shape.depth ? "depth" : recipe!.kind;
    const model = kind === "depth" ? "mask-depth-da2-small" : kind === "object" ? "mask-object-sam21-small"
      : kind === "subject" ? "mask-subject-birefnet-lite" : "mask-scene-segformer-b2";
    try {
      const select = () => kind === "depth" ? commands.aiMask(kind, shape.depth!, null, null)
        : kind === "object"
          ? commands.aiObject(recipe!.points ?? [], recipe!.box ?? null, recipe!.inset, recipe!.backdrop)
          : commands.aiMask(kind, null, recipe!.inset, recipe!.backdrop);
      const reply = await withModel(model, select) as ObjectShape["paths"] | { paths: ObjectShape["paths"]; backdrop: Backdrop | null };
      const paths = Array.isArray(reply) ? reply : reply.paths;
      if (!paths.length) throw Error("nothing found");
      const { backdrop: oldBackdrop, ...rest } = shape;
      const backdrop = Array.isArray(reply) ? null : reply.backdrop;
      m.shapes[i] = { ...rest, paths, ...(backdrop && { backdrop: { ...backdrop, off: oldBackdrop?.off } }) };
    } catch (e) { throw Error(`AI mask "${m.name}": ${e}`); }
  }
  return result;
}

export async function restorePaste(token: number, action: "undo" | "redo" | "abort") {
  const r = await commands.pasteBatch(action, token, null);
  return r.updates ?? [];
}

// The caller must quiesce the viewer session, block editing/navigation, and
// reopen it in finally. A failed batch rolls back all targets; failed recovery
// writes retain their snapshots so Undo can retry instead of discarding edits.
export async function runPaste(targets: PasteTarget[], clip: Clip,
                               progress: (done: number, total: number) => void,
                               saved: (update: PasteUpdate) => void,
                               prepare?: (s: Session) => Promise<void>) {
  const c = structuredClone(clip);
  validateAiPaste(c);
  if (prepare) {
    for (const [n, target] of targets.entries()) {
      progress(n, targets.length);
      const s = await Session.open(target.path, target.imgid, () => ({ width: 1, height: 1 }), () => {}, () => {}, true);
      try { await prepare(s); }
      finally { await s.close(); }
    }
  }
  const { token } = await commands.pasteBatch("begin", null, targets.map(i => i.imgid));
  if (token == null) throw Error("the engine gave no paste token");
  try {
    for (const [n, target] of targets.entries()) {
      progress(n, targets.length);
      let failure: string | null = null;
      const s = await Session.open(target.path, target.imgid, () => ({ width: 1, height: 1 }),
        () => {}, e => { failure ??= e; }, true);
      try {
        applyClip(s, { ...c, masks: undefined }, true);
        await s.settled();
        if (failure) throw Error(failure);
        const calculated = await recalculateAiMasks(c).catch(e => { throw Error(`${target.path}: ${e}`); });
        if (calculated.masks) replaceMasks(s, calculated.masks);
      }
      finally { await s.settled(); }
      if (failure) throw Error(failure);
      await s.close();
      if (failure) throw Error(failure);
      // close() only writes when changed. Reading the metadata covers no-op pastes too.
      const r = await commands.meta(s.imgid);
      saved({ imgid: s.imgid, edited: r.image.edited, error: null });
    }
    await commands.pasteBatch("commit", token, null);
    progress(targets.length, targets.length);
    return { token, error: null as string | null, recovery: false };
  } catch (e) {
    try {
      const updates = await restorePaste(token, "abort");
      updates.forEach(saved);
      const failures = updates.filter(i => i.error);
      if (failures.length) return { token, error: `${e}; recovery failed for ${failures.length} photo(s). Undo retries recovery.`, recovery: true };
      await commands.pasteBatch("release", token, null);
      return { token: null, error: `${e}; batch rolled back`, recovery: false };
    } catch (recovery) {
      return { token, error: `${e}; recovery failed: ${recovery}. Undo retries recovery.`, recovery: true };
    }
  }
}
