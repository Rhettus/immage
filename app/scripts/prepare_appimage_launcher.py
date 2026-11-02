#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Install runtime selection in an already bundled AppDir, before repacking."""
from pathlib import Path
import argparse
import shutil
import subprocess


def prepare(root):
    root = Path(root)
    launcher = root / 'AppRun'
    original = root / 'AppRun.bundled'
    # Idempotent for local repackaging; never wrap our launcher recursively.
    if not original.exists():
        launcher.rename(original)
    binary = root / 'usr/bin/immage-system'
    shutil.copy2(root / 'usr/bin/immage', binary)
    subprocess.run(['patchelf', '--remove-rpath', str(binary)], check=True)
    extensions = list((root / 'usr').rglob('webext/libimmage-frames.so'))
    if len(extensions) != 1:
        raise SystemExit(f'expected one packaged frames extension, found {len(extensions)}')
    # WebKit/JSC are already loaded in the web process in either mode. The
    # extension needs no private search path; system mode must not reach the
    # packaged UI libraries through one. Keep the resource path the app knows.
    extension = extensions[0]
    subprocess.run(['patchelf', '--remove-rpath', str(extension)], check=True)
    shutil.copy2(Path(__file__).with_name('appimage-launcher.sh'), launcher)
    launcher.chmod(0o755)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('appdir', type=Path)
    prepare(parser.parse_args().appdir)
