#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Measure the experimental ORF metadata worker pipeline at limits 1 through 4.

    python3 -I benchmarking/orf-metadata-pipeline.py PHOTO_FOLDER --runs 4

Each sample starts a fresh headless engine and imports the original photos
read-only. Prefix reads remain enabled. Metadata parsing and catalog updates
stay serialized; the worker limit controls prepared metadata results in flight.
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
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'verify'))
background = __import__('background-priority')
PIPELINE_DIAGNOSTIC = '[engine] metadata pipeline:'
PREFETCH_DIAGNOSTIC = 'IMMAGE_METADATA_PREFETCH\t'

_spec = importlib.util.spec_from_file_location(
    'orf_partial_reads', Path(__file__).with_name('orf-partial-reads.py'))
orf = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(orf)

LIMITS = (1, 2, 3, 4)
ORDERS = ((1, 2, 4, 3), (2, 3, 1, 4), (3, 4, 2, 1), (4, 1, 3, 2))
ENV_KEYS = ('IMMAGE_METADATA_PREFIX', 'IMMAGE_METADATA_IO_DIAGNOSTICS',
            'IMMAGE_IMPORT_READ_AHEAD', 'IMMAGE_IMPORT_METADATA_WORKERS',
            'IMMAGE_IMPORT_METADATA_TIMEOUT_MS', 'IMMAGE_IMPORT_DIAGNOSTICS')


def fields(line, prefix, separator='\t'):
    offset = line.find(prefix)
    if offset < 0:
        return None
    result = {}
    for part in line[offset + len(prefix):].split(separator):
        key, sep, value = part.partition('=')
        if sep:
            result[key] = value
    if 'path' in result:
        parsed = urlparse(result['path'])
        result['path'] = unquote(parsed.path) if parsed.scheme == 'file' else unquote(result['path'])
    return result


def set_environment(workers):
    previous = {key: os.environ.get(key) for key in ENV_KEYS}
    os.environ['IMMAGE_METADATA_PREFIX'] = '1'
    os.environ['IMMAGE_METADATA_IO_DIAGNOSTICS'] = '1'
    os.environ['IMMAGE_IMPORT_READ_AHEAD'] = '1'
    os.environ['IMMAGE_IMPORT_METADATA_WORKERS'] = str(workers)
    os.environ['IMMAGE_IMPORT_METADATA_TIMEOUT_MS'] = '30000'
    os.environ['IMMAGE_IMPORT_DIAGNOSTICS'] = '1'
    return previous


def restore_environment(previous):
    for key, value in previous.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


def measure(binary, photos, workers, run_no):
    with tempfile.TemporaryDirectory(prefix=f'immage-orf-meta{workers}-') as temp:
        work = Path(temp)
        previous = set_environment(workers)
        engine = None
        reply = None
        log_path = work / 'engine' / 'engine.log'
        try:
            engine_work = work / 'engine'
            engine_work.mkdir()
            engine = background.Engine(binary, engine_work)
            engine.call({'cmd': 'import', 'files': [], 'job': run_no * 10 + workers})
            started = time.monotonic()
            tag = engine.tagged_send({'cmd': 'import', 'files': [str(p) for p in photos],
                                      'job': run_no * 10 + workers})
            if not engine.wait_tags([tag], 3600):
                raise RuntimeError(f'workers={workers} import timed out')
            elapsed = time.monotonic() - started
            reply = engine.tagged[tag][1]
            if not reply.get('ok'):
                raise RuntimeError(f'workers={workers} import failed: {reply}')
            images = orf.normalized_images(reply.get('images', []))
        finally:
            if engine is not None:
                engine.close()
            restore_environment(previous)
        lines = log_path.read_text(errors='replace').splitlines()

        if reply.get('unanswered'):
            raise RuntimeError(f'import left unanswered files: {reply["unanswered"]}')
        if reply.get('done') != len(photos):
            raise RuntimeError(f'import handled {reply.get("done")} of {len(photos)} files')
        imported_paths = {Path(image.get('path', '')).resolve() for image in reply.get('images', [])}
        if imported_paths != set(photos):
            raise RuntimeError(f'imported {len(imported_paths)} of {len(photos)} requested ORFs')

        source_set = set(photos)
        metadata_records = [record for line in lines
                            if (record := orf.diagnostic_fields(line)) is not None
                            and Path(record.get('path', '')).resolve() in source_set]
        if {Path(record['path']).resolve() for record in metadata_records} != source_set:
            raise RuntimeError('metadata IO diagnostics do not cover every ORF')
        for record in metadata_records:
            if record.get('prefix_enabled') != 'true':
                raise RuntimeError(f'prefix mode was not enabled: {record}')
            if 'source_read_bytes' not in record:
                raise RuntimeError(f'metadata IO diagnostic lacks source_read_bytes: {record}')

        consumed = [fields(line, PREFETCH_DIAGNOSTIC)
                    for line in lines if PREFETCH_DIAGNOSTIC in line]
        consumed = [record for record in consumed if record is not None
                    and record.get('hit') == '1'
                    and Path(record.get('path', '')).resolve() in source_set]
        consumed_paths = [Path(record['path']).resolve() for record in consumed]
        if len(consumed_paths) != len(source_set) or set(consumed_paths) != source_set:
            raise RuntimeError(f'prefetch-hit diagnostics cover {len(set(consumed_paths))} of '
                               f'{len(source_set)} ORFs')

        pipeline_lines = [line for line in lines if PIPELINE_DIAGNOSTIC in line]
        if not pipeline_lines:
            raise RuntimeError('engine emitted no metadata pipeline diagnostics')
        pipeline = fields(pipeline_lines[-1], PIPELINE_DIAGNOSTIC, separator=' ')
        if int(pipeline.get('workers', -1)) != workers:
            raise RuntimeError(f'requested workers={workers} was not applied: {pipeline}')
        if int(pipeline.get('prepared', -1)) != len(photos) \
                or int(pipeline.get('consumed', -1)) != len(photos):
            raise RuntimeError(f'pipeline did not prepare and consume every ORF: {pipeline}')
        if int(pipeline.get('timeouts', -1)) != 0 or int(pipeline.get('saturated', -1)) != 0:
            raise RuntimeError(f'pipeline timed out or saturated: {pipeline}')
        max_active = int(pipeline.get('max_active', -1))
        if not 1 <= max_active <= workers:
            raise RuntimeError(f'invalid max_active for workers={workers}: {pipeline}')

        source_bytes = sum(int(record['source_read_bytes']) for record in metadata_records)
        return {'workers': workers, 'round': run_no,
                'elapsed_seconds': elapsed, 'photos': len(photos),
                'source_read_bytes': source_bytes,
                'bytes_per_photo': source_bytes / len(photos),
                'photos_per_second': len(photos) / max(elapsed, 1e-9),
                'max_active': max_active, 'pipeline': pipeline,
                'images': images}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path)
    parser.add_argument('--recursive', action='store_true', help='search subfolders for .ORF files')
    parser.add_argument('--runs', type=int, default=4, help='balanced Williams rounds (default: 4)')
    parser.add_argument('--engine', type=Path, default=ROOT / 'build/bin/darktable-engine')
    parser.add_argument('--report', type=Path, help='write measurements and summaries as JSON')
    args = parser.parse_args()
    folder, binary = args.folder.resolve(), args.engine.resolve()
    if not folder.is_dir():
        parser.error(f'not a folder: {folder}')
    if not binary.is_file():
        parser.error(f'engine not found: {binary}')
    if args.runs < 1:
        parser.error('--runs must be at least 1')
    photos = orf.photo_paths(folder, args.recursive)
    if not photos:
        parser.error('no .ORF photos found')

    reference = None
    samples = {workers: [] for workers in LIMITS}
    records = []
    for round_no in range(args.runs):
        for workers in ORDERS[round_no % len(ORDERS)]:
            result = measure(binary, photos, workers, round_no + 1)
            if reference is None:
                reference = result['images']
            elif result['images'] != reference:
                raise RuntimeError(f'workers={workers} metadata differs across runs')
            samples[workers].append(result)
            records.append(result)
            print(f"round {round_no + 1}/{args.runs} workers {workers}: "
                  f"{result['source_read_bytes']} source bytes, "
                  f"{result['elapsed_seconds']:.2f}s, "
                  f"{result['photos_per_second']:.2f} photos/s, "
                  f"max active {result['max_active']}", flush=True)

    summary = {}
    print(f'\nMedian results for {len(photos)} ORF photos (prefix enabled; '
          'bounded metadata workers; parsing/catalog writes serialized)')
    print('Normalized imported metadata matches across all samples.')
    for workers in LIMITS:
        group = samples[workers]
        summary[str(workers)] = {key: statistics.median(row[key] for row in group)
                                 for key in ('source_read_bytes', 'bytes_per_photo',
                                             'photos_per_second', 'elapsed_seconds',
                                             'max_active')}
        median = summary[str(workers)]
        print(f"  workers {workers}: {median['source_read_bytes']:.0f} metadata bytes, "
              f"{median['photos_per_second']:.2f} photos/s, "
              f"{median['elapsed_seconds']:.2f}s, "
              f"max active {median['max_active']:.0f}")
    if args.report:
        report = {'folder': str(folder), 'recursive': args.recursive,
                  'photos': [str(photo) for photo in photos], 'runs': args.runs,
                  'workers': list(LIMITS), 'records': records,
                  'median': summary,
                  'scope': 'ORF metadata preparation workers; prefix enabled; Exiv2 parsing and catalog imports serialized',
                  'cache_caveat': 'Operating-system and storage caches can warm across runs.',
                  'source_policy': 'Original photo and sidecar paths are imported read-only.'}
        args.report.resolve().write_text(json.dumps(report, indent=2) + '\n')
        print(f'Wrote {args.report.resolve()}')


if __name__ == '__main__':
    main()
