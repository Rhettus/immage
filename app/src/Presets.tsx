// Lightroom-style develop presets: a named set of slider values, in
// Lightroom units, applied over the image's own. kept in the app's runtime
// folder (presets.json) by the Rust side, not in any image's sidecar.
// beside them, looks: darktable styles (film emulations) the engine puts on
// extra module instances, one look at a time. both can be shared as files
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileDown, Plus, Save, Share, Trash } from "lucide-react";
import { blacksFromLinear, controlById, panels, type Values } from "./manifest";
import type { Frame } from "./session";

// rawOnly: applied to raw files only, as Lightroom's import defaults are
export type Preset = { id: string; name: string; group: string; values: Values; builtin?: boolean;
                       rawOnly?: boolean };
// user: imported, kept in the runtime folder, and deletable
export type Look = { name: string; group: string; path: string; user?: boolean };

// presets.json is { version, presets }. a preset keeps slider values, so
// when a control's scale changes, MIGRATIONS[n] carries a version n file's
// presets to version n + 1, keeping what each one does to a photo. version
// 1 was the bare list
const PRESETS_VERSION = 2;
type PresetsFile = { version: number; presets: Preset[] };
const mapValues = (presets: Preset[], f: (v: Values) => Values) =>
  presets.map((p) => ({ ...p, values: f(p.values) }));
const MIGRATIONS: Record<number, (presets: Preset[]) => Preset[]> = {
  // Blacks went from linear to squared, and apart from Exposure (manifest.ts)
  1: (presets) => mapValues(presets, (v) => {
    const out = { ...v };
    for (const [id, ev] of [["blacks", "exposure"], ["l_blacks", "l_exposure"]])
      if (Number.isFinite(out[id])) out[id] = blacksFromLinear(out[id], out[ev] ?? 0);
    return out;
  }),
};

export async function loadPresets(): Promise<Preset[]> {
  const raw = await invoke<PresetsFile | Preset[]>("presets_load");
  let { version, presets } = Array.isArray(raw) ? { version: 1, presets: raw } : raw;
  if (version > PRESETS_VERSION) throw new Error("presets.json is from a newer Immage");
  for (; version < PRESETS_VERSION; version++) presets = MIGRATIONS[version](presets);
  return presets;
}
export const savePresets = (presets: Preset[]) =>
  invoke("presets_save", { presets: { version: PRESETS_VERSION, presets } satisfies PresetsFile });
export const loadLooks = () => invoke<Look[]>("looks_list");

// presets as a file to give someone, as the Export dialog's are
// (exportSettings.ts): its version says which scale the values are on
export const sharedPresets = (list: Preset[]) => ({
  immage: "presets", version: PRESETS_VERSION,
  presets: list.map((p) => ({ name: p.name, group: p.group, values: p.values, ...(p.rawOnly ? { rawOnly: true } : {}) })),
});

// the presets in a shared file, brought to this version's scale, renamed
// where their group has the name already. controls this version lacks are
// dropped, as applying one would find no control to set
export function readSharedPresets(file: unknown, taken: Preset[]): Preset[] {
  const f = file as { immage?: unknown; version?: unknown; presets?: unknown };
  if (!f || f.immage !== "presets" || !Array.isArray(f.presets) || !Number.isInteger(f.version) || (f.version as number) < 1)
    throw new Error("this file is not an Immage preset");
  let version = f.version as number;
  if (version > PRESETS_VERSION) throw new Error("this preset is from a newer Immage");
  let list = f.presets.flatMap((raw): Preset[] => {
    const r = raw as { name?: unknown; group?: unknown; values?: unknown; rawOnly?: unknown };
    if (typeof r?.name !== "string" || !r.values || typeof r.values !== "object" || Array.isArray(r.values)) return [];
    const values = Object.fromEntries(Object.entries(r.values).filter(([, v]) => typeof v === "number" && Number.isFinite(v)));
    const group = typeof r.group === "string" && r.group.trim() ? r.group.trim() : DEFAULT_GROUP;
    return [{ id: crypto.randomUUID(), name: r.name.trim() || "Imported preset", group, values,
              ...(r.rawOnly === true ? { rawOnly: true } : {}) }];
  });
  for (; version < PRESETS_VERSION; version++) list = MIGRATIONS[version](list);
  const names = new Set(taken.map((p) => `${p.group}\n${p.name}`));
  return list.flatMap((p) => {
    const values = Object.fromEntries(Object.entries(p.values).filter(([id]) => controlById.has(id)));
    if (!Object.keys(values).length) return [];
    let name = p.name;
    for (let n = 2; names.has(`${p.group}\n${name}`); n++) name = `${p.name} (${n})`;
    names.add(`${p.group}\n${name}`);
    return [{ ...p, name, values }];
  });
}

// the preset a photo gets the first time it is opened unedited, as
// Lightroom's import presets: by id, kept with the app, not the photo
const NEW_PHOTOS_KEY = "immage.newPhotosPreset";
// new photos get Default until Preferences says otherwise; "" is None
export function loadNewPhotosPreset(): string | null {
  try {
    const v = localStorage.getItem(NEW_PHOTOS_KEY);
    return v === null ? DEFAULT_PRESET_ID : v || null;
  } catch { return DEFAULT_PRESET_ID; }
}
export function storeNewPhotosPreset(id: string | null) {
  try { localStorage.setItem(NEW_PHOTOS_KEY, id ?? ""); } catch { /* not kept */ }
}

// a few to start from, always there and not deletable
// a raw's starting point: lens profile corrections with chromatic
// aberration removed. no sharpening, unlike Lightroom's: Immage's
// (diffuse or sharpen) reruns on every slider before it in the pipe, about
// 150 ms a frame (measured with benchmarking/bench.py), so it is left to the photo.
// Color Noise Reduction 25 comes from the new-photo setup (App.tsx)
export const DEFAULT_PRESET_ID = "builtin:Default";
const DEFAULT_PRESET: Preset = {
  id: DEFAULT_PRESET_ID, name: "Default", group: "Import", builtin: true, rawOnly: true,
  values: { lens_profile: 1, lens_ca: 1 },
};

export const BUILTIN_PRESETS: Preset[] = [DEFAULT_PRESET, ...([
  ["Vivid", { contrast: 15, clarity: 15, vibrance: 30, saturation: 8 }],
  ["Soft", { contrast: -20, highlights: -25, shadows: 25, clarity: -15 }],
  ["Bright & Airy", { exposure: 0.35, highlights: -40, shadows: 30, whites: 20, blacks: 36, vibrance: -10 }],
  ["Moody", { exposure: -0.3, contrast: 20, highlights: -30, shadows: -10, blacks: -35, vibrance: -15, clarity: 10 }],
  ["B&W Contrast", { bw_mode: 1, contrast: 30, clarity: 20, blacks: -32 }],
] as [string, Values][]).map(([name, values]) => ({ id: `builtin:${name}`, name, group: "Basics", values, builtin: true }))];

// preview tiles: one small render per preset or look, on the engine while
// it is otherwise idle. an edit makes them stale; the old tile stays on
// show until its fresh one is ready
export type PreviewJob = { key: string; run: () => Promise<Frame> };

export class PreviewCache {
  private bitmaps = new Map<string, ImageBitmap>();
  private fresh = new Set<string>();
  private queue: PreviewJob[] = [];
  private running = false;
  private version = 0;

  constructor(private isIdle: () => boolean, private onLoaded: () => void) {}

  get(key: string) { return this.bitmaps.get(key); }

  // these, in this order, in place of whatever was waiting
  request(jobs: PreviewJob[]) {
    this.queue = jobs.filter((j) => !this.fresh.has(j.key));
    void this.run();
  }

  invalidate() { this.version++; this.fresh.clear(); }

  clear() { this.invalidate(); this.bitmaps.clear(); this.queue = []; }

  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        while (!this.isIdle()) await new Promise((r) => setTimeout(r, 80));
        const job = this.queue.shift()!;
        if (this.fresh.has(job.key)) continue;
        const version = this.version;
        try {
          const f = await job.run();
          this.bitmaps.set(job.key, await createImageBitmap(new ImageData(f.pixels, f.width, f.height)));
          if (version === this.version) this.fresh.add(job.key);
          this.onLoaded();
        } catch {
          // a preview that fails keeps its placeholder
        }
      }
    } finally {
      this.running = false;
    }
  }
}

function Tile({ bitmap }: { bitmap: ImageBitmap | undefined }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !bitmap) return;
    c.width = bitmap.width;
    c.height = bitmap.height;
    c.getContext("2d")!.drawImage(bitmap, 0, 0);
  }, [bitmap]);
  return <canvas ref={ref} className={`tile-img${bitmap ? "" : " empty"}`} />;
}

const SHUT_KEY = "immage.presets.shut";
const loadShut = (groups: string[]) => {
  try {
    const kept = localStorage.getItem(SHUT_KEY);
    if (kept) return new Set<string>(JSON.parse(kept));
  } catch { /* first run */ }
  return new Set(groups);
};

const DEFAULT_GROUP = "User Presets";
const MY_LOOKS = "My Looks";

// what a preset can hold, as the New Preset dialog lists it: Basic by its
// sections, every other panel whole. the point curve goes with the Tone
// Curve, and crop is never part of one, as in Lightroom
type Part = { id: string; label: string; controls: string[]; on: boolean };
const OFF_BY_DEFAULT = new Set(["basic:White Balance", "transform"]);

const PARTS: Part[] = (() => {
  const ids = (sections: { controls: { id: string }[] }[]) =>
    [...new Set(sections.flatMap((s) => s.controls.map((c) => c.id)))];
  const parts: Part[] = [];
  for (const p of panels) {
    if (p.hidden) continue;
    if (p.id === "basic") {
      for (const s of p.sections) {
        const id = `basic:${s.title}`;
        parts.push({ id, label: s.title, controls: ids([s]), on: !OFF_BY_DEFAULT.has(id) });
      }
      continue;
    }
    const extra = p.id === "tonecurve" ? panels.filter((q) => q.id === "tonecurve-points") : [];
    parts.push({ id: p.id, label: p.title, controls: ids([...p.sections, ...extra.flatMap((q) => q.sections)]),
                 on: !OFF_BY_DEFAULT.has(p.id) });
  }
  return parts;
})();

// the presets and looks in the right-hand panel, by group, each as a
// preview of the open image; a click applies one
export function PresetsPanel({ presets, looks, look, disabled, preview, onWant, onApply, onLook, onCreate, onDelete,
                              fold, onAnyOpen, focusMode, onHover, amount, onAmount, onRename, onUpdate,
                              lookAmount, onLookAmount, newPhotos, onNewPhotos, onImport, onExportPreset,
                              onExportLook, onDeleteLook }: {
  onImport: () => void;                  // presets or looks from files
  onExportPreset: (p: Preset) => void;
  onExportLook: (l: Look) => void;
  onDeleteLook: (l: Look) => void;
  newPhotos: string | null;              // the preset new photos get, by id
  onNewPhotos: (id: string | null) => void;
  lookAmount: number;                    // the look's strength, 0-100
  onLookAmount: (v: number) => void;
  // the pointer resting on a tile, for the preview on the image (null: off it)
  onHover: (key: string | null) => void;
  // the strength of the preset last applied, 0-200
  amount: { name: string; value: number } | null;
  onAmount: (v: number) => void;
  onRename: (p: Preset, name: string) => void;
  onUpdate: (p: Preset) => void;
  // the header's collapse/expand-all: each new n shuts or opens every group
  fold: { open: boolean; n: number };
  onAnyOpen: (open: boolean) => void;
  focusMode: boolean;
  presets: Preset[]; looks: Look[]; look: string | null; disabled: boolean;
  preview: (key: string) => ImageBitmap | undefined;
  onWant: (keys: string[]) => void;      // the tiles on show, in order
  onApply: (p: Preset) => void; onLook: (l: Look | null) => void;
  onCreate: () => void; onDelete: (p: Preset) => void;
}) {
  type Group = { title: string; items: ({ kind: "preset"; p: Preset } | { kind: "look"; l: Look })[] };
  const groups = useMemo<Group[]>(() => {
    const byName = <T,>(list: T[], name: (t: T) => string) => [...list].sort((a, b) => name(a).localeCompare(name(b)));
    const user = new Map<string, Preset[]>();
    for (const p of presets) user.set(p.group, [...(user.get(p.group) ?? []), p]);
    const film = new Map<string, Look[]>();
    for (const l of looks) {
      const g = l.user ? MY_LOOKS : l.group;
      film.set(g, [...(film.get(g) ?? []), l]);
    }
    return [
      ...[...user.entries()].sort(([a], [b]) => (a === "Basics" ? -1 : b === "Basics" ? 1 : a.localeCompare(b)))
        .map(([title, list]) => ({ title, items: byName(list, (p) => p.name).map((p) => ({ kind: "preset" as const, p })) })),
      ...[...film.entries()].sort(([a], [b]) => (a === MY_LOOKS ? -1 : b === MY_LOOKS ? 1 : a.localeCompare(b)))
        .map(([g, list]) => ({ title: g === MY_LOOKS ? g : `Film · ${g}`, items: byName(list, (l) => l.name).map((l) => ({ kind: "look" as const, l })) })),
    ];
  }, [presets, looks]);
  const [shut, setShut] = useState<Set<string>>(() => loadShut(groups.filter((g) => g.title.startsWith("Film")).map((g) => g.title)));
  const [confirming, setConfirming] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);      // the tile whose ⋯ menu is open
  const [renaming, setRenaming] = useState<string | null>(null);
  useEffect(() => {
    if (!fold.n) return;
    const next = new Set(fold.open ? [] : groups.map((g) => g.title));
    setShut(next);
    try { localStorage.setItem(SHUT_KEY, JSON.stringify([...next])); } catch { /* not kept */ }
  }, [fold.n]);
  useEffect(() => { onAnyOpen(groups.some((g) => !shut.has(g.title))); }, [shut, groups]);
  // the tile last clicked, which the tools above act on, as the Export
  // dialog's act on its chosen preset; else the look that is on
  const [chosen, setChosen] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const [arming, setArming] = useState(false);  // the tools' delete, asking once
  const keyOf = (it: Group["items"][number]) => (it.kind === "preset" ? `p:${it.p.id}` : `l:${it.l.path}`);
  const items = groups.flatMap((g) => g.items);
  const pick = items.find((it) => keyOf(it) === chosen)
    ?? items.find((it) => it.kind === "look" && it.l.name === look) ?? null;
  const pickName = pick ? (pick.kind === "preset" ? pick.p.name : pick.l.name) : null;
  const pickMine = pick?.kind === "preset" ? !pick.p.builtin : !!pick?.l.user;

  useEffect(() => {
    onWant(groups.filter((g) => !shut.has(g.title)).flatMap((g) => g.items.map(keyOf)));
  }, [groups, shut]);

  // focus mode and ⌥ as for the Adjustments panels: opening a group alone
  // shuts the rest
  const toggleGroup = (g: string, alt: boolean) => setShut((s) => {
    const solo = focusMode ? !alt && s.has(g) : alt;
    const openNow = groups.filter((x) => !s.has(x.title));
    let n: Set<string>;
    if (solo) {
      const only = openNow.length === 1 && openNow[0].title === g;
      n = new Set(groups.map((x) => x.title).filter((t) => only || t !== g));
    } else {
      n = new Set(s);
      if (n.has(g)) n.delete(g); else n.add(g);
    }
    try { localStorage.setItem(SHUT_KEY, JSON.stringify([...n])); } catch { /* not kept */ }
    return n;
  });

  return (
    <div className="presets-panel">
      {amount && (
        <div className="preset-amount">
          <div className="row">
            <span className="label">Amount <b>{amount.name}</b></span>
            <span className="value">{Math.round(amount.value)}%</span>
          </div>
          <input type="range" min={0} max={200} step={1} value={amount.value}
                 onChange={(e) => onAmount(Number(e.target.value))}
                 onDoubleClick={() => onAmount(100)} />
        </div>
      )}
      <div className="preset-tools" onMouseLeave={() => setArming(false)}>
        <button className="tool" disabled={disabled} title="new preset from the settings as they are now"
                onClick={onCreate}><Plus className="icon" strokeWidth={1.8} /></button>
        <button className="tool" disabled={disabled || pick?.kind !== "preset" || pick.p.builtin}
                title={pick?.kind === "preset" && !pick.p.builtin ? `update “${pickName}” with the current settings`
                                                                  : "update the chosen preset with the current settings"}
                onClick={() => pick?.kind === "preset" && onUpdate(pick.p)}><Save className="icon" strokeWidth={1.8} /></button>
        <button className="tool" title="import presets (.json) or darktable styles as looks (.dtstyle) from files"
                onClick={onImport}><FileDown className="icon" strokeWidth={1.8} /></button>
        <button className="tool" disabled={!pick}
                title={pick ? `save “${pickName}” as a file to share` : "export the chosen preset or look to a file"}
                onClick={() => pick && (pick.kind === "preset" ? onExportPreset(pick.p) : onExportLook(pick.l))}>
          <Share className="icon" strokeWidth={1.8} /></button>
        <button className={`tool delete${arming ? " armed" : ""}`} disabled={!pickMine}
                title={!pickMine ? "delete the chosen preset or look" : arming ? `click again to delete “${pickName}”`
                                                                                : `delete “${pickName}”`}
                onClick={() => {
                  if (!pick || !pickMine) return;
                  if (!arming) { setArming(true); return; }
                  setArming(false);
                  setChosen(null);
                  if (pick.kind === "preset") onDelete(pick.p); else onDeleteLook(pick.l);
                }}><Trash className="icon" strokeWidth={1.8} /></button>
      </div>
      <div className="presets-head">
        <span className="look-chip">
          Look: <b>{look ?? "none"}</b>
          {look && <button title="take the look off" disabled={disabled} onClick={() => onLook(null)}>×</button>}
        </span>
      </div>

      {look && (
        <div className="preset-amount">
          <div className="row">
            <span className="label">Look amount</span>
            <span className="value">{Math.round(lookAmount)}%</span>
          </div>
          <input type="range" min={0} max={100} step={1} value={lookAmount} disabled={disabled}
                 onChange={(e) => onLookAmount(Number(e.target.value))}
                 onDoubleClick={() => onLookAmount(100)} />
        </div>
      )}
      {groups.map((g) => {
        const open = !shut.has(g.title);
        return (
          <div key={g.title} className="preset-group">
            <div className="preset-group-title" onClick={(e) => toggleGroup(g.title, e.altKey)}>
              <span className={`tri${open ? " open" : ""}`}>▸</span>{g.title}
              <span className="count">{g.items.length}</span>
            </div>
            {open && (
              <div className="tiles">
                {g.items.map((it) => {
                  const key = keyOf(it);
                  const name = it.kind === "preset" ? it.p.name : it.l.name;
                  const on = it.kind === "look" ? look === it.l.name : applied === key;
                  return (
                    <div key={key} className={`tile${on ? " on" : ""}${disabled ? " disabled" : ""}`} title={name}
                         onMouseEnter={() => { if (!disabled) onHover(key); }}
                         onMouseLeave={() => {
                           onHover(null);
                           if (confirming === key) setConfirming(null);
                           if (menu === key) setMenu(null);
                         }}
                         onClick={() => {
                           if (disabled || renaming === key) return;
                           onHover(null);
                           setChosen(key);
                           setArming(false);
                           if (it.kind === "preset") { onApply(it.p); setApplied(key); }
                           else onLook(look === it.l.name ? null : it.l);
                         }}>
                      <Tile bitmap={preview(key)} />
                      {renaming === key && it.kind === "preset" ? (
                        <input className="tile-rename" autoFocus defaultValue={it.p.name}
                               onClick={(e) => e.stopPropagation()}
                               onFocus={(e) => e.target.select()}
                               onKeyDown={(e) => {
                                 e.stopPropagation();
                                 if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                 if (e.key === "Escape") setRenaming(null);
                               }}
                               onBlur={(e) => {
                                 const n = e.target.value.trim();
                                 if (renaming && n && n !== it.p.name) onRename(it.p, n);
                                 setRenaming(null);
                               }} />
                      ) : <span className="tile-name">{name}</span>}
                      {it.kind === "preset" && newPhotos === it.p.id && (
                        <span className="tile-badge" title="applied to new photos">new photos</span>
                      )}
                      {(it.kind === "look" || !it.p.builtin) && renaming !== key && (
                        <button className="more" title={it.kind === "look" ? (it.l.user ? "export or delete" : "export")
                                                                             : "rename, update, export or delete"}
                                onClick={(e) => { e.stopPropagation(); setMenu(menu === key ? null : key); setConfirming(null); }}>⋯</button>
                      )}
                      {menu === key && it.kind === "preset" && (
                        <div className="tile-menu" onClick={(e) => e.stopPropagation()}>
                          <button onClick={() => { setMenu(null); setRenaming(key); }}>Rename</button>
                          <button title="apply it the first time a photo with no edit is opened"
                                  onClick={() => { setMenu(null); onNewPhotos(newPhotos === it.p.id ? null : it.p.id); }}>
                            {newPhotos === it.p.id ? "Stop applying to new photos" : "Apply to new photos"}</button>
                          <button title="replace its settings with the photo's current ones"
                                  onClick={() => { setMenu(null); onUpdate(it.p); }}>Update with current settings</button>
                          <button title="save it as a file to share"
                                  onClick={() => { setMenu(null); onExportPreset(it.p); }}>Export…</button>
                          <button className={confirming === key ? "danger" : ""}
                                  onClick={() => {
                                    if (confirming === key) { setMenu(null); setConfirming(null); onDelete(it.p); }
                                    else setConfirming(key);
                                  }}>{confirming === key ? "Delete: are you sure?" : "Delete"}</button>
                        </div>
                      )}
                      {menu === key && it.kind === "look" && (
                        <div className="tile-menu" onClick={(e) => e.stopPropagation()}>
                          <button title="save its darktable style as a file to share"
                                  onClick={() => { setMenu(null); onExportLook(it.l); }}>Export…</button>
                          {it.l.user && (
                            <button className={confirming === key ? "danger" : ""}
                                    onClick={() => {
                                      if (confirming === key) { setMenu(null); setConfirming(null); onDeleteLook(it.l); }
                                      else setConfirming(key);
                                    }}>{confirming === key ? "Delete: are you sure?" : "Delete"}</button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Lightroom's New Develop Preset dialog: a name, a group, and which
// settings to take from the open image
export function NewPresetDialog({ values, groups, forNewPhotos = false, onSave, onClose }: {
  values: Values; groups: string[];
  forNewPhotos?: boolean;                // "use for new photos" starts ticked
  onSave: (p: Preset, forNewPhotos: boolean) => void; onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [forNew, setForNew] = useState(forNewPhotos);
  const [group, setGroup] = useState(groups[0] ?? DEFAULT_GROUP);
  const [on, setOn] = useState<Set<string>>(() => new Set(PARTS.filter((p) => p.on).map((p) => p.id)));
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => nameRef.current?.focus(), []);

  const save = () => {
    const picked: Values = {};
    for (const part of PARTS) {
      if (!on.has(part.id)) continue;
      for (const id of part.controls) if (values[id] !== undefined) picked[id] = values[id];
    }
    onSave({ id: crypto.randomUUID(), name: name.trim(), group: group.trim() || DEFAULT_GROUP, values: picked }, forNew);
  };
  const ok = name.trim().length > 0 && on.size > 0;

  return (
    <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal new-preset" onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        if (e.key === "Enter" && ok) save();
      }}>
        <div className="modal-head"><h2>New Preset</h2></div>
        <div className="modal-body">
          <div className="row">
            <span className="k">Name</span>
            <input ref={nameRef} className="field" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="row">
            <span className="k">Group</span>
            <input className="field" list="preset-groups" value={group} onChange={(e) => setGroup(e.target.value)} />
            <datalist id="preset-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
          </div>
          <h3>Settings</h3>
          <div className="preset-parts">
            {PARTS.map((p) => (
              <label key={p.id} className="row check">
                <input type="checkbox" checked={on.has(p.id)} onChange={(e) => setOn((s) => {
                  const n = new Set(s);
                  if (e.target.checked) n.add(p.id); else n.delete(p.id);
                  return n;
                })} />
                {p.label}
              </label>
            ))}
          </div>
          <div className="row">
            <button className="btn small" onClick={() => setOn(new Set(PARTS.map((p) => p.id)))}>Check All</button>
            <button className="btn small" onClick={() => setOn(new Set())}>Check None</button>
          </div>
          <label className="row check" title="apply it the first time a photo with no edit is opened (Preferences)">
            <input type="checkbox" checked={forNew} onChange={(e) => setForNew(e.target.checked)} />
            Use for new photos
          </label>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!ok} onClick={save}>Create</button>
        </div>
      </div>
    </div>
  );
}
