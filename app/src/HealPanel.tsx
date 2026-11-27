// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Lightroom's Remove panel, Heal and Clone, with Fill and Blur beside them:
// the brush for new spots, the selected spot's own settings, the settings
// fill and blur spots share, which spots show, and Visualize Spots
import { useState } from "react";
import type { Control } from "./manifest";
import { DROPPER } from "./ParametricEditor";
import { FillSection } from "./FillSection";
import type { ShowSpots, SpotTool } from "./SpotOverlay";
import { fillColorHsl, fillColorRgb, hasSource, type FillSettings, type Spot } from "./spots";
import { formatNumber, t } from "./i18n";

const MODES = ["heal", "clone", "fill", "blur"] as const;

// a stored color as darktable's swatch shows it: the values as they are
const swatch = (c: [number, number, number] | null | undefined) =>
  c ? `rgb(${c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)).join(",")})` : "transparent";

export function HealPanel({ tool, spots, selection, onSelect, show, visualize, disabled, fill, picking, renderSlider,
                            onTool, onSpot, onDeselect, onDelete, onClear, onShow, onVisualize, onFill, onPick, rangePreviewPinned, onRangePreviewToggle, onRangeHover, fillHidden, onFillHidden }: {
  tool: SpotTool; spots: Spot[]; selection: number[]; onSelect: (index: number) => void; show: ShowSpots; visualize: number | null; disabled: boolean;
  fill: FillSettings;                       // what the photo's fill and blur spots share
  picking: "color" | "range" | null;        // the eyedropper that is on, for a spot's color or the color range
  renderSlider: (c: Control, value: number, onChange: (v: number) => void) => React.ReactNode;
  onTool: (t: SpotTool) => void;
  onDeselect: () => void;
  onFill: (patch: Partial<FillSettings>) => void;
  onPick: (p: "color" | "range" | null) => void;
  rangePreviewPinned: boolean;
  onRangePreviewToggle: (on: boolean) => void;
  onRangeHover: (on: boolean) => void;
  fillHidden: boolean;
  onFillHidden: (hidden: boolean) => void;
  onSpot: (update: (spot: Spot) => Spot, field: string) => void;
  onDelete: () => void;
  onClear: () => void;
  onShow: (v: ShowSpots) => void;
  onVisualize: (v: number | null) => void;
}) {
  const selected = selection.at(-1);
  const sel = selected === undefined ? undefined : spots[selected];
  // with a spot selected, the controls are its own, as in Lightroom; a
  // change is also kept for the next spot
  const mode = sel?.mode ?? tool.mode;
  const size = sel ? (sel.type === "circle" ? sel.r * 2 : sel.size) : tool.size;
  const feather = sel?.feather ?? tool.feather;
  const opacity = sel?.opacity ?? tool.opacity;
  // the selected spot's own fill and blur settings, else the brush's
  const fillMode = sel?.fill_mode ?? tool.fill_mode;
  const fillColor = sel ? sel.fill_color ?? null : tool.fill_color;
  const brightness = sel?.fill_brightness ?? tool.fill_brightness;
  const blurType = sel?.blur_type ?? tool.blur_type;
  const radius = sel?.blur_radius ?? tool.blur_radius;
  const set = (patch: Partial<SpotTool>, applies: (spot: Spot) => boolean = () => true) => {
    onTool({ ...tool, ...patch });
    const { size, ...settings } = patch;
    onSpot((spot) => {
      if (!applies(spot)) return spot;
      if (size === undefined) return { ...spot, ...settings };
      return spot.type === "circle" ? { ...spot, r: size / 2 } : { ...spot, size };
    }, Object.keys(patch)[0]);
  };
  const isFill = (spot: Spot) => spot.mode === "fill";
  const isBlur = (spot: Spot) => spot.mode === "blur";
  const setMode = (m: Spot["mode"]) => {
    const compatible = (spot: Spot) => hasSource(spot) === hasSource({ mode: m });
    if (sel && !compatible(sel)) {
      onTool({ ...tool, mode: m });
      onDeselect();
      return;
    }
    const patch = hasSource({ mode: m }) ? { mode: m } : {
      mode: m, fill_mode: tool.fill_mode, fill_brightness: tool.fill_brightness, blur_type: tool.blur_type,
      blur_radius: tool.blur_radius, ...(tool.fill_color ? { fill_color: tool.fill_color } : {}),
    };
    set(patch, (spot) => spot.mode !== m && compatible(spot));
  };
  const [grayColor, setGrayColor] = useState<{ selection: number[]; hue: number }>();
  const grayHue = grayColor?.selection === selection ? grayColor.hue : 0;
  const hsl = fillColor ? fillColorHsl(fillColor, grayHue) : null;
  const adjustColor = (field: "hue" | "saturation", value: number) => {
    if (!hsl) return;
    const hue = field === "hue" ? value : hsl.hue;
    setGrayColor({ selection, hue });
    onTool({ ...tool, fill_color: fillColorRgb({ ...hsl, [field]: value }) });
    onSpot((spot) => {
      if (!isFill(spot) || spot.fill_mode === 0 || !spot.fill_color) return spot;
      const color = fillColorHsl(spot.fill_color, grayHue);
      return { ...spot, fill_color: fillColorRgb({ ...color, [field]: value }) };
    }, field);
  };
  const fills = spots.some((s) => !hasSource(s));
  const pct = (v: number) => `${Math.round(v)}`;
  return (
    <div className="panel">
      <div className="panel-title"><span>{t("fields.heal.title")}</span></div>
      <section>
        <div className="seg heal-mode">
          {MODES.map((m) => (
            <button key={m} className={`btn small${mode === m ? " on" : ""}`} disabled={disabled}
                    title={t(`fields.heal.mode.${m}.hint`)}
                    onClick={() => setMode(m)}>{t(`fields.heal.mode.${m}`)}</button>
          ))}
        </div>
        {spots.length > 0 && (
          <fieldset className="heal-selection" disabled={disabled}>
            <legend>{t("fields.heal.selection")}</legend>
            <div className="heal-selection-list">
              {spots.map((spot, index) => (
                <label className={`heal-row${index === selected ? " primary" : ""}`} key={index}>
                  <input type="checkbox" checked={selection.includes(index)} onChange={() => onSelect(index)} />
                  <span>{t("fields.heal.selectionItem", {
                    mode: t(`fields.heal.mode.${spot.mode}`), number: formatNumber(index + 1),
                  })}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {renderSlider({ id: "spot_size", label: t("fields.heal.size"), min: 0.2, max: 20, step: 0.1, neutral: 3,
                        format: (v) => `${v.toFixed(1)}%` }, size * 100, (v) => set({ size: v / 100 }))}
        {renderSlider({ id: "spot_feather", label: t("fields.heal.feather"), min: 0, max: 100, step: 1, neutral: 50, format: pct },
                      feather * 100, (v) => set({ feather: v / 100 }))}
        {renderSlider({ id: "spot_opacity", label: t("fields.heal.opacity"), min: 0, max: 100, step: 1, neutral: 100, format: pct },
                      opacity * 100, (v) => set({ opacity: v / 100 }))}
        {mode === "fill" && (
          <>
            <div className="heal-row">
              <span>{t("fields.heal.fill.with")}</span>
              <div className="seg heal-mode">
                {([1, 0] as const).map((v) => (
                  <button key={v} className={`btn small${fillMode === v ? " on" : ""}`} disabled={disabled}
                          title={v === 1 ? t("fields.heal.fill.color.hint") : t("fields.heal.fill.erase.hint")}
                          onClick={() => set({ fill_mode: v }, isFill)}>{v === 1 ? t("fields.heal.fill.color") : t("fields.heal.fill.erase")}</button>
                ))}
              </div>
            </div>
            {fillMode === 1 && (
              <div className="heal-row">
                <span>{t("fields.heal.fill.colorLabel")}</span>
                <span className="heal-swatch" style={{ background: swatch(fillColor) }}
                      title={fillColor ? fillColor.map((v) => v.toFixed(3)).join(", ") : t("fields.heal.fill.fromPhoto")} />
                <button className={`pm-tool${picking === "color" ? " on" : ""}`} disabled={disabled}
                        title={t("fields.heal.fill.pick")} aria-label={t("fields.heal.fill.pick")}
                        onClick={() => onPick(picking === "color" ? null : "color")}>{DROPPER}</button>
              </div>
            )}
            {fillMode === 1 && hsl && (
              <>
                {renderSlider({ id: "spot_fill_hue", label: t("fields.heal.fill.hue"), min: 0, max: 359, step: 1,
                                neutral: 0, format: (v) => `${formatNumber(Math.round(v))}°` },
                              Math.round(hsl.hue) % 360, (v) => adjustColor("hue", v))}
                {renderSlider({ id: "spot_fill_saturation", label: t("fields.heal.fill.saturation"), min: 0, max: 100, step: 1,
                                neutral: 0, format: (v) => formatNumber(v / 100, { style: "percent" }) },
                              hsl.saturation * 100, (v) => adjustColor("saturation", v / 100))}
              </>
            )}
            {renderSlider({ id: "spot_fill_brightness", label: t("fields.heal.fill.brightness"), min: -100, max: 100, step: 1,
                            neutral: 0, format: pct }, brightness * 100, (v) => set({ fill_brightness: v / 100 }, isFill))}
          </>
        )}
        {mode === "blur" && (
          <>
            <div className="heal-row">
              <span>{t("fields.heal.blur.type")}</span>
              <div className="seg heal-mode">
                {([0, 1] as const).map((v) => (
                  <button key={v} className={`btn small${blurType === v ? " on" : ""}`} disabled={disabled}
                          title={v === 0 ? t("fields.heal.blur.gaussian.hint") : t("fields.heal.blur.bilateral.hint")}
                          onClick={() => set({ blur_type: v }, isBlur)}>{v === 0 ? t("fields.heal.blur.gaussian") : t("fields.heal.blur.bilateral")}</button>
                ))}
              </div>
            </div>
            {renderSlider({ id: "spot_blur_radius", label: t("fields.heal.blur.radius"), min: 0.1, max: 200, step: 0.1, neutral: 10,
                            format: (v) => v.toFixed(1) }, radius, (v) => set({ blur_radius: v }, isBlur))}
          </>
        )}
        <div className="note-plain">
          {sel ? hasSource(sel) ? t("fields.heal.selected.hint") : t("fields.heal.selected.fillHint")
            : mode === "fill" ? t("fields.heal.empty.fillHint") : mode === "blur" ? t("fields.heal.empty.blurHint")
            : t("fields.heal.empty.hint")}
        </div>
        <div className="heal-actions">
          <button className="btn small" disabled={disabled || !sel} onClick={onDelete}>{selection.length > 1 ? t("fields.heal.deleteSelected") : t("fields.heal.delete")}</button>
          <button className="btn small" disabled={disabled || !spots.length} onClick={onClear}>
            {t("fields.heal.clearAll")}{spots.length ? ` (${spots.length})` : ""}</button>
        </div>
      </section>
      {(mode === "fill" || mode === "blur" || fills) && (
        <FillSection fill={fill} disabled={disabled} picking={picking === "range"} renderSlider={renderSlider}
                     onFill={onFill} onPick={(on) => onPick(on ? "range" : null)} previewPinned={rangePreviewPinned}
                     onPreviewToggle={onRangePreviewToggle} onRangeHover={onRangeHover}
                     effectHidden={fillHidden} canCompare={fills} onEffectHidden={onFillHidden} />
      )}
      <section>
        <div className="heal-show">
          <span title={t("fields.heal.show.hint")}>{t("fields.heal.show")}</span>
          <div className="seg heal-mode">
            {(["always", "selected", "never"] as const).map((v) => (
              <button key={v} className={`btn small${show === v ? " on" : ""}`} disabled={disabled}
                      title={v === "always" ? t("fields.heal.show.always.hint") : v === "selected" ? t("fields.heal.show.selected.hint") : t("fields.heal.show.never.hint")}
                      onClick={() => onShow(v)}>{v === "always" ? t("fields.heal.show.always") : v === "selected" ? t("fields.heal.show.selected") : t("fields.heal.show.never")}</button>
            ))}
          </div>
        </div>
        <label className="toggle">
          <span>{t("fields.heal.visualize")}</span>
          <input type="checkbox" className="switch" checked={visualize !== null} disabled={disabled}
                 onChange={(e) => onVisualize(e.target.checked ? 50 : null)} />
        </label>
        {visualize !== null && renderSlider({ id: "spot_vis", label: t("fields.heal.threshold"), min: 0, max: 100, step: 1,
                                              neutral: 50, format: pct }, visualize, (v) => onVisualize(v))}
      </section>
    </div>
  );
}
