// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { click, inspect } from '../support/controls.mjs';
import { textButton, Blocked } from '../support/scenario.mjs';
import { until } from '../support/webdriver.mjs';
import { settledPhoto } from './smoke.mjs';
import { validateBenchmark } from '../support/benchmark.mjs';

function environment() {
  return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
    hidden: document.hidden };
}

async function tabTo(t, selector) {
  // Real keyboard focus scrolls controls into view. Do not inject focus() or
  // scrollIntoView(), and do not depend on repeated synthetic wheel events.
  for (let n = 0; n < 100; n++) {
    if (await t.driver.observe(s => document.activeElement === document.querySelector(s), selector)) return;
    await t.driver.keys('\uE004');
  }
  throw Error(`Keyboard navigation did not reach ${selector}`);
}

// Start the app's existing scripted benchmark through its real button. This
// measures that workload, not WebDriver pointer input or input-to-photon time.
export async function guiBenchmark(t, screenDrafts = null) {
  const baseline = await settledPhoto(t);
  const before = await t.driver.observe(environment);
  assert(!before.hidden, 'benchmark app must be visible');
  await click(t, 'button[data-tour="prefs"]');
  await textButton(t, '.prefs-tabs', 'Performance');
  if (screenDrafts !== null) {
    const selector = `[data-pref-label="Drag drafts at the screen's scale"] input[type=checkbox]`;
    const toggle = await t.driver.observe(inspect, selector);
    if (!toggle) throw new Blocked('Requires a preconfigured fractional-scale output with screen scale below webview DPR');
    if (toggle.checked !== screenDrafts) {
      await tabTo(t, selector);
      await t.driver.keys(' ');
    }
    await until(async () => (await t.driver.observe(inspect, selector))?.checked === screenDrafts, 'draft scale setting');
  }
  const run = '[data-pref-label="GUI benchmark"] button';
  await tabTo(t, run);
  const target = await t.driver.observe(inspect, run);
  assert(target?.visible && target.hit && !target.disabled, 'focused Run button must be visible and enabled');
  await t.evidence('benchmark-settings');
  await t.driver.keys('\uE007');
  // Poll only read-only DOM observations. Error status aborts immediately;
  // until() retries thrown errors, so return the error text and assert outside.
  const status = await until(() => t.driver.observe(() => {
    const text = document.querySelector('.status')?.textContent ?? '';
    return /^benchmark(?: saved:|:)/.test(text) ? text : null;
  }), 'GUI benchmark report or error', 10 * 60 * 1000);
  assert(status.startsWith('benchmark saved: '), status);
  const after = await t.driver.observe(environment);
  const filename = status.slice('benchmark saved: '.length).split(/[\\/]/).pop();
  const { file, report } = await t.benchmarkReport(filename);
  // Keep the raw artifact even if validation rejects this measurement.
  validateBenchmark(report, before, after, screenDrafts);
  const restored = await settledPhoto(t, p => p.hash === baseline.hash);
  assert.equal(restored.width, baseline.width, 'benchmark restores fit frame width');
  assert.equal(restored.height, baseline.height, 'benchmark restores fit frame height');
  t.measure({ name: 'gui-benchmark', file, before, after, frames: report.samples.length,
    viewport: report.viewport, configuration: report.configuration, webview: report.webview,
    limitation: 'Approximate workload timings on this machine; VM results do not predict native GPU performance. Animation callbacks do not measure compositor presentation.' });
  await t.evidence('benchmark-restored');
}
