#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Measure ORF prefix metadata reads with import probe limits 1 through 4.

    python3 -I benchmarking/orf-prefix-concurrency.py PHOTO_FOLDER --recursive

Each sample uses a fresh headless engine and isolated state. Prefix reads stay
enabled for every sample; only the overlap limit for 4 KB photo/XMP probes
changes. Metadata imports themselves remain serialized.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import statistics
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'verify'))
background = __import__('background-priority')
LIMITS = (1, 2, 3, 4)
IMPORT_DIAGNOSTIC = 'import diagnostics:'

_spec = importlib.util.spec_from_file_location(
    'orf_partial_reads', Path(__file__).with_name('orf-partial-reads.py'))
orf = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(orf)


def measure(binary, photos, limit, round_no):
    photo_set = set(photos)
    with tempfile.TemporaryDirectory(prefix=f'immage-orf-ra{limit}-') as temp:
        work = Path(temp)
        old_env = os.environ.copy()
        os.environ['IMMAGE_IMPORT_METADATA_WORKERS'] = '0'
        os.environ['IMMAGE_METADATA_PREFIX'] = '1'
        os.environ['IMMAGE_METADATA_IO_DIAGNOSTICS'] = '1'
        os.environ['IMMAGE_IMPORT_READ_AHEAD'] = str(limit)
        os.environ['IMMAGE_IMPORT_DIAGNOSTICS'] = '1'
        engine = None
        try:
            engine = background.Engine(binary, work)
            engine.call({'cmd': 'import', 'files': [], 'job': round_no * 10 + limit})
            started = time.monotonic()
            tag = engine.tagged_send({'cmd': 'import', 'files': [str(p) for p in photos],
                                      'job': round_no * 10 + limit})
            if not engine.wait_tags([tag], 3600):
                raise RuntimeError(f'limit {limit} import timed out')
            elapsed = time.monotonic() - started
            reply = engine.tagged[tag][1]
            if not reply.get('ok'):
                raise RuntimeError(f'limit {limit} import failed: {reply}')
            images = orf.normalized_images(reply.get('images', []))
        finally:
            if engine is not None:
                engine.close()
            os.environ.clear()
            os.environ.update(old_env)

        if reply.get('unanswered'):
            raise RuntimeError(f'limit {limit} import left unanswered: {reply["unanswered"]}')
        if reply.get('done') != len(photos):
            raise RuntimeError(f'limit {limit} handled {reply.get("done")} of {len(photos)} files')
        imported_paths = {Path(image.get('path', '')).resolve() for image in reply.get('images', [])}
        if imported_paths != photo_set:
            raise RuntimeError(f'limit {limit} imported {len(imported_paths)} of {len(photos)} photos')

        lines = engine.log_path.read_text(errors='replace').splitlines()
        source = [record for line in lines
                  if (record := orf.diagnostic_fields(line)) is not None
                  and Path(record.get('path', '')).resolve() in photo_set]
        if {Path(record['path']).resolve() for record in source} != photo_set:
            raise RuntimeError(f'limit {limit} lacks metadata-read diagnostics for every photo')
        for record in source:
            if record.get('prefix_enabled') != 'true':
                raise RuntimeError(f'prefix mode was not applied: {record}')
            if 'source_read_bytes' not in record:
                raise RuntimeError(f'metadata diagnostic lacks source_read_bytes: {record}')

        diag_lines = [line[line.find(IMPORT_DIAGNOSTIC) + len(IMPORT_DIAGNOSTIC):].strip()
                      for line in lines if IMPORT_DIAGNOSTIC in line]
        if not diag_lines:
            raise RuntimeError('engine emitted no IMMAGE_IMPORT_DIAGNOSTICS records')
        fields = dict(part.split('=', 1) for part in diag_lines[-1].split() if '=' in part)
        if int(fields.get('cap', -1)) != limit:
            raise RuntimeError(f'requested limit {limit} was not applied: {fields}')
        probe_count = int(fields.get('probes', 0))
        timeouts = int(fields.get('timeouts', -1))
        saturated = int(fields.get('saturated', -1))
        if probe_count < len(photos):
            raise RuntimeError(f'probe diagnostics cover {probe_count} probes for {len(photos)} photos: {fields}')
        if timeouts or saturated:
            raise RuntimeError(f'limit {limit} encountered timeouts or saturation: {fields}')
        max_active = int(fields.get('max_active', -1))
        if not 1 <= max_active <= limit:
            raise RuntimeError(f'invalid active probe count for limit {limit}: {fields}')

        byte_count = sum(int(record['source_read_bytes']) for record in source)
        return {'limit': limit, 'round': round_no, 'elapsed_seconds': elapsed,
                'photos': len(photos), 'source_read_bytes': byte_count,
                'bytes_per_photo': byte_count / len(photos),
                'photos_per_second': len(photos) / max(elapsed, 1e-9),
                'max_active_probes': max_active, 'diagnostics': fields, 'images': images}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path)
    parser.add_argument('--recursive', action='store_true', help='search subfolders for .ORF files')
    parser.add_argument('--runs', type=int, default=4, help='balanced rounds (default: 4)')
    parser.add_argument('--engine', type=Path, default=ROOT / 'build/bin/darktable-engine')
    parser.add_argument('--report', type=Path, help='write measurements and summaries as JSON')
    args = parser.parse_args()
    folder, binary = args.folder.resolve(), args.engine.resolve()
    if not folder.is_dir(): parser.error(f'not a folder: {folder}')
    if not binary.is_file(): parser.error(f'engine not found: {binary}')
    if args.runs < 1: parser.error('--runs must be at least 1')
    photos = orf.photo_paths(folder, args.recursive)
    if not photos: parser.error('no .ORF photos found')
    photo_set = set(photos)

    samples = {limit: [] for limit in LIMITS}
    reference = None
    records = []
    # Williams square balances limit position and immediate predecessor.
    orders = ((1, 2, 4, 3), (2, 3, 1, 4), (3, 4, 2, 1), (4, 1, 3, 2))
    for round_no in range(args.runs):
        order = orders[round_no % 4]
        for limit in order:
            result = measure(binary, photos, limit, round_no + 1)
            if reference is None:
                reference = result['images']
            elif result['images'] != reference:
                raise RuntimeError(f'limit {limit} import metadata differs from other runs')
            samples[limit].append(result)
            records.append(result)
            print(f"round {round_no + 1}/{args.runs} limit {limit}: "
                  f"{result['source_read_bytes']} metadata bytes, "
                  f"{result['elapsed_seconds']:.2f}s, "
                  f"{result['photos_per_second']:.2f} photos/s, "
                  f"max probes {result['max_active_probes']}", flush=True)

    summary = {}
    print(f'\nMedian results for {len(photos)} ORF photos (prefix enabled; probes overlap; imports serialized)')
    print('Normalized import entries match across all limits and runs.')
    for limit in LIMITS:
        group = samples[limit]
        summary[str(limit)] = {key: statistics.median(row[key] for row in group)
                               for key in ('source_read_bytes', 'bytes_per_photo',
                                           'photos_per_second', 'elapsed_seconds')}
        med = summary[str(limit)]
        print(f"  limit {limit}: {med['source_read_bytes']:.0f} metadata bytes, "
              f"{med['photos_per_second']:.2f} photos/s, {med['elapsed_seconds']:.2f}s")
    report = {'folder': str(folder), 'recursive': args.recursive,
              'photos': [str(photo) for photo in photos], 'runs': args.runs,
              'limits': list(LIMITS),
              'scope': 'ORF prefix metadata reads; bounded 4 KB photo/XMP probes overlap; metadata imports serialized',
              'cache_caveat': 'Operating-system and storage caches can warm across runs.',
              'records': records, 'median': summary}
    if args.report:
        args.report.resolve().write_text(json.dumps(report, indent=2) + '\n')
        print(f'Wrote {args.report.resolve()}')


if __name__ == '__main__':
    main()
