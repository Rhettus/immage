// SPDX-License-Identifier: GPL-3.0-or-later
// Batch paste benchmark: ms per photo of runPaste (app/src/batchPaste.ts) on raw
// photos, for never-edited and already-edited targets, plus open_image calls per
// photo. All app code and verify/shim.mjs come from --tree, so a before/after
// comparison runs the same engine binary (this checkout's build/bin) under each
// tree's page code:
//   node benchmarking/batch-paste-bench.mjs --tree <checkout> [--photos a.CR2,b.ARW]
//        [--copies 4] [--runs 3] [--json out.json]
// Compare a worktree of the earlier code (git worktree add ../before <rev>,
// with app/node_modules linked) against this checkout's --tree. Needs the
// ignored benchmarking/corpus and this checkout's engine build.
import { createRequire, registerHooks } from 'node:module';
import { mkdtempSync, copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// this checkout: its engine build, corpus and node_modules serve every --tree
const MAIN = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const ENGINE = join(MAIN, 'build/bin/darktable-engine');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const root = resolve(arg('tree', MAIN));
const photos = arg('photos', ['IMG_2586.CR2', 'IMG_2587.CR2', 'IMG_2588.CR2', 'DSC07771.ARW']
  .map(f => join(MAIN, 'benchmarking/corpus', f)).join(',')).split(',').filter(Boolean);
const copies = +arg('copies', 4), runs = +arg('runs', 3), jsonOut = arg('json', null);

const require = createRequire(join(MAIN, 'app/package.json'));
const { transformSync } = await import(require.resolve('rolldown/experimental'));
const shim = pathToFileURL(join(root, 'verify/shim.mjs')).href;
registerHooks({
  load(url, ctx, next) {
    if (!url.startsWith('file:') || !/\.tsx?$/.test(url)) return next(url, ctx);
    const path = fileURLToPath(url);
    let source = readFileSync(path, 'utf8');
    if (path === join(root, 'app/src/i18n.ts')) {
      const english = readFileSync(join(root, 'app/src/locales/en.json'), 'utf8');
      source = source.replace('import.meta.glob<Dict>("./locales/*.json", { eager: true, import: "default" })',
        `{ "./locales/en.json": ${english} }`);
    }
    return { format: 'module', source: transformSync(path, source, { jsx: { runtime: 'automatic' } }).code, shortCircuit: true };
  },
  resolve(spec, ctx, next) {
    if (spec.startsWith('@tauri-apps/') || spec === '@immporter/api') return next(shim, ctx);
    if (/^\.\.?\//.test(spec) && !/\.[cm]?[jt]sx?$/.test(spec))
      for (const ext of ['.ts', '.tsx']) {
        const u = new URL(spec + ext, ctx.parentURL);
        if (existsSync(fileURLToPath(u))) return next(u.href, ctx);
      }
    return next(spec, ctx);
  },
});
process.env.OMP_NUM_THREADS = '2';
globalThis.window = globalThis;
const store = new Map();
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
globalThis.addEventListener ??= () => {};
globalThis.requestAnimationFrame = f => setTimeout(() => f(performance.now()), 0);
globalThis.cancelAnimationFrame = clearTimeout;
const imp = p => import(pathToFileURL(join(root, p)).href);
const { Session } = await imp('app/src/session.ts');
const { runPaste } = await imp('app/src/batchPaste.ts');
const { preparePastePhoto } = await imp('app/src/pasteDefaults.ts');
const { startEngine, stopEngine, request, requestTagged, sent } = await imp('verify/shim.mjs');

const sha = (() => { try { return execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return '?'; } })();
console.log(`tree: ${root}\ncommit: ${sha}\nphotos: ${photos.length} x ${copies} copies, ${runs} runs\n`);

const view = () => ({ width: 64, height: 64 });
const defaults = { profile: 0, compensation: 0, auto: false, preset: null, lensMethod: undefined };
const prepare = s => preparePastePhoto(s, defaults);
const toneClip = { values: { exposure: 0.8, contrast: 14, vibrance: -12 } };
const wbClip = { values: { exposure: 0.8, temp: 5600, tint: 6, lens_profile: 1 } };
const autoClip = { values: { exposure: 0.8 }, autoWB: true };
const fullOpen = async t => { const s = await Session.open(t.path, t.imgid, view, () => {}, () => {}, true); await s.settled(); await s.close(); };
const scenarios = [
  { name: 'new', clip: { values: { exposure: 0.5, contrast: 10 } }, edited: false, decode: false, prepare },
  { name: 'edited-tone-restart', clip: toneClip, edited: true, decode: false },
  { name: 'edited-wb-decoded', clip: wbClip, edited: true, decode: true },
  { name: 'edited-wb-restart', clip: wbClip, edited: true, decode: false },
  { name: 'edited-autowb', clip: autoClip, edited: true, decode: true },
];

async function once(sc) {
  const dir = mkdtempSync(join(tmpdir(), 'immage-paste-bench-')), home = join(dir, 'runtime');
  const files = [];
  for (const p of photos) for (let c = 0; c < copies; c++) {
    const f = join(dir, `${c}_${basename(p)}`); copyFileSync(p, f); files.push(f);
  }
  const imported = async () => (await requestTagged({ cmd: 'import', files })).images.map((i, k) => ({ path: files[k], imgid: i.imgid }));
  const opens = []; let result;
  try {
    startEngine(ENGINE, home, null);
    let targets = await imported();
    if (sc.edited) {
      for (const t of targets) {
        const s = await Session.open(t.path, t.imgid, view, () => {}, () => {}, true);
        await s.settled(); s.endBaseline(); s.setMany([['exposure', 0.3], ['shadows', 11]]); await s.close();
      }
      await stopEngine();
      startEngine(ENGINE, home, null);
      targets = await imported();
      if (sc.decode) for (const t of targets) await fullOpen(t);
    }
    sent.hook = (cmd) => { if (process.env.BENCH_TRACE) process.stderr.write(`> ${cmd}\n`); if (cmd === 'open_image') opens.push(cmd); };
    const t0 = performance.now();
    const r = await runPaste(targets, sc.clip, () => {}, () => {}, sc.prepare);
    const ms = performance.now() - t0;
    sent.hook = null;
    result = { ms, perPhoto: ms / targets.length, opens: opens.length / targets.length, error: r?.error ?? null };
    try { if (r?.token != null) await request({ cmd: 'paste_batch', action: 'release', token: r.token }); } catch {}
  } catch (e) {
    result = { error: String(e?.stack ?? e) };
  } finally { sent.hook = null; await stopEngine(); rmSync(dir, { recursive: true, force: true }); }
  return result;
}

const med = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const report = [];
for (const sc of scenarios) {
  const res = [];
  for (let r = 0; r < runs; r++) {
    const x = await once(sc); res.push(x);
    process.stderr.write(`${sc.name} run ${r + 1}: ${x.error ? 'ERROR ' + String(x.error).split('\n')[0] : x.perPhoto.toFixed(0) + ' ms/photo'}\n`);
  }
  report.push({ scenario: sc.name, photos: photos.length * copies, runs: res });
}
const f = n => n.toFixed(0);
console.log('| scenario | photos | median ms/photo | min | max | opens/photo |\n|---|---|---|---|---|---|');
for (const r of report) {
  const ok = r.runs.filter(x => !x.error), errs = r.runs.filter(x => x.error);
  const v = ok.map(x => x.perPhoto);
  const cells = ok.length ? `${f(med(v))} | ${f(Math.min(...v))} | ${f(Math.max(...v))} | ${med(ok.map(x => x.opens)).toFixed(2)}` : '- | - | - | -';
  console.log(`| ${r.scenario} | ${r.photos} | ${cells} |`);
  for (const e of errs) console.log(`  error in ${r.scenario}: ${String(e.error).split('\n')[0]}`);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ tree: root, commit: sha, photos, copies, report }, null, 2));
process.exit(0);
