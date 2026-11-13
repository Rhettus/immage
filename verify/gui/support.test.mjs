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
    if (path === '/actions' && method === 'POST') state.input.push(body);
    if (path === '/actions' && method === 'DELETE') state.releases = (state.releases ?? 0) + 1;
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
test('external pages never receive keyboard or wheel input', async () => {
  const { driver, state } = fixture(); state.url = 'https://example.com';
  await assert.rejects(driver.keys('a', '\uE007'), /App-only boundary/);
  await assert.rejects(driver.wheel(10, 10, 180), /App-only boundary/);
  assert.equal(state.input.length, 0);
});
test('a changed window rejects keyboard and wheel input', async () => {
  const { driver, state } = fixture(); await driver.guard(); state.handle = 'other';
  await assert.rejects(driver.keys('\uE014'), /main window changed/);
  await assert.rejects(driver.wheel(10, 10, -180), /main window changed/);
  assert.equal(state.input.length, 0);
});

test('modified selection clicks stay inside the original app and release modifiers', async () => {
  const { driver, state } = fixture();
  await driver.modifiedPoint('\uE009',10,10);
  assert.equal(state.input.length,1);
  assert.equal(state.releases,1);
  const keyboard=state.input[0].actions.find(a=>a.type==='key').actions;
  const pointer=state.input[0].actions.find(a=>a.type==='pointer').actions;
  assert(keyboard.findIndex(a=>a.type==='keyUp')>pointer.findIndex(a=>a.type==='pointerUp'),'modifier is held through the click event');
  state.url='https://example.com';
  await assert.rejects(driver.modifiedPoint('\uE009',10,10),/App-only boundary/);
  assert.equal(state.input.length,1);
  await assert.rejects(driver.modifiedPoint('x',10,10),/Unsupported/);
});

test('Space-drag holds Space through the drag and stays inside the original app', async () => {
  const { driver, state } = fixture();
  await driver.spaceDrag({ x: 10, y: 10 }, { x: 60, y: 40 });
  assert.equal(state.releases, 1);
  const seq = state.input.at(-1);
  const keyboard = seq.actions.find(a => a.type === 'key').actions, pointer = seq.actions.find(a => a.type === 'pointer').actions;
  assert.equal(keyboard[0].value, '\uE00D');
  assert.equal(keyboard.findIndex(a => a.type === 'keyDown'), 0);
  assert(keyboard.findIndex(a => a.type === 'keyUp') > pointer.findIndex(a => a.type === 'pointerUp'), 'Space is held through the release');
  assert.equal(keyboard.length, pointer.length + 1, 'key and pointer ticks line up');
  state.url = 'https://example.com'; const before = state.input.length;
  await assert.rejects(driver.spaceDrag({ x: 1, y: 1 }, { x: 5, y: 5 }), /App-only boundary/);
  assert.equal(state.input.length, before);
});
