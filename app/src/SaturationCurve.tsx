// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// darktable's saturation curve (satcurvergb) as its two curves: across, how
// saturated a color is; up, more of the channel than it had, down, less
import { useState } from "react";
import { PointCurve } from "./PointCurve";
import { SAT_CHANNELS, SATCURVE_NEUTRAL, satPointsOf, satPointValues, type SatChannel, type Values } from "./manifest";

export function SaturationCurve({ values, disabled, onChange, module }: {
  values: Values; disabled: boolean; onChange: (entries: [string, number][]) => void;
  module?: React.ReactNode;   // the ModuleSwitch beside the name
}) {
  const [channel, setChannel] = useState<SatChannel>(0);
  return <div className="contrast-equalizer saturation-curve">
    <div className="equalizer-heading"><span className="name">{"Saturation curve"}{module}</span><button disabled={disabled}
      onClick={() => onChange(Object.entries(SATCURVE_NEUTRAL))}>Reset</button></div>
    <select aria-label="Saturation curve channel" disabled={disabled} value={channel}
            onChange={(e) => setChannel(+e.target.value as SatChannel)}>
      {SAT_CHANNELS.map((label, c) => <option key={c} value={c}>{label}</option>)}
    </select>
    <PointCurve key={channel} points={satPointsOf(values, channel)} disabled={disabled} histogram={null}
                guide="flat" label={`${SAT_CHANNELS[channel]} curve`}
                onChange={(pts) => onChange(Object.entries(satPointValues(pts, channel)))} />
    <div className="equalizer-scale"><span>Muted</span><span>Saturated</span></div>
    <div className="equalizer-hint">
      {channel === 0 ? "Pull up to add saturation, down to remove it." : "Pull up to brighten colors, down to darken them."}
      {" "}Click to add a point; double-click or drag it off the graph to remove it.
    </div>
  </div>;
}
