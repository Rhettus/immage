// SPDX-License-Identifier: GPL-3.0-or-later
// Screenshots must not show file paths. The photo info over the canvas shows
// the photo's folder, so it is cycled off with I (real keyboard input) before
// a screenshot; a shot that would still show a home or temporary directory is
// withheld rather than saved.
import { pause } from './webdriver.mjs';

export const visiblePath = () => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!/(^|\s)(\/home\/|\/tmp\/|\/Users\/|[A-Z]:\\)/.test(n.textContent)) continue;
    const r = n.parentElement?.getBoundingClientRect();
    const st = n.parentElement && getComputedStyle(n.parentElement);
    if (r && r.width && r.height && st.visibility !== 'hidden' && st.display !== 'none' && +st.opacity > 0) return n.textContent.trim().slice(0, 80);
  }
  return null;
};

const infoShown = () => !!document.querySelector('.info-overlay');
// I would be typed into a focused field instead of toggling the info.
const typing = () => { const e = document.activeElement;
  return !!e && (/^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName) && e.type !== 'range' || e.isContentEditable); };

export async function hideInfo(driver) {
  for (let i = 0; i < 3 && await driver.observe(infoShown); i++) {
    if (await driver.observe(typing)) return false;
    await driver.keys('i');
    await pause(300);
  }
  return !await driver.observe(infoShown);
}

// Returns null when the screen is clear to capture, else why it is not.
export async function pathFree(driver) {
  await hideInfo(driver);
  const path = await driver.observe(visiblePath);
  return path && `a file path is visible (${path})`;
}
