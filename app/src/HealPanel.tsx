// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Lightroom's Remove panel, Heal and Clone, with Fill and Blur beside them:
// the brush for new spots, the selected spot's own settings, the settings
// fill and blur spots share, which spots show, and Visualize Spots
import type { Control } from "./manifest";
import { DROPPER } from "./ParametricEditor";
import { FillSection } from "./FillSection";
import type { ShowSpots, SpotTool } from "./SpotOverlay";
import { hasSource, type FillSettings, type Spot } from "./spots";
import { t } from "./i18n";

const MODES = ["heal", "clone", "fill", "blur"] as const;

// a stored color as darktable's swatch shows it: the values as they are
const swatch = (c: [number, number, number] | null | undefined) =>
  c ? `rgb(${c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)).join(",")})` : "transparent";

export function HealPanel({ tool, spots, selected, show, visualize, disabled, fill, picking, renderSlider,
                            onTool, onSpot, onDeselect, onDelete, onClear, onShow, onVisualize, onFill, onPick }: {
  tool: SpotTool; spots: Spot[]; selected: number | null; show: ShowSpots; visualize: number | null; disabled: boolean;
  fill: FillSettings;                       // what the photo's fill and blur spots share
  picking: "color" | "range" | null;        // the eyedropper that is on, for a spot's color or the color range
  renderSlider: (c: Control, value: number, onChange: (v: number) => void) => React.ReactNode;
  onTool: (t: SpotTool) => void;
  onDeselect: () => void;
  onFill: (patch: Partial<FillSettings>) => void;
  onPick: (p: "color" | "range" | null) => void;
  onSpot: (patch: Partial<Spot>) => void;  // the selected spot changed
  onDelete: () => void;
  onClear: () => void;
  onShow: (v: ShowSpots) => void;
  onVisualize: (v: number | null) => void;
}) {
  const sel = selected !== null ? spots[selected] : undefined;
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
  const set = (patch: Partial<SpotTool>) => {
    onTool({ ...tool, ...patch });
    if (!sel) return;
    if (patch.size !== undefined)
      onSpot(sel.type === "circle" ? { r: patch.size / 2 } : { size: patch.size });
    else onSpot(patch as Partial<Spot>);
  };
  // another kind of spot: the selected one changes with it among its own
  // kind (heal and clone, fill and blur), else the brush goes to the new
  // kind and the spot is let go
  const setMode = (m: Spot["mode"]) => {
    if (sel && hasSource(sel) !== hasSource({ mode: m })) {
      onTool({ ...tool, mode: m });
      onDeselect();
      return;
    }
    // a spot made over as fill or blur takes the brush's settings for it
    set(hasSource({ mode: m }) ? { mode: m } : {
      mode: m, fill_mode: tool.fill_mode, fill_brightness: tool.fill_brightness, blur_type: tool.blur_type,
      blur_radius: tool.blur_radius, ...(tool.fill_color ? { fill_color: tool.fill_color } : {}),
    });
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
                          onClick={() => set({ fill_mode: v })}>{v === 1 ? t("fields.heal.fill.color") : t("fields.heal.fill.erase")}</button>
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
            {renderSlider({ id: "spot_fill_brightness", label: t("fields.heal.fill.brightness"), min: -100, max: 100, step: 1,
                            neutral: 0, format: pct }, brightness * 100, (v) => set({ fill_brightness: v / 100 }))}
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
                          onClick={() => set({ blur_type: v })}>{v === 0 ? t("fields.heal.blur.gaussian") : t("fields.heal.blur.bilateral")}</button>
                ))}
              </div>
            </div>
            {renderSlider({ id: "spot_blur_radius", label: t("fields.heal.blur.radius"), min: 0.1, max: 200, step: 0.1, neutral: 10,
                            format: (v) => v.toFixed(1) }, radius, (v) => set({ blur_radius: v }))}
          </>
        )}
        <div className="note-plain">
          {sel ? hasSource(sel) ? t("fields.heal.selected.hint") : t("fields.heal.selected.fillHint")
            : mode === "fill" ? t("fields.heal.empty.fillHint") : mode === "blur" ? t("fields.heal.empty.blurHint")
            : t("fields.heal.empty.hint")}
        </div>
        <div className="heal-actions">
          <button className="btn small" disabled={disabled || !sel} onClick={onDelete}>{t("fields.heal.delete")}</button>
          <button className="btn small" disabled={disabled || !spots.length} onClick={onClear}>
            {t("fields.heal.clearAll")}{spots.length ? ` (${spots.length})` : ""}</button>
        </div>
      </section>
      {(mode === "fill" || mode === "blur" || fills) && (
        <FillSection fill={fill} disabled={disabled} picking={picking === "range"} renderSlider={renderSlider}
                     onFill={onFill} onPick={(on) => onPick(on ? "range" : null)} />
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
