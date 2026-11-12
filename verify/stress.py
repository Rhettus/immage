#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Headless concurrency stress: photos opening and closing while thumbnails,
an import and exports run beside them.

For --duration seconds (default 120) four client threads share one engine:

  opener   opens a photo, renders a small frame, edits, renders again and
           closes it, as fast as the engine answers (main-loop requests)
  thumbs   tagged `thumb` requests for imported photos (the thumbnail
           threads); each frame file must be exactly width x height x 4 bytes
  importer tagged `import` of batches of new hard-linked copies of the
           fixtures (the import thread); each reply must list every file
  exporter export_hold, tagged `export` to JPEG (the export thread) and
           export_release; each output must be a whole JPEG of the fixture's
           size

Every request must get its reply within --timeout (default 120 s), no reply
may be an error for a request that should succeed, the engine must not exit,
and it must still answer (and open and render a photo) when the threads stop.
Counts per request kind are printed. Violations are reported as in
hostile-inputs.py (KNOWN BUG lines do not fail the run, unless --strict).

The checks find hangs, deadlocks, crashes and wrong replies; data races and
lock-order mistakes surface better with an engine built with assertions and
the lock-order check (engine/engine.h, ENG_LOCK_DEBUG, on in debug builds
without NDEBUG: pass --engine) or built with ThreadSanitizer
(-DCMAKE_C_FLAGS=-fsanitize=thread). Not built here. CPU heavy: it keeps
every core busy for the duration.

    flock <lock> python3 -I verify/stress.py [--engine build/bin/darktable-engine]
        [--duration 120] [--timeout 120] [--seed 1] [--strict]"""
import argparse
import json
import os
from pathlib import Path
import random
import shutil
import struct
import sys
import tempfile
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
engine_session = __import__('engine_session')
Eng, EngineDied, Report = engine_session.Eng, engine_session.EngineDied, engine_session.Report
ROOT, tiff = engine_session.ROOT, engine_session.tiff

KNOWN = {}

FIXTURES = ((1600, 1200), (2000, 1333), (2400, 1600))


class Mux:
    """One engine, many client threads: replies are matched to their request
    by `rid` (main-loop requests) or `tag` (the pools'), by a reader thread."""

    def __init__(self, eng):
        self.eng = eng
        self.cv = threading.Condition()
        self.replies = {}
        self.dead = None
        self.next = 0
        self.wlock = threading.Lock()
        self.fd = eng.child.stdout.fileno()
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        buf = b''
        while True:
            try:
                data = os.read(self.fd, 1 << 16)
            except OSError:
                data = b''
            if not data:
                with self.cv:
                    self.dead = self.eng.exit_text()
                    self.cv.notify_all()
                return
            buf += data
            while b'\n' in buf:
                line, _, buf = buf.partition(b'\n')
                if not line.strip():
                    continue
                try:
                    reply = json.loads(line)
                except ValueError:
                    with self.cv:
                        self.replies[('bad', len(self.replies))] = {'ok': False, 'error': 'reply is not JSON: ' + line[:80].decode('latin-1')}
                        self.cv.notify_all()
                    continue
                key = ('tag', reply['tag']) if 'tag' in reply else ('rid', reply.get('rid'))
                with self.cv:
                    self.replies[key] = reply
                    self.cv.notify_all()

    def request(self, data, timeout, tagged=False):
        """(reply or None, seconds). Raises EngineDied if the engine exits."""
        with self.wlock:
            self.next += 1
            n = self.next
            key = ('tag', n) if tagged else ('rid', n)
            self.eng.send_raw((json.dumps(data | ({'tag': n} if tagged else {'rid': n})) + '\n').encode())
        t0 = time.monotonic()
        end = t0 + timeout
        with self.cv:
            while key not in self.replies:
                if self.dead:
                    raise EngineDied(self.dead)
                left = end - time.monotonic()
                if left <= 0:
                    return None, time.monotonic() - t0
                self.cv.wait(min(left, 1.0))
            return self.replies.pop(key), time.monotonic() - t0


def jpeg_size(path):
    """(width, height) of a whole JPEG, or None."""
    data = path.read_bytes()
    if data[:2] != b'\xff\xd8' or data[-2:] != b'\xff\xd9':
        return None
    i = 2
    while i + 4 <= len(data):
        if data[i] != 0xFF:
            return None
        marker = data[i + 1]
        if marker in (0xC0, 0xC1, 0xC2):
            h, w = struct.unpack('>HH', data[i + 5:i + 9])
            return w, h
        if marker == 0xDA:
            return None
        i += 2 + struct.unpack('>H', data[i + 2:i + 4])[0]
    return None


class Stress:
    def __init__(self, args, work, mux, report):
        self.args, self.work, self.mux, self.report = args, work, mux, report
        self.deadline = time.monotonic() + args.duration
        self.counts = {}
        self.lock = threading.Lock()
        self.fixtures = []
        self.imported = []   # (imgid, (w, h))
        self.stop = threading.Event()
        self.problems = []

    def count(self, kind):
        with self.lock:
            self.counts[kind] = self.counts.get(kind, 0) + 1

    def problem(self, key, text):
        with self.lock:
            self.problems.append((key, text))
        self.stop.set() if key.startswith('crash') else None

    def call(self, kind, data, tagged=False, expect_ok=True):
        try:
            reply, secs = self.mux.request(data, self.args.timeout, tagged)
        except EngineDied as e:
            self.problem(f'crash|{kind}', f'engine exited during {kind}: {e}')
            return None
        if reply is None:
            self.problem(f'no-reply|{kind}', f'{kind}: no reply in {self.args.timeout} s to {json.dumps(data)[:200]}')
            return None
        self.count(kind)
        if expect_ok and not reply.get('ok'):
            self.problem(f'error|{kind}', f'{kind}: {reply.get("error")} (request {json.dumps(data)[:200]})')
            return None
        return reply

    def running(self):
        return time.monotonic() < self.deadline and not self.stop.is_set()

    def opener(self):
        rng = random.Random(f'{self.args.seed}:open')
        k = 0
        while self.running():
            path, dim = rng.choice(self.fixtures)
            if not self.call('open', {'cmd': 'open', 'path': str(path)}):
                continue
            fit = min(500 / dim[0], 330 / dim[1])
            frame = {'cmd': 'render', 'width': 500, 'height': 330, 'scale': fit, 'x': 0, 'y': 0,
                     'rgba': str(self.work / 'open.rgba')}
            self.call('render', frame)
            if rng.random() < 0.7:
                self.call('set', {'cmd': 'set', 'op': 'exposure', 'enabled': True,
                                  'params': {'exposure': rng.uniform(-1, 1)}})
                self.call('render', frame | {'draft': True})
            if rng.random() < 0.3:
                self.call('save', {'cmd': 'save'})
            self.call('close', {'cmd': 'close'})
            k += 1

    def thumbs(self):
        rng = random.Random(f'{self.args.seed}:thumb')
        out = self.work / 'thumbs'
        out.mkdir(exist_ok=True)
        n = 0
        while self.running():
            with self.lock:
                pool = list(self.imported)
            if not pool:
                time.sleep(0.05)
                continue
            imgid, dim = rng.choice(pool)
            dest = out / f't{n % 8}.rgba'
            n += 1
            size = rng.choice([64, 128, 256])
            # the file is shared by up to eight in flight at once only if n wraps; one request at a time here
            reply = self.call('thumb', {'cmd': 'thumb', 'imgid': imgid, 'size': size, 'out': str(dest)}, tagged=True)
            if reply:
                want = 4 * reply['width'] * reply['height']
                got = dest.stat().st_size if dest.exists() else -1
                if got != want:
                    self.problem('bad-output|thumb', f'thumb of {imgid}: frame file is {got} bytes, {reply["width"]}x{reply["height"]} needs {want}')

    def importer(self):
        folder = self.work / 'import'
        folder.mkdir(exist_ok=True)
        rnd = 0
        while self.running():
            files = []
            for k in range(6):
                src, dim = self.fixtures[(rnd + k) % len(self.fixtures)]
                dst = folder / f'imp{rnd:04d}_{k}.tif'
                try:
                    dst.hardlink_to(src)
                except OSError:
                    shutil.copyfile(src, dst)
                files.append(str(dst))
            rnd += 1
            reply = self.call('import', {'cmd': 'import', 'files': files, 'job': rnd}, tagged=True)
            if reply:
                images = reply.get('images', [])
                if len(images) != len(files) or reply.get('done') != len(files):
                    self.problem('bad-output|import', f'import of {len(files)} files listed {len(images)}, done {reply.get("done")}')
                with self.lock:
                    for img in images[:3]:
                        self.imported.append((img['imgid'], (img['width'], img['height'])))
                    self.imported = self.imported[-60:]

    def exporter(self):
        out = self.work / 'export'
        out.mkdir(exist_ok=True)
        job = 5000
        while self.running():
            with self.lock:
                pool = list(self.imported)
            if not pool:
                time.sleep(0.05)
                continue
            imgid, dim = pool[job % len(pool)]
            job += 1
            dest = out / f'e{job % 4}.jpg'
            dest.unlink(missing_ok=True)
            if not self.call('export_hold', {'cmd': 'export_hold', 'job': job, 'imgids': [imgid]}):
                continue
            reply = self.call('export', {'cmd': 'export', 'job': job, 'imgid': imgid, 'out': str(dest),
                                         'format': 'jpeg', 'quality': 85, 'color_space': 'srgb'}, tagged=True)
            if reply:
                got = jpeg_size(dest) if dest.exists() else None
                if got != dim:
                    self.problem('bad-output|export', f'export of {imgid}: file is {"missing" if not dest.exists() else got}, '
                                                      f'photo is {dim}')
            self.call('export_release', {'cmd': 'export_release', 'job': job}, tagged=True)

    def run(self):
        threads = [threading.Thread(target=getattr(self, n), name=n, daemon=True)
                   for n in ('opener', 'thumbs', 'importer', 'exporter')]
        for t in threads:
            t.start()
        for t in threads:
            t.join(self.args.duration + self.args.timeout + 30)
        stuck = [t.name for t in threads if t.is_alive()]
        if stuck:
            self.problem('hang|threads', f'client threads did not finish: {stuck}')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--engine', type=Path, default=ROOT / 'build/bin/darktable-engine')
    parser.add_argument('--duration', type=float, default=120)
    parser.add_argument('--timeout', type=float, default=120, help='seconds to wait for one reply')
    parser.add_argument('--seed', default='1')
    parser.add_argument('--strict', action='store_true')
    args = parser.parse_args()
    report = Report(KNOWN, args.strict)
    print(engine_session.require_memory('running'))
    tmp = Path(tempfile.mkdtemp(prefix='immage-stress-'))
    eng = None
    try:
        eng = Eng(args.engine, tmp / 'eng', limit_gib=None)
        mux = Mux(eng)
        stress = Stress(args, tmp, mux, report)
        for k, dim in enumerate(FIXTURES):
            p = tmp / f'fixture{k}.tif'
            p.write_bytes(tiff(*dim))
            stress.fixtures.append((p, dim))
        # a few photos to thumbnail and export from the start
        first, _ = mux.request({'cmd': 'import', 'files': [str(p) for p, _ in stress.fixtures]}, 120)
        for img in first['images']:
            stress.imported.append((img['imgid'], (img['width'], img['height'])))
        print(f'stressing for {args.duration:.0f} s')
        t0 = time.monotonic()
        stress.run()
        print(f'ran {time.monotonic() - t0:.0f} s; requests answered: '
              + ', '.join(f'{k} {v}' for k, v in sorted(stress.counts.items())))
        for key, text in stress.problems[:60]:
            report.bug(key, text)
        if not stress.problems:
            report.ok('every request answered in time and every output was whole')
        try:
            reply, _ = mux.request({'cmd': 'version'}, 60)
            opened, _ = mux.request({'cmd': 'open', 'path': str(stress.fixtures[0][0])}, 60)
            rendered, _ = mux.request({'cmd': 'render', 'width': 200, 'height': 130, 'scale': 0.1, 'x': 0, 'y': 0,
                                       'rgba': str(tmp / 'final.rgba')}, 60)
            if reply and reply.get('ok') and opened and opened.get('ok') and rendered and rendered.get('ok'):
                report.ok('engine responsive at the end (version, open, render)')
            else:
                report.bug('unresponsive|end', f'engine did not answer at the end: {reply} {opened} {rendered}')
        except EngineDied as e:
            report.bug('crash|end', str(e))
        if not eng.alive():
            report.bug('crash|exit', 'engine is not running at the end')
    finally:
        if eng is not None:
            try:
                eng.send_raw(b'{"cmd":"quit"}\n')
                eng.child.wait(timeout=30)
            except Exception:
                pass
            eng.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)
    sys.exit(report.finish())


if __name__ == '__main__':
    main()
