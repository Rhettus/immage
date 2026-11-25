// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the settings a photo's Fill and Blur spots share (darktable holds them in
// one retouch instance, which blends as a whole): whether they change color
// only or color and tone, how strongly, and the color they are limited to,
// as a mask's color range is set
import { useState } from "react";
import type { Control } from "./manifest";
import { rangeChannels, type ColorRange, type ParametricRange, type Range } from "./masks";
import { DROPPER, ParametricEditor } from "./ParametricEditor";
import type { FillSettings } from "./spots";
import { t } from "./i18n";

type Limit = "off" | "color" | "custom";

// a skin tone's hue (JzCzhz, 0-1), where a range starts before a pick
const START: ColorRange = { type: "color", hue: 0.1, width: 0.04, feather: 0.04, chroma: 0.002 };

const noop = () => {};

export function FillSection({ fill, disabled, picking, renderSlider, onFill, onPick }: {
  fill: FillSettings;
  disabled: boolean;
  picking: boolean;                         // the eyedropper for the color range is on
  renderSlider: (c: Control, value: number, onChange: (v: number) => void) => React.ReactNode;
  onFill: (patch: Partial<FillSettings>) => void;
  onPick: (on: boolean) => void;
}) {
  const ranges = fill.ranges as unknown as Range[];
  // a custom range with no channel set limits nothing, and reads back as none
  const [chosen, setChosen] = useState<Limit>("off");
  const limit: Limit = ranges.some((r) => r.type === "parametric") ? "custom" : ranges.some((r) => r.type === "color") ? "color"
    : chosen === "color" ? "off" : chosen;
  const set = (patch: Partial<FillSettings>) => onFill(patch);
  const setRanges = (next: Range[]) => set({ ranges: next as unknown as FillSettings["ranges"] });
  const color = ranges.find((r): r is ColorRange => r.type === "color");
  const custom = ranges.find((r): r is ParametricRange => r.type === "parametric");
  const choose = (next: Limit) => {
    setChosen(next);
    if (next === "off") { setRanges([]); onPick(false); }
    else if (next === "color") setRanges([color ?? START]);
    else setRanges(color ? [{ type: "parametric", channels: rangeChannels(color) }] : []);
  };
  const pct = (v: number) => `${Math.round(v)}`;
  return (
    <section>
      <div className="heal-sub">{t("fields.heal.fillblur.title")}</div>
      <div className="heal-row">
        <span>{t("fields.heal.fillblur.affects")}</span>
        <div className="seg heal-mode">
          {(["chromaticity", "normal"] as const).map((b) => (
            <button key={b} className={`btn small${fill.blend === b ? " on" : ""}`} disabled={disabled}
                    title={b === "chromaticity" ? t("fields.heal.fillblur.colorOnly.hint") : t("fields.heal.fillblur.colorTone.hint")}
                    onClick={() => set({ blend: b })}>
              {b === "chromaticity" ? t("fields.heal.fillblur.colorOnly") : t("fields.heal.fillblur.colorTone")}</button>
          ))}
        </div>
      </div>
      {renderSlider({ id: "fill_strength", label: t("fields.heal.fillblur.strength"), min: 0, max: 100, step: 1, neutral: 100, format: pct },
                    fill.opacity, (v) => set({ opacity: v }))}
      <div className="heal-row">
        <span>{t("fields.heal.fillblur.limit")}</span>
        <div className="seg heal-mode">
          {(["off", "color", "custom"] as const).map((l) => (
            <button key={l} className={`btn small${limit === l ? " on" : ""}`} disabled={disabled}
                    title={t(`fields.heal.fillblur.limit.${l}.hint`)}
                    onClick={() => choose(l)}>{t(`fields.heal.fillblur.limit.${l}`)}</button>
          ))}
        </div>
      </div>
      {limit === "color" && color && (
        <>
          <div className="heal-row">
            <button className={`pm-tool${picking ? " on" : ""}`} disabled={disabled}
                    title={t("fields.heal.fillblur.pickRange")} aria-label={t("fields.heal.fillblur.pickRange")}
                    onClick={() => onPick(!picking)}>{DROPPER}</button>
            <span>{t("fields.heal.fillblur.pickRange")}</span>
          </div>
          {renderSlider({ id: "fill_hue", label: t("fields.text.Hue"), min: 0, max: 360, step: 1, neutral: 0,
                          format: (v) => `${Math.round(v)}°` },
                        color.hue * 360, (v) => setRanges([{ ...color, hue: (v % 360) / 360 }]))}
          {renderSlider({ id: "fill_hue_range", label: t("fields.text.Hue Range"), min: 0, max: 100, step: 1,
                          neutral: (0.04 - 0.005) / 0.00445, format: pct },
                        (color.width - 0.005) / 0.00445, (v) => setRanges([{ ...color, width: 0.005 + v * 0.00445 }]))}
          {renderSlider({ id: "fill_chroma", label: t("fields.text.Minimum Chroma"), min: 0,
                          max: Math.max(100, Math.ceil(color.chroma * 1000)), step: 0.1, neutral: 2,
                          format: (v) => v.toFixed(1) },
                        color.chroma * 1000, (v) => setRanges([{ ...color, chroma: v / 1000 }]))}
          {renderSlider({ id: "fill_smooth", label: t("fields.text.Smoothness"), min: 0, max: 100, step: 1, neutral: 19,
                          format: pct },
                        (color.feather - 0.002) / 0.002, (v) => setRanges([{ ...color, feather: 0.002 + v * 0.002 }]))}
        </>
      )}
      {limit === "custom" && (
        <ParametricEditor range={custom ?? { type: "parametric", channels: {} }} picked={null} showing={false} setting={null}
                          disabled={disabled} renderSlider={renderSlider} pickers={false}
                          onChange={(channels) => setRanges([{ type: "parametric", channels }])}
                          onShow={noop} onSet={noop} onTab={noop} />
      )}
      <div className="note-plain">{t("fields.heal.fillblur.hint")}</div>
    </section>
  );
}
