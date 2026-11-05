#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Headless check that a folder import and its thumbnails yield to zooming.

Opens one photo, times 100% zoom renders on an idle engine, then times the
same renders while the engine imports a folder and makes its thumbnails.
Passes when the busy median stays within --ratio of the idle median and the
background work still finishes. Run it against two engines to compare, e.g.
the one built before and after the foreground-first change (`--engine`).
No GUI is launched."""
import argparse
import json
import os
from pathlib import Path
import selectors
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
    def __init__(self, binary, work):
        self.log = (work / 'engine.log').open('w')
        self.child = subprocess.Popen(
            [str(binary.resolve()), '--core', '--configdir', str(work / 'config'),
             '--cachedir', str(work / 'cache'), '--conf', 'opencl=false',
             '--conf', 'resourcelevel=0'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=self.log, text=True, env=os.environ | {'XDG_DATA_HOME': str(work / 'data')})
        self.sel = selectors.DefaultSelector()
        self.sel.register(self.child.stdout, selectors.EVENT_READ)
        self.tagged = {}
        self.tag = 0

    def send(self, data):
        self.child.stdin.write(json.dumps(data) + '\n')
        self.child.stdin.flush()

    def tagged_send(self, data):
        self.tag += 1
        self.send(data | {'tag': self.tag})
        return self.tag

    def pump(self, timeout):
        """Read one reply line; file tagged ones, return an untagged one."""
        if not self.sel.select(timeout):
            return None
        reply = json.loads(self.child.stdout.readline())
        if 'tag' in reply:
            self.tagged[reply['tag']] = (time.monotonic(), reply)
            return None
        return reply

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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, default=ROOT / 'build/bin/darktable-engine')
    parser.add_argument('--files', type=int, default=120)
    parser.add_argument('--renders', type=int, default=12)
    parser.add_argument('--ratio', type=float, default=1.5,
                        help='busy median may be at most this times the idle median')
    parser.add_argument('--no-assert', action='store_true', help='report only (for the old engine)')
    args = parser.parse_args()
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
