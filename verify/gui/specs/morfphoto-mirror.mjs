// SPDX-License-Identifier: GPL-3.0-or-later
// The local copy of the morfPhoto catalog (morf_mirror.rs, MorfPhotoMirror.tsx):
// a fake morfPhoto server on loopback (node:http, below) serves five photos and
// a change feed, and the share is a scratch folder on the 9p host share
// (/mnt/mac/.immage-gui-test-<run id>/photos, made and removed by run.mjs, which
// also gives the app a private keychain so the API key Save never touches the
// user's). The same names sit in a plain local twin beside the run's fixtures.
//
// Steps: (a) Preferences > Immage Accelerator, the Local catalog card fills;
// (b) the share folder opens from the local copy with only a status probe, no
// listing request; (c) a rating made here survives the feed's unrelated change
// and the server catching up; (d) Find over All folders lists the camera as
// darktable spells it; (e) with the server gone the folder still opens, as the
// local copy; (f) pointing the mapping at the twin (not a network mount) makes
// it an unmounted share: red dots, a click says the drive is offline; (g) only
// the scratch tree and the run folder were written, and the twin not at all.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, extname, join, relative } from 'node:path';
import { Blocked, choose, textButton } from '../support/scenario.mjs';
import { click, reveal } from '../support/controls.mjs';
import { until, pause } from '../support/webdriver.mjs';

const KEY = 'gui-mirror-key';
const CATALOG = 'gui-mirror-catalog';
const SERVER_ROOT = '/photos';
const MAKE = 'NIKON CORPORATION', MODEL = 'NIKON Z 6', LENS = 'NIKKOR Z 35mm f/1.8 S';
const BACKSPACE = '\uE003';
const CONTROL = '\uE009';

// the five photos: id, folder under the share and name stem. m-04 and m-05 sit in 2024/
export const MIRROR_FILES = [
  { id: 1, dir: '', stem: 'm-01' }, { id: 2, dir: '', stem: 'm-02' }, { id: 3, dir: '', stem: 'm-03' },
  { id: 4, dir: '2024', stem: 'm-04' }, { id: 5, dir: '2024', stem: 'm-05' },
];

// run.mjs calls this before the first launch: the photos on the share (scratch
// tree under /mnt/mac) and the same names in the plain local twin
export async function morfphotoMirrorFixtures(fixtureDir, fixture, scratch) {
  const ext = extname(fixture);
  const share = join(scratch, 'photos');
  const twin = join(dirname(fixtureDir), 'morfphoto-mirror-fixtures', 'twin');
  for (const base of [share, twin]) {
    for (const f of MIRROR_FILES) {
      await mkdir(join(base, f.dir), { recursive: true });
      await copyFile(fixture, join(base, f.dir, f.stem + ext));
    }
  }
  return { scratch, share, twin, ext, photos: MIRROR_FILES.length,
    files: MIRROR_FILES.map(f => join(f.dir, f.stem + ext)) };
}

// ---- the fake morfPhoto server ----
// Answers what Immage asks (morf_photo.rs, morf_mirror.rs), with the item shape
// of morfPhoto's PhotoRepository::libraryItems (src/PhotoRepository.cpp).
// Every request is logged; a request without the bearer key is answered 401.
export class FakeMorf {
  constructor(files) {
    this.files = new Map(files.map((f, i) => [f.id, { ...f, seq: i + 1, rating: 0 }]));
    this.highWater = files.length;
    this.log = [];
    this.server = createServer((req, res) => this.handle(req, res));
  }
  async start() {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    this.url = `http://127.0.0.1:${this.server.address().port}`;
  }
  // a changed photo: a new change number, and optionally a new rating
  bump(id, { rating } = {}) {
    const f = this.files.get(id);
    f.seq = ++this.highWater;
    if (rating !== undefined) f.rating = rating;
    return f.seq;
  }
  async stop() {
    if (!this.server.listening) return;
    await new Promise(resolve => { this.server.close(resolve); this.server.closeAllConnections(); });
  }
  item(f) {
    const ext = f.name.slice(f.name.lastIndexOf('.') + 1);
    const day = String(f.id).padStart(2, '0');
    return {
      id: f.id, path: f.path, root: SERVER_ROOT, directory: f.dir, filename: f.name, extension: ext,
      file_type: 'image', size: f.size, mtime: f.mtime, make: MAKE, camera_model: MODEL, lens: LENS,
      focal_length: 35, focal_length_35mm: 35, aperture: 2.8, shutter_speed: '1/250', shutter_speed_s: 0.004,
      iso: 400, exposure_compensation: 0,
      kind: ext.toLowerCase() === 'jpg' || ext.toLowerCase() === 'jpeg' ? 'JPEG' : ext.toUpperCase(),
      file_ext: ext.toUpperCase(), camera: 'Nikon Z 6', body_key: null, body_serial: null,
      iso_label: '400', aperture_label: 'f/2.8', focal_label: '35 mm', shutter_label: '1/250 s',
      relative_path: f.path.slice(SERVER_ROOT.length + 1),
      versions: [{ version: 0, copy: false, sidecar: null, rating: f.rating, rejected: false, labels: 0,
        edited: null, taken_at: `2024-06-${day}T10:00:${day}`, latitude: null, longitude: null,
        title: null, description: null, creator: null, rights: null, version_name: null, has_sidecar: false,
        keywords: [] }],
    };
  }
  handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const entry = { at: Date.now(), pathname: url.pathname, query: url.search, authorized: req.headers.authorization === `Bearer ${KEY}` };
    this.log.push(entry);
    const send = (status, body, headers = {}) => {
      entry.status = status;
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (!entry.authorized) return send(401, { error: 'unauthorized' });
    const etag = tag => {
      if (req.headers['if-none-match'] === tag) { entry.status = 304; res.writeHead(304, { ETag: tag }); res.end(); return true; }
      return false;
    };
    const rev = `rev-${this.highWater}`;
    switch (url.pathname) {
      case '/api/v1/index/status': {
        const tag = `"st-${CATALOG}-${this.highWater}"`;
        if (etag(tag)) return;
        return send(200, { last_run: null, catalog_revision: rev, catalog_id: CATALOG, high_water: this.highWater }, { ETag: tag });
      }
      case '/api/v1/library/changes': {
        const num = (key, fallback, min) => {
          const v = url.searchParams.get(key);
          if (v === null) return fallback;
          const n = Number(v);
          return Number.isInteger(n) && n >= min ? n : NaN;
        };
        const afterSeq = num('after_seq', 0, 0), afterId = num('after_id', 0, 0), limit = num('limit', 500, 1);
        if ([afterSeq, afterId, limit].some(Number.isNaN)) return send(400, { error: 'bad_request' });
        const after = [...this.files.values()].filter(f => f.seq > afterSeq || (f.seq === afterSeq && f.id > afterId))
          .sort((a, b) => a.seq - b.seq || a.id - b.id);
        const page = after.slice(0, limit), more = after.length > limit;
        const last = page.at(-1);
        return send(200, { catalog_id: CATALOG, high_water: this.highWater,
          next: more && last ? { seq: last.seq, id: last.id } : null,
          items: page.map(f => ({ ...this.item(f), seq: f.seq, state: 'present' })) },
        { ETag: `"chg-${CATALOG}-${this.highWater}"` });
      }
      case '/api/v1/library/subfolders': {
        const folder = url.searchParams.get('folder_path') ?? '';
        const prefix = folder === '/' ? '/' : `${folder}/`;
        const children = new Map();
        for (const f of this.files.values()) {
          if (!f.dir.startsWith(prefix)) continue;
          const parts = f.dir.slice(prefix.length).split('/').filter(Boolean);
          if (!parts.length) continue;
          children.set(prefix + parts[0], children.get(prefix + parts[0]) || parts.length > 1);
        }
        return send(200, { items: [...children].map(([path, has_children]) => ({ path, has_children })) });
      }
      case '/api/v1/library': {
        // the offset listing (the Test button, a server without the feed); a
        // cursor request gets an empty last page
        const size = Number(url.searchParams.get('page_size') ?? 100), page = Number(url.searchParams.get('page') ?? 1);
        if (url.searchParams.has('cursor'))
          return send(200, { page_size: size, has_more: false, next_cursor: null, items: [] }, { 'X-Catalog-Revision': rev });
        const folder = url.searchParams.get('folder_path'), recursive = url.searchParams.get('recursive') === 'true';
        const all = [...this.files.values()].filter(f => !folder || f.dir === folder
          || (recursive && f.dir.startsWith(`${folder}/`))).sort((a, b) => a.id - b.id);
        const items = all.slice((page - 1) * size, page * size).map(f => this.item(f));
        return send(200, { page, page_size: size, total: all.length, has_more: page * size < all.length,
          next_cursor: null, items }, { 'X-Catalog-Revision': rev });
      }
      case '/api/v1/thumbnail/cached':
      case '/api/v1/search/semantic':
        return send(404, { error: 'not_found' });
      default:
        return send(404, { error: 'not_found' });
    }
  }
}

// ---- helpers ----
const present = (t, selector) => t.driver.observe(s => !!document.querySelector(s), selector);
const count = (t, selector) => t.driver.observe(s => document.querySelectorAll(s).length, selector);
const row = path => `.folder-row[data-folder-path=${JSON.stringify(path)}]`;
const cells = '.filmstrip.grid .thumb[data-imgid]';
const field = label => `.prefs input[aria-label=${JSON.stringify(label)}]`;
const SAVE = '.prefs [data-pref-label="Connection"] button:nth-child(2)';
const pop = '.find-pop';
const searchIn = `${pop} select[aria-label="Search in"]`;
const titles = t => t.driver.observe(s => [...document.querySelectorAll(s)].map(e => e.title).sort(), cells);
const stars = (t, name) => t.driver.observe((s, n) => {
  const e = [...document.querySelectorAll(s)].find(x => x.title === n);
  return e ? e.querySelectorAll('.thumb-stars button.on').length : null;
}, cells, name);
const statusText = t => t.driver.observe(() => document.querySelector('.status')?.textContent.trim() ?? '');
const rowState = (t, path) => t.driver.observe(s => { const e = document.querySelector(s);
  return e && { offline: e.classList.contains('offline'), title: e.getAttribute('title') }; }, row(path));

// real key input into a field the pointer click just focused
async function typeInto(t, label, text) {
  const selector = field(label);
  await click(t, selector);
  await t.driver.guard();
  const found = await t.driver.command('POST', '/element', { using: 'css selector', value: selector });
  await t.driver.command('POST', `/element/${Object.values(found)[0]}/value`, { text });
}
// replace what a field holds: select all and delete it, then type
async function replaceInto(t, label, text) {
  const selector = field(label);
  await click(t, selector);
  await t.driver.chord(CONTROL, 'a');
  await t.driver.keys(BACKSPACE);
  await typeInto(t, label, text);
  await until(() => t.driver.observe((s, v) => document.querySelector(s)?.value === v, selector, text), `${label} holds the new text`);
}

async function openAcceleratorTab(t) {
  if (!await present(t, '.prefs')) await click(t, 'button[data-tour="prefs"]');
  const tab = await until(() => t.driver.observe(() => {
    const e = [...document.querySelectorAll('.prefs-tabs button')].find(b => b.textContent.trim() === 'Immage Accelerator (Experimental)');
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }), 'the Immage Accelerator tab');
  await t.driver.point(tab.x, tab.y);
  await until(() => present(t, field('Server URL')), 'the Immage Accelerator settings');
}
async function savePrefs(t) {
  await click(t, SAVE);
  const text = await until(() => t.driver.observe(() => document.querySelector('.prefs .prefs-status')?.textContent.trim() ?? ''),
    'the save result', 20000);
  if (/Could not save/.test(text)) throw new Blocked(`the settings could not be saved (private keychain?): ${text}`);
  assert.equal(text, 'morfPhoto settings saved.');
}
async function closePrefs(t) {
  await textButton(t, '.prefs-foot', 'Done');
  await until(async () => !await present(t, '.prefs'), 'Preferences closes');
}

async function foldersCard(t, roots) {
  if (!await t.driver.observe(() => document.querySelector('.folders-panel > .panel-title')?.classList.contains('open')))
    await click(t, '.folders-panel > .panel-title');
  for (const r of roots) await until(() => present(t, row(r)), `the Folders row ${basename(r)}`, 30000);
}
async function ensureGrid(t) {
  if (!await present(t, '.filmstrip.grid')) await click(t, '.rail .library-toggle');
  await until(() => present(t, '.filmstrip.grid'), 'grid view');
}
async function openFolder(t, path) {
  await foldersCard(t, [path]);
  await click(t, `${row(path)} .name`);
  await ensureGrid(t);
}

// the wanted names appear in the grid, and no others
async function listed(t, names, label, timeout = 60000) {
  const want = [...names].sort();
  return until(async () => JSON.stringify(await titles(t)) === JSON.stringify(want) && want, label, timeout);
}

// the server's requests since a log position
const since = (fake, from, pathname) => fake.log.slice(from).filter(r => r.pathname === pathname);
const waitRequest = (fake, from, pathname, label, timeout = 150000) =>
  until(() => since(fake, from, pathname).length > 0, label, timeout);

// darktable's spelling of the camera, from the table the app ships (camera_names.rs)
async function expectedCamera() {
  const tsv = await readFile(new URL('../../../app/src-tauri/data/camera_names.tsv', import.meta.url), 'utf8');
  for (const line of tsv.split('\n')) {
    const [make, model, maker, name] = line.split('\t');
    if (make === MAKE && model === MODEL) return `${maker} ${name}`.trim();
  }
  throw Error(`camera_names.tsv has no row for ${MAKE} ${MODEL}`);
}
// camera_names.rs lens(): NIKKOR keeps the first letter capital and the rest lower case
const expectedLens = name => name.startsWith('NIKKOR ') ? name[0] + name.slice(1, 7).toLowerCase() + name.slice(7) : name;

async function openCategory(t, name) {
  const expanded = n => t.driver.observe(title => [...document.querySelectorAll('.find-pop .fr-row')]
    .find(c => c.querySelector('.fr-title')?.textContent === title)?.getAttribute('aria-expanded') === 'true', n);
  if (await expanded(name)) return;
  const c = await reveal(t, '.find-pop .fr-row .fr-title', name);
  await t.driver.point(c.x, c.y);
  await until(() => expanded(name), `the ${name} editor`);
}
const tickList = t => t.driver.observe(() => [...document.querySelectorAll('.find-pop .fr-editor .filter-ticks button[role="checkbox"]')]
  .map(b => ({ name: b.querySelector('.name')?.textContent.trim(), count: b.querySelector('.count')?.textContent.trim(),
    on: b.getAttribute('aria-checked') === 'true' })));
const findBoxes = t => count(t, '.find-pop .fr-editor input.field.find');
const findCount = t => t.driver.observe(() => {
  const m = /^\s*(\d[\d.,\s\u00a0\u202f]*)/.exec(document.querySelector('.find-pop .find-count-text')?.textContent ?? '');
  return m ? Number(m[1].replace(/\D/g, '')) : null;
});

// every file under a folder: relative name, size, mtime and SHA-256
async function snapshot(dir, base = dir, out = {}) {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await snapshot(path, base, out);
    else {
      const s = await stat(path);
      out[relative(base, path)] = { size: s.size, mtimeMs: s.mtimeMs, sha256: createHash('sha256').update(await readFile(path)).digest('hex') };
    }
  }
  return out;
}

export async function morfphotoMirror(t) {
  const fx = t.morfphotoMirror;
  if (!fx) throw new Blocked('the runner did not make the share and twin folders');
  const { share, twin, ext, scratch } = fx;
  const name = stem => stem + ext;
  const rootNames = MIRROR_FILES.filter(f => !f.dir).map(f => name(f.stem));
  const allNames = MIRROR_FILES.map(f => name(f.stem));
  const camera = await expectedCamera();

  // the catalog the fake server holds: real sizes and times of the copies on the share
  const files = [];
  for (const f of MIRROR_FILES) {
    const s = await stat(join(share, f.dir, name(f.stem)));
    const dir = f.dir ? `${SERVER_ROOT}/${f.dir}` : SERVER_ROOT;
    files.push({ id: f.id, dir, name: name(f.stem), path: `${dir}/${name(f.stem)}`, size: s.size, mtime: Math.floor(s.mtimeMs / 1000) });
  }
  const fake = new FakeMorf(files);
  await fake.start();
  try {
    const twinBefore = await snapshot(twin);
    t.measure({ name: 'fake-server', url: fake.url, share, twin: basename(twin), photos: files.length, camera });

    // a. Preferences > Immage Accelerator: the mapping, the key, Enable, Save; the Local catalog card fills
    await openAcceleratorTab(t);
    await typeInto(t, 'Server URL', fake.url);
    await typeInto(t, 'Folder on the server', SERVER_ROOT);
    await replaceInto(t, 'Folder on this computer', share);
    await typeInto(t, 'API key', KEY);
    if (!await t.driver.observe(s => document.querySelector(s).checked, field('Enable Immage Accelerator')))
      await click(t, field('Enable Immage Accelerator'));
    await until(() => t.driver.observe(s => document.querySelector(s).checked, field('Enable Immage Accelerator')), 'Enable on');
    await savePrefs(t);
    const card = await until(() => t.driver.observe(() => {
      const value = label => document.querySelector(`.prefs [data-pref-label="${label}"] .mirror-value`)?.textContent.trim() ?? null;
      const photos = value('Photos in the local copy'), synced = value('Last synced');
      return photos === '5' && synced && synced !== 'Not yet' ? { photos, synced } : null;
    }), 'the Local catalog card: 5 photos and a synced time', 60000);
    t.measure({ name: 'local-catalog-card', ...card });
    await t.evidence('local-catalog-card', '.prefs');
    await closePrefs(t);
    const synced = fake.log.length;
    assert(fake.log.some(r => r.pathname === '/api/v1/library/changes'), 'the sync read the change feed');
    assert(fake.log.every(r => r.authorized), 'every request carried the API key');

    // b. the share folder opens from the local copy: a status probe, no listing request
    await foldersCard(t, [share, twin]);
    await ensureGrid(t);
    const recursive = await t.driver.observe(() => !!document.querySelector('.sub-toggle input')?.checked);
    const expected = recursive ? allNames : rootNames;
    t.measure({ name: 'include-subfolders-default', recursive, expected: expected.length });
    await click(t, `${row(share)} .name`);
    await listed(t, expected, `${expected.length} photos listed from the share folder`);
    await until(() => since(fake, synced, '/api/v1/index/status').length > 0, 'a status probe for the open', 10000);
    assert.equal(fake.log.filter(r => r.pathname === '/api/v1/library').length, 0, 'no /api/v1/library listing was requested');
    t.measure({ name: 'share-open-requests', paths: fake.log.slice(synced).map(r => r.pathname) });
    await click(t, `${row(share)} .twisty`);
    await until(() => present(t, row(join(share, '2024'))), 'the 2024 subfolder row', 30000);
    assert(since(fake, 0, '/api/v1/library/subfolders').length > 0, 'the folder tree asked the server for subfolders');
    await t.evidence('share-open', '.folders-panel');

    // c. a rating made here is kept while the feed changes something else, and after the server catches up
    const rated = name('m-01'), other = 2;
    await listed(t, expected, 'the share folder still listed');
    const cell = `.filmstrip.grid .thumb[title=${JSON.stringify(rated)}]`;
    const at = await reveal(t, cell);
    await t.driver.move(at.x, at.y);
    await click(t, `${cell} .thumb-stars button:nth-child(3)`);
    await until(async () => await stars(t, rated) === 3, `${rated} rated three stars`);
    await pause(2000);
    const samples = [];
    const watch = async ms => {
      for (const end = Date.now() + ms; Date.now() < end; await pause(300)) samples.push(await stars(t, rated));
    };
    const afterFeed = async (from, label) => {
      // wait for the sync's feed read, then for the folder to be read again (its status probe), sampling the rating throughout
      let done = false;
      const sampler = (async () => { while (!done) { samples.push(await stars(t, rated)); await pause(400); } })();
      try {
        await waitRequest(fake, from, '/api/v1/library/changes', `the feed read after ${label}`);
        const fed = fake.log.findIndex((r, i) => i >= from && r.pathname === '/api/v1/library/changes');
        const reread = await until(() => since(fake, fed + 1, '/api/v1/index/status').length > 0, `the folder read again after ${label}`, 30000)
          .catch(() => false);
        t.subcheck(`${label}: the open folder is read again`, !!reread);
        await pause(1500);
        await watch(5000);
      } finally { done = true; await sampler; }
    };
    const beforeUnrelated = fake.log.length;
    fake.bump(other);
    await afterFeed(beforeUnrelated, 'an unrelated change');
    const seen = samples.filter(v => v !== null);
    t.measure({ name: 'rating-after-unrelated-change', samples: seen.length, min: Math.min(...seen) });
    assert(seen.length > 0 && seen.every(v => v === 3), `${rated} kept its three stars while the server said 0 (samples ${[...new Set(samples)]})`);
    await t.evidence('rating-kept', '.filmstrip.grid');
    samples.length = 0;
    const beforeRated = fake.log.length;
    fake.bump(1, { rating: 3 });
    await afterFeed(beforeRated, 'the server rating');
    const later = samples.filter(v => v !== null);
    assert(later.length > 0 && later.every(v => v === 3), `${rated} stays at three stars once the server says 3 (samples ${[...new Set(samples)]})`);

    // d. Find over All folders: the camera as darktable spells it, with its count
    if (!await present(t, pop)) await click(t, '.find-button');
    await until(() => present(t, pop), 'Find column');
    await choose(t, searchIn, 'library');
    await openCategory(t, 'Camera');
    const cameras = await until(async () => { const l = await tickList(t); return l.some(x => x.name === camera) && l; },
      `the Cameras list holds ${camera}`, 60000);
    const entry = cameras.find(x => x.name === camera);
    t.measure({ name: 'cameras-list', list: cameras });
    assert.equal(entry.count, String(MIRROR_FILES.length), `${camera} counts ${MIRROR_FILES.length} photos`);
    assert.equal(await findBoxes(t), 0, 'a short Cameras list has no find box');
    const tick = await reveal(t, '.find-pop .fr-editor .filter-ticks button[role="checkbox"]', camera);
    await t.driver.point(tick.x, tick.y);
    await until(async () => await findCount(t) === MIRROR_FILES.length, `Find counts ${MIRROR_FILES.length} photos for ${camera}`, 60000);
    await t.evidence('find-camera', pop);
    await openCategory(t, 'Lens');
    const lenses = await until(async () => { const l = await tickList(t); return l.length > 0 && l; }, 'the Lenses list renders', 30000);
    t.measure({ name: 'lenses-list', list: lenses });
    assert(lenses.some(x => x.name === expectedLens(LENS) && x.count === String(MIRROR_FILES.length)),
      `the Lenses list holds ${expectedLens(LENS)} (${JSON.stringify(lenses)})`);
    assert.equal(await findBoxes(t), lenses.length > 8 ? 1 : 0, 'the Lenses find box shows only with more than 8 values');
    assert.equal(fake.log.filter(r => r.pathname === '/api/v1/library').length, 0, 'Find asked for no listing either');
    await click(t, `${pop} .find-clear`);
    await until(async () => (await tickList(t)).every(x => !x.on), 'Find cleared');
    await choose(t, searchIn, 'folder');

    // e. the server stops answering: the folder still opens, as the local copy
    await fake.stop();
    const down = fake.log.length;
    await openFolder(t, twin); // away from the share (the twin is a plain folder until f)
    await listed(t, expected, 'the twin listed before the mapping moves').catch(() => {});
    await openFolder(t, share);
    await listed(t, expected, `${expected.length} photos listed from the local copy with the server down`);
    const notice = await until(async () => { const s = await statusText(t); return /^Showing the local catalog, synced .+/.test(s) && s; },
      'the local catalog status', 30000);
    t.measure({ name: 'local-copy-status', notice, requestsAfterStop: fake.log.length - down });
    await t.evidence('local-copy', '.folders-panel');

    // f. the mapping moves to the twin, which is not on a network mount: an unmounted share, offline
    await openAcceleratorTab(t);
    await replaceInto(t, 'Folder on this computer', twin);
    await savePrefs(t);
    await closePrefs(t);
    const off = await until(async () => { const r = await rowState(t, twin); return r?.offline && r; },
      'the twin row offline (the next volume read, up to 10 s)', 60000);
    t.measure({ name: 'twin-offline', title: off.title });
    await openFolder(t, twin);
    await listed(t, expected, `${expected.length} photos listed from the local copy for the twin`);
    await until(async () => await count(t, `${cells} .thumb-offline`) === expected.length, 'a red offline dot on every photo', 30000);
    const dot = await t.driver.observe(() => { const e = document.querySelector('.filmstrip.grid .thumb .thumb-offline');
      return { role: e.getAttribute('role'), label: e.getAttribute('aria-label') }; });
    assert.deepEqual(dot, { role: 'img', label: "Photo's drive is offline" });
    await t.evidence('offline-dots', '.filmstrip.grid');
    const openBefore = await t.driver.observe(() => [...document.querySelectorAll('.thumb.active')].map(e => e.title));
    const target = name('m-01');
    const c = await reveal(t, `.filmstrip.grid .thumb[title=${JSON.stringify(target)}]`);
    await t.driver.point(c.x, c.y, 2);
    const refused = await until(async () => { const s = await statusText(t); return /is on a drive that is offline$/.test(s) && s; },
      'the photo-offline status', 15000);
    assert(refused.startsWith(target), `the status names ${target}: ${refused}`);
    const openAfter = await t.driver.observe(() => [...document.querySelectorAll('.thumb.active')].map(e => e.title));
    assert.deepEqual(openAfter, openBefore, 'no photo was opened');
    assert(!openAfter.some(n => allNames.includes(n)), 'the offline photo is not the open one');
    t.measure({ name: 'offline-click', status: refused, openBefore, openAfter });
    await t.evidence('offline-refused');
    assert.deepEqual(await snapshot(twin), twinBefore, 'nothing was written to the twin (files, sidecars, sizes, times, hashes)');

    // g. only the scratch tree and the run folder were written; the scratch tree holds the photos and the rated photo's sidecars
    const tree = Object.keys(await snapshot(scratch)).sort();
    const expectedTree = new Set(fx.files.map(f => join('photos', f)));
    const strays = tree.filter(n => !expectedTree.has(n) && !(n.startsWith(join('photos', rated)) && n.endsWith('.xmp')));
    t.measure({ name: 'scratch-tree', files: tree });
    assert.deepEqual(strays, [], 'the scratch tree holds only the photos and the rated photo\'s sidecar');
    assert(fake.log.every(r => r.authorized), 'every request carried the API key');
    t.measure({ name: 'requests', total: fake.log.length,
      byPath: Object.fromEntries([...new Set(fake.log.map(r => r.pathname))].map(p => [p, fake.log.filter(r => r.pathname === p).length])) });
  } finally {
    await fake.stop();
  }
}
