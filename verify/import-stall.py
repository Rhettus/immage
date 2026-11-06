#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Headless check that a folder import survives files that never answer.

A half-dead SMB mount once blocked one import read for 129 s while the
engine held its import lock, so opening a photo and the next folder waited
too. POSIX only: a sidecar that is a FIFO with no writer blocks every read
of it, as such a mount does. Checks that the batch skips those files within
the probe timeout and reports them as `unanswered`, imports the others, skips
the rest of the stalled folder at once, leaves an open photo unblocked, and
still imports a folder on a healthy path afterwards. No GUI is launched.

    python3 -I verify/import-stall.py [--engine build/bin/darktable-engine]"""
import argparse
import os
from pathlib import Path
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
background = __import__('background-priority')
ROOT = background.ROOT
PROBE_MS = 700


def batch(engine, files, timeout=60):
    tag = engine.tagged_send({'cmd': 'import', 'files': [str(f) for f in files], 'job': 1,
                              'probe_ms': PROBE_MS})
    assert engine.wait_tags([tag], timeout), f'import of {len(files)} files never replied'
    return engine.tagged[tag][1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, default=ROOT / 'build/bin/darktable-engine')
    args = parser.parse_args()
    assert hasattr(os, 'mkfifo'), 'needs a POSIX system'
    with tempfile.TemporaryDirectory(prefix='immage-stall-') as tmp:
        work = Path(tmp)
        photo = background.tiff(400, 300)
        (work / 'open.tif').write_bytes(photo)
        share, healthy = work / 'share', work / 'healthy'
        share.mkdir()
        healthy.mkdir()
        for k in range(4):
            (healthy / f'h{k}.tif').write_bytes(photo)
        for name in ('a', 'b', 'c'):
            (share / f'{name}.tif').write_bytes(photo)
        os.mkfifo(share / 'b.tif.xmp')  # b's sidecar never answers
        engine = background.Engine(args.engine, work)
        try:
            engine.call({'cmd': 'open', 'path': str(work / 'open.tif')})

            start = time.monotonic()
            reply = batch(engine, sorted(share.glob('*.tif')))
            took = time.monotonic() - start
            # a.tif imports; b.tif stalls; c.tif is skipped with its folder
            assert [i['filename'] for i in reply['images']] == ['a.tif'], reply
            assert reply['unanswered'] == [str(share / 'b.tif'), str(share / 'c.tif')], reply
            assert reply['done'] == 3, reply
            assert took < PROBE_MS / 1000 + 5, f'the stalled file held the batch for {took:.1f} s'

            # the stalled read must not hold the import lock: an open photo is
            # served at once while the abandoned read is still blocked
            start = time.monotonic()
            engine.call({'cmd': 'open', 'path': str(work / 'open.tif')}, 10)
            assert time.monotonic() - start < 3, 'open waited on the stalled import'

            # the folder is skipped without waiting a probe each time
            start = time.monotonic()
            again = batch(engine, [share / 'a.tif', share / 'c.tif'])
            assert len(again['unanswered']) == 2 and not again['images'], again
            assert time.monotonic() - start < PROBE_MS / 1000, 'a quarantined folder was probed again'

            # other folders are untouched
            ok = batch(engine, sorted(healthy.glob('*.tif')))
            assert len(ok['images']) == 4 and not ok['unanswered'], ok
        finally:
            # unblock the abandoned reads so the engine can quit
            for fifo in share.glob('*.xmp'):
                try:
                    fd = os.open(fifo, os.O_WRONLY | os.O_NONBLOCK)
                    os.close(fd)
                except OSError:
                    pass
            engine.close()
        print('passed; no GUI launched')


if __name__ == '__main__':
    main()
