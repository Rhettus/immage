// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Find's filter list: the group titles, and a row per filter that opens its
// editor (FindEditors.tsx) directly beneath it. A row says what its filter is
// set to; an active one has a button to clear it. FindPanel.tsx owns which row
// is open and the scrolling
import { ChevronRight, X } from "lucide-react";
import type { Named } from "./commands";
import { bodyLabel, EXPOSURE } from "./filter";
import { settingOf, type CategoryKey, type Chip, type FindState, type Group } from "./findModel";
import { chosen, dates, dimensionLabel, EXPOSURE_LABEL, gpsLabel, keyword, orientationLabel, ratioLabel, textFieldLabel } from "./FindEditors";
import { formatNumber, t } from "./i18n";
import { LABEL_COLORS } from "./library";

export const GROUP_TITLE: Record<Group, () => string> = {
  photo: () => t("library.find.group.photo"), camera: () => t("library.find.group.camera"),
  when: () => t("library.find.group.when"), immich: () => t("library.find.group.immich"),
};

export function categoryTitle(key: CategoryKey): string {
  switch (key) {
    case "rating": return t("library.find.rating");
    case "edits": return t("library.find.editStatus");
    case "kinds": return t("library.filters.fileType");
    case "keywords": return t("library.keywording.title");
    case "cameras": return t("library.filters.camera");
    case "bodies": return t("library.filters.cameraBody");
    case "lenses": return t("library.filters.lens");
    case "exposure": return t("library.filters.exposure");
    case "taken": return t("library.filters.captured");
    case "gps": return t("library.filters.gps");
    case "geometry": return t("library.filters.geometry");
    case "metadata": return t("library.filters.metadataText");
    case "place": return t("library.filters.place");
    case "people": return t("library.filters.people");
    case "albums": return t("library.filters.albums");
    case "favorites": return t("library.filters.favorites");
  }
}

// the server's names for the ids a filter holds
export type Names = { people: Named[]; tags: Named[]; albums: Named[] };

// what a filter is set to, in words, "" when it is not on
export function summarize(key: CategoryKey, state: FindState, server: boolean, names: Names): string {
  const v = settingOf(key, state, server);
  if (!v) return "";
  const f = state.filter;
  const list = v.values ?? [];
  const nameOf = (all: Named[]) => (id: string) => all.find((x) => x.id === id)?.name ?? "…";
  switch (key) {
    case "rating": {
      const colors = LABEL_COLORS.map((_, k) => k).filter((k) => (v.labels ?? 0) & (1 << k));
      const labels = colors.length + (v.unlabeled ? 1 : 0);
      return [v.stars ? t("library.find.starsPlus", { n: v.stars, count: formatNumber(v.stars) }) : "",
              v.picked ? t("library.filters.picked") : "",
              v.rejected === "hide" ? t("library.filters.hideRejected") : v.rejected === "only" ? t("library.filters.onlyRejected") : "",
              labels === 1 ? (colors.length ? t(`library.menu.label-${["red", "yellow", "green", "blue", "purple"][colors[0]]}`) : t("library.find.noLabel"))
                : labels ? t("library.find.labelsCount", { n: labels, count: formatNumber(labels) }) : ""].filter(Boolean).join(" · ");
    }
    case "edits": return v.edited === "edited" ? t("library.find.editedOnly") : v.edited === "unedited" ? t("library.find.uneditedOnly") : "";
    case "kinds": return v.flags?.includes("raw") ? "RAW" : chosen(list);
    case "keywords": return chosen(list, server ? nameOf(names.tags) : keyword);
    case "cameras": return list.length ? chosen(list) : [v.make, v.model].filter(Boolean).join(" ");
    case "bodies": return chosen(list, bodyLabel);
    case "lenses": return list.length ? chosen(list) : v.lens ?? "";
    case "exposure": {
      const set = EXPOSURE.filter((k) => f[k].length);
      return set.length === 1 && f[set[0]].length === 1 ? `${set[0] === "iso" ? "ISO " : ""}${f[set[0]][0]}` : set.map((k) => EXPOSURE_LABEL[k]).join(" · ");
    }
    case "taken": return dates(v.from ?? "", v.to ?? "");
    case "gps": return v.gps ? gpsLabel(v.gps) : "";
    case "geometry": {
      const g = v.geometry!;
      return [
        ...g.orientations.map(orientationLabel),
        ...g.aspectRatios.map(ratioLabel),
        ...(["width", "height", "minMegapixels", "maxMegapixels"] as const).filter((k) => g[k])
          .map((k) => `${dimensionLabel(k)} ${formatNumber(g[k])}`),
      ].join(" · ");
    }
    case "metadata": return v.textField && v.textQuery ? `${textFieldLabel(v.textField)} · ${v.textQuery}` : "";
    case "place": return [v.city, v.country].filter(Boolean).join(", ");
    case "people": return chosen(list, nameOf(names.people));
    case "albums": return chosen(list, nameOf(names.albums));
    case "favorites": return t("library.filters.favorites");
  }
}

export const rowId = (key: CategoryKey) => `find-row-${key}`;
export const editorId = (key: CategoryKey) => `find-ed-${key}`;

// the rows of one group, under its title
export function FilterGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="fr-group" aria-label={title}>
      <div className="fr-group-title" aria-hidden="true">{title}</div>
      {children}
    </section>
  );
}

// one filter: its row, and while open its editor (the children) beneath it.
// The clear button is the row's sibling, not inside the row's button
export function FilterRow({ cat, title, summary, open, tag, excludes, onToggle, onClear, children }: {
  cat: CategoryKey;
  title: string;
  summary: string;               // "" when the filter is off
  open: boolean;
  tag?: string;                  // IMMICH, on a server-only filter in a search of both
  excludes?: Chip["excludes"];   // a Both search loses one source to this filter
  onToggle: () => void;
  onClear: () => void;
  children?: React.ReactNode;    // the editor
}) {
  const active = !!summary;
  const warning = active && excludes ? (excludes === "local" ? t("library.find.hidesLocal") : t("library.find.hidesImmich")) : "";
  return (
    <>
      <div className="fr-wrap">
        <button id={rowId(cat)} type="button" className={`fr-row${active ? " on" : ""}${open ? " open" : ""}${active ? " has-x" : ""}`}
                aria-expanded={open} aria-controls={open ? editorId(cat) : undefined} title={summary || undefined} onClick={onToggle}>
          <span className="fr-main">
            <span className="fr-title">{title}</span>
            {tag && <span className="fr-tag">{tag}</span>}
            <span className="fr-sum">{summary || t("library.filters.any")}</span>
            {warning && <span className="fr-note">{warning}</span>}
          </span>
          <ChevronRight className="fr-chev" size={13} strokeWidth={2} aria-hidden="true" />
        </button>
        {active && (
          <button type="button" className="fr-x" aria-label={t("library.find.removeFilter", { category: title })}
                  title={t("library.find.removeFilter", { category: title })} onClick={onClear}>
            <X size={12} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
      </div>
      {open && <div className="fr-editor" id={editorId(cat)} role="group" aria-label={title}>{children}</div>}
    </>
  );
}
