#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

"""Put ONNX Runtime into build/_deps before darktable is configured.

darktable's FindONNXRuntime.cmake downloads the Linux and macOS archives from
github.com/microsoft/onnxruntime, which has answered 404 since November 2026.
Microsoft's NuGet package carries the same libraries, so this unpacks it where
that module looks first, in the layout of the GitHub archive. Windows is left
out: darktable already takes its DirectML package from NuGet.

This stands in until darktable settles on its own source. It steps aside once
darktable's module no longer downloads from that repository; delete it then,
with its call in scripts/build.sh and its test.
"""

import argparse
import hashlib
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "darktable/cmake/modules/FindONNXRuntime.cmake"
GITHUB_DOWNLOAD = "github.com/microsoft/onnxruntime/releases/download"

VERSION = "1.24.4"
NUPKG_URL = ("https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/"
             f"{VERSION}/microsoft.ml.onnxruntime.{VERSION}.nupkg")
# packageHash in NuGet's catalog entry for this version
NUPKG_SHA512 = ("f5dd415dfcafcb3a7461f10a08f0337ea22c1ba8f8af81316daabf7496075add"
                "181aecb0de3cabebebdb9f5da3afbe507480aaf34b76e1189409088ccc5c2eac")

# (system, machine): (NuGet runtime folder, the GitHub archive's platform name)
PLATFORMS = {
    ("Linux", "x86_64"): ("linux-x64", "linux-x64"),
    ("Linux", "aarch64"): ("linux-arm64", "linux-aarch64"),
    ("Darwin", "arm64"): ("osx-arm64", "osx-arm64"),
}


def sha512(path):
    digest = hashlib.sha512()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url, dest, expected):
    if dest.exists() and sha512(dest) == expected:
        return
    partial = dest.with_suffix(".part")
    subprocess.run(["curl", "-fsSL", "--retry", "3", "-o", str(partial), url], check=True)
    actual = sha512(partial)
    if actual != expected:
        partial.unlink()
        sys.exit(f"ONNX Runtime package from {url} has SHA-512 {actual}, expected {expected}")
    os.replace(partial, dest)


def write(path, data, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    path.chmod(mode)


def unpack(nupkg, top, runtime, version):
    """Lay the package out as the GitHub archive does, for the libraries'
    own names: the Linux soname is libonnxruntime.so.1, and darktable installs
    macOS's libonnxruntime.<version>.dylib by that pattern"""
    lib = top / "lib"
    native = f"runtimes/{runtime}/native/"
    with zipfile.ZipFile(nupkg) as z:
        names = z.namelist()
        for name in ("LICENSE", "ThirdPartyNotices.txt"):
            write(top / name, z.read(name))
        for name in names:
            if name.startswith("build/native/include/") and not name.endswith("/"):
                write(top / "include" / os.path.basename(name), z.read(name))
        if runtime.startswith("osx"):
            write(lib / f"libonnxruntime.{version}.dylib", z.read(native + "libonnxruntime.dylib"), 0o755)
            (lib / "libonnxruntime.dylib").symlink_to(f"libonnxruntime.{version}.dylib")
        else:
            write(lib / f"libonnxruntime.so.{version}", z.read(native + "libonnxruntime.so"), 0o755)
            (lib / "libonnxruntime.so.1").symlink_to(f"libonnxruntime.so.{version}")
            (lib / "libonnxruntime.so").symlink_to("libonnxruntime.so.1")
            shared = "libonnxruntime_providers_shared.so"
            write(lib / shared, z.read(native + shared), 0o755)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--build", type=Path, default=ROOT / "build")
    parser.add_argument("--module", type=Path, default=MODULE)
    parser.add_argument("--url", default=NUPKG_URL)
    parser.add_argument("--sha512", default=NUPKG_SHA512)
    parser.add_argument("--system", default=platform.system())
    parser.add_argument("--machine", default=platform.machine())
    args = parser.parse_args()

    module = args.module.read_text()
    if GITHUB_DOWNLOAD not in module:
        print("ONNX Runtime: darktable no longer downloads it from GitHub, leaving it to darktable")
        return
    wanted = re.search(r'set\(ONNXRUNTIME_VERSION "([^"]+)"', module)
    if not wanted or wanted.group(1) != VERSION:
        found = wanted.group(1) if wanted else "an unknown version"
        sys.exit(f"darktable wants ONNX Runtime {found}, but scripts/fetch_onnxruntime.py "
                 f"pins {VERSION}: update VERSION and NUPKG_SHA512 there")

    target = PLATFORMS.get((args.system, args.machine))
    if not target:
        sys.exit(f"no ONNX Runtime in the NuGet package for {args.system} {args.machine}")
    runtime, name = target

    deps = args.build / "_deps"
    stem = f"onnxruntime-{name}-{VERSION}"
    # the archive is written last and bundle_engine.py reads the licenses from it
    archive = deps / f"{stem}.tgz"
    installed = deps / "onnxruntime"
    if archive.exists() and (installed / "include/onnxruntime_c_api.h").exists():
        return

    deps.mkdir(parents=True, exist_ok=True)
    nupkg = deps / f"microsoft.ml.onnxruntime.{VERSION}.nupkg"
    print(f"ONNX Runtime: fetching {VERSION} for {runtime} from NuGet")
    download(args.url, nupkg, args.sha512)

    work = deps / "onnxruntime-nuget"
    shutil.rmtree(work, ignore_errors=True)
    unpack(nupkg, work / stem, runtime, VERSION)
    partial = deps / f"{stem}.tgz.part"
    with tarfile.open(partial, "w:gz") as t:
        t.add(work / stem, arcname=stem)
    shutil.rmtree(installed, ignore_errors=True)
    os.replace(work / stem, installed)
    os.replace(partial, archive)
    shutil.rmtree(work)
    nupkg.unlink()


if __name__ == "__main__":
    main()
