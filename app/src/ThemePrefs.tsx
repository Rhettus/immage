// SPDX-License-Identifier: GPL-3.0-or-later
import { useRef, useState } from 'react';
import { PrefRow } from './PrefsUI';
import { importTheme, removeTheme, selectedTheme, selectTheme, themeEntries, THEME_MAX_BYTES, useThemes } from './themes';
export function ThemePrefs() {
  useThemes();
  const file = useRef<HTMLInputElement>(null), [error, setError] = useState('');
  const active = selectedTheme();
  function act(action: () => void) { try { action(); setError(''); } catch (e) { setError(String(e instanceof Error ? e.message : e)); } }
  return <PrefRow label="Theme" hint="interface colors; applies immediately">
    <div>
      <div className="pref-swatches" role="group" aria-label="Theme">
        {themeEntries().map(t => <button key={t.id} className={`swatch${active.id === t.id ? ' on' : ''}`} aria-label={t.name} title={t.name} aria-pressed={active.id === t.id} style={{ background: t.colors.panel }} onClick={() => act(() => selectTheme(t.id))} />)}
      </div>
      <span>{active.name}</span>{' '}
      <button className="btn" onClick={() => file.current?.click()}>Import theme…</button>
      {active.id.startsWith('custom-') && <button className="btn" onClick={() => act(() => removeTheme(active.id))}>Remove theme</button>}
      <input ref={file} type="file" accept=".json,application/json" hidden onChange={async e => { const input = e.currentTarget, picked = input.files?.[0]; input.value = ''; if (!picked) return; try { if (picked.size > THEME_MAX_BYTES) throw Error('Theme exceeds 64 KiB'); const text = await picked.text(); importTheme(text); setError(''); } catch (e) { setError(String(e instanceof Error ? e.message : e)); } }} />
      {error && <div role="alert" style={{ color: 'var(--error)' }}>{error}</div>}
    </div>
  </PrefRow>;
}
