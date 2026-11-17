#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Headless check of an inverted mask with ranges, no GUI.

An inverted mask with a range and drawn shapes is the shapes as the engine
stores them, inverted, times the inverted range: (1 - S) * (1 - r). The mask
map the engine renders is compared with S and r measured from the same mask
without the other part. Drawn-only and range-only masks must keep 1 - S and
1 - r, and a mask that is not inverted S * r.
"""
import argparse
import json
import os
from pathlib import Path
import selectors
import struct
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
W, H = 240, 160
TOL = 4  # of 255: the map is 8 bit and resampled


def tiff():
    """Grey horizontal ramp, so a luminance range selects a band."""
    tags = [(256, 4, W), (257, 4, H), (258, 3, 0), (259, 3, 1), (262, 3, 2), (273, 4, 0),
            (274, 3, 1), (277, 3, 3), (278, 4, H), (279, 4, W * H * 3), (284, 3, 1)]
    extra = 8 + 2 + 12 * len(tags) + 4
    out = b'II' + struct.pack('<HIH', 42, 8, len(tags))
    for tag, kind, value in tags:
        count = 3 if tag == 258 else 1
        if tag == 258:
            value = extra
        elif tag == 273:
            value = extra + 6
        out += struct.pack('<HHI', tag, kind, count)
        out += struct.pack('<I', value) if kind == 4 or count > 1 else struct.pack('<H', value) + b'\0\0'
    out += struct.pack('<IHHH', 0, 8, 8, 8)
    row = bytearray()
    for x in range(W):
        v = 20 + x * 220 // W
        row += bytes((v, v, v))
    return out + bytes(row) * H


ELLIPSE = {'type': 'ellipse', 'x': 0.4, 'y': 0.5, 'rx': 0.2, 'ry': 0.3, 'feather': 0.3, 'mode': 'add'}
LUMA = {'type': 'luminance', 'lo': -3.0, 'hi': -1.0, 'feather': 1.0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, default=ROOT / 'build/bin/darktable-engine')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='immage-invert-') as tmp:
        work = Path(tmp)
        (work / 'ramp.tif').write_bytes(tiff())
        with (work / 'engine.log').open('w') as log:
            child = subprocess.Popen(
                [str(args.engine.resolve()), '--core', '--configdir', str(work / 'config'),
                 '--cachedir', str(work / 'cache'), '--conf', 'opencl=false',
                 '--conf', 'resourcelevel=0'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=log, text=True, env=os.environ | {'OMP_NUM_THREADS': '2',
                'OMP_WAIT_POLICY': 'passive', 'XDG_DATA_HOME': str(work / 'data')})
            poll = selectors.DefaultSelector()
            poll.register(child.stdout, selectors.EVENT_READ)

            def request(data):
                child.stdin.write(json.dumps(data) + '\n')
                child.stdin.flush()
                assert poll.select(120), f'engine timeout: {data}'
                reply = json.loads(child.stdout.readline())
                assert reply.get('ok'), f'{data}: {reply}'
                return reply

            counter = [0]

            def mask_map(shapes, invert):
                counter[0] += 1
                name = f'm{counter[0]}'
                request({'cmd': 'mask', 'name': name, 'shapes': shapes})
                request({'cmd': 'set', 'op': 'exposure', 'instance': name, 'params': {'exposure': 0.5},
                         'mask': name, 'invert': invert})
                out = work / f'{name}.map'
                reply = request({'cmd': 'mask_map', 'name': name, 'width': 48, 'height': 32,
                                 'out': str(out)})
                data = out.read_bytes()
                assert len(data) == reply['width'] * reply['height'], (len(data), reply)
                return name, list(data)

            def close(label, got, want):
                worst = max(abs(a - b) for a, b in zip(got, want))
                print(f'{label}: worst difference {worst}/255', flush=True)
                assert worst <= TOL, f'{label}: {worst}'

            try:
                request({'cmd': 'open', 'path': str(work / 'ramp.tif')})
                sub = dict(ELLIPSE, mode='subtract')
                _, S = mask_map([ELLIPSE], False)
                _, r = mask_map([LUMA], False)
                assert min(r) < 60 and max(r) > 200, 'the range must be partial'
                assert min(S) < 20 and max(S) > 235, 'the shape must be partial'
                _, c_sr = mask_map([ELLIPSE, LUMA], False)
                close('S * r', c_sr, [s * v // 255 for s, v in zip(S, r)])
                _, c_sub = mask_map([sub, LUMA], False)
                close('(1 - S) * r', c_sub, [(255 - s) * v // 255 for s, v in zip(S, r)])
                name, inv = mask_map([ELLIPSE, LUMA], True)
                close('(1 - S) * (1 - r)', inv,
                      [(255 - s) * (255 - v) // 255 for s, v in zip(S, r)])
                _, inv_sub = mask_map([sub, LUMA], True)
                close('S_sub inverted with range: S * (1 - r)', inv_sub,
                      [s * (255 - v) // 255 for s, v in zip(S, r)])
                _, inv_range = mask_map([LUMA], True)
                close('range only inverted: 1 - r', inv_range, [255 - v for v in r])
                _, inv_draw = mask_map([ELLIPSE], True)
                close('drawn only inverted: 1 - S', inv_draw, [255 - s for s in S])
                # the last mask's instance sees the same input throughout (a
                # newer instance runs ahead of the older ones), so its own
                # inversion can be toggled and its shapes resent
                shapes = [ELLIPSE, LUMA]
                name, plain = mask_map(shapes, False)

                def again(label):
                    out = work / 'again.map'
                    request({'cmd': 'mask_map', 'name': name, 'width': 48, 'height': 32, 'out': str(out)})
                    return list(out.read_bytes())

                def inverted():
                    got = request({'cmd': 'masks'})['masks']
                    return [m['invert'] for m in got if m['name'] == name][0]

                assert not inverted()
                request({'cmd': 'set', 'op': 'exposure', 'instance': name, 'mask': name, 'invert': True})
                assert inverted(), 'the inversion must read back'
                flipped = again('inverted')
                assert max(abs(a - b) for a, b in zip(flipped, plain)) > 100, 'the inversion had no effect'
                request({'cmd': 'mask', 'name': name, 'shapes': shapes})
                assert inverted(), 'reshaping must keep the inversion'
                close('reshaped keeps the inversion', again('reshaped'), flipped)
                request({'cmd': 'set', 'op': 'exposure', 'instance': name, 'mask': name, 'invert': False})
                assert not inverted()
                close('inversion turned off: S * r', again('off'), plain)
                request({'cmd': 'quit'})
                child.wait(timeout=15)
                print('inverted range mask checks passed; no GUI launched')
            except BaseException:
                log.flush()
                print((work / 'engine.log').read_text()[-6000:], file=sys.stderr)
                raise
            finally:
                poll.close()
                if child.poll() is None:
                    child.kill()
                    child.wait()


if __name__ == '__main__':
    main()
