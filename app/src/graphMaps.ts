// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the manifest maps behind an Advanced card's graph (ModuleLayout.graph),
// apart from ModuleGraph so a Node test can import them without JSX
import { colorzonesMap, equalizerMap, satcurveMap, type ModuleMap } from "./manifest";

export const GRAPHS: Record<"equalizer" | "satcurve" | "colorzones", ModuleMap> =
  { equalizer: equalizerMap, satcurve: satcurveMap, colorzones: colorzonesMap };

// the schema's name for a mapped param: `y[0][1]` and `channel[0].curve[2].x` are the fields y and channel
export const graphFields = (kind: keyof typeof GRAPHS) =>
  [...new Set(GRAPHS[kind].fields.map((f) => f.replace(/[[.].*$/, "")))];
