// SPDX-License-Identifier: GPL-3.0-or-later
// Keyboard Shortcuts live search (app/src/shortcutsSearch.ts): partial,
// accent-insensitive, multi-word matching across sections, keys, and actions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('./') && ctx.parentURL?.endsWith('.ts')) {
      const url = new URL(spec + '.ts', ctx.parentURL);
      if (existsSync(url)) return next(url.href, ctx);
    }
    return next(spec, ctx);
  },
});

const { filterShortcutGroups, normalizeShortcutSearch } = await import('../app/src/shortcutsSearch.ts');

const NAMES = [['⌘', 'Ctrl'], ['⌃', 'Ctrl'], ['⌥', 'Alt'], ['⇧', 'Shift']];
function formatWinLinux(s) {
  return s.replace(/[⇧⌥⌘⌃]+(-(?=[a-z])|)/g, (m, dash, at) => {
    const names = NAMES.filter(([g]) => m.includes(g)).map(([, n]) => n).join('+');
    if (dash) return `${names}-`;
    const next = s[at + m.length];
    return next === undefined || next === ' ' || next === ')' ? names : `${names}+`;
  });
}

const GROUPS = [
  {
    title: 'General',
    keys: [
      ['⇧⌘E', 'Export'],
      ['⌘Z', 'Undo'],
      ['⌘/', 'Keyboard shortcuts'],
    ],
  },
  {
    title: 'View',
    keys: [
      ['F', 'Preview (editor: full screen; grid: culling lightbox; F or Esc leaves)'],
      ['H', 'Next scope: histogram, waveform (⇧H back)'],
    ],
  },
  {
    title: 'Photos',
    keys: [
      ['← →', 'Previous or next photo'],
      ['⌥-drag', 'Drag something'],
    ],
  },
  {
    title: 'Masks',
    keys: [
      ['O', 'Show or hide overlay'],
      ['K', 'Brush'],
    ],
  },
];

test('empty or whitespace-only query returns all groups unchanged', () => {
  assert.deepEqual(filterShortcutGroups(GROUPS, ''), GROUPS);
  assert.deepEqual(filterShortcutGroups(GROUPS, '   \t\n  '), GROUPS);
});

test('partial case-insensitive matching on action descriptions', () => {
  const hits = filterShortcutGroups(GROUPS, 'LIGHTBOX', (s) => s);
  assert.deepEqual(hits, [
    {
      title: 'View',
      keys: [['F', 'Preview (editor: full screen; grid: culling lightbox; F or Esc leaves)']],
    },
  ]);
});

test('accent and diacritic-insensitive matching', () => {
  assert.equal(normalizeShortcutSearch('Aperçu Sélection'), 'apercu selection');
  const frenchGroups = [
    {
      title: 'Affichage',
      keys: [
        ['F', 'Aperçu plein écran'],
        ['G', 'Afficher la sélection'],
      ],
    },
  ];
  assert.deepEqual(filterShortcutGroups(frenchGroups, 'apercu', (s) => s), [
    { title: 'Affichage', keys: [['F', 'Aperçu plein écran']] },
  ]);
  assert.deepEqual(filterShortcutGroups(frenchGroups, 'selection', (s) => s), [
    { title: 'Affichage', keys: [['G', 'Afficher la sélection']] },
  ]);
});

test('multi-word token matching across section, key, and action', () => {
  const hits = filterShortcutGroups(GROUPS, 'masks overlay', (s) => s);
  assert.deepEqual(hits, [
    { title: 'Masks', keys: [['O', 'Show or hide overlay']] },
  ]);
  const cross = filterShortcutGroups(GROUPS, 'view waveform h', (s) => s);
  assert.deepEqual(cross, [
    { title: 'View', keys: [['H', 'Next scope: histogram, waveform (⇧H back)']] },
  ]);
});

test('matching by group/section title preserves all entries in matching group', () => {
  const hits = filterShortcutGroups(GROUPS, 'Masks', (s) => s);
  assert.deepEqual(hits, [
    {
      title: 'Masks',
      keys: [
        ['O', 'Show or hide overlay'],
        ['K', 'Brush'],
      ],
    },
  ]);
});

test('macOS identity formatter matches modifier and arrow aliases and symbols', () => {
  const id = (s) => s;
  assert.deepEqual(filterShortcutGroups(GROUPS, 'cmd shift', id), [
    { title: 'General', keys: [['⇧⌘E', 'Export']] },
  ]);
  assert.deepEqual(filterShortcutGroups(GROUPS, '⌘', id), [
    {
      title: 'General',
      keys: [
        ['⇧⌘E', 'Export'],
        ['⌘Z', 'Undo'],
        ['⌘/', 'Keyboard shortcuts'],
      ],
    },
  ]);
  assert.deepEqual(filterShortcutGroups(GROUPS, 'arrow', id), [
    { title: 'Photos', keys: [['← →', 'Previous or next photo']] },
  ]);
});

test('Windows/Linux formatter matches formatted keys and aliases', () => {
  assert.deepEqual(filterShortcutGroups(GROUPS, 'Ctrl+Shift+E', formatWinLinux), [
    { title: 'General', keys: [['⇧⌘E', 'Export']] },
  ]);
  assert.deepEqual(filterShortcutGroups(GROUPS, 'ctrl z', formatWinLinux), [
    { title: 'General', keys: [['⌘Z', 'Undo']] },
  ]);
  assert.deepEqual(filterShortcutGroups(GROUPS, 'alt drag', formatWinLinux), [
    { title: 'Photos', keys: [['⌥-drag', 'Drag something']] },
  ]);
  assert.deepEqual(filterShortcutGroups(GROUPS, 'left', formatWinLinux), [
    { title: 'Photos', keys: [['← →', 'Previous or next photo']] },
  ]);
});

test('unmatched query returns empty array and matching preserves group and entry order', () => {
  assert.deepEqual(filterShortcutGroups(GROUPS, 'nonexistent-xyz', (s) => s), []);
  const ordered = filterShortcutGroups(GROUPS, 'o', (s) => s);
  assert.deepEqual(
    ordered.map((g) => g.title),
    ['General', 'View', 'Photos', 'Masks'],
  );
  assert.deepEqual(
    ordered[0].keys.map(([k]) => k),
    ['⇧⌘E', '⌘Z', '⌘/'],
  );
});
