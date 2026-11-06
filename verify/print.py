#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Headless Print panel check: printer profiles, soft proof, gamut warning, PDF.

Runs the engine on a synthetic photo with a made-up narrow-gamut printer
profile. It does not print: CUPS and Windows spooling need a real printer
and are checked by hand (app/docs/dev/print.md).
"""
import argparse
import json
import os
from pathlib import Path
import selectors
import struct
import subprocess
import sys
import re
import tempfile
import zlib

ROOT = Path(__file__).resolve().parent.parent
D50 = (0.9642, 1.0, 0.8249)
# sRGB's colorants adapted to D50, as an ICC matrix profile holds them
SRGB = ((0.4361, 0.2225, 0.0139), (0.3851, 0.7169, 0.0971), (0.1431, 0.0606, 0.7141))


def s15(v):
    return struct.pack('>i', round(v * 65536))


def icc(name, cls=b'prtr', space=b'RGB ', squeeze=0.5):
    """A v2 matrix/TRC profile whose colorants are sRGB's pulled toward white."""
    def xyz(v):
        return b'XYZ ' + b'\0' * 4 + b''.join(s15(c) for c in v)
    cols = [tuple(squeeze * c + (1 - squeeze) * w / 3 for c, w in zip(col, D50)) for col in SRGB]
    text = name.encode() + b'\0'
    desc = b'desc' + b'\0' * 4 + struct.pack('>I', len(text)) + text + b'\0' * (4 + 4 + 2 + 1 + 67)
    curve = b'curv' + b'\0' * 4 + struct.pack('>IH', 1, 0x0233) + b'\0\0'
    cprt = b'text' + b'\0' * 4 + b'no copyright\0'
    tags = [(b'desc', desc), (b'cprt', cprt), (b'wtpt', xyz(D50)),
            (b'rXYZ', xyz(cols[0])), (b'gXYZ', xyz(cols[1])), (b'bXYZ', xyz(cols[2])),
            (b'rTRC', curve), (b'gTRC', curve), (b'bTRC', curve)]
    offset = 128 + 4 + 12 * len(tags)
    table, data = b'', b''
    for sig, body in tags:
        body += b'\0' * (-len(body) % 4)
        table += sig + struct.pack('>II', offset + len(data), len(body))
        data += body
    size = offset + len(data)
    header = (struct.pack('>I', size) + b'\0' * 4 + struct.pack('>I', 0x02100000) + cls + space + b'XYZ '
              + b'\0' * 12 + b'acsp' + b'\0' * 24 + struct.pack('>I', 0) + b''.join(s15(c) for c in D50)
              + b'\0' * 48)
    assert len(header) == 128
    return header + struct.pack('>I', len(tags)) + table + data


def tiff(width, height):
    """Saturated red, green and blue bands over a gray one."""
    tags = [(256, 4, width), (257, 4, height), (258, 3, 0), (259, 3, 1), (262, 3, 2), (273, 4, 0),
            (277, 3, 3), (278, 4, height), (279, 4, width * height * 3), (284, 3, 1)]
    extra = 8 + 2 + 12 * len(tags) + 4
    header = b'II' + struct.pack('<HIH', 42, 8, len(tags))
    for tag, kind, value in tags:
        if tag == 258:
            value = extra
        elif tag == 273:
            value = extra + 6
        payload = struct.pack('<I', value) if kind == 4 or tag == 258 else struct.pack('<H', value) + b'\0\0'
        header += struct.pack('<HHI', tag, kind, 3 if tag == 258 else 1) + payload
    header += struct.pack('<IHHH', 0, 8, 8, 8)
    bands = [(250, 10, 10), (10, 240, 10), (10, 10, 250), (128, 128, 128)]
    row = lambda y: bytes(bands[min(3, y * 4 // height)]) * width
    return header + b''.join(row(y) for y in range(height))


def ppm(path):
    data = path.read_bytes()
    parts = data.split(maxsplit=4)
    assert parts[0] == b'P6', parts[0]
    w, h = int(parts[1]), int(parts[2])
    return w, h, parts[4][-w * h * 3:]


def band(frame, k):
    """The mean color of band k's middle row."""
    w, h, px = frame
    y = (2 * k + 1) * h // 8
    row = px[y * w * 3:(y + 1) * w * 3]
    return tuple(sum(row[c::3]) / w for c in range(3))


def chroma(rgb):
    return max(rgb) - min(rgb)


def pdf_images(data):
    """The PDF's images, in order, as (width, height, raw bytes); flate streams only."""
    found = []
    for m in re.finditer(rb'/Subtype /Image', data):
        w = int(re.search(rb'/Width (\d+)', data[m.start():]).group(1))
        h = int(re.search(rb'/Height (\d+)', data[m.start():]).group(1))
        start = data.index(b'stream\n', m.start()) + len(b'stream\n')
        found.append((w, h, zlib.decompressobj().decompress(data[start:])))
    return found


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, default=ROOT / 'build/bin/darktable-engine')
    parser.add_argument('--keep', type=Path, help='copy the written PDFs into this folder')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='immage-print-') as tmp:
        work = Path(tmp)
        (work / 'photo.tif').write_bytes(tiff(480, 320))
        (work / 'narrow.icc').write_bytes(icc('Immage test narrow printer'))
        (work / 'cmyk.icc').write_bytes(icc('Immage test cmyk', space=b'CMYK'))
        with (work / 'engine.log').open('w') as log:
            child = subprocess.Popen(
                [str(args.engine.resolve()), '--core', '--configdir', str(work / 'config'),
                 '--cachedir', str(work / 'cache'), '--conf', 'opencl=false',
                 '--conf', 'resourcelevel=0'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=log, text=True, env=os.environ | {'OMP_NUM_THREADS': '2',
                'OMP_WAIT_POLICY': 'passive', 'XDG_DATA_HOME': str(work / 'data')})
            poll = selectors.DefaultSelector()
            poll.register(child.stdout, selectors.EVENT_READ)

            def send(data):
                child.stdin.write(json.dumps(data) + '\n')
                child.stdin.flush()
                assert poll.select(120), f'engine timeout: {data}'
                return json.loads(child.stdout.readline())

            def request(data):
                reply = send(data)
                assert reply.get('ok'), f'{data}: {reply}'
                return reply

            def refused(data, words):
                reply = send(data)
                assert not reply.get('ok') and words in reply.get('error', ''), f'{data}: {reply}'

            hashes = []

            def render():
                # with the frames already had, as the app sends them: a proofed
                # frame must not be taken for one of them
                reply = request({'cmd': 'render', 'width': 240, 'height': 160, 'out': str(work / 'frame.ppm'),
                                 'have': hashes[-1:]})
                assert 'kept' not in reply, reply
                hashes.append(reply['hash'])
                return ppm(work / 'frame.ppm')

            try:
                refused({'cmd': 'print_profile_add', 'path': str(work / 'cmyk.icc')}, 'RGB')
                added = request({'cmd': 'print_profile_add', 'path': str(work / 'narrow.icc')})
                assert added['name'] == 'Immage test narrow printer', added
                profile = added['file']
                assert Path(profile).parent == work / 'config' / 'color' / 'out', profile
                again = request({'cmd': 'print_profile_add', 'path': str(work / 'narrow.icc')})
                assert again['file'] == profile, again
                listed = request({'cmd': 'print_profiles'})['profiles']
                assert [p['file'] for p in listed].count(profile) == 1, listed
                print('printer profiles: added once, listed, CMYK refused', flush=True)

                request({'cmd': 'open', 'path': str(work / 'photo.tif')})
                normal = render()
                proofed = request({'cmd': 'softproof', 'mode': 'proof', 'profile': profile, 'intent': 1})
                assert proofed['changed'], proofed
                assert not request({'cmd': 'softproof', 'mode': 'proof', 'profile': profile,
                                    'intent': 1})['changed']
                proof = render()
                for k in range(3):
                    assert chroma(band(proof, k)) < chroma(band(normal, k)) - 20, (k, band(normal, k), band(proof, k))
                gray_n, gray_p = band(normal, 3), band(proof, 3)
                assert max(abs(a - b) for a, b in zip(gray_n, gray_p)) < 6, (gray_n, gray_p)
                print('soft proof: saturated bands pulled in, gray kept', flush=True)

                request({'cmd': 'softproof', 'mode': 'gamut', 'profile': profile, 'intent': 1})
                gamut = render()
                for k in range(3):
                    r, g, b = band(gamut, k)
                    assert r < 30 and g > 220 and b > 220, (k, band(gamut, k))
                assert chroma(band(gamut, 3)) < 10, band(gamut, 3)
                print('gamut warning: out of gamut bands cyan, gray not', flush=True)

                request({'cmd': 'softproof', 'mode': 'off'})
                back = render()
                for k in range(4):
                    assert max(abs(a - b) for a, b in zip(band(back, k), band(normal, k))) < 1.5, k
                refused({'cmd': 'softproof', 'mode': 'proof', 'profile': str(work / 'missing.icc')}, "can't be used")
                assert hashes[-1] == hashes[0] and len(set(hashes)) == 3, hashes
                print('soft proof off: the frame as before, with its hash', flush=True)

                imgid = request({'cmd': 'open', 'path': str(work / 'photo.tif')})['imgid']
                page = {'width': 210, 'height': 297}
                # 190 mm at 150 dpi is 1122 pixels; the photo is 3:2, so the width binds
                for name, prof in [('managed', profile), ('driver', '')]:
                    pdf = work / f'{name}.pdf'
                    done = request({'cmd': 'print', 'imgid': imgid, 'pdf': str(pdf), 'page': page,
                                    'area': {'x': 10, 'y': 10, 'width': 190, 'height': 277}, 'dpi': 150,
                                    'profile': prof, 'intent': 0, 'bpc': True, 'title': 'photo'})
                    assert done['dpi'] == 150 and abs(done['width'] - 1122) <= 2, done
                    assert abs(done['height'] - done['width'] * 2 / 3) <= 2, done
                    data = pdf.read_bytes()
                    assert data.startswith(b'%PDF') and b'%%EOF' in data[-32:], name
                    assert b'/ICCBased' in data, name
                    assert f'/BitsPerComponent {16 if prof else 8}'.encode() in data, name
                    assert b'/MediaBox [0 0 595 842]' in data, name
                    if args.keep:
                        args.keep.mkdir(parents=True, exist_ok=True)
                        (args.keep / pdf.name).write_bytes(data)
                print('PDF: page, size at the resolution, bit depth and profile', flush=True)

                # the Cells layout: boxes and labels per page, composed in the engine
                dpi = 100
                px = lambda mm: round(mm / 25.4 * dpi)
                cell = lambda x, name: {'imgid': imgid, 'valign': 'bottom', 'box': {'x': x, 'y': 20, 'width': 80, 'height': 60},
                                        'label': {'x': x, 'y': 80, 'width': 80, 'height': 4, 'text': name}}
                sheet = {'cmd': 'print', 'page': page, 'dpi': dpi, 'profile': '', 'title': 'sheet',
                         'label_points': 7, 'pages': [[cell(20, 'IMG_0001.CR3'), cell(110, 'IMG_0002_a_rather_long_name.CR3')]]}
                done = request(sheet | {'pdf': str(work / 'sheet.pdf')})
                assert done['pages'] == 1 and done['photos'] == 2 and done['dpi'] == dpi, done
                data = (work / 'sheet.pdf').read_bytes()
                assert data.startswith(b'%PDF') and b'/MediaBox [0 0 595 842]' in data, 'sheet PDF'
                [(w, h, raw)] = pdf_images(data)
                assert (w, h) == (px(210), px(297)) and len(raw) == w * h * 3, (w, h, len(raw))
                at = lambda x, y: tuple(raw[(px(y) * w + px(x)) * 3:(px(y) * w + px(x)) * 3 + 3])
                white = lambda x, y: min(at(x, y)) >= 250
                # the page is white where nothing is put, the gutter between the cells included
                assert white(5, 5) and white(105, 50) and white(60, 95) and white(150, 200), 'white page'
                # a 3:2 photo in a 4:3 box fills its width and sits at the bottom, with its name: the red band tops it
                r, g, b = at(60, 30)
                assert r > 200 and g < 80 and b < 80, at(60, 30)
                r, g, b = at(150, 30)
                assert r > 200 and g < 80 and b < 80, at(150, 30)
                # above the photo, inside the box, stays white (the photo is 53 mm high in 60, at the bottom)
                assert white(60, 21), 'letterbox'
                # a named photo sits at the bottom of its box, its name right under it: the box's
                # top 6 mm are white and the photo reaches the strip
                assert white(60, 25) and not white(60, 79) and not white(150, 79), 'bottom aligned'
                # the label strips hold dark pixels, the long name's no wider than its cell
                dark = lambda x0, x1: sum(1 for yy in range(px(80), px(84)) for xx in range(px(x0), px(x1))
                                          if max(raw[(yy * w + xx) * 3:(yy * w + xx) * 3 + 3]) < 100)
                assert dark(20, 100) > 40 and dark(110, 190) > 40, (dark(20, 100), dark(110, 190))
                assert dark(100, 110) == 0 and dark(190, 205) == 0, 'the text stays in its cell'
                # a managed sheet: 16 bits, tagged, converted once for the page
                done = request(sheet | {'pdf': str(work / 'sheet-managed.pdf'), 'profile': profile})
                data = (work / 'sheet-managed.pdf').read_bytes()
                assert b'/ICCBased' in data and b'/BitsPerComponent 16' in data, 'managed sheet'
                # two pages: a PDF page each
                done = request(sheet | {'pdf': str(work / 'sheet2.pdf'), 'pages': sheet['pages'] * 2})
                assert done['pages'] == 2 and done['photos'] == 4, done
                data = (work / 'sheet2.pdf').read_bytes()
                assert len(re.findall(rb'/Type /Page\b(?!s)', data)) == 2 and len(pdf_images(data)) == 2, 'two pages'
                refused(sheet | {'pdf': str(work / 'x.pdf'), 'pages': []}, 'nothing to print')
                refused(sheet | {'pdf': None, 'printer': None}, 'needs a printer')
                refused(sheet | {'pdf': str(work / 'x.pdf'), 'page': {'width': 0, 'height': 297}}, 'no size')
                print('Cells sheet: boxes, gutters, labels in their strips, 16 bits when managed, a page each', flush=True)

                refused({'cmd': 'print', 'imgid': imgid, 'pdf': str(work / 'x.pdf'), 'page': page,
                         'area': {'x': 100, 'y': 10, 'width': 190, 'height': 277}}, 'does not fit')
                refused({'cmd': 'print', 'imgid': imgid, 'page': page,
                         'area': {'x': 10, 'y': 10, 'width': 190, 'height': 277}}, 'needs a printer')
                printers = request({'cmd': 'printers'})
                assert printers['available'] is True and isinstance(printers['printers'], list), printers
                refused({'cmd': 'printer', 'name': 'immage-no-such-printer'}, 'no printer')
                refused({'cmd': 'print', 'imgid': imgid, 'printer': 'immage-no-such-printer', 'page': page,
                         'area': {'x': 10, 'y': 10, 'width': 190, 'height': 277}}, 'no printer')
                print(f'printers: {len(printers["printers"])} listed, unknown ones refused', flush=True)

                request({'cmd': 'quit'})
                child.wait(timeout=15)
                assert child.returncode == 0
                print('print checks passed; nothing printed, no GUI launched')
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
