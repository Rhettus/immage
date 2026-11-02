#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Check launcher wiring without starting the packaged application."""
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1])
expected = Path(__file__).with_name('appimage-launcher.sh').read_bytes()
if (root / 'AppRun').read_bytes() != expected:
    raise SystemExit('packaged AppRun is not the runtime selector')
for path in ('AppRun.bundled', 'usr/bin/immage', 'usr/bin/immage-system',
             'usr/lib/Immage/webext/libimmage-frames.so'):
    if not (root / path).is_file():
        raise SystemExit(f'missing launcher component: {path}')
for path in ('usr/bin/immage-system', 'usr/lib/Immage/webext/libimmage-frames.so'):
    rpath = subprocess.check_output(['patchelf', '--print-rpath', str(root / path)], text=True).strip()
    if rpath:
        raise SystemExit(f'system runtime still has a private library path: {path}: {rpath}')
print('AppImage runtime selector and system ELF paths verified')
