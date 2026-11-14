#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Headless metadata-pipeline parity and bounded abandoned-worker checks.

Uses temporary ORFs/TIFFs and FIFO sidecars; never touches original photos.
"""
import argparse
import os
from pathlib import Path
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
background = __import__('background-priority')
probe_checks = __import__('import-read-ahead')


def launch(binary, work, workers):
    previous = os.environ.copy()
    os.environ.update(IMMAGE_IMPORT_METADATA_WORKERS=str(workers),
                      IMMAGE_IMPORT_METADATA_TIMEOUT_MS='400',
                      IMMAGE_IMPORT_READ_AHEAD='1', IMMAGE_METADATA_PREFIX='1',
                      IMMAGE_IMPORT_DIAGNOSTICS='1', IMMAGE_METADATA_IO_DIAGNOSTICS='1')
    try:
        return background.Engine(binary, work)
    finally:
        os.environ.clear()
        os.environ.update(previous)


def batch(engine, files, job):
    tag = engine.tagged_send({'cmd': 'import', 'files': [str(p) for p in files],
                              'job': job, 'probe_ms': 200})
    assert engine.wait_tags([tag], 15), 'pipeline batch did not finish'
    reply = engine.tagged[tag][1]
    assert reply.get('ok'), reply
    return reply


def parity(binary, root):
    folder = root / 'photos'
    folder.mkdir()
    tiff = background.tiff(64, 48)
    orf = b'IIRO' + tiff[4:]
    files = []
    for name in ('a.orf', 'b.ORF', 'c.orf', 'd.orf', 'other.tif'):
        path = folder / name
        path.write_bytes(tiff if name.endswith('.tif') else orf)
        os.utime(path, (1700000000, 1700000000))
        files.append(path)
    sidecar = Path(str(files[0]) + '.xmp')
    sidecar_bytes = (b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF '
                     b'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
                     b'<rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" '
                     b'xmp:Rating="3"/></rdf:RDF></x:xmpmeta>')
    sidecar.write_bytes(sidecar_bytes)
    reference = None
    for workers in (0, 1, 2, 3, 4):
        work = root / f'parity-{workers}'
        work.mkdir()
        engine = launch(binary, work, workers)
        try:
            reply = batch(engine, files, 1)
            assert reply.get('done') == len(files) and not reply.get('unanswered'), reply
            images = probe_checks.stable_images(reply)
            assert len(images) == len(files), reply
            assert images[0]['rating'] == 3, images[0]
            if reference is None:
                reference = images
            else:
                assert images == reference, f'metadata differs with {workers} workers'
        finally:
            engine.close()
        if workers:
            logs = engine.log_path.read_text(errors='replace')
            assert logs.count('IMMAGE_METADATA_PREFETCH') == 4, logs[-4000:]
    assert sidecar.read_bytes() == sidecar_bytes


def abandoned_workers(binary, root):
    work = root / 'abandoned'
    work.mkdir()
    tiff = background.tiff(64, 48)
    blocked = work / 'blocked'
    healthy = work / 'healthy'
    blocked.mkdir()
    healthy.mkdir()
    stalled = []
    for i in range(8):
        path = blocked / f'{i}.orf'
        path.write_bytes(b'IIRO' + tiff[4:])
        os.mkfifo(str(path) + '.xmp')
        stalled.append(path)
    good = healthy / 'good.orf'
    good.write_bytes(b'IIRO' + tiff[4:])
    engine = launch(binary, work, 4)
    try:
        batch(engine, [], 1)  # exclude startup from cancellation timing
        first = engine.tagged_send({'cmd': 'import', 'files': [str(p) for p in stalled], 'job': 11})
        time.sleep(0.08)
        second = engine.tagged_send({'cmd': 'import', 'files': [str(good)], 'job': 12})
        assert engine.wait_tags([first, second], 15), 'cancelled worker batches did not return'
        cancelled = engine.tagged[first][1]
        saturated = engine.tagged[second][1]
        assert cancelled.get('done', 8) < 8, cancelled
        assert saturated.get('unanswered') and not saturated.get('images'), saturated
        # All abandoned workers remain capped until their actual reads return.
        for job in range(13, 16):
            reply = batch(engine, [good], job)
            assert reply.get('unanswered') and not reply.get('images'), reply
        probe_checks.unblock(work)
        deadline = time.monotonic() + 5
        while True:
            reply = batch(engine, [good], 20)
            if not reply.get('unanswered'):
                break
            assert time.monotonic() < deadline, 'worker slots did not recover'
            time.sleep(0.05)
        assert len(reply.get('images', [])) == 1, reply
        # A real task timeout releases the batch promptly, while blocked reads
        # continue to occupy slots. No remaining staged tasks get a new wait.
        started = time.monotonic()
        reply = batch(engine, stalled, 30)
        assert reply.get('done') == len(stalled) and reply.get('unanswered'), reply
        assert time.monotonic() - started < 2, 'timeout waited for every staged worker'
        probe_checks.unblock(work)
    finally:
        probe_checks.unblock(work)
        engine.close()


def blocked_shutdown(binary, root):
    work = root / 'shutdown'
    work.mkdir()
    photo = work / 'blocked.orf'
    photo.write_bytes(b'IIRO' + background.tiff(64, 48)[4:])
    os.mkfifo(str(photo) + '.xmp')
    engine = launch(binary, work, 1)
    try:
        reply = batch(engine, [photo], 1)
        assert reply.get('unanswered'), reply
        started = time.monotonic()
        engine.close()
        assert time.monotonic() - started < 3, 'shutdown waited for blocked filesystem read'
        assert engine.child.returncode == 0, engine.child.returncode
        logs = engine.log_path.read_text(errors='replace')
        assert 'exiting without global teardown' in logs, logs[-2000:]
    finally:
        if engine.child.poll() is None:
            engine.child.kill()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, default=background.ROOT / 'build/bin/darktable-engine')
    args = parser.parse_args()
    assert hasattr(os, 'mkfifo'), 'requires POSIX FIFOs'
    with tempfile.TemporaryDirectory(prefix='immage-metadata-pipeline-') as temp:
        root = Path(temp)
        parity(args.engine, root)
        abandoned_workers(args.engine, root)
        blocked_shutdown(args.engine, root)
    print('passed; parity 0–4 workers, cancellation/timeout/cap/recovery/shutdown; no GUI launched')


if __name__ == '__main__':
    main()
