// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// darktable's saturation curve (satcurvergb) as its two curves: across, how
// saturated a color is; up, more of the channel than it had, down, less
import { useState } from "react";
import { PointCurve } from "./PointCurve";
import { SAT_CHANNELS, SATCURVE_NEUTRAL, satPointsOf, satPointValues, type SatChannel, type Values } from "./manifest";
import { t } from "./i18n";

export function SaturationCurve({ values, disabled, onChange, module, heading = true }: {
  values: Values; disabled: boolean; onChange: (entries: [string, number][]) => void;
  heading?: boolean;          // false on an Advanced card, whose header has the name and reset
  module?: React.ReactNode;   // the ModuleSwitch beside the name
}) {
  const [channel, setChannel] = useState<SatChannel>(0);
  return <div className="contrast-equalizer saturation-curve">
    {heading && <div className="equalizer-heading"><span className="name">{t("fields.saturationCurve.title")}{module}</span><button disabled={disabled}
      onClick={() => onChange(Object.entries(SATCURVE_NEUTRAL))}>{t("fields.reset")}</button></div>}
    <select aria-label={t("fields.saturationCurve.channel")} disabled={disabled} value={channel}
            onChange={(e) => setChannel(+e.target.value as SatChannel)}>
      {SAT_CHANNELS.map((label, c) => <option key={c} value={c}>{label}</option>)}
    </select>
    <PointCurve key={channel} points={satPointsOf(values, channel)} disabled={disabled} histogram={null}
                guide="flat" label={t("fields.saturationCurve.graph", { channel: SAT_CHANNELS[channel] })}
                onChange={(pts) => onChange(Object.entries(satPointValues(pts, channel)))} />
    <div className="equalizer-scale"><span>{t("fields.saturationCurve.muted")}</span><span>{t("fields.saturationCurve.saturated")}</span></div>
    <div className="equalizer-hint">
      {channel === 0 ? t("fields.saturationCurve.hint.saturation") : t("fields.saturationCurve.hint.brightness")}
      {" "}{t("fields.curve.pointHint")}
    </div>
  </div>;
}
