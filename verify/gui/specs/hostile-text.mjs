// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { click } from '../support/controls.mjs';
import { Blocked } from '../support/scenario.mjs';
import { until } from '../support/webdriver.mjs';

// The strings fixtures.py (HOSTILE, hostile_name) puts in the photo's name and metadata.
const H = {
  title: '<img src=x onerror=window.__pwned=1>',
  description: '<script>window.__pwned=1</script>',
  creator: '"><b>bold</b>',
  rights: 'javascript:window.__pwned=1',
  make: '<img src=x onerror=window.__pwned=1>',
  model: '"><b>bold</b>',
  keywords: ['<img src=x onerror=window.__pwned=1>', '<script>window.__pwned=1</script>', '"><b>bold</b>', 'javascript:window.__pwned=1'],
};

// Read-only page observation: where the strings show, and whether any of them became markup.
function snapshot(stem) {
  const text = sel => [...document.querySelectorAll(sel)].map(e => ({ text: e.textContent, title: e.getAttribute('title') }));
  const rows = {};
  const grid = document.querySelector('.meta-grid');
  if (grid) for (const k of grid.querySelectorAll('.k')) {
    const v = k.nextElementSibling;
    if (v?.classList.contains('v')) rows[k.textContent.trim()] = { text: v.textContent, title: v.getAttribute('title'), kids: v.children.length,
      input: v.tagName === 'INPUT' ? v.value : v.querySelector('input')?.value ?? null };
  }
  const markup = ['img[src="x"]', '[onerror]', 'a[href^="javascript:"]'].map(s => [s, document.querySelectorAll(s).length]);
  return {
    stem, thumbNames: [...document.querySelectorAll('.thumb-name')].map(e => ({ text: e.textContent, kids: e.children.length })),
    rows, chips: [...document.querySelectorAll('.kw-chip')].map(e => ({ text: e.textContent, title: e.getAttribute('title'),
      kids: [...e.children].map(c => c.tagName) })),
    markup, scripts: [...document.querySelectorAll('script')].map(s => s.textContent),
    // an element made from a hostile string would sit inside one of these containers
    inner: ['.thumb-name', '.meta-grid', '.kw-chips'].map(s => [s, document.querySelectorAll(`${s} b, ${s} img, ${s} script`).length]),
    pwned: typeof window.__pwned,
  };
}

export async function hostileText(t) {
  if (t.fixture.name !== 'hostile') throw new Blocked('Requires --fixture hostile (generated photo with markup in its name and metadata)');
  const file = t.fixture.file, stem = file.replace(/\.[^.]+$/, '');
  const before = await t.driver.observe(() => document.querySelectorAll('script').length);
  // Focus mode (a plain click opens a card alone) may keep only one card open,
  // so read the keyword chips first, then open Metadata and read its rows.
  const open = async (card, probe) => {
    if (!await t.driver.observe(p => !!document.querySelector(p), probe)) await click(t, `${card} .panel-title`);
  };
  await open('.keywording', '.kw-body');
  const kw = await until(async () => {
    const x = await t.driver.observe(snapshot, stem);
    return x.chips.length >= H.keywords.length && x;
  }, 'hostile keywords shown');
  await t.evidence('hostile-keywords');
  await open('.metadata', '.meta-grid');
  // the metadata text rows fill in once the engine has read the photo
  const md = await until(async () => {
    const x = await t.driver.observe(snapshot, stem);
    return x.rows.Title?.input === H.title && x;
  }, 'hostile title shown');
  const s = { ...md, chips: kw.chips, inner: [...kw.inner, ...md.inner], markup: [...kw.markup, ...md.markup],
    pwned: kw.pwned === 'undefined' ? md.pwned : kw.pwned };
  await t.evidence('hostile-metadata');
  // (a) literal text
  assert(s.thumbNames.some(n => n.text === stem), `grid/filmstrip name shows ${stem} as text`);
  assert.equal(s.rows['File Name'].text, file, 'Metadata File Name');
  assert.equal(s.rows['File Name'].title, file, 'File Name tooltip');
  for (const [label, key] of [['Title', 'title'], ['Caption', 'description'], ['Creator', 'creator'], ['Copyright', 'rights']])
    assert.equal(s.rows[label]?.input, H[key], `${label} field holds the literal text`);
  assert.equal(s.rows.Make?.text, H.make, 'Make row text');
  assert.equal(s.rows.Make?.title, H.make, 'Make tooltip');
  assert.equal(s.rows.Model?.text, H.model, 'Model row text');
  assert.equal(s.rows.Model?.title, H.model, 'Model tooltip');
  for (const k of H.keywords) {
    const chip = s.chips.find(c => c.text.includes(k));
    assert(chip, `keyword chip shows ${k} as text`);
    assert.equal(chip.title, k, `keyword tooltip ${k}`);
    assert.deepEqual(chip.kids, ['BUTTON'], `keyword chip ${k} holds only its remove button`);
  }
  // (b) nothing was made from the text
  for (const n of s.thumbNames) assert.equal(n.kids, 0, 'photo names hold text only');
  for (const label of ['File Name', 'Folder', 'Make', 'Model']) assert.equal(s.rows[label]?.kids, 0, `${label} row holds text only`);
  for (const [sel, n] of s.markup) assert.equal(n, 0, `no element matches ${sel}`);
  for (const [sel, n] of s.inner) assert.equal(n, 0, `no b, img or script inside ${sel}`);
  assert.equal(s.scripts.length, before, 'no script element was added');
  assert(!s.scripts.some(x => x.includes('__pwned')), 'no script runs the hostile code');
  // (c) nothing ran. A content security policy violation also fails the run (run.mjs reads webview.log).
  assert.equal(s.pwned, 'undefined', 'window.__pwned stays undefined');
  t.measure({ name: 'hostile-text', file, thumbs: s.thumbNames.length, keywordChips: s.chips.length });
}
