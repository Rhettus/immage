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

export function detailRows(controls: Control[], render: (c: Control) => ReactNode, advanced: boolean): ReactNode[] {
  const rows: ReactNode[] = [];
  for (const c of controls) {
    if (isAdvancedControl(c.id) && !advanced) continue;
    rows.push(render(c));
  }
  return rows;
}
