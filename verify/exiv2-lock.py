#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""A large photo's metadata read does not hold up other photos (Linux, headless).

A 480 MB TIFF with its directory after the pixels, as libtiff writes it, is
past the 16 MB metadata prefix, so its whole file is read. verify/slowread.c
makes that read take about 5 s. Meanwhile a small TIFF's thumbnail must not
wait on darktable's global exiv2 lock for it.

    python3 -I verify/exiv2-lock.py [--engine build/bin/darktable-engine]"""
import argparse
import importlib.util
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('background', ROOT / 'verify/background-priority.py')
background = importlib.util.module_from_spec(spec)
spec.loader.exec_module(background)
LIMIT_MS = 1000


def tiff_tail(path, width, height):
    # 8-bit RGB, one strip, IFD0 after the pixels
    pixels = width * height * 3
    ifd = 8 + pixels
    tags = [(256, 4, width), (257, 4, height), (258, 3, None), (259, 3, 1), (262, 3, 2),
            (273, 4, 8), (274, 3, 1), (277, 3, 3), (278, 4, height), (279, 4, pixels), (284, 3, 1)]
    extra = ifd + 2 + 12 * len(tags) + 4
    row = b''.join(bytes((x * 255 // width, (x * 7) % 256, 220 if (x // 16) % 2 else 25))
                   for x in range(width))
    with path.open('wb') as f:
        f.write(b'II' + struct.pack('<HI', 42, ifd))
        for _ in range(height):
            f.write(row)
        f.write(struct.pack('<H', len(tags)))
        for tag, kind, value in tags:
            if tag == 258:
                f.write(struct.pack('<HHII', tag, kind, 3, extra))
            elif kind == 4:
                f.write(struct.pack('<HHII', tag, kind, 1, value))
            else:
                f.write(struct.pack('<HHIH', tag, kind, 1, value) + b'\0\0')
        f.write(struct.pack('<IHHH', 0, 8, 8, 8))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, default=ROOT / 'build/bin/darktable-engine')
    args = parser.parse_args()
    if not sys.platform.startswith('linux'):
        print('skipped: slowread.c is built for Linux only')
        return
    with tempfile.TemporaryDirectory(prefix='immage-exiv2-lock-') as tmp:
        work = Path(tmp)
        shim = work / 'slowread.so'
        subprocess.run(['cc', '-shared', '-fPIC', '-O2', '-o', str(shim), str(ROOT / 'verify/slowread.c'),
                        '-ldl'], check=True)
        (work / 'small.tif').write_bytes(background.tiff(400, 300))
        big = work / 'slowread-big.tif'
        tiff_tail(big, 20000, 8000)
        os.environ['LD_PRELOAD'] = str(shim)
        engine = background.Engine(args.engine, work)
        del os.environ['LD_PRELOAD']
        try:
            tag = engine.tagged_send({'cmd': 'import', 'files': [str(work / 'small.tif')]})
            assert engine.wait_tags([tag], 60), 'small import never replied'
            imgid = engine.tagged[tag][1]['images'][0]['imgid']

            start = time.monotonic()
            slow = engine.tagged_send({'cmd': 'import', 'files': [str(big)], 'job': 1})
            time.sleep(1.0)  # past the prefixes, into the whole-file read
            asked = time.monotonic()
            thumb = engine.tagged_send({'cmd': 'thumb', 'imgid': imgid, 'size': 240,
                                        'out': str(work / 'small.rgba')})
            assert engine.wait_tags([thumb], 120), 'thumbnail never replied'
            waited = (engine.tagged[thumb][0] - asked) * 1000
            assert engine.tagged[thumb][1].get('ok'), engine.tagged[thumb][1]
            assert engine.wait_tags([slow], 120), 'large import never replied'
            took = (engine.tagged[slow][0] - start) * 1000
            reply = engine.tagged[slow][1]
            assert [i['filename'] for i in reply['images']] == [big.name], reply
            print(f'large import {took:.0f} ms; small thumbnail meanwhile {waited:.0f} ms (limit {LIMIT_MS})')
            assert took > 3000, 'the slow read did not happen: is slowread.c loaded?'
            assert waited < LIMIT_MS, 'the small thumbnail waited for the large file\'s metadata read'
            print('PASS')
        finally:
            engine.close()


if __name__ == '__main__':
    main()
