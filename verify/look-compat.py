#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors
"""Run the real-engine look-mask checks with disposable photos and app state."""
import argparse
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import zlib

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--build', type=Path, required=True,
                    help='candidate build containing bin/immage-look-check and IOP modules')
args = parser.parse_args()
build = args.build.resolve()

def chunk(kind, data):
    return (struct.pack('>I', len(data)) + kind + data
            + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff))

with tempfile.TemporaryDirectory(prefix='immage-look-compat-') as tmp:
    state = Path(tmp)
    w, h = 128, 96
    rows = b''.join(b'\0' + bytes(v for x in range(w)
                                  for v in (30 + x, 30 + y, 30 + (x + y) // 2))
                    for y in range(h))
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))
    for name in ('source.png', 'target.png', 'multi.png'):
        (state / name).write_bytes(png)
    command = [str(build / 'bin/immage-look-check'), str(state / 'source.png'),
               str(state / 'target.png'), str(state), '--library', ':memory:',
               '--configdir', str(state / 'config'), '--cachedir', str(state / 'cache'),
               '--datadir', str(build / 'share/darktable'),
               '--moduledir', str(build / 'lib/darktable'),
               '--conf', 'opencl=false', '--conf', 'resourcelevel=0']
    for reload_sidecar in (None, "--reload", "--reload-multi"):
        run = command.copy()
        if reload_sidecar:
            run[1] = reload_sidecar
            if reload_sidecar == '--reload-multi':
                run[2] = str(state / 'multi.png')
        result = subprocess.run(run, capture_output=True, text=True, timeout=180,
                                env=os.environ | {'OMP_NUM_THREADS': '2',
                                                  'OMP_WAIT_POLICY': 'passive',
                                                  'XDG_DATA_HOME': str(state / 'data')})
        print(result.stdout, end='')
        if result.returncode:
            print(result.stderr, end='')
            raise SystemExit(result.returncode)
