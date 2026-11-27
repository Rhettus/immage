// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { click } from '../support/controls.mjs';
import { until } from '../support/webdriver.mjs';

const field = label => `.prefs input[aria-label=${JSON.stringify(label)}]`;
const testButton = '.prefs [data-pref-label="Connection"] button:first-child';

async function typeInto(t, label, value) {
  const selector = field(label);
  await click(t, selector);
  await t.driver.guard();
  const found = await t.driver.command('POST', '/element', { using: 'css selector', value: selector });
  await t.driver.command('POST', `/element/${Object.values(found)[0]}/value`, { text: value });
}

export async function morfphotoPrefs(t) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url, authorized: req.headers.authorization === 'Bearer gui-fixture-key' });
    const status = requests.length === 1 && requests[0].authorized ? 200 : 503;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ page: 1, page_size: 1, total: 0, items: [] }));
  });
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    await click(t, 'button[data-tour="prefs"]');
    const tab = await until(() => t.driver.observe(() => {
      const button = [...document.querySelectorAll('.prefs-tabs button')]
        .find(node => node.textContent.trim() === 'Immage Accelerator (Experimental)');
      if (!button) return null;
      const { x, y, width, height } = button.getBoundingClientRect();
      return { x: x + width / 2, y: y + height / 2 };
    }), 'morfPhoto preferences tab');
    await t.driver.point(tab.x, tab.y);
    const disabledByDefault = await until(() => t.driver.observe((enable, test) => {
      const toggle = document.querySelector(enable);
      const button = document.querySelector(test);
      return toggle && button ? { enabled: toggle.checked, canTest: !button.disabled } : null;
    }, field('Enable Immage Accelerator'), testButton), 'morfPhoto settings loaded');
    assert.deepEqual(disabledByDefault, { enabled: false, canTest: false });

    await typeInto(t, 'Server URL', `http://127.0.0.1:${server.address().port}`);
    await typeInto(t, 'Folder on the server', '/photos');
    await typeInto(t, 'Folder on this computer', t.fixtureDir);
    await typeInto(t, 'API key', 'gui-fixture-key');
    await click(t, testButton);
    await until(() => t.driver.observe(() => document.querySelector('.prefs [role="status"]')
      ?.textContent.includes('Connected to the morfPhoto library.')), 'successful connection');
    await click(t, testButton);
    await until(() => t.driver.observe(() => document.querySelector('.prefs [role="status"]')
      ?.textContent.includes('Could not read the morfPhoto library.')), 'failed connection');
    assert.deepEqual(requests, Array.from({ length: 2 }, () => ({
      path: '/api/v1/library?page=1&page_size=1', authorized: true,
    })));
    await t.evidence('morfphoto-connection-error');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}
