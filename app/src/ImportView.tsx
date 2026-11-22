// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Lightroom's import screen: the SD card importer (immporter/) over the whole
// window, below the title strip. the editor stays mounted underneath, so
// closing returns to it as it was. loaded on first use
import { lazy, Suspense } from "react";
import { X } from "lucide-react";
import type { ImportResult } from "@immporter/embed";
import { t } from "./i18n";

const Importer = lazy(async () => {
  const m = await import("@immporter/embed");
  return { default: m.ImmporterView };
});

// whether an import is running: Close waits for it, as the copy would go on
// without anything showing it
const CloseButton = lazy(async () => {
  const m = await import("@immporter/embed");
  return {
    default: ({ onClose }: { onClose: () => void }) => {
      const importing = m.useImporting();
      return (
        <button type="button" className="tool" disabled={importing} onClick={onClose}
                aria-label={t("library.import.close")}
                title={importing ? t("library.import.running") : t("library.import.back")}>
          <X size={16} aria-hidden="true" />
        </button>
      );
    },
  };
});

export function ImportView({ onClose, onImportDone, onShowImported, onOpenSettings }: {
  onClose: () => void;
  onImportDone: (r: ImportResult) => void;
  onShowImported: (r: ImportResult) => void;
  onOpenSettings?: () => void;
}) {
  return (
    <div className="import-view">
      <div className="import-head">
        <h1>{t("library.import.title")}</h1>
        <Suspense fallback={
          <button type="button" className="tool" onClick={onClose}
                  aria-label={t("library.import.close")}
                  title={t("library.import.back")}>
            <X size={16} aria-hidden="true" />
          </button>
        }><CloseButton onClose={onClose} /></Suspense>
      </div>
      <div className="import-body">
        <Suspense fallback={<div className="note-plain">{t("library.import.loading")}</div>}>
          <Importer onImportDone={onImportDone} onShowImported={onShowImported} onOpenSettings={onOpenSettings} />
        </Suspense>
      </div>
    </div>
  );
}
