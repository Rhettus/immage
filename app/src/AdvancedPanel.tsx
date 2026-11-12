// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import { Chevron, Collapse } from "./Collapse";

// Advanced mode's Adjustments: the same fold-out groups as Simple, each to
// hold darktable's modules as cards. None are there yet.
export const TECHNICAL_ID = "technical";

// the module search above the groups; inert until there are modules to find
export function AdvancedSearch() {
  return (
    <div className="advanced-search">
      <input type="search" className="field" placeholder="Search modules" aria-label="Search modules" spellCheck={false} />
    </div>
  );
}

// one group: its title row folds like Simple's (Focus mode and Alt-click
// are the caller's onToggle), with no More controls icon
export function AdvancedGroup({ id, title, open, onToggle }: {
  id: string; title: string; open: boolean; onToggle: (solo: boolean) => void;
}) {
  return (
    <div className="panel adjust" data-panel-id={id}>
      <div className={`panel-title${open ? " open" : ""}`} onClick={(e) => onToggle(e.altKey)}>
        <span>{title}</span>
        <Chevron open={open} />
      </div>
      <Collapse open={open}>
        <div className="panel-body">
          <div className="advanced-empty">No darktable modules yet</div>
        </div>
      </Collapse>
    </div>
  );
}
