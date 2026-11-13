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
  async move(x, y) {
    await this.guard();
    this.log({ action: 'move', x, y });
    await this.command('POST', '/actions', { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
      actions: [{ type: 'pointerMove', duration: 120, origin: 'viewport', x: Math.round(x), y: Math.round(y) }] }] });
  }
  async modifiedPoint(modifier, x, y) {
    if (!['\uE008', '\uE009', '\uE03D'].includes(modifier)) throw Error('Unsupported pointer modifier');
    await this.guard();
    this.log({ action: 'modified-click', modifier, x, y });
    try {
      await this.command('POST', '/actions', { actions: [
        { type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: modifier },
          { type: 'pause', duration: 200 }, { type: 'pause', duration: 0 }, { type: 'keyUp', value: modifier }] },
        { type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [
          { type: 'pointerMove', duration: 120, origin: 'viewport', x: Math.round(x), y: Math.round(y) },
          { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] },
      ] });
    } finally { await this.command('DELETE', '/actions'); }
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
  // a drag left held at `to`, for reading the frames shown mid-drag;
  // release() lets go. both act only through this session's pointer source
  async hold(from, to) {
    await this.guard();
    this.log({ action: 'hold', from, to });
    const actions = [
      { type: 'pointerMove', duration: 120, origin: 'viewport', x: Math.round(from.x), y: Math.round(from.y) },
      { type: 'pointerDown', button: 0 },
      ...Array.from({ length: 8 }, (_, i) => ({ type: 'pointerMove', duration: 80, origin: 'viewport',
        x: Math.round(from.x + (to.x - from.x) * (i + 1) / 8), y: Math.round(from.y + (to.y - from.y) * (i + 1) / 8) })),
    ];
    await this.command('POST', '/actions', { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions }] });
  }
  // a drag with Space held, for panning a zoomed photo in any tool. the
  // pointer is on the viewer before the key goes down (the app pans only
  // with the pointer over the photo), and Space is let go after the pointer
  async spaceDrag(from, to) {
    await this.guard();
    this.log({ action: 'space-drag', from, to });
    const at = (p, duration) => ({ type: 'pointerMove', duration, origin: 'viewport', x: Math.round(p.x), y: Math.round(p.y) });
    const pointer = actions => ({ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions });
    try {
      await this.command('POST', '/actions', { actions: [pointer([at(from, 120)])] });
      const moves = Array.from({ length: 8 }, (_, i) => at({ x: from.x + (to.x - from.x) * (i + 1) / 8, y: from.y + (to.y - from.y) * (i + 1) / 8 }, 80));
      await this.command('POST', '/actions', { actions: [
        { type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE00D' },
          ...Array.from({ length: 10 }, () => ({ type: 'pause', duration: 0 })), { type: 'keyUp', value: '\uE00D' }] },
        pointer([at(from, 0), { type: 'pointerDown', button: 0 }, ...moves, { type: 'pointerUp', button: 0 }]),
      ] });
    } finally { await this.command('DELETE', '/actions'); }
  }
  async release() {
    this.log({ action: 'release' });
    try {
      await this.command('POST', '/actions', { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
        actions: [{ type: 'pointerUp', button: 0 }] }] });
    } finally { await this.command('DELETE', '/actions'); }
  }
  async screenshot(path) {
    await this.guard();
    const png = await this.command('GET', '/screenshot');
    await writeFile(path, Buffer.from(png, 'base64'));
  }
  async keys(...keys) {
    await this.guard();
    this.log({ action: 'keys', keys });
    await this.command('POST', '/actions', { actions: [{ type: 'key', id: 'keyboard',
      actions: keys.flatMap(value => [{ type: 'keyDown', value }, { type: 'keyUp', value }]) }] });
  }
  async chord(modifier, key) {
    await this.guard(); this.log({ action: 'chord', modifier, key });
    await this.command('POST', '/actions', { actions: [{ type: 'key', id: 'keyboard', actions: [
      { type: 'keyDown', value: modifier }, { type: 'keyDown', value: key },
      { type: 'keyUp', value: key }, { type: 'keyUp', value: modifier },
    ] }] });
  }
  async wheel(x, y, deltaY, deltaX = 0) {
    await this.guard();
    this.log({ action: 'wheel', x, y, deltaY, deltaX });
    // WebKitWebDriver keeps a wheel source's scrolled amount between action
    // sequences, so a second equal scroll moved nothing (lists stuck at 180).
    // A new source per gesture, released afterwards, starts from zero.
    const id = `wheel-${this.wheels = (this.wheels ?? 0) + 1}`;
    try {
      await this.command('POST', '/actions', { actions: [{ type: 'wheel', id, actions: [
        { type: 'scroll', origin: 'viewport', x: Math.round(x), y: Math.round(y), deltaX, deltaY, duration: 180 },
      ] }] });
    } finally { await this.command('DELETE', '/actions'); }
  }
  async close() { if (this.session) await this.command('DELETE', ''); }
}
