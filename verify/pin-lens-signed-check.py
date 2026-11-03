#!/usr/bin/env python3
"""Compare isolated signed-input plugins at floating vignetting or geometry boundaries.

Requires assigned XMP fixtures from the exceptional-profile diagnostic. These
are synthetic inputs on an unrelated photo, not matching-camera validation.
"""
import argparse
import base64
import struct
import xml.etree.ElementTree as ET
import zlib
from collections import Counter
import importlib.util
import json
from pathlib import Path
import tempfile

spec = importlib.util.spec_from_file_location('pixels', Path(__file__).with_name('pin-pixels.py'))
pixels = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pixels)


def records(log, distort_mask=False, mask_bypass=False):
    rows = []
    for line in log.read_text().splitlines():
        if line.startswith('SIGNED_LENS '):
            fields = line.split()
            if len(fields) != 11:
                raise ValueError(f'invalid trace: {line}')
            inverse, x, y, width, ch, negative, positive, nonfinite, alpha_changed = map(int, fields[1:10])
            if inverse not in (0, 1) or min(x, y) < 0 or width <= 0 or ch != 4:
                raise ValueError(f'invalid geometry: {line}')
            if nonfinite or alpha_changed or negative + positive > width * 3:
                raise ValueError(f'invalid float output: {line}')
            if len(fields[10]) != 64:
                raise ValueError('invalid SHA256')
            rows.append(line)
    masks = [line for line in log.read_text().splitlines() if line.startswith('MASK_LENS ')]
    if bool(masks) != distort_mask:
        raise ValueError('mask trace presence must match requested mode')
    if distort_mask:
        counts = {pattern: Counter() for pattern in (0, 1, 2)}
        rgb_geometry = Counter(tuple(map(int, row.split()[1:5])) for row in rows)
        for line in masks:
            fields = line.split()
            if len(fields) != 7 or len(fields[-1]) != 64:
                raise ValueError(f'invalid mask trace: {line}')
            pattern, inverse, x, y, width = map(int, fields[1:6])
            if pattern not in (0, 1, 2) or inverse not in (0, 1) or min(x, y) < 0 or width <= 0:
                raise ValueError(f'invalid mask geometry: {line}')
            counts[pattern][(inverse, x, y, width)] += 1
            if (inverse, x, y, width) not in rgb_geometry:
                raise ValueError('mask row has no corresponding image row')
        if any(geometry != rgb_geometry for geometry in counts.values()):
            raise ValueError('incomplete mask patterns')
    if not rows:
        raise ValueError(f'no actual-pixel Lensfun calls in {log}')
    bypasses = [line for line in log.read_text().splitlines() if line.startswith('MASK_BYPASS ')]
    if bool(bypasses) != mask_bypass:
        raise ValueError('bypass trace presence must match requested mode')
    if mask_bypass:
        counts = Counter()
        for line in bypasses:
            fields = line.split()
            if len(fields) != 7 or len(fields[-1]) != 64:
                raise ValueError(f'invalid bypass trace: {line}')
            bypass, pattern, inverse, width, height = map(int, fields[1:6])
            if bypass not in (0, 1) or pattern not in (0, 1, 2) or inverse not in (0, 1) or min(width, height) <= 0:
                raise ValueError(f'invalid bypass geometry: {line}')
            counts[bypass, pattern] += 1
        if set(counts) != {(b, p) for b in range(2) for p in range(3)} or len(set(counts.values())) != 1:
            raise ValueError('incomplete bypass patterns')
    return rows + masks + bypasses


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('old', 'direct', 'fixtures', 'photo', 'output'):
        parser.add_argument(f'--{name}', type=Path, required=True)
    parser.add_argument('--geometry', action='store_true')
    parser.add_argument('--distort-mask', action='store_true')
    parser.add_argument('--mask-bypass', action='store_true')
    parser.add_argument('--mask-display', action='store_true')
    parser.add_argument('--size', type=int, action='append', default=[])
    parser.add_argument('--interpolation', choices=['bilinear', 'bicubic', 'lanczos2', 'lanczos3'])
    parser.add_argument('--aspect', type=float, choices=[0.75, 1.5])
    args = parser.parse_args()
    if (args.mask_display or args.distort_mask) and not args.geometry:
        parser.error('--mask-display and --distort-mask require --geometry')
    if args.mask_bypass and not args.distort_mask:
        parser.error('--mask-bypass requires --distort-mask')
    for build in (args.old, args.direct):
        manifest = json.loads((build / 'manifest.json').read_text())
        if bool(manifest.get('mask_bypass')) != args.mask_bypass:
            raise ValueError('mask-bypass mode must match both plugin manifests')
        if bool(manifest.get('distort_mask')) != args.distort_mask:
            raise ValueError('distort-mask mode must match both plugin manifests')
        if bool(manifest.get('mask_display')) != args.mask_display:
            raise ValueError('mask-display mode must match both plugin manifests')
    if args.geometry:
        for build in (args.old, args.direct):
            if not json.loads((build / 'manifest.json').read_text()).get('geometry'):
                raise ValueError('geometry mode requires geometry-instrumented plugins')
    out = args.output.resolve()
    out.mkdir()  # Never overwrite a diagnostic run.
    fixtures = sorted(args.fixtures.resolve().glob('*-assigned.xmp'))
    if len(fixtures) != 24:
        raise ValueError(f'expected 24 assigned fixtures, found {len(fixtures)}')
    sizes = args.size or [512]
    report = {'diagnostic_only': True, 'injection': [-1, -.01, '-0', 0, .01, .5, 1, 2, 10],
              'mask_bypass': args.mask_bypass, 'geometry': args.geometry, 'mask_display': args.mask_display, 'distort_mask': args.distort_mask, 'photo_sha256': pixels.digest(args.photo), 'interpolation': args.interpolation,
              'pixel_aspect_ratio': args.aspect, 'cases': {}}
    with tempfile.TemporaryDirectory(prefix='immage-signed-lens-') as tmp:
        for fixture in fixtures:
            for size in sizes:
                key = f'{fixture.stem}-{size}'
                outputs, traces = {}, {}
                for label, build in (('old', args.old), ('direct', args.direct)):
                    prefix = out / f'{key}-{label}'
                    saved = out / f'{key}-{label}.xmp' if args.aspect or args.geometry else None
                    edits = ([{'op': 'scalepixels', 'enabled': True,
                               'params': {'pixel_aspect_ratio': args.aspect}}] if args.aspect else [])
                    if args.geometry:
                        edits.append({'op': 'lens', 'enabled': True,
                                      'params': {'modify_flags': 6}})
                    outputs[label] = pixels.render(build.resolve(), args.photo.resolve(),
                        Path(tmp) / f'{key}-{label}', prefix, [size], sidecar=fixture,
                        resource_level='minimum', interpolation=args.interpolation,
                        edits=edits, save=saved)[size]
                    if saved and args.geometry:
                        ns = '{http://darktable.sf.net/}'
                        lens = next(item for item in ET.parse(saved).iter()
                                    if item.get(ns + 'operation') == 'lens')
                        encoded = lens.get(ns + 'params')
                        params = (zlib.decompress(base64.b64decode(encoded[4:]))
                                  if encoded.startswith('gz') else bytes.fromhex(encoded))
                        if (lens.get(ns + 'modversion') != '10' or len(params) != 356
                                or lens.get(ns + 'enabled') != '1'
                                or struct.unpack_from('<i', params, 4)[0] != 6):
                            raise ValueError('saved geometry flags changed')
                    if saved and args.aspect:
                        ns = '{http://darktable.sf.net/}'
                        aspect = next(item for item in ET.parse(saved).iter()
                                      if item.get(ns + 'operation') == 'scalepixels')
                        encoded = aspect.get(ns + 'params')
                        params = (zlib.decompress(base64.b64decode(encoded[4:]))
                                  if encoded.startswith('gz') else bytes.fromhex(encoded))
                        if (aspect.get(ns + 'modversion') != '1'
                                or aspect.get(ns + 'enabled') != '1'
                                or params != struct.pack('<f', args.aspect)):
                            raise ValueError('saved pixel aspect parameters changed')
                    traces[label] = records(prefix.with_suffix('.log'), args.distort_mask, args.mask_bypass)
                if Counter(traces['old']) != Counter(traces['direct']):
                    raise ValueError(f'floating-row mismatch: {key}')
                if outputs['old'] != outputs['direct']:
                    raise ValueError(f'final frame mismatch: {key}')
                rgb_rows = [row for row in traces['old'] if row.startswith('SIGNED_LENS ')]
                negative = sum(int(row.split()[6]) for row in rgb_rows)
                positive = sum(int(row.split()[7]) for row in rgb_rows)
                report['cases'][key] = {'dimensions': outputs['old'][0],
                    'exact_float_rows': len(rgb_rows), 'exact_mask_rows': sum(row.startswith('MASK_LENS ') for row in traces['old']),
                    'exact_bypass_copies': sum(row.startswith('MASK_BYPASS ') for row in traces['old']), 'negative_output_channels': negative,
                    'positive_output_channels': positive, 'exact_rgba': True}
                (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
                print(key, report['cases'][key], flush=True)
    identities = list(out.iterdir()) + fixtures + [args.photo.resolve(), Path(__file__).resolve(),
        Path(pixels.__file__), Path(__file__).with_name('pin-lens-signed.py').resolve()]
    for build in (args.old.resolve(), args.direct.resolve()):
        identities += [build / 'manifest.json', build / 'bin/darktable-engine',
                       build / 'lib/darktable/plugins/liblens.so']
    (out / 'manifest.json').write_text(json.dumps({str(p): pixels.digest(p) for p in identities}, indent=2) + '\n')


if __name__ == '__main__':
    main()
