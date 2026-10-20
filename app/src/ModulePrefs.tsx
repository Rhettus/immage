// Preferences' Modules tab: the darktable module each tool runs on, as
// README's table lists them. a tool with more than one gets a menu, set by
// Default (darktable's AgX workflow's module for each) or by hand under Custom
import { useState } from "react";
import { moduleTools } from "./manifest";
import { loadModuleChoice, loadModuleMode, storeModuleChoice, storeModuleMode, type ModuleMode } from "./moduleChoice";
import { PrefCard, PrefRow } from "./PrefsUI";

const TOOLS = moduleTools();

export function ModulePrefs() {
  const [mode, setMode] = useState(loadModuleMode);
  // bumped on a pick, so the menus read their stored values again
  const [, setPicked] = useState(0);
  const chooseMode = (v: ModuleMode) => { setMode(v); storeModuleMode(v); };
  return (
    <>
      <p className="prefs-lead">
        Which darktable module each tool runs on, and so which sliders it shows. Photos that already use one of a
        tool's modules keep it, so their edits look the same; the choice here applies to tools a photo has not used
        yet, from the next photo opened.
      </p>
      <PrefCard title="Modules">
        <PrefRow label="Modules"
                 hint={mode === "default" ? "the module darktable's AgX workflow uses for each tool"
                                           : "each tool's module as set below"}>
          <div className="segmented small">
            {([["Default", "default"], ["Custom", "custom"]] as const).map(([label, v]) => (
              <button key={v} className={mode === v ? "active" : ""} onClick={() => chooseMode(v)}>{label}</button>
            ))}
          </div>
        </PrefRow>
      </PrefCard>
      {TOOLS.map(({ panel, tools }) => (
        <PrefCard key={panel} title={panel}>
          {tools.map((t) => (
            <PrefRow key={t.title} label={t.title}>
              {t.choice ? (
                <select className="field" value={loadModuleChoice(t.choice.id)} disabled={mode === "default"}
                        onChange={(e) => { storeModuleChoice(t.choice!.id, Number(e.target.value)); setPicked((n) => n + 1); }}>
                  {t.choice.options.map((o) => (
                    <option key={o.value} value={o.value}>{o.name}{o.preferred ? " (AgX workflow)" : ""}</option>
                  ))}
                </select>
              ) : <span className="pref-value" title={t.modules.join(", ")}>{t.modules.join(", ")}</span>}
            </PrefRow>
          ))}
        </PrefCard>
      ))}
    </>
  );
}
