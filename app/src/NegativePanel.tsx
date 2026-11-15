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
import { t } from "./i18n";
import { fieldText } from "./fieldText";

export type NegPick = "border" | "area" | "dmax" | "offset" | "black" | "exposure" | "shadows" | "highlights";

const PICK_HINTS: Record<NegPick, string> = {
  border: t("fields.negative.pick.border"), area: t("fields.negative.pick.area"),
  dmax: t("fields.negative.pick.dmax"), offset: t("fields.negative.pick.offset"),
  black: t("fields.negative.pick.black"), exposure: t("fields.negative.pick.exposure"),
  shadows: t("fields.negative.pick.shadows"), highlights: t("fields.negative.pick.highlights"),
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
    const options = (profiles?.[role] ?? []).map(([name, id]) => [fieldText(name), id] as [string, number]);
    const value = values[`neg_${role}_profile`];
    return value !== undefined && !options.some(([, id]) => id === value)
      ? [...options, [t("fields.negative.currentProfile"), value] as [string, number]] : options;
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
  const lockNote = t("fields.negative.pickBorderFirst");
  const signed = (v: number, d: number) => `${v > 0 ? "+" : ""}${v.toFixed(d)}`;
  const steps: Step[] = [
    { id: "profiles", title: t("fields.negative.profiles"),
      summary: `${profileOptions("input").find(([, v]) => v === values.neg_input_profile)?.[0] ?? t("fields.negative.input")} → `
        + `${profileOptions("working").find(([, v]) => v === values.neg_working_profile)?.[0] ?? t("fields.negative.working")}`,
      content: (
        <>
          {renderControl("neg_input_profile", profileOptions("input"))}
          {renderControl("neg_working_profile", profileOptions("working"))}
          <div className="note-plain">{profileError ? t("fields.negative.profilesUnavailable", { error: profileError })
            : t("fields.negative.profilesHint")}</div>
        </>
      ) },
    { id: "border", title: t("fields.negative.borderArea"),
      summary: `${color ? t("fields.negative.color") : t("fields.negative.bw")} · ${t("fields.negative.border")} ${converted ? t("fields.negative.picked") : t("fields.negative.notPicked")} · ${t("fields.negative.area")} ${hasArea ? t("fields.negative.set") : t("fields.negative.notSet")}`,
      content: (
        <>
          {renderControl("neg_film")}
          <div className="neg-step">
            {pickButton("border", t("fields.negative.pickFilmBorder"),
                        converted ? t("fields.negative.pickBorderAgain") : t("fields.negative.pickBorderConvert"))}
            {converted && <span className="neg-swatch" style={{ background: swatch }} title={t("fields.negative.borderColor")} />}
          </div>
          <div className="neg-step">
            {pickButton("area", t("fields.negative.pickPhotoArea"), t("fields.negative.pickAreaHint"))}
            {hasArea && <span className="note-plain">{t("fields.negative.set")}</span>}
          </div>
          <div className="note-plain">
            {picking ? PICK_HINTS[picking]
              : note ?? (converted ? t("fields.negative.pickingFrame") : t("fields.negative.startBorder"))}
          </div>
        </>
      ) },
    { id: "base", title: t("fields.negative.filmBase"), locked, lockNote,
      summary: `${t("fields.negative.whitePoint")} ${(values.neg_dmax ?? 0).toFixed(2)} · ${t("fields.negative.blackPoint")} ${signed(values.neg_offset ?? 0, 2)}`,
      content: (
        <>
          {withPick("neg_dmax", "dmax", t("fields.negative.pickBrightScene"))}
          {withPick("neg_offset", "offset", t("fields.negative.pickBorderOrWhole"))}
        </>
      ) },
    { id: "color", title: t("fields.negative.color"), hidden: !color, locked, lockNote, summary: t("fields.negative.neutralShadowsHighlights"),
      content: (
        <>
          <div className="neg-step">
            {pickButton("shadows", t("fields.negative.neutralShadows"), t("fields.negative.pickNeutralShadow"))}
            {pickButton("highlights", t("fields.negative.neutralHighlights"), t("fields.negative.pickNeutralHighlight"))}
          </div>
          <div className="neg-step">
            <button className="btn small" disabled={off} onClick={onResetColor}>{t("fields.negative.resetColor")}</button>
          </div>
        </>
      ) },
    { id: "tone", title: t("fields.negative.tone"), locked, lockNote,
      summary: `${t("fields.negative.exposure")} ${signed(values.neg_exposure ?? 0, 2)} · ${t("fields.negative.contrast")} ${(values.neg_grade ?? 0).toFixed(1)}`,
      content: (
        <>
          {withPick("neg_exposure", "exposure", t("fields.negative.pickBrightPhoto"))}
          {renderControl("neg_grade")}
          {withPick("neg_black", "black", "pick what should be pure black")}
          {renderControl("neg_gloss")}
        </>
      ) },
    { id: "finecolor", title: t("fields.negative.fineColor"), hidden: !converted, locked, lockNote,
      summary: `${t("fields.negative.borderColor")}, ${t("fields.negative.shadowTint")}, ${t("fields.negative.whiteBalance")}${fineColorChanged ? ` · ${t("fields.negative.changed")}` : ""}`,
      content: (
        <div className="section-body">
          <div className="neg-sub">{t("fields.negative.borderColor")}</div>
          {(color ? ["r", "g", "b"] : ["r"]).map((c) => renderControl(`neg_dmin_${c}`))}
          {color && <div className="neg-sub">{t("fields.negative.shadowTint")}</div>}
          {color && ["r", "g", "b"].map((c) => renderControl(`neg_wbl_${c}`))}
          <div className="neg-sub">{t("fields.negative.whiteBalance")}</div>
          {["r", "g", "b"].map((c) => renderControl(`neg_wbh_${c}`))}
        </div>
      ) },
    { id: "export", title: t("fields.negative.exportPositive"), locked, lockNote, summary: t("fields.negative.exportSummary"), content: footer },
  ];
  return (
    <div className="panel negative">
      <div className="panel-title"><span>{t("fields.negative.title")}</span></div>
      <GuidedSteps steps={steps} open={stepOpen} onOpen={setStepOpen} />
    </div>
  );
}
