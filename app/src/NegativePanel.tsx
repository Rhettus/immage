// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the Negative panel: a film negative turned positive by darktable's
// negadoctor, in the order darktable's manual sets it. the film border
// first, which converts the photo; then the photo area, which sets the
// rest; then each control on its own, its eyedropper picking a box for it
// alone (negadoctor.ts), as the steps of an accordion (GuidedSteps.tsx), the
// ones after the border locked until it is picked. Export to Library and
// turning the conversion off are its last step, `footer` (PositiveFooter.tsx)
import { useEffect, useState } from "react";
import { Pipette } from "lucide-react";
import { GuidedSteps, useStepOpen, type Step } from "./GuidedSteps";
import { FILM_BW } from "./negadoctor";
import { colorProfiles, type ColorProfiles } from "./session";

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

// the controls the advanced section renders, for its edited dot
export function negAdvancedIds(values: Record<string, number>): string[] {
  const color = values.neg_film !== FILM_BW;
  return [...(color ? ["r", "g", "b"] : ["r"]).map((c) => `neg_dmin_${c}`),
          ...(color ? ["r", "g", "b"].map((c) => `neg_wbl_${c}`) : []),
          ...["r", "g", "b"].map((c) => `neg_wbh_${c}`)];
}

export function NegativePanel({ photo, values, disabled, converted, picking, busy, hasArea, note, renderControl,
                                onPick, onResetColor, fineColorChanged, footer }: {
  fineColorChanged: boolean; footer: React.ReactNode;
  photo: object | null; values: Record<string, number>; disabled: boolean; converted: boolean;
  picking: NegPick | null; busy: boolean; hasArea: boolean; note: string | null;
  renderControl: (id: string, options?: [string, number][]) => React.ReactNode;
  onPick: (kind: NegPick | null) => void;
  onResetColor: () => void;
}) {
  const [stepOpen, setStepOpen] = useStepOpen("negative");
  const [profiles, setProfiles] = useState<ColorProfiles | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setProfiles(null);
    setProfileError(null);
    if (photo) colorProfiles().then((p) => { if (live) setProfiles(p); })
      .catch((e) => { if (live) setProfileError(String(e)); });
    return () => { live = false; };
  }, [photo, values.neg_input_profile, values.neg_working_profile]);
  const profileOptions = (role: "input" | "working") => {
    const options = profiles?.[role] ?? [];
    const value = values[`neg_${role}_profile`];
    return value !== undefined && !options.some(([, id]) => id === value)
      ? [...options, ["Current Profile", value] as [string, number]] : options;
  };
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
  const locked = !converted;
  const lockNote = "pick the film border first";
  const signed = (v: number, d: number) => `${v > 0 ? "+" : ""}${v.toFixed(d)}`;
  const steps: Step[] = [
    { id: "profiles", title: "Profiles",
      summary: `${profileOptions("input").find(([, v]) => v === values.neg_input_profile)?.[0] ?? "Input"} → `
        + `${profileOptions("working").find(([, v]) => v === values.neg_working_profile)?.[0] ?? "Working"}`,
      content: (
        <>
          {renderControl("neg_input_profile", profileOptions("input"))}
          {renderControl("neg_working_profile", profileOptions("working"))}
          <div className="note-plain">{profileError ? `Profiles unavailable: ${profileError}`
            : "Choose profiles before picking the film border; a photo still on its defaults gets the profiles you chose last when it converts. After changing either profile, pick the border and photo area again."}</div>
        </>
      ) },
    { id: "border", title: "Border & Photo Area",
      summary: `${color ? "Color" : "B&W"} · Border ${converted ? "picked" : "not picked"} · Area ${hasArea ? "set" : "not set"}`,
      content: (
        <>
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
        </>
      ) },
    { id: "base", title: "Film Base", locked, lockNote,
      summary: `White Point ${(values.neg_dmax ?? 0).toFixed(2)} · Black Point ${signed(values.neg_offset ?? 0, 2)}`,
      content: (
        <>
          {withPick("neg_dmax", "dmax", "pick the brightest part of the scene")}
          {withPick("neg_offset", "offset", "pick the film border, or the whole photo")}
        </>
      ) },
    { id: "color", title: "Color", hidden: !color, locked, lockNote, summary: "Neutral Shadows / Highlights",
      content: (
        <>
          <div className="neg-step">
            {pickButton("shadows", "Neutral Shadows", "pick the film border or a neutral shadow, to take a cast out of the shadows")}
            {pickButton("highlights", "Neutral Highlights", "pick something white or gray, to set the white balance")}
          </div>
          <div className="neg-step">
            <button className="btn small" disabled={off} onClick={onResetColor}>Reset Color</button>
          </div>
        </>
      ) },
    { id: "tone", title: "Tone", locked, lockNote,
      summary: `Exposure ${signed(values.neg_exposure ?? 0, 2)} · Contrast ${(values.neg_grade ?? 0).toFixed(1)}`,
      content: (
        <>
          {withPick("neg_exposure", "exposure", "pick the brightest part of the photo, or the whole photo")}
          {renderControl("neg_grade")}
          {withPick("neg_black", "black", "pick what should be pure black")}
          {renderControl("neg_gloss")}
        </>
      ) },
    { id: "finecolor", title: "Fine Color", hidden: !converted, locked, lockNote,
      summary: `Border Color, Shadow Tint, White Balance${fineColorChanged ? " · changed" : ""}`,
      content: (
        <div className="section-body">
          <div className="neg-sub">Border Color</div>
          {(color ? ["r", "g", "b"] : ["r"]).map((c) => renderControl(`neg_dmin_${c}`))}
          {color && <div className="neg-sub">Shadow Tint</div>}
          {color && ["r", "g", "b"].map((c) => renderControl(`neg_wbl_${c}`))}
          <div className="neg-sub">White Balance</div>
          {["r", "g", "b"].map((c) => renderControl(`neg_wbh_${c}`))}
        </div>
      ) },
    { id: "export", title: "Export Positive", locked, lockNote, summary: "Export to Library, Turn Off", content: footer },
  ];
  return (
    <div className="panel negative">
      <div className="panel-title"><span>Negative</span></div>
      <GuidedSteps steps={steps} open={stepOpen} onOpen={setStepOpen} />
    </div>
  );
}
