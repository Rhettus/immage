// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Lightroom's Print module as a right-hand panel: soft proofing, then the
// printer, its paper and the photo's place on the page, the printer
// profile, and Print (or Save PDF). the settings are kept between photos
// and runs (print.ts); the page preview follows them
import { useState } from "react";
import { fromUnit, layout, PDF, PDF_DPI, PDF_PAPERS, shown, sourcePpi, toUnit, type Layout, type Margins, type Paper,
         type PrintSettings, type Printer, type PrinterInfo, type Profile, type Proof, type Unit } from "./print";

const ADD_PROFILE = "\u0000add";

export function PrintPanel({ settings: s, onSettings, available, printers, info, infoError, profiles, onAddProfile,
                             aspect, pixelWidth, thumb, proof, onProof, busy, note, onPrint, disabled }: {
  settings: PrintSettings; onSettings: (s: PrintSettings) => void;
  available: boolean | null; printers: Printer[] | null;
  info: PrinterInfo | null; infoError: string | null;
  profiles: Profile[]; onAddProfile: () => void;
  aspect: number; pixelWidth: number; thumb: string | null;
  proof: Proof; onProof: (mode: Proof["mode"]) => void;
  busy: boolean; note: { text: string; error: boolean } | null;
  onPrint: () => void; disabled: boolean;
}) {
  const set = (patch: Partial<PrintSettings>) => onSettings({ ...s, ...patch });
  const pdf = s.printer === PDF;
  const papers: Paper[] = pdf ? PDF_PAPERS : info?.papers ?? [];
  const paper = papers.find((p) => p.name === s.paper) ?? papers[0] ?? null;
  const l = paper ? layout(paper, s, aspect, pdf ? undefined : info?.margins) : null;
  const dpi = pdf ? s.dpi : info?.resolution ?? 300;
  const ppi = l ? sourcePpi(pixelWidth, l.image.width) : 0;
  const profileName = profiles.find((p) => p.file === s.profile)?.name;
  const managed = !!s.profile && !!profileName;
  const ready = !disabled && available === true && !!paper && !!l?.fits && !busy && (pdf || !!info);

  if (available === false) return (
    <div className="panel print">
      <section>
        <p className="note-plain">This copy of Immage was built without printing.</p>
      </section>
    </div>
  );

  return (
    <div className="panel print">
      <section>
        <h3>Soft Proofing</h3>
        <label className={`toggle${disabled || !managed ? " disabled" : ""}`}
               title={managed ? "show the photo as the printer profile can print it (S)"
                              : "choose a printer profile under Color Management to proof against"}>
          <span>Soft Proof</span>
          <input type="checkbox" className="switch" data-action="print-softproof" checked={proof.mode !== "off"}
                 disabled={disabled || !managed} onChange={(e) => onProof(e.target.checked ? "proof" : "off")} />
        </label>
        <label className={`toggle${disabled || proof.mode === "off" ? " disabled" : ""}`}
               title="paint the colors the printer can't reach cyan">
          <span>Gamut Warning</span>
          <input type="checkbox" className="switch" data-action="print-gamut" checked={proof.mode === "gamut"}
                 disabled={disabled || proof.mode === "off"}
                 onChange={(e) => onProof(e.target.checked ? "gamut" : "proof")} />
        </label>
        {proof.mode !== "off" && profileName && (
          <p className="note-plain">Proofing for {profileName}, {s.intent ? "relative colorimetric" : "perceptual"}.
            The proof stays on in the other panels until you turn it off.</p>
        )}
      </section>

      <section>
        <h3>Printer</h3>
        <div className="choice-row">
          <span>Printer</span>
          <select className="field" data-action="print-printer" value={s.printer} disabled={busy}
                  onChange={(e) => set({ printer: e.target.value })}>
            {(printers ?? []).map((p) => <option key={p.name} value={p.name}>{p.description}</option>)}
            <option value={PDF}>Save as PDF</option>
          </select>
        </div>
        {printers === null && <p className="note-plain">Looking for printers…</p>}
        {printers && !printers.length && <p className="note-plain">No printers found; you can save a PDF.</p>}
        {!pdf && infoError && <p className="note-plain warn">{infoError}</p>}
        {!pdf && !info && !infoError && <p className="note-plain">Asking the printer…</p>}
        <div className="choice-row">
          <span>Paper</span>
          <select className="field" data-action="print-paper" value={paper?.name ?? ""} disabled={busy || !papers.length}
                  onChange={(e) => set({ paper: e.target.value })}>
            {papers.map((p) => (
              <option key={p.name} value={p.name}>{p.label} ({shown(p.width, s.unit)} × {shown(p.height, s.unit)})</option>
            ))}
          </select>
        </div>
        {!pdf && info && info.media.length > 0 && (
          <div className="choice-row">
            <span>Media Type</span>
            <select className="field" value={info.media.some((m) => m.name === s.medium) ? s.medium : ""}
                    disabled={busy} onChange={(e) => set({ medium: e.target.value })}>
              <option value="">Printer default</option>
              {info.media.map((m) => <option key={m.name} value={m.name}>{m.label}</option>)}
            </select>
          </div>
        )}
        {pdf && (
          <div className="choice-row">
            <span>Resolution</span>
            <select className="field" value={s.dpi} disabled={busy} onChange={(e) => set({ dpi: Number(e.target.value) })}>
              {PDF_DPI.map((d) => <option key={d} value={d}>{d} dpi</option>)}
            </select>
          </div>
        )}
        <div className="choice-row">
          <span>Orientation</span>
          <div className="segmented small">
            {(["auto", "portrait", "landscape"] as const).map((o) => (
              <button key={o} className={s.orientation === o ? "active" : ""} disabled={busy}
                      onClick={() => set({ orientation: o })}>{o[0].toUpperCase() + o.slice(1)}</button>
            ))}
          </div>
        </div>
      </section>

      <section>
        <h3>Layout</h3>
        {l && <PagePreview l={l} thumb={thumb} onAlign={(alignment) => set({ alignment })} alignment={s.alignment} />}
        {l && (
          <p className="note-plain print-size">
            {l.fits ? <>Prints {shown(l.image.width, s.unit)} × {shown(l.image.height, s.unit)} at {dpi} dpi
              {ppi > 0 && <>, {Math.round(ppi)} pixels per inch from the photo</>}.</>
              : "The margins leave no room for the photo."}
            {l.fits && ppi > 0 && ppi < 180 && " The photo is enlarged to fill it; it may print soft."}
            {l.borderless && " A margin is inside what the printer can reach: it prints borderless if it can."}
          </p>
        )}
        <div className="choice-row">
          <span>Units</span>
          <div className="segmented small">
            {(["mm", "in"] as Unit[]).map((u) => (
              <button key={u} className={s.unit === u ? "active" : ""} onClick={() => set({ unit: u })}>{u}</button>
            ))}
          </div>
        </div>
        <div className="print-margins">
          {(["top", "bottom", "left", "right"] as (keyof Margins)[]).map((side) => (
            <label key={side}>
              <span>{side[0].toUpperCase() + side.slice(1)}</span>
              <Length mm={s.margins[side]} unit={s.unit} disabled={busy} data-margin={side}
                      onChange={(mm) => set({ margins: { ...s.margins, [side]: mm } })} />
            </label>
          ))}
        </div>
        <div className="choice-row">
          <span>Photo Size</span>
          <div className="segmented small">
            <button className={s.size === null ? "active" : ""} disabled={busy} onClick={() => set({ size: null })}>Fill</button>
            <button className={s.size !== null ? "active" : ""} disabled={busy || !l}
                    onClick={() => l && set({ size: Math.round(Math.max(l.image.width, l.image.height)) })}>Custom</button>
          </div>
        </div>
        {s.size !== null && (
          <div className="choice-row">
            <span>Long Edge</span>
            <Length mm={s.size} unit={s.unit} disabled={busy} data-margin="size"
                    onChange={(mm) => set({ size: Math.max(10, mm) })} />
          </div>
        )}
      </section>

      <section>
        <h3>Color Management</h3>
        <div className="choice-row">
          <span>Profile</span>
          <select className="field" data-action="print-profile" value={managed ? s.profile : ""} disabled={busy}
                  onChange={(e) => (e.target.value === ADD_PROFILE ? onAddProfile() : set({ profile: e.target.value }))}>
            <option value="">Managed by printer</option>
            {profiles.map((p) => <option key={p.file} value={p.file} title={p.file}>{p.name}</option>)}
            <option value={ADD_PROFILE}>Add Profile…</option>
          </select>
        </div>
        {managed ? (
          <>
            <div className="choice-row">
              <span>Intent</span>
              <div className="segmented small">
                <button className={s.intent === 0 ? "active" : ""} disabled={busy} onClick={() => set({ intent: 0 })}>Perceptual</button>
                <button className={s.intent === 1 ? "active" : ""} disabled={busy} onClick={() => set({ intent: 1 })}>Relative</button>
              </div>
            </div>
            <label className="toggle" title="map the photo's black to the darkest black the paper prints">
              <span>Black Point Compensation</span>
              <input type="checkbox" className="switch" checked={s.bpc} disabled={busy}
                     onChange={(e) => set({ bpc: e.target.checked })} />
            </label>
            {!pdf && <p className="note-plain">Immage converts the colors for this profile. Turn color management off
              in the printer's own settings, and choose the paper the profile was made for.</p>}
          </>
        ) : (
          <p className="note-plain">The printer's driver converts the colors, from sRGB.</p>
        )}
      </section>

      <section>
        <button className="btn primary print-go" data-action="print-go" disabled={!ready} onClick={onPrint}>
          {busy ? (pdf ? "Saving…" : "Printing…") : pdf ? "Save PDF…" : "Print"}
        </button>
        {note && <p className={`note-plain${note.error ? " warn" : ""}`} data-print-note>{note.text}</p>}
      </section>
    </div>
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

// the page to scale: the margins dashed, the photo in its place, and the
// nine places it can go, clickable
function PagePreview({ l, thumb, alignment, onAlign }: {
  l: Layout; thumb: string | null; alignment: number; onAlign: (a: number) => void;
}) {
  const { width: W, height: H } = l.page;
  const a = l.area, im = l.image;
  return (
    <div className="print-page" style={{ aspectRatio: `${W} / ${H}` }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
        <rect className="sheet" x={0} y={0} width={W} height={H} />
        {l.fits && <rect className="area" x={a.x} y={a.y} width={a.width} height={a.height} />}
        {l.fits && (thumb
          ? <image href={thumb} x={im.x} y={im.y} width={im.width} height={im.height} preserveAspectRatio="none" />
          : <rect className="photo" x={im.x} y={im.y} width={im.width} height={im.height} />)}
      </svg>
      {l.fits && (
        <div className="print-align" style={{ left: `${a.x / W * 100}%`, top: `${a.y / H * 100}%`,
                                              width: `${a.width / W * 100}%`, height: `${a.height / H * 100}%` }}>
          {Array.from({ length: 9 }, (_, k) => (
            <button key={k} className={k === alignment ? "on" : ""} aria-label={`place the photo ${PLACES[k]}`}
                    title={`place the photo ${PLACES[k]}`} onClick={() => onAlign(k)} />
          ))}
        </div>
      )}
    </div>
  );
}

const PLACES = ["top left", "at the top", "top right", "on the left", "in the middle", "on the right",
                "bottom left", "at the bottom", "bottom right"];
