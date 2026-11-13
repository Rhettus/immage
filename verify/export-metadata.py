#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Headless check that an export keeps or leaves out each Metadata field as asked.

A TIFF carries every field the export dialog's Metadata section decides:
GPS, serial numbers and owner, camera and exposure, title, description,
creator and rights, keywords, and (after an edit) the edit history. Each of
the 64 combinations of the engine's export flags (`location`, `camera`,
`serials`, `description`, `tags`, `history`, as ExportDialog.tsx sends them)
is exported to JPEG and to JPEG XL, plus all-in and all-out to TIFF, and read
back with exiv2. A JPEG XL's metadata boxes are edited by engine/strip.cc
itself (exiv2 cannot write them), and the whole-sidecar XMP darktable embeds
must not leak history or location. Two JPEG XL exports also check that the
`quality` and `bpp` settings apply (jxlinfo, when installed). A field must be in the file exactly when its flags ask for it; the
capture date must always stay. darktable writes some fields itself and the
source's EXIF brings the rest (engine/strip.cc), so both paths are covered.
Needs the exiv2 command. No GUI is launched.

    python3 -I verify/export-metadata.py [--engine build/bin/darktable-engine]"""
import argparse
import itertools
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
background = __import__('background-priority')
ROOT = background.ROOT
FLAGS = ('location', 'camera', 'serials', 'description', 'tags', 'history')
KEYWORD = 'exportkeyword'

# what the fixture is given (exiv2 -M); XMP goes in the TIFF's own packet
FIXTURE = [
    'set Exif.Image.Make Sony',
    'set Exif.Image.Model ILCE-7M4',
    'set Exif.Photo.ExposureTime 1/250',
    'set Exif.Photo.FNumber 28/10',
    'set Exif.Photo.ISOSpeedRatings 400',
    'set Exif.Photo.FocalLength 35/1',
    'set Exif.Photo.LensModel FE 35mm F1.8',
    'set Exif.Photo.DateTimeOriginal 2026:05:04 10:11:12',
    'set Exif.Photo.BodySerialNumber 1234567',
    'set Exif.Photo.LensSerialNumber 7654321',
    'set Exif.Photo.CameraOwnerName Owner Person',
    'set Exif.GPSInfo.GPSVersionID 2 3 0 0',
    'set Exif.GPSInfo.GPSLatitudeRef N',
    'set Exif.GPSInfo.GPSLatitude 37/1 46/1 30/1',
    'set Exif.GPSInfo.GPSLongitudeRef W',
    'set Exif.GPSInfo.GPSLongitude 122/1 25/1 10/1',
    'set Exif.Image.ImageDescription exif description',
    'set Exif.Image.Artist Exif Artist',
    'set Exif.Image.Copyright exif copyright',
    # a Windows tag: UCS-2 bytes
    'set Exif.Image.XPKeywords ' + ' '.join(str(b) for b in 'exifkeyword\0'.encode('utf-16-le')),
    'set Xmp.dc.title lang="x-default" xmp title',
    'set Xmp.dc.description lang="x-default" xmp description',
    'set Xmp.dc.creator XMP Creator',
    'set Xmp.dc.rights lang="x-default" xmp rights',
    'set Xmp.dc.subject xmpkeyword',
]

# each field, the flags that must all be on for it to stay, and the keys
# (exiv2 -pa) that make it up, wherever darktable or the source put them
FIELDS = {
    'location': (('location',), r'GPS(Latitude|Longitude)'),
    # Camera and lens covers all of Exif.Photo but the dates: the serials go
    # with it (strip.cc, _camera_exif)
    'serials': (('serials', 'camera'), r'(?i)serial|ownername'),
    'camera': (('camera',), r'^Exif\.Image\.(Make|Model)$|^Exif\.Photo\.(ExposureTime|FNumber|ISOSpeedRatings'
                            r'|FocalLength|LensModel)$|^Xmp\.(tiff\.(Make|Model)|exif\.(ExposureTime|FNumber'
                            r'|FocalLength)|aux\.|exifEX\.)'),
    'description': (('description',), r'^Exif\.Image\.(ImageDescription|Artist|Copyright|XPTitle|XPComment'
                                      r'|XPAuthor)$|^Xmp\.dc\.(title|description|creator|rights)$|^Xmp\.xmpRights\.'),
    'keywords': (('tags',), r'^Exif\.Image\.XPKeywords$|^Xmp\.(dc\.subject|lr\.hierarchicalSubject)$'),
    'history': (('history',), r'^Xmp\.darktable\.history'),
}
# kept whatever is asked, so a whole-file wipe does not pass for a strip
ALWAYS = r'^Exif\.Photo\.DateTimeOriginal$'
# the values a kept field must still carry, by field: the source's and
# darktable's own (a description or keyword from the library, the export's
# own keyword) all reach the file
VALUES = {
    'location': ["37 deg 46'"],
    'serials': ['1234567', '7654321', 'Owner Person'],
    'camera': ['ILCE-7M4', 'FE 35mm F1.8'],
    'description': ['xmp title', 'xmp description', 'XMP Creator', 'xmp rights'],
    'keywords': ['xmpkeyword', KEYWORD],
}


def exiv2(*args):
    out = subprocess.run(['exiv2', *args], capture_output=True, text=True)
    return out


def listing(path):
    """{key: value text} of every tag exiv2 decodes, plus the raw text."""
    text = exiv2('-pa', '-q', str(path)).stdout
    keys = {}
    for line in text.splitlines():
        parts = line.split(None, 3)
        if parts:
            keys.setdefault(parts[0], []).append(parts[3] if len(parts) > 3 else '')
    return keys, text


def problems(keys, text, asked):
    found = []
    if not any(re.search(ALWAYS, k) for k in keys):
        found.append('the capture date is gone')
    for field, (needs, pattern) in FIELDS.items():
        want = all(asked[f] for f in needs)
        present = sorted(k for k in keys if re.search(pattern, k))
        if want and not present:
            found.append(f'{field} asked for but missing')
        elif not want and present:
            found.append(f'{field} left in: {", ".join(present)}')
        if want:
            missing = [v for v in VALUES.get(field, []) if v not in text]
            if missing:
                found.append(f'{field} lost {", ".join(missing)}')
    return found


EXT = {'jpeg': 'jpg', 'jxl': 'jxl', 'tiff': 'tif'}


def jxl_facts(path):
    """(bits per sample, lossless?) from jxlinfo, or None without it."""
    info = shutil.which('jxlinfo')
    if not info:
        return None
    text = subprocess.run([info, str(path)], capture_output=True, text=True).stdout
    bits = re.search(r'(\d+)-bit', text)
    return int(bits.group(1)) if bits else 0, 'lossless' in text.lower()


def quality_problems(engine, imgid, work):
    """quality and bpp reach the JPEG XL plugin, whose settings are named jxl."""
    sizes = {}
    found = []
    for name, quality, bpp in (('lossless', 100, 16), ('lossy', 50, 8)):
        out = work / 'export' / f'q-{name}.jxl'
        engine.call({'cmd': 'export', 'imgid': imgid, 'out': str(out), 'format': 'jxl',
                     'color_space': 'srgb', 'long_edge': 160, 'draft': True,
                     'quality': quality, 'bpp': bpp})
        sizes[name] = out.stat().st_size
        facts = jxl_facts(out)
        if facts is None:
            continue
        print(f'jxl quality {quality} bpp {bpp}: {facts[0]}-bit, lossless {facts[1]}')
        bits, lossless = facts
        if lossless != (quality == 100):
            found.append(f'jxl quality {quality}: lossless is {lossless}')
        if bits != bpp:
            found.append(f'jxl bpp {bpp}: file is {bits}-bit')
    # the synthetic photo is tiny and the metadata dominates, so sizes only
    # stand in when jxlinfo is missing
    if jxl_facts(work / 'export' / 'q-lossy.jxl') is None and sizes['lossless'] < 2 * sizes['lossy']:
        found.append(f'jxl quality 100 is {sizes["lossless"]} bytes, quality 50 {sizes["lossy"]}')
    print(f'jxl lossless {sizes["lossless"]} bytes, lossy {sizes["lossy"]} bytes')
    return found


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, default=ROOT / 'build/bin/darktable-engine')
    args = parser.parse_args()
    if not shutil.which('exiv2'):
        sys.exit('needs the exiv2 command (brew install exiv2, or the distribution package)')
    with tempfile.TemporaryDirectory(prefix='immage-export-meta-') as tmp:
        work = Path(tmp)
        photo = work / 'photo.tif'
        photo.write_bytes(background.tiff(320, 240))
        cmds = work / 'fixture.txt'
        cmds.write_text('\n'.join(FIXTURE) + '\n')
        done = exiv2('-m', str(cmds), str(photo))
        assert done.returncode == 0, f'exiv2 could not write the fixture: {done.stderr}'
        keys, text = listing(photo)
        missing = [c.split()[1] for c in FIXTURE if c.split()[1] not in keys]
        assert not missing, f'the fixture lacks {missing}'

        engine = background.Engine(args.engine, work)
        failures = []
        try:
            opened = engine.call({'cmd': 'open', 'path': str(photo)})
            imgid = opened['imgid']
            # an edit, so there is a history to embed or leave out
            engine.call({'cmd': 'set', 'op': 'exposure', 'params': {'exposure': 0.5}, 'enabled': True})
            engine.call({'cmd': 'save'})

            runs = [('jpeg', dict(zip(FLAGS, combo))) for combo in itertools.product((False, True), repeat=6)]
            runs += [('jxl', dict(zip(FLAGS, combo))) for combo in itertools.product((False, True), repeat=6)]
            runs += [('tiff', dict.fromkeys(FLAGS, v)) for v in (False, True)]
            for n, (fmt, asked) in enumerate(runs):
                out = work / 'export' / f'{n:02d}.{EXT[fmt]}'
                req = {'cmd': 'export', 'imgid': imgid, 'out': str(out), 'format': fmt,
                       'color_space': 'srgb', 'long_edge': 160, 'draft': True, 'keywords': [KEYWORD]} | asked
                if fmt in ('jpeg', 'jxl'):
                    req['quality'] = 90
                engine.call(req)
                found = problems(*listing(out), asked)
                if found:
                    on = [f for f in FLAGS if asked[f]] or ['nothing']
                    failures.append(f'{fmt} with {"+".join(on)}: {"; ".join(found)}')
            print(f'{len(runs)} exports checked')
            failures += quality_problems(engine, imgid, work)
        finally:
            engine.close()
        if failures:
            print('\n'.join(failures))
            sys.exit(f'{len(failures)} of {len(runs)} exports kept or lost the wrong fields')
        print('every field was kept or left out as asked')


if __name__ == '__main__':
    main()
