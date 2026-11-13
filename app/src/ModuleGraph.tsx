// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Simple's contrast equalizer or saturation curve on an Advanced card (the
// layout's `graph`), over the module's own manifest map: the card's params
// are read into the graph's values, and an edit is written back through the
// map, so the two modes edit the same params the same way
import { ContrastEqualizer } from "./ContrastEqualizer";
import { SaturationCurve } from "./SaturationCurve";
import type { ImageContext } from "./manifest";
import { GRAPHS } from "./graphMaps";
import type { AdvancedState } from "./session";

// these two maps ignore the image, so a card with no photo's context reads and writes the same
const NO_IMAGE: ImageContext = { sensorWidth: 1, sensorHeight: 1, orientation: 0, camera: 0 };

export function ModuleGraph({ kind, state, disabled, onFields }: {
  kind: keyof typeof GRAPHS; state: AdvancedState; disabled: boolean;
  onFields: (edit: Record<string, number>, coalesce: boolean, id: string) => void;
}) {
  const map = GRAPHS[kind];
  const params = { ...state.defaults, ...state.params };
  const values = map.read(params, state.defaults, NO_IMAGE);
  const onChange = (entries: [string, number][]) => {
    const written = map.write({ ...values, ...Object.fromEntries(entries) }, state.defaults, NO_IMAGE);
    // only what changed, so a drag sends the band or node set it moved; a
    // saturation curve's slots past its last point go as zero, clearing stale nodes
    const edit = Object.fromEntries(Object.entries(written).filter(([k, v]) => Math.abs(v - (params[k] ?? NaN)) > 1e-6 || !(k in params)));
    if (Object.keys(edit).length) onFields(edit, true, `${map.op}-graph`);
  };
  return (
    <div className="module-card-graph" data-graph={map.op}>
      {kind === "equalizer"
        ? <ContrastEqualizer values={values} disabled={disabled} onChange={onChange} heading={false} />
        : <SaturationCurve values={values} disabled={disabled} onChange={onChange} heading={false} />}
    </div>
  );
}
