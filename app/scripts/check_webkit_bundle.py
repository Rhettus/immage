#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

"""Check the experimental AppDir carries the requested WebKitGTK and helpers."""
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys

if sys.argv[1] == "--probe":
    root = Path(sys.argv[2])
    versions = {}
    for name, pattern, prefix in (
        ("WebKitGTK", "libwebkit2gtk-4.1.so.0", "webkit"),
        ("JavaScriptCore", "libjavascriptcoregtk-4.1.so.0", "jsc"),
    ):
        paths = list((root / "usr/lib").rglob(pattern))
        if not paths:
            raise SystemExit(f"missing bundled {name}")
        lib = ctypes.CDLL(str(paths[0]))
        versions[name] = ".".join(str(getattr(lib, f"{prefix}_get_{part}_version")())
                                  for part in ("major", "minor", "micro"))
    print(json.dumps(versions))
else:
    root, expected = Path(sys.argv[1]).resolve(), sys.argv[2]
    for helper in ("WebKitWebProcess", "WebKitNetworkProcess", "libwebkit2gtkinjectedbundle.so"):
        if not list((root / "usr").rglob(helper)):
            raise SystemExit(f"missing bundled helper: {helper}")
    env = os.environ.copy()
    # select the bundled dependencies before the interpreter loads anything
    libdirs = [root / "usr/lib"] + list((root / "usr/lib").glob("*-linux-gnu"))
    env["LD_LIBRARY_PATH"] = ":".join(map(str, libdirs))
    result = subprocess.run([sys.executable, "-I", __file__, "--probe", str(root)],
                            env=env, text=True, capture_output=True, check=True)
    versions = json.loads(result.stdout)
    if any(version != expected for version in versions.values()):
        raise SystemExit(f"expected {expected}; packaged {versions}")
    print(json.dumps(versions))
