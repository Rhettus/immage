// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { inspect, reveal, click } from './controls.mjs';
import { until, pause } from './webdriver.mjs';
export class Blocked extends Error { constructor(message) { super(message); this.name = 'Blocked'; } }
export async function requireElement(t, selector, reason = selector) {
  if (!await t.driver.observe(s => !!document.querySelector(s), selector)) throw new Blocked(`Missing prerequisite: ${reason}`);
}
export async function textButton(t, scope, text) {
  // Resolve by readonly text observation at interaction time; no DOM mutations.
  // reveal scrolls a button below or above its list into view first.
  const b = await reveal(t, `${scope} button`, text);
  await until(async () => !(await t.driver.observe(inspect, `${scope} button`, text))?.disabled, `enabled button ${scope}/${text}`);
  await t.driver.point(b.x, b.y);
}
// `appears`: an option that opens something (Enter Custom…) rather than
// staying selected; wait for that element instead of the value
export async function choose(t, selector, value, appears) {
  const c = await reveal(t, selector);
  if (c.disabled) throw new Blocked(`Disabled prerequisite ${selector}`);
  const index = c.options?.findIndex(o => o.value === String(value));
  assert(index >= 0 && !c.options[index].disabled, `${selector} has enabled option ${value}`);
  // GTK's popup can step over a disabled option (a separator) differently
  // from its index: when the menu lands elsewhere, correct the count by
  // where it landed and choose again
  let steps = index, error;
  for (let attempt = 0; attempt < 3; attempt++) {
    const at = (await t.driver.observe(inspect, selector)).value;
    await t.driver.point(c.x, c.y);
    await t.driver.keys('\uE011', ...Array(Math.max(0, steps)).fill('\uE015'), '\uE007');
    try {
      if (appears) await until(() => t.driver.observe(s => !!document.querySelector(s), appears), `${value} opens ${appears}`, 3000);
      else await until(async () => (await t.driver.observe(inspect, selector))?.value === String(value), `selected ${value}`, 3000);
      return;
    } catch (e) {
      error = e;
      const landed = (await t.driver.observe(inspect, selector)).value;
      // an option that opens something leaves the value as it was: no move
      // seen means one step short of the last option was the closest guess
      const li = c.options.findIndex(o => o.value === landed);
      steps += landed === at && appears ? 1 : index - li;
      t.measure({ name: 'choose-retry', selector, value, landed, steps });
    }
  }
  throw error;
}
export async function panel(t, id) {
  const selector = `[data-panel-id=${JSON.stringify(id)}]`;
  await requireElement(t, selector, `panel ${id}, fixture/module/treatment`);
  if (!await t.driver.observe(s => document.querySelector(`${s} > .panel-title`)?.classList.contains('open'), selector))
    await click(t, `${selector} > .panel-title`);
  await until(() => t.driver.observe(s => !!document.querySelector(`${s} > .collapse.open`), selector), `${id} open`);
  // the open class comes before the layout settles: panels slide open and
  // (in focus mode) others slide shut over 0.22 s (.collapse in styles.css).
  // a control measured mid-slide is clicked where it no longer is
  await until(() => t.driver.observe(() => !document.getAnimations().some(a =>
    a.playState === 'running' && a.effect?.target?.closest?.('.collapse'))), `${id} settled`);
  return selector;
}
// open a guided step (GuidedSteps.tsx) of a panel by its id, through a real
// click on its heading, unless it is already open; a locked step cannot open
export async function openStep(t, scope, id) {
  const step = `${scope} .step[data-step=${JSON.stringify(id)}]`;
  const isOpen = () => t.driver.observe(s => document.querySelector(s)?.classList.contains('open'), step);
  // a step shutting above slides the headings below it (.collapse): a click
  // measured mid-slide lands on another step's heading, so let it settle
  // and click again while this one is still shut
  for (let attempt = 0; attempt < 3 && !await isOpen(); attempt++) {
    await until(() => t.driver.observe(() => !document.getAnimations().some(a =>
      a.playState === 'running' && a.effect?.target?.closest?.('.collapse'))), `${id} steps settled`);
    await click(t, `${step} > .step-head`);
    try { await until(isOpen, `${id} step open`, 3000); } catch (e) { if (attempt === 2) throw e; }
  }
}
export async function expandSections(t, selector) {
  for (let pass = 0; pass < 100; pass++) {
    const target = await t.driver.observe(s => {
      for (const e of document.querySelectorAll(`${s} section[data-section-id] > h3.fold`))
        if (e.querySelector('.chevron:not(.open)')) return `${s} section[data-section-id=${JSON.stringify(e.parentElement.dataset.sectionId)}] > h3.fold`;
      return null;
    }, selector);
    if (!target) return settledHeight(t, selector);
    // a fold opened a moment ago is still animating its height, moving the
    // folds below it: aim only once the target has stopped moving
    // a heading can unmount meanwhile (the panel rerendered): look again
    let last = null;
    const settled = await until(async () => {
      const y = await t.driver.observe(s => document.querySelector(s)?.getBoundingClientRect().top ?? null, target);
      if (y === null) return 'gone';
      const still = last !== null && Math.abs(y - last) < 0.5;
      last = y; return still && 'still';
    }, 'section heading settled');
    if (settled === 'gone') continue;
    await click(t, target);
    await until(() => t.driver.observe(s => {
      const e = document.querySelector(s); return e?.getAttribute('aria-expanded') === 'true' || !!e?.querySelector('.chevron.open');
    }, target), 'section expanded');
  }
  throw Error('Section expansion exceeded limit');
}
// wait for an element to stop moving: two looks 0.5 px apart
async function still(t, selector) {
  let last = null;
  await until(async () => {
    const y = await t.driver.observe(s => document.querySelector(s)?.getBoundingClientRect().top ?? null, selector);
    const same = y !== null && last !== null && Math.abs(y - last) < 0.5;
    last = y; if (!same) await pause(150); return same;
  }, `${selector} still`);
}
// the last fold opened animates its height and moves every control below it:
// wait for the panel's content to stop growing before aiming at one
async function settledHeight(t, selector) {
  let last = null;
  await until(async () => {
    const h = await t.driver.observe(s => document.querySelector(s)?.scrollHeight ?? 0, selector);
    const still = last !== null && h === last; last = h; return still;
  }, 'panel height settled');
}

// Open a mask adjustment group (Tone, Presence, ...) if it is closed. Its
// heading toggles, so clicking an already open group would close it.
export async function openMaskGroup(t, title) {
  const heading = `[data-mask-group=${JSON.stringify(title)}]`;
  await requireElement(t, heading, `${title} mask group`);
  // a new mask folds its settings card as it opens, moving the groups up:
  // a click aimed before that lands on a mask control and changes it. aim
  // only once the heading has stopped moving, and click again while it
  // stays closed, never while it is open
  const open = () => t.driver.observe(s => !!document.querySelector(`${s} .chevron.open`), heading);
  await until(async () => {
    if (await open()) return true;
    await still(t, heading);
    await click(t, heading);
    await pause(1000);
    return open();
  }, `${title} group open`);
}
