#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Headless Upright regression; optionally retain synthetic corpus photos."""
import argparse
import json
import math
import os
from pathlib import Path
import selectors
import shutil
import struct
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def tiff(width, height, orientation):
    """Baseline RGB TIFF with a grid for line detection and EXIF orientation."""
    tags = [(256, 4, width), (257, 4, height), (258, 3, 0),
            (259, 3, 1), (262, 3, 2), (273, 4, 0), (274, 3, orientation),
            (277, 3, 3), (278, 4, height), (279, 4, width * height * 3), (284, 3, 1)]
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
    header += struct.pack('<IHHH', 0, 8, 8, 8)
    pixels = bytearray()
    for y in range(height):
        for x in range(width):
            pixels.extend((x * 255 // width, y * 255 // height,
                           220 if (x // 16 + y // 16) % 2 else 25))
    return header + pixels


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, default=ROOT / 'build/bin/darktable-engine')
    parser.add_argument('--write-corpus', type=Path,
                        help='also save generated photos here (tests always edit isolated copies)')
    args = parser.parse_args()
    cases = [('landscape', 1800, 1200, 1), ('portrait-native', 1200, 1800, 1),
             ('portrait-right', 1800, 1200, 6), ('portrait-left', 1800, 1200, 8),
             ('portrait-mirrored', 1800, 1200, 5)]
    with tempfile.TemporaryDirectory(prefix='immage-transform-') as tmp:
        work = Path(tmp)
        for name, width, height, orientation in cases:
            photo = work / (name + '.tif')
            photo.write_bytes(tiff(width, height, orientation))
            if args.write_corpus:
                args.write_corpus.mkdir(parents=True, exist_ok=True)
                destination = args.write_corpus / photo.name
                # Do not replace a preexisting corpus original.
                if destination.exists():
                    assert destination.read_bytes() == photo.read_bytes(), destination
                else:
                    shutil.copyfile(photo, destination)
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
                assert poll.select(60), f'engine timeout: {data}'
                reply = json.loads(child.stdout.readline())
                assert reply.get('ok'), f'{data}: {reply}'
                return reply

            try:
                count = 0
                for name, width, height, orientation in cases:
                    opened = request({'cmd': 'open', 'path': str(work / (name + '.tif'))})
                    assert (opened['height'] > opened['width']) == name.startswith('portrait'), opened
                    # Render first to populate caches at a different scale. Then
                    # repeat after geometry edits, as the Transform panel does.
                    for cropped in [False, True, False]:
                        request({'cmd': 'set', 'op': 'crop', 'enabled': cropped,
                                 'params': {'cx': .1, 'cy': .15, 'cw': .9, 'ch': .85}})
                        request({'cmd': 'render', 'width': 400, 'height': 300,
                                 'rgba': str(work / 'frame.rgba')})
                        for mode in ['auto', 'level', 'vertical', 'full']:
                            result = request({'cmd': 'upright', 'mode': mode, 'aspect': 1})
                            for key in ['rotation', 'lensshift_v', 'lensshift_h']:
                                assert math.isfinite(result[key]), result
                            if mode == 'level':
                                assert result['lensshift_v'] == result['lensshift_h'] == 0, result
                            # Apply the returned correction before the next fit,
                            # including its automatic crop and changed cache ROI.
                            request({'cmd': 'set', 'op': 'ashift', 'enabled': True,
                                     'params': {key: result[key] for key in
                                                ['rotation', 'lensshift_v', 'lensshift_h']}})
                            count += 1
                    print(f'{name}: full frame, crop and restored frame passed', flush=True)
                request({'cmd': 'quit'})
                child.wait(timeout=15)
                assert child.returncode == 0
                print(f'{count} Upright fits passed; no GUI launched')
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
