#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Headless check of the engine's stuck-drive holds (engine/drives.c).

IMMAGE_TEST_STALL_DIR makes reads under one folder block until <dir>/.release
exists, and makes that folder a drive of its own. A stuck read holds that
drive: its later imports and thumbnails are answered at once as not
answering, other drives carry on, and the hold lifts when the read returns.
"""
import argparse
import json
import os
from pathlib import Path
import selectors
import struct
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent


def tiff(width=64, height=48):
    """Baseline 8-bit RGB TIFF."""
    tags = [(256, 4, width), (257, 4, height), (258, 3, 0), (259, 3, 1), (262, 3, 2),
            (273, 4, 0), (277, 3, 3), (278, 4, height), (279, 4, width * height * 3), (284, 3, 1)]
    extra = 8 + 2 + 12 * len(tags) + 4
    header = b'II' + struct.pack('<HIH', 42, 8, len(tags))
    for tag, kind, value in tags:
        count = 3 if tag == 258 else 1
        if tag == 258:
            value = extra
        elif tag == 273:
            value = extra + 6
        payload = struct.pack('<I', value) if kind == 4 or count > 1 else struct.pack('<H', value) + b'\0\0'
        header += struct.pack('<HHI', tag, kind, count) + payload
    header += struct.pack('<IHHH', 0, 8, 8, 8)
    return header + bytes((x * 7) % 256 for x in range(width * height * 3))


class Engine:
    def __init__(self, engine, work, stall):
        self.log = (work / 'engine.log').open('w')
        self.child = subprocess.Popen(
            [str(engine.resolve()), '--core', '--configdir', str(work / 'config'),
             '--cachedir', str(work / 'cache'), '--conf', 'opencl=false', '--conf', 'resourcelevel=0'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log, text=True,
            env=os.environ | {'OMP_NUM_THREADS': '2', 'OMP_WAIT_POLICY': 'passive',
                              'XDG_DATA_HOME': str(work / 'data'), 'IMMAGE_TEST_STALL_DIR': str(stall)})
        self.poll = selectors.DefaultSelector()
        self.poll.register(self.child.stdout, selectors.EVENT_READ)
        self.tag = 0
        self.early = {}

    def send(self, data):
        self.tag += 1
        self.child.stdin.write(json.dumps(data | {'tag': self.tag}) + '\n')
        self.child.stdin.flush()
        return self.tag

    def wait(self, tag, timeout=60):
        deadline = time.monotonic() + timeout
        while tag not in self.early:
            left = deadline - time.monotonic()
            assert left > 0 and self.poll.select(left), f'no reply to tag {tag}'
            reply = json.loads(self.child.stdout.readline())
            self.early[reply.get('tag')] = reply
        return self.early.pop(tag)

    def timed(self, data, timeout=60):
        start = time.monotonic()
        reply = self.wait(self.send(data), timeout)
        return reply, time.monotonic() - start

    def close(self):
        self.child.stdin.close()
        try:
            self.child.wait(30)
        except subprocess.TimeoutExpired:
            self.child.kill()
        self.log.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, default=ROOT / 'build/bin/darktable-engine')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='immage-stuck-') as tmp:
        work = Path(tmp)
        stall, ok = work / 'stall', work / 'ok'
        stall.mkdir()
        ok.mkdir()
        for p in [stall / 'a.tif', stall / 'b.tif', ok / 'c.tif']:
            p.write_bytes(tiff())
        engine = Engine(args.engine, work, stall)
        try:
            # the first stuck read is given up on after the 5 s probe and holds the drive
            reply, took = engine.timed({'cmd': 'import', 'files': [str(stall / 'a.tif')]})
            assert reply['unanswered'] == [str(stall / 'a.tif')] and reply['held'] == [str(stall)], reply
            assert 4 < took < 15, took
            # a held drive is answered at once, without a probe
            reply, took = engine.timed({'cmd': 'import', 'files': [str(stall / 'b.tif')]})
            assert reply['unanswered'] == [str(stall / 'b.tif')] and reply['held'] == [str(stall)], reply
            assert took < 1, took
            # another drive is not held
            reply, took = engine.timed({'cmd': 'import', 'files': [str(ok / 'c.tif')]})
            assert len(reply['images']) == 1 and not reply['held'] and not reply['unanswered'], reply
            # the stuck read returns: the drive answers again
            (stall / '.release').touch()
            time.sleep(0.5)
            reply, took = engine.timed({'cmd': 'import', 'files': [str(stall / 'b.tif')]})
            assert len(reply['images']) == 1 and not reply['held'], reply
        finally:
            engine.close()
            log = (work / 'engine.log').read_text(errors='replace')
        for line in ['not answering: held until its read returns', 'answering again']:
            assert line in log, f'missing log line: {line}'
    print('stuck-drive: ok')


if __name__ == '__main__':
    sys.exit(main())
