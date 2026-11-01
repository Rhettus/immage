// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import { writeFile } from 'node:fs/promises';

export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(fn, label, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  do {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await pause(200);
  } while (Date.now() < end);
  throw Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

// Only checked-in observation functions are executed. There is deliberately no
// evaluate/script option in configuration or command-line arguments.
export class AppDriver {
  constructor(url, log) { this.url = url; this.log = log; }
  async request(method, path, body) {
    const response = await fetch(this.url + path, {
      method, headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(path === '/session' ? 90000 : 15000),
    });
    const result = await response.json();
    if (!response.ok || result.value?.error) throw Error(`${method} ${path}: ${JSON.stringify(result.value)}`);
    return result.value;
  }
  command(method, path, body) { return this.request(method, `/session/${this.session}${path}`, body); }
  async open(binary, fixture) {
    const result = await this.request('POST', '/session', { capabilities: {
      alwaysMatch: { 'tauri:options': { application: binary, args: [fixture] } },
    } });
    this.session = result.sessionId;
    this.capabilities = result.capabilities;
  }
  // No navigation, window switching, clipboard or OS-input endpoints are exposed.
  async observe(fn, ...args) {
    return this.command('POST', '/execute/sync', { script: `return (${fn.toString()})(...arguments);`, args });
  }
  async guard() {
    const handle = await this.command('GET', '/window');
    if (this.mainHandle && handle !== this.mainHandle) throw Error('App-only boundary: main window changed');
    const identity = await this.observe(() => ({ url: location.href, viewer: !!document.querySelector('main.viewer') }));
    const u = new URL(identity.url);
    if (!['tauri:', 'http:', 'https:'].includes(u.protocol)
        || !['localhost', 'tauri.localhost'].includes(u.hostname) || !identity.viewer)
      throw Error(`App-only boundary: unexpected main webview ${identity.url}`);
    if (this.mainUrl && identity.url !== this.mainUrl) throw Error('App-only boundary: main URL changed');
    this.mainHandle = handle; this.mainUrl = identity.url;
    return identity;
  }
  async point(x, y, clicks = 1) {
    await this.guard();
    this.log({ action: clicks === 2 ? 'double-click' : 'click', x, y });
    const actions = [{ type: 'pointerMove', duration: 120, origin: 'viewport', x: Math.round(x), y: Math.round(y) }];
    for (let i = 0; i < clicks; i++) {
      actions.push({ type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 });
      if (i + 1 < clicks) actions.push({ type: 'pause', duration: 80 });
    }
    await this.command('POST', '/actions', { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions }] });
  }
  async drag(from, to) {
    await this.guard();
    this.log({ action: 'drag', from, to });
    const actions = [
      { type: 'pointerMove', duration: 120, origin: 'viewport', x: Math.round(from.x), y: Math.round(from.y) },
      { type: 'pointerDown', button: 0 },
      ...Array.from({ length: 8 }, (_, i) => ({ type: 'pointerMove', duration: 80, origin: 'viewport',
        x: Math.round(from.x + (to.x - from.x) * (i + 1) / 8), y: Math.round(from.y + (to.y - from.y) * (i + 1) / 8) })),
      { type: 'pointerUp', button: 0 },
    ];
    await this.command('POST', '/actions', { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions }] });
  }
  async screenshot(path) {
    await this.guard();
    const png = await this.command('GET', '/screenshot');
    await writeFile(path, Buffer.from(png, 'base64'));
  }
  async close() { if (this.session) await this.command('DELETE', ''); }
}
