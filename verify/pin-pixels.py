#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors
"""Report fresh-image CPU pixel differences between coherent engine builds.

Differences are observations, not a pass/fail threshold for pin adoption.
Original photos and adjacent sidecars are never modified or imported.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import selectors
import shutil
import struct
import subprocess
import tempfile
import zlib


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def chunk(kind, data):
    return (struct.pack('>I', len(data)) + kind + data
            + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff))


def render(build, photo, state, output, sizes):
    state.mkdir()
    copied = state / photo.name
    shutil.copyfile(photo, copied)
    command = [str(build / 'bin/darktable-engine'), '--core',
               '--configdir', str(state / 'config'), '--cachedir', str(state / 'cache'),
               '--datadir', str(build / 'share/darktable'),
               '--moduledir', str(build / 'lib/darktable'),
               '--conf', 'opencl=false', '--conf', 'resourcelevel=0']
    frames = {}
    with output.with_suffix('.log').open('w') as log:
        child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=log, text=True, env=os.environ | {
                                     'OMP_NUM_THREADS': '2', 'OMP_WAIT_POLICY': 'passive',
                                     'XDG_DATA_HOME': str(state / 'data')})
        poll = selectors.DefaultSelector()
        poll.register(child.stdout, selectors.EVENT_READ)

        def request(data):
            child.stdin.write(json.dumps(data) + '\n')
            child.stdin.flush()
            if not poll.select(180):
                raise RuntimeError('engine response timed out')
            response = json.loads(child.stdout.readline())
            if not response.get('ok'):
                raise RuntimeError(response)
            return response

        try:
            request({'cmd': 'open', 'path': str(copied)})
            for size in sizes:
                dest = output.parent / f'{output.name}-{size}.rgba'
                response = request({'cmd': 'render', 'width': size, 'height': size,
                                    'rgba': str(dest)})
                pixels = dest.read_bytes()
                width, height = response['width'], response['height']
                if len(pixels) != width * height * 4 or set(pixels[3::4]) != {255}:
                    raise RuntimeError('invalid opaque RGBA output')
                frames[size] = ((width, height), pixels)
            request({'cmd': 'quit'})
            child.wait(timeout=15)
            if child.returncode:
                raise RuntimeError(f'engine exited {child.returncode}')
        finally:
            poll.close()
            if child.poll() is None:
                child.kill()
                child.wait()
    return frames


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--old', type=Path, required=True)
    parser.add_argument('--candidate', type=Path, action='append', required=True)
    parser.add_argument('--photo', type=Path, action='append', default=[])
    parser.add_argument('--size', type=int, action='append', default=[])
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    sizes = args.size or [96, 512]
    if any(size <= 0 for size in sizes):
        parser.error('sizes must be positive')
    builds = [('old', args.old.resolve())] + [
        (f'candidate-{i}', path.resolve()) for i, path in enumerate(args.candidate)]
    report = {'builds': {}, 'inputs': {}}
    for label, build in builds:
        # Record all engine/module bytes, rather than assuming timestamps or a
        # source checkout prove binary identity. Includes dynamically loaded IOPs.
        files = [build / 'bin/darktable-engine', build / 'bin/libdarktable.so']
        files += sorted((build / 'lib/darktable').rglob('*.so'))
        report['builds'][label] = {'path': str(build), 'sha256': {
            str(path.relative_to(build)): digest(path) for path in files}}
    with tempfile.TemporaryDirectory(prefix='immage-pin-pixels-') as tmp:
        state = Path(tmp)
        width, height = 128, 96
        rows = b''.join(b'\0' + bytes(value for x in range(width)
                                    for value in (x * 2, y * 2, (x + y) % 256))
                        for y in range(height))
        png = state / 'synthetic.png'
        png.write_bytes(b'\x89PNG\r\n\x1a\n'
                        + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
                        + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))
        for index, photo in enumerate([png] + [path.resolve() for path in args.photo]):
            key = f'{index}-{photo.name}'
            frames = {label: render(build, photo, state / f'{index}-{label}',
                                    output / f'{index}-{label}', sizes)
                      for label, build in builds}
            record = {'sha256': digest(photo), 'comparisons': {}}
            for label, _ in builds[1:]:
                for size in sizes:
                    dims, before = frames['old'][size]
                    after_dims, after = frames[label][size]
                    if dims != after_dims:
                        raise RuntimeError(f'dimension mismatch: {dims} vs {after_dims}')
                    differences = [abs(a - b) for i, (a, b) in enumerate(zip(before, after))
                                   if i % 4 != 3]
                    record['comparisons'][f'{label}-{size}'] = {
                        'dimensions': dims, 'rgb_channels': len(differences),
                        'changed_rgb_channels': sum(d != 0 for d in differences),
                        'max_difference': max(differences),
                        'mean_absolute_difference': sum(differences) / len(differences),
                        'sha256': hashlib.sha256(after).hexdigest()}
            report['inputs'][key] = record
    (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report['inputs'], indent=2))


if __name__ == '__main__':
    main()
