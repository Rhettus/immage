#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Headless check that a folder import and its thumbnails yield to zooming.

Opens one photo, times 100% zoom renders on an idle engine, then times the
same renders while the engine imports a folder and makes its thumbnails.
Passes when the busy median stays within --ratio of the idle median and the
background work still finishes. Run it against two engines to compare, e.g.
the one built before and after the foreground-first change (`--engine`).

`--load import export prefetch denoise` (or `all`) instead measures each
background load for the background-priority plan's stage 0: the same
foreground renders (a 100% zoom and a slider edit at fit size) idle and under
the load, the load alone and under foreground work, per-load medians and the
busy/idle ratio (flagged above --flag-ratio), and whether the foreground pipe's
modules ran on the GPU or the CPU under each load (from the engine's
`-d perf` lines; needs --opencl). `--report` writes the numbers as JSON.
No GUI is launched."""
import argparse
import collections
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import statistics
import struct
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent


def tiff(width, height):
    tags = [(256, 4, width), (257, 4, height), (258, 3, 0), (259, 3, 1), (262, 3, 2),
            (273, 4, 0), (274, 3, 1), (277, 3, 3), (278, 4, height),
            (279, 4, width * height * 3), (284, 3, 1)]
    extra = 8 + 2 + 12 * len(tags) + 4
    out = b'II' + struct.pack('<HIH', 42, 8, len(tags))
    for tag, kind, value in tags:
        count = 3 if tag == 258 else 1
        if tag == 258:
            value = extra
        elif tag == 273:
            value = extra + 6
        out += struct.pack('<HHI', tag, kind, count)
        out += struct.pack('<I', value) if kind == 4 or count > 1 else struct.pack('<H', value) + b'\0\0'
    out += struct.pack('<IHHH', 0, 8, 8, 8)
    rows = b''.join(bytes((x * 255 // width, (x * 7) % 256, 220 if (x // 16) % 2 else 25))
                    for x in range(width))
    return out + rows * height


class Engine:
    def __init__(self, binary, work, opencl=False, perf=False, models=None):
        self.log_path = work / 'engine.log'
        self.log = self.log_path.open('w')
        args = [str(binary.resolve()), '--core', '--configdir', str(work / 'config'),
                '--cachedir', str(work / 'cache'), '--conf', f'opencl={"true" if opencl else "false"}',
                '--conf', 'resourcelevel=0']
        if models:
            args += ['--models', str(models)]
        if perf:
            # the app's own flag: per-module timings, with the pipe and the device
            args += ['-d', 'perf']
        env = os.environ | {'XDG_DATA_HOME': str(work / 'data')}
        if perf and sys.platform.startswith('linux'):
            env.setdefault('OMP_WAIT_POLICY', 'passive')  # as the app starts it
        self.child = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                      stderr=self.log, text=True, env=env)
        self.sel = selectors.DefaultSelector()
        self.sel.register(self.child.stdout, selectors.EVENT_READ)
        self.fd = self.child.stdout.fileno()
        self.pending = b''
        self.replies = collections.deque()
        self.tagged = {}
        self.tag = 0

    def send(self, data):
        self.child.stdin.write(json.dumps(data) + '\n')
        self.child.stdin.flush()

    def tagged_send(self, data):
        self.tag += 1
        self.send(data | {'tag': self.tag})
        return self.tag

    def _lines(self):
        while b'\n' in self.pending:
            line, _, self.pending = self.pending.partition(b'\n')
            if not line.strip():
                continue
            reply = json.loads(line)
            if 'tag' in reply:
                self.tagged[reply['tag']] = (time.monotonic(), reply)
            else:
                self.replies.append(reply)

    def pump(self, timeout):
        """Read replies; file tagged ones, return an untagged one (os.read, so
        that lines already buffered are never missed by select)."""
        self._lines()
        if not self.replies and self.sel.select(timeout):
            data = os.read(self.fd, 1 << 16)
            if not data:
                raise AssertionError('engine closed its output')
            self.pending += data
            self._lines()
        return self.replies.popleft() if self.replies else None

    def call(self, data, timeout=120):
        """A main-loop request; tagged replies that arrive meanwhile are kept."""
        self.send(data)
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            reply = self.pump(1)
            if reply is not None:
                assert reply.get('ok'), f'{data}: {reply}'
                return reply
        raise AssertionError(f'timeout: {data}')

    def wait_tags(self, tags, timeout):
        end = time.monotonic() + timeout
        while time.monotonic() < end and not all(t in self.tagged for t in tags):
            self.pump(0.5)
        return all(t in self.tagged for t in tags)

    def cpu_seconds(self):
        """The engine's CPU time so far, or None where this cannot be read."""
        try:
            if sys.platform.startswith('linux'):
                fields = Path(f'/proc/{self.child.pid}/stat').read_text().rsplit(')', 1)[1].split()
                return (int(fields[11]) + int(fields[12])) / os.sysconf('SC_CLK_TCK')
            if sys.platform == 'darwin':
                out = subprocess.run(['ps', '-o', 'time=', '-p', str(self.child.pid)],
                                     capture_output=True, text=True).stdout.strip()
                minutes, seconds = out.split(':')
                return int(minutes) * 60 + float(seconds)
        except (OSError, ValueError, IndexError):
            pass
        return None

    def close(self):
        try:
            self.call({'cmd': 'quit'}, 30)
            self.child.wait(timeout=30)
        finally:
            if self.child.poll() is None:
                self.child.kill()


def zoom_times(engine, work, count, start=0):
    times = []
    for k in range(count):
        t = time.monotonic()
        engine.call({'cmd': 'render', 'width': 1400, 'height': 900, 'scale': 1.0,
                     'x': 100 + 60 * ((start + k) % 20), 'y': 100 + 30 * ((start + k) // 20),
                     'rgba': str(work / 'frame.rgba')})
        times.append(time.monotonic() - t)
    return times


def run(binary, files, renders, work):
    engine = Engine(binary, work)
    try:
        folder = work / 'folder'
        listed = [str(p) for p in sorted(folder.glob('*.tif'))][:files]
        engine.call({'cmd': 'open', 'path': str(work / 'open.tif')})
        # edits that make each zoom frame cost real time, as a developed raw does
        for op in ('exposure', 'denoiseprofile', 'diffuse', 'bilat'):
            engine.call({'cmd': 'set', 'op': op, 'enabled': True,
                          'params': {'exposure': 0.5} if op == 'exposure' else {}})
        zoom_times(engine, work, 3)
        idle = zoom_times(engine, work, renders, 3)

        start = time.monotonic()
        imports = [engine.tagged_send({'cmd': 'import', 'files': listed[k:k + 10], 'job': 1})
                   for k in range(0, len(listed), 10)]
        thumbs, seen = [], set()
        busy, k = [], 0
        # zoom on while the folder reads and its thumbnails render; once the
        # background work is done there is nothing left to compete with
        while k < 300:
            for t in imports:
                if t in engine.tagged and t not in seen:
                    seen.add(t)
                    for image in engine.tagged[t][1].get('images', []):
                        thumbs.append(engine.tagged_send({'cmd': 'thumb', 'imgid': image['imgid'],
                                                          'size': 240, 'out': str(work / f"t{image['imgid']}.rgba")}))
            pending = [t for t in imports + thumbs if t not in engine.tagged]
            if not pending and len(seen) == len(imports):
                break
            busy += zoom_times(engine, work, 1, k + 100)
            k += 1
        finished = engine.wait_tags(imports + thumbs, 600)
        total = time.monotonic() - start
        done = sum(len(engine.tagged[t][1].get('images', [])) for t in imports if t in engine.tagged)
        return idle, busy, finished, total, done, len(thumbs)
    finally:
        engine.close()


# ---------------------------------------------------------------- --load mode

LOADS = ('import', 'export', 'prefetch', 'denoise')
CASES = ('zoom', 'edit')
PERF_LINE = re.compile(r"\[(\w+)\] processed `([^']+)' on (GPU|CPU)")
# pipes that are background work themselves; the rest serve the foreground
BACKGROUND_PIPES = ('export', 'thumbnail')


_frames = [0]


def foreground_render(engine, work, case, k, size):
    """Time one foreground request: a 100% zoom, or a slider edit at fit size.
    Every call is a new region and a new value (k is ignored, a counter across
    all loads is used), or later phases would be cache hits."""
    _frames[0] += 1
    k = _frames[0]
    t = time.monotonic()
    if case == 'zoom':
        engine.call({'cmd': 'render', 'width': 1400, 'height': 900, 'scale': 1.0,
                     'x': 100 + 60 * (k % 20) + k // 200, 'y': 100 + 30 * ((k // 20) % 10),
                     'rgba': str(work / 'frame.rgba')})
    else:
        # a new value each time, so the frame is never a cache hit
        engine.call({'cmd': 'set', 'op': 'exposure', 'enabled': True,
                     'params': {'exposure': 0.3 + 0.0007 * k}})
        engine.call({'cmd': 'render', 'width': 1400, 'height': 900, 'draft': True,
                     'scale': min(1400 / size[0], 900 / size[1]), 'x': 0, 'y': 0,
                     'rgba': str(work / 'frame.rgba')})
    return time.monotonic() - t


def perf_tally(path, start, end):
    """Modules processed per pipe and device in a stretch of the engine's log."""
    with open(path, 'rb') as f:
        f.seek(start)
        text = f.read(max(0, end - start)).decode('utf-8', 'replace')
    tally = {}
    for match in PERF_LINE.finditer(text):
        pipe, _, device = match.groups()
        tally.setdefault(pipe, {'GPU': 0, 'CPU': 0})[device] += 1
    return tally


def log_size(engine):
    engine.log.flush()
    return engine.log_path.stat().st_size


def gpu_share(tally, pipes=None):
    gpu = cpu = 0
    for pipe, counts in tally.items():
        if pipes is None or pipe in pipes:
            gpu += counts['GPU']
            cpu += counts['CPU']
    return gpu / (gpu + cpu) if gpu + cpu else None


def wait_quiet(engine, cap=300, window=0.25, eps=0.02):
    """Seconds until the engine's CPU use stops (None where it cannot be read).
    Prefetch has no completion reply, so this stands in for one."""
    last = engine.cpu_seconds()
    if last is None:
        return None
    t0 = time.monotonic()
    while time.monotonic() - t0 < cap:
        time.sleep(window)
        now = engine.cpu_seconds()
        if now - last < eps:
            return max(0.0, time.monotonic() - t0 - window)
        last = now
    return time.monotonic() - t0


class Fixture:
    """The photos each load needs, and the open photo the foreground works on."""

    def __init__(self, args, work):
        self.args, self.work = args, work
        self.raw = args.raw
        self.ext = args.raw.suffix if args.raw else '.tif'
        self.open_path = work / f'open{self.ext}'
        if args.raw:
            shutil.copyfile(args.raw, self.open_path)
        else:
            self.open_path.write_bytes(tiff(3000, 2000))
        self.sources = {}

    def folder(self, name, count):
        """`count` distinct files, which a second set of the same size avoids
        warm caches for."""
        folder = self.work / name
        folder.mkdir()
        data = self.args.raw.read_bytes() if self.raw else tiff(2400, 1600)
        for k in range(count):
            (folder / f'p{k:04d}{self.ext}').write_bytes(data)
        return [str(p) for p in sorted(folder.glob('*' + self.ext))]


def start_import(engine, fix, files):
    imports = [engine.tagged_send({'cmd': 'import', 'files': files[k:k + 10], 'job': 1})
               for k in range(0, len(files), 10)]
    state = {'imports': imports, 'thumbs': [], 'seen': set(), 'files': len(files)}

    def poll():
        engine.pump(0)
        for t in imports:
            if t in engine.tagged and t not in state['seen']:
                state['seen'].add(t)
                for image in engine.tagged[t][1].get('images', []):
                    state['thumbs'].append(engine.tagged_send({
                        'cmd': 'thumb', 'imgid': image['imgid'], 'size': 240,
                        'out': str(fix.work / f"t{image['imgid']}.rgba")}))
        return len(state['seen']) == len(imports) and all(t in engine.tagged for t in state['thumbs'])

    def detail():
        done = sum(len(engine.tagged[t][1].get('images', [])) for t in imports if t in engine.tagged)
        return f"imported {done}/{state['files']}, {len(state['thumbs'])} thumbnails"
    return poll, detail


def start_export(engine, fix, count, label):
    tags = []
    for k in range(count):
        job = 1000 + engine.tag + k * 7 + 1
        out = fix.work / 'out' / f'{label}{k}.jpg'
        out.parent.mkdir(exist_ok=True)
        engine.call({'cmd': 'export_hold', 'job': job, 'imgids': [fix.imgid]})
        tags.append(engine.tagged_send({'cmd': 'export', 'job': job, 'imgid': fix.imgid, 'out': str(out),
                                        'format': 'jpeg', 'quality': 90, 'color_space': 'srgb'}))

    def poll():
        engine.pump(0)
        return all(t in engine.tagged for t in tags)

    def detail():
        bad = [engine.tagged[t][1].get('error') for t in tags
               if t in engine.tagged and not engine.tagged[t][1].get('ok')]
        return f'{count} exports' + (f'; failed: {bad[0]}' if bad else '')
    return poll, detail


def start_denoise(engine, fix):
    tag = engine.tag + 1
    engine.call({'cmd': 'ai_denoise', 'strength': 1.0, 'tag': tag})
    engine.tag = tag

    def poll():
        engine.pump(0)
        return tag in engine.tagged

    def detail():
        reply = engine.tagged.get(tag, (0, {}))[1]
        return 'denoised' if reply.get('ok') else f"failed: {reply.get('error')}"
    return poll, detail


def run_load(engine, fix, name, args, size):
    """One load: foreground idle, the load alone, the load under foreground work."""
    work = fix.work
    out = {'status': 'ok', 'fg': {}, 'load': {}, 'gpu': {}}
    count = {'import': args.files, 'export': args.export_count, 'prefetch': min(args.prefetch_count, 16)}.get(name, 0)
    sets = {}
    try:
        # denoise needs no photos of its own; a missing raw or model shows up
        # as an engine error when it starts, and is reported as a skip
        if name == 'import':
            files = fix.folder('import', 2 * count)
            sets = {'alone': files[:count], 'busy': files[count:]}
        elif name == 'prefetch':
            files = fix.folder('prefetch', 2 * count)
            ids = {}
            for label, part in (('alone', files[:count]), ('busy', files[count:])):
                tag = engine.tagged_send({'cmd': 'import', 'files': part, 'job': 2})
                assert engine.wait_tags([tag], 300), 'prefetch photos did not import'
                ids[label] = [i['imgid'] for i in engine.tagged[tag][1].get('images', [])]
                assert ids[label], 'prefetch photos did not import'
            sets = ids
    except AssertionError as e:
        return {'status': f'skipped: {e}'}

    def start(label):
        if name == 'import':
            return start_import(engine, fix, sets[label])
        if name == 'export':
            return start_export(engine, fix, count, label)
        if name == 'denoise':
            return start_denoise(engine, fix)
        engine.call({'cmd': 'prefetch', 'imgids': sets[label]})
        return (lambda: False), (lambda: f'{count} photos queued')

    # idle foreground baseline for this load
    for case in CASES:
        foreground_render(engine, work, case, 0, size)
    idle = {c: [] for c in CASES}
    mark = log_size(engine)
    for k in range(args.renders):
        for case in CASES:
            idle[case].append(foreground_render(engine, work, case, k + 1, size))
    out['gpu']['idle'] = perf_tally(engine.log_path, mark, log_size(engine))

    # the load alone
    mark = log_size(engine)
    t0 = time.monotonic()
    try:
        poll, detail = start('alone')
    except AssertionError as e:
        return {'status': f'skipped: {e}'}
    if name == 'prefetch':
        quiet = wait_quiet(engine)
        alone = quiet
        alone_note = 'decode time from engine CPU quiescence; the engine has no prefetch completion reply'
        if quiet is None:
            alone_note = 'cannot read the engine CPU time here; fixed window used'
    else:
        while not poll() and time.monotonic() - t0 < 600:
            time.sleep(0.02)
        alone, alone_note = time.monotonic() - t0, detail()
        if not poll():
            return {'status': 'failed: load alone did not finish in 600 s'}
        if 'failed' in alone_note:
            return {'status': 'skipped: ' + alone_note}
    out['gpu']['alone'] = perf_tally(engine.log_path, mark, log_size(engine))

    # the load under foreground work: renders back to back until it is done
    samples = {c: [] for c in CASES}
    mark = log_size(engine)
    t0 = time.monotonic()
    poll, detail = start('busy')
    window = None
    if name == 'prefetch':
        window = max(1.0, (alone or args.prefetch_window) * 0.5)
    k = 0
    while k < args.max_busy_renders:
        if window is not None and time.monotonic() - t0 >= window:
            break
        if window is None and poll():
            break
        case = CASES[k % 2]
        samples[case].append(foreground_render(engine, work, case, 100 + k, size))
        k += 1
    renders_end = time.monotonic() - t0
    finished_during = window is None and poll()
    if name == 'prefetch':
        tail = wait_quiet(engine)
        if tail is None:
            busy_total = None
            busy_note = f'ran {renders_end:.1f} s of renders; completion unknown here'
        elif tail < 0.05:
            busy_total = renders_end
            busy_note = f'finished within the {renders_end:.1f} s render window (upper bound)'
        else:
            busy_total = renders_end + tail
            busy_note = f'{tail:.1f} s of decoding left after the {renders_end:.1f} s render window'
        finished = True
    else:
        while not poll() and time.monotonic() - t0 < 600:
            time.sleep(0.02)
        finished = poll()
        busy_total, busy_note = time.monotonic() - t0, detail()
        if 'failed' in busy_note:
            finished = False
    out['gpu']['busy'] = perf_tally(engine.log_path, mark, log_size(engine))

    out['load'] = {'alone_s': alone, 'alone_note': alone_note, 'busy_s': busy_total, 'busy_note': busy_note,
                   'finished': finished, 'finished_during_renders': finished_during,
                   'slowdown': busy_total / alone if alone and alone >= 0.5 and busy_total else None}
    for case in CASES:
        mi = statistics.median(idle[case])
        mb = statistics.median(samples[case]) if samples[case] else None
        out['fg'][case] = {'idle_median_ms': mi * 1000, 'idle_n': len(idle[case]),
                           'busy_median_ms': mb * 1000 if mb else None, 'busy_n': len(samples[case]),
                           'idle_ms': [round(x * 1000, 1) for x in idle[case]],
                           'busy_ms': [round(x * 1000, 1) for x in samples[case]],
                           'ratio': mb / mi if mb else None,
                           'flagged': bool(mb and mb / mi > args.flag_ratio)}
    allidle = [x for c in CASES for x in idle[c]]
    allbusy = [x for c in CASES for x in samples[c]]
    out['fg_all'] = {'ratio': statistics.median(allbusy) / statistics.median(allidle) if allbusy else None}
    out['fg_all']['flagged'] = bool(out['fg_all']['ratio'] and out['fg_all']['ratio'] > args.flag_ratio)
    return out


def gpu_verdict(result, opencl_info):
    """Whether foreground modules left the GPU while the load ran."""
    if not opencl_info.get('running'):
        return 'no data: OpenCL was not running (pass --opencl on a machine with a GPU)'
    idle = gpu_share(result['gpu']['idle'], None)
    busy_tally = {p: c for p, c in result['gpu']['busy'].items() if p not in BACKGROUND_PIPES}
    busy = gpu_share(busy_tally)
    if idle is None or busy is None:
        return 'no data: the engine logged no module timings for the foreground pipe in one phase'
    text = f'foreground modules on the GPU: {idle * 100:.0f}% idle, {busy * 100:.0f}% under load'
    if busy < idle - 0.10:
        return text + '; FALLBACK to the CPU under load'
    return text + '; no fallback seen'


def run_loads(args, work):
    fix = Fixture(args, work)
    engine = Engine(args.engine, work, opencl=args.opencl, perf=True, models=args.models)
    report = {'engine': str(args.engine), 'raw': str(args.raw) if args.raw else 'synthetic TIFF',
              'settings': {'renders': args.renders, 'files': args.files, 'export_count': args.export_count,
                           'prefetch_count': args.prefetch_count, 'flag_ratio': args.flag_ratio,
                           'opencl_requested': args.opencl, 'cpu_count': os.cpu_count()},
              'loads': {}}
    try:
        opened = engine.call({'cmd': 'open', 'path': str(fix.open_path)})
        fix.imgid = opened['imgid']
        size = (opened['width'], opened['height'])
        for op in ('exposure', 'denoiseprofile', 'diffuse', 'bilat'):
            engine.call({'cmd': 'set', 'op': op, 'enabled': True,
                         'params': {'exposure': 0.5} if op == 'exposure' else {}})
        opencl_info = engine.call({'cmd': 'opencl'})
        report['opencl'] = {k: opencl_info.get(k) for k in ('running', 'inited', 'error_count', 'stopped')}
        report['opencl']['devices'] = [d.get('name') for d in opencl_info.get('devices', [])]
        for name in args.load:
            errors_before = engine.call({'cmd': 'opencl'}).get('error_count')
            result = run_load(engine, fix, name, args, size)
            if result['status'] == 'ok':
                result['gpu_verdict'] = gpu_verdict(result, opencl_info)
                result['opencl_errors_during'] = (engine.call({'cmd': 'opencl'}).get('error_count') or 0) - (errors_before or 0)
            report['loads'][name] = result
    finally:
        engine.close()
    return report


def print_report(report, args):
    print(f"engine {report['engine']}; photo {report['raw']}; OpenCL running: {report['opencl']['running']}")
    for name, r in report['loads'].items():
        print(f'\n== {name}')
        if r['status'] != 'ok':
            print(f"  {r['status']}")
            continue
        for case, f in r['fg'].items():
            mb = f['busy_median_ms']
            line = f"  {case:5s} idle {f['idle_median_ms']:.0f} ms (n={f['idle_n']})"
            line += f", busy {mb:.0f} ms (n={f['busy_n']}), ratio {f['ratio']:.2f}" if mb else ', busy: no samples (the load ended at once)'
            print(line + ('  FLAGGED' if f['flagged'] else ''))
            if f['busy_n'] < 3:
                print(f"        only {f['busy_n']} busy samples; raise the load size for a usable median")
        a = r['fg_all']
        if a['ratio']:
            print(f"  all   busy/idle {a['ratio']:.2f}" + (f' > {args.flag_ratio}: FLAGGED' if a['flagged'] else ''))
        l = r['load']
        alone = f"{l['alone_s']:.1f} s" if l['alone_s'] is not None else 'unknown'
        busy = f"{l['busy_s']:.1f} s" if l['busy_s'] is not None else 'unknown'
        slow = f", {l['slowdown']:.2f}x slower" if l['slowdown'] else ''
        print(f"  load alone {alone} ({l['alone_note']}); under foreground work {busy}{slow} ({l['busy_note']})")
        print(f"  GPU/CPU: {r['gpu_verdict']}")
        for phase in ('idle', 'alone', 'busy'):
            parts = [f"{p} {c['GPU']} GPU/{c['CPU']} CPU" for p, c in sorted(r['gpu'][phase].items())]
            print(f"    {phase:5s}: {'; '.join(parts) or 'no module timings'}")
        if r['opencl_errors_during']:
            print(f"  OpenCL errors counted during this load: {r['opencl_errors_during']}")
    flagged = [n for n, r in report['loads'].items() if r['status'] == 'ok'
               and any(f['flagged'] for f in r['fg'].values())]
    print(f"\nloads above {args.flag_ratio}x: {', '.join(flagged) or 'none'}"
          ' (go on to the later stages only for these)')
    return flagged



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, default=ROOT / 'build/bin/darktable-engine')
    parser.add_argument('--files', type=int, default=120)
    parser.add_argument('--renders', type=int, default=12)
    parser.add_argument('--ratio', type=float, default=1.5,
                        help='busy median may be at most this times the idle median')
    parser.add_argument('--no-assert', action='store_true', help='report only (for the old engine)')
    parser.add_argument('--load', nargs='+', choices=LOADS + ('all',),
                        help='measure these background loads (stage 0 of the background-priority plan) '
                             'instead of the import check')
    parser.add_argument('--export-count', type=int, default=4, help='photos in the export load')
    parser.add_argument('--prefetch-count', type=int, default=8, help='photos in the prefetch load (at most 16)')
    parser.add_argument('--prefetch-window', type=float, default=8,
                        help='seconds of renders against prefetch when its decode time cannot be read')
    parser.add_argument('--max-busy-renders', type=int, default=300)
    parser.add_argument('--flag-ratio', type=float, default=1.2, help='flag loads whose busy/idle ratio exceeds this')
    parser.add_argument('--raw', type=Path, help='a raw photo to open, export, prefetch and denoise (default: a synthetic TIFF)')
    parser.add_argument('--opencl', action='store_true', help='start the engine with OpenCL, to see GPU fallback')
    parser.add_argument('--models', type=Path, help='the AI models folder, for the denoise load')
    parser.add_argument('--report', type=Path, help='write the --load results here as JSON')
    args = parser.parse_args()
    if args.load:
        args.load = list(LOADS) if 'all' in args.load else args.load
        with tempfile.TemporaryDirectory(prefix='immage-priority-') as tmp:
            report = run_loads(args, Path(tmp))
        flagged = print_report(report, args)
        if args.report:
            args.report.write_text(json.dumps(report, indent=2) + '\n')
            print(f'report written to {args.report}')
        if args.no_assert:
            return
        failed = [n for n, r in report['loads'].items() if r['status'].startswith('failed')
                  or (r['status'] == 'ok' and not r['load']['finished'])]
        slow = [n for n, r in report['loads'].items() if r['status'] == 'ok'
                and any(f['ratio'] and f['ratio'] > args.ratio for f in r['fg'].values())]
        assert not failed, f'background work did not finish: {failed}'
        assert not slow, f'foreground slowed more than {args.ratio}x under: {slow}'
        print('passed; no GUI launched')
        return
    with tempfile.TemporaryDirectory(prefix='immage-priority-') as tmp:
        work = Path(tmp)
        (work / 'folder').mkdir()
        (work / 'open.tif').write_bytes(tiff(3000, 2000))
        one = tiff(2400, 1600)
        for k in range(args.files):
            (work / 'folder' / f'p{k:04d}.tif').write_bytes(one)
        idle, busy, finished, total, done, thumbs = run(args.engine, args.files, args.renders, work)
        mi, mb = statistics.median(idle), statistics.median(busy)
        print(f'engine {args.engine}')
        print(f'idle zoom median {mi * 1000:.0f} ms (max {max(idle) * 1000:.0f})')
        print(f'busy zoom median {mb * 1000:.0f} ms (max {max(busy) * 1000:.0f}), ratio {mb / mi:.2f}')
        print(f'background finished: {finished}; imported {done}/{args.files}; {thumbs} thumbnails, {len(busy)} zooms meanwhile; {total:.1f} s')
        if args.no_assert:
            return
        assert finished and done == args.files, 'background work did not finish'
        assert mb <= mi * args.ratio, f'zoom slowed {mb / mi:.2f}x while importing (limit {args.ratio}x)'
        print('passed; no GUI launched')


if __name__ == '__main__':
    main()
