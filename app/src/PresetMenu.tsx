// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// an Advanced card's presets menu: darktable's own presets for the module, in
// darktable's order (shipped ones, then the user's), loaded when it opens and
// drawn like the instance menu (InstanceMenu.tsx)
import { useState } from "react";
import { createPortal } from "react-dom";
import { AlignLeft } from "lucide-react";
import { menuKeys, useCardMenu } from "./cardMenu";
import type { DtPreset } from "./commands";
import { presetLabel } from "./presetName";

export function PresetMenu({ name, load, onPick }: {
  name: string; load: () => Promise<DtPreset[]>; onPick: (rawName: string) => void;
}) {
  const [list, setList] = useState<DtPreset[] | null>(null);
  const { at, close, toggle, box, menu } = useCardMenu(list);
  const open = (e: React.MouseEvent<HTMLButtonElement>) => {
    setList(null);
    if (!toggle(e)) return;
    // read each time: a preset saved or applied elsewhere shows as it is now
    load().then(setList, () => setList([]));
  };
  const item = (p: DtPreset) => (
    <button key={p.name} type="button" role="menuitemradio" aria-checked={p.active} data-preset={p.name}
            disabled={!p.applicable} title={p.applicable ? p.description || undefined : "this preset does not apply to this photo"}
            onClick={(e) => { e.stopPropagation(); close(); onPick(p.name); }}>
      <span className="check">{p.active ? "✓" : ""}</span><span className="name">{presetLabel(p.name)}</span>
    </button>
  );
  const builtin = list?.filter((p) => p.builtin) ?? [];
  const own = list?.filter((p) => !p.builtin) ?? [];
  return (
    <span className="preset-menu" ref={box}>
      <button type="button" className={`module-card-menu${at ? " on" : ""}`} aria-haspopup="menu" aria-expanded={!!at}
              aria-label={`Presets for ${name}`} title="darktable presets" onClick={open}>
        <AlignLeft size={14} strokeWidth={1.8} />
      </button>
      {at && createPortal(
        <div ref={menu} className="context-menu module-menu" role="menu"
             style={{ position: "fixed", left: at.x, top: at.y, maxHeight: "60vh", overflowY: "auto" }}
             onKeyDown={menuKeys}>
          <div className="menu-label">darktable presets</div>
          {list && list.length === 0 && <button type="button" role="menuitem" disabled><span className="check" /><span className="name">No presets</span></button>}
          {builtin.map(item)}
          {builtin.length > 0 && own.length > 0 && <div className="menu-sep" />}
          {own.map(item)}
        </div>, document.body)}
    </span>
  );
}
