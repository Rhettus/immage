// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the Negative panel: a film negative turned positive by darktable's
// negadoctor, in the order darktable's manual sets it. the film border
// first, which converts the photo; then the photo area, which sets the
// rest; then each control on its own, its eyedropper picking a box for it
// alone (negadoctor.ts)
import { useState } from "react";
import { Pipette } from "lucide-react";
import { Chevron, Collapse } from "./Collapse";
import { FILM_BW } from "./negadoctor";

export type NegPick = "border" | "area" | "dmax" | "offset" | "black" | "exposure" | "shadows" | "highlights";

const PICK_HINTS: Record<NegPick, string> = {
  border: "drag a box over the unexposed film border, clear of dust and of any pre-exposed edge",
  area: "drag a box over the photo, inside the border, clear of dust and scratches",
  dmax: "drag over the brightest part of the scene, or the whole photo",
  offset: "drag over the film border, or the whole photo",
  black: "drag over what should be pure black: the film border, or a dark part of the photo",
  exposure: "drag over the brightest part of the photo, or the whole photo",
  shadows: "drag over the film border, or a shadow that should be neutral",
  highlights: "drag over something white or gray, or the whole photo",
};

export function NegativePanel({ values, disabled, converted, picking, busy, hasArea, note, renderControl,
                                onPick, onTurnOff, onResetColor }: {
  values: Record<string, number>; disabled: boolean; converted: boolean;
  picking: NegPick | null; busy: boolean; hasArea: boolean; note: string | null;
  renderControl: (id: string) => React.ReactNode;
  onPick: (kind: NegPick | null) => void;
  onTurnOff: () => void;
  onResetColor: () => void;
}) {
  const [advanced, setAdvanced] = useState(false);
  const off = disabled || busy;
  const pickButton = (kind: NegPick, label: string, title: string) => (
    <button className={`btn small${picking === kind ? " on" : ""}`} disabled={off} title={title}
            onClick={() => onPick(picking === kind ? null : kind)}>
      <Pipette size={13} strokeWidth={1.8} />{label}
    </button>
  );
  // a slider with an eyedropper beside it that sets it alone
  const withPick = (id: string, kind: NegPick, title: string) => (
    <div className="neg-row" key={id}>
      <div className="neg-slider">{renderControl(id)}</div>
      <button className={`tool${picking === kind ? " on" : ""}`} disabled={off || !converted} title={title}
              onClick={() => onPick(picking === kind ? null : kind)}><Pipette size={14} strokeWidth={1.8} /></button>
    </div>
  );
  // the film base as a color, as darktable's swatch shows it
  const swatch = `rgb(${["r", "g", "b"].map((c) => Math.round(255 * Math.min(1, Math.max(0, values[`neg_dmin_${c}`] ?? 0))
    ** (1 / 2.2))).join(", ")})`;
  const color = values.neg_film !== FILM_BW;
  return (
    <div className="panel negative">
      <div className="panel-title"><span>Negative</span></div>
      <section>
        {renderControl("neg_film")}
        <div className="neg-step">
          {pickButton("border", "Pick Film Border",
                      converted ? "pick the film border again" : "pick the unexposed film border: this converts the negative")}
          {converted && <span className="neg-swatch" style={{ background: swatch }} title="Border Color" />}
        </div>
        <div className="neg-step">
          {pickButton("area", "Pick Photo Area",
                      "the photo inside the border, which White Point, Black Point, Blacks and Exposure are set from")}
          {hasArea && <span className="note-plain">set</span>}
        </div>
        <div className="note-plain">
          {picking ? PICK_HINTS[picking]
            : note ?? (converted ? "the whole frame shows while you pick, so the film border can be reached"
                                 : "start with the film border: picking it converts the negative")}
        </div>
      </section>
      {converted && (
        <>
          <section>
            <h3>Film</h3>
            {withPick("neg_dmax", "dmax", "pick the brightest part of the scene")}
            {withPick("neg_offset", "offset", "pick the film border, or the whole photo")}
          </section>
          {color && (
            <section>
              <h3>Color</h3>
              <div className="neg-step">
                {pickButton("shadows", "Neutral Shadows", "pick the film border or a neutral shadow, to take a cast out of the shadows")}
                {pickButton("highlights", "Neutral Highlights", "pick something white or gray, to set the white balance")}
              </div>
              <div className="neg-step">
                <button className="btn small" disabled={off} onClick={onResetColor}>Reset Color</button>
              </div>
            </section>
          )}
          <section>
            <h3>Tone</h3>
            {withPick("neg_exposure", "exposure", "pick the brightest part of the photo, or the whole photo")}
            {renderControl("neg_grade")}
            {withPick("neg_black", "black", "pick what should be pure black")}
            {renderControl("neg_gloss")}
          </section>
          <section>
            <h3 className="fold" onClick={() => setAdvanced(!advanced)}>Advanced<Chevron open={advanced} /></h3>
            <Collapse open={advanced}>
              <div className="section-body">
                <div className="neg-sub">Border Color</div>
                {(color ? ["r", "g", "b"] : ["r"]).map((c) => renderControl(`neg_dmin_${c}`))}
                {color && <div className="neg-sub">Shadow Tint</div>}
                {color && ["r", "g", "b"].map((c) => renderControl(`neg_wbl_${c}`))}
                <div className="neg-sub">White Balance</div>
                {["r", "g", "b"].map((c) => renderControl(`neg_wbh_${c}`))}
              </div>
            </Collapse>
          </section>
          <section>
            <button className="btn small" disabled={off} onClick={onTurnOff}
                    title="the photo back as a negative, with Basic's tools as they were">Turn Off Conversion</button>
          </section>
        </>
      )}
    </div>
  );
}
