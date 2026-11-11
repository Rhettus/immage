// SPDX-License-Identifier: GPL-3.0-or-later
import { useState, type ReactNode } from "react";
import { Chevron, Collapse } from "./Collapse";
import type { Control } from "./manifest";

// a tool's primary sliders, then the rest under "<tool>: Advanced"
function AdvancedFold({ label, primary, advanced, render }: { label: string; primary: Control[]; advanced: Control[];
                                                               render: (c: Control) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return <>
    {primary.map(render)}
    <button data-detail-id={advanced[0].id} className="detail-advanced fold" aria-expanded={open} onClick={() => setOpen(!open)}>
      {label}: Advanced<Chevron open={open} />
    </button>
    <Collapse open={open}>{advanced.map(render)}</Collapse>
  </>;
}

export function detailRows(controls: Control[], render: (c: Control) => ReactNode): ReactNode[] {
  const rows: ReactNode[] = [];
  for (let i = 0; i < controls.length;) {
    const c = controls[i];
    // Whites on AgX: the share of brilliance it adds
    if (c.id === "whites_brilliance") {
      rows.push(<AdvancedFold key={c.id} label="Whites" primary={[]} advanced={[c]} render={render} />);
      i++;
      continue;
    }
    const prefix = /^(l_)?detail_(clarity|texture)_/.exec(c.id)?.[0];
    if (!prefix) { rows.push(render(c)); i++; continue; }
    const group: Control[] = [];
    while (i < controls.length && controls[i].id.startsWith(prefix)) group.push(controls[i++]);
    const primary = (x: Control) => /_gain_(medium|fine)$/.test(x.id);
    rows.push(<AdvancedFold key={prefix} label={prefix.includes("clarity") ? "Clarity" : "Texture"}
                            primary={group.filter(primary)} advanced={group.filter((x) => !primary(x))} render={render} />);
  }
  return rows;
}
