// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the Film Simulation panel: darktable's spektrafilm, a spectral model of a
// film exposed, developed and printed, or scanned. its data pack comes
// first, downloaded on first use; then turning it on, a preset, the film
// and paper, the controls most photos need, and the rest of darktable's
// tabs folded under Advanced (spektrafilm.ts)
import { useState } from "react";
import type { Control } from "./manifest";
import { Chevron, Collapse } from "./Collapse";
import { autoPaper, filmOf, PAPER_AUTO, PAPER_SCAN, paperOf, presetLabel, SF_PRESETS, type FetchStatus,
         type Stock, type Stocks } from "./spektrafilm";

// darktable's tabs, as the folds under Advanced
const ADVANCED: { title: string; ids: string[]; print?: boolean }[] = [
  { title: "Development", ids: ["development_min", "film_gamma_factor", "film_gamma_factor_fast",
                                "film_gamma_factor_slow", "film_developer_exhaustion"] },
  { title: "DIR Couplers", ids: ["couplers_amount", "couplers_inhibition_same", "couplers_inhibition_inter",
                                 "couplers_diffusion_um", "couplers_tail_um", "couplers_tail_weight"] },
  { title: "Lens Diffusion", ids: ["diffusion_on", "diffusion_filter_family", "diffusion_strength", "diffusion_scale",
                                   "diffusion_warmth"] },
  { title: "Print", print: true, ids: ["print_development_min", "print_gamma_r", "print_gamma_g", "print_gamma_b",
                                       "preflash_exposure", "preflash_m_shift", "preflash_y_shift"] },
  { title: "Print Diffusion", print: true, ids: ["print_diffusion_on", "print_diffusion_filter_family",
    "print_diffusion_strength", "print_diffusion_scale", "print_diffusion_warmth"] },
  { title: "Grain", ids: ["grain_uniformity", "grain_sublayer_scale", "grain_density_min", "grain_blur",
                          "grain_dye_cloud", "grain_usm_sigma", "grain_usm_amount"] },
  { title: "Halation", ids: ["halation_scale", "scatter_amount", "scatter_scale", "boost_ev", "boost_range",
                             "protect_ev"] },
  { title: "Scanner", ids: ["output_scale", "scan_blur", "scan_usm_sigma", "scan_usm_amount", "glare_percent",
                            "scan_black_correction", "scan_black_level", "scan_white_correction",
                            "scan_white_level"] },
  { title: "Color Science", ids: ["adaptation_bandwidth", "adaptation_surface", "gamut_compress"] },
];
const id = (field: string) => `sf_${field}`;

// the stocks under headings, as darktable's lists file them
const groups = (stocks: Stock[], printing: boolean): [string, [string, number][]][] => {
  const of = (bw: boolean, positive: boolean) => stocks.filter((s) => s.printing === printing && s.bw === bw
    && (printing || s.positive === positive)).map((s): [string, number] => [s.name, s.hash]);
  const g: [string, [string, number][]][] = printing
    ? [["Color", of(false, false)], ["Black & White", of(true, false)]]
    : [["Color Negative", of(false, false)], ["Color Slide", of(false, true)],
       ["Black & White Negative", of(true, false)], ["Black & White Positive", of(true, true)]];
  return g.filter(([, list]) => list.length);
};

export function FilmPanel({ values, disabled, on, stocks, fetch, onDownload, onCancel, onTurnOn, onPreset,
                            onFilm, onPaper, renderControl, advanced }: {
  advanced: boolean;
  values: Record<string, number>; disabled: boolean; on: boolean;
  stocks: Stocks | null; fetch: FetchStatus | null;
  onDownload: () => void; onCancel: () => void;
  onTurnOn: () => void; onPreset: (name: string) => void;
  onFilm: (hash: number) => void; onPaper: (pick: number) => void;
  renderControl: (id: string, override?: Partial<Control>, onChange?: (v: number) => void,
                  value?: number) => React.ReactNode;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  // the preset last applied stays shown: a menu that snapped back to its
  // placeholder would, stepped with the arrow keys (each step a change),
  // apply its first preset over and over
  const [preset, setPreset] = useState("");
  const fold = (title: string) => setOpen((o) => {
    const next = new Set(o);
    if (!next.delete(title)) next.add(title);
    return next;
  });
  const running = fetch?.state === "running";
  const credit = (
    <p className="note-plain">spektrafilm by Andrea Volpato, in darktable; its film data is under CC BY-SA 4.0 and
      shared with darktable on this computer.</p>
  );
  if (!stocks) return <div className="panel film"><section><p className="note-plain">Reading the film data…</p></section></div>;
  if (!stocks.pack || !stocks.stocks.length) return (
    <div className="panel film">
      <section>
        <p className="note-plain">Film Simulation renders the photo as a film would: exposed, developed and printed on
          a paper, or scanned. It needs the measured data of the films and papers, about 12 MB, downloaded once.</p>
        {running ? (
          <>
            <div className="progress"><div className="bar" style={{ width: `${Math.max(0, fetch.progress) * 100}%` }} /></div>
            <p className="note-plain">{fetch.message}</p>
            <button className="btn small" onClick={onCancel}>Cancel</button>
          </>
        ) : (
          <>
            <button className="btn small" disabled={disabled} onClick={onDownload}>
              {fetch?.state === "failed" ? "Try Again" : "Download Film Data"}</button>
            {fetch?.state === "failed" && <p className="note-plain">The download failed: {fetch.message}</p>}
          </>
        )}
        {credit}
      </section>
    </div>
  );

  const film = filmOf(stocks.stocks, values.sf_film_hash ?? 0);
  const scan = values.sf_scan_film === 1;
  const auto = autoPaper(stocks.stocks, film);
  const paper = paperOf(stocks.stocks, values.sf_paper_hash ?? 0, film);
  const presetMenu = (
    <div className="choice-row">
      <span>Preset</span>
      <select className="field" value={on ? preset : ""} disabled={disabled}
              onChange={(e) => { setPreset(e.target.value); if (e.target.value) onPreset(e.target.value); }}>
        <option value="">{on ? "Apply a preset…" : "Start from a preset…"}</option>
        {["Film", "Look", ""].map((group) => {
          const list = SF_PRESETS.filter((p) => presetLabel(p.name).group === group);
          const opts = list.map((p) => <option key={p.name} value={p.name}>
            {group ? presetLabel(p.name).label : "Default"}</option>);
          return group ? <optgroup key={group} label={group}>{opts}</optgroup> : opts;
        })}
      </select>
    </div>
  );
  if (!on) return (
    <div className="panel film">
      <section>
        <p className="note-plain">Film Simulation takes the place of the tone mapper: the photo's light exposes a film,
          which is developed and printed on a paper, or scanned. Exposure and white balance still set what the film
          sees.</p>
        <div className="neg-step">
          <button className="btn small" disabled={disabled} onClick={onTurnOn}>Turn On Film Simulation</button>
        </div>
        {presetMenu}
        {credit}
      </section>
    </div>
  );

  const shown = (field: string) => (scan && ["print_exposure_ev", "print_auto_exposure", "print_contrast",
    "filter_m", "filter_y"].includes(field) ? null : renderControl(id(field)));
  return (
    <div className="panel film">
      <section>
        {presetMenu}
        {renderControl(id("film_hash"), { kind: "choice", menu: true, optionGroups: groups(stocks.stocks, false),
                                          options: undefined, label: "Film" }, onFilm, film?.hash)}
        {film?.positive
          ? <p className="note-plain">a slide film: scanned, with no print</p>
          : renderControl(id("paper_hash"), {
              kind: "choice", menu: true, label: "Paper", options: undefined,
              optionGroups: [["", [[`Auto${auto ? ` (${auto.name})` : ""}`, PAPER_AUTO],
                                   ["None: scan the film", PAPER_SCAN]]],
                             ...groups(stocks.stocks, true)],
            }, onPaper, scan ? PAPER_SCAN : values.sf_paper_hash ? paper?.hash ?? PAPER_AUTO : PAPER_AUTO)}
        {renderControl(id("film_format_mm"))}
      </section>
      <section>
        <h3>Exposure</h3>
        {shown("exposure_ev")}
        {shown("push_pull_stops")}
        {shown("print_exposure_ev")}
        {shown("print_auto_exposure")}
        {shown("print_contrast")}
        {shown("output_luminance_boost")}
      </section>
      {!scan && (
        <section>
          <h3>Color</h3>
          {shown("filter_m")}
          {shown("filter_y")}
        </section>
      )}
      <section>
        <h3>Grain &amp; Halation</h3>
        {renderControl(id("grain_on"))}
        {values.sf_grain_on === 1 && renderControl(id("grain_amount"))}
        {values.sf_grain_on === 1 && renderControl(id("grain_granularity"))}
        {renderControl(id("halation_on"))}
        {values.sf_halation_on === 1 && renderControl(id("halation_amount"))}
      </section>
      {advanced && (
        <section>
          <div className="section-body">
            {ADVANCED.filter((g) => !g.print || !scan).map((g) => (
              <div key={g.title}>
                <div className="neg-sub fold" onClick={() => fold(g.title)}>{g.title}<Chevron open={open.has(g.title)} /></div>
                <Collapse open={open.has(g.title)}>
                  <div>{g.ids.map((f) => renderControl(id(f)))}</div>
                </Collapse>
              </div>
            ))}
          </div>
        </section>
      )}
      {credit}
    </div>
  );
}
