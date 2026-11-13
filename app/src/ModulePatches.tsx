// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the patch grid editor of an Advanced card for color look up table (the
// layout's `patches`), after colorchecker.c gui_init: the grid of source
// colors, a patch menu, lightness, green-magenta, blue-yellow and saturation
// sliders for the selected patch's target, and a relative or absolute target
// menu. a click selects a patch, a double-click puts its target back and a
// right-click deletes it. the picker that finds the patch for a color in
// the photo (and shift+click to replace one) is not here
import { useRef, useState } from "react";
import { Choice, Slider } from "./Controls";
import type { Control } from "./manifest";
import type { AdvancedState } from "./session";
import {
  altered, deletePatch, DEFAULT_PATCHES, editChannel, editSaturation, gridOf, highlightGray, labToSrgb, MAX_PATCHES,
  patchAt, resetPatch, sliderValues,
} from "./colorchecker";

const W = 260;   // the viewBox's width; the grid keeps darktable's aspect ratio
const pct = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);

const sliderControl = (id: string, label: string, min: number, max: number, note: string, track?: string): Control =>
  ({ id: `adv:colorchecker:${id}`, label, kind: "slider", min, max, step: 0.01, format: (v) => v.toFixed(2), note, track });

const CONTROLS = {
  L: sliderControl("L", "Lightness", -100, 200, "adjust target color Lab 'L' channel\nlower values darken target color while higher brighten it"),
  a: sliderControl("a", "Green-magenta offset", -256, 256,
    "adjust target color Lab 'a' channel\nlower values shift target color towards greens while higher shift towards magentas",
    "linear-gradient(to right, rgb(0,255,51), #fff, rgb(255,0,51))"),
  b: sliderControl("b", "Blue-yellow offset", -256, 256,
    "adjust target color Lab 'b' channel\nlower values shift target color towards blues while higher shift towards yellows",
    "linear-gradient(to right, rgb(0,0,255), #fff, rgb(255,255,0))"),
  C: sliderControl("C", "Saturation", -128, 128,
    "adjust target color saturation\nadjusts 'a' and 'b' channels of target color in Lab space simultaneously\nlower values scale towards lower saturation while higher scale towards higher saturation"),
};

export function ModulePatches({ state, disabled, onFields }: {
  state: AdvancedState; disabled: boolean;
  onFields: (edit: Record<string, number>, coalesce: boolean, id: string) => void;
}) {
  const p = state.params, d = state.defaults;
  const P = (path: string) => p[path] ?? d[path] ?? 0;
  // gui_update: the stored count is kept to 0..49
  const n = Math.min(MAX_PATCHES, Math.max(0, Math.round(P("num_patches"))));
  const { cx, cy } = gridOf(n);
  const [selected, setSelected] = useState(0);
  const [absolute, setAbsolute] = useState(0);
  // the outlined patch: none until one is chosen, or the patch menu is
  // rebuilt for a count other than the last built (_colorchecker_rebuild_patch_list)
  const built = useRef(DEFAULT_PATCHES);
  const [drawn, setDrawn] = useState(-1);
  const patch = Math.min(selected, n - 1);   // the menu and sliders always have a patch to show
  let outline = drawn >= n ? n - 1 : drawn;
  if (built.current !== n) { built.current = n; outline = patch; if (drawn !== patch) setDrawn(patch); }
  const choose = (k: number) => { setSelected(k); setDrawn(k); };

  const H = W * cy / cx;
  const send = (edit: Record<string, number>, coalesce: boolean, id: string) => !disabled && onFields(edit, coalesce, `colorchecker-${id}`);
  const at = (e: { clientX: number; clientY: number; currentTarget: Element }) => {
    const r = e.currentTarget.getBoundingClientRect();
    return patchAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, n);
  };
  const press = (e: React.MouseEvent<SVGSVGElement>) => {
    if (disabled || n === 0) return;
    const k = at(e);
    if (e.button === 0 && e.detail >= 2) {
      // double-click: target back to source (the first click already selected)
      if (k < n) send(resetPatch(P, k), false, `reset-${k}`);
      return;
    }
    if (e.button === 2 && k < n) { send(deletePatch(P, k), false, `delete-${k}`); return; }
    if (e.button === 0 || e.button === 2) choose(Math.min(k, n - 1));
  };

  const sv = n ? sliderValues(P, patch, !!absolute) : { L: 0, a: 0, b: 0, C: 0 };
  const row = (ch: "L" | "a" | "b" | "C") => (
    <Slider key={ch} control={CONTROLS[ch]} value={sv[ch]} neutral={0} values={p} disabled={disabled || !n}
            onChange={(v) => send(ch === "C" ? editSaturation(P, patch, v, !!absolute) : editChannel(P, patch, ch, v, !!absolute), true, `${ch}-${patch}`)} />
  );
  const gray = (k: number) => highlightGray(P, k);

  return (
    <div className="module-card-curve module-card-patches" data-patches="colorchecker">
      <svg className={`patches-area${disabled ? " disabled" : ""}`} viewBox={`0 0 ${W} ${H}`} aria-label="Color look up table patches"
           style={{ aspectRatio: `${cx} / ${cy}` }} shapeRendering="crispEdges"
           onMouseDown={press} onContextMenu={(e) => e.preventDefault()}>
        <rect x={0} y={0} width={W} height={H} fill="rgb(51,51,51)" />
        {Array.from({ length: n }, (_, k) => {
          const x = W * (k % cx) / cx, y = H * Math.floor(k / cx) / cy, w = W / cx, h = H / cy;
          const [r, g, b] = labToSrgb(P(`source_L[${k}]`), P(`source_a[${k}]`), P(`source_b[${k}]`));
          return (
            <g key={k}>
              <title>{`(${["L", "a", "b"].map((c) => P(`source_${c}[${k}]`).toFixed(2)).join(" ")})\naltered patches are marked with an outline\nclick to select\ndouble-click to reset\nright-click to delete patch`}</title>
              <rect x={x} y={y} width={w - 1} height={h - 1} fill={`rgb(${pct(r)},${pct(g)},${pct(b)})`} />
              {altered(P, k) && <>
                <rect x={x + 1} y={y + 1} width={w - 3} height={h - 3} fill="none" stroke="rgb(204,204,204)" strokeWidth={2} />
                <rect x={x + 2} y={y + 2} width={w - 5} height={h - 5} fill="none" stroke="rgb(51,51,51)" strokeWidth={1} />
              </>}
            </g>
          );
        })}
        {outline >= 0 && outline < n && (
          <rect x={W * (outline % cx) / cx + 5} y={H * Math.floor(outline / cx) / cy + 5} width={W / cx - 11} height={H / cy - 11}
                fill="none" stroke={`rgb(${gray(outline) * 255},${gray(outline) * 255},${gray(outline) * 255})`} strokeWidth={2} pointerEvents="none" />
        )}
      </svg>
      <div className="choice-row" data-control-id="adv:colorchecker:patch">
        <span title="color checker patch">Patch</span>
        <select className="field" value={patch} disabled={disabled || !n} title="color checker patch" onChange={(e) => choose(Number(e.target.value))}>
          {Array.from({ length: n }, (_, k) => <option key={k} value={k}>{`patch #${k}`}</option>)}
        </select>
      </div>
      {(["L", "a", "b", "C"] as const).map(row)}
      <Choice control={{ id: "adv:colorchecker:target", label: "Target color", kind: "choice", inline: true, min: 0, max: 1, step: 1,
                         options: [["Relative", 0], ["Absolute", 1]], format: String,
                         note: "control target color of the patches\nrelative - target color is relative from the patch original color\nabsolute - target color is absolute Lab value" }}
              value={absolute} neutral={0} values={p} disabled={false} onChange={setAbsolute} />
    </div>
  );
}
