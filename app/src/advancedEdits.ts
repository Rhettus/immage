// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Simple's badge for Advanced edits: instances on and changed from
// darktable's defaults that no Simple slider shows (a second instance, a
// module Simple has no map for), counted per Adjustments group
import type { Instance, ModuleState } from "./commands";
import { LAYOUTS, shows } from "./advancedLayout";
import { mapsFor } from "./manifest";

type Inst = Pick<Instance, "op" | "priority" | "name" | "hand_edited" | "enabled" | "changed" | "owner">;

// Simple drives the module's first instance, or the instance its map names
// (B&W's "channelmixerrgb#bw")
export const simpleShows = (i: Inst) =>
  i.priority === 0 && mapsFor(i.op).length > 0 || i.hand_edited && mapsFor(`${i.op}#${i.name}`).length > 0;

// group id -> how many such instances its cards hold. masks', shared and
// looks' instances belong to their tools, not to a group
export function advancedEdits(list: Inst[]): Map<string, number> {
  const n = new Map<string, number>();
  for (const i of list) {
    if (i.owner !== null || !i.enabled || !i.changed || simpleShows(i)) continue;
    const l = LAYOUTS.find((x) => x.op === i.op && shows(x, i));
    if (l) n.set(l.group, (n.get(l.group) ?? 0) + 1);
  }
  return n;
}

// Copy Settings' Advanced modules: the same instances, on or off, except
// those darktable's own copy leaves out (per-camera, hidden, deprecated:
// `copyable`) and those with a drawn mask, whose shapes are this photo's
export const advancedCopies = (list: Instance[]) =>
  list.filter((i) => i.owner === null && i.changed && i.copyable && !i.masked && !simpleShows(i));

// one copied instance: its whole state, as module_state replies it
export type AdvancedCopy = { op: string; priority: number; name: string; state: ModuleState };

// the instance of the target's `list` a copy pastes onto, as darktable's
// paste picks it (history.c, _merge_target): one with the same name, else an
// unnamed one with the same priority; none means a new instance. a tool's
// instance, a masked one or one already pasted onto is never picked
export function pasteTarget(list: Instance[], c: AdvancedCopy, used: Set<string>) {
  const free = list.filter((i) => i.op === c.op && i.owner === null && !i.masked && !used.has(`${i.op}#${i.priority}`));
  return (c.name ? free.find((i) => i.hand_edited && i.name === c.name) : undefined)
    ?? free.find((i) => !i.hand_edited && i.priority === c.priority);
}
