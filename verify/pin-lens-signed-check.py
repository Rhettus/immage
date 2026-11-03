#!/usr/bin/env python3
"""Compare isolated signed-input plugins at the floating vignetting boundary.

Requires assigned XMP fixtures from the exceptional-profile diagnostic. These
are synthetic inputs on an unrelated photo, not matching-camera validation.
"""
import argparse
from collections import Counter
import importlib.util
import json
from pathlib import Path
import tempfile

spec = importlib.util.spec_from_file_location('pixels', Path(__file__).with_name('pin-pixels.py'))
pixels = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pixels)


def records(log):
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
    if not rows:
        raise ValueError(f'no actual-pixel Lensfun calls in {log}')
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('old', 'direct', 'fixtures', 'photo', 'output'):
        parser.add_argument(f'--{name}', type=Path, required=True)
    parser.add_argument('--size', type=int, action='append', default=[])
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir()  # Never overwrite a diagnostic run.
    fixtures = sorted(args.fixtures.resolve().glob('*-assigned.xmp'))
    if len(fixtures) != 24:
        raise ValueError(f'expected 24 assigned fixtures, found {len(fixtures)}')
    sizes = args.size or [512]
    report = {'diagnostic_only': True, 'injection': [-1, -.01, '-0', 0, .01, .5, 1, 2, 10],
              'photo_sha256': pixels.digest(args.photo), 'cases': {}}
    with tempfile.TemporaryDirectory(prefix='immage-signed-lens-') as tmp:
        for fixture in fixtures:
            for size in sizes:
                key = f'{fixture.stem}-{size}'
                outputs, traces = {}, {}
                for label, build in (('old', args.old), ('direct', args.direct)):
                    prefix = out / f'{key}-{label}'
                    outputs[label] = pixels.render(build.resolve(), args.photo.resolve(),
                        Path(tmp) / f'{key}-{label}', prefix, [size], sidecar=fixture,
                        resource_level='minimum')[size]
                    traces[label] = records(prefix.with_suffix('.log'))
                if Counter(traces['old']) != Counter(traces['direct']):
                    raise ValueError(f'floating-row mismatch: {key}')
                if outputs['old'] != outputs['direct']:
                    raise ValueError(f'final frame mismatch: {key}')
                negative = sum(int(row.split()[6]) for row in traces['old'])
                positive = sum(int(row.split()[7]) for row in traces['old'])
                report['cases'][key] = {'dimensions': outputs['old'][0],
                    'exact_float_rows': len(traces['old']), 'negative_output_channels': negative,
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
