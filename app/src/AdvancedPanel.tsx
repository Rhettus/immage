// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import { useEffect, useState } from "react";
import { Chevron, Collapse } from "./Collapse";
import { commands, type ModuleSchema } from "./commands";
import { ModuleCard } from "./ModuleCard";
import type { InstanceChoice } from "./InstanceMenu";
import type { Session } from "./session";
import { editOf, groupLayouts, layoutFor, layoutRank, shows } from "./advancedLayout";
import { AddModuleMenu } from "./AddModuleMenu";

// Advanced mode's Adjustments: the same fold-out groups as Simple, each
// holding darktable's modules as cards
export const TECHNICAL_ID = "technical";

// the module search above the groups; inert until there are modules to find
export function AdvancedSearch() {
  return (
    <div className="advanced-search">
      <input type="search" className="field" placeholder="Search modules" aria-label="Search modules" spellCheck={false} />
    </div>
  );
}

// darktable's introspection does not change between photos
const schemas = new Map<string, Promise<ModuleSchema>>();
const schemaOf = (op: string) => {
  let s = schemas.get(op);
  if (!s) { s = commands.moduleSchema(op); schemas.set(op, s); s.catch(() => schemas.delete(op)); }
  return s;
};

export type AdvancedEdit = (ids: string[], label?: string) => void;

// modules that do one job and share a card: the photo shows the one that is
// on (or, with none on, the ones it has used), and the card's switch moves
// to another
const FAMILIES: { label: string; ops: string[] }[] = [
  { label: "tone mapper", ops: ["agx", "sigmoid", "filmicrgb", "basecurve"] },
];
const familyOf = (op: string) => FAMILIES.find((f) => f.ops.includes(op));

// one group: its title row folds like Simple's (Focus mode and Alt-click
// are the caller's onToggle), with no More controls icon. with a photo open
// it holds the cards of the instances its modules have, in pipe order
export function AdvancedGroup({ id, title, open, onToggle, session, revision = 0, record, onSimple }: {
  id: string; title: string; open: boolean; onToggle: (solo: boolean) => void;
  session?: Session | null; revision?: number; record?: AdvancedEdit;
  // Simple's values set as one undo step, for a card of a Simple instance
  onSimple?: (entries: [string, number][], label: string) => void;
}) {
  const [loaded, setLoaded] = useState<{ session: Session; schemas: Map<string, ModuleSchema> } | null>(null);
  // the cards this group could show, and the data they need, once per photo
  useEffect(() => {
    if (!session) return;
    let live = true;
    void (async () => {
      const insts = await session.loadInstances();
      const found = new Map<string, ModuleSchema>();
      for (const i of insts) {
        const layout = i.owner === null ? layoutFor(i.op, id) : undefined;
        if (!layout) continue;
        // the schema even with no instance to show: Add module needs it
        found.set(i.op, await schemaOf(i.op));
        if (shows(layout, i)) await session.loadAdvanced(i.op, i.priority, layout.fields.map((f) => f.path));
      }
      if (live) setLoaded({ session, schemas: found });
    })().catch(() => {});
    return () => { live = false; };
  }, [session, id]);
  void revision;
  // a card for each instance the photo uses: on, in its history, or added or
  // changed here. the rest wait in Add module. cards follow the group's
  // curated order, a module's instances together in pipe order
  const all = session && loaded?.session === session
    ? session.instances.flatMap((i) => {
      const layout = i.owner === null ? layoutFor(i.op, id) : undefined;
      if (!layout || !shows(layout, i)) return [];
      const schema = loaded.schemas.get(i.op);
      const state = session.advanced.get(`${i.op}#${i.priority}`);
      return layout && schema && state ? [{ i, layout, schema, state }] : [];
    })
    : [];
  const shown = (c: typeof all[number]) =>
    c.state.enabled || c.i.in_history || session!.cardsShown.has(`${c.i.op}#${c.i.priority}`);
  // a family member that is off gives way to one that is on
  const familyOn = (f: { ops: string[] }) => all.some((c) => f.ops.includes(c.i.op) && c.state.enabled);
  const cards = all.filter((c) => {
    const f = familyOf(c.i.op);
    return shown(c) && (!f || c.state.enabled || !familyOn(f));
  }).sort((a, b) => layoutRank(a.i.op, id) - layoutRank(b.i.op, id));
  const familyOptions = (f: { ops: string[] }) => f.ops.flatMap((op) => {
    const l = layoutFor(op, id), first = all.find((c) => c.i.op === op && c.i.priority === 0);
    return l && first ? [{ op, title: l.title, applicable: first.i.switchable !== false }] : [];
  });
  const choices = groupLayouts(id).flatMap((l) => {
    // a named card's instance may not exist yet: the module's first says
    // whether darktable can apply it
    const first = session?.instances.find((i) => i.op === l.op && i.priority === 0);
    if (!first || !loaded || loaded.session !== session || !loaded.schemas.has(l.op) || (l.instance && !onSimple)) return [];
    // a family member counts as shown while its family's card is: the
    // card's switch is how to reach it
    const f = familyOf(l.op);
    return [{ op: l.op, title: l.title, shown: cards.some((c) => c.i.op === l.op || (!!f && f.ops.includes(c.i.op) && c.state.enabled)),
              applicable: first.switchable !== false }];
  });
  return (
    <div className="panel adjust" data-panel-id={id}>
      <div className={`panel-title${open ? " open" : ""}`} onClick={(e) => onToggle(e.altKey)}>
        <span>{title}</span>
        <Chevron open={open} />
      </div>
      <Collapse open={open}>
        <div className="panel-body">
          {cards.length === 0 && choices.length === 0 && <div className="advanced-empty">No darktable modules yet</div>}
          {cards.map(({ i, layout, schema, state }) => {
            const key = `${i.op}#${i.priority}`;
            const sib = cards.filter((c) => c.i.op === i.op).map((c) => c.i);
            const index = sib.indexOf(i);
            const onInstance = (c: InstanceChoice, name?: string) => {
              const s = session!;
              const steps: Record<InstanceChoice, string> = { new: "New instance", duplicate: "Duplicate instance",
                rename: "Rename instance", up: "Move instance", down: "Move instance", delete: "Delete instance" };
              // each action its own step, however quickly the next follows
              record?.([`adv:${key}:${c}:${performance.now()}`], `${steps[c]}: ${layout.title}`);
              if (c === "up") s.instanceAction({ action: "move", op: i.op, priority: i.priority, other: sib[index - 1].priority, after: false });
              else if (c === "down") s.instanceAction({ action: "move", op: i.op, priority: i.priority, other: sib[index + 1].priority, after: true });
              else s.instanceAction({ action: c, op: i.op, priority: i.priority, name });
            };
            return (
              <ModuleCard key={key} instance={i} layout={layout} schema={schema} state={state}
                family={(() => {
                  const f = familyOf(i.op);
                  return f && familyOptions(f).length > 1 ? { label: f.label, options: familyOptions(f), onPick: (to: string) => {
                    record?.([`adv:${key}:switch:${performance.now()}`], `Switch ${f.label}: ${layoutFor(to, id)!.title}`);
                    session!.switchModule(i.op, i.priority, to);
                  } } : undefined;
                })()}
                siblings={sib.length} index={index} fresh={session!.lastAdded === key} onInstance={onInstance}
                onField={(path, v, coalesce) => { record?.([`adv:${key}:${path}`], layout.title); const c = session!.context;
                  session!.setFields(i.op, i.priority, editOf(layout, path, v, state.params, { width: c.sensorWidth, height: c.sensorHeight }), coalesce); }}
                onEnabled={(on) => { record?.([`adv:${key}:enabled`], layout.title); session!.setAdvancedEnabled(i.op, i.priority, on); }}
                loadPresets={() => session!.loadPresets(i.op, i.priority)}
                onPreset={(name) => { record?.([`adv:${key}:preset:${performance.now()}`], `Preset: ${layout.title}`); session!.applyPreset(i.op, i.priority, name); }}
                onReset={() => { record?.([`adv:${key}:reset`], layout.title); session!.resetAdvanced(i.op, i.priority); }} />
            );
          })}
          {choices.length > 0 && (
            <AddModuleMenu group={title} choices={choices} onAdd={(op) => {
              const l = layoutFor(op, id)!;
              if (l.instance) { onSimple!(l.instance.add, `Add module: ${l.title}`); return; }
              record?.([`adv:${op}#0:add:${performance.now()}`], `Add module: ${l.title}`);
              session!.addModule(op);
            }} />
          )}
        </div>
      </Collapse>
    </div>
  );
}
