#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Compare full-file and prefix-enabled metadata reads on a photo folder.

Each measurement starts a fresh headless engine with isolated config, cache,
and library state. It imports the original photo paths read-only; no GUI is
started and no photo or sidecar is written. Runs alternate baseline/prefix
order to reduce ordering bias. Requires IMMAGE_METADATA_IO diagnostics from the
engine build under test.

    python3 -I benchmarking/orf-partial-reads.py PHOTO_FOLDER --recursive --runs 5
"""
import argparse
import json
import os
from pathlib import Path
import re
import statistics
import sys
import tempfile
import time
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'verify'))
background = __import__('background-priority')
Engine = background.Engine

DIAGNOSTIC = 'IMMAGE_METADATA_IO\t'


def photo_paths(folder, recursive):
    iterator = folder.rglob('*') if recursive else folder.glob('*')
    return sorted(p.resolve() for p in iterator if p.is_file() and p.suffix.lower() == '.orf')


def diagnostic_fields(line):
    where = line.find(DIAGNOSTIC)
    if where < 0:
        return None
    fields = {}
    for field in line[where + len(DIAGNOSTIC):].split('\t'):
        key, sep, value = field.partition('=')
        if sep:
            fields[key] = value
    raw_path = fields.get('path', '')
    parsed = urlparse(raw_path)
    fields['path'] = unquote(parsed.path) if parsed.scheme == 'file' else unquote(raw_path)
    return fields


def normalized_images(images):
    def normalize(value):
        if isinstance(value, dict):
            return {key: normalize(item) for key, item in value.items() if key != 'imgid'}
        if isinstance(value, list):
            return [normalize(item) for item in value]
        return value
    return normalize(images)


def run(engine_path, photos, mode):
    with tempfile.TemporaryDirectory(prefix='immage-orf-io-') as temp:
        work = Path(temp)
        previous = os.environ.get('IMMAGE_METADATA_PREFIX')
        previous_diagnostics = os.environ.get('IMMAGE_METADATA_IO_DIAGNOSTICS')
        previous_workers = os.environ.get('IMMAGE_IMPORT_METADATA_WORKERS')
        if mode == 'baseline':
            os.environ['IMMAGE_METADATA_PREFIX'] = '0'
        else:
            os.environ.pop('IMMAGE_METADATA_PREFIX', None)
        os.environ['IMMAGE_METADATA_IO_DIAGNOSTICS'] = '1'
        os.environ['IMMAGE_IMPORT_METADATA_WORKERS'] = '0'
        engine = None
        try:
            engine = Engine(engine_path, work)
            engine.call({'cmd': 'import', 'files': [], 'job': 1})
            start = time.monotonic()
            tag = engine.tagged_send({'cmd': 'import', 'files': [str(p) for p in photos], 'job': 1})
            if not engine.wait_tags([tag], 3600):
                raise RuntimeError(f'{mode} import timed out')
            elapsed = time.monotonic() - start
            reply = engine.tagged[tag][1]
            if not reply.get('ok'):
                raise RuntimeError(f'{mode} import failed: {reply}')
            image_entries = normalized_images(reply.get('images', []))
        finally:
            if engine is not None:
                engine.close()
            if previous is None:
                os.environ.pop('IMMAGE_METADATA_PREFIX', None)
            else:
                os.environ['IMMAGE_METADATA_PREFIX'] = previous
            if previous_diagnostics is None:
                os.environ.pop('IMMAGE_METADATA_IO_DIAGNOSTICS', None)
            else:
                os.environ['IMMAGE_METADATA_IO_DIAGNOSTICS'] = previous_diagnostics
            if previous_workers is None:
                os.environ.pop('IMMAGE_IMPORT_METADATA_WORKERS', None)
            else:
                os.environ['IMMAGE_IMPORT_METADATA_WORKERS'] = previous_workers
        if reply.get('unanswered'):
            raise RuntimeError(f'{mode} import left files unanswered: {reply["unanswered"]}')
        if reply.get('done') != len(photos):
            raise RuntimeError(f'{mode} import handled {reply.get("done")} of {len(photos)} requested files')
        imported_paths = {Path(image.get('path', '')).resolve() for image in reply.get('images', [])}
        if imported_paths != set(photos):
            raise RuntimeError(f'{mode} imported {len(imported_paths)} of {len(photos)} requested photo paths')
        records = []
        for line in engine.log_path.read_text(errors='replace').splitlines():
            record = diagnostic_fields(line)
            if record is not None: records.append(record)
        if not records:
            raise RuntimeError('engine emitted no IMMAGE_METADATA_IO diagnostics')
        # Count only photo source reads; sidecar records are also logged.
        source_records = [r for r in records if Path(r.get('path', '')).resolve() in photos]
        if not source_records:
            raise RuntimeError(f'no photo source diagnostics found in {mode} run')
        measured_paths = {Path(r['path']).resolve() for r in source_records}
        if measured_paths != set(photos):
            raise RuntimeError(f'{mode} source diagnostics cover {len(measured_paths)} of {len(photos)} photos')
        expected_prefix = mode == 'prefix'
        for record in source_records:
            if record.get('prefix_enabled') != str(expected_prefix).lower():
                raise RuntimeError(f'{mode} setting was not applied: {record}')
            if 'source_read_bytes' not in record:
                raise RuntimeError(f'diagnostic lacks source_read_bytes: {record}')
            if mode == 'baseline' and (record.get('prefix_size') != '0'
                                       or record.get('full_buffer') != 'true'):
                raise RuntimeError(f'baseline did not use a full read: {record}')
        byte_count = sum(int(r.get('source_read_bytes', 0)) for r in source_records)
        return {'mode': mode, 'elapsed_seconds': elapsed, 'photos': len(photos),
                'imported_rows': len(image_entries),
                'source_files_read': len(measured_paths), 'source_read_bytes': byte_count,
                'bytes_per_file': byte_count / len(photos),
                'photos_per_second': len(photos) / max(elapsed, 1e-9),
                'metadata_records': len(source_records), 'images': image_entries}


def summarize(samples, key):
    values = [sample[key] for sample in samples]
    return statistics.median(values)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path)
    parser.add_argument('--recursive', action='store_true', help='search subfolders for .ORF files')
    parser.add_argument('--runs', type=int, default=6)
    parser.add_argument('--engine', type=Path, default=ROOT / 'build/bin/darktable-engine')
    parser.add_argument('--report', type=Path, help='write all measurements and summaries as JSON')
    args = parser.parse_args()
    folder = args.folder.resolve()
    engine = args.engine.resolve()
    if not folder.is_dir(): parser.error(f'not a folder: {folder}')
    if not engine.is_file(): parser.error(f'engine not found: {engine}')
    if args.runs < 1: parser.error('--runs must be at least 1')
    photos = photo_paths(folder, args.recursive)
    if not photos: parser.error('no .ORF photos found')
    samples = {'baseline': [], 'prefix': []}
    reference_images = None
    for k in range(args.runs):
        order = ('baseline', 'prefix') if k % 2 == 0 else ('prefix', 'baseline')
        for mode in order:
            sample = run(engine, photos, mode)
            if reference_images is None:
                reference_images = sample['images']
            elif sample['images'] != reference_images:
                raise RuntimeError(f'{mode} import metadata differs from the first run')
            samples[mode].append(sample)
            print(f"run {k + 1}/{args.runs} {mode}: {sample['photos']} photos, "
                  f"{sample['source_read_bytes']} source bytes, "
                  f"{sample['elapsed_seconds']:.2f}s, "
                  f"{sample['photos_per_second']:.2f} photos/s", flush=True)
    print(f'folder: {folder} ({len(photos)} ORF files; recursive={args.recursive}); '
          'normalized import entries match across runs')
    summary = {}
    for mode in ('baseline', 'prefix'):
        summary[mode] = {key: summarize(samples[mode], key) for key in
                         ('bytes_per_file', 'photos_per_second', 'elapsed_seconds')}
        print(f"{mode}: median bytes/file={summary[mode]['bytes_per_file']:.0f}; "
              f"median photos/s={summary[mode]['photos_per_second']:.2f}; "
              f"median elapsed={summary[mode]['elapsed_seconds']:.2f}s")
    before = summarize(samples['baseline'], 'bytes_per_file')
    after = summarize(samples['prefix'], 'bytes_per_file')
    print(f'bytes/file change: {(after / before - 1) * 100:.1f}%')
    if args.report:
        report = {'folder': str(folder), 'recursive': args.recursive, 'photos': [str(p) for p in photos],
                  'runs': args.runs, 'samples': samples, 'median': summary}
        args.report.resolve().write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
