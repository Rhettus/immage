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
import { PrefCard, PrefRow, PrefSwitch } from "./PrefsUI";
import { t } from "./i18n";
import { fieldText } from "./fieldText";
import { LAYOUTS, groupLayouts } from "./advancedLayout";
import { essentialsHidden, hiddenKey, loadHiddenModules, storeHiddenModules } from "./hiddenModules";
import { panels } from "./manifest";
import { loadLutFolder, storeLutFolder } from "./lutFolder";
import { commands } from "./commands";

const TOOLS = moduleTools().filter((group) => group.panel !== "Masks");
// Advanced mode's groups, as Adjustments shows them
const ADVANCED_GROUPS = [...panels.filter((p) => !p.hidden).map((p) => ({ id: p.id, title: p.advancedTitle ?? p.title })),
                         { id: "technical", title: t("modules.technical") }];

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
  const advancedOpen = open.has("advanced");
  const [hidden, setHidden] = useState(() => new Set(loadHiddenModules()));
  const [find, setFind] = useState("");
  const setHiddenKeys = (keys: Iterable<string>) => { const next = new Set(keys); setHidden(next); storeHiddenModules(next); };
  const setGroup = (group: string, hide: boolean) => {
    const next = new Set(hidden);
    for (const l of groupLayouts(group)) { const k = hiddenKey(group, l.op); if (hide) next.add(k); else next.delete(k); }
    setHiddenKeys(next);
  };
  const needle = find.trim().toLowerCase();
  const [lutFolder, setLutFolder] = useState(loadLutFolder);
  const chooseLutFolder = (v: string) => { setLutFolder(v); storeLutFolder(v); };
  const browseLutFolder = () => { commands.pickFolder(lutFolder).then((f) => { if (f) chooseLutFolder(f); }).catch(() => {}); };
  const [mode, setMode] = useState(loadModuleMode);
  // bumped on a pick, so the menus read their stored values again
  const [, setPicked] = useState(0);
  const chooseMode = (v: ModuleMode) => { setMode(v); storeModuleMode(v); };
  const menu = (choice: ModuleChoice, scope: "global" | "masks") => {
    const label = `${scope === "global" ? t("modules.global") : t("modules.masks")} ${fieldText(choice.label)}`;
    const selected = loadModuleChoice(choice.id, scope);
    if (mode === "default") {
      const name = choice.options.find((o) => o.value === selected)?.name ?? "";
      return <span className="pref-value" aria-label={label} title={name}>{name}</span>;
    }
    return (
      <select className="field" aria-label={label} value={selected}
              onChange={(e) => { storeModuleChoice(choice.id, Number(e.target.value), scope); setPicked((n) => n + 1); }}>
        {choice.options.map((o) => (
          <option key={o.value} value={o.value}>{fieldText(o.name)}{o.preferred ? ` ${t("modules.default")}` : ""}</option>
        ))}
      </select>
    );
  };
  return (
    <>
      <p className="prefs-lead">{t("modules.lead")}</p>
      <PrefCard title={t("modules.title")}>
        <PrefRow id="Modules" label={t("modules.title")}
                 summary={mode === "default" ? t("modules.row.summary.default") : t("modules.row.summary.custom")}
                 hint={mode === "default" ? t("modules.row.hint.default") : t("modules.row.hint.custom")}>
          <div className="segmented small">
            {([[t("modules.mode.default"), "default"], [t("modules.mode.custom"), "custom"]] as const).map(([label, v]) => (
              <button key={v} className={mode === v ? "active" : ""} onClick={() => chooseMode(v)}>{label}</button>
            ))}
          </div>
        </PrefRow>
      </PrefCard>
      <button className="module-prefs-fold" aria-expanded={globalOpen} aria-controls="module-prefs-global"
              onClick={(e) => toggle("global", e.altKey)}>
        {t("modules.global")} <Chevron open={globalOpen} />
      </button>
      <Collapse open={globalOpen}>
        <div id="module-prefs-global">
        {TOOLS.map(({ panel, tools }) => (
          <PrefCard key={panel} title={panel}>
            {tools.map((tool) => (
              <PrefRow key={tool.title} label={tool.title}>
                {tool.choice ? (
                  menu(tool.choice, "global")
                ) : <span className="pref-value" title={tool.modules.map(fieldText).join(", ")}>{tool.modules.map(fieldText).join(", ")}</span>}
              </PrefRow>
            ))}
          </PrefCard>
        ))}
        </div>
      </Collapse>
      <button className="module-prefs-fold" aria-expanded={masksOpen} aria-controls="module-prefs-masks"
              onClick={(e) => toggle("masks", e.altKey)}>
        {t("modules.masks")} <Chevron open={masksOpen} />
      </button>
      <Collapse open={masksOpen}>
        <div id="module-prefs-masks">
          <PrefCard title={t("modules.maskcard")}>
            {MASK_MODULE_CHOICES.map((c) => (
              <PrefRow key={c.id} label={c.label}>{menu(c, "masks")}</PrefRow>
            ))}
            <PrefRow label={t("fields.maskModule.whiteBalance")}><span className="pref-value">{t("fields.darktable.colorCalibration")}</span></PrefRow>
            <PrefRow label={t("fields.maskModule.exposureBlacks")}><span className="pref-value">{t("fields.darktable.exposure")}</span></PrefRow>
            <PrefRow label={t("fields.maskModule.whitesHueSaturation")}><span className="pref-value">{t("fields.darktable.colorBalanceRgb")}</span></PrefRow>
            <PrefRow label={t("fields.maskModule.hsl")}><span className="pref-value">{t("fields.darktable.colorEqualizer")}</span></PrefRow>
            <PrefRow label={t("fields.maskModule.colorGrading")}><span className="pref-value">{t("fields.darktable.colorBalanceRgb")}</span></PrefRow>
            <PrefRow label={t("fields.maskModule.dehaze")}><span className="pref-value">{t("fields.darktable.hazeRemoval")}</span></PrefRow>
            <PrefRow label={t("fields.maskModule.noise")}><span className="pref-value">{t("fields.darktable.denoiseProfiled")}</span></PrefRow>
          </PrefCard>
        </div>
      </Collapse>
      <button className="module-prefs-fold" aria-expanded={advancedOpen} aria-controls="module-prefs-advanced"
              onClick={(e) => toggle("advanced", e.altKey)}>
        {t("modules.advanced")} <Chevron open={advancedOpen} />
      </button>
      <Collapse open={advancedOpen}>
        <div id="module-prefs-advanced">
          <p className="prefs-lead">{t("modules.advanced.lead")}</p>
          <PrefCard title={t("modules.lut.card")}>
            <PrefRow id="LUT folder" label={t("modules.lut.row")} summary={t("modules.lut.summary")}
                     hint={t("modules.lut.hint")}>
              <div className="module-prefs-tools">
                <input className="field" placeholder={t("modules.lut.home")} aria-label={t("modules.lut.card")} spellCheck={false}
                       value={lutFolder} onChange={(e) => chooseLutFolder(e.target.value)} />
                <button className="btn small" onClick={browseLutFolder}>{t("prefs.choose")}</button>
              </div>
            </PrefRow>
          </PrefCard>
          <div className="module-prefs-tools">
            <input type="search" className="field" placeholder={t("modules.filter")} aria-label={t("modules.filter")} spellCheck={false}
                   value={find} onChange={(e) => setFind(e.target.value)} />
            <button className="btn small" onClick={() => setHiddenKeys(essentialsHidden(LAYOUTS))}
                    title={t("modules.essentials.title")}>{t("modules.essentials")}</button>
          </div>
          {ADVANCED_GROUPS.map(({ id, title }) => {
            const rows = groupLayouts(id).filter((l) => !needle || l.title.toLowerCase().includes(needle));
            if (!rows.length) return null;
            return (
              <PrefCard key={id} title={title}>
                <PrefRow id="Modules" label={t("modules.title")} summary={t("modules.shown", { shown: rows.filter((l) => !hidden.has(hiddenKey(id, l.op))).length, total: rows.length })}>
                  <div className="module-prefs-bulk">
                    <button className="btn small" onClick={() => setGroup(id, false)}>{t("modules.showall")}</button>
                    <button className="btn small" onClick={() => setGroup(id, true)}>{t("modules.hideall")}</button>
                  </div>
                </PrefRow>
                {rows.map((l) => (
                  <PrefRow key={l.op} label={l.title}>
                    <PrefSwitch checked={!hidden.has(hiddenKey(id, l.op))}
                                onChange={(on) => { const next = new Set(hidden); if (on) next.delete(hiddenKey(id, l.op)); else next.add(hiddenKey(id, l.op)); setHiddenKeys(next); }} />
                  </PrefRow>
                ))}
              </PrefCard>
            );
          })}
        </div>
      </Collapse>
    </>
  );
}
