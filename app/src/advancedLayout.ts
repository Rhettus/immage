// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Advanced mode's module cards are generated from darktable's introspection,
// which says what a module's fields are but not how darktable's own GUI lays
// them out: the order, which fields are hidden, the soft slider ranges, the
// units and when a field shows. This is that part, written by hand from each
// module's gui_init and gui_changed, one entry per module.
export type LayoutField = {
  path: string;    // a schema path, or "name[i]" for one element of an array
  label: string;
  tab?: string;      // darktable's notebook page the field is on
  section?: string;  // a section heading darktable shows above the field
  // the slider's range as darktable first shows it; typing a value or an
  // edit made elsewhere can go past it, up to the schema's min and max
  soft?: [number, number];
  unit?: string;
  digits?: number;
  // darktable's slider shows value * factor + offset (a 0..1 param as %)
  factor?: number;
  offset?: number;
  // the enum values darktable's combobox offers, when it leaves some out
  options?: number[];
  // darktable shows the field only for some settings of the others
  showIf?: (params: Record<string, number>) => boolean;
};

export type ModuleLayout = {
  op: string;
  group: string;   // the panel (manifest.ts) whose Advanced group holds the card
  title: string;
  fields: LayoutField[];
};

export const LAYOUTS: ModuleLayout[] = [
  {
    // exposure.c gui_init (the mode combobox over a manual and a deflicker
    // page, then black level); the mode stack is gui_changed's showIf
    op: "exposure", group: "basic", title: "Exposure",
    fields: [
      { path: "mode", label: "Mode" },
      { path: "compensate_exposure_bias", label: "Compensate camera exposure", showIf: (p) => p.mode !== 1 },
      { path: "exposure", label: "Exposure", soft: [-3, 4], unit: "EV", digits: 3, showIf: (p) => p.mode !== 1 },
      { path: "deflicker_percentile", label: "Percentile", unit: "%", digits: 1, showIf: (p) => p.mode === 1 },
      { path: "deflicker_target_level", label: "Target level", unit: "EV", digits: 1, showIf: (p) => p.mode === 1 },
      { path: "black", label: "Black level correction", soft: [-0.1, 0.1], digits: 4 },
    ],
  },
];

export const layoutFor = (op: string, group: string) => LAYOUTS.find((l) => l.op === op && l.group === group);

// a group's cards sit in LAYOUTS order (Simple's sections), not pipe order
export const layoutRank = (op: string, group: string) => LAYOUTS.findIndex((l) => l.op === op && l.group === group);
export const groupLayouts = (group: string) => LAYOUTS.filter((l) => l.group === group);

// the schema field a layout path reads: "red[2]" is an element of array "red"
export const fieldPath = (path: string) => path.replace(/\[\d+\]$/, "");
