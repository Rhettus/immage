// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { until } from './webdriver.mjs';

// Read only. No scrollIntoView: scrolling must go through real wheel input.
export function inspect(selector) {
  const e = document.querySelector(selector);
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
    if (!scroll && /(auto|scroll)/.test(ps.overflowY) && p.scrollHeight > p.clientHeight)
      scroll = { x: pr.right - 6, y: Math.max(1, Math.min(innerHeight - 1, pr.top + pr.height / 2)), top: p.scrollTop };
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
export async function reveal(t, selector) {
  return until(async () => {
    const c = await t.driver.observe(inspect, selector);
    if (!c) throw Error(`Control is not mounted: ${selector}`);
    if (c.visible && c.hit) return c;
    if (c.scroll) {
      const delta = c.bounds.y < c.clip.top ? -180 : c.bounds.y + c.bounds.height > c.clip.bottom ? 180 : 0;
      if (delta) await t.driver.wheel(c.scroll.x, c.scroll.y, delta);
    }
    if (c.scrollX) {
      const delta = c.bounds.x < c.clip.left ? -180 : c.bounds.x + c.bounds.width > c.clip.right ? 180 : 0;
      if (delta) await t.driver.wheel(c.scrollX.x, c.scrollX.y, 0, delta);
    }
    throw Error(`Unreachable control: ${JSON.stringify(c)}`);
  }, `visible, unclipped hit target ${selector}`, 15000);
}
export async function click(t, selector) {
  const c = await reveal(t, selector);
  assert(!c.disabled, `${selector} must be enabled`);
  await t.driver.point(c.x, c.y);
  return c;
}
export const rangeSelector = id => `[data-control-id=${JSON.stringify(id)}] input[type=range]`;
