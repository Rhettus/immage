// SPDX-License-Identifier: GPL-3.0-or-later
import type { ReactNode } from "react";
import type { Control } from "./manifest";

const DETAIL = /^(l_)?detail_(clarity|texture)_/;
const PRIMARY = /_gain_(medium|fine)$/;

// what the panel's Advanced toggle reveals: a detail group's sliders beyond
// Medium and Fine, and Whites' share of brilliance on AgX
export function isAdvancedControl(id: string): boolean {
  return id === "whites_brilliance" || (DETAIL.test(id) && !PRIMARY.test(id));
}

// Clarity's and Texture's detail sliders stand in for their single slider:
// each set sits in a box headed by its name, the rows without the "Texture: "
// prefix, all on the full layout, and the tuning sliders after the three bands a little apart
export function detailRows(controls: Control[], render: (c: Control) => ReactNode, advanced: boolean): ReactNode[] {
  const visible = controls.filter((c) => advanced || !isAdvancedControl(c.id));
  const rows: ReactNode[] = [];
  for (let i = 0; i < visible.length; i++) {
    const c = visible[i];
    const m = /^((?:l_)?detail_(?:clarity|texture)_)/.exec(c.id);
    if (!m) {
      rows.push(render(c));
      continue;
    }
    const group = [c];
    while (visible[i + 1]?.id.startsWith(m[1])) group.push(visible[++i]);
    const title = c.label.split(":")[0];
    let tuning = false;
    rows.push(
      <div className="subcard detail-group" key={`${m[1]}group`} data-detail-group={title}>
        <div className="subcard-head">{title}</div>
        {group.map((d) => {
          const row = render({ ...d, label: d.label.replace(/^[^:]+:\s*/, ""), wide: true });
          const gap = !tuning && !/_gain_(coarse|medium|fine)$/.test(d.id);
          tuning ||= gap;
          return gap ? <div className="detail-tuning" key={`${d.id}-gap`}>{row}</div> : row;
        })}
      </div>,
    );
  }
  return rows;
}
