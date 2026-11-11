// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the Film Simulation panel: darktable's spektrafilm, a spectral model of a
// film exposed, developed and printed, or scanned. its data pack comes
// first, downloaded on first use; then turning it on, a preset, the film
// and paper, the controls most photos need, and the rest of darktable's
// tabs folded under Advanced (spektrafilm.ts)
import { useEffect, useState } from "react";
import type { Control } from "./manifest";
import { Chevron, Collapse } from "./Collapse";
import { GuidedSteps, openStep, useStepOpen, type Step } from "./GuidedSteps";
import { Tile } from "./Presets";
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

// the steps by what decides which can be opened, for the tiles wanted
const stepLayout = (slide: boolean, scan: boolean, advanced: boolean) => [
  { id: "stock" }, { id: "paper", skipped: slide }, { id: "exposure" }, { id: "color", hidden: scan },
  { id: "grain" }, { id: "advanced", hidden: !advanced },
];

// the controls the advanced section renders, for its edited dot; the print
// folds are hidden for a scan
export const filmAdvancedIds = (values: Record<string, number>): string[] =>
  ADVANCED.filter((g) => !g.print || values.sf_scan_film !== 1).flatMap((g) => g.ids.map(id));

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

// the keys of the tiles the panel shows, for the preview cache: a film's by
// its hash, a paper's by the film it is printed with and its pick
export const filmTileKey = (hash: number) => `film:${hash}`;
export const paperTileKey = (film: number, pick: number) => `paper:${film}:${pick}`;

export function FilmPanel({ values, disabled, on, stocks, fetch, onDownload, onCancel, onTurnOn, onPreset,
                            onFilm, onPaper, renderControl, advanced, preview, onWant }: {
  advanced: boolean;
  preview: (key: string) => ImageBitmap | undefined;
  onWant: (keys: string[]) => void;
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
  const [stepOpen, setStepOpen] = useStepOpen("film");
  // only the open step's tiles are rendered
  const allStocks = stocks?.stocks ?? [];
  const film = filmOf(allStocks, values.sf_film_hash ?? 0);
  const scan = values.sf_scan_film === 1;
  const slide = !!film?.positive;
  const stepNow = on ? openStep(stepLayout(slide, scan, advanced), stepOpen) : "";
  const wanted = stepNow === "stock" ? allStocks.filter((x) => !x.printing).map((x) => filmTileKey(x.hash))
    : stepNow === "paper" ? [PAPER_AUTO, PAPER_SCAN, ...allStocks.filter((x) => x.printing).map((x) => x.hash)]
        .map((p) => paperTileKey(film?.hash ?? 0, p)) : [];
  const wantedKey = wanted.join(",");
  useEffect(() => { onWant(wanted); }, [wantedKey]);
  useEffect(() => () => onWant([]), []);
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

  const auto = autoPaper(stocks.stocks, film);
  const paper = paperOf(stocks.stocks, values.sf_paper_hash ?? 0, film);
  const presetMenu = (
    <div className="choice-row">
      <span>Preset</span>
      <select className="field" data-action="film-preset" value={on ? preset : ""} disabled={disabled}
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
  const tile = (key: string, name: string, picked: boolean, click: () => void, title = name) => (
    <button key={key} type="button" className={`tile${picked ? " on" : ""}`} title={title} disabled={disabled}
            data-tile={key} aria-pressed={picked} onClick={click}>
      <Tile bitmap={preview(key)} /><span className="tile-name">{name}</span>
    </button>
  );
  const num = (v: number | undefined, d: number) => (v ?? 0).toFixed(d);
  const signed = (v: number | undefined, d: number) => `${(v ?? 0) > 0 ? "+" : ""}${num(v, d)}`;
  const paperPick = scan ? PAPER_SCAN : values.sf_paper_hash ? paper?.hash ?? PAPER_AUTO : PAPER_AUTO;
  const paperName = scan ? "Scanned" : paperPick === PAPER_AUTO ? "Auto paper" : paper?.name ?? "";
  const printTile = (pick: number, name: string, title?: string) =>
    tile(paperTileKey(film?.hash ?? 0, pick), name, paperPick === pick, () => onPaper(pick), title);
  const steps: Step[] = [
    { id: "stock", title: "Stock", summary: `${film?.name ?? ""} · ${slide ? "Scanned" : paperName}`,
      content: (
        <>
          {presetMenu}
          {groups(stocks.stocks, false).map(([title, list]) => (
            <div key={title}>
              <div className="tile-group">{title}</div>
              <div className="tile-grid">
                {list.map(([name, hash]) => tile(filmTileKey(hash), name, film?.hash === hash, () => onFilm(hash)))}
              </div>
            </div>
          ))}
        </>
      ) },
    { id: "paper", title: "Paper", skipped: slide,
      summary: slide ? "a slide film: scanned, with no print" : scan ? "None: scan the film"
        : paperPick === PAPER_AUTO ? `Auto (${auto?.name ?? ""})` : paperName,
      content: (
        <>
          <div className="tile-grid">
            {printTile(PAPER_AUTO, `Auto${auto ? ` (${auto.name})` : ""}`)}
            {printTile(PAPER_SCAN, "None: scan the film")}
          </div>
          {groups(stocks.stocks, true).map(([title, list]) => (
            <div key={title}>
              <div className="tile-group">{title}</div>
              <div className="tile-grid">{list.map(([name, hash]) => printTile(hash, name))}</div>
            </div>
          ))}
        </>
      ) },
    { id: "exposure", title: "Exposure",
      summary: `Exposure ${signed(values.sf_exposure_ev, 1)} · Push ${signed(values.sf_push_pull_stops, 0)}`,
      content: (
        <>
          {shown("exposure_ev")}
          {shown("push_pull_stops")}
          {shown("print_exposure_ev")}
          {shown("print_auto_exposure")}
          {shown("print_contrast")}
          {shown("output_luminance_boost")}
        </>
      ) },
    { id: "color", title: "Color", hidden: scan, summary: `M ${signed(values.sf_filter_m, 0)} · Y ${signed(values.sf_filter_y, 0)}`,
      content: <>{shown("filter_m")}{shown("filter_y")}</> },
    { id: "grain", title: "Grain & Halation",
      summary: `${values.sf_grain_on === 1 ? `Grain ${num(values.sf_grain_amount, 2)}` : "Grain off"} · `
        + `${values.sf_halation_on === 1 ? `Halation ${num(values.sf_halation_amount, 2)}` : "Halation off"}`,
      content: (
        <>
          {renderControl(id("grain_on"))}
          {values.sf_grain_on === 1 && renderControl(id("grain_amount"))}
          {values.sf_grain_on === 1 && renderControl(id("grain_granularity"))}
          {renderControl(id("halation_on"))}
          {values.sf_halation_on === 1 && renderControl(id("halation_amount"))}
        </>
      ) },
    { id: "advanced", title: "Advanced", hidden: !advanced, summary: "Development, couplers, print, scanner…",
      content: (
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
      ) },
  ];
  return (
    <div className="panel film">
      <div className="film-format">{renderControl(id("film_format_mm"))}</div>
      <GuidedSteps steps={steps} open={stepOpen} onOpen={setStepOpen} />
      {credit}
    </div>
  );
}
