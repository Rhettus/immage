#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Headless check that a subtracted object with holes keeps its holes out of the mask.

A mask is an ellipse plus a subtracted "object" (an AI Background: the frame
as an outline, the subject as a hole). That subtracts the frame less the
subject, so what stays is the ellipse where it overlaps the subject. The
subject must not be added back outside the ellipse. Also checks that the object
reads back with mode subtract and the same hole flags. No GUI, no AI model.
"""
import argparse
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
background = __import__('background-priority')
ROOT = background.ROOT


def rect(x0, y0, x1, y1, hole=False):
    pts = [[x, y, x, y, x, y] for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]
    return {'hole': hole, 'points': pts}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, default=ROOT / 'build/bin/darktable-engine')
    args = parser.parse_args()
    width, height = 600, 400
    failures = []

    def check(label, ok, detail=''):
        print(('PASS ' if ok else 'FAIL ') + label + (' ' + detail if detail else ''))
        if not ok:
            failures.append(label)

    with tempfile.TemporaryDirectory(prefix='immage-object-holes-') as tmp:
        work = Path(tmp)
        photo = work / 'photo.tif'
        photo.write_bytes(background.tiff(width, height))
        eng = background.Engine(args.engine, work)
        try:
            eng.call({'cmd': 'open', 'path': str(photo)})
            shapes = [
                {'type': 'ellipse', 'mode': 'add', 'x': 0.35, 'y': 0.5, 'rx': 0.2, 'ry': 0.3, 'feather': 0.0},
                {'type': 'object', 'mode': 'subtract', 'feather': 0.0,
                 'paths': [rect(0.02, 0.02, 0.98, 0.98), rect(0.4, 0.25, 0.9, 0.75, True)]},
            ]
            eng.call({'cmd': 'mask', 'name': 'Obj', 'shapes': shapes})
            eng.call({'cmd': 'set', 'op': 'exposure', 'instance': 'Obj', 'mask': 'Obj', 'invert': False,
                      'opacity': 100, 'enabled': True, 'params': {'exposure': 1}})
            out = work / 'map.u8'
            reply = eng.call({'cmd': 'mask_map', 'op': 'exposure#Obj', 'width': width, 'height': height,
                              'out': str(out)})
            w, h = reply['width'], reply['height']
            data = out.read_bytes()
            assert len(data) == w * h, (len(data), w, h)

            def at(x, y):
                return data[int(y * h) * w + int(x * w)]

            check('inside the hole, outside the ellipse is off', at(0.8, 0.5) < 8, f'value {at(0.8, 0.5)}')
            check('inside the ellipse and the hole is on', at(0.47, 0.5) > 247, f'value {at(0.47, 0.5)}')
            check('inside the ellipse, outside the hole is off', at(0.25, 0.5) < 8, f'value {at(0.25, 0.5)}')
            check('outside everything is off', at(0.95, 0.95) < 8, f'value {at(0.95, 0.95)}')

            masks = eng.call({'cmd': 'masks', 'fields': {}})['masks']
            shown = next(m for m in masks if m['name'] == 'Obj')['shapes']
            obj = [s for s in shown if s['type'] == 'object']
            check('the mask reads back as an ellipse and one object', len(shown) == 2 and len(obj) == 1,
                  str([s['type'] for s in shown]))
            if obj:
                check('the object reads back as subtract', obj[0]['mode'] == 'subtract', obj[0]['mode'])
                check('the object keeps its hole flags', [p['hole'] for p in obj[0]['paths']] == [False, True],
                      str([p['hole'] for p in obj[0]['paths']]))
            eng.call({'cmd': 'save'})
        finally:
            eng.close()
        # the saved edit, read by a new engine, renders and reads back the same
        eng = background.Engine(args.engine, work)
        try:
            eng.call({'cmd': 'open', 'path': str(photo)})
            eng.call({'cmd': 'mask_map', 'op': 'exposure#Obj', 'width': width, 'height': height,
                      'out': str(out)})
            data = out.read_bytes()
            check('after reopening, inside the hole outside the ellipse is off', at(0.8, 0.5) < 8)
            check('after reopening, inside both is on', at(0.47, 0.5) > 247)
            masks = eng.call({'cmd': 'masks', 'fields': {}})['masks']
            shown = next(m for m in masks if m['name'] == 'Obj')['shapes']
            check('after reopening, the object reads back with its holes',
                  [s.get('mode') for s in shown if s['type'] == 'object'] == ['subtract'] and
                  [p['hole'] for s in shown if s['type'] == 'object' for p in s['paths']] == [False, True])
        finally:
            eng.close()
    if failures:
        print(f'{len(failures)} check(s) failed')
        sys.exit(1)
    print('all checks passed; no GUI launched')


if __name__ == '__main__':
    main()
