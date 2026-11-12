// SPDX-License-Identifier: GPL-3.0-or-later
// Advanced mode phase 3, headless: the engine's module schema, instance
// addressing (priority), sidecar round trip, module reset and render parity
// with darktable-cli, shown for op `exposure` on a copied photo. Talks to
// build/bin/darktable-engine directly in the app's JSON-lines protocol.
// Skips when the engine is not built or memory is short; the parity part
// also skips when darktable-cli or ImageMagick's `compare` is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ENGINE = process.env.IMMAGE_ENGINE || join(ROOT, 'build/bin/darktable-engine');
const CLI = join(ROOT, 'build/bin/darktable-cli');
const SAMPLE = join(ROOT, 'app/sample/stairs-to-mountain.jpg');

function memoryProblem() {
  try {
    const info = {};
    for (const l of readFileSync('/proc/meminfo', 'utf8').split('\n')) {
      const m = l.match(/^(\w+):\s+(\d+)/); if (m) info[m[1]] = +m[2];
    }
    const gib = info.MemAvailable / 1048576;
    const swap = info.SwapTotal ? 100 * (info.SwapTotal - info.SwapFree) / info.SwapTotal : 0;
    return gib >= 4 && swap <= 50 ? null : `MemAvailable ${gib.toFixed(1)} GiB, swap ${swap.toFixed(0)}%`;
  } catch { return 'cannot read /proc/meminfo'; }
}
const skip = !existsSync(ENGINE) ? `engine not built (${ENGINE})`
  : !existsSync(SAMPLE) ? 'sample photo missing' : memoryProblem();

// the engine child: one JSON line per request, replies in order
class Engine {
  constructor(work) {
    const args = ['--core', '--configdir', join(work, 'config'), '--cachedir', join(work, 'cache'),
      '--conf', 'opencl=false', '--conf', 'resourcelevel=0'];
    this.child = spawn(ENGINE, args, { stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, XDG_DATA_HOME: join(work, 'data') } });
    this.buf = ''; this.waiting = []; this.closed = false;
    this.child.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        const r = JSON.parse(line);
        if ('tag' in r) continue;
        this.waiting.shift()?.(r);
      }
    });
    this.child.on('exit', () => { this.closed = true; for (const w of this.waiting) w({ ok: false, error: 'engine exited' }); });
  }
  call(req, ms = 120000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout: ${JSON.stringify(req).slice(0, 200)}`)), ms);
      this.waiting.push((r) => { clearTimeout(t); r.ok === false ? reject(new Error(`${req.cmd}: ${r.error}`)) : resolve(r); });
      this.child.stdin.write(JSON.stringify(req) + '\n');
    });
  }
  stop() { try { this.child.stdin.end(); } catch {} setTimeout(() => this.child.kill(), 3000).unref(); }
}

const FIELDS = ['mode', 'black', 'exposure', 'compensate_exposure_bias', 'deflicker_percentile', 'deflicker_target_level'];
const EDIT = { exposure: 1.0, black: 0.01, compensate_exposure_bias: 0 };

test('Advanced mode modules (exposure)', { skip: skip || false }, async (t) => {
  const work = mkdtempSync(join(tmpdir(), 'immage-advmod-'));
  const photo = join(work, 'photos', 'stairs.jpg');
  mkdirSync(join(work, 'photos'));
  copyFileSync(SAMPLE, photo);   // the original and its sidecar are never touched
  const e = new Engine(work);
  t.after(() => { e.stop(); if (process.env.KEEP) console.log(work); else rmSync(work, { recursive: true, force: true }); });
  const read = async (key) => (await e.call({ cmd: 'get', modules: { [key]: FIELDS } })).modules[key];

  const opened = await e.call({ cmd: 'open', path: photo });
  const imgid = opened.imgid;

  await t.test('module_schema lists exposure fields with ranges and defaults', async () => {
    const s = await e.call({ cmd: 'module_schema', op: 'exposure' });
    assert.equal(s.op, 'exposure');
    const by = Object.fromEntries(s.fields.map((f) => [f.path, f]));
    for (const f of FIELDS) assert.ok(by[f], `field ${f} missing; got ${Object.keys(by)}`);
    for (const f of ['black', 'exposure', 'deflicker_percentile', 'deflicker_target_level']) {
      for (const k of ['min', 'max', 'default']) assert.equal(typeof by[f][k], 'number', `${f}.${k}`);
    }
    assert.equal(by.exposure.min, -18); assert.equal(by.exposure.max, 18);
    assert.equal(by.black.min, -1); assert.equal(by.black.max, 1);
    assert.equal(by.deflicker_percentile.min, 0); assert.equal(by.deflicker_percentile.max, 100);
    assert.equal(by.deflicker_percentile.default, 50);
    assert.equal(by.mode.type, 'enum');
    assert.deepEqual(by.mode.values.map((v) => v.value), [0, 1]);
    assert.equal(by.compensate_exposure_bias.default, 0);
  });

  await t.test('instances holds exposure at priority 0', async () => {
    const { instances } = await e.call({ cmd: 'instances' });
    assert.ok(instances.some((i) => i.op === 'exposure' && i.priority === 0), 'no exposure priority 0');
  });

  await t.test('set by priority, get exposure@0 reads it back', async () => {
    await e.call({ cmd: 'set', op: 'exposure', priority: 0, params: EDIT, enabled: true });
    const m = await read('exposure@0');
    assert.equal(m.enabled, true);
    for (const [k, v] of Object.entries(EDIT)) assert.ok(Math.abs(m.params[k] - v) < 1e-6, `${k} ${m.params[k]} != ${v}`);
  });

  await t.test('save, close, reopen: the sidecar gives the same values', async () => {
    await e.call({ cmd: 'save' });
    assert.ok(existsSync(photo + '.xmp'), 'no sidecar written next to the copy');
    await e.call({ cmd: 'close' });
    await e.call({ cmd: 'open', path: photo });
    const m = await read('exposure@0');
    assert.equal(m.enabled, true);
    for (const [k, v] of Object.entries(EDIT)) assert.ok(Math.abs(m.params[k] - v) < 1e-6, `${k} ${m.params[k]} != ${v}`);
  });

  await t.test('engine export equals darktable-cli with the saved XMP', async (t2) => {
    if (!existsSync(CLI)) return t2.skip(`darktable-cli not built (${CLI})`);
    if (spawnSync('compare', ['-version']).status !== 0) return t2.skip('ImageMagick compare not installed');
    const outA = join(work, 'engine.png'), outB = join(work, 'cli.png');
    const id = (await e.call({ cmd: 'open', path: photo })).imgid ?? imgid;
    await e.call({ cmd: 'export', imgid: id, out: outA, format: 'png', bpp: 8, color_space: 'srgb', long_edge: 600 });
    const cfg = join(work, 'cli-config');
    const r = spawnSync(CLI, [photo, photo + '.xmp', outB, '--width', '600', '--height', '600', '--hq', 'true',
      '--core', '--configdir', cfg, '--cachedir', join(work, 'cli-cache'), '--library', ':memory:',
      '--conf', 'opencl=false', '--conf', 'plugins/lighttable/export/force_lcms2=false'],
    { env: { ...process.env, XDG_DATA_HOME: join(work, 'cli-data') }, encoding: 'utf8', timeout: 180000 });
    assert.ok(existsSync(outB), `darktable-cli wrote nothing (status ${r.status}): ${(r.stderr || '').slice(-500)}`);
    // compare prints "<absolute> (<normalized 0..1>)" on stderr; 8-bit steps are 1/255 = 0.0039
    const c = spawnSync('compare', ['-metric', 'MAE', outA, outB, 'null:'], { encoding: 'utf8' });
    const m = /\(([0-9.e+-]+)\)/.exec(c.stderr);
    assert.ok(m, `compare gave: ${c.stderr}`);
    const mean = +m[1];
    // threshold 0.5/255 mean: both paths run the same history at the same size (hq on, as the engine
    // exports), so the result is expected identical; allow rounding only. a missing +1 EV edit or a
    // lost black offset would be tens of levels (hq off resamples differently: 4.5 levels, so it is not used)
    assert.ok(mean < 0.5 / 255, `mean absolute difference ${mean} (${(mean * 255).toFixed(3)} levels of 255)`);
    t2.diagnostic(`mean abs diff ${(mean * 255).toFixed(4)} / 255`);
  });

  await t.test('module_state reset on exposure@0 returns the defaults', async () => {
    const defaults = (await read('exposure@0')).defaults;
    const r = await e.call({ cmd: 'module_state', op: 'exposure', priority: 0, reset: true });
    assert.ok(r.was && r.now, 'reply lacks was/now');
    const m = await read('exposure@0');
    for (const f of FIELDS) assert.ok(Math.abs(m.params[f] - defaults[f]) < 1e-6, `${f} ${m.params[f]} != default ${defaults[f]}`);
    assert.notEqual(r.was.params, r.now.params, 'reset changed nothing');
    assert.equal(m.params.exposure, 0);
  });
});
