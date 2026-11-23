// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import { useEffect, useMemo, useRef, useState } from "react";
import { Chevron, Collapse } from "./Collapse";
import { commands, type ModuleSchema } from "./commands";
import { ModuleCard } from "./ModuleCard";
import type { InstanceChoice } from "./InstanceMenu";
import type { Session } from "./session";
import type { Turn } from "./manifest";
import { checkerBoxPaths } from "./ModuleChecker";
import { patchPaths } from "./colorchecker";
import { clusterPaths } from "./colormapping";
import { LAYOUTS, editOf, groupLayouts, layoutPaths, layoutFor, layoutRank, shows } from "./advancedLayout";
import { searchModules, type SearchHit } from "./advancedSearch";
import { MASK_MODULES, TONE_MAPPER_OPS, localMaps, panels } from "./manifest";
import { useDismiss } from "./MasksPanel";
import { AddModuleMenu } from "./AddModuleMenu";
import { GRAPHS } from "./graphMaps";
import { MAX_NODES } from "./tonecurve";
import { isHidden, loadHiddenModules, visibleLayouts } from "./hiddenModules";
import type { ImageEntry } from "./library";
import { t } from "./i18n";
import { ModuleOrderIcon } from "./icons";
import { fieldText } from "./fieldText";
import { presetLabel } from "./presetName";

// Advanced mode's Adjustments: the same fold-out groups as Simple, each
// holding darktable's modules as cards
export const TECHNICAL_ID = "technical";

// the module search above the groups: a drop-down of the modules (by title)
// and settings (by label) it finds in every group. `applicable` says whether
// darktable can apply a module to this photo; a module it cannot, or any with
// no photo open, is greyed out
export function AdvancedSearch({ photo, applicable, reasonFor, onPick, onOrder }: {
  photo: boolean; applicable: (op: string) => boolean; reasonFor?: (op: string) => string | undefined; onPick: (hit: SearchHit) => void;
  onOrder?: () => void;   // the Module order button beside the search
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => [...panels.filter((p) => !p.hidden).map((p) => ({ id: p.id, title: p.advancedTitle ?? p.title })),
                                { id: TECHNICAL_ID, title: t("fields.advanced.technical") }], []);
  // read on each render: closing Preferences re-renders the panel
  const hidden = loadHiddenModules();
  const hits = useMemo(() => searchModules(visibleLayouts(LAYOUTS, hidden), groups, text), [groups, text, hidden]);
  const ok = (h: SearchHit) => photo && applicable(h.op);
  const close = () => { setText(""); setOpen(false); };
  useDismiss(open, () => setOpen(false), box);
  const pick = (h: SearchHit) => { if (!ok(h)) return; close(); onPick(h); };
  const move = (by: 1 | -1) => {
    for (let k = 1; k <= hits.length; k++) {
      const i = (active + by * k + hits.length * k) % hits.length;
      if (ok(hits[i])) { setActive(i); return; }
    }
  };
  return (
    <div className="advanced-search" ref={box}>
      <input type="search" className="field" placeholder={t("fields.advanced.search")} aria-label={t("fields.advanced.search")} spellCheck={false}
             value={text} role="combobox" aria-expanded={open && hits.length > 0} aria-controls="advanced-search-results"
             onChange={(e) => { setText(e.target.value); setActive(0); setOpen(true); }}
             onFocus={() => setOpen(true)}
             onKeyDown={(e) => {
               if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setOpen(true); move(e.key === "ArrowDown" ? 1 : -1); }
               else if (e.key === "Enter" && open && hits[active]) { e.preventDefault(); pick(hits[active]); }
               else if (e.key === "Escape") { e.stopPropagation(); close(); }
             }} />
      {onOrder && <button type="button" className="tool" title={t("dialogs.moduleOrder.title")} aria-label={t("dialogs.moduleOrder.title")}
                          disabled={!photo} onClick={onOrder}><ModuleOrderIcon /></button>}
      {open && hits.length > 0 && (
        <div id="advanced-search-results" className="context-menu module-menu advanced-search-results" role="listbox">
          {hits.map((h, i) => (
            <button key={`${h.group}:${h.op}:${h.title}`} type="button" role="option" aria-selected={i === active}
                    className={i === active ? "active" : ""} data-search-hit={h.op} disabled={!ok(h)}
                    title={!photo ? t("fields.advanced.openPhoto") : ok(h) ? undefined : (reasonFor?.(h.op) ?? t("fields.advanced.notApplicable"))}
                    onMouseEnter={() => { if (ok(h)) setActive(i); }}
                    onClick={() => pick(h)}>
              <span className="name">{fieldText(h.title)}{h.setting && <span className="tag"> · {fieldText(h.setting)}</span>}</span>
              <span className="tag">{fieldText(h.groupTitle)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// the search's pick of a module in a group: `nonce` tells one pick from the
// next, so the group acts on each once
export type AdvancedPick = { op: string; group: string; nonce: number };

// darktable's introspection does not change between photos
const schemas = new Map<string, Promise<ModuleSchema>>();
const schemaOf = (op: string) => {
  let s = schemas.get(op);
  if (!s) { s = commands.moduleSchema(op); schemas.set(op, s); s.catch(() => schemas.delete(op)); }
  return s;
};

export type AdvancedEdit = (ids: string[], label?: string, gesture?: number) => void;
export type ToneMapperGuardRequest = {
  current: string;
  next: string;
  onSwitch: () => void;
  onEnableAnyway: () => void;
};

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
// every field a card reads: its controls, and the curve or graph it draws.
// those must be in the card's snapshot, or an undo cannot put them back
const cardFields = (layout: NonNullable<ReturnType<typeof layoutFor>>) => {
  const c = layout.curves;
  const curve = c ? c.channels.flatMap((_, ch) => [c.count(ch), c.type(ch),
    ...Array.from({ length: MAX_NODES }, (__, k) => [c.node(ch, k, "x"), c.node(ch, k, "y")]).flat()]) : [];
  const levels = layout.levels ? [0, 1, 2].flatMap((c) => [0, 1, 2].map((k) => `levels[${c}][${k}]`)) : [];
  const b = layout.bands;
  const bands = b ? Array.from({ length: b.channels }, (_, c) => Array.from({ length: b.count }, (__, k) => [`x[${c}][${k}]`, `y[${c}][${k}]`]).flat()).flat() : [];
  return [...layout.fields.flatMap(layoutPaths), ...(layout.op === "channelmixerrgb" ? ["x", "y", ...checkerBoxPaths] : []), ...levels, ...bands, ...(layout.patches ? patchPaths() : []), ...(layout.clusters ? clusterPaths() : []), ...(layout.lensPick ? ["lens_pick"] : []), ...curve,
    ...(layout.graph ? GRAPHS[layout.graph].fields : [])];
};

export function AdvancedGroup({ id, title, open, onToggle, session, revision = 0, record, onToneMapperGuard, onSimple, onTurn, pick, onPicked, photos }: {
  id: string; title: string; open: boolean; onToggle: (solo: boolean) => void;
  session?: Session | null; revision?: number; record?: AdvancedEdit;
  onToneMapperGuard?: (req: ToneMapperGuardRequest) => void;
  // Simple's values set as one undo step, for a card of a Simple instance
  onSimple?: (entries: [string, number][], label: string) => void;
  // the toolbar's turn of the photo, for a card's turn buttons
  onTurn?: (how: Turn) => void;
  // the module search's pick, acted on once the group's modules have loaded
  pick?: AdvancedPick | null; onPicked?: (nonce: number) => void;
  // the photos of the folder being browsed, for Composite's photo
  photos?: ImageEntry[];
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
        if (shows(layout, i)) await session.loadAdvanced(i.op, i.priority, cardFields(layout));
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
  const tmAllowed = (op: string) => !TONE_MAPPER_OPS.has(op) || !!session?.toneMappable;
  const tmReason = (op: string) => TONE_MAPPER_OPS.has(op) && session && !session.toneMappable
    ? t("fields.advanced.toneMapperNonRaw") : undefined;
  // Pop-up warning when an Advanced action would leave two tone mappers enabled.
  const guardToneMapper = (op: string, priority: number | null, label: string,
                           onEnableAnyway: () => void, onSwitch: () => void) => {
    if (!session || !TONE_MAPPER_OPS.has(op)) { onEnableAnyway(); return; }
    const others = session.activeToneMappers(priority === null ? undefined : { op, priority });
    if (!others.length || !onToneMapperGuard) { onEnableAnyway(); return; }
    const current = others.map((x) => fieldText(layoutFor(x.op, id)?.title ?? x.title)).join(", ");
    onToneMapperGuard({ current, next: fieldText(label), onSwitch, onEnableAnyway });
  };
  // hidden modules leave the tone mapper switch, but not the one the card is on
  const hiddenSet = loadHiddenModules();
  const familyOptions = (f: { ops: string[] }, current: string) => f.ops.flatMap((op) => {
    if (op !== current && isHidden(hiddenSet, id, op)) return [];
    const l = layoutFor(op, id), first = all.find((c) => c.i.op === op && c.i.priority === 0);
    return l && first ? [{ op, title: l.title, applicable: first.i.switchable !== false && tmAllowed(op),
                           reason: tmReason(op) }] : [];
  });
  const switchTo = (c: typeof all[number], f: { label: string }, to: string) => {
    if (!tmAllowed(to)) return;
    record?.([`adv:${c.i.op}#${c.i.priority}:switch:${performance.now()}`], `Switch ${f.label}: ${layoutFor(to, id)!.title}`);
    session!.switchModule(c.i.op, c.i.priority, to);
  };
  // Add module's action, for its menu and the search
  const add = (op: string) => {
    if (!tmAllowed(op)) return;
    const l = layoutFor(op, id)!;
    if (l.instance) { onSimple!(l.instance.add, `Add module: ${l.title}`); return; }
    const doAdd = () => {
      record?.([`adv:${op}#0:add:${performance.now()}`], `Add module: ${l.title}`);
      session!.addModule(op);
    };
    const doSwitch = () => {
      record?.([`adv:${op}#0:switch:${performance.now()}`], `Switch tone mapper: ${l.title}`);
      session!.disableOtherToneMappers({ op, priority: 0 });
      session!.addModule(op);
    };
    guardToneMapper(op, 0, l.title, doAdd, doSwitch);
  };
  const choices = visibleLayouts(groupLayouts(id), hiddenSet).flatMap((l) => {
    // a named card's instance may not exist yet: the module's first says
    // whether darktable can apply it
    const first = session?.instances.find((i) => i.op === l.op && i.priority === 0);
    if (!first || !loaded || loaded.session !== session || !loaded.schemas.has(l.op) || (l.instance && !onSimple)) return [];
    // a family member counts as shown while its family's card is: the
    // card's switch is how to reach it
    const f = familyOf(l.op);
    return [{ op: l.op, title: l.title, shown: cards.some((c) => c.i.op === l.op || (!!f && f.ops.includes(c.i.op) && c.state.enabled)),
              applicable: first.switchable !== false && tmAllowed(l.op), reason: tmReason(l.op) }];
  });
  // the module search's pick: the card shown is focused, a tone mapper's
  // shared card switches to it, and a module not shown is added
  const [focused, setFocused] = useState<{ key: string; nonce: number } | null>(null);
  useEffect(() => {
    if (!pick || !session || loaded?.session !== session) return;
    const l = layoutFor(pick.op, id);
    const choice = choices.find((c) => c.op === pick.op);
    const f = familyOf(pick.op);
    const own = cards.find((c) => c.i.op === pick.op);
    const other = f && cards.find((c) => f.ops.includes(c.i.op));
    if (own) setFocused({ key: `${own.i.op}#${own.i.priority}`, nonce: pick.nonce });
    else if (l && f && other) { switchTo(other, f, pick.op); setFocused({ key: `${pick.op}#0`, nonce: pick.nonce }); }
    else if (l && choice?.applicable && !choice.shown) { add(pick.op); setFocused({ key: `${pick.op}#0`, nonce: pick.nonce }); }
    onPicked?.(pick.nonce);
  }, [pick?.nonce, loaded, session]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!focused) return;
    const t = window.setTimeout(() => setFocused(null), 2000);
    return () => window.clearTimeout(t);
  }, [focused]);
  return (
    <div className="panel adjust" data-panel-id={id}>
      <div className={`panel-title${open ? " open" : ""}`} onClick={(e) => onToggle(e.altKey)}>
        <span>{fieldText(title)}</span>
        <Chevron open={open} />
      </div>
      <Collapse open={open}>
        <div className="panel-body">
          {cards.length === 0 && choices.length === 0 && <div className="advanced-empty">{t("fields.advanced.noModules")}</div>}
          {cards.map(({ i, layout, schema, state }) => {
            const key = `${i.op}#${i.priority}`;
            const sib = cards.filter((c) => c.i.op === i.op).map((c) => c.i);
            const index = sib.indexOf(i);
            const onInstance = (c: InstanceChoice, name?: string) => {
              const s = session!;
              const steps: Record<InstanceChoice, string> = { new: "New instance", duplicate: "Duplicate instance",
                rename: "Rename instance", up: "Move instance", down: "Move instance", delete: "Delete instance",
                remove: "Remove from mask", reset: "Reset module" };
              if (c === "remove" || c === "reset") return;
              if ((c === "new" || c === "duplicate") && !tmAllowed(i.op)) return;
              const runInstance = () => {
                // each action its own step, however quickly the next follows
                record?.([`adv:${key}:${c}:${performance.now()}`], `${steps[c]}: ${layout.title}`);
                if (c === "up") s.instanceAction({ action: "move", op: i.op, priority: i.priority, other: sib[index - 1].priority, after: false });
                else if (c === "down") s.instanceAction({ action: "move", op: i.op, priority: i.priority, other: sib[index + 1].priority, after: true });
                else s.instanceAction({ action: c, op: i.op, priority: i.priority, name });
              };
              if (c === "duplicate" && TONE_MAPPER_OPS.has(i.op) && (state.enabled || s.activeToneMappers().length > 0)) {
                guardToneMapper(i.op, null, layout.title, runInstance, () => {
                  record?.([`adv:${key}:switch:${performance.now()}`], `${steps[c]}: ${layout.title}`);
                  s.disableOtherToneMappers();
                  s.instanceAction({ action: c, op: i.op, priority: i.priority, name });
                });
                return;
              }
              runInstance();
            };
            const applyFieldEdit = (edit: Record<string, number>, coalesce: boolean, editId: string, gesture?: number) => {
              if (!state.enabled && !tmAllowed(i.op)) return;
              const doEdit = () => {
                record?.([`adv:${key}:${editId}`], layout.title, gesture);
                session!.setFields(i.op, i.priority, edit, coalesce);
              };
              if (!state.enabled && TONE_MAPPER_OPS.has(i.op)) {
                guardToneMapper(i.op, i.priority, layout.title, doEdit, () => {
                  record?.([`adv:${key}:switch:${performance.now()}`], `Switch tone mapper: ${layout.title}`);
                  session!.disableOtherToneMappers({ op: i.op, priority: i.priority });
                  session!.setFields(i.op, i.priority, edit, coalesce);
                });
                return;
              }
              doEdit();
            };
            return (
              <ModuleCard key={key} hidden={isHidden(hiddenSet, id, i.op)}
                blockEnable={!tmAllowed(i.op)} blockReason={tmReason(i.op)}
                instance={i} layout={layout} schema={schema} state={state}
                family={(() => {
                  const f = familyOf(i.op);
                  return f && familyOptions(f, i.op).length > 1 ? { label: f.label, options: familyOptions(f, i.op), onPick: (to: string) => switchTo(cards.find((c) => c.i === i)!, f, to) } : undefined;
                })()}
                photo={session} photos={photos} onSettled={() => void session!.reloadAdvanced(i.op, i.priority)} settle={() => session!.settled()} wbInModule={session?.wbInModule} wbLocked={session?.wbLocked} trouble={i.op === "temperature" ? session?.wbTrouble : i.op === "channelmixerrgb" ? session?.catTrouble.get(i.priority) : 0} siblings={sib.length} index={index} fresh={session!.lastAdded === key} focus={focused?.key === key ? focused.nonce : undefined} onInstance={onInstance} onTurn={onTurn}
                onField={(path, v, coalesce) => {
                  const c = session!.context;
                  applyFieldEdit(editOf(layout, path, v, state.params, { width: c.sensorWidth, height: c.sensorHeight }), coalesce, path);
                }}
                onFields={(edit, coalesce, editId, gesture) => {
                  const c = session!.context;
                  const size = { width: c.sensorWidth, height: c.sensorHeight };
                  const all = Object.entries(edit).reduce((acc, [path, v]) => ({ ...acc, ...editOf(layout, path, v, { ...state.params, ...acc }, size) }), {});
                  if (gesture !== undefined && !session!.changesFields(i.op, i.priority, all)) return;
                  applyFieldEdit(all, coalesce, editId, gesture);
                }}
                onEnabled={(on) => {
                  if (on && !tmAllowed(i.op)) return;
                  const doToggle = () => {
                    record?.([`adv:${key}:enabled`], layout.title);
                    session!.setAdvancedEnabled(i.op, i.priority, on);
                  };
                  if (on && TONE_MAPPER_OPS.has(i.op)) {
                    guardToneMapper(i.op, i.priority, layout.title, doToggle, () => {
                      record?.([`adv:${key}:switch:${performance.now()}`], `Switch tone mapper: ${layout.title}`);
                      session!.disableOtherToneMappers({ op: i.op, priority: i.priority });
                      session!.setAdvancedEnabled(i.op, i.priority, true);
                    });
                    return;
                  }
                  doToggle();
                }}
                loadPresets={(change) => session!.loadPresets(i.op, i.priority, change)}
                importPreset={(xml) => session!.importModulePreset(i.op, i.priority, xml)}
                onPreset={(name) => {
                  if (!state.enabled && !tmAllowed(i.op)) return;
                  const doPreset = () => {
                    record?.([`adv:${key}:preset:${performance.now()}`], `Preset: ${layout.title}`);
                    session!.applyPreset(i.op, i.priority, name);
                  };
                  if (!state.enabled && TONE_MAPPER_OPS.has(i.op)) {
                    guardToneMapper(i.op, i.priority, layout.title, doPreset, () => {
                      record?.([`adv:${key}:switch:${performance.now()}`], `Switch tone mapper: ${layout.title}`);
                      session!.disableOtherToneMappers({ op: i.op, priority: i.priority });
                      session!.applyPreset(i.op, i.priority, name);
                    });
                    return;
                  }
                  doPreset();
                }}
                onReset={() => { record?.([`adv:${key}:reset`], layout.title); session!.resetAdvanced(i.op, i.priority); }} />
            );
          })}
          {choices.length > 0 && (
            <AddModuleMenu group={title} choices={choices} onAdd={add} />
          )}
        </div>
      </Collapse>
    </div>
  );
}

// A mask owns its own module instances. They use the same full cards as the
// global Advanced panels, with add/remove actions scoped to the selected mask.
export function AdvancedMaskCards({ mask, session, revision = 0, record, photos }: {
  mask: string; session?: Session | null; revision?: number; record?: AdvancedEdit; photos?: ImageEntry[];
}) {
  const signature = session?.instances.filter((i) => i.owner === "mask" && i.mask === mask)
    .map((i) => `${i.op}#${i.priority}`).join(",") ?? "";
  const [loaded, setLoaded] = useState<{ session: Session; mask: string; signature: string; schemas: Map<string, ModuleSchema> } | null>(null);
  void revision;
  useEffect(() => {
    if (!session) return;
    let live = true;
    void (async () => {
      await session.loadInstances();
      const owned = session.instances.filter((i) => i.owner === "mask" && i.mask === mask);
      const found = new Map<string, ModuleSchema>();
      for (const i of owned) {
        const layout = LAYOUTS.find((l) => l.op === i.op && !l.instance) ?? LAYOUTS.find((l) => l.op === i.op);
        if (!layout) continue;
        const schema = await schemaOf(i.op);
        found.set(i.op, schema);
        await session.loadAdvanced(i.op, i.priority, cardFields(layout));
      }
      if (live) setLoaded({ session, mask, signature: session.instances.filter((i) => i.owner === "mask" && i.mask === mask)
        .map((i) => `${i.op}#${i.priority}`).join(","), schemas: found });
    })().catch(() => {});
    return () => { live = false; };
  }, [session, mask, signature]);

  const ready = !!session && loaded?.session === session && loaded.mask === mask && loaded.signature === signature;
  const instances = session && ready
    ? session.instances.filter((i) => i.owner === "mask" && i.mask === mask)
        .flatMap((i) => {
          const layout = LAYOUTS.find((l) => l.op === i.op && !l.instance) ?? LAYOUTS.find((l) => l.op === i.op);
          const schema = loaded.schemas.get(i.op);
          const state = session.advanced.get(`${i.op}#${i.priority}`);
          return layout && schema && state ? [{ i, layout, schema, state }] : [];
        }).sort((a, b) => a.i.iop_order - b.i.iop_order)
    : [];
  const present = new Set(instances.map(({ i }) => i.op));
  const hidden = loadHiddenModules();
  const choices = MASK_MODULES.flatMap(({ op }) => {
    if (present.has(op)) return [];
    const layout = LAYOUTS.find((l) => l.op === op && !l.instance) ?? LAYOUTS.find((l) => l.op === op);
    if (layout && isHidden(hidden, layout.group, op)) return [];
    const first = session?.instances.find((i) => i.op === op && i.owner === null);
    return layout ? [{ op, title: layout.title, shown: false, applicable: !!first && first.switchable !== false }] : [];
  });
  const add = (op: string) => {
    const layout = LAYOUTS.find((l) => l.op === op && !l.instance) ?? LAYOUTS.find((l) => l.op === op);
    if (!session || !layout) return;
    record?.([`mask:${mask}:${op}:add:${performance.now()}`], `Add ${layout.title} to mask`);
    const module = MASK_MODULES.find((m) => m.op === op);
    if (module) session.addMaskModule(mask, op);
  };
  return <div className="mask-advanced-cards" data-mask-advanced={mask}>
    {instances.map(({ i, layout, schema, state }, index) => {
      const s = session!;
      const key = `${i.op}#${i.priority}`;
      const siblings = instances.filter((c) => c.i.op === i.op).map((c) => c.i);
      const siblingIndex = siblings.indexOf(i);
      return <ModuleCard key={`${mask}:${key}`} maskOwned simple={localMaps.some((m) => m.op === i.op)}
        instance={i} layout={layout} schema={schema} state={state} siblings={siblings.length} index={siblingIndex}
        photo={s} photos={photos} onSettled={() => void s.reloadAdvanced(i.op, i.priority)} settle={() => s.settled()}
        wbInModule={s.wbInModule}
        wbLocked={s.wbLocked}
        trouble={i.op === "channelmixerrgb" ? s.catTrouble.get(i.priority) : 0}
        onField={(path, value, coalesce) => {
          record?.([`mask:${mask}:${key}:${path}`], layout.title);
          const c = s.context;
          s.setFields(i.op, i.priority, editOf(layout, path, value, state.params, { width: c.sensorWidth, height: c.sensorHeight }), coalesce);
        }}
        onFields={(edit, coalesce, editId, gesture) => {
          const c = s.context, size = { width: c.sensorWidth, height: c.sensorHeight };
          const all = Object.entries(edit).reduce((acc, [path, value]) => ({ ...acc, ...editOf(layout, path, value, { ...state.params, ...acc }, size) }), {} as Record<string, number>);
          if (gesture !== undefined && !s.changesFields(i.op, i.priority, all)) return;
          record?.([`mask:${mask}:${key}:${editId}`], layout.title, gesture);
          s.setFields(i.op, i.priority, all, coalesce);
        }}
        onEnabled={(on) => { record?.([`mask:${mask}:${key}:enabled`], layout.title); s.setAdvancedEnabled(i.op, i.priority, on); }}
        onReset={() => { record?.([`mask:${mask}:${key}:reset`], `Reset ${layout.title}`); s.resetAdvanced(i.op, i.priority); }}
        onInstance={(action) => {
          if (action === "reset") { record?.([`mask:${mask}:${key}:reset-menu`], `Reset ${layout.title}`); s.resetAdvanced(i.op, i.priority); }
          else if (action === "remove") {
            record?.([`mask:${mask}:${key}:remove`], `Remove ${layout.title} from mask`);
            s.removeMaskModule(mask, i.op, i.priority);
          }
        }}
        loadPresets={(change) => s.loadPresets(i.op, i.priority, change)}
        importPreset={(xml) => s.importModulePreset(i.op, i.priority, xml)}
        onPreset={(name) => {
          record?.([`mask:${mask}:${key}:preset:${performance.now()}`], presetLabel(name));
          s.applyPreset(i.op, i.priority, name);
        }}
      />;
    })}
    {session && ready && choices.length > 0 && <AddModuleMenu group={`mask ${mask}`} choices={choices} onAdd={add} />}
    {!session && <div className="advanced-empty">{t("fields.advanced.maskOpenPhoto")}</div>}
    {session && !ready && <div className="advanced-empty">{t("fields.advanced.maskLoading")}</div>}
    {instances.length === 0 && session && ready && choices.length === 0 && <div className="advanced-empty">{t("fields.advanced.maskNoModules")}</div>}
  </div>;
}
