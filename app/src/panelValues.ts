// SPDX-License-Identifier: GPL-3.0-or-later
import { MODULE_CHOICES, type Panel, type Values } from "./manifest";

const modes = new Set(["neg_on", "bw_mode", "tc_mode", "tm_mode", ...MODULE_CHOICES.map(c => c.control)]);
const controls = new WeakMap<Panel, Set<string>>();
// Graph data includes point-curve coordinates that have no slider of their own.
export function panelValues(panel: Panel, values: Values, previous?: Values): Values {
  let ids = controls.get(panel);
  if (!ids) { ids = new Set([...modes, ...panel.sections.flatMap(s => s.controls.map(c => c.id))]); controls.set(panel, ids); }
  const graphPrefix = panel.graph === "tonecurve" ? "tc_" : panel.graph === "colorwheels" ? "cg_" : null;
  const next: Values = {};
  for (const id of Object.keys(values)) if (ids.has(id) || (graphPrefix && id.startsWith(graphPrefix))) next[id] = values[id];
  if (previous && Object.keys(previous).length === Object.keys(next).length
      && Object.keys(next).every(id => Object.is(previous[id], next[id]))) return previous;
  return next;
}
