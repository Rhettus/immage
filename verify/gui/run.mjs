#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { readFile, writeFile, mkdir, copyFile, stat, access, realpath, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppDriver, until } from './support/webdriver.mjs';
import { resolveCases, suites, cases } from './suites.mjs';
import { availableMemory } from './support/memory.mjs';
import { Journal } from './support/journal.mjs';
import { sampleProcesses } from './support/process-memory.mjs';
import { implementationFor } from './registry.mjs';
import { benchmarkFilename, parseViewport } from './support/benchmark.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let gitError;
const git = (...args) => {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); }
  catch (e) { gitError = e; return 'unknown'; }
};
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node verify/gui/run.mjs --config verify/gui/local.json [--suite smoke|regressions|controls|crop|workflows|inventory|all | --case NAME[,NAME...]] [--fixture NAME] [--viewport WIDTHxHEIGHT] [--list]');
  process.exit(0);
}
if (args.includes('--list')) {
  console.log(JSON.stringify({ suites, cases: Object.keys(cases) }, null, 2));
  process.exit(0);
}
let configFile = 'verify/gui/local.json', selected = 'smoke', fixtureName = 'configured', expectedViewport = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--config' && args[i + 1]) configFile = args[++i];
  else if (args[i] === '--fixture' && args[i + 1]) fixtureName = args[++i];
  else if (args[i] === '--viewport' && args[i + 1]) expectedViewport = parseViewport(args[++i]);
  else if (['--suite', '--case'].includes(args[i]) && args[i + 1]) selected = args[++i];
  else throw Error(`Unknown argument: ${args[i]}`);
}
const selectedCases = resolveCases(selected);
if (!['configured','landscape','portrait','endpoints','negative','camera-a','camera-b','camera-missing'].includes(fixtureName)) throw Error('Unknown synthetic fixture');
const id = `${new Date().toISOString().replaceAll(':', '-')}_${git('rev-parse', '--short', 'HEAD')}_${randomUUID().slice(0, 8)}`;
const out = join(root, 'verify/results/gui', id);
await mkdir(out, { recursive: true });
const report = { id, runnerPid: process.pid, status: 'blocked', started: new Date().toISOString(), checkout: root,
  commit: git('rev-parse', 'HEAD'), dirty: !!git('status', '--porcelain'),
  host: hostname(), platform: process.platform, arch: process.arch,
  display: { wayland: process.env.WAYLAND_DISPLAY, x11: process.env.DISPLAY, backend: process.env.XDG_SESSION_TYPE },
  coverage: 'Visible Linux app using system WebKit. Only selected cases are exercised; see case limitations and COVERAGE.md. New cases await live validation.',
  selected, selectedCases, expectedViewport,
  actions: [], cases: [], errors: [] };
const journal = new Journal(out);
journal.checkpoint(report);
let monitor, monitoring = false, resourceFailure, driverStart;
let driver, processDriver, lock, logHandle, acquired = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  report.status = 'failure'; report.errors.push(`Interrupted by ${signal}`);
  if (processDriver?.pid) { try { process.kill(-processDriver.pid, 'SIGTERM'); } catch {} }
  if (acquired) lock.stdin.end();
  await finishReport();
  process.exit(signal === 'SIGINT' ? 130 : 143);
});
const log = step => { const action = { at: new Date().toISOString(), ...step }; report.actions.push(action); journal.event('action', action); };
const freePort = () => new Promise((yes, no) => {
  const s = createServer(); s.on('error', no); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => yes(p)); });
});
async function memoryPreflight(stage) {
  const snapshot = await availableMemory();
  (report.memoryPreflight ??= []).push({ stage, ...snapshot });
  journal.checkpoint(report);
  if (!snapshot.allowed) throw Error(`GUI launch blocked by memory preflight: ${snapshot.reasons.join('; ')}. No app was launched; do not stop unrelated processes automatically.`);
}
async function executable(path) {
  const full = await realpath(resolve(root, path));
  await access(full, constants.X_OK);
  if (!(await stat(full)).isFile()) throw Error(`Not an executable file: ${full}`);
  return full;
}
async function finishReport() {
  if (monitor) clearInterval(monitor);
  report.finished = new Date().toISOString();
  journal.checkpoint(report);
  const md = [`# GUI verification: ${report.status}`, '', `Run: ${id}`, '',
    `Checkout: ${report.commit}${report.dirty ? ' (dirty)' : ''}`, '', report.coverage, '',
    ...report.cases.map(c => `- ${c.name}: ${c.status}${c.error ? ` — ${c.error}` : ''}`),
    ...report.errors.map(e => `- ${e}`), '', 'Evidence and action log: see report.json and case directories.', ''];
  await writeFile(join(out, 'report.md'), md.join('\n'));
  journal.event('finished', { status: report.status });
  console.log(`${report.status.toUpperCase()}: ${out}/report.md`);
}
try {
  if (gitError) throw Error(`Git metadata is unavailable: ${gitError.message}`);
  if (process.platform !== 'linux') throw Error('This initial runner supports Linux only.');
  await memoryPreflight('before-setup');
  if (!process.env.WAYLAND_DISPLAY && !process.env.DISPLAY) throw Error('A visible desktop is required.');
  const config = JSON.parse(await readFile(resolve(root, configFile), 'utf8'));
  const allowed = ['binary', 'engine', 'tauriDriver', 'nativeDriver', 'fixture', 'binaryRevision'];
  for (const key of Object.keys(config)) if (!allowed.includes(key)) throw Error(`Unsupported configuration key: ${key}`);
  for (const key of ['binary', 'engine', 'tauriDriver', 'nativeDriver', 'fixture'])
    if (typeof config[key] !== 'string' || !config[key]) throw Error(`Missing configuration path: ${key}`);
  const binary = await executable(config.binary), engine = await executable(config.engine);
  const supportedBinary = await realpath(join(root, 'app/src-tauri/target/release/immage'));
  if (binary !== supportedBinary) throw Error('This initial runner supports only this checkout’s release binary; debug and installed builds are blocked to protect shared app state.');
  const tauriDriver = await executable(config.tauriDriver), nativeDriver = await executable(config.nativeDriver);
  const fixture = await realpath(resolve(root, config.fixture));
  if (!(await stat(fixture)).isFile()) throw Error('Fixture must be a file.');
  const bytes = await readFile(fixture), binaryBytes = await readFile(binary);
  for (const path of [binary, engine, tauriDriver, nativeDriver]) {
    const magic = (await readFile(path)).subarray(0, 4);
    if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw Error(`Expected a native ELF executable, not a script: ${path}`);
  }
  report.drivers = { tauri: { path: tauriDriver, sha256: hash(await readFile(tauriDriver)) },
    native: { path: nativeDriver, sha256: hash(await readFile(nativeDriver)) },
    installedWebKit: execFileSync('pkg-config', ['--modversion', 'webkit2gtk-4.1'], { encoding: 'utf8' }).trim() };
  report.binary = { path: binary, sha256: hash(binaryBytes), modified: (await stat(binary)).mtime.toISOString(),
    declaredRevision: config.binaryRevision || 'unknown — executable may predate checkout',
    runtime: 'system WebKit (not the CI AppImage)' };
  report.engine = { path: engine, sha256: hash(await readFile(engine)) };
  report.fixture = { name: basename(fixture), sha256: hash(bytes) };
  // flock is held by a live child, so the kernel releases it even after a crash.
  // The lock lives outside the checkout: separate worktrees share the desktop.
  const displayKey = hash(`${process.env.XDG_RUNTIME_DIR}:${process.env.WAYLAND_DISPLAY || process.env.DISPLAY}`).slice(0, 20);
  const lockFile = join(tmpdir(), `immage-gui-${process.getuid()}-${displayKey}.lock`);
  lock = spawn('flock', ['--nonblock', '--exclusive', lockFile, 'sh', '-c', 'printf "locked\\n"; cat >/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise((yes, no) => {
    lock.once('error', no);
    lock.once('exit', code => { if (!acquired) no(Error(`Desktop lock is occupied or unavailable (${code}); no app was launched.`)); });
    lock.stdout.once('data', () => { acquired = true; yes(); });
  });
  report.lock = { path: lockFile, ownerPid: process.pid, machine: hostname(), run: id };
  const profile = join(out, 'profile'), fixtures = join(out, 'fixtures');
  await mkdir(fixtures);
  for (const part of ['data', 'config', 'cache', 'state']) await mkdir(join(profile, part), { recursive: true });
  let copiedFixture = join(fixtures, basename(fixture));
  if(fixtureName==='configured') await copyFile(fixture, copiedFixture);
  else {
    execFileSync('python3',[join(root,'verify/gui/fixtures.py'),fixtures],{stdio:'pipe'});
    const generated=JSON.parse(await readFile(join(fixtures,'fixtures.json'),'utf8'));
    copiedFixture=join(fixtures,generated[fixtureName].file);
    report.syntheticFixture={name:fixtureName,...generated[fixtureName]};
  }
  if (selectedCases.includes('batch-paste')) {
    if (!/\.jpe?g$/i.test(copiedFixture)) throw Error('batch-paste requires a JPEG fixture');
    for (const name of ['batch-target-1.jpg', 'batch-target-2.jpg', 'batch-untouched.jpg'])
      await copyFile(copiedFixture, join(fixtures, name));
    report.batchFixtures = ['batch-target-1.jpg', 'batch-target-2.jpg', 'batch-untouched.jpg'];
  }
  const port = await freePort(); let nativePort = await freePort(); while (nativePort === port) nativePort = await freePort();
  const env = { ...process.env,
    XDG_DATA_HOME: join(profile, 'data'), XDG_CONFIG_HOME: join(profile, 'config'),
    XDG_CACHE_HOME: join(profile, 'cache'), XDG_STATE_HOME: join(profile, 'state'),
    DT_ENGINE_BIN: engine, TAURI_WEBVIEW_AUTOMATION: 'true' };
  report.profile = { path: profile, variables: Object.fromEntries(Object.entries(env).filter(([k]) => /^XDG_(DATA|CONFIG|CACHE|STATE)_HOME$/.test(k))) };
  await memoryPreflight('before-launch');
  const { open } = await import('node:fs/promises'); logHandle = await open(join(out, 'driver-app.log'), 'w');
  processDriver = spawn(tauriDriver, ['--port', String(port), '--native-port', String(nativePort), '--native-driver', nativeDriver],
    { cwd: root, env, detached: true, stdio: ['ignore', logHandle.fd, logHandle.fd] });
  let launchError; processDriver.on('error', e => { launchError = e; });
  const sample = async () => {
    if (monitoring || !processDriver.pid) return;
    monitoring = true;
    try {
      const [system, children] = await Promise.all([availableMemory(), sampleProcesses(processDriver.pid,'/proc',driverStart)]);
      driverStart ??= children.processes.find(p=>p.pid===processDriver.pid)?.started;
      const reading = { system, children, case: report.cases.at(-1)?.name ?? 'launch' };
      journal.event('memory', reading);
      report.memory = { last: reading, peakRssSum: Math.max(report.memory?.peakRssSum ?? 0, children.rssSum) };
      journal.checkpoint(report);
      if (system.MemAvailable < 1024 ** 3 || system.swapUsedFraction > .85) {
        resourceFailure = Error('GUI run stopped: available RAM below 1 GiB or swap usage above 85%.');
        journal.event('resource-stop', { error: resourceFailure.message });
        try { process.kill(-processDriver.pid, 'SIGTERM'); } catch {}
      }
    } catch (error) { journal.event('memory-error', { message: error.message }); }
    finally { monitoring = false; }
  };
  await sample();
  if (resourceFailure) throw resourceFailure;
  monitor = setInterval(sample, 2000);
  driver = new AppDriver(`http://127.0.0.1:${port}`, log);
  await until(async () => { if (launchError) throw launchError; return driver.request('GET', '/status'); }, 'Tauri driver', 15000);
  await driver.open(binary, copiedFixture);
  report.capabilities = driver.capabilities;
  await driver.command('POST', '/timeouts', { script: 10000, pageLoad: 15000, implicit: 0 });
  console.log(`Visible app launched; evidence: ${out}`);
  report.status = 'running';
  const prepareViewport = async () => {
    if (!expectedViewport || report.viewportPrepared) return;
    // External authorized preparation may size only this test app. The runner
    // itself only observes and enforces the requested logical viewport.
    report.preparingViewport = true; journal.checkpoint(report);
    try { await until(async () => {
      await driver.guard();
      const actual = await driver.observe(() => ({ width: innerWidth, height: innerHeight }));
      if (JSON.stringify(actual) !== JSON.stringify(report.viewportPreparation)) {
        report.viewportPreparation = actual; journal.checkpoint(report);
      }
      return actual.width === expectedViewport.width && actual.height === expectedViewport.height;
    }, `prepared viewport ${expectedViewport.width}x${expectedViewport.height}`, 30000); }
    catch (error) {
      // Retain app-only evidence if the known main URL/handle still match,
      // even when the viewer disappears during external sizing preparation.
      try {
        const handle = await driver.command('GET', '/window');
        const observation = await driver.observe(() => ({ url: location.href, title: document.title,
          width: innerWidth, height: innerHeight, ready: document.readyState,
          viewer: !!document.querySelector('main.viewer'), text: document.body?.innerText.slice(0, 2000) }));
        if (handle === driver.mainHandle && observation.url === driver.mainUrl) {
          report.viewportFailureObservation = observation;
          await driver.screenshot(join(out, 'viewport-preparation-failure.png'));
        }
      } catch (capture) { report.viewportCaptureError = capture.message; }
      journal.checkpoint(report);
      throw error;
    }
    report.preparingViewport = false; report.viewportPrepared = true; journal.checkpoint(report);
  };
  for (const name of selectedCases) {
    // Finish startup/tour/first photo before external sizing. Early sizing can
    // otherwise race the splash/main-window transition and initial layout.
    if (name !== 'startup') await prepareViewport();
    const run = implementationFor(name);
    if (resourceFailure) throw resourceFailure;
    const c = { name, definition: cases[name], status: 'running', measurements: [], started: new Date().toISOString() };
    report.cases.push(c); journal.event('case-start', { name }); journal.checkpoint(report);
    const caseDir = join(out, name); await mkdir(caseDir);
    const t = { driver,
      fixture:{name:fixtureName,generated:fixtureName!=='configured',file:basename(copiedFixture),raw:/\.(?:cr2|cr3|nef|arw|raf|dng|orf|rw2)$/i.test(copiedFixture)},
      sidecars:async()=>Promise.all((await readdir(fixtures)).filter(n=>n.endsWith('.xmp')).map(n=>readFile(join(fixtures,n),'utf8'))),
      sidecarsNamed:async()=>Promise.all((await readdir(fixtures)).filter(n=>n.endsWith('.xmp')).map(async file=>({file,text:await readFile(join(fixtures,file),'utf8')}))),
      fixtureFiles:()=>readdir(fixtures), engineLog:()=>readFile(join(profile,'data','app.immage','engine.log'),'utf8'),
      benchmarkReport: async filename => {
        // Read only the known report folder inside this run's isolated profile.
        // Never follow an arbitrary path supplied by the app's status text.
        const directory = await realpath(join(profile, 'data', 'app.immage', 'benchmarks'));
        const source = await realpath(join(directory, benchmarkFilename(filename)));
        if (dirname(source) !== directory) throw Error('Benchmark report escaped its profile directory');
        const bytes = await readFile(source);
        await writeFile(join(caseDir, 'benchmark.json'), bytes);
        journal.event('benchmark-report', { case: name, file: join(caseDir, 'benchmark.json'), sha256: hash(bytes) });
        return { file: join(caseDir, 'benchmark.json'), report: JSON.parse(bytes) };
      },
      measure: m => { c.measurements.push(m); journal.event('measurement', { case: name, ...m }); journal.checkpoint(report); }, evidence: async label => {
      await driver.screenshot(join(caseDir, `${label}.png`));
      const environment=await driver.observe(()=>({userAgent:navigator.userAgent,viewport:[innerWidth,innerHeight],scale:devicePixelRatio,theme:document.documentElement.className,canvasTheme:document.querySelector('main.viewer')?.className,font:getComputedStyle(document.body).fontFamily,fonts:document.fonts.status}));
      await writeFile(join(caseDir,`${label}.png.json`),JSON.stringify({run:id,case:name,environment:{platform:process.platform,arch:process.arch,webview:report.drivers.installedWebKit,...environment}},null,2)+'\n');
      journal.event('screenshot', { case: name, label });
    } };
    try { await run(t); if (resourceFailure) throw resourceFailure; c.status = 'pass'; }
    catch (e) {
      c.status = e.name === 'Blocked' ? 'blocked' : 'failure'; c.error = e.stack;
      try { await t.evidence('failure'); } catch (capture) { c.captureError = capture.message; }
      throw e;
    } finally { c.finished = new Date().toISOString(); journal.event('case-finished', { name, status: c.status }); journal.checkpoint(report); }
  }
  await prepareViewport(); // Also enforce the requirement for startup-only runs.
  // App and engine output must have landed in this run's XDG profile.
  const engineLog = join(profile, 'data', 'app.immage', 'engine.log');
  await access(engineLog);
  report.isolation = { engineLog, fixtureOriginalUnchanged: hash(await readFile(fixture)) === report.fixture.sha256 };
  if (!report.isolation.fixtureOriginalUnchanged) throw Error('Original fixture changed.');
  if (resourceFailure) throw resourceFailure;
  report.status = 'pass';
} catch (error) {
  if (resourceFailure) report.errors.push(resourceFailure.message);
  if (report.status === 'running') report.status = error.name === 'Blocked' ? 'blocked' : 'failure';
  report.errors.push(error.stack ?? error.message);
} finally {
  if (monitor) clearInterval(monitor);
  if (driver?.session) { try { await driver.close(); } catch (e) { report.errors.push(`Session cleanup: ${e.message}`); if (report.status === 'pass') report.status = 'failure'; } }
  if (processDriver?.pid) { try { process.kill(-processDriver.pid, 'SIGTERM'); } catch {} }
  await logHandle?.close();
  if (acquired) lock.stdin.end();
  await finishReport();
}
process.exitCode = report.status === 'pass' ? 0 : 1;
