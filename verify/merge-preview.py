#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Merge DNGs carry an embedded JPEG preview of the merge (headless).

A panorama of the sample JPEG (a rendered merge), and with a camera RAW
(--raw or IMMAGE_TEST_RAW) a panorama and an HDR merge of copies of it.
Each DNG must have IFD1 after IFD0, marked reduced-resolution, with a JPEG
that fits 3840 x 2160 and ends within the first 16 MB (the metadata prefix
exif.cc reads), and the JPEG, turned by the DNG's orientation, must look
like darktable's own render of the merge. A portrait RAW checks the turn.

    python3 -I verify/merge-preview.py [--engine build/bin/darktable-engine] [--raw PHOTO]"""
import argparse
import importlib.util
import os
from pathlib import Path
import shutil
import struct
import tempfile

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('background', ROOT / 'verify/background-priority.py')
background = importlib.util.module_from_spec(spec)
spec.loader.exec_module(background)
SIZE = 512
LIMIT = 3.0  # mean absolute difference of 16 x 16 block means, 8-bit


def ifd1_jpeg(path):
    data = path.read_bytes()
    order = '<' if data[:2] == b'II' else '>'
    u16 = lambda at: struct.unpack_from(order + 'H', data, at)[0]
    u32 = lambda at: struct.unpack_from(order + 'I', data, at)[0]
    ifd0 = u32(4)
    orientation = 1
    for i in range(u16(ifd0)):
        if u16(ifd0 + 2 + 12 * i) == 274:
            orientation = u16(ifd0 + 2 + 12 * i + 8)
    ifd1 = u32(ifd0 + 2 + 12 * u16(ifd0))
    assert ifd1, f'{path.name}: no IFD1, so no embedded preview'
    tags = {}
    for i in range(u16(ifd1)):
        entry = ifd1 + 2 + 12 * i
        kind = u16(entry + 2)
        tags[u16(entry)] = u16(entry + 8) if kind == 3 else u32(entry + 8)
    assert tags.get(254) == 1, f'{path.name}: preview not marked reduced-resolution: {tags}'
    assert tags.get(259) == 6, f'{path.name}: preview not JPEG: {tags}'
    start, length = tags[513], tags[514]
    assert start + length <= 16 << 20, f'{path.name}: preview ends at {start + length}, past the 16 MB prefix'
    jpeg = data[start:start + length]
    assert jpeg[:2] == b'\xff\xd8', f'{path.name}: preview is not a JPEG'
    at = 2
    while at < len(jpeg):
        marker, size = jpeg[at + 1], struct.unpack_from('>H', jpeg, at + 2)[0]
        # no EXIF or XMP: a reader must turn it by the DNG's orientation only
        assert marker != 0xe1, f'{path.name}: the preview has an APP1 segment'
        if marker in (0xc0, 0xc1, 0xc2):
            height, width = struct.unpack_from('>HH', jpeg, at + 5)
            break
        at += 2 + size
    else:
        raise AssertionError(f'{path.name}: no frame header in the preview')
    assert max(width, height) <= 3840 and min(width, height) <= 2160, f'{path.name}: preview {width}x{height}'
    return jpeg, width, height, start, orientation


def decoded(engine, work, jpeg, name):
    # the engine's own JPEG decoder, fitted to SIZE
    path = work / f'{name}.jpg'
    path.write_bytes(jpeg)
    imgid = engine.call({'cmd': 'import', 'files': [str(path)]})['images'][0]['imgid']
    out = work / f'{name}.rgba'
    reply = engine.call({'cmd': 'thumb', 'imgid': imgid, 'size': SIZE, 'prefer_source': True, 'out': str(out)})
    assert reply.get('ok'), reply
    return reply['width'], reply['height'], out.read_bytes()


def turned(width, height, pixels, orientation):
    # stored RGBA as shown under a TIFF Orientation
    swap = orientation in (5, 6, 7, 8)
    out_w, out_h = (height, width) if swap else (width, height)
    out = bytearray(len(pixels))
    for y in range(out_h):
        for x in range(out_w):
            sx, sy = {1: (x, y), 2: (width - 1 - x, y), 3: (width - 1 - x, height - 1 - y),
                      4: (x, height - 1 - y), 5: (y, x), 6: (y, height - 1 - x),
                      7: (width - 1 - y, height - 1 - x), 8: (width - 1 - y, x)}[orientation]
            at = (sy * width + sx) * 4
            out[(y * out_w + x) * 4:(y * out_w + x) * 4 + 4] = pixels[at:at + 4]
    return out_w, out_h, bytes(out)


def cropped(width, height, pixels, to_width, to_height):
    return b''.join(pixels[y * width * 4:(y * width + to_width) * 4] for y in range(to_height))


def blocks_diff(width, height, a, b, n=16):
    # mean absolute difference of n x n block means: the engine's fit decode
    # samples without filtering, a turned photo a pixel apart from an upright
    # one, so single pixels differ wherever there is
    # fine detail; a wrong look or turn still shows in the blocks
    total = count = 0
    for by in range(0, height - n + 1, n):
        for bx in range(0, width - n + 1, n):
            for c in range(3):
                at = [((by + y) * width + bx + x) * 4 + c for y in range(n) for x in range(n)]
                total += abs(sum(a[i] for i in at) - sum(b[i] for i in at)) / (n * n)
                count += 1
    return total / count


def check(engine, work, path, imgid, label):
    jpeg, width, height, start, orientation = ifd1_jpeg(path)
    # stored as the raw is, as camera previews are: shown turned by the
    # DNG's orientation, as darktable turns an embedded preview
    # (mipmap_cache.c, _init_8), which the grid of an unedited merge shows
    preview = turned(*decoded(engine, work, jpeg, f'{label}-preview'), orientation)
    rendered = work / f'{label}-render.jpg'
    reply = engine.call({'cmd': 'export', 'imgid': imgid, 'out': str(rendered), 'format': 'jpeg',
                         'quality': 100, 'long_edge': max(width, height)}, 300)
    assert reply.get('ok'), reply
    reference = decoded(engine, work, rendered.read_bytes(), f'{label}-render')
    # an HDR copy drops up to a few pattern periods, so a fitted size may
    # round a pixel apart
    assert all(abs(p - r) <= 1 for p, r in zip(preview[:2], reference[:2])), \
        f'{label}: preview {preview[:2]}, render {reference[:2]}'
    w, h = min(preview[0], reference[0]), min(preview[1], reference[1])
    diff = blocks_diff(w, h, cropped(*preview, w, h), cropped(*reference, w, h))
    print(f'{label}: preview {width}x{height} at byte {start}, {len(jpeg)} bytes, orientation {orientation}; '
          f'block difference from the render {diff:.2f} (limit {LIMIT})')
    assert diff < LIMIT, f'{label}: the preview does not look like the merge'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, default=ROOT / 'build/bin/darktable-engine')
    parser.add_argument('--raw', type=Path, default=os.environ.get('IMMAGE_TEST_RAW'))
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='immage-merge-preview-') as tmp:
        work = Path(tmp)
        engine = background.Engine(args.engine, work)
        try:
            if not engine.call({'cmd': 'version'}).get('pano'):
                print('OpenCV stitching unavailable; panoramas skipped')
            else:
                source = work / 'source.jpg'
                shutil.copy(ROOT / 'app/sample/stairs-to-mountain.jpg', source)
                opened = engine.call({'cmd': 'open', 'path': str(source)})
                a, b = work / 'a.jpg', work / 'b.jpg'
                engine.call({'cmd': 'export', 'imgid': opened['imgid'], 'out': str(a), 'format': 'jpeg',
                             'long_edge': 1000, 'quality': 100})
                engine.call({'cmd': 'close'})
                shutil.copy(a, b)
                images = engine.call({'cmd': 'import', 'files': [str(a), str(b)]})['images']
                reply = engine.call({'cmd': 'pano_merge', 'imgids': [i['imgid'] for i in images],
                                     'projection': 'perspective', 'crop': True}, 300)
                assert reply.get('ok'), reply
                check(engine, work, Path(reply['path']), reply['image']['imgid'], 'rendered panorama')
            if args.raw:
                frames = [work / f'raw{k}{args.raw.suffix}' for k in range(2)]
                for frame in frames:
                    shutil.copy(args.raw, frame)
                images = engine.call({'cmd': 'import', 'files': [str(f) for f in frames]})['images']
                imgids = [i['imgid'] for i in images]
                for cmd in ('pano_merge', 'hdr_merge'):
                    if cmd == 'pano_merge' and not engine.call({'cmd': 'version'}).get('pano'):
                        continue
                    reply = engine.call({'cmd': cmd, 'imgids': imgids, 'projection': 'perspective',
                                         'crop': True, 'align': False}, 600)
                    assert reply.get('ok'), reply
                    check(engine, work, Path(reply['path']), reply['image']['imgid'], f'raw {cmd}')
            else:
                print('no camera RAW (--raw or IMMAGE_TEST_RAW): raw merges skipped')
            left = list((work / 'cache' / 'merge-preview').glob('*'))
            assert not left, f'the preview step left {left}'
            print('PASS')
        finally:
            engine.close()


if __name__ == '__main__':
    main()
