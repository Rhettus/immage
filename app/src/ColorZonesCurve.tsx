// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// darktable's color zones (colorzones) curves: a page each for lightness,
// chroma and hue, drawn over the "select by" axis, with a color band under it
// and the interpolation of the shown page
import { useState } from "react";
import { PointCurve } from "./PointCurve";
import { CZ_HUE, CZ_MIN_X, CZ_PAGES, CZ_V1, czBandGradient, czCurveFn, czDefaultPoints, czMinNodes, type CzPage } from "./colorzones";
import { czPointValues, czPointsOf, type Values } from "./manifest";
import { INTERPOLATIONS } from "./advancedLayout";
import { fieldText } from "./fieldText";
import { t } from "./i18n";
import type { Point } from "./tonecurve";

export function ColorZonesCurve({ values, disabled, onChange }: {
  values: Values; disabled: boolean; onChange: (entries: [string, number][]) => void;
}) {
  const [page, setPage] = useState<CzPage>(2);
  const version = values.cz_version ?? 1;
  const selectBy = values.cz_channel ?? CZ_HUE;
  const periodic = selectBy === CZ_HUE;
  const points = czPointsOf(values, page);
  const type = values[`cz${page}t`] ?? 1;
  const v1 = version === CZ_V1;
  const put = (pts: Point[], withType?: number) => onChange(Object.entries(czPointValues(pts, page, withType)));
  // V1 keeps the ends mirrored on the hue axis, as colorzones.c moves them together
  const edit = (pts: Point[]) => {
    if (v1 && periodic && pts.length === points.length && pts.length > 1) {
      const last = pts.length - 1;
      if (pts[0][0] !== points[0][0] || pts[0][1] !== points[0][1]) pts[last] = [1 - pts[0][0], pts[0][1]];
      else if (pts[last][0] !== points[last][0] || pts[last][1] !== points[last][1]) pts[0] = [1 - pts[last][0], pts[last][1]];
    }
    put(pts);
  };
  const name = fieldText(CZ_PAGES[page]);
  return <div className="contrast-equalizer color-zones">
    <div className="segmented small module-card-tabs" role="tablist" aria-label={t("fields.colorZones.pages")}>
      {CZ_PAGES.map((label, i) => (
        <button key={label} role="tab" aria-selected={i === page} className={i === page ? "active" : ""}
                onClick={() => setPage(i as CzPage)}>{fieldText(label)}</button>
      ))}
    </div>
    <PointCurve key={`${page}-${selectBy}-${version}`} points={points} disabled={disabled} histogram={null} guide="flat"
                edit={v1 ? "free" : periodic ? "periodic" : "free"} minNodes={czMinNodes(version)} keepEnds={v1} gap={CZ_MIN_X}
                draw={(pts) => czCurveFn(type, pts, version, periodic)}
                label={t("fields.colorZones.graph", { page: name })} onChange={edit} />
    <div className={`color-zones-band${periodic ? " hue" : ""}`} aria-hidden="true"
         style={{ backgroundImage: czBandGradient(selectBy) }} />
    <div className="choice-row">
      <span>{t("fields.moduleCurve.interpolation")}</span>
      <select className="field" value={type} disabled={disabled}
              onChange={(e) => put(points, Number(e.target.value))}>
        {INTERPOLATIONS.map(([label, v]) => <option key={v} value={v}>{fieldText(label)}</option>)}
      </select>
    </div>
    <div className="equalizer-heading"><span className="equalizer-hint">{t("fields.colorZones.hint")}{" "}{t("fields.curve.pointHint")}</span>
      <button disabled={disabled} onClick={() => put(czDefaultPoints(version, periodic), 1)}>{t("fields.colorZones.resetPage", { page: name })}</button></div>
  </div>;
}
