// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
// Read-only functions run inside the app's main webview.
export function environment() {
  return { url: location.href, title: document.title, userAgent: navigator.userAgent,
    scale: devicePixelRatio, viewport: [innerWidth, innerHeight],
    fonts: document.fonts.status, theme: document.documentElement.className,
    data: { localStorageKeys: Object.keys(localStorage) } };
}
export function button(text) {
  const e = [...document.querySelectorAll('button')].find(e => e.textContent.trim() === text);
  if (!e) return null;
  const r = e.getBoundingClientRect();
  const x = r.x + r.width / 2, y = r.y + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  return r.width && r.height && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight && (hit === e || e.contains(hit))
    ? { x, y } : null;
}
export function exposure() {
  const panel = [...document.querySelectorAll('.panel.adjust')].find(p => p.querySelector('.panel-title > span')?.textContent === 'Basic');
  const e = [...(panel?.querySelectorAll('.slider') ?? [])].find(e => e.querySelector('label')?.textContent === 'Exposure');
  const range = e?.querySelector('input[type=range]');
  if (!range) return null;
  const r = range.getBoundingClientRect(), l = e.querySelector('label').getBoundingClientRect();
  const s = getComputedStyle(range), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return { value: +range.value, min: +range.min, max: +range.max, disabled: range.disabled,
    displayed: e.querySelector('.value')?.textContent, bounds: { x: r.x, y: r.y, width: r.width, height: r.height },
    label: { x: l.x + l.width / 2, y: l.y + l.height / 2 },
    css: { display: s.display, visibility: s.visibility, opacity: s.opacity, cursor: s.cursor, accentColor: s.accentColor },
    hit: hit === range, visible: r.width > 0 && r.height > 0 && r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
}
export function photo() {
  const canvas = document.querySelector('canvas.layer.sharp');
  if (!canvas || !canvas.width || !canvas.height || canvas.classList.contains('empty')) return null;
  // Draw a read-only copy for measurement; production canvas/state is untouched.
  const copy = document.createElement('canvas'); copy.width = 64; copy.height = 64;
  const context = copy.getContext('2d'); context.drawImage(canvas, 0, 0, 64, 64);
  const rgba = context.getImageData(0, 0, 64, 64).data;
  let luma = 0, alpha = 0, hash = 2166136261;
  for (let i = 0; i < rgba.length; i += 4) {
    luma += (rgba[i] * .2126 + rgba[i + 1] * .7152 + rgba[i + 2] * .0722) * rgba[i + 3] / 255;
    alpha += rgba[i + 3];
    for (let c = 0; c < 4; c++) hash = Math.imul(hash ^ rgba[i + c], 16777619);
  }
  return { width: canvas.width, height: canvas.height, luma: luma / 4096, alpha: alpha / 4096, hash: hash >>> 0,
    quality: canvas.dataset.renderQuality ?? 'unknown',
    working: !!document.querySelector('.working.on'),
    rgba: Array.from(rgba) };
}
export function panelTitle() {
  const e = [...document.querySelectorAll('.panel.adjust .panel-title')].find(e => e.querySelector('span')?.textContent === 'Basic');
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return { open: e.classList.contains('open'), x: r.x + r.width / 2, y: r.y + r.height / 2 };
}
