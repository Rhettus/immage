// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { Chevron } from "./Collapse";
import { t } from "./i18n";

export function CullingPanel({ disabled, onPreview, expanded = true, onToggle, pin, showHeader = true }: {
  disabled: boolean; onPreview: () => void; expanded?: boolean; onToggle?: (alt: boolean) => void; pin?: React.ReactNode; showHeader?: boolean;
}) {
  const coming = t("app.culling.comingSoon");
  const placeholder = (label: string) => <button className="culling-action" disabled>{label}</button>;
  return <section className={`culling-card${expanded ? " expanded" : ""}`}>
    {showHeader && <div className="panel-head"><button type="button" className="panel-title-toggle" aria-expanded={expanded}
      onClick={(e) => onToggle?.(e.altKey)}>{t("app.panel.culling")}<Chevron open={expanded} /></button><div className="head-tools">{pin}</div></div>}
    {expanded && <div className="culling-panel">
    <h2 className="group-label">{t("app.culling.previewSection")}</h2>
    <button className="culling-action" disabled={disabled} onClick={onPreview}>
      <span>{t("menu.culling-preview")}</span><kbd>F</kbd>
    </button>
    {placeholder(t("app.culling.compare"))}
    {placeholder(t("app.culling.survey"))}
    <h2 className="group-label">{t("app.culling.autoCull")}<span>{coming}</span></h2>
    {placeholder(t("app.culling.blur"))}
    {placeholder(t("app.culling.duplicates"))}
    <h2 className="group-label">{t("app.culling.scenes")}<span>{coming}</span></h2>
    {placeholder(t("app.culling.sceneGrouping"))}
    {placeholder(t("app.culling.bestFrame"))}
    </div>}
  </section>;
}
