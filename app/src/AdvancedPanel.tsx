// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import { useEffect, useState } from "react";
import { Chevron, Collapse } from "./Collapse";
import { commands, type ModuleSchema } from "./commands";
import { ModuleCard } from "./ModuleCard";
import type { InstanceChoice } from "./InstanceMenu";
import type { Session } from "./session";
import { layoutFor } from "./advancedLayout";

// Advanced mode's Adjustments: the same fold-out groups as Simple, each to
// hold darktable's modules as cards. None are there yet.
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

// one group: its title row folds like Simple's (Focus mode and Alt-click
// are the caller's onToggle), with no More controls icon. with a photo open
// it holds the cards of the instances its modules have, in pipe order
export function AdvancedGroup({ id, title, open, onToggle, session, revision = 0, record }: {
  id: string; title: string; open: boolean; onToggle: (solo: boolean) => void;
  session?: Session | null; revision?: number; record?: AdvancedEdit;
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
        if (i.owner !== null || !layoutFor(i.op, id)) continue;
        const schema = await schemaOf(i.op);
        found.set(i.op, schema);
        await session.loadAdvanced(i.op, i.priority, layoutFor(i.op, id)!.fields.map((f) => f.path));
      }
      if (live) setLoaded({ session, schemas: found });
    })().catch(() => {});
    return () => { live = false; };
  }, [session, id]);
  void revision;
  const cards = session && loaded?.session === session
    ? session.instances.flatMap((i) => {
      const layout = i.owner === null ? layoutFor(i.op, id) : undefined;
      const schema = loaded.schemas.get(i.op);
      const state = session.advanced.get(`${i.op}#${i.priority}`);
      return layout && schema && state ? [{ i, layout, schema, state }] : [];
    })
    : [];
  return (
    <div className="panel adjust" data-panel-id={id}>
      <div className={`panel-title${open ? " open" : ""}`} onClick={(e) => onToggle(e.altKey)}>
        <span>{title}</span>
        <Chevron open={open} />
      </div>
      <Collapse open={open}>
        <div className="panel-body">
          {cards.length === 0 && <div className="advanced-empty">No darktable modules yet</div>}
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
                siblings={sib.length} index={index} fresh={session!.lastAdded === key} onInstance={onInstance}
                onField={(path, v, coalesce) => { record?.([`adv:${key}:${path}`], layout.title); session!.setField(i.op, i.priority, path, v, coalesce); }}
                onEnabled={(on) => { record?.([`adv:${key}:enabled`], layout.title); session!.setAdvancedEnabled(i.op, i.priority, on); }}
                loadPresets={() => session!.loadPresets(i.op, i.priority)}
                onPreset={(name) => { record?.([`adv:${key}:preset:${performance.now()}`], `Preset: ${layout.title}`); session!.applyPreset(i.op, i.priority, name); }}
                onReset={() => { record?.([`adv:${key}:reset`], layout.title); session!.resetAdvanced(i.op, i.priority); }} />
            );
          })}
        </div>
      </Collapse>
    </div>
  );
}
