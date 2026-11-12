// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { until } from './webdriver.mjs';

// Read only. No scrollIntoView: scrolling must go through real wheel input.
// With text, the first match whose own text (a menu item's shortcut,
// <span class="key">, and a filter row's tick and count left out) is that text.
export function inspect(selector, text) {
  const own = b => [...b.childNodes].filter(n => !['key', 'tick', 'count'].some(c => n.classList?.contains(c))).map(n => n.textContent).join('').trim();
  const e = text == null ? document.querySelector(selector) : [...document.querySelectorAll(selector)].find(b => own(b) === text);
  if (!e) return null;
  const r = e.getBoundingClientRect(), s = getComputedStyle(e);
  let clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }, scroll, scrollX;
  for (let p = e.parentElement; p; p = p.parentElement) {
    const ps = getComputedStyle(p), pr = p.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(ps.overflowY)) {
      clip.top = Math.max(clip.top, pr.top); clip.bottom = Math.min(clip.bottom, pr.bottom);
    }
    if (/(auto|scroll|hidden|clip)/.test(ps.overflowX)) {
      clip.left = Math.max(clip.left, pr.left); clip.right = Math.min(clip.right, pr.right);
    }
    // a list left scrolled after its content shrank (a section folded) can
    // report no overflow while scrollTop is still above zero: wheel it too
    if (!scroll && /(auto|scroll)/.test(ps.overflowY) && (p.scrollHeight > p.clientHeight || p.scrollTop > 0))
      scroll = { x: pr.right - 6, left: pr.left + 12, y: Math.max(1, Math.min(innerHeight - 1, pr.top + pr.height / 2)), top: p.scrollTop,
                 height: p.scrollHeight, client: p.clientHeight };
    if (!scrollX && /(auto|scroll)/.test(ps.overflowX) && p.scrollWidth > p.clientWidth)
      scrollX = { x: Math.max(1, Math.min(innerWidth - 1, pr.left + pr.width / 2)), y: pr.bottom - 6, left: p.scrollLeft };
  }
  const x = r.x + r.width / 2, y = r.y + r.height / 2, hit = document.elementFromPoint(x, y);
  const row = e.closest('.slider'), label = row?.querySelector('label'), lr = label?.getBoundingClientRect();
  return { bounds: { x: r.x, y: r.y, width: r.width, height: r.height }, x, y, clip, scroll, scrollX,
    visible: r.width > 0 && r.height > 0 && r.left >= clip.left && r.right <= clip.right && r.top >= clip.top && r.bottom <= clip.bottom
      && s.visibility === 'visible' && s.display !== 'none' && +s.opacity > 0,
    hit: hit === e || e.contains(hit), disabled: !!e.disabled, value: e.value, min: +e.min, max: +e.max, step: +e.step,
    text: e.textContent?.trim(), checked: e.checked, active: e.classList.contains('on') || e.classList.contains('active'),
    css: { color: s.color, background: s.backgroundColor, cursor: s.cursor, fontSize: s.fontSize },
    label: lr && { x: lr.x + lr.width / 2, y: lr.y + lr.height / 2, text: label.textContent },
    displayed: row?.querySelector('.value')?.textContent,
    options: e.options && [...e.options].map(o => ({ value: o.value, label: o.label, disabled: o.disabled })),
  };
}
export async function reveal(t, selector, text) {
  // WebKitGTK can ignore a wheel over a visible scrollbar: when the list
  // did not move after the last wheel, aim at its left edge instead.
  // Some lists (Preferences) never move under WebDriver's wheel at all: after
  // a few stuck wheels, Tab to a focusable control so the browser scrolls it
  // into view.
  let lastTop, stuck = 0, tabbed = false;
  return until(async () => {
    const c = await t.driver.observe(inspect, selector, text);
    if (!c) throw Error(`Control is not mounted: ${selector}${text == null ? '' : ` "${text}"`}`);
    if (c.visible && c.hit) return c;
    // a handle on a graph's edge overhangs it sideways and no scrolling can
    // help: its center taking the hit while vertically inside is enough.
    // a pixel of slack: a crop handle at the photo's top edge can sit a
    // fraction of a pixel above the canvas at some window sizes
    if (c.hit && !c.scrollX && c.bounds.y >= c.clip.top - 1 && c.bounds.y + c.bounds.height <= c.clip.bottom + 1
        && c.x >= c.clip.left && c.x <= c.clip.right) return c;
    if (stuck >= 4 && !tabbed && text == null && await t.driver.observe(s => document.querySelector(s)?.tabIndex >= 0
        // in the main window Tab hides the panels; only a dialog keeps it
        && !!document.querySelector('.modal-backdrop'), selector)) {
      tabbed = true;
      try { await tabTo(t, selector, 400); } catch {}
      throw Error(`Tabbed to ${selector}`);
    }
    if (c.scroll) {
      const delta = c.bounds.y < c.clip.top ? -180 : c.bounds.y + c.bounds.height > c.clip.bottom ? 180 : 0;
      if (delta) {
        if (lastTop === c.scroll.top) stuck++;
        lastTop = c.scroll.top;
        await t.driver.wheel(stuck % 2 ? c.scroll.left : c.scroll.x, c.scroll.y, delta);
      }
    }
    if (c.scrollX) {
      const delta = c.bounds.x < c.clip.left ? -180 : c.bounds.x + c.bounds.width > c.clip.right ? 180 : 0;
      if (delta) await t.driver.wheel(c.scrollX.x, c.scrollX.y, 0, delta);
    }
    throw Error(`Unreachable control: ${JSON.stringify(c)}`);
  }, `visible, unclipped hit target ${selector}`, 15000);
}
// Open a rail tool (data-tour name). Its button toggles: clicking an open
// tool closes it, so click only when it is not on.
export async function openTool(t, name) {
  const b = await reveal(t, `button[data-tour="${name}"]`);
  if (!b.active) await click(t, `button[data-tour="${name}"]`);
  await until(async () => (await t.driver.observe(inspect, `button[data-tour="${name}"]`))?.active, `${name} tool open`);
}
// Move keyboard focus to a control with Tab; the browser scrolls a focused
// control into view, for a list the wheel does not scroll under WebDriver.
export async function tabTo(t, selector, max = 200) {
  for (let i = 0; i < max; i++) {
    if (await t.driver.observe(s => { const e = document.querySelector(s); return !!e && document.activeElement === e; }, selector)) return;
    await t.driver.keys('\uE004');
  }
  throw Error(`Tab did not reach ${selector}`);
}
export async function click(t, selector) {
  const c = await reveal(t, selector);
  assert(!c.disabled, `${selector} must be enabled`);
  await t.driver.point(c.x, c.y);
  return c;
}
export const rangeSelector = id => `[data-control-id=${JSON.stringify(id)}] input[type=range]`;
