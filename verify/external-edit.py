#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""A photo saved over by another program opens and thumbnails anew (headless).

darktable caches a photo's pixels by image id. The engine checks the file's
size, modified time and inode before a reopen and a thumbnail, and drops
the cached pixels when they changed. Three saves are checked: one that
replaces the file with a new size (an editor's save by rename), one that
rewrites it in place at the same size, and one while the photo is open,
whose thumbnail is flagged stale until the photo closes.

    python3 -I verify/external-edit.py [--engine build/bin/darktable-engine]"""
import argparse
import importlib.util
import os
from pathlib import Path
import struct
import tempfile

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('background', ROOT / 'verify/background-priority.py')
background = importlib.util.module_from_spec(spec)
spec.loader.exec_module(background)


def tiff(width, height, rgb, model=None):
    """8-bit RGB, one strip, one flat color; `model` is the camera model tag."""
    extra = b''
    tags = [(256, 4, 1, width), (257, 4, 1, height), (258, 3, 3, 'bits'), (259, 3, 1, 1), (262, 3, 1, 2),
            (273, 4, 1, 'strip'), (274, 3, 1, 1), (277, 3, 1, 3), (278, 4, 1, height),
            (279, 4, 1, width * height * 3), (284, 3, 1, 1)]
    if model:
        tags.insert(5, (272, 2, len(model) + 1, 'model'))
    data_at = 8 + 2 + 12 * len(tags) + 4
    blobs = {'bits': struct.pack('<HHH', 8, 8, 8)}
    if model:
        blobs['model'] = model.encode() + b'\0'
    offsets = {}
    for name, blob in blobs.items():
        offsets[name] = data_at + len(extra)
        extra += blob + (b'\0' if len(blob) % 2 else b'')
    offsets['strip'] = data_at + len(extra)
    out = b'II' + struct.pack('<HIH', 42, 8, len(tags))
    for tag, kind, count, value in tags:
        if value in blobs:
            out += struct.pack('<HHII', tag, kind, count, offsets[value])
        elif value == 'strip':
            out += struct.pack('<HHII', tag, kind, count, offsets['strip'])
        elif kind == 4:
            out += struct.pack('<HHII', tag, kind, count, value)
        else:
            out += struct.pack('<HHIH', tag, kind, count, value) + b'\0\0'
    out += struct.pack('<I', 0)
    return out + extra + bytes(rgb) * (width * height)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, default=ROOT / 'build/bin/darktable-engine')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='immage-external-edit-') as tmp:
        work = Path(tmp)
        photo = work / 'photo.tif'
        photo.write_bytes(tiff(400, 300, (230, 30, 30)))
        engine = background.Engine(args.engine, work)
        try:
            def thumb(name, stale=False):
                out = work / name
                tag = engine.tagged_send({'cmd': 'thumb', 'imgid': imgid, 'size': 240, 'out': str(out)})
                assert engine.wait_tags([tag], 60), 'thumbnail never replied'
                reply = engine.tagged[tag][1]
                assert reply.get('ok'), reply
                assert reply.get('stale', False) == stale, f'{name}: stale {reply.get("stale")}, expected {stale}'
                return out.read_bytes()

            def reopen():
                engine.call({'cmd': 'close'})
                return engine.call({'cmd': 'open', 'path': str(photo)})

            first = engine.call({'cmd': 'open', 'path': str(photo)})
            imgid = first['imgid']
            assert (first['width'], first['height']) == (400, 300), first
            red = thumb('red.rgba')

            # saved by rename: a new file at the same path, another size
            fresh = work / 'photo.tif.tmp'
            fresh.write_bytes(tiff(300, 400, (30, 30, 230)))
            os.replace(fresh, photo)
            second = reopen()
            assert second['imgid'] == imgid, (first, second)
            assert (second['width'], second['height']) == (300, 400), \
                f'reopen kept the old pixels: {second["width"]}x{second["height"]}'
            blue = thumb('blue.rgba')
            assert blue != red, 'thumbnail kept the old pixels after a replace'

            # rewritten in place: same inode and size, a later modified time
            stat = photo.stat()
            with photo.open('r+b') as f:
                f.write(tiff(300, 400, (30, 230, 30)))
            os.utime(photo, ns=(stat.st_atime_ns, stat.st_mtime_ns + 2_000_000_000))
            third = reopen()
            assert (third['width'], third['height']) == (300, 400), third
            green = thumb('green.rgba')
            assert green not in (red, blue), 'thumbnail kept the old pixels after an in-place save'

            # saved over while open: the open photo holds the old pixels, so
            # the thumbnail is flagged stale (the app does not keep it) until
            # the photo is closed; then the new one is built
            fresh.write_bytes(tiff(300, 400, (230, 230, 30)))
            os.replace(fresh, photo)
            thumb('held.rgba', stale=True)
            thumb('held-again.rgba', stale=True)
            engine.call({'cmd': 'close'})
            yellow = thumb('yellow.rgba')
            assert yellow not in (red, blue, green), 'thumbnail kept the old pixels after the photo closed'
            engine.call({'cmd': 'open', 'path': str(photo)})
            green = yellow

            # unchanged: the cached pixels stay (no reload line in the log)
            engine.log.flush()
            before = engine.log_path.read_text(errors='replace').count('changed on disk')
            reopen()
            assert thumb('again.rgba') == green
            engine.log.flush()
            after = engine.log_path.read_text(errors='replace').count('changed on disk')
            assert (before, after) == (3, 3), f'reload lines {before} -> {after}, expected 3 -> 3'
            # saved over after its import, before anything looked at it:
            # the import's stamp tells the change from a first sight, so the
            # EXIF is read again too
            other = work / 'other.tif'
            other.write_bytes(tiff(400, 300, (90, 90, 90), model='ALPHA'))
            tag = engine.tagged_send({'cmd': 'import', 'files': [str(other)]})
            assert engine.wait_tags([tag], 60), 'import never replied'
            imgid = engine.tagged[tag][1]['images'][0]['imgid']
            fresh.write_bytes(tiff(400, 300, (200, 90, 90), model='BETA'))
            os.replace(fresh, other)
            thumb('other.rgba')
            tag = engine.tagged_send({'cmd': 'meta', 'imgid': imgid})
            assert engine.wait_tags([tag], 60), 'meta never replied'
            model = engine.tagged[tag][1]['image']['exif']['model']
            assert model == 'BETA', f'EXIF of the file as imported kept: {model}'
            print('PASS')
        finally:
            engine.close()


if __name__ == '__main__':
    main()
