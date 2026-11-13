#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Headless golden-reply check of the engine's JSON line protocol.

Starts build/bin/darktable-engine with temporary state and sends every
command (the `!g_strcmp0(cmd, ...)` names in _handle() and _read_requests()
of engine/main.c, read at run time and compared with COMMANDS below, so a
new or removed command fails the check until the script is updated) in four
states: no photo and an empty library, a library of two photos, a photo
open, and after `close`. Also an unknown command, a missing one, a line that
is not JSON, a request that is not an object, tagged requests that run on
the engine's thread pools, and the reader thread's cancels.

Each reply is normalized (timings, the temporary folder, the build's version
string and file times dropped or replaced; frame hashes numbered by first
use; the size of each file a request writes kept, and its hash too except
for exported JPEG and TIFF files and PDFs, which hold run-specific data) and `--record FILE` writes them, keyed by state and command;
`--compare FILE` diffs a later run against that file and exits 1 on any
difference. Use it to prove a refactor of the engine changes no reply.

It checks the protocol: member names, types, values and error texts, and the
frames' hashes on a tiny TIFF, on the CPU. It does not check a raw
photo's pixels, OpenCL, the AI models (none are given, so the ai_* commands
run only their error path), heavy work (HDR and panorama merges, Denoise,
Upload) beyond argument errors, nor timing. `quit` is sent last. No GUI is
launched and nothing is written outside a temporary folder.

`--fixtures DIR` writes the raw `ok` replies, per command, to DIR/<command>.json
(a list of {label, reply}) for the Rust layer's reply-type tests
(app/src-tauri/src/bindings.rs). Types stay real: only the temporary folder,
timings, hashes, ids and the build's version string are replaced, and long
arrays are cut to a few elements, so a run on any machine writes the same files.

    python3 -I verify/engine-protocol.py [--engine build/bin/darktable-engine]
        [--record FILE | --compare FILE | --fixtures DIR]"""
import argparse
import collections
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
background = __import__('background-priority')
ROOT = background.ROOT

# every command the engine answers; keep in step with engine/main.c
COMMANDS = sorted('''
agx_auto agx_presets ai_accel ai_denoise ai_denoise_preview ai_depth ai_mask
ai_object baseline_end before cancel_base capture_times close color_profiles
combine copy data_backup export export_hold export_release folder fonts forget get
hdr_merge history import instance instances keywords keywords_set lenses look look_amount mask
mask_delete mask_map mask_rename masks merge_cancel meta meta_set module_schema module_state
open opencl pano_merge pano_preview parity paste_batch points prefetch preview
presets print print_profile_add print_profiles printer printers quit range_map
remove_copy render sample save set sidecars softproof spektra_fetch
spektra_stocks spot_source spots spots_enable style_forget thumb tone_key wb_presets
unpack upright version zones
'''.split())

# members that vary from run to run or build to build
TIMING = re.compile(r'(^|_)(ms|seconds|elapsed)$')
VOLATILE = {'version': '<VERSION>', 'file_datetime': '<FILE-TIME>'}


def source_commands(engine_c):
    """The command names main.c's _handle() and _read_requests() compare."""
    text = engine_c.read_text()
    names = set()
    lines = text.split('\n')
    if 'static const eng_cmd_t _commands[] =' in lines:
        start = lines.index('static const eng_cmd_t _commands[] =')
        end = lines.index('};', start)
        for line in lines[start + 1:end]:
            m = re.match(r'\s*\{\s*"([a-z_0-9]+)"\s*,', line)
            if m:
                names.add(m.group(1))
        starts = ('static gpointer _read_requests(',)
    else:
        starts = ('static void _handle(', 'static gpointer _read_requests(')
    for start in starts:
        i = text.index(start)
        names |= set(re.findall(r'g_strcmp0\(cmd, "([^"]+)"\)', text[i:text.index('\n}\n', i)]))
    return sorted(names)


FIXTURE_TMP = '/tmp/immage-fixture'
DATED = '2026:10:31 23:59:58.125'
FIXTURE_KEEP = 4       # distinct reply shapes kept per command
FIXTURE_ITEMS = 3      # elements kept of a long array


def shape(value):
    """The member names and types of a reply, to keep fixtures that differ."""
    if isinstance(value, dict):
        return {k: shape(v) for k, v in value.items()}
    if isinstance(value, list):
        return [shape(value[0])] if value else []
    return type(value).__name__


class Req:
    """One request: its label, the JSON (or raw line), the files whose hash it
    records, whether it is tagged (answered by a pool thread), and whether the
    engine answers it at all."""

    def __init__(self, label, req, files=(), tagged=False, silent=False, raw=False):
        self.label, self.req, self.files = label, req, files
        self.tagged, self.silent, self.raw = tagged, silent, raw


def R(cmd, *files, label=None, **args):
    return Req(label or cmd, {'cmd': cmd} | args, files)


def T(cmd, *files, label=None, **args):
    return Req(label or cmd + ' (tagged)', {'cmd': cmd} | args, files, tagged=True)


PAGE = {'width': 6.0, 'height': 4.0}
AREA = {'x': 0.5, 'y': 0.5, 'width': 5.0, 'height': 3.0}
CIRCLE = {'type': 'ellipse', 'x': 0.5, 'y': 0.5, 'rx': 0.2, 'ry': 0.2}


def anywhere(img):
    """Requests whose reply does not depend on a photo being open: library,
    metadata, settings and information commands, and the argument errors of
    the heavy ones. `img` is a photo id that exists or not."""
    return [
        R('version'), R('opencl'), R('ai_accel'), R('fonts'), R('keywords'),
        R('data_backup', label='data_backup no path'),
        R('data_backup', path='{tmp}/no-such-folder/data.db', label='data_backup unwritable'),
        R('spektra_stocks'),
        R('spektra_fetch', label='spektra_fetch status'),
        R('spektra_fetch', action='cancel', label='spektra_fetch cancel'),
        R('spektra_fetch', action='bogus', label='spektra_fetch bogus'),
        R('print_profiles'), R('printers'),
        R('printer', label='printer none'),
        R('printer', name='immage-no-such-printer', label='printer unknown'),
        R('print_profile_add', label='print_profile_add none'),
        R('print_profile_add', path='{tmp}/none.icc', label='print_profile_add missing'),
        R('softproof', label='softproof default'),
        R('softproof', mode='bogus', label='softproof bogus'),
        R('softproof', mode='off', label='softproof off'),
        R('style_forget', label='style_forget none'),
        R('style_forget', name='immage-no-such-look', label='style_forget unknown'),
        R('paste_batch', label='paste_batch none'),
        R('paste_batch', action='begin', token=1, label='paste_batch begin empty'),
        R('paste_batch', action='begin', token=1, imgids=[0], label='paste_batch begin missing'),
        R('paste_batch', action='undo', token=77, label='paste_batch unknown token'),
        R('export_hold', job=5, imgids=[0]),
        R('folder', label='folder none'),
        R('folder', path='{tmp}/no-such-folder', label='folder missing'),
        R('folder', path='{tmp}/empty', label='folder empty'),
        R('unpack', label='unpack none'),
        R('unpack', archive='{tmp}/none.zip', dir='{out}/unpacked', label='unpack missing'),
        R('import', label='import none'),
        R('import', files=['{tmp}/no-such.tif'], label='import missing'),
        R('prefetch', imgid=0),
        R('prefetch', imgids=[0, 0], label='prefetch list'),
        R('meta', imgid=0, label='meta unknown'),
        R('keywords_set', imgid=0, add=['x'], label='keywords_set unknown'),
        R('meta_set', imgid=0, label='meta_set unknown'),
        R('capture_times', label='capture_times none'),
        R('capture_times', entries=[{'imgid': 0, 'before': '', 'after': ''}],
          label='capture_times stale'),
        R('thumb', imgid=0, label='thumb no out'),
        R('thumb', '{out}/t-missing.rgba', imgid=0, size=64, out='{out}/t-missing.rgba',
          label='thumb unknown'),
        R('copy', imgid=0, label='copy unknown'),
        R('remove_copy', imgid=0, label='remove_copy unknown'),
        R('forget', imgid=0, label='forget unknown'),
        R('sidecars', imgid=0, label='sidecars unknown'),
        R('export', imgid=0, label='export no out'),
        R('export', imgid=0, out='{out}/e.jpg', label='export invalid id'),
        R('export', imgid=img, out='{out}/e.jpg', format='bogus', label='export bad format'),
        R('export', imgid=img, out='{out}/e.jpg', transient=True, quality=50,
          label='export transient mismatch'),
        R('export_release', label='export_release'),
        R('print', label='print none'),
        R('print', imgid=0, pdf='{out}/p.pdf', label='print no page'),
        R('print', imgid=0, printer='immage-no-such-printer', page=PAGE,
          label='print unknown printer'),
        R('print', pages=[], pdf='{out}/p.pdf', page=PAGE, label='print empty sheet'),
        R('hdr_merge', label='hdr_merge none'),
        R('hdr_merge', imgids=[0], label='hdr_merge invalid'),
        R('pano_merge', label='pano_merge none'),
        R('pano_merge', imgids=[0, 0], label='pano_merge invalid'),
        R('pano_preview', imgids=[img], label='pano_preview one'),
    ]


def photo_edits(img):
    """Requests on the open photo's edit: every one answers `no image open`
    with none."""
    return [
        R('history'), R('history', saved=True, label='history saved'),
        R('get', label='get none'),
        R('get', modules={'exposure': ['exposure']}, label='get exposure'),
        R('get', modules={'nosuchmodule': []}, label='get unknown module'),
        R('set', label='set none'),
        R('set', op='exposure', enabled=True, params={'exposure': 0.5}, label='set exposure'),
        R('set', op='nosuchmodule', enabled=True, label='set unknown module'),
        R('set', op='exposure', field='nosuchfield', value=1, label='set unknown field'),
        R('module_state', label='module_state none'),
        R('module_state', op='exposure', label='module_state exposure'),
        R('module_state', op='exposure', enabled=False, label='module_state off'),
        R('module_state', op='exposure', enabled=True, label='module_state on'),
        R('module_state', op='nosuchmodule', label='module_state unknown'),
        R('module_schema', label='module_schema none'),
        R('module_schema', op='nosuchmodule', label='module_schema unknown'),
        R('module_schema', op='exposure', label='module_schema exposure'),
        R('module_schema', op='tonecurve', label='module_schema tonecurve'),
        R('instances'),
        R('presets', op='exposure', priority=0, label='presets exposure'),
        R('presets', op='nosuchmodule', priority=0, label='presets unknown'),
        R('module_state', op='exposure', priority=0, preset='no such preset', label='module_state preset unknown'),
        R('module_state', op='exposure', priority=0, preset='_builtin_magic lantern defaults', reset=True, label='module_state preset and reset'),
        R('instance', label='instance none'),
        R('instance', action='new', op='exposure', priority=0, label='instance new'),
        R('instance', action='rename', op='exposure', priority=1, name='second', label='instance rename'),
        R('instance', action='move', op='exposure', priority=1, other=0, after=False, label='instance move'),
        R('instance', action='delete', op='exposure', priority=0, label='instance delete first'),
        R('instance', action='delete', op='exposure', priority=1, label='instance delete'),
        R('instance', action='restore', op='exposure', priority=1, label='instance restore'),
        R('instance', action='nosuch', op='exposure', priority=0, label='instance unknown action'),
        R('set', op='exposure', priority=7, enabled=True, params={'exposure': 0.5},
          label='set exposure priority unknown'),
        R('set', op='exposure', priority=1, instance='x', params={'exposure': 0.5},
          label='set exposure priority and instance'),
        R('get', modules={'exposure@7': ['exposure']}, label='get exposure priority unknown'),
        R('get', modules={'exposure@0': ['exposure']}, label='get exposure priority 0'),
        R('color_profiles'), R('lenses'), R('wb_presets'),
        R('render', '{out}/r.ppm', width=64, height=48, out='{out}/r.ppm', label='render ppm'),
        R('render', '{out}/r.rgba', width=64, height=48, rgba='{out}/r.rgba', label='render rgba'),
        R('render', '{out}/r.ppm', width=32, height=24, scale=1.0, x=8, y=8, out='{out}/r.ppm',
          label='render zoomed'),
        R('render', '{out}/r.ppm', width=64, height=48, draft=True, out='{out}/r.ppm',
          label='render draft'),
        R('render', '{out}/r.ppm', width=64, height=48, base=True, id=0, out='{out}/r.ppm',
          label='render base'),
        R('render', '{out}/r.ppm', width=64, height=48, skip=['exposure'], out='{out}/r.ppm',
          label='render skip'),
        R('render', width=64, height=48, have=['0000000000000000'], label='render have'),
        R('render', width=64, height=48, out='{tmp}/no-such-folder/r.ppm', label='render unwritable'),
        R('mask', label='mask none'),
        R('mask', name='m1', shapes=[CIRCLE], label='mask add'),
        R('mask', name='m2', shapes=[{'type': 'bogus'}], label='mask bad shape'),
        R('combine', label='combine none'),
        R('combine', name='c1', members=[{'mask': 'nosuchmask'}], label='combine unknown mask'),
        R('combine', name='c1', members=[{'mask': 'm1'}], label='combine add'),
        R('masks', label='masks none'),
        R('masks', fields={}, label='masks empty'),
        R('set', op='exposure', instance='m1', mask='m1', enabled=True, params={'exposure': 0.5},
          label='set masked exposure'),
        R('masks', fields={'exposure': ['exposure']}, label='masks instance'),
        R('mask_map', label='mask_map none'),
        R('mask_map', '{out}/m.rgba', name='m1', width=32, height=24, out='{out}/m.rgba',
          label='mask_map m1'),
        R('mask_rename', label='mask_rename none'),
        R('mask_rename', name='m1', to='m3', label='mask_rename'),
        R('mask_rename', name='nosuchmask', to='m4', label='mask_rename unknown'),
        R('mask_delete', label='mask_delete none'),
        R('mask_delete', name='c1', label='mask_delete c1'),
        R('mask_delete', name='m3', label='mask_delete m3'),
        R('mask_delete', name='nosuchmask', label='mask_delete unknown'),
        R('spots'), R('spots_enable', on=False, label='spots_enable off'),
        R('spots', spots=[{'type': 'circle', 'x': 0.5, 'y': 0.5, 'r': 0.1, 'sx': 0.3, 'sy': 0.3,
                           'mode': 'clone', 'feather': 0.5, 'opacity': 100},
                          {'type': 'brush', 'points': [[0.2, 0.2], [0.4, 0.3]], 'size': 0.05, 'sx': 0.6,
                           'sy': 0.6, 'mode': 'heal', 'feather': 0.5, 'opacity': 100}],
          label='spots set'),
        R('spots', label='spots read'),
        R('spots', spots=[], label='spots clear'),
        R('spot_source', label='spot_source none'),
        R('spot_source', spot={'type': 'circle', 'x': 0.5, 'y': 0.5, 'radius': 0.1},
          label='spot_source circle'),
        R('sample', label='sample default'),
        R('sample', x=0.25, y=0.75, box=[0.2, 0.2, 0.4, 0.4], label='sample box'),
        R('tone_key'), R('agx_auto', label='agx_auto without agx'),
        R('set', op='agx', enabled=True, params={}, label='set agx'), R('agx_auto'),
        R('upright', label='upright default'),
        R('upright', mode='bogus', label='upright bogus mode'),
        R('points', label='points none'),
        R('points', points=[[0.5, 0.5], [0.1, 0.9]], to='shown', label='points shown'),
        R('points', points=[[0.5, 0.5]], to='input', label='points input'),
        R('range_map', label='range_map none'),
        R('range_map', '{out}/rm.rgba', ranges=[{'type': 'luminance', 'lo': -2, 'hi': 2}],
          width=16, height=12, out='{out}/rm.rgba', label='range_map luminance'),
        R('zones', label='zones none'),
        R('zones', '{out}/z.rgba', width=16, height=12, out='{out}/z.rgba', label='zones before'),
        R('zones', width=0, height=12, out='{out}/z.rgba', label='zones empty'),
        R('look', label='look none'),
        R('look', path='{tmp}/no-such-look.dtstyle', label='look missing'),
        R('look_amount', amount=50.0),
        R('agx_presets', label='agx_presets none'),
        R('agx_presets', fields=[], label='agx_presets empty'),
        R('preview', label='preview none'),
        R('preview', '{out}/pv.rgba', rgba='{out}/pv.rgba', width=32, height=24,
          label='preview rgba'),
        R('parity', size=64, self=True, label='parity self'),
        R('parity', size=64, label='parity opencl'),
        R('ai_object', label='ai_object none'),
        R('ai_object', kind='subject', label='ai_object subject'),
        R('ai_object', kind='subject', tag=1, label='ai_object tagged'),
        R('ai_mask', kind='sky', label='ai_mask sky'),
        R('ai_depth', label='ai_depth'),
        R('ai_denoise', strength=1.0, label='ai_denoise'),
        R('ai_denoise_preview', out='{out}/dn.rgba', label='ai_denoise_preview'),
        R('before', on=True, label='before on'), R('before', on=False, label='before off'),
        R('baseline_end'),
        R('save'),
        R('module_state', op='exposure', priority=0, preset='_builtin_magic lantern defaults', label='module_state preset'),
    ]


def photo_files(img):
    """The photo's own commands, with files written to the temporary folder."""
    return [
        R('meta', imgid=img),
        R('sidecars', imgid=img),
        R('thumb', '{out}/t.rgba', imgid=img, size=64, out='{out}/t.rgba'),
        R('thumb', '{out}/t.rgba', imgid=img, size=64, proof=True, out='{out}/t.rgba',
          label='thumb proof'),
        R('thumb', imgid=img, size=64, label='thumb no out'),
        R('export', '{out}/e.jpg', imgid=img, out='{out}/e.jpg', label='export jpeg'),
        R('export', '{out}/e.tif', imgid=img, out='{out}/e.tif', format='tiff', bpp=8,
          label='export tiff'),
        R('export', '{out}/e.jpg', imgid=img, out='{out}/e.jpg', transient=True, quality=85,
          label='export transient'),
        R('print', '{out}/p.pdf', imgid=img, pdf='{out}/p.pdf', page=PAGE, area=AREA,
          label='print pdf'),
        R('print', '{out}/s.pdf', pages=[{'cells': []}], pdf='{out}/s.pdf', page=PAGE,
          label='print sheet pdf'),
        R('print', imgid=img, pdf='{out}/p.pdf', page=PAGE, area={'x': 0, 'y': 0, 'width': 99, 'height': 1},
          label='print area off page'),
        R('hdr_merge', imgids=[img], label='hdr_merge one'),
        R('pano_merge', imgids=[img], label='pano_merge one'),
        R('prefetch', imgid=img, label='prefetch photo'),
        R('keywords_set', imgid=img, add=['golden', 'golden/child'], label='keywords_set add'),
        R('keywords'),
        R('keywords_set', imgid=img, remove=['golden'], label='keywords_set remove'),
        R('meta_set', imgid=img, location={'latitude': 1.5, 'longitude': 2.5}, label='meta_set location'),
        R('meta_set', imgid=img, location={'latitude': 'x'}, label='meta_set bad location'),
        R('meta_set', imgid=img, location=None, label='meta_set clear location'),
        R('meta', imgid=img, label='meta after edits'),
        R('capture_times', entries=[{'imgid': img, 'before': '', 'after': ''}],
          label='capture_times no time'),
        R('export_hold', job=6, imgids=[img], label='export_hold photo'),
        R('paste_batch', action='begin', token=2, imgids=[img, img], label='paste_batch duplicate'),
    ]


def tagged(img):
    """Requests handed to the engine's thread pools, answered with their tag,
    and the reader thread's cancels (no reply of their own)."""
    return [
        T('thumb', '{out}/tt.rgba', imgid=img, size=64, out='{out}/tt.rgba'),
        T('export', '{out}/te.jpg', imgid=img, out='{out}/te.jpg'),
        T('export', imgid=0, out='{out}/te.jpg', label='export tagged invalid id'),
        T('export_release', job=9),
        T('print', imgid=0, page=PAGE, label='print tagged no target'),
        T('hdr_merge', imgids=[], label='hdr_merge tagged none'),
        T('pano_merge', imgids=[], label='pano_merge tagged none'),
        T('pano_preview', imgids=[], label='pano_preview tagged none'),
        T('import', files=['{tmp}/photos/a.tif'], job=3),
        T('import', files=['{tmp}/no-such.tif'], job=4, label='import tagged missing'),
        Req('cancel_base', {'cmd': 'cancel_base', 'id': 1}, silent=True),
        Req('merge_cancel', {'cmd': 'merge_cancel', 'job': 1}, silent=True),
    ]


def malformed():
    return [
        Req('unknown cmd', {'cmd': 'immage-no-such-command'}),
        Req('missing cmd', {'no': 'cmd'}),
        Req('cmd not a string', {'cmd': 7}),
        Req('invalid json', '{"cmd": "version"', raw=True),
        Req('not an object', '[1, 2]', raw=True),
        Req('rid not an int', {'cmd': 'version', 'rid': 'x'}),
    ]


def library_work(a, b, copy):
    """With no photo open and photos in the library: copies, forgetting."""
    return [
        R('keywords_set', imgid=a, add=['one'], label='keywords_set add'),
        R('capture_times', entries=[{'imgid': a, 'before': '', 'after': ''}], label='capture_times'),
        R('copy', imgid=a, label='copy a'),
        R('sidecars', imgid=a, label='sidecars after copy'),
        R('meta', imgid=copy, label='meta copy'),
        R('remove_copy', imgid=copy, label='remove_copy copy'),
        R('folder', path='{tmp}/photos', recursive=True, label='folder recursive'),
        R('forget', imgid=b, label='forget b'),
        R('meta', imgid=b, label='meta forgotten'),
    ]


class Engine:
    """The engine child and its replies, by line."""

    def __init__(self, binary, work):
        self.log_path = work / 'engine.log'
        self.log = self.log_path.open('w')
        args = [str(binary.resolve()), '--core', '--configdir', str(work / 'config'),
                '--cachedir', str(work / 'cache'), '--conf', 'opencl=false',
                '--conf', 'resourcelevel=0']
        env = os.environ | {'XDG_DATA_HOME': str(work / 'data'), 'OMP_NUM_THREADS': '2'}
        self.child = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                      stderr=self.log, text=True, env=env)
        self.fd = self.child.stdout.fileno()
        self.sel = selectors.DefaultSelector()
        self.sel.register(self.child.stdout, selectors.EVENT_READ)
        self.pending = b''
        self.replies = collections.deque()

    def write(self, line):
        self.child.stdin.write(line + '\n')
        self.child.stdin.flush()

    def read(self, timeout):
        """The next reply line, parsed, or None on timeout."""
        end = time.monotonic() + timeout
        while True:
            if b'\n' in self.pending:
                line, _, self.pending = self.pending.partition(b'\n')
                if line.strip():
                    return json.loads(line)
                continue
            left = end - time.monotonic()
            if left <= 0 or not self.sel.select(left):
                return None
            data = os.read(self.fd, 1 << 16)
            if not data:
                self.log.flush()
                tail = self.log_path.read_text(errors='replace').splitlines()[-15:]
                raise AssertionError('engine closed its output; its log ends:\n' + '\n'.join(tail))
            self.pending += data

    def stop(self):
        if self.child.poll() is None:
            self.child.kill()
        self.child.wait(timeout=30)
        self.log.close()


class Run:
    def __init__(self, args, work):
        self.work = work
        self.tmp = str(work.resolve())
        self.out = work / 'out'
        self.rid = 0
        self.timeout = args.timeout
        self.engine = Engine(args.engine, work)
        self.results = {}
        self.counts = collections.Counter()
        self.commands = set()
        self.hashes = {}
        self.fixtures = {}
        self.last_token = 0

    def norm(self, value, key=None):
        if isinstance(value, dict):
            return {k: self.norm(v, k) for k, v in value.items() if not TIMING.search(k)}
        if isinstance(value, list):
            return [self.norm(v) for v in value]
        if key == 'hash' and isinstance(value, str):
            # a frame's hash differs from run to run; which frames share one does not
            return self.hashes.setdefault(value, f'<HASH-{len(self.hashes) + 1}>')
        if isinstance(value, str):
            return VOLATILE.get(key, value.replace(self.tmp, '<TMP>'))
        return VOLATILE.get(key, value) if key in VOLATILE else value

    def fixture(self, value, key=None):
        """A reply as a fixture: real member types, run-specific values fixed."""
        if isinstance(value, dict):
            return {k: self.fixture(v, k) for k, v in value.items() if k not in ('rid', 'tag')}
        if isinstance(value, list):
            return [self.fixture(v) for v in value[:FIXTURE_ITEMS]]
        if key == 'hash' and isinstance(value, str):
            n = self.hashes.setdefault(value, f'<HASH-{len(self.hashes) + 1}>')
            return f'{int(n[6:-1]):016x}'
        if isinstance(value, float) and key and TIMING.search(key):
            return 0.0
        if isinstance(value, str):
            if key == 'version':
                return '<version>'
            if key == 'file_datetime':
                return '2000-01-01 00:00:00'
            return value.replace(self.tmp, FIXTURE_TMP)
        if isinstance(value, int) and not isinstance(value, bool) and key and TIMING.search(key):
            return 0
        return value

    def keep_fixture(self, cmd, label, reply):
        if not cmd or reply.get('ok') is not True:
            return
        reply = self.fixture(reply)
        kept = self.fixtures.setdefault(cmd, [])
        sig = json.dumps(shape(reply), sort_keys=True)
        if len(kept) < FIXTURE_KEEP and all(sig != k[0] for k in kept):
            kept.append((sig, {'label': label, 'reply': reply}))

    def fill(self, value):
        if isinstance(value, dict):
            return {k: self.fill(v) for k, v in value.items()}
        if isinstance(value, list):
            return [self.fill(v) for v in value]
        if isinstance(value, str):
            return value.replace('{tmp}', self.tmp).replace('{out}', str(self.out))
        return value

    def files(self, names):
        """What a request wrote: each file's size and hash. The photo's own
        folder is not listed, and the files are removed after."""
        found = {}
        for name in names:
            path = Path(self.fill(name))
            if path.is_file():
                data = path.read_bytes()
                found[path.name] = {'bytes': len(data)}
                # exported files and PDFs carry times and ids that differ per run
                if path.suffix not in ('.jpg', '.tif', '.pdf'):
                    found[path.name]['sha256'] = hashlib.sha256(data).hexdigest()
        shutil.rmtree(self.out, ignore_errors=True)
        self.out.mkdir()
        return found

    def send(self, req):
        if req.raw:
            self.engine.write(req.req)
            return
        data = self.fill(req.req)
        if data.get('token') == '<last-token>':
            data['token'] = self.last_token
        if not req.silent:
            self.rid += 1
            if data.get('rid') is None and 'rid' not in data:
                data['rid'] = self.rid
        if req.tagged:
            self.rid += 1
            data['tag'] = 1000 + self.rid
        self.engine.write(json.dumps(data))

    def collect(self, req):
        """The replies a request gets: its one untagged reply, or for a
        tagged one the replies carrying its tag up to the last."""
        replies = []
        if req.silent:
            # nothing answers a cancel: a later request's reply is the next
            # line, so a line that comes first is the answer to this
            self.engine.write(json.dumps({'cmd': 'version', 'rid': 0}))
            first = self.engine.read(self.timeout)
            return [first] if first and first.get('rid') != 0 else []
        while True:
            reply = self.engine.read(self.timeout)
            if reply is None:
                raise AssertionError(f'no reply in {self.timeout:.0f} s to {req.req}; the engine is stuck')
            replies.append(reply)
            if not req.tagged or 'tag' not in reply or 'ok' not in reply:
                if not req.tagged or 'tag' not in reply:
                    return replies
                continue
            if reply['ok'] is False or not ({'progress', 'step', 'stage'} & set(reply)):
                return replies

    def run_one(self, state, req):
        cmd = req.req['cmd'] if isinstance(req.req, dict) and isinstance(req.req.get('cmd'), str) else None
        if cmd:
            self.commands.add(cmd)
        self.send(req)
        replies = self.collect(req)
        if cmd == 'paste_batch' and replies and 'token' in replies[0]:
            self.last_token = replies[0]['token']
        record = {'replies': [self.norm(r) for r in replies]}
        if req.files:
            record['files'] = self.files(req.files)
        elif self.out.exists() and any(self.out.iterdir()):
            shutil.rmtree(self.out)
            self.out.mkdir()
        key = f'{state} / {req.label}'
        for r in replies:
            self.keep_fixture(cmd, key, r)
        while key in self.results:
            key += ' again'
        self.results[key] = record
        self.counts[state] += 1

    def state(self, name, reqs):
        for req in reqs:
            self.run_one(name, req)

    def go(self, photos):
        a, b = photos
        self.out.mkdir()
        # no photo, nothing in the library
        self.state('1 empty', anywhere(0) + photo_edits(0) + malformed())
        self.state('1 empty', [r for r in tagged(0) if r.label not in ('import (tagged)',)])
        # two photos in the library, none open
        self.state('2 library', [
            R('import', files=[str(a)], label='import a'),
            R('import', files=[str(b), str(a)], label='import b and a'),
        ])
        work = library_work(1, 2, 0)
        self.state('2 library', work[:3])
        copy = self.results['2 library / copy a']['replies'][0]['image']['imgid']
        self.state('2 library', library_work(1, 2, copy)[3:6])
        # the original stays: the photo opened below is its id
        self.state('2 library', library_work(1, 2, copy)[6:])
        # a paste batch's whole life, with the token the begin reply gave
        last = '<last-token>'
        self.state('2 library', [
            R('paste_batch', action='begin', token=0, imgids=[1], label='paste_batch begin'),
            R('paste_batch', action='commit', token=last, label='paste_batch commit'),
            R('paste_batch', action='undo', token=last, label='paste_batch undo'),
            R('paste_batch', action='redo', token=last, label='paste_batch redo'),
            R('paste_batch', action='release', token=last, label='paste_batch release'),
        ])
        # a photo open
        self.state('3 open', [R('open', path=str(a)), R('open', path=str(a), imgid=1, pipe='preview',
                                                         label='open preview pipe'),
                              R('open', label='open no path'),
                              R('open', path='{tmp}/no-such.tif', label='open missing')])
        self.state('3 open', [R('open', path=str(a), label='open again')])
        self.state('3 open', anywhere(1) + photo_files(1) + photo_edits(1) + tagged(1)
                   + malformed())
        # closed again
        self.state('4 closed', [R('close'), R('close', label='close again')])
        self.state('4 closed', anywhere(1) + photo_files(1) + photo_edits(1) + tagged(1)
                   + malformed())
        # a photo with a capture time (a sidecar's, as capture-time.test.mjs does), whose
        # change is the one capture_times reply that says ok
        dated = Path(self.tmp) / 'dated' / 'c.tif'
        self.state('5 dated', [R('import', files=[str(dated)], label='import dated')])
        c = self.results['5 dated / import dated']['replies'][0]['images'][0]['imgid']
        self.state('5 dated', [R('capture_times', entries=[{'imgid': c, 'before': DATED, 'after': '2026:10:31 23:59:59.625'}],
                                 label='capture_times dated')])
        self.state('5 dated', [R('quit')])


def summary(results):
    return collections.Counter(k.split(' / ')[0] for k in results)


def diff(old, new):
    problems = []
    for key in sorted(set(old) | set(new)):
        if key not in new:
            problems.append(f'{key}: missing from this run')
        elif key not in old:
            problems.append(f'{key}: not in the recording')
        elif old[key] != new[key]:
            problems.append(f'{key}:\n    was {json.dumps(old[key], sort_keys=True)[:600]}'
                            f'\n    now {json.dumps(new[key], sort_keys=True)[:600]}')
    return problems


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--engine', type=Path, default=ROOT / 'build/bin/darktable-engine')
    parser.add_argument('--timeout', type=float, default=60, help='seconds a reply may take')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--record', type=Path, metavar='FILE', help='write the normalized replies')
    mode.add_argument('--fixtures', type=Path, metavar='DIR', help='write the raw replies, per command')
    mode.add_argument('--compare', type=Path, metavar='FILE', help='diff against a recording; exit 1 on a difference')
    args = parser.parse_args()

    found = source_commands(ROOT / 'engine/main.c')
    if found != COMMANDS:
        print('engine/main.c commands differ from COMMANDS in this script:')
        print('  only in main.c:', sorted(set(found) - set(COMMANDS)))
        print('  only in script:', sorted(set(COMMANDS) - set(found)))
        return 1

    with tempfile.TemporaryDirectory(prefix='immage-protocol-') as tmp:
        work = Path(tmp).resolve()
        photos = work / 'photos'
        photos.mkdir()
        (work / 'empty').mkdir()
        files = [photos / 'a.tif', photos / 'b.tif']
        files[0].write_bytes(background.tiff(64, 48))
        (work / 'dated').mkdir()
        (work / 'dated' / 'c.tif').write_bytes(background.tiff(64, 48))
        (work / 'dated' / 'c.tif.xmp').write_text(
            '<?xml version="1.0"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF '
            'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" '
            f'xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:DateTimeOriginal="{DATED}"/></rdf:RDF></x:xmpmeta>')
        files[1].write_bytes(background.tiff(48, 64))
        run = Run(args, work)
        try:
            run.go(files)
            code = run.engine.child.wait(timeout=30)
            assert code == 0, f'engine exited with {code} after quit'
        except BaseException:
            run.engine.log.flush()
            print(run.engine.log_path.read_text(errors='replace')[-3000:], file=sys.stderr)
            raise
        finally:
            run.engine.stop()
        results = run.results

    missed = sorted(set(COMMANDS) - run.commands)
    print(f'{len(results)} requests over {len(COMMANDS)} commands in {len(summary(results))} states: '
          + ', '.join(f'{s}: {n}' for s, n in sorted(summary(results).items())))
    if missed:
        print('commands never sent:', missed)
        return 1
    if args.record:
        args.record.write_text(json.dumps(results, indent=1, sort_keys=True) + '\n')
        print(f'recorded to {args.record}')
    elif args.fixtures:
        args.fixtures.mkdir(parents=True, exist_ok=True)
        for old in args.fixtures.glob('*.json'):
            old.unlink()
        for cmd, kept in sorted(run.fixtures.items()):
            text = json.dumps([k[1] for k in kept], indent=1, sort_keys=True) + '\n'
            (args.fixtures / f'{cmd}.json').write_text(text)
        print(f'wrote fixtures for {len(run.fixtures)} commands to {args.fixtures}')
    elif args.compare:
        problems = diff(json.loads(args.compare.read_text()), results)
        for p in problems:
            print('DIFFERS', p)
        print(f'{len(problems)} of {len(results)} requests differ from {args.compare}'
              if problems else f'all {len(results)} replies match {args.compare}')
        return 1 if problems else 0
    return 0


if __name__ == '__main__':
    sys.exit(main())
