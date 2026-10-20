// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the Export dialog's Frame & Captions: frames (space added around the
// photo), keylines (thin lines on its edge) and captions, each a list
// drawn in order
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Chevron } from "./Collapse";
import {
  newBorder, newInner, newText, type BorderItem, type InnerItem, type Settings, type Sides, type TextItem,
} from "./exportSettings";
import { TEXT_TOKENS } from "./exportTokens";

type Face = { name: string; weight: number; italic: boolean };
type Family = { name: string; faces: Face[] };

// the installed fonts, read once from the engine, which draws the text
let fontList: Promise<Family[]> | null = null;
function useFonts(): Family[] | null {
  const [fonts, setFonts] = useState<Family[] | null>(null);
  useEffect(() => {
    fontList ??= invoke<Family[]>("fonts").catch(() => { fontList = null; return []; });
    void fontList.then(setFonts);
  }, []);
  return fonts;
}

const move = <T,>(list: T[], from: number, to: number) => {
  const l = [...list];
  const [x] = l.splice(from, 1);
  l.splice(to, 0, x);
  return l;
};

// an item's controls: move up, move down, remove
function ItemTools({ index, count, onMove, onRemove }: {
  index: number; count: number; onMove: (to: number) => void; onRemove: () => void;
}) {
  return (
    <div className="item-tools">
      {count > 1 && <button title="Move up" disabled={index === 0} onClick={() => onMove(index - 1)}>↑</button>}
      {count > 1 && <button title="Move down" disabled={index === count - 1} onClick={() => onMove(index + 1)}>↓</button>}
      <button title="Remove" onClick={onRemove}>✕</button>
    </div>
  );
}

function Num({ value, onChange, step = 0.1, min = 0, max = 10000 }: {
  value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number;
}) {
  return (
    <input className="field num-small" type="number" step={step} min={min} max={max} value={value}
           onChange={(e) => {
             const v = Number(e.target.value);
             if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
           }} />
  );
}

export function ColorPick({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <span className="color-choice">
      {["#ffffff", "#000000"].map((c) => (
        <button key={c} className={`swatch${value === c ? " on" : ""}`} style={{ background: c }}
                title={c === "#ffffff" ? "white" : "black"} onClick={() => onChange(c)} />
      ))}
      <input type="color" className="color-pick" value={value} onChange={(e) => onChange(e.target.value)} />
    </span>
  );
}

function Opacity({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <>
      <input type="range" min={0} max={100} value={value} title="Opacity" onChange={(e) => onChange(Number(e.target.value))} />
      <span className="num">{value}%</span>
    </>
  );
}

type Unit = "short" | "long" | "px";
const UNIT_NAMES: Record<Unit, string> = { px: "px", short: "% of short side", long: "% of long side" };
function UnitPick<U extends Unit>({ value, units, onChange }: { value: U; units: U[]; onChange: (u: U) => void }) {
  return (
    <select className="unit" value={value} onChange={(e) => onChange(e.target.value as U)}>
      {units.map((u) => <option key={u} value={u}>{UNIT_NAMES[u]}</option>)}
    </select>
  );
}

// four sides' values, laid out around the photo
function SidesInput({ value, onChange }: { value: Sides; onChange: (v: Sides) => void }) {
  const side = (k: keyof Sides, label: string) => (
    <label style={{ gridArea: k[0] }}>{label} <Num value={value[k]} onChange={(v) => onChange({ ...value, [k]: v })} /></label>
  );
  return <div className="sides">{side("top", "Top")}{side("left", "Left")}{side("right", "Right")}{side("bottom", "Bottom")}</div>;
}

// one width for all sides, or one for each
function Widths({ label, same, value, unit, units, onValue, onUnit }: {
  label: string; same: boolean; value: Sides; unit: Unit; units: Unit[];
  onValue: (v: Sides) => void; onUnit: (u: Unit) => void;
}) {
  return (
    <>
      <div className="row">
        <span className="k">{label}</span>
        {same && <Num value={value.top} onChange={(v) => onValue({ top: v, left: v, right: v, bottom: v })} />}
        <UnitPick value={unit} units={units} onChange={onUnit} />
      </div>
      {!same && <SidesInput value={value} onChange={onValue} />}
    </>
  );
}

const ALL_UNITS: Unit[] = ["px", "short", "long"];

function BorderCard({ b, set }: { b: BorderItem; set: (p: Partial<BorderItem>) => void }) {
  return (
    <>
      <label className="row check">
        <input type="checkbox" checked={b.identical} onChange={(e) => set({ identical: e.target.checked })} />
        Same width all round
      </label>
      <Widths label="Width" same={b.identical} value={b} unit={b.unit} units={ALL_UNITS}
              onValue={(v) => set(v)} onUnit={(unit) => set({ unit })} />
      <div className="row"><span className="k">Color</span><ColorPick value={b.color} onChange={(color) => set({ color })} /></div>
    </>
  );
}

function KeylineCard({ b, set }: { b: InnerItem; set: (p: Partial<InnerItem>) => void }) {
  return (
    <>
      <label className="row check">
        <input type="checkbox" checked={b.identical} onChange={(e) => set({ identical: e.target.checked })} />
        Same all round
      </label>
      <Widths label="Thickness" same={b.identical} value={b.size} unit={b.sizeUnit} units={ALL_UNITS}
              onValue={(size) => set({ size })} onUnit={(sizeUnit) => set({ sizeUnit })} />
      <Widths label="Inset" same={b.identical} value={b.inset} unit={b.insetUnit} units={ALL_UNITS}
              onValue={(inset) => set({ inset })} onUnit={(insetUnit) => set({ insetUnit })} />
      <div className="row">
        <span className="k">Color</span>
        <ColorPick value={b.color} onChange={(color) => set({ color })} />
        <Opacity value={b.opacity} onChange={(opacity) => set({ opacity })} />
      </div>
    </>
  );
}

const POSITION_NAMES = ["top left", "top", "top right", "left", "center", "right", "bottom left", "bottom", "bottom right"];

function CaptionCard({ t, set, fonts }: { t: TextItem; set: (p: Partial<TextItem>) => void; fonts: Family[] | null }) {
  const area = useRef<HTMLTextAreaElement | null>(null);
  const [more, setMore] = useState(false);
  const family = fonts?.find((f) => f.name === t.font);
  // photo info goes in where the cursor was, or at the end
  const caret = useRef<number | null>(null);
  const insert = (token: string) => {
    const at = caret.current ?? t.text.length;
    set({ text: t.text.slice(0, at) + `{${token}}` + t.text.slice(at) });
    caret.current = at + token.length + 2;
  };
  return (
    <>
      <div className="text-and-grid">
        <textarea ref={area} className="field text-area" rows={2} value={t.text}
                  onChange={(e) => set({ text: e.target.value })}
                  onSelect={(e) => { caret.current = e.currentTarget.selectionStart; }} />
        <div className="pos-grid" title="Position">
          {POSITION_NAMES.map((n, p) => (
            <button key={p} title={n} className={t.position === p ? "on" : ""} onClick={() => set({ position: p })} />
          ))}
        </div>
      </div>
      <div className="row">
        <select className="token-menu" value="" onChange={(e) => { if (e.target.value) insert(e.target.value); }}>
          <option value="">Insert photo info…</option>
          {TEXT_TOKENS.map(([group, list]) => (
            <optgroup key={group} label={group}>
              {list.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </optgroup>
          ))}
        </select>
        <div className="segmented small">
          <button className={!t.beforeBorders ? "active" : ""} onClick={() => set({ beforeBorders: false })}>In the border</button>
          <button className={t.beforeBorders ? "active" : ""} onClick={() => set({ beforeBorders: true })}>On the photo</button>
        </div>
      </div>
      <div className="row">
        <span className="k">Font</span>
        <select value={t.font} disabled={!fonts} onChange={(e) => {
          const f = fonts?.find((x) => x.name === e.target.value);
          // the face nearest the weight chosen before
          const face = f?.faces.filter((x) => x.italic === t.italic)
            .sort((a, b) => Math.abs(a.weight - t.weight) - Math.abs(b.weight - t.weight))[0];
          set({ font: e.target.value, ...(face ? { weight: face.weight } : {}) });
        }}>
          {!family && <option value={t.font}>{fonts ? `${t.font} (not installed)` : t.font}</option>}
          {fonts?.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
        </select>
        <select className="face" value={`${t.weight}:${t.italic}`} onChange={(e) => {
          const [w, i] = e.target.value.split(":");
          set({ weight: Number(w), italic: i === "true" });
        }}>
          {(family?.faces.length ? family.faces : [{ name: "Regular", weight: t.weight, italic: t.italic }])
            .slice().sort((a, b) => a.weight - b.weight || Number(a.italic) - Number(b.italic))
            .map((f) => <option key={`${f.weight}:${f.italic}`} value={`${f.weight}:${f.italic}`}>{f.name}</option>)}
        </select>
      </div>
      <div className="row">
        <span className="k">Size</span>
        <Num value={t.size} onChange={(size) => set({ size })} />
        <UnitPick value={t.sizeUnit} units={["px", "short"]} onChange={(sizeUnit) => set({ sizeUnit })} />
      </div>
      <div className="row">
        <span className="k">Color</span>
        <ColorPick value={t.color} onChange={(color) => set({ color })} />
      </div>
      <button className="more-toggle" onClick={() => setMore(!more)}>
        <Chevron open={more} /> More: offset, opacity, backdrop
      </button>
      {more && (
        <>
          <div className="row">
            <span className="k">Offset</span>
            <label className="check-inline" title="across, in from the side">↔ <Num value={t.insetX} min={-10000} onChange={(insetX) => set({ insetX })} /></label>
            <label className="check-inline" title="up or down, in from the edge">↕ <Num value={t.insetY} min={-10000} onChange={(insetY) => set({ insetY })} /></label>
            <UnitPick value={t.insetUnit} units={["px", "short"]} onChange={(insetUnit) => set({ insetUnit })} />
          </div>
          <div className="row">
            <span className="k">Opacity</span>
            <Opacity value={t.opacity} onChange={(opacity) => set({ opacity })} />
          </div>
          <div className="row">
            <label className="check-inline k">
              <input type="checkbox" checked={t.background} onChange={(e) => set({ background: e.target.checked })} />
              Backdrop
            </label>
            {t.background && (
              <>
                <ColorPick value={t.bgColor} onChange={(bgColor) => set({ bgColor })} />
                <Opacity value={t.bgOpacity} onChange={(bgOpacity) => set({ bgOpacity })} />
              </>
            )}
          </div>
        </>
      )}
    </>
  );
}

// one part of the frame: its items, each folding to a one-line summary
function Part<T extends { id: string }>({ title, hint, items, onChange, make, summary, card, addLabel }: {
  title: string; hint: string; items: T[]; onChange: (l: T[]) => void; make: () => T;
  summary: (x: T) => string; card: (x: T, set: (p: Partial<T>) => void) => React.ReactNode; addLabel: string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const set = (k: number, patch: Partial<T>) => onChange(items.map((x, i) => i === k ? { ...x, ...patch } : x));
  return (
    <div className="frame-part">
      <div className="frame-part-head">
        <h5>{title}</h5>
        <button className="btn small" onClick={() => { const x = make(); onChange([...items, x]); setOpen(x.id); }}>
          + {addLabel}
        </button>
      </div>
      {!items.length && <div className="note-plain">{hint}</div>}
      {items.map((x, k) => (
        <div key={x.id} className="frame-item">
          <div className="frame-item-head">
            <button className="fold" onClick={() => setOpen(open === x.id ? null : x.id)}>
              <Chevron open={open === x.id} /><span>{summary(x)}</span>
            </button>
            <ItemTools index={k} count={items.length} onMove={(to) => onChange(move(items, k, to))}
                       onRemove={() => onChange(items.filter((_, i) => i !== k))} />
          </div>
          {open === x.id && <div className="frame-item-body">{card(x, (p) => set(k, p))}</div>}
        </div>
      ))}
    </div>
  );
}

const unitShort = (u: Unit) => u === "px" ? " px" : "%";
const sidesText = (same: boolean, v: Sides, u: Unit) => same ? `${v.top}${unitShort(u)}`
  : `${v.top} ${v.right} ${v.bottom} ${v.left}${unitShort(u)}`;

export function FrameEditor({ s, set }: {
  s: Settings; set: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
}) {
  const fonts = useFonts();
  return (
    <div className="frame-editor">
      <Part title="Frame" addLabel="Frame" items={s.borders} onChange={(l) => set("borders", l)}
            hint="space added around the photo, wider at the bottom if you like; nothing is cropped"
            make={() => ({ ...newBorder(), ...(s.borders.length ? { unit: s.borders[s.borders.length - 1].unit } : {}) })}
            summary={(b) => `${sidesText(b.identical, b, b.unit)} ${b.color}`}
            card={(b, p) => <BorderCard b={b} set={p} />} />
      <Part title="Keyline" addLabel="Keyline" items={s.inner} onChange={(l) => set("inner", l)}
            hint="a thin line drawn on the photo's edge, or inset from it"
            make={newInner}
            summary={(b) => `${sidesText(b.identical, b.size, b.sizeUnit)} ${b.color}${b.opacity < 100 ? ` at ${b.opacity}%` : ""}`}
            card={(b, p) => <KeylineCard b={b} set={p} />} />
      <Part title="Captions" addLabel="Caption" items={s.texts} onChange={(l) => set("texts", l)}
            hint="text from each photo's info, such as its title or camera settings, in the border or on the photo"
            make={newText}
            summary={(t) => `${POSITION_NAMES[t.position]}: ${t.text.replace(/\s+/g, " ") || "(empty)"}`}
            card={(t, p) => <CaptionCard t={t} set={p} fonts={fonts} />} />
      {s.texts.length > 0 && (
        <div className="note-plain small">if a photo lacks a piece of info, text after a comma stands in:
          {" {lens, unknown lens}"}</div>
      )}
    </div>
  );
}
