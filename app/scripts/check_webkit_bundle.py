#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

"""Check bundled WebKit versions, helpers and the AppDir's glibc baseline."""
import argparse
import ctypes
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def probe(root):
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
    return versions


def glibc_requirements(symbols):
    # Only imports count. Exported version definitions in a bundled library
    # do not establish the minimum glibc needed by that library.
    return {tuple(map(int, version.split(".")))
            for line in symbols.splitlines() if " UND " in line
            for version in re.findall(r"@GLIBC_([0-9]+(?:\.[0-9]+)+)", line)}


def check_glibc(root, maximum):
    limit = tuple(map(int, maximum.split(".")))
    seen, failures = set(), []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.resolve() in seen:
            continue
        seen.add(path.resolve())
        with path.open("rb") as stream:
            if stream.read(4) != b"\x7fELF":
                continue
        result = subprocess.run(["readelf", "--dyn-syms", "--wide", str(path)],
                                text=True, capture_output=True, check=True)
        newer = sorted(v for v in glibc_requirements(result.stdout) if v > limit)
        if newer:
            versions = ", ".join("GLIBC_" + ".".join(map(str, v)) for v in newer)
            failures.append(f"{path.relative_to(root)} requires {versions}")
    if failures:
        raise SystemExit(f"AppDir exceeds glibc {maximum} baseline:\n" + "\n".join(failures))


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--probe":
        print(json.dumps(probe(Path(sys.argv[2]))))
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("appdir", type=Path)
    parser.add_argument("expected")
    parser.add_argument("--max-glibc", help="reject ELF imports newer than this version")
    args = parser.parse_args()
    root = args.appdir.resolve()
    for helper in ("WebKitWebProcess", "WebKitNetworkProcess", "libwebkit2gtkinjectedbundle.so"):
        if not list((root / "usr").rglob(helper)):
            raise SystemExit(f"missing bundled helper: {helper}")
    if args.max_glibc:
        check_glibc(root, args.max_glibc)
    env = os.environ.copy()
    # Select bundled dependencies before the interpreter loads anything.
    libdirs = [root / "usr/lib"] + list((root / "usr/lib").glob("*-linux-gnu"))
    env["LD_LIBRARY_PATH"] = ":".join(map(str, libdirs))
    result = subprocess.run([sys.executable, "-I", __file__, "--probe", str(root)],
                            env=env, text=True, capture_output=True)
    if result.returncode:
        raise SystemExit(result.stderr.strip() or "bundled WebKit version probe failed")
    versions = json.loads(result.stdout)
    if any(version != args.expected for version in versions.values()):
        raise SystemExit(f"expected {args.expected}; packaged {versions}")
    print(json.dumps(versions))


if __name__ == "__main__":
    main()
