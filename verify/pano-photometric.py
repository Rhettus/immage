#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Headless Panorama Merge check: frames of one scene shot at different
exposures, tints and with lens vignetting must stitch into a sky without
steps or bands at the overlaps."""
import argparse
import base64
import json
import math
import os
from pathlib import Path
import selectors
import struct
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent

WIDTH, HEIGHT, FOCAL = 800, 600, 700.0
YAWS = [0.0, 35.0, 70.0, 105.0]
EVS = [0.0, 0.6, -0.5, 0.3]
TINTS = [(1.0, 1.0, 1.0), (1.06, 1.0, 0.95), (0.95, 1.0, 1.05), (1.03, 1.0, 0.97)]
VIGNETTING = 0.35  # V(r) = 1 - 0.35 r^2, r 1 at the corner


def _cell(i, j):
    v = math.sin(i * 12.9898 + j * 78.233) * 43758.5453
    return v - math.floor(v)


def scene(phi, h):
    """Linear sRGB: a sky that depends on height alone over textured ground."""
    if h < 0.08:
        lum = 0.32 - 0.25 * (0.08 - h)
        return (0.55 * lum, 0.75 * lum, 1.0 * lum)
    v = 0.04 + 0.3 * _cell(math.floor(phi * 45), math.floor(h * 45))
    v *= 0.8 + 0.2 * math.sin(phi * 131.0) * math.cos(h * 97.0)
    return (v, 0.9 * v, 0.7 * v)


def _srgb(v):
    v = min(max(v, 0.0), 1.0)
    return 12.92 * v if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055


def _linear(e):
    return e / 12.92 if e <= 0.04045 else ((e + 0.055) / 1.055) ** 2.4


def tiff16(k):
    """A 16-bit sRGB TIFF of frame k: the scene seen at YAWS[k] through a
    lens of FOCAL pixels, with EVS[k], TINTS[k] and the vignetting."""
    tags = [(256, 4, WIDTH), (257, 4, HEIGHT), (258, 3, 0), (259, 3, 1), (262, 3, 2), (273, 4, 0),
            (277, 3, 3), (278, 4, HEIGHT), (279, 4, WIDTH * HEIGHT * 6), (284, 3, 1)]
    extra = 8 + 2 + 12 * len(tags) + 4
    header = b'II' + struct.pack('<HIH', 42, 8, len(tags))
    for tag, kind, value in tags:
        count = 3 if tag == 258 else 1
        if tag == 258:
            value = extra
        elif tag == 273:
            value = extra + 6
        payload = struct.pack('<I', value) if kind == 4 or count > 1 else struct.pack('<H', value) + b'\0\0'
        header += struct.pack('<HHI', tag, kind, count) + payload
    header += struct.pack('<IHHH', 0, 16, 16, 16)
    yaw, gain, tint = math.radians(YAWS[k]), 2.0 ** EVS[k], TINTS[k]
    cx, cy = WIDTH / 2, HEIGHT / 2
    corner = cx * cx + cy * cy
    pixels = bytearray()
    for y in range(HEIGHT):
        dy = y + 0.5 - cy
        for x in range(WIDTH):
            dx = x + 0.5 - cx
            phi = yaw + math.atan2(dx, FOCAL)
            h = dy / math.hypot(dx, FOCAL)
            v = gain * (1.0 - VIGNETTING * (dx * dx + dy * dy) / corner)
            rgb = scene(phi, h)
            pixels.extend(struct.pack('<3H', *(round(_srgb(rgb[c] * v * tint[c]) * 65535) for c in range(3))))
    return header + pixels


def bands(reply):
    """The sky's column profile in log luminance, less a quadratic fit: the
    largest deviation, smoothed over 9 columns. The outer 5% at each end is
    left out: there the first and last frames' corners lie outside every
    overlap, so their vignetting is extrapolated rather than measured"""
    w, h = reply['width'], reply['height']
    x0, y0, cw, ch = reply['crop']
    rgba = base64.b64decode(reply['rgba'])
    lut = [_linear(e / 255) for e in range(256)]
    xs, profile = [], []
    for x in range(x0 + cw // 20, x0 + cw - cw // 20):
        total, n = 0.0, 0
        for y in range(y0 + ch // 20, y0 + ch // 4):
            i = 4 * (y * w + x)
            if rgba[i + 3]:
                total += math.log(max(1e-4, (lut[rgba[i]] + lut[rgba[i + 1]] + lut[rgba[i + 2]]) / 3))
                n += 1
        if n:
            xs.append((x - x0) / cw)
            profile.append(total / n)
    smooth = [sum(profile[max(0, i - 4):i + 5]) / len(profile[max(0, i - 4):i + 5]) for i in range(len(profile))]
    # least squares a + b x + c x^2
    s = [[sum(x ** (i + j) for x in xs) for j in range(3)] for i in range(3)]
    t = [sum(p * x ** i for x, p in zip(xs, smooth)) for i in range(3)]
    for i in range(3):
        for j in range(i + 1, 3):
            f = s[j][i] / s[i][i]
            s[j] = [a - f * b for a, b in zip(s[j], s[i])]
            t[j] -= f * t[i]
    coef = [0.0] * 3
    for i in (2, 1, 0):
        coef[i] = (t[i] - sum(s[i][j] * coef[j] for j in range(i + 1, 3))) / s[i][i]
    return max(abs(p - (coef[0] + coef[1] * x + coef[2] * x * x)) for x, p in zip(xs, smooth))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, default=ROOT / 'build/bin/darktable-engine')
    parser.add_argument('--limit', type=float, default=0.015,
                        help='largest sky deviation allowed, in natural log units')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='immage-pano-photometric-') as tmp:
        work = Path(tmp)
        files = []
        for k in range(len(YAWS)):
            path = work / f'frame{k}.tif'
            path.write_bytes(tiff16(k))
            files.append(str(path))
        with (work / 'engine.log').open('w') as log:
            child = subprocess.Popen(
                [str(args.engine.resolve()), '--core', '--configdir', str(work / 'config'),
                 '--cachedir', str(work / 'cache'), '--conf', 'opencl=false',
                 '--conf', 'resourcelevel=0'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=log, text=True, env=os.environ | {'OMP_NUM_THREADS': '2',
                'OMP_WAIT_POLICY': 'passive', 'XDG_DATA_HOME': str(work / 'data')})
            poll = selectors.DefaultSelector()
            poll.register(child.stdout, selectors.EVENT_READ)

            def request(data, timeout=60):
                child.stdin.write(json.dumps(data) + '\n')
                child.stdin.flush()
                while True:
                    assert poll.select(timeout), f'engine timeout: {data}'
                    reply = json.loads(child.stdout.readline())
                    if 'tag' in data and (reply.get('tag') != data['tag'] or 'progress' in reply):
                        continue
                    assert reply.get('ok'), f'{data}: {reply}'
                    return reply

            try:
                version = request({'cmd': 'version'})
                if not version.get('pano'):
                    print('OpenCV stitching unavailable; skipped')
                    return
                images = request({'cmd': 'import', 'files': files})['images']
                reply = request({'cmd': 'pano_preview', 'tag': 1, 'projection': 'cylindrical',
                                 'imgids': [i['imgid'] for i in images]}, timeout=300)
                assert reply['used'] == len(YAWS), reply['used']
                deviation = bands(reply)
                print(f'sky deviation {deviation:.4f} (limit {args.limit})')
                request({'cmd': 'quit'})
                child.wait(timeout=15)
                assert deviation < args.limit, 'the sky shows steps or bands at the overlaps'
                print('panorama exposure matching passed; no GUI launched')
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
