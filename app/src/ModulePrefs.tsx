// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Preferences' Modules tab: the darktable module each tool runs on, as
// README's table lists them. a tool with more than one gets a menu, set by
// Default (darktable's AgX workflow's module for each, but contrast & texture
// for Clarity and Texture) or by hand under Custom
import { useState } from "react";
import { MASK_MODULE_CHOICES, moduleTools, type ModuleChoice } from "./manifest";
import { loadModuleChoice, loadModuleMode, storeModuleChoice, storeModuleMode, type ModuleMode } from "./moduleChoice";
import { Chevron, Collapse } from "./Collapse";
import { PrefCard, PrefRow } from "./PrefsUI";

const TOOLS = moduleTools().filter((group) => group.panel !== "Masks");

export function ModulePrefs({ focusMode }: { focusMode: boolean }) {
  const [open, setOpen] = useState(() => new Set(focusMode ? ["global"] : ["global", "masks"]));
  const toggle = (id: string, alt: boolean) => setOpen((old) => {
    const solo = focusMode ? !alt && !old.has(id) : alt;
    if (solo) return new Set(old.has(id) && old.size === 1 ? [] : [id]);
    const next = new Set(old);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const globalOpen = open.has("global");
  const masksOpen = open.has("masks");
  const [mode, setMode] = useState(loadModuleMode);
  // bumped on a pick, so the menus read their stored values again
  const [, setPicked] = useState(0);
  const chooseMode = (v: ModuleMode) => { setMode(v); storeModuleMode(v); };
  const menu = (choice: ModuleChoice, scope: "global" | "masks") => {
    const label = `${scope === "global" ? "Global" : "Masks"} ${choice.label}`;
    const selected = loadModuleChoice(choice.id, scope);
    if (mode === "default") {
      const name = choice.options.find((o) => o.value === selected)?.name ?? "";
      return <span className="pref-value" aria-label={label} title={name}>{name}</span>;
    }
    return (
      <select className="field" aria-label={label} value={selected}
              onChange={(e) => { storeModuleChoice(choice.id, Number(e.target.value), scope); setPicked((n) => n + 1); }}>
        {choice.options.map((o) => (
          <option key={o.value} value={o.value}>{o.name}{o.preferred ? " (default)" : ""}</option>
        ))}
      </select>
    );
  };
  return (
    <>
      <p className="prefs-lead">
        Choose which darktable module each tool uses; it determines the sliders shown. Existing edits keep their
        modules, and new choices apply when Preferences closes. Global and Masks have separate choices.
      </p>
      <PrefCard title="Modules">
        <PrefRow label="Modules"
                 summary={mode === "default" ? "darktable's AgX workflow defaults" : "custom module choices below"}
                 hint={mode === "default" ? "the module darktable's AgX workflow uses for each tool, and contrast & texture for Clarity and Texture"
                                           : "each tool's module as set below"}>
          <div className="segmented small">
            {([["Default", "default"], ["Custom", "custom"]] as const).map(([label, v]) => (
              <button key={v} className={mode === v ? "active" : ""} onClick={() => chooseMode(v)}>{label}</button>
            ))}
          </div>
        </PrefRow>
      </PrefCard>
      <button className="module-prefs-fold" aria-expanded={globalOpen} aria-controls="module-prefs-global"
              onClick={(e) => toggle("global", e.altKey)}>
        Global <Chevron open={globalOpen} />
      </button>
      <Collapse open={globalOpen}>
        <div id="module-prefs-global">
        {TOOLS.map(({ panel, tools }) => (
          <PrefCard key={panel} title={panel}>
            {tools.map((t) => (
              <PrefRow key={t.title} label={t.title}>
                {t.choice ? (
                  menu(t.choice, "global")
                ) : <span className="pref-value" title={t.modules.join(", ")}>{t.modules.join(", ")}</span>}
              </PrefRow>
            ))}
          </PrefCard>
        ))}
        </div>
      </Collapse>
      <button className="module-prefs-fold" aria-expanded={masksOpen} aria-controls="module-prefs-masks"
              onClick={(e) => toggle("masks", e.altKey)}>
        Masks <Chevron open={masksOpen} />
      </button>
      <Collapse open={masksOpen}>
        <div id="module-prefs-masks">
          <PrefCard title="Mask adjustments">
            {MASK_MODULE_CHOICES.map((c) => (
              <PrefRow key={c.id} label={c.label}>{menu(c, "masks")}</PrefRow>
            ))}
            <PrefRow label="White Balance"><span className="pref-value">color calibration</span></PrefRow>
            <PrefRow label="Exposure and Blacks"><span className="pref-value">exposure</span></PrefRow>
            <PrefRow label="Whites, Hue and Saturation"><span className="pref-value">color balance rgb</span></PrefRow>
            <PrefRow label="HSL"><span className="pref-value">color equalizer</span></PrefRow>
            <PrefRow label="Color Grading"><span className="pref-value">color balance rgb</span></PrefRow>
            <PrefRow label="Dehaze"><span className="pref-value">haze removal</span></PrefRow>
            <PrefRow label="Noise"><span className="pref-value">denoise (profiled)</span></PrefRow>
          </PrefCard>
        </div>
      </Collapse>
    </>
  );
}
