// SPDX-License-Identifier: GPL-3.0-or-later
import { FileDown, Share, Trash } from 'lucide-react';
import { useRef, useState } from 'react';
import { commands, type Value } from './commands';
import { PrefRow } from './PrefsUI';
import { t } from './i18n';
import {
  importTheme,
  isCustomTheme,
  removeTheme,
  selectedTheme,
  selectTheme,
  themeEntries,
  themePayload,
  THEME_MAX_BYTES,
  useThemes,
} from './themes';

const safeName = (name: string) => name.replace(/[/\\:*?"<>|]+/g, "_");

export function ThemePrefs() {
  useThemes();
  const file = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const active = selectedTheme();
  const custom = isCustomTheme(active);

  function act(action: () => void) {
    try {
      action();
      setError('');
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  async function exportActive() {
    try {
      await commands.exportPresetsExport(
        themePayload(active) as unknown as Value,
        safeName(active.name),
        t("library.theme.exportFileLabel"),
      );
      setError('');
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  const removeLabel = custom
    ? t("library.theme.removeNamed", { name: active.name })
    : t("library.theme.removeBuiltin");

  return (
    <PrefRow id="Theme" label={t("library.theme.label")} hint={t("library.theme.hint")}>
      <div className="theme-prefs">
        <div className="pref-swatches" role="group" aria-label={t("library.theme.label")}>
          {themeEntries().map(entry => (
            <button
              key={entry.id}
              type="button"
              className={`swatch${active.id === entry.id ? ' on' : ''}`}
              aria-label={entry.name}
              title={entry.name}
              aria-pressed={active.id === entry.id}
              style={{ background: entry.colors.panel }}
              onClick={() => act(() => selectTheme(entry.id))}
            />
          ))}
        </div>
        <div className="theme-prefs-bar">
          <span className="theme-prefs-name">{active.name}</span>
          <div className="theme-prefs-actions">
            <button
              type="button"
              className="tool"
              title={t("library.theme.import")}
              aria-label={t("library.theme.import")}
              onClick={() => file.current?.click()}
            >
              <FileDown className="icon" strokeWidth={1.8} />
            </button>
            <button
              type="button"
              className="tool"
              title={t("library.theme.export", { name: active.name })}
              aria-label={t("library.theme.export", { name: active.name })}
              onClick={() => void exportActive()}
            >
              <Share className="icon" strokeWidth={1.8} />
            </button>
            <button
              type="button"
              className="tool"
              disabled={!custom}
              title={removeLabel}
              aria-label={removeLabel}
              onClick={() => act(() => removeTheme(active.id))}
            >
              <Trash className="icon" strokeWidth={1.8} />
            </button>
          </div>
        </div>
        <input
          ref={file}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={async e => {
            const input = e.currentTarget;
            const picked = input.files?.[0];
            input.value = '';
            if (!picked) return;
            try {
              if (picked.size > THEME_MAX_BYTES) throw Error(t("library.theme.tooLarge"));
              const text = await picked.text();
              importTheme(text);
              setError('');
            } catch (err) {
              setError(String(err instanceof Error ? err.message : err));
            }
          }}
        />
        {error && <div role="alert" className="theme-prefs-error">{error}</div>}
      </div>
    </PrefRow>
  );
}
