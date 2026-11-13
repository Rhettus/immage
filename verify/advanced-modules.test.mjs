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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

// the app's own imports leave out the .ts the bundler adds
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('./') && ctx.parentURL?.endsWith('.ts')) {
      const url = new URL(spec + '.ts', ctx.parentURL);
      if (existsSync(url)) return next(url.href, ctx);
    }
    return next(spec, ctx);
  },
});

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

// the engine's export of the open photo against darktable-cli rendering the
// same saved XMP. threshold 0.5/255 mean: both run the same history at the
// same size (hq on, as the engine exports), so they are expected identical
// but for rounding; a lost edit is tens of levels (hq off resamples
// differently: 4.5 levels, so it is not used)
async function cliParity(t2, e, work, photo, imgid, tag = 'p') {
  if (!existsSync(CLI)) return t2.skip(`darktable-cli not built (${CLI})`);
  if (spawnSync('compare', ['-version']).status !== 0) return t2.skip('ImageMagick compare not installed');
  const outA = join(work, `${tag}-engine.png`), outB = join(work, `${tag}-cli.png`);
  // every card's module is on by the end of the layout test, so this export
  // is slow, the more so on a loaded machine
  await e.call({ cmd: 'export', imgid, out: outA, format: 'png', bpp: 8, color_space: 'srgb', long_edge: 600 }, 600000);
  const r = spawnSync(CLI, [photo, photo + '.xmp', outB, '--width', '600', '--height', '600', '--hq', 'true',
    '--core', '--configdir', join(work, `${tag}-cli-config`), '--cachedir', join(work, `${tag}-cli-cache`), '--library', ':memory:',
    '--conf', 'opencl=false', '--conf', 'plugins/lighttable/export/force_lcms2=false'],
  { env: { ...process.env, XDG_DATA_HOME: join(work, `${tag}-cli-data`) }, encoding: 'utf8', timeout: 600000 });
  assert.ok(existsSync(outB), `darktable-cli wrote nothing (status ${r.status}): ${(r.stderr || '').slice(-500)}`);
  // compare prints "<absolute> (<normalized 0..1>)" on stderr; 8-bit steps are 1/255 = 0.0039
  const c = spawnSync('compare', ['-metric', 'MAE', outA, outB, 'null:'], { encoding: 'utf8' });
  const m = /\(([0-9.e+-]+)\)/.exec(c.stderr);
  assert.ok(m, `compare gave: ${c.stderr}`);
  const mean = +m[1];
  assert.ok(mean < 0.5 / 255, `mean absolute difference ${mean} (${(mean * 255).toFixed(3)} levels of 255)`);
  t2.diagnostic(`mean abs diff ${(mean * 255).toFixed(4)} / 255`);
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

  await t.test('instances: in_history after an edit, switchable false where darktable hides the switch', async () => {
    const { instances } = await e.call({ cmd: 'instances' });
    const by = (op) => instances.find((i) => i.op === op && i.priority === 0);
    assert.equal(by('exposure').in_history, true, 'the edited exposure is not in the history');
    assert.equal(by('bilat').in_history, false, 'an untouched module is in the history');
    // demosaic cannot apply to a JPEG: Add module greys it out
    assert.equal(by('demosaic').switchable, false);
    assert.equal(by('bilat').switchable, true);
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
    const id = (await e.call({ cmd: 'open', path: photo })).imgid ?? imgid;
    await cliParity(t2, e, work, photo, id);
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

// every module Advanced mode can show as a card (the plan's inventory: the
// introspected, non-deprecated, visible modules not on a tool of their own).
// liquify is listed apart: it has no introspected params, so its card is a
// placeholder and its schema is `fields: []` by design. `colorreconstruct`
// is the op name of the inventory's colorreconstruction.c
const CARD_OPS = `temperature channelmixerrgb exposure highlights agx sigmoid filmicrgb basecurve
  contrastntexture bilat hazeremoval diffuse colorbalancergb tonecurve rgbcurve rgblevels toneequal shadhi
  colorequal satcurvergb velvia colorcontrast colorzones colorharmonizer primaries colorcorrection
  colorchecker lut3d colormapping monochrome colorbalance splittoning colorize demosaic sharpen highpass
  denoiseprofile nlmeans rawdenoise bilateral atrous lowpass lens cacorrectrgb cacorrect hotpixels ashift
  flip scalepixels enlargecanvas vignette grain bloom soften blurs lowlight graduatednd censorize borders
  watermark overlay dither rawprepare colorreconstruct colorin colorout profile_gamma rasterfile`.split(/\s+/);

// darktable's own declarations that break the min <= default <= max rule, so a
// card must not clamp them: borders' aspect declares $MIN 1 $MAX 3 but
// defaults to -1 (DT_IOP_BORDERS_ASPECT_CONSTANT_VALUE, "constant")
const UPSTREAM_DEFAULT_OUTSIDE = new Set(['borders:aspect']);

test('Advanced mode schema sweep over the card modules', { skip: skip || false }, async (t) => {
  const work = mkdtempSync(join(tmpdir(), 'immage-advsweep-'));
  mkdirSync(join(work, 'photos'));
  const photo = join(work, 'photos', 'stairs.jpg');
  copyFileSync(SAMPLE, photo);
  const e = new Engine(work);
  t.after(() => { e.stop(); rmSync(work, { recursive: true, force: true }); });
  await e.call({ cmd: 'open', path: photo });

  const failures = [];
  const problems = (s, op) => {
    const bad = [];
    if (s.op !== op) bad.push(`op ${s.op}`);
    if (!(s.version > 0)) bad.push(`version ${s.version}`);
    if (!s.fields?.length) bad.push('no fields');
    if (s.flags?.deprecated) bad.push('deprecated');
    for (const f of s.fields ?? []) {
      if (f.type === 'enum' && !f.values?.length) bad.push(`${f.path}: enum without values`);
      if (f.type === 'float' || f.type === 'int') {
        // a null bound is the type's own limit and cannot be compared
        const { min, max, default: d } = f;
        if (typeof d !== 'number') bad.push(`${f.path}: default ${d}`);
        else if (UPSTREAM_DEFAULT_OUTSIDE.has(`${op}:${f.path}`)) { /* see above */ }
        else if ((typeof min === 'number' && d < min - 1e-6) || (typeof max === 'number' && d > max + 1e-6)) {
          bad.push(`${f.path}: default ${d} outside [${min}, ${max}]`);
        }
        if (typeof min === 'number' && typeof max === 'number' && min > max) bad.push(`${f.path}: min ${min} > max ${max}`);
      }
    }
    return bad;
  };
  for (const op of CARD_OPS) {
    let s;
    try { s = await e.call({ cmd: 'module_schema', op }); } catch (err) { failures.push(`${op}: ${err.message}`); continue; }
    const bad = problems(s, op);
    if (bad.length) failures.push(`${op}: ${bad.join('; ')}`);
  }
  t.diagnostic(`${CARD_OPS.length} ops swept, ${failures.length} failing`);
  assert.deepEqual(failures, []);
});

test('instances marks a look\'s instances with owner "look"', { skip: skip || false }, async (t) => {
  const style = join(ROOT, 'darktable/data/styles');
  const names = existsSync(style) ? readdirSync(style).filter((n) => n.endsWith('.dtstyle')) : [];
  if (!names.length) return t.skip('no .dtstyle file in darktable/data/styles');
  const work = mkdtempSync(join(tmpdir(), 'immage-advlook-'));
  mkdirSync(join(work, 'photos'));
  const photo = join(work, 'photos', 'stairs.jpg');
  copyFileSync(SAMPLE, photo);
  const e = new Engine(work);
  t.after(() => { e.stop(); rmSync(work, { recursive: true, force: true }); });
  await e.call({ cmd: 'open', path: photo });
  const before = (await e.call({ cmd: 'instances' })).instances;
  assert.ok(before.every((i) => i.owner === null), 'an instance has an owner before any look');
  const look = join(style, names[0]);
  await e.call({ cmd: 'look', path: look });
  const after = (await e.call({ cmd: 'instances' })).instances;
  const owned = after.filter((i) => i.owner === 'look');
  assert.ok(owned.length > 0, `no instance owned by the look: ${JSON.stringify(after.filter((i) => i.name))}`);
  for (const i of owned) assert.ok(/^look: /.test(i.name), `owner look on '${i.name}'`);
  // the user's own instances stay theirs, whatever the look added beside them
  for (const i of before) {
    const now = after.find((a) => a.op === i.op && a.priority === i.priority && a.name === i.name);
    assert.ok(now && now.owner === null, `${i.op}@${i.priority} lost its null owner`);
  }
  await e.call({ cmd: 'look' });
  const off = (await e.call({ cmd: 'instances' })).instances;
  t.diagnostic(`${names[0]}: ${owned.map((i) => i.op).join(', ')}; ${off.filter((i) => i.owner === 'look').length} left after removing`);
});

// Simple's B&W makes color calibration's instance "bw"; the B&W group's card
// finds it by that hand-edited name, and Basic's leaves it out
test('Simple\'s named instance "bw" is listed by its name', { skip: skip || false }, async (t) => {
  const work = mkdtempSync(join(tmpdir(), 'immage-advbw-'));
  mkdirSync(join(work, 'photos'));
  const photo = join(work, 'photos', 'stairs.jpg');
  copyFileSync(SAMPLE, photo);
  const e = new Engine(work);
  t.after(() => { e.stop(); rmSync(work, { recursive: true, force: true }); });
  await e.call({ cmd: 'open', path: photo });
  await e.call({ cmd: 'set', op: 'channelmixerrgb', instance: 'bw', after: 'colorequal', enabled: true,
                 params: { 'grey[0]': 0, 'grey[1]': 1, 'grey[2]': 0 } });
  const cal = (await e.call({ cmd: 'instances' })).instances.filter((i) => i.op === 'channelmixerrgb');
  const bw = cal.filter((i) => i.hand_edited && i.name === 'bw');
  assert.equal(bw.length, 1, `channelmixerrgb instances: ${JSON.stringify(cal)}`);
  assert.equal(bw[0].owner, null, 'the bw instance is the user\'s, not a tool\'s');
  assert.ok(bw[0].priority > 0 && bw[0].enabled, `bw instance ${JSON.stringify(bw[0])}`);
  const got = (await e.call({ cmd: 'get', modules: { [`channelmixerrgb@${bw[0].priority}`]: ['grey[1]'] } })).modules;
  assert.equal(got[`channelmixerrgb@${bw[0].priority}`].params['grey[1]'], 1);
});

// Simple's "N advanced edits" badge (advancedEdits.ts): nothing at open,
// where darktable's auto-applied modules are at their defaults; then a
// second exposure and velvia count in their groups, while Simple's own
// instances (exposure 0, B&W's "bw") never do. IMMAGE_RAW adds a raw photo
// for the at-open check, whose auto-applied modules differ from a JPEG's
test('Simple counts the Advanced edits its sliders cannot show', { skip: skip || false }, async (t) => {
  const { advancedEdits } = await import('../app/src/advancedEdits.ts');
  const work = mkdtempSync(join(tmpdir(), 'immage-advcount-'));
  mkdirSync(join(work, 'photos'));
  const photos = [join(work, 'photos', 'stairs.jpg')];
  copyFileSync(SAMPLE, photos[0]);
  const raw = process.env.IMMAGE_RAW;
  if (raw) { photos.push(join(work, 'photos', 'raw' + raw.slice(raw.lastIndexOf('.')))); copyFileSync(raw, photos[1]); }
  const e = new Engine(work);
  t.after(() => { e.stop(); rmSync(work, { recursive: true, force: true }); });
  const counts = async () => Object.fromEntries(advancedEdits((await e.call({ cmd: 'instances' })).instances));
  for (const photo of photos.slice(1)) {
    await e.call({ cmd: 'open', path: photo });
    assert.deepEqual(await counts(), {}, `${photo} at open`);
    await e.call({ cmd: 'close' });
  }
  await e.call({ cmd: 'open', path: photos[0] });
  assert.deepEqual(await counts(), {}, 'at open');
  // darktable's copy of history leaves out per-camera modules
  const flags = Object.fromEntries((await e.call({ cmd: 'instances' })).instances.filter((i) => i.priority === 0)
    .map((i) => [i.op, i.copyable]));
  assert.equal(flags.temperature, false); assert.equal(flags.flip, false); assert.equal(flags.exposure, true);
  await e.call({ cmd: 'set', op: 'exposure', priority: 0, params: { exposure: 0.5 }, enabled: true });
  await e.call({ cmd: 'set', op: 'channelmixerrgb', instance: 'bw', after: 'colorequal', enabled: true,
                 params: { 'grey[0]': 0, 'grey[1]': 1, 'grey[2]': 0 } });
  assert.deepEqual(await counts(), {}, 'Simple\'s own instances');
  const p1 = (await e.call({ cmd: 'instance', action: 'new', op: 'exposure', priority: 0 })).priority;
  await e.call({ cmd: 'set', op: 'exposure', priority: p1, params: { exposure: -0.25 } });
  await e.call({ cmd: 'set', op: 'velvia', priority: 0, params: { strength: 40 }, enabled: true });
  assert.deepEqual(await counts(), { basic: 1, hsl: 1 });
  await e.call({ cmd: 'set', op: 'velvia', priority: 0, enabled: false });
  assert.deepEqual(await counts(), { basic: 1 }, 'a module switched off');
});

// Advanced mode phase 4: the instance menu's actions on exposure. A second
// and third instance, a rename, a move, a delete undone and one kept; then
// save, reopen and render parity with darktable-cli over the sidecar
test('Advanced mode instances (exposure)', { skip: skip || false }, async (t) => {
  const work = mkdtempSync(join(tmpdir(), 'immage-advinst-'));
  mkdirSync(join(work, 'photos'));
  const photo = join(work, 'photos', 'stairs.jpg');
  copyFileSync(SAMPLE, photo);
  const e = new Engine(work);
  t.after(() => { e.stop(); if (process.env.KEEP) console.log(work); else rmSync(work, { recursive: true, force: true }); });
  await e.call({ cmd: 'open', path: photo });
  const exp = (list) => list.filter((i) => i.op === 'exposure');
  const order = (list) => exp(list).map((i) => i.priority);
  const read = async (p) => (await e.call({ cmd: 'get', modules: { [`exposure@${p}`]: FIELDS } })).modules[`exposure@${p}`];

  await e.call({ cmd: 'set', op: 'exposure', priority: 0, params: { exposure: 0.5 }, enabled: true });
  const added = await e.call({ cmd: 'instance', action: 'new', op: 'exposure', priority: 0 });
  const p1 = added.priority;
  assert.ok(p1 > 0, `new instance priority ${p1}`);
  assert.deepEqual(order(added.instances), [0, p1], 'new instance not right after the first');
  const fresh = await read(p1);
  assert.equal(fresh.enabled, true, 'a new instance comes on');
  assert.ok(Math.abs(fresh.params.exposure - fresh.defaults.exposure) < 1e-6, 'new instance not at the defaults');
  // darktable's own label: a matching preset's name (an auto-applied one on
  // this JPEG), else the instance's number; never the raw '_builtin_' key
  const lab = exp(added.instances)[1].label;
  assert.ok(lab && !lab.startsWith('_builtin_'), `label '${lab}'`);

  await e.call({ cmd: 'set', op: 'exposure', priority: p1, params: { exposure: -0.25 } });
  const dup = await e.call({ cmd: 'instance', action: 'duplicate', op: 'exposure', priority: p1 });
  const p2 = dup.priority;
  assert.deepEqual(order(dup.instances), [0, p1, p2]);
  assert.ok(Math.abs((await read(p2)).params.exposure + 0.25) < 1e-6, 'duplicate lost the settings');

  const named = await e.call({ cmd: 'instance', action: 'rename', op: 'exposure', priority: p2, name: '  lift  ' });
  const i2 = exp(named.instances).find((i) => i.priority === p2);
  assert.equal(i2.name, 'lift'); assert.equal(i2.label, 'lift'); assert.equal(i2.hand_edited, true);
  await assert.rejects(e.call({ cmd: 'instance', action: 'rename', op: 'exposure', priority: p2, name: 'look: x' }),
    /keeps for masks and looks/, 'a look name was accepted');

  const moved = await e.call({ cmd: 'instance', action: 'move', op: 'exposure', priority: p2, other: p1, after: false });
  assert.deepEqual(order(moved.instances), [0, p2, p1], 'move before did not reorder');
  const back = await e.call({ cmd: 'instance', action: 'move', op: 'exposure', priority: p2, other: p1, after: true });
  assert.deepEqual(order(back.instances), [0, p1, p2], 'move after did not reorder');

  await assert.rejects(e.call({ cmd: 'instance', action: 'delete', op: 'exposure', priority: 0 }), /not deleted/);
  const del = await e.call({ cmd: 'instance', action: 'delete', op: 'exposure', priority: p1 });
  assert.deepEqual(order(del.instances), [0, p2], 'deleted instance still listed');
  assert.equal((await read(p1)).enabled, false, 'deleted instance still on');
  const undone = await e.call({ cmd: 'instance', action: 'restore', op: 'exposure', priority: p1 });
  assert.deepEqual(order(undone.instances), [0, p1, p2], 'restore did not bring it back in place');
  await e.call({ cmd: 'set', op: 'exposure', priority: p1, params: {}, enabled: true });
  // the one kept deleted: its entries must not reach the sidecar
  const p3 = (await e.call({ cmd: 'instance', action: 'new', op: 'exposure', priority: p2 })).priority;
  await e.call({ cmd: 'set', op: 'exposure', priority: p3, params: { exposure: 2 } });
  await e.call({ cmd: 'instance', action: 'delete', op: 'exposure', priority: p3 });

  await e.call({ cmd: 'save' });
  const xmp = readFileSync(photo + '.xmp', 'utf8');
  const prios = [...xmp.matchAll(/darktable:operation="exposure"[^>]*?darktable:multi_priority="(\d+)"/g)].map((m) => +m[1]);
  t.diagnostic(`sidecar exposure priorities: ${prios.join(', ')}`);
  assert.ok(!prios.includes(p3), 'the deleted instance reached the sidecar');
  await e.call({ cmd: 'close' });
  await e.call({ cmd: 'open', path: photo });
  const reopened = (await e.call({ cmd: 'instances' })).instances;
  assert.equal(exp(reopened).length, 3, `reopened with ${JSON.stringify(exp(reopened))}`);
  const r2 = exp(reopened).find((i) => i.name === 'lift');
  assert.ok(r2, 'the name did not survive reopening');
  assert.ok(Math.abs((await read(r2.priority)).params.exposure + 0.25) < 1e-6, 'renamed instance lost its value');

  await t.test('engine export equals darktable-cli with two extra instances', async (t2) => {
    if (!existsSync(CLI)) return t2.skip(`darktable-cli not built (${CLI})`);
    if (spawnSync('compare', ['-version']).status !== 0) return t2.skip('ImageMagick compare not installed');
    const outA = join(work, 'engine.png'), outB = join(work, 'cli.png');
    const id = (await e.call({ cmd: 'open', path: photo })).imgid;
    await e.call({ cmd: 'export', imgid: id, out: outA, format: 'png', bpp: 8, color_space: 'srgb', long_edge: 600 });
    spawnSync(CLI, [photo, photo + '.xmp', outB, '--width', '600', '--height', '600', '--hq', 'true',
      '--core', '--configdir', join(work, 'cli-config'), '--cachedir', join(work, 'cli-cache'), '--library', ':memory:',
      '--conf', 'opencl=false', '--conf', 'plugins/lighttable/export/force_lcms2=false'],
    { env: { ...process.env, XDG_DATA_HOME: join(work, 'cli-data') }, encoding: 'utf8', timeout: 180000 });
    assert.ok(existsSync(outB), 'darktable-cli wrote nothing');
    const c = spawnSync('compare', ['-metric', 'MAE', outA, outB, 'null:'], { encoding: 'utf8' });
    const m = /\(([0-9.e+-]+)\)/.exec(c.stderr);
    assert.ok(m, `compare gave: ${c.stderr}`);
    assert.ok(+m[1] < 0.5 / 255, `mean absolute difference ${(+m[1] * 255).toFixed(3)} levels of 255`);
  });
});

// phase 5: darktable's module presets on an exposure instance, headless
test('Advanced mode darktable presets (exposure)', { skip: skip || false }, async (t) => {
  const work = mkdtempSync(join(tmpdir(), 'immage-advpre-'));
  const photo = join(work, 'photos', 'stairs.jpg');
  mkdirSync(join(work, 'photos'));
  copyFileSync(SAMPLE, photo);
  const e = new Engine(work);
  t.after(() => { e.stop(); if (process.env.KEEP) console.log(work); else rmSync(work, { recursive: true, force: true }); });
  const read = async (key) => (await e.call({ cmd: 'get', modules: { [key]: FIELDS } })).modules[key];
  const ML = '_builtin_magic lantern defaults';   // darktable keeps the untranslated prefix on shipped names
  const state = (r) => JSON.stringify(r);
  await e.call({ cmd: 'open', path: photo });

  const listed = (await e.call({ cmd: 'presets', op: 'exposure', priority: 0 })).presets;
  const ml = listed.find((p) => p.name === ML);
  assert.ok(ml, `presets: ${JSON.stringify(listed)}`);
  assert.equal(ml.builtin, true);
  assert.equal(ml.applicable, true);
  assert.equal(typeof ml.description, 'string');
  assert.equal(listed.filter((p) => p.active).length, 0, 'no preset should match an untouched instance');
  await assert.rejects(e.call({ cmd: 'presets', op: 'exposure', priority: 9 }), /no instance/);

  // an edit, so the undo has something to bring back
  await e.call({ cmd: 'set', op: 'exposure', params: { exposure: 0.7, black: 0.02 }, enabled: true });
  const before = await read('exposure');
  assert.equal(before.params.mode, 0);

  const applied = await e.call({ cmd: 'module_state', op: 'exposure', priority: 0, preset: ML });
  const after = await read('exposure');
  assert.equal(after.params.mode, 1, 'magic lantern defaults is the deflicker mode');
  assert.notEqual(applied.was.params, applied.now.params);
  assert.equal(after.enabled, true);
  assert.equal((await e.call({ cmd: 'presets', op: 'exposure', priority: 0 })).presets.find((p) => p.name === ML).active, true,
    'the applied preset is the active one');
  assert.ok((await e.call({ cmd: 'history' })).items.some((h) => h.op === 'exposure'), 'no history item');

  // undo: restore the state the reply gave, params and blend byte for byte
  const undone = await e.call({ cmd: 'module_state', op: 'exposure', priority: 0, restore: applied.was });
  assert.equal(state(undone.now), state(applied.was), 'restore did not bring the state back');
  assert.deepEqual(await read('exposure'), before);

  // an unknown name, and a preset with another switch, change nothing
  const quiet = (await e.call({ cmd: 'module_state', op: 'exposure', priority: 0 })).now;
  await assert.rejects(e.call({ cmd: 'module_state', op: 'exposure', priority: 0, preset: 'no such preset' }), /no preset/);
  await assert.rejects(e.call({ cmd: 'module_state', op: 'exposure', priority: 0, preset: ML, reset: true }), /cannot be combined/);
  assert.equal(state((await e.call({ cmd: 'module_state', op: 'exposure', priority: 0 })).now), state(quiet));

  // a label the user typed survives a preset on a second instance
  const p1 = (await e.call({ cmd: 'instance', action: 'new', op: 'exposure', priority: 0 })).priority;
  await e.call({ cmd: 'instance', action: 'rename', op: 'exposure', priority: p1, name: 'mine' });
  await e.call({ cmd: 'module_state', op: 'exposure', priority: p1, preset: ML });
  const named = (await e.call({ cmd: 'instances' })).instances.find((i) => i.op === 'exposure' && i.priority === p1);
  assert.equal(named.name, 'mine');
  assert.equal(named.hand_edited, true);
  // the preset's params survive a save and reopen
  await e.call({ cmd: 'module_state', op: 'exposure', priority: 0, preset: ML });
  await e.call({ cmd: 'save' });
  await e.call({ cmd: 'close' });
  await e.call({ cmd: 'open', path: photo });
  assert.equal((await read('exposure')).params.mode, 1, 'the preset did not survive reopening');
  assert.equal((await read(`exposure@${p1}`)).params.mode, 1);
});

// every card layout (app/src/advancedLayout.ts) against darktable's schema:
// each path names a field (or an element inside an array), enum options
// exist, soft ranges sit within the hard ones. Then one slider per module
// moves off its default, reads back, survives save and reopen, and the
// photo with all of them renders as darktable-cli renders the same XMP
test('Advanced card layouts match darktable', { skip: skip || false }, async (t) => {
  const { LAYOUTS, INTERPOLATIONS, fieldPath, editOf } = await import('../app/src/advancedLayout.ts');
  const { MAX_NODES } = await import('../app/src/tonecurve.ts');
  const work = mkdtempSync(join(tmpdir(), 'immage-advlay-'));
  mkdirSync(join(work, 'photos'));
  const photo = join(work, 'photos', 'stairs.jpg');
  copyFileSync(SAMPLE, photo);
  const e = new Engine(work);
  t.after(() => { e.stop(); if (process.env.KEEP) console.log(work); else rmSync(work, { recursive: true, force: true }); });
  const { imgid, sensor_width: width, sensor_height: height } = await e.call({ cmd: 'open', path: photo });

  // a card's wheel edits a hue and a chroma field of the section it heads
  for (const l of LAYOUTS) for (const w of l.wheels ?? []) {
    const f = (p) => l.fields.find((x) => x.path === p);
    assert.ok(f(w.hue) && f(w.chroma), `${l.op} wheel ${w.hue}/${w.chroma} not among its fields`);
    assert.equal(f(w.hue).section, w.section); assert.equal(f(w.chroma).section, w.section);
    assert.ok(f(w.chroma).soft?.[1] > 0, `${l.op} ${w.chroma} has no soft end for the wheel's edge`);
  }

  // a card's point curve names real node, count and type fields for every
  // channel, and the interpolation menu matches darktable's curve types
  for (const l of LAYOUTS) if (l.curves) await t.test(`${l.op} curve fields`, async () => {
    const s = await e.call({ cmd: 'module_schema', op: l.op });
    const by = new Map(s.fields.map((f) => [f.path, f]));
    const base = (p) => by.get(p.replace(/\[.*$/, ''));
    l.curves.channels.forEach((_, ch) => {
      for (const p of [l.curves.count(ch), l.curves.type(ch), l.curves.node(ch, 19, 'x'), l.curves.node(ch, 19, 'y')])
        assert.ok(base(p), `${l.op}: ${p} not in the schema`);
    });
    assert.equal(base(l.curves.node(0, 0, 'x')).dims[1], MAX_NODES);
  });
  assert.deepEqual(INTERPOLATIONS.map(([, v]) => v), [0, 1, 2]);

  // a card's graph writes only fields the schema has (Simple's maps)
  for (const l of LAYOUTS) if (l.graph) await t.test(`${l.op} graph fields`, async () => {
    const { GRAPHS, graphFields } = await import('../app/src/graphMaps.ts');
    assert.equal(GRAPHS[l.graph].op, l.op);
    const s = await e.call({ cmd: 'module_schema', op: l.op });
    const names = new Set(s.fields.map((f) => f.path));
    for (const f of graphFields(l.graph)) assert.ok(names.has(f), `${l.op}: ${f} not in the schema`);
  });

  const edits = [];
  for (const l of LAYOUTS) {
    await t.test(`${l.op} (${l.group}) layout`, async () => {
      const s = await e.call({ cmd: 'module_schema', op: l.op });
      const by = new Map(s.fields.map((f) => [f.path, f]));
      const resolve = (path) => {
        const f = by.get(path) ?? by.get(fieldPath(path));
        if (!f) return null;
        if (f.path === path) return f;
        const k = +/\[(\d+)\]$/.exec(path)[1];
        assert.equal(f.type, 'array', `${path}: ${f.path} is not an array`);
        assert.ok(k < f.dims[0], `${path}: index past ${f.dims[0]}`);
        return { ...f, type: f.element, default: f.defaults?.[k] };
      };
      const seen = new Set();
      for (const lf of l.fields) {
        assert.ok(!seen.has(lf.path) || lf.showIf, `${lf.path} listed twice without a showIf`);
        seen.add(lf.path);
        // a profile menu is the engine's own field, and its choices the
        // profiles the photo can use, the current one among them
        if (lf.profiles) {
          assert.ok(lf.label && ['input', 'working'].includes(lf.profiles), `${lf.path}: profiles ${lf.profiles}`);
          const list = (await e.call({ cmd: 'color_profiles' }))[lf.profiles];
          const now = (await e.call({ cmd: 'get', modules: { [`${l.op}@0`]: [lf.path] } })).modules[`${l.op}@0`].params[lf.path];
          assert.ok(list.length && list.some(([, v]) => v === now), `${lf.path}: ${now} not among ${JSON.stringify(list)}`);
          continue;
        }
        // white balance's temperature, tint, settings and finetune are the engine's own, not in the schema
        if (l.op === 'temperature' && ['temp_k', 'tint', 'wb_setting', 'wb_tune'].includes(lf.path)) {
          assert.ok(lf.label, `${lf.path}: no label`);
          const now = (await e.call({ cmd: 'get', modules: { 'temperature@0': [lf.path] } })).modules['temperature@0'].params[lf.path];
          assert.ok(Number.isFinite(now), `${lf.path}: reads ${now}`);
          continue;
        }
        const f = resolve(lf.path);
        assert.ok(f, `${l.op}: no field ${lf.path}; schema has ${[...by.keys()]}`);
        assert.ok(lf.label, `${lf.path}: no label`);
        // a hand-filled combobox over an int, or names for an enum's values
        if (lf.choices && f.type === 'enum') assert.ok(lf.choices.every(([n, v]) => n && f.values.some((x) => x.value === v)),
          `${lf.path}: choices not in the enum`);
        else if (lf.choices) assert.ok(f.type === 'int' && lf.choices.every(([n, v]) => n && Number.isInteger(v)
          && (typeof f.min !== 'number' || v >= f.min) && (typeof f.max !== 'number' || v <= f.max)), `${lf.path}: choices on ${f.type}`);
        if (lf.options) {
          assert.equal(f.type, 'enum', `${lf.path}: options on a ${f.type}`);
          for (const v of lf.options) assert.ok(f.values.some((x) => x.value === v), `${lf.path}: option ${v} not in the enum`);
        }
        if (lf.soft) {
          assert.ok(lf.soft[0] < lf.soft[1], `${lf.path}: soft ${lf.soft}`);
          if (typeof f.min === 'number') assert.ok(lf.soft[0] >= f.min - 1e-6, `${lf.path}: soft ${lf.soft} under min ${f.min}`);
          if (typeof f.max === 'number') assert.ok(lf.soft[1] <= f.max + 1e-6, `${lf.path}: soft ${lf.soft} over max ${f.max}`);
        }
        assert.ok(['float', 'int', 'enum', 'bool', 'uint', 'short', 'ushort', 'char', 'uchar'].includes(f.type),
          `${lf.path}: a card cannot draw type ${f.type}`);
      }
      // fields a card edit also sets (layout.touch) are the module's own
      for (const [path, v] of l.touch?.set ?? []) {
        const f = resolve(path);
        assert.ok(f && Number.isFinite(v), `${l.op}: touch sets ${path}, not in the schema`);
      }
      for (const path of l.touch?.except ?? []) assert.ok(seen.has(path), `${l.op}: touch except ${path} not on the card`);
      for (const b of l.turns ?? []) assert.ok(b.label && ['ccw', 'cw', 'h', 'v'].includes(b.how), `${l.op}: turn ${JSON.stringify(b)}`);
      // the module's first float slider shown at its defaults, a quarter of
      // the way into its soft range
      const paths = l.fields.map((lf) => lf.path);
      const cur = (await e.call({ cmd: 'get', modules: { [`${l.op}@0`]: paths } })).modules[`${l.op}@0`];
      const lf = l.fields.find((x) => !x.profiles && resolve(x.path)?.type === 'float' && (!x.showIf || x.showIf(cur.defaults)));
      if (!lf) return;
      const f = resolve(lf.path);
      const [lo, hi] = lf.soft ?? [f.min, f.max];
      let v = cur.defaults[lf.path] + (hi - lo) / 4;
      if (v > hi) v = cur.defaults[lf.path] - (hi - lo) / 4;
      // as the card sends it, with what its edits also set and recompute
      const sent = editOf(l, lf.path, v, cur.params, { width, height });
      for (const [p, x] of Object.entries(sent)) assert.ok(resolve(p) && Number.isFinite(x), `${l.op}: an edit sends ${p} = ${x}`);
      await e.call({ cmd: 'set', op: l.op, priority: 0, params: sent, enabled: true });
      const back = (await e.call({ cmd: 'get', modules: { [`${l.op}@0`]: [lf.path] } })).modules[`${l.op}@0`];
      assert.ok(back.enabled, `${l.op} not on after a set`);
      assert.ok(Math.abs(back.params[lf.path] - v) < 1e-4, `${lf.path}: ${back.params[lf.path]} != ${v}`);
      edits.push({ op: l.op, path: lf.path, v });
    });
  }

  await t.test('save and reopen keep every edit', async () => {
    await e.call({ cmd: 'save' });
    await e.call({ cmd: 'close' });
    await e.call({ cmd: 'open', path: photo });
    for (const { op, path, v } of edits) {
      const m = (await e.call({ cmd: 'get', modules: { [`${op}@0`]: [path] } })).modules[`${op}@0`];
      assert.ok(m.enabled && Math.abs(m.params[path] - v) < 1e-4, `${op}.${path} after reopen: ${JSON.stringify(m)}`);
    }
  });

  await t.test('the edited photo renders as darktable-cli', async (t2) => {
    await cliParity(t2, e, work, photo, imgid, 'layouts');
  });
});

// the point curve editor on the rgb curve card: its edit (ModuleCurves) is
// a node count and every node's x and y, written as one set
test('Advanced rgb curve editor writes its nodes', { skip: skip || false }, async (t) => {
  const { LAYOUTS } = await import('../app/src/advancedLayout.ts');
  const c = LAYOUTS.find((l) => l.op === 'rgbcurve').curves;
  const work = mkdtempSync(join(tmpdir(), 'immage-advcurve-'));
  mkdirSync(join(work, 'photos'));
  const photo = join(work, 'photos', 'stairs.jpg');
  copyFileSync(SAMPLE, photo);
  const e = new Engine(work);
  t.after(() => { e.stop(); rmSync(work, { recursive: true, force: true }); });
  const { imgid } = await e.call({ cmd: 'open', path: photo });
  const shot = async (name) => {
    const out = join(work, name);
    await e.call({ cmd: 'export', imgid, out, format: 'png', bpp: 8, color_space: 'srgb', long_edge: 300 }, 600000);
    return readFileSync(out);
  };
  const pts = [[0, 0], [0.25, 0.15], [0.75, 0.85], [1, 1]];
  const edit = { [c.count(0)]: pts.length };
  pts.forEach(([x, y], k) => { edit[c.node(0, k, 'x')] = x; edit[c.node(0, k, 'y')] = y; });
  const keys = Object.keys(edit);
  const before = await shot('before.png');
  await e.call({ cmd: 'set', op: 'rgbcurve', priority: 0, params: edit, enabled: true });
  const got = (await e.call({ cmd: 'get', modules: { 'rgbcurve@0': keys } })).modules['rgbcurve@0'];
  for (const k of keys) assert.ok(Math.abs(got.params[k] - edit[k]) < 1e-6, `${k}: ${got.params[k]} != ${edit[k]}`);
  assert.equal(got.enabled, true);
  // the interpolation menu writes every channel's type
  const types = Object.fromEntries(c.channels.map((_, i) => [c.type(i), 1]));
  await e.call({ cmd: 'set', op: 'rgbcurve', priority: 0, params: types });
  const t2 = (await e.call({ cmd: 'get', modules: { 'rgbcurve@0': Object.keys(types) } })).modules['rgbcurve@0'];
  for (const k of Object.keys(types)) assert.equal(t2.params[k], 1, k);
  assert.ok(!before.equals(await shot('after.png')), 'the S curve did not change the render');
});

// the contrast equalizer and saturation curve cards (ModuleGraph) write
// through Simple's maps: band heights, and a node count with every slot
test('Advanced graph cards write through the manifest maps', { skip: skip || false }, async (t) => {
  const { equalizerMap, satcurveMap } = await import('../app/src/manifest.ts');
  const ctx = { sensorWidth: 1, sensorHeight: 1, orientation: 0, camera: 0 };
  const work = mkdtempSync(join(tmpdir(), 'immage-advgraph-'));
  mkdirSync(join(work, 'photos'));
  const photo = join(work, 'photos', 'stairs.jpg');
  copyFileSync(SAMPLE, photo);
  const e = new Engine(work);
  t.after(() => { e.stop(); rmSync(work, { recursive: true, force: true }); });
  const { imgid } = await e.call({ cmd: 'open', path: photo });
  const shot = async (name) => {
    const out = join(work, name);
    await e.call({ cmd: 'export', imgid, out, format: 'png', bpp: 8, color_space: 'srgb', long_edge: 300 }, 600000);
    return readFileSync(out);
  };
  const before = await shot('before.png');
  // one luminance band raised
  const eq = equalizerMap.write({ ce_0_2: 0.9 }, {}, ctx);
  const eqKeys = Object.keys(eq);
  await e.call({ cmd: 'set', op: 'atrous', priority: 0, params: eq, enabled: true });
  const g1 = (await e.call({ cmd: 'get', modules: { 'atrous@0': eqKeys } })).modules['atrous@0'];
  for (const k of eqKeys) assert.ok(Math.abs(g1.params[k] - eq[k]) < 1e-6, `${k}: ${g1.params[k]} != ${eq[k]}`);
  assert.ok(!before.equals(await shot('eq.png')), 'the raised band did not change the render');
  // a three point saturation curve
  const sat = satcurveMap.write({ sc_pn: 3, sc_p0x: 0, sc_p0y: 0.5, sc_p1x: 0.4, sc_p1y: 0.8, sc_p2x: 1, sc_p2y: 0.5,
                                 sb_pn: 2, sb_p0x: 0, sb_p0y: 0.5, sb_p1x: 1, sb_p1y: 0.5 }, {}, ctx);
  const satKeys = Object.keys(sat);
  await e.call({ cmd: 'set', op: 'satcurvergb', priority: 0, params: sat, enabled: true });
  const g2 = (await e.call({ cmd: 'get', modules: { 'satcurvergb@0': satKeys } })).modules['satcurvergb@0'];
  assert.equal(g2.params['channel[0].curve_num_nodes'], 3);
  for (const k of satKeys) assert.ok(Math.abs(g2.params[k] - sat[k]) < 1e-6, `${k}: ${g2.params[k]} != ${sat[k]}`);
  for (let k = 3; k < 20; k++) {
    assert.equal(g2.params[`channel[0].curve[${k}].x`], 0, `slot ${k} x`);
    assert.equal(g2.params[`channel[0].curve[${k}].y`], 0, `slot ${k} y`);
  }
  assert.ok(!before.equals(await shot('sat.png')), 'the saturation curve did not change the render');
});

// the lens card's picker writes lens_pick to its own instance: Simple's
// field, read and written per instance by the engine. the sample JPEG may
// name no camera the Lensfun database lists lenses for; the test then skips
test('Advanced lens card picks a lens for its own instance', { skip: skip || false }, async (t) => {
  const work = mkdtempSync(join(tmpdir(), 'immage-advlens-'));
  mkdirSync(join(work, 'photos'));
  const photo = join(work, 'photos', 'stairs.jpg');
  copyFileSync(SAMPLE, photo);
  const e = new Engine(work);
  t.after(() => { e.stop(); rmSync(work, { recursive: true, force: true }); });
  await e.call({ cmd: 'open', path: photo });
  const menu = await e.call({ cmd: 'lenses' });
  if (!menu.lenses.length) { t.skip('no Lensfun lenses for this photo'); return; }
  const second = (await e.call({ cmd: 'instance', action: 'new', op: 'lens', priority: 0 })).priority;
  const want = menu.lenses[0].hash;
  const read = async (p) => (await e.call({ cmd: 'get', modules: { [`lens@${p}`]: ['lens_pick', 'method', 'has_been_set'] } })).modules[`lens@${p}`];
  assert.equal((await read(second)).params.lens_pick, 0);
  await e.call({ cmd: 'set', op: 'lens', priority: second, params: { lens_pick: want, has_been_set: 1 }, enabled: true });
  const g = await read(second);
  assert.equal(g.params.lens_pick, want, 'the second instance holds the pick');
  assert.equal(g.params.method, 1, 'a pick is Lensfun');
  assert.equal(g.params.has_been_set, 1);
  assert.equal((await read(0)).params.lens_pick, 0, 'the first instance is unaffected');
  await e.call({ cmd: 'set', op: 'lens', priority: second, params: { lens_pick: 0 }, enabled: true });
  assert.equal((await read(second)).params.lens_pick, 0, 'Auto again');
});

// white balance's temperature and tint are the engine's own fields (wb.c,
// ported from temperature.c): computed from red, green and blue, and written
// back to them. the sample JPEG uses darktable's sRGB matrices, a raw its own
const wbPhotos = [['the sample JPEG', SAMPLE]];
if (process.env.IMMAGE_RAW) wbPhotos.push(['IMMAGE_RAW', process.env.IMMAGE_RAW]);
for (const [what, source] of wbPhotos) {
  test(`Advanced white balance temperature and tint (${what})`, { skip: skip || false }, async (t) => {
    const work = mkdtempSync(join(tmpdir(), 'immage-advwb-'));
    mkdirSync(join(work, 'photos'));
    const photo = join(work, 'photos', `wb${source.slice(source.lastIndexOf('.'))}`);
    copyFileSync(source, photo);
    const e = new Engine(work);
    t.after(() => { e.stop(); rmSync(work, { recursive: true, force: true }); });
    await e.call({ cmd: 'open', path: photo });
    const read = async () => (await e.call({ cmd: 'get', modules: { 'temperature@0': ['temp_k', 'tint', 'red', 'green', 'blue'] } })).modules['temperature@0'].params;
    const write = (params) => e.call({ cmd: 'set', op: 'temperature', priority: 0, params, enabled: true });
    const first = await read();
    assert.ok(first.temp_k >= 1901 && first.temp_k <= 25000, `temp_k ${first.temp_k}`);
    assert.ok(first.tint >= 0.135 && first.tint <= 2.326, `tint ${first.tint}`);

    await write({ temp_k: 4500 });
    const a = await read();
    assert.ok(a.red !== first.red || a.blue !== first.blue, 'red and blue change');
    assert.ok(a.red !== a.blue);
    assert.equal(a.green, 1, 'green is the reference');
    assert.ok(Math.abs(a.temp_k - 4500) <= 2, `temp_k reads back ${a.temp_k}`);
    assert.ok(Math.abs(a.tint - first.tint) <= 0.002, `tint stays ${first.tint} -> ${a.tint}`);

    await write({ tint: 1.1 });
    const b = await read();
    assert.ok(Math.abs(b.tint - 1.1) <= 0.002, `tint reads back ${b.tint}`);
    assert.ok(Math.abs(b.temp_k - a.temp_k) <= 2, `temp_k stays ${a.temp_k} -> ${b.temp_k}`);

    await write({ red: b.red * 1.3 });
    assert.notEqual((await read()).temp_k, b.temp_k, 'a coefficient edit moves the temperature');

    // the settings menu (temperature.c's presets combobox): wb_setting is its
    // index, wb_tune the finetune; a coefficient edit is "user modified"
    const get = async (...f) => (await e.call({ cmd: 'get', modules: { 'temperature@0': f } })).modules['temperature@0'].params;
    const { presets } = await e.call({ cmd: 'wb_presets' });
    assert.equal((await get('wb_setting')).wb_setting, 2, 'the red edit is user modified');
    assert.equal((await get('wb_tune')).wb_tune, 0);
    await assert.rejects(write({ wb_tune: 1 }), /not a camera preset/);
    await assert.rejects(write({ wb_setting: 5 }), /unknown white balance setting/);
    await assert.rejects(write({ wb_setting: 1 }), /unknown white balance setting/);
    if (what === 'the sample JPEG') {
      assert.deepEqual(presets, [], 'a JPEG has no camera presets');
      await write({ wb_setting: 3 });
      // sRGB has no separate reference, so the as shot match wins as in gui_update
      assert.equal((await get('wb_setting')).wb_setting, 0, 'as shot and camera reference are the same');
      return;
    }
    const same = (x, y) => ['red', 'green', 'blue'].every((c) => Math.abs(x[c] - y[c]) < 1e-5);
    const coeffs = ['red', 'green', 'blue', 'wb_setting'];
    await write({ wb_setting: 0 });
    const shot = await get(...coeffs);
    assert.equal(shot.wb_setting, 0, 'as shot');
    await write({ wb_setting: 3 });
    const ref = await get(...coeffs);
    assert.equal(ref.wb_setting, 3, 'camera reference');
    assert.ok(!same(ref, shot), 'camera reference differs from as shot');
    await write({ wb_setting: 4 });
    const late = await get(...coeffs);
    assert.equal(late.wb_setting, 4, 'as shot to reference');
    assert.ok(same(late, shot), 'as shot to reference starts from the as shot coefficients');
    await write({ wb_setting: 0 });
    await write({ red: shot.red * 1.2 });
    assert.equal((await get('wb_setting')).wb_setting, 2, 'an edit is user modified');
    await write({ wb_setting: 2 });
    assert.equal((await get('wb_setting')).wb_setting, 2, 'user modified keeps the coefficients');

    if (!presets.length) return;
    assert.ok(presets.every((p, k) => p.value === 6 + k && p.name), 'preset values follow the section header');
    const top = presets[0];
    await write({ wb_setting: top.value });
    const p0 = await get(...coeffs);
    assert.equal(p0.wb_setting, top.value, `${top.name} reads back`);
    const ranged = presets.find((p) => p.tune_min < p.tune_max);
    if (!ranged) return;
    assert.ok(ranged.tune_min <= 0 && ranged.tune_max >= 0);
    await write({ wb_setting: ranged.value });
    const base = await get(...coeffs, 'wb_tune');
    assert.equal(base.wb_setting, ranged.value);
    assert.equal(base.wb_tune, 0);
    // every tuning, exact variants and any interpolated across gaps, reads back
    const seen = new Set();
    for (let tune = ranged.tune_min; tune <= ranged.tune_max; tune++) {
      await write({ wb_tune: tune });
      const g = await get(...coeffs, 'wb_tune');
      assert.equal(g.wb_setting, ranged.value, `${ranged.name} stays chosen at ${tune}`);
      assert.equal(g.wb_tune, tune, `finetune ${tune} reads back`);
      seen.add(`${g.red.toFixed(5)} ${g.blue.toFixed(5)}`);
    }
    assert.ok(seen.size > 1, 'finetuning changes the coefficients');
    await write({ wb_tune: ranged.tune_max + 50 });
    assert.equal((await get('wb_tune')).wb_tune, ranged.tune_max, 'finetune clamps to the preset range');
    await write({ wb_tune: 0 });
    const back = await get(...coeffs);
    assert.ok(same(back, base), 'finetune 0 is the preset again');
  });
}
