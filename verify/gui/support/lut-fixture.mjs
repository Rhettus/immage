// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// The LUT 3D card's file list is only enabled once the photo has a LUT, and
// the file dialog that chooses the first one is outside the GUI suite's
// boundary. This makes the LUT folder (two cubes in a sub folder: one that
// inverts the colors, one that halves them) and has a separate headless engine,
// in its own folders, record a copy of the photo's sidecar that already uses the
// first, as the dialog's pick would. The app then opens the photo with it.

const cube = f => ['LUT_3D_SIZE 2', ...[0, 1].flatMap(b => [0, 1].flatMap(g => [0, 1].map(r => f(r, g, b).join(' '))))].join('\n') + '\n';

export async function prepareLutFixture({ engine, work, folder, photo }) {
  await mkdir(join(folder, 'film'), { recursive: true });
  await mkdir(work, { recursive: true });
  await writeFile(join(folder, 'film', 'invert.cube'), cube((r, g, b) => [1 - r, 1 - g, 1 - b]));
  await writeFile(join(folder, 'film', 'dim.cube'), cube((r, g, b) => [r / 2, g / 2, b / 2]));
  const child = spawn(engine, ['--core', '--configdir', join(work, 'config'), '--cachedir', join(work, 'cache'),
    '--conf', 'opencl=false', '--conf', 'resourcelevel=0'],
  { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, XDG_DATA_HOME: join(work, 'data') } });
  let buf = ''; const waiting = [];
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if ('tag' in r) continue;
      waiting.shift()?.(r);
    }
  });
  child.on('exit', () => { for (const w of waiting.splice(0)) w({ ok: false, error: 'engine exited' }); });
  const call = (req, ms = 120000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`timeout: ${req.cmd}`)), ms);
    waiting.push(r => { clearTimeout(timer); r.ok === false ? reject(Error(`${req.cmd}: ${r.error}`)) : resolve(r); });
    child.stdin.write(JSON.stringify(req) + '\n');
  });
  try {
    await call({ cmd: 'open', path: photo });
    const picked = await call({ cmd: 'lut_files', folder, pick: join(folder, 'film', 'invert.cube') });
    await call({ cmd: 'set', op: 'lut3d', priority: 0, params: { lut_file: picked.current_hash }, enabled: true });
    await call({ cmd: 'save' });
    return { folder, files: picked.files.map(f => f.path), chosen: picked.current };
  } finally {
    try { child.stdin.end(); } catch { /* already gone */ }
    setTimeout(() => child.kill(), 3000).unref();
  }
}
