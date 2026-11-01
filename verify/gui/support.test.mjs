// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
// Boundary checks supplement, and do not substitute for, visible-app tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppDriver } from './support/webdriver.mjs';
function fixture() {
  const state = { handle: 'main', url: 'tauri://localhost', viewer: true, input: [] };
  const driver = new AppDriver('', () => {});
  driver.command = async (method, path, body) => {
    if (path === '/window') return state.handle;
    if (path === '/execute/sync') return { url: state.url, viewer: state.viewer };
    if (path === '/actions') state.input.push(body);
  };
  return { driver, state };
}
test('external pages never receive pointer actions', async () => {
  const { driver, state } = fixture(); state.url = 'https://example.com';
  await assert.rejects(driver.point(10, 10), /App-only boundary/);
  assert.equal(state.input.length, 0);
});
test('a changed window never receives pointer actions', async () => {
  const { driver, state } = fixture(); await driver.guard(); state.handle = 'other';
  await assert.rejects(driver.drag({ x: 1, y: 1 }, { x: 10, y: 10 }), /main window changed/);
  assert.equal(state.input.length, 0);
});
test('a localhost page without the app is rejected', async () => {
  const { driver, state } = fixture(); state.viewer = false;
  await assert.rejects(driver.point(10, 10), /App-only boundary/);
  assert.equal(state.input.length, 0);
});
test('navigation within localhost is rejected after binding to the app URL', async () => {
  const { driver, state } = fixture(); await driver.guard(); state.url += '/other';
  await assert.rejects(driver.point(10, 10), /main URL changed/);
  assert.equal(state.input.length, 0);
});
