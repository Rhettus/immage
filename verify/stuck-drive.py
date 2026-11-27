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
        release = stall / '.release'
        a_tif, b_tif, c_tif = str(stall / 'a.tif'), str(stall / 'b.tif'), str(ok / 'c.tif')
        try:
            # a photo on the drive while it answers, then the drive sticks
            release.touch()
            reply, _ = engine.timed({'cmd': 'import', 'files': [a_tif]})
            a_id = reply['images'][0]['imgid']
            release.unlink()
            # imports: the first stuck read is given up on after the 5 s
            # probe and holds the drive; later ones are answered at once,
            # by the request reader, without a probe
            reply, took = engine.timed({'cmd': 'import', 'files': [b_tif]})
            assert reply['unanswered'] == [b_tif] and reply['held'] == [str(stall)], reply
            assert 4 < took < 15, took
            reply, took = engine.timed({'cmd': 'import', 'files': [b_tif]})
            assert reply['unanswered'] == [b_tif] and reply['held'] == [str(stall)], reply
            assert took < 1, took
            # thumbnails of a held drive's photo: refused at once, by the
            # worker and, given the path, by the request reader
            for extra in [{}, {'path': a_tif}]:
                reply, took = engine.timed({'cmd': 'thumb', 'imgid': a_id, 'size': 64,
                                            'out': str(work / 'a.rgba')} | extra)
                assert not reply['ok'] and reply['held'] == [str(stall)], reply
                assert took < 1, took
            # another drive is not held
            reply, _ = engine.timed({'cmd': 'import', 'files': [c_tif]})
            assert len(reply['images']) == 1 and not reply['held'] and not reply['unanswered'], reply
            reply, _ = engine.timed({'cmd': 'thumb', 'imgid': reply['images'][0]['imgid'], 'size': 64,
                                     'out': str(work / 'c.rgba')})
            assert reply['ok'], reply
            # the stuck read returns: the drive answers again
            release.touch()
            time.sleep(0.5)
            reply, _ = engine.timed({'cmd': 'import', 'files': [b_tif]})
            assert len(reply['images']) == 1 and not reply['held'], reply
            reply, _ = engine.timed({'cmd': 'thumb', 'imgid': a_id, 'size': 64, 'path': a_tif,
                                     'out': str(work / 'a.rgba')})
            assert reply['ok'], reply
            # a thumbnail's own probe holds the drive too
            release.unlink()
            reply, took = engine.timed({'cmd': 'thumb', 'imgid': reply.get('imgid', a_id), 'size': 2000,
                                        'out': str(work / 'a2.rgba')})
            assert not reply['ok'] and reply.get('held') == [str(stall)], reply
            assert 4 < took < 15, took
            release.touch()
        finally:
            release.touch()
            engine.close()
            log = (work / 'engine.log').read_text(errors='replace')
        for line in ['not answering: held until its read returns', 'answering again',
                     'answered at once: its drive is held']:
            assert line in log, f'missing log line: {line}'
    print('stuck-drive: ok')


if __name__ == '__main__':
    sys.exit(main())
