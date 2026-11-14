#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Headless regression checks for bounded concurrent import probes.

Uses isolated engine databases and synthetic TIFFs/FIFOs. It compares import
metadata at read-ahead 1 and 4, then leaves FIFO sidecars blocked across batch
and job changes and checks the engine's diagnostic outstanding-probe count.
No GUI is launched and no real photo or sidecar is touched.

    python3 -I verify/import-read-ahead.py [--engine build/bin/darktable-engine]"""
import argparse
import os
from pathlib import Path
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
background = __import__('background-priority')
ROOT = background.ROOT
PROBE_MS = 250


def launch(binary, work, read_ahead):
    # Engine reads these at process startup. Keep the environment per-child.
    old = os.environ.copy()
    os.environ['IMMAGE_IMPORT_READ_AHEAD'] = str(read_ahead)
    os.environ['IMMAGE_IMPORT_DIAGNOSTICS'] = '1'
    try:
        return background.Engine(binary, work)
    finally:
        os.environ.clear()
        os.environ.update(old)


def import_batch(engine, files, job=1, timeout=30):
    tag = engine.tagged_send({'cmd': 'import', 'files': [str(p) for p in files],
                              'job': job, 'probe_ms': PROBE_MS})
    assert engine.wait_tags([tag], timeout), f'import timed out for {len(files)} files'
    reply = engine.tagged[tag][1]
    assert reply.get('ok'), reply
    return reply


def stable_images(reply):
    stable = []
    for row in reply['images']:
        copy = {k: v for k, v in row.items() if k not in ('imgid', 'path')}
        stable.append(copy)
    return stable


def unblock(folder):
    for fifo in folder.rglob('*.xmp'):
        if not fifo.is_fifo():
            continue
        try:
            fd = os.open(fifo, os.O_WRONLY | os.O_NONBLOCK)
            os.close(fd)
        except OSError:
            pass


def metadata_check(binary, root):
    photo = background.tiff(400, 300)
    replies = []
    sidecar = ('<?xml version="1.0"?><x:xmpmeta xmlns:x="adobe:ns:meta/">'
               '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
               '<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" '
               'xmp:Rating="3" xmlns:dc="http://purl.org/dc/elements/1.1/">'
               '<dc:subject><rdf:Bag><rdf:li>read-ahead-regression</rdf:li></rdf:Bag></dc:subject>'
               '</rdf:Description></rdf:RDF></x:xmpmeta>').encode()
    for limit in (1, 4):
        work = root / f'metadata-{limit}'
        work.mkdir()
        folder = work / 'photos'
        folder.mkdir()
        for name in ('alpha', 'bravo', 'charlie', 'delta'):
            path = folder / f'{name}.tif'
            path.write_bytes(photo)
            os.utime(path, (1_700_000_000, 1_700_000_000))
            if name == 'alpha':
                Path(str(path) + '.xmp').write_bytes(sidecar)
        engine = launch(binary, work, limit)
        try:
            reply = import_batch(engine, sorted(folder.glob('*.tif')))
            assert reply.get('done') == 4 and not reply.get('unanswered'), reply
            alpha = next(row for row in reply['images'] if row['filename'] == 'alpha.tif')
            assert alpha['rating'] == 3 and 'read-ahead-regression' in alpha['keywords'], alpha
            assert Path(str(folder / 'alpha.tif') + '.xmp').read_bytes() == sidecar
            replies.append(stable_images(reply))
        finally:
            engine.close()
    assert replies[0] == replies[1], 'read-ahead changed imported metadata or image order'


def stall_cap_check(binary, root):
    work = root / 'stalls'
    work.mkdir()
    folder_a, folder_b, healthy = (work / n for n in ('a', 'b', 'healthy'))
    for folder in (folder_a, folder_b, healthy):
        folder.mkdir()
    photo = background.tiff(64, 48)
    for folder, prefix, count in ((folder_a, 'a', 8), (folder_b, 'b', 8), (healthy, 'h', 2)):
        for i in range(count):
            path = folder / f'{prefix}{i}.tif'
            path.write_bytes(photo)
            if folder != healthy:
                os.mkfifo(Path(str(path) + '.xmp'))
            os.utime(path, (1_700_000_000, 1_700_000_000))

    engine = launch(binary, work, 4)
    try:
        # A main-thread request completes startup before we measure cancellation.
        engine.call({'cmd': 'open', 'path': str(next(healthy.glob('*.tif')))}, 60)
        # Let the first job populate the shared probe pool, then switch jobs
        # while those FIFO reads remain unanswered.
        first = engine.tagged_send({'cmd': 'import', 'files': [str(p) for p in sorted(folder_a.glob('*.tif'))],
                                    'job': 11, 'probe_ms': PROBE_MS})
        time.sleep(0.08)
        second = engine.tagged_send({'cmd': 'import', 'files': [str(p) for p in sorted(folder_b.glob('*.tif'))],
                                     'job': 12, 'probe_ms': PROBE_MS})
        assert engine.wait_tags([first, second], 15), 'stalled import batches did not return'
        one = engine.tagged[first][1]
        two = engine.tagged[second][1]
        assert one.get('ok') and two.get('ok'), (one, two)
        assert one.get('done', 8) < 8, f'newer job did not cancel the first batch: {one}'
        assert two.get('unanswered'), f'second job did not observe the shared cap: {two}'
        # Quarantined files in the same folder should be skipped together.
        saturated_reply = import_batch(engine, sorted(healthy.glob('*.tif')), job=13)
        assert saturated_reply.get('done') == 2 and saturated_reply.get('unanswered'), saturated_reply
        assert not saturated_reply.get('images'), saturated_reply
        # Free the blocked filesystem reads, then verify the process recovers.
        unblock(work)
        deadline = time.monotonic() + 5
        while True:
            healthy_reply = import_batch(engine, sorted(healthy.glob('*.tif')), job=14)
            if not healthy_reply.get('unanswered'):
                break
            assert time.monotonic() < deadline, f'probe slots did not recover: {healthy_reply}'
            time.sleep(0.05)
        assert healthy_reply.get('done') == 2 and len(healthy_reply.get('images', [])) == 2, healthy_reply
        engine.log.flush()
        logs = engine.log_path.read_text(errors='replace')
        summaries = [line for line in logs.splitlines() if 'import diagnostics:' in line]
        assert summaries, 'diagnostics did not report outstanding probe counts'
        max_active = [int(line.split('max_active=', 1)[1].split()[0]) for line in summaries
                      if 'max_active=' in line]
        saturated = [int(line.split('saturated=', 1)[1].split()[0]) for line in summaries
                     if 'saturated=' in line]
        assert max_active and max(max_active) <= 4, f'global outstanding probes exceeded limit 4: {max_active}'
        assert saturated and max(saturated) > 0, f'expected capacity saturation across jobs: {summaries}'
    finally:
        unblock(work)
        engine.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, default=ROOT / 'build/bin/darktable-engine')
    args = parser.parse_args()
    assert os.name == 'posix' and hasattr(os, 'mkfifo'), 'requires POSIX FIFOs'
    assert args.engine.is_file(), f'engine not found: {args.engine}'
    with tempfile.TemporaryDirectory(prefix='immage-read-ahead-') as tmp:
        root = Path(tmp)
        metadata_check(args.engine, root)
        stall_cap_check(args.engine, root)
    print('passed; metadata matches and outstanding probes stayed within the cap; no GUI launched')


if __name__ == '__main__':
    main()
