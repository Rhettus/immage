// SPDX-License-Identifier: GPL-3.0-or-later
import { useState, type ReactNode } from "react";
import { Chevron, Collapse } from "./Collapse";
import type { Control } from "./manifest";

function DetailControls({ controls, render }: { controls: Control[]; render: (c: Control) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const primary = (c: Control) => /_gain_(medium|fine)$/.test(c.id);
  const label = controls[0].id.includes("clarity") ? "Clarity" : "Texture";
  return <>
    {controls.filter(primary).map(render)}
    <button className="detail-advanced fold" aria-expanded={open} onClick={() => setOpen(!open)}>
      {label}: Advanced<Chevron open={open} />
    </button>
    <Collapse open={open}>{controls.filter((c) => !primary(c)).map(render)}</Collapse>
  </>;
}

export function detailRows(controls: Control[], render: (c: Control) => ReactNode): ReactNode[] {
  const rows: ReactNode[] = [];
  for (let i = 0; i < controls.length;) {
    const c = controls[i];
    const prefix = /^(l_)?detail_(clarity|texture)_/.exec(c.id)?.[0];
    if (!prefix) { rows.push(render(c)); i++; continue; }
    const group: Control[] = [];
    while (i < controls.length && controls[i].id.startsWith(prefix)) group.push(controls[i++]);
    rows.push(<DetailControls key={prefix} controls={group} render={render} />);
  }
  return rows;
}
