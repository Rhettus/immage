// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Lightroom's Print module as a right-hand panel: soft proofing, then the
// printer, its paper and the photo's place on the page (or, in the Cells
// layout, the grid of cells the selected photos fill), the printer
// profile, and Print (or Save PDF). the settings are kept between photos
// and runs (print.ts); the page they lay out is shown in the viewer (App.tsx)
import { useState } from "react";
import { t } from "./i18n";
import { cellsLayout, fromUnit, layout, PDF, PDF_DPI, PDF_PAPERS, shown, sourcePpi, toUnit, type Margins,
         type Paper, type PrintLayout, type PrintSettings, type Printer, type PrinterInfo, type Profile, type Proof, type Unit } from "./print";

const ADD_PROFILE = "\u0000add";

export function PrintPanel({ settings: s, onSettings, available, printers, info, infoError, profiles, onAddProfile,
                             aspect, pixelWidth, photos, proof, onProof, busy, note, onPrint, disabled }: {
  settings: PrintSettings; onSettings: (s: PrintSettings) => void;
  available: boolean | null; printers: Printer[] | null;
  info: PrinterInfo | null; infoError: string | null;
  profiles: Profile[]; onAddProfile: () => void;
  aspect: number; pixelWidth: number;
  photos: number;  // the photos the Cells layout prints: those selected, else the open one
  proof: Proof; onProof: (mode: Proof["mode"]) => void;
  busy: boolean; note: { text: string; error: boolean } | null;
  onPrint: () => void; disabled: boolean;
}) {
  const set = (patch: Partial<PrintSettings>) => onSettings({ ...s, ...patch });
  const pdf = s.printer === PDF;
  const papers: Paper[] = pdf ? PDF_PAPERS : info?.papers ?? [];
  const paper = papers.find((p) => p.name === s.paper) ?? papers[0] ?? null;
  const l = paper && s.layout === "single" ? layout(paper, s, aspect, pdf ? undefined : info?.margins) : null;
  const dpi = pdf ? s.dpi : info?.resolution ?? 300;
  const ppi = l ? sourcePpi(pixelWidth, l.image.width) : 0;
  const unit = s.unit;
  const profileName = profiles.find((p) => p.file === s.profile)?.name;
  const managed = !!s.profile && !!profileName;
  const cells = s.layout === "cells";
  const cl = paper && cells ? cellsLayout(paper, s, photos, pdf ? undefined : info?.margins) : null;
  const noPhoto = cells ? photos === 0 : disabled;
  const ready = !noPhoto && available === true && !!paper && !!(cells ? cl?.fits : l?.fits) && !busy && (pdf || !!info);

  if (available === false) return (
    <div className="panel print">
      <section>
        <p className="note-plain">{t("dialogs.print.unavailable")}</p>
      </section>
    </div>
  );

  return (
    <div className="panel print">
      <section>
        <h3>{t("dialogs.print.softProofing")}</h3>
        <label className={`toggle${disabled || !managed ? " disabled" : ""}`}
               title={managed ? t("dialogs.print.softProofHint")
                              : t("dialogs.print.chooseProofProfileHint")}>
          <span>{t("dialogs.print.softProof")}</span>
          <input type="checkbox" className="switch" data-action="print-softproof" checked={proof.mode !== "off"}
                 disabled={disabled || !managed} onChange={(e) => onProof(e.target.checked ? "proof" : "off")} />
        </label>
        <label className={`toggle${disabled || proof.mode === "off" ? " disabled" : ""}`}
               title={t("dialogs.print.gamutWarningHint")}>
          <span>{t("dialogs.print.gamutWarning")}</span>
          <input type="checkbox" className="switch" data-action="print-gamut" checked={proof.mode === "gamut"}
                 disabled={disabled || proof.mode === "off"}
                 onChange={(e) => onProof(e.target.checked ? "gamut" : "proof")} />
        </label>
        {proof.mode !== "off" && profileName && (
          <p className="note-plain">{t("dialogs.print.proofingFor", {
            profile: profileName, intent: s.intent ? t("dialogs.print.relativeColorimetric") : t("dialogs.print.perceptual"),
          })} {t("dialogs.print.proofingPersists")}</p>
        )}
      </section>

      <section>
        <h3>{t("dialogs.print.printer")}</h3>
        <div className="choice-row">
          <span>{t("dialogs.print.printer")}</span>
          <select className="field" data-action="print-printer" value={s.printer} disabled={busy}
                  onChange={(e) => set({ printer: e.target.value })}>
            {(printers ?? []).map((p) => <option key={p.name} value={p.name}>{p.description}</option>)}
            <option value={PDF}>{t("dialogs.print.saveAsPdf")}</option>
          </select>
        </div>
        {printers === null && <p className="note-plain">{t("dialogs.print.lookingForPrinters")}</p>}
        {printers && !printers.length && <p className="note-plain">{t("dialogs.print.noPrinters")}</p>}
        {!pdf && infoError && <p className="note-plain warn">{infoError}</p>}
        {!pdf && !info && !infoError && <p className="note-plain">{t("dialogs.print.askingPrinter")}</p>}
        <div className="choice-row">
          <span>{t("dialogs.print.paper")}</span>
          <select className="field" data-action="print-paper" value={paper?.name ?? ""} disabled={busy || !papers.length}
                  onChange={(e) => set({ paper: e.target.value })}>
            {papers.map((p) => (
              <option key={p.name} value={p.name}>{p.label} ({shown(p.width, s.unit)} × {shown(p.height, s.unit)})</option>
            ))}
          </select>
        </div>
        {!pdf && info && info.media.length > 0 && (
          <div className="choice-row">
            <span>{t("dialogs.print.mediaType")}</span>
            <select className="field" value={info.media.some((m) => m.name === s.medium) ? s.medium : ""}
                    disabled={busy} onChange={(e) => set({ medium: e.target.value })}>
              <option value="">{t("dialogs.print.printerDefault")}</option>
              {info.media.map((m) => <option key={m.name} value={m.name}>{m.label}</option>)}
            </select>
          </div>
        )}
        {pdf && (
          <div className="choice-row">
            <span>{t("dialogs.print.resolution")}</span>
            <select className="field" value={s.dpi} disabled={busy} onChange={(e) => set({ dpi: Number(e.target.value) })}>
              {PDF_DPI.map((d) => <option key={d} value={d}>{d} dpi</option>)}
            </select>
          </div>
        )}
        <div className="choice-row">
          <span>{t("dialogs.print.orientation")}</span>
          <div className="segmented small">
            {(["auto", "portrait", "landscape"] as const).map((o) => (
              <button key={o} className={s.orientation === o ? "active" : ""} disabled={busy}
                      onClick={() => set({ orientation: o })}>{t(`dialogs.print.orientation.${o}`)}</button>
            ))}
          </div>
        </div>
      </section>

      <section>
        <h3>{t("dialogs.print.layout")}</h3>
        <div className="segmented print-layout">
          {([["single", t("dialogs.print.singlePhoto")], ["cells", t("dialogs.print.cells")]] as [PrintLayout, string][]).map(([k, label]) => (
            <button key={k} className={s.layout === k ? "active" : ""} data-action={`print-layout-${k}`} disabled={busy}
                    onClick={() => set({ layout: k })}>{label}</button>
          ))}
        </div>
        {l && (
          <p className="note-plain print-size">
            {l.fits ? <>{t("dialogs.print.printsAt", { width: shown(l.image.width, s.unit), height: shown(l.image.height, s.unit), dpi })}{ppi > 0 && " " + t("dialogs.print.pixelsPerInchFromPhoto", { ppi: Math.round(ppi) })}.</>
              : t("dialogs.print.noPhotoRoom")}
            {l.fits && ppi > 0 && ppi < 180 && " " + t("dialogs.print.enlargedSoft")}
            {l.borderless && " " + t("dialogs.print.borderlessHint")}
            {l.fits && " " + t("dialogs.print.placePhotoHint")}
          </p>
        )}
        {cells && (
          <p className="note-plain print-size" data-print-cells>
            {!cl?.fits ? t("dialogs.print.noPhotosRoom")
              : photos === 0 ? t("dialogs.print.selectPhotos")
              : <>{t(photos === 1 ? "dialogs.print.cellsSummary.onePhoto" : "dialogs.print.cellsSummary.manyPhotos", { photos })} {t(cl.pages === 1 ? "dialogs.print.cellsSummary.onePage" : "dialogs.print.cellsSummary.manyPages", { pages: cl.pages })}: {t("dialogs.print.cellsGrid", { columns: cl.columns, rows: cl.rows, width: shown(cl.cell.width, s.unit), height: shown(cl.cell.height, s.unit) })}.</>}
            {cl?.fits && cl.borderless && " " + t("dialogs.print.borderlessHint")}
          </p>
        )}
        <div className="choice-row">
          <span>{t("dialogs.print.units")}</span>
          <div className="segmented small">
            {(["mm", "in"] as Unit[]).map((u) => (
              <button key={u} className={s.unit === u ? "active" : ""} onClick={() => set({ unit: u })}>{u}</button>
            ))}
          </div>
        </div>
        <div className="print-margins">
          {(["top", "bottom", "left", "right"] as (keyof Margins)[]).map((side) => (
            <label key={side}>
              <span>{t(`dialogs.print.margin.${side}`)}</span>
              <Length mm={s.margins[side]} unit={s.unit} disabled={busy} data-margin={side}
                      onChange={(mm) => set({ margins: { ...s.margins, [side]: mm } })} />
            </label>
          ))}
        </div>
        {!cells && (
          <>
            <div className="choice-row">
              <span>{t("dialogs.print.photoSize")}</span>
              <div className="segmented small">
                <button className={s.size === null ? "active" : ""} disabled={busy} onClick={() => set({ size: null })}>{t("dialogs.print.fill")}</button>
                <button className={s.size !== null ? "active" : ""} disabled={busy || !l}
                        onClick={() => l && set({ size: Math.round(Math.max(l.image.width, l.image.height)) })}>{t("dialogs.print.custom")}</button>
              </div>
            </div>
            {s.size !== null && (
              <div className="choice-row">
                <span>{t("dialogs.print.longEdge")}</span>
                <Length mm={s.size} unit={s.unit} disabled={busy} data-margin="size"
                        onChange={(mm) => set({ size: Math.max(10, mm) })} />
              </div>
            )}
          </>
        )}
        {cells && (
          <>
            <div className="choice-row">
              <span>{t("dialogs.print.cellsPerPage")}</span>
              <div className="segmented small">
                <button className={s.cellCount === 0 ? "active" : ""} disabled={busy} data-action="print-cells-auto"
                        onClick={() => set({ cellCount: 0 })}>{t("dialogs.print.auto")}</button>
                <button className={s.cellCount > 0 ? "active" : ""} disabled={busy} data-action="print-cells-custom"
                        onClick={() => set({ cellCount: cl?.perPage ?? 2 })}>{t("dialogs.print.custom")}</button>
              </div>
            </div>
            {s.cellCount > 0 && (
              <div className="choice-row print-sub">
                <span>{t("dialogs.print.cells")}</span>
                <Count value={s.cellCount} min={1} max={200} disabled={busy} data-cells="count"
                       onChange={(n) => set({ cellCount: n })} />
              </div>
            )}
            <div className="choice-row">
              <span>{t("dialogs.print.columns")}</span>
              <div className="segmented small">
                <button className={s.columns === 0 ? "active" : ""} disabled={busy}
                        onClick={() => set({ columns: 0 })}>{t("dialogs.print.auto")}</button>
                <button className={s.columns > 0 ? "active" : ""} disabled={busy}
                        onClick={() => set({ columns: cl?.columns ?? 2 })}>{t("dialogs.print.custom")}</button>
              </div>
            </div>
            {s.columns > 0 && (
              <div className="choice-row print-sub">
                <span>{t("dialogs.print.columns")}</span>
                <Count value={s.columns} min={1} max={50} disabled={busy} data-cells="columns"
                       onChange={(n) => set({ columns: n })} />
              </div>
            )}
            <div className="choice-row">
              <span>{t("dialogs.print.cellSize")}</span>
              <div className="segmented small">
                <button className={s.cellSize === null ? "active" : ""} disabled={busy} data-action="print-size-auto"
                        onClick={() => set({ cellSize: null })}>{t("dialogs.print.auto")}</button>
                <button className={s.cellSize !== null ? "active" : ""} disabled={busy || !cl?.fits}
                        data-action="print-size-custom"
                        onClick={() => cl && set({ cellSize: { width: Math.round(cl.cell.width), height: Math.round(cl.cell.height) } })}>{t("dialogs.print.custom")}</button>
              </div>
            </div>
            {s.cellSize !== null ? (
              <>
                <div className="choice-row print-sub">
                  <span>{t("dialogs.print.width")}</span>
                  <Length mm={s.cellSize.width} unit={unit} disabled={busy} data-margin="cell-width"
                          onChange={(mm) => set({ cellSize: { width: Math.max(5, mm), height: s.cellSize!.height } })} />
                </div>
                <div className="choice-row print-sub">
                  <span>{t("dialogs.print.height")}</span>
                  <Length mm={s.cellSize.height} unit={unit} disabled={busy} data-margin="cell-height"
                          onChange={(mm) => set({ cellSize: { width: s.cellSize!.width, height: Math.max(5, mm) } })} />
                </div>
                <p className="note-plain">{t("dialogs.print.spaceShared")}</p>
              </>
            ) : (
              <div className="choice-row">
                <span>{t("dialogs.print.spacing")}</span>
                <Length mm={s.gap} unit={unit} disabled={busy} data-margin="gap"
                        onChange={(mm) => set({ gap: mm })} />
              </div>
            )}
            <label className="toggle" title={t("dialogs.print.filenamesHint")}>
              <span>{t("dialogs.print.filenamesUnderPhotos")}</span>
              <input type="checkbox" className="switch" data-action="print-names" checked={s.names} disabled={busy}
                     onChange={(e) => set({ names: e.target.checked })} />
            </label>
          </>
        )}
      </section>

      <section>
        <h3>{t("dialogs.print.colorManagement")}</h3>
        <div className="choice-row">
          <span>{t("dialogs.print.profile")}</span>
          <select className="field" data-action="print-profile" value={managed ? s.profile : ""} disabled={busy}
                  onChange={(e) => (e.target.value === ADD_PROFILE ? onAddProfile() : set({ profile: e.target.value }))}>
            <option value="">{t("dialogs.print.managedByPrinter")}</option>
            {profiles.map((p) => <option key={p.file} value={p.file} title={p.file}>{p.name}</option>)}
            <option value={ADD_PROFILE}>{t("dialogs.print.addProfile")}</option>
          </select>
        </div>
        {managed ? (
          <>
            <div className="choice-row">
              <span>{t("dialogs.print.intent")}</span>
              <div className="segmented small">
                <button className={s.intent === 0 ? "active" : ""} disabled={busy} onClick={() => set({ intent: 0 })}>{t("dialogs.print.perceptual")}</button>
                <button className={s.intent === 1 ? "active" : ""} disabled={busy} onClick={() => set({ intent: 1 })}>{t("dialogs.print.relative")}</button>
              </div>
            </div>
            <label className="toggle" title={t("dialogs.print.blackPointHint")}>
              <span>{t("dialogs.print.blackPointCompensation")}</span>
              <input type="checkbox" className="switch" checked={s.bpc} disabled={busy}
                     onChange={(e) => set({ bpc: e.target.checked })} />
            </label>
            {!pdf && <p className="note-plain">{t("dialogs.print.immageConvertsColors")}</p>}
          </>
        ) : (
          <p className="note-plain">{t("dialogs.print.driverConvertsColors")}</p>
        )}
      </section>

      <section>
        <button className="btn primary print-go" data-action="print-go" disabled={!ready} onClick={onPrint}>
          {busy ? (pdf ? t("dialogs.common.saving") : t("dialogs.print.printing")) : pdf ? t("dialogs.print.savePdf") : t("dialogs.print.print")}
        </button>
        {note && <p className={`note-plain${note.error ? " warn" : ""}`} data-print-note>{note.text}</p>}
      </section>
    </div>
  );
}

// a whole number, kept as typed while it is being typed, like Length
function Count({ value, min, max, disabled, onChange, ...rest }: {
  value: number; min: number; max: number; disabled: boolean; onChange: (n: number) => void; "data-cells"?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <span className="print-length">
      <input className="field" type="text" inputMode="numeric" value={draft ?? String(value)} disabled={disabled}
             {...rest} onFocus={() => setDraft(String(value))} onBlur={() => setDraft(null)}
             onChange={(e) => {
               setDraft(e.target.value);
               const v = parseInt(e.target.value, 10);
               if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
             }} />
    </span>
  );
}

// a length in the panel's unit, kept as typed while it is being typed ("0."
// on the way to "0.5"), and shown from the setting otherwise
function Length({ mm, unit, disabled, onChange, ...rest }: {
  mm: number; unit: Unit; disabled: boolean; onChange: (mm: number) => void; "data-margin"?: string;
}) {
  const value = String(Number(toUnit(mm, unit).toFixed(unit === "in" ? 2 : 1)));
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <span className="print-length">
      <input className="field" type="text" inputMode="decimal" value={draft ?? value} disabled={disabled}
             {...rest} onFocus={() => setDraft(value)} onBlur={() => setDraft(null)}
             onChange={(e) => {
               setDraft(e.target.value);
               const v = parseFloat(e.target.value.replace(",", "."));
               if (Number.isFinite(v) && v >= 0) onChange(fromUnit(v, unit));
             }} />
      <span>{unit}</span>
    </span>
  );
}
