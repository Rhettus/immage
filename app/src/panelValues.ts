// SPDX-License-Identifier: GPL-3.0-or-later
import { isModuleSetting, MODULE_CHOICES, panels, type Panel, type Values } from "./manifest";

const modes = new Set(["neg_on", "sf_on", "bw_mode", "tc_mode", "tm_mode", ...MODULE_CHOICES.map(c => c.control)]);
const controls = new WeakMap<Panel, Set<string>>();

// the hidden panels a panel edits through its own tools: the point curve,
// the vignette's center, Upright
const PARTS: Record<string, string> = { tonecurve: "tonecurve-points", effects: "vignette-center", transform: "upright" };
const own = (id: string) => panels.find((p) => p.id === id)?.sections.flatMap((s) => s.controls.map((c) => c.id)) ?? [];
const peeks = new WeakMap<Panel, string[]>();
// what a panel's eye shows at its defaults: its controls, less the module
// choices (which pick a module rather than edit one) and what the Before
// view keeps (App.tsx, keptBefore)
export function peekIds(panel: Panel): string[] {
  let ids = peeks.get(panel);
  if (!ids) {
    ids = [...new Set([...own(panel.id), ...(PARTS[panel.id] ? own(PARTS[panel.id]) : [])])]
      .filter((id) => !isModuleSetting(id) && !id.startsWith("crop_") && id !== "orient" && id !== "exp_comp");
    peeks.set(panel, ids);
  }
  return ids;
}
// Graph data includes point-curve coordinates that have no slider of their own.
export function panelValues(panel: Panel, values: Values, previous?: Values): Values {
  let ids = controls.get(panel);
  if (!ids) { ids = new Set([...modes, ...panel.sections.flatMap(s => s.controls.map(c => c.id)), ...peekIds(panel)]); controls.set(panel, ids); }
  const graphPrefix = panel.graph === "tonecurve" ? "tc_" : panel.graph === "colorwheels" ? "cg_" : null;
  const next: Values = {};
  for (const id of Object.keys(values)) if (ids.has(id) || (graphPrefix && id.startsWith(graphPrefix))) next[id] = values[id];
  if (previous && Object.keys(previous).length === Object.keys(next).length
      && Object.keys(next).every(id => Object.is(previous[id], next[id]))) return previous;
  return next;
}
