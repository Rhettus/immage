// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the point curve of an Advanced card for tonecurve or rgbcurve (the layout's
// `curves`): channel tabs, the graph, and darktable's interpolation method
import { useState } from "react";
import { PointCurve } from "./PointCurve";
import { curveFn, MAX_NODES, type Point } from "./tonecurve";
import { INTERPOLATIONS, type ModuleLayout } from "./advancedLayout";
import type { AdvancedState } from "./session";

type Curves = NonNullable<ModuleLayout["curves"]>;

export function ModuleCurves({ op, curves, state, disabled, onFields }: {
  op: string; curves: Curves; state: AdvancedState; disabled: boolean;
  onFields: (edit: Record<string, number>, coalesce: boolean, id: string) => void;
}) {
  const [tab, setTab] = useState(0);
  const p = state.params, d = state.defaults;
  const tabs = curves.tabs(p);
  // linked channels have the one curve; a hidden tab cannot stay selected
  const ch = tabs ? tab : 0;
  const n = Math.max(2, Math.min(MAX_NODES, p[curves.count(ch)] ?? d[curves.count(ch)] ?? 2));
  const points: Point[] = Array.from({ length: n }, (_, k) => [
    p[curves.node(ch, k, "x")] ?? d[curves.node(ch, k, "x")] ?? k / (n - 1),
    p[curves.node(ch, k, "y")] ?? d[curves.node(ch, k, "y")] ?? k / (n - 1),
  ]);
  const type = p[curves.type(ch)] ?? d[curves.type(ch)] ?? 2;
  const off = disabled || !curves.editable(p, ch);
  return (
    <div className="module-card-curve" data-curve={op}>
      {tabs && (
        <div className="segmented small module-card-tabs" role="tablist">
          {curves.channels.map((label, i) => (
            <button key={label} role="tab" aria-selected={i === ch} className={i === ch ? "active" : ""}
                    data-curve-channel={label} onClick={() => setTab(i)}>{label}</button>
          ))}
        </div>
      )}
      <PointCurve points={points} disabled={off} histogram={null} channel={curves.colored ? (ch as 0 | 1 | 2) : null}
                  draw={(pts) => curveFn(type, pts)} label={`${op} ${curves.channels[ch]} curve`}
                  onChange={(pts) => {
                    const edit: Record<string, number> = { [curves.count(ch)]: pts.length };
                    pts.forEach(([x, y], k) => { edit[curves.node(ch, k, "x")] = x; edit[curves.node(ch, k, "y")] = y; });
                    onFields(edit, true, `${op}-curve-${ch}`);
                  }} />
      <div className="choice-row" data-control-id={`${op}-interpolation`}>
        <span>Interpolation method</span>
        <select className="field" value={type} disabled={disabled}
                onChange={(e) => onFields(Object.fromEntries(curves.channels.map((_, i) => [curves.type(i), Number(e.target.value)])),
                                          false, `${op}-interpolation`)}>
          {INTERPOLATIONS.map(([label, v]) => <option key={v} value={v}>{label}</option>)}
        </select>
      </div>
    </div>
  );
}
