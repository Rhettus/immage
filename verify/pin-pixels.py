#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors
"""Report CPU pixel differences between coherent engine builds.

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
import xml.etree.ElementTree as ET
import zlib


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def chunk(kind, data):
    return (struct.pack('>I', len(data)) + kind + data
            + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff))


def render(build, photo, state, output, sizes, edits=(), sidecar=None, save=None):
    state.mkdir()
    copied = state / photo.name
    shutil.copyfile(photo, copied)
    if sidecar:
        shutil.copyfile(sidecar, Path(str(copied) + '.xmp'))
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
            for edit in edits:
                request({'cmd': 'set'} | edit)
            if save:
                request({'cmd': 'save'})
                shutil.copyfile(Path(str(copied) + '.xmp'), save)
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
    parser.add_argument('--edited', action='store_true',
                        help='Also compare old-created exposure, sigmoid, AgX and vignette histories')
    parser.add_argument('--vignette', action='store_true',
                        help='Compare saved vignette dithering, shape and saturation variants')
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    sizes = args.size or [96, 512]
    if any(size <= 0 for size in sizes):
        parser.error('sizes must be positive')
    builds = [('old', args.old.resolve())] + [
        (f'candidate-{i}', path.resolve()) for i, path in enumerate(args.candidate)]
    report = {'schema_version': 2, 'builds': {}, 'inputs': {}}
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
            cases = {'defaults': []}
            if args.edited:
                # Explicitly select one tone mapper: RAW auto-defaults can already
                # enable sigmoid. Save with the old build so candidate migration
                # handles historical versions, including output-follow flags.
                disable_mappers = [{'op': op, 'enabled': False}
                                   for op in ('sigmoid', 'agx', 'filmicrgb')]
                cases |= {
                    'exposure': [{'op': 'exposure', 'enabled': True,
                                  'params': {'exposure': 1.25}}],
                    'sigmoid': disable_mappers + [
                        {'op': 'sigmoid', 'enabled': True,
                         'params': {'middle_grey_contrast': 1.9}}],
                    'agx': disable_mappers + [
                        {'op': 'agx', 'enabled': True,
                         'params': {'curve_contrast_around_pivot': 2.5}}],
                    'vignette': [{'op': 'vignette', 'enabled': True,
                                  'params': {'brightness': -0.7, 'scale': 50.0,
                                             'falloff_scale': 40.0, 'dithering': 0}}],
                }
            if args.vignette:
                base = {'brightness': -0.7, 'scale': 50.0,
                        'falloff_scale': 40.0, 'dithering': 0}
                variants = {
                    'off': {},
                    '8bit': {'dithering': 1},
                    '16bit': {'dithering': 2},
                    'bright': {'brightness': 0.4},
                    'saturation': {'brightness': 0.0, 'saturation': -0.8},
                    'shape': {'shape': 2.0, 'center.x': 0.2, 'center.y': -0.15},
                }
                for name, params in variants.items():
                    cases[f'vignette-{name}'] = [
                        {'op': 'vignette', 'enabled': True, 'params': base | params}]
            record = {'sha256': digest(photo), 'cases': {}}
            default_frames = None
            for case, edits in cases.items():
                prefix = f'{index}-{case}'
                sidecar = output / f'{prefix}-old.xmp' if edits else None
                old = render(builds[0][1], photo, state / f'{prefix}-old',
                             output / f'{prefix}-old', sizes, edits=edits, save=sidecar)
                if not edits:
                    default_frames = old
                comparisons = {}
                targets = builds if edits else builds[1:]
                for label, build in targets:
                    frames = render(build, photo, state / f'{prefix}-{label}-reload',
                                    output / f'{prefix}-{label}-reload', sizes,
                                    sidecar=sidecar)
                    for size in sizes:
                        dims, before = old[size]
                        after_dims, after = frames[size]
                        if dims != after_dims:
                            raise RuntimeError(f'dimension mismatch: {dims} vs {after_dims}')
                        differences = [abs(a - b) for i, (a, b) in enumerate(zip(before, after))
                                       if i % 4 != 3]
                        comparisons[f'{label}-{size}'] = {
                            'dimensions': dims, 'rgb_channels': len(differences),
                            'changed_rgb_channels': sum(d != 0 for d in differences),
                            'max_difference': max(differences),
                            'mean_absolute_difference': sum(differences) / len(differences),
                            'sha256': hashlib.sha256(after).hexdigest()}
                result = {'edits': edits, 'comparisons': comparisons}
                if sidecar:
                    result['sidecar_sha256'] = digest(sidecar)
                    ns = '{http://darktable.sf.net/}'
                    result['saved_modules'] = [
                        {key: item.get(ns + key) for key in
                         ('operation', 'modversion', 'enabled', 'blendop_version')}
                        for item in ET.parse(sidecar).iter()
                        if item.get(ns + 'operation') is not None]
                    result['changed_from_defaults'] = {
                        str(size): old[size] != default_frames[size] for size in sizes}
                    if not all(result['changed_from_defaults'].values()):
                        raise RuntimeError(f'{key}/{case} has no visible contribution')
                record['cases'][case] = result
            report['inputs'][key] = record
    (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report['inputs'], indent=2))


if __name__ == '__main__':
    main()
