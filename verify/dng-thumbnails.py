#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Headless thumbnail fallback checks; generated DNGs and optional copied photos.

python3 -I verify/dng-thumbnails.py [--engine build/bin/darktable-engine] [PHOTO ...]
"""
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


def fixture(path, orientation):
    # DNG 1.7 with an unsupported full-resolution compression and a usable
    # TIFF RGB preview, like Lightroom's JPEG XL panoramas. No real photo data.
    data = bytearray(1024 + 256 * 128 * 3)
    data[:8] = struct.pack('<2sHI', b'II', 42, 8)

    def ifd(offset, entries):
        struct.pack_into('<H', data, offset, len(entries))
        for index, entry in enumerate(sorted(entries)):
            struct.pack_into('<HHII', data, offset + 2 + index * 12, *entry)
        struct.pack_into('<I', data, offset + 2 + len(entries) * 12, 0)

    ifd(8, [(254, 4, 1, 1), (256, 4, 1, 256), (257, 4, 1, 128),
            (258, 3, 3, 256), (259, 3, 1, 1), (262, 3, 1, 2),
            (273, 4, 1, 1024), (274, 3, 1, orientation), (277, 3, 1, 3),
            (278, 4, 1, 128), (279, 4, 1, 256 * 128 * 3), (284, 3, 1, 1),
            (330, 4, 1, 512), (50706, 1, 4, 0x701), (50707, 1, 4, 0x701)])
    struct.pack_into('<3H', data, 256, 8, 8, 8)
    ifd(512, [(254, 4, 1, 0), (256, 4, 1, 1024), (257, 4, 1, 512),
              (258, 3, 3, 262), (259, 3, 1, 52546), (262, 3, 1, 34892),
              (273, 4, 1, 1024), (277, 3, 1, 3), (278, 4, 1, 512),
              (279, 4, 1, 1), (284, 3, 1, 1)])
    struct.pack_into('<3H', data, 262, 16, 16, 16)
    colors = [bytes((255, 0, 0)), bytes((0, 255, 0)),
              bytes((0, 0, 255)), bytes((255, 255, 0))]
    for y in range(128):
        for x in range(256):
            at = 1024 + (y * 256 + x) * 3
            data[at:at + 3] = colors[(y >= 64) * 2 + (x >= 128)]
    path.write_bytes(data)
    return colors


def thumbnail(engine, photo, out):
    imported = engine.call({'cmd': 'import', 'files': [str(photo)]})
    imgid = imported['images'][0]['imgid']
    tag = engine.tagged_send({'cmd': 'thumb', 'imgid': imgid, 'size': 240, 'out': str(out)})
    assert engine.wait_tags([tag], 120), f'thumbnail timed out: {photo.name}'
    reply = engine.tagged[tag][1]
    assert reply.get('ok'), (photo.name, reply)
    width, height = reply['width'], reply['height']
    pixels = out.read_bytes()
    assert width > 0 and height > 0 and len(pixels) == width * height * 4
    assert len(set(pixels)) > 1, 'blank thumbnail'
    return width, height, pixels


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, default=ROOT / 'build/bin/darktable-engine')
    parser.add_argument('photos', type=Path, nargs='*')
    args = parser.parse_args()
    os.environ.setdefault('OMP_NUM_THREADS', '2')
    # Corner order after each EXIF orientation: TL, TR, BL, BR.
    orders = [(0, 1, 2, 3), (1, 0, 3, 2), (3, 2, 1, 0), (2, 3, 0, 1),
              (0, 2, 1, 3), (2, 0, 3, 1), (3, 1, 2, 0), (1, 3, 0, 2)]
    with tempfile.TemporaryDirectory(prefix='immage-dng-thumbnails-') as tmp:
        work = Path(tmp)
        engine = background.Engine(args.engine, work)
        try:
            for orientation in range(1, 9):
                path = work / f'orientation-{orientation}.dng'
                colors = fixture(path, orientation)
                width, height, pixels = thumbnail(engine, path, work / 'thumb.rgba')
                assert (width, height) == ((256, 128) if orientation < 5 else (128, 256))
                corners = [0, width - 1, (height - 1) * width, width * height - 1]
                actual = [pixels[index * 4:index * 4 + 3] for index in corners]
                assert actual == [colors[index] for index in orders[orientation - 1]], (orientation, actual)
                print(f'PASS TIFF preview fallback and orientation {orientation}', flush=True)
            # A real saved edit supplies a valid sidecar. It must prevent an
            # unsupported DNG from silently showing its unedited preview.
            editable = work / 'editable.jpg'
            shutil.copyfile(ROOT / 'app/sample/stairs-to-mountain.jpg', editable)
            engine.call({'cmd': 'open', 'path': str(editable)})
            engine.call({'cmd': 'baseline_end'})
            engine.call({'cmd': 'set', 'op': 'exposure', 'enabled': True, 'params': {'exposure': 0.8}})
            engine.call({'cmd': 'save'})
            engine.call({'cmd': 'close'})
            edited = work / 'edited.dng'
            fixture(edited, 1)
            shutil.copyfile(str(editable) + '.xmp', str(edited) + '.xmp')
            imported = engine.call({'cmd': 'import', 'files': [str(edited)]})['images'][0]
            assert imported['edited'], 'edited sidecar was not loaded'
            tag = engine.tagged_send({'cmd': 'thumb', 'imgid': imported['imgid'],
                                      'size': 240, 'out': str(work / 'edited.rgba')})
            assert engine.wait_tags([tag], 120)
            assert not engine.tagged[tag][1].get('ok'), 'unedited preview used for edited photo'
            print('PASS edited photos refuse unedited preview fallback', flush=True)
            for index, source in enumerate(args.photos):
                copied = work / f'photo-{index}{source.suffix}'
                shutil.copyfile(source.expanduser(), copied)
                width, height, _ = thumbnail(engine, copied, work / 'thumb.rgba')
                print(f'PASS copied {source.name}: {width}x{height}', flush=True)
        finally:
            engine.close()


if __name__ == '__main__':
    main()
