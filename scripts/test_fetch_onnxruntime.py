#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

"""fetch_onnxruntime.py must lay NuGet's package out as darktable's build expects"""

import hashlib
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path

SCRIPT = Path(__file__).with_name("fetch_onnxruntime.py").resolve()
GITHUB = 'set(_ORT_URL "https://github.com/microsoft/onnxruntime/releases/download/v1/x")\n'


def pinned_version():
    for line in SCRIPT.read_text().splitlines():
        if line.startswith("VERSION = "):
            return line.split('"')[1]
    raise AssertionError("no VERSION in fetch_onnxruntime.py")


VERSION = pinned_version()


class FetchOnnxRuntime(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="immage-ort-test-")
        self.addCleanup(temp.cleanup)
        self.dir = Path(temp.name)
        self.build = self.dir / "build"
        self.module = self.dir / "FindONNXRuntime.cmake"
        self.module.write_text(f'set(ONNXRUNTIME_VERSION "{VERSION}" CACHE STRING "")\n{GITHUB}')
        self.nupkg = self.dir / "ort.nupkg"
        with zipfile.ZipFile(self.nupkg, "w") as z:
            z.writestr("LICENSE", "license")
            z.writestr("ThirdPartyNotices.txt", "notices")
            z.writestr("build/native/include/onnxruntime_c_api.h", "header")
            for runtime in ("linux-x64", "linux-arm64"):
                z.writestr(f"runtimes/{runtime}/native/libonnxruntime.so", runtime)
                z.writestr(f"runtimes/{runtime}/native/libonnxruntime_providers_shared.so", "shared")
            z.writestr("runtimes/osx-arm64/native/libonnxruntime.dylib", "osx")
        self.sha512 = hashlib.sha512(self.nupkg.read_bytes()).hexdigest()

    def run_script(self, system="Linux", machine="x86_64", sha512=None):
        return subprocess.run(
            [sys.executable, "-I", str(SCRIPT), "--build", str(self.build),
             "--module", str(self.module), "--url", self.nupkg.as_uri(),
             "--sha512", sha512 or self.sha512, "--system", system, "--machine", machine],
            capture_output=True, text=True)

    def test_linux_layout(self):
        r = self.run_script(machine="aarch64")
        self.assertEqual(r.returncode, 0, r.stderr)
        lib = self.build / "_deps/onnxruntime/lib"
        self.assertEqual((lib / f"libonnxruntime.so.{VERSION}").read_text(), "linux-arm64")
        self.assertEqual(os.readlink(lib / "libonnxruntime.so"), "libonnxruntime.so.1")
        self.assertEqual(os.readlink(lib / "libonnxruntime.so.1"), f"libonnxruntime.so.{VERSION}")
        self.assertTrue((lib / "libonnxruntime_providers_shared.so").is_file())
        self.assertTrue((self.build / "_deps/onnxruntime/include/onnxruntime_c_api.h").is_file())

    def test_macos_layout(self):
        r = self.run_script("Darwin", "arm64")
        self.assertEqual(r.returncode, 0, r.stderr)
        lib = self.build / "_deps/onnxruntime/lib"
        self.assertEqual((lib / f"libonnxruntime.{VERSION}.dylib").read_text(), "osx")
        self.assertEqual(os.readlink(lib / "libonnxruntime.dylib"), f"libonnxruntime.{VERSION}.dylib")

    def test_archive_carries_the_licenses_where_the_bundler_reads_them(self):
        self.assertEqual(self.run_script().returncode, 0)
        stem = f"onnxruntime-linux-x64-{VERSION}"
        with tarfile.open(self.build / f"_deps/{stem}.tgz") as t:
            names = t.getnames()
        self.assertIn(f"{stem}/LICENSE", names)
        self.assertIn(f"{stem}/ThirdPartyNotices.txt", names)

    def test_wrong_hash_installs_nothing(self):
        r = self.run_script(sha512="0" * 128)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("SHA-512", r.stderr)
        self.assertFalse((self.build / "_deps/onnxruntime").exists())

    def test_second_run_keeps_the_install(self):
        self.assertEqual(self.run_script().returncode, 0)
        self.nupkg.unlink()
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_other_version_stops_the_build(self):
        self.module.write_text(f'set(ONNXRUNTIME_VERSION "0.0.1" CACHE STRING "")\n{GITHUB}')
        r = self.run_script()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("0.0.1", r.stderr)

    def test_steps_aside_when_darktable_changes_source(self):
        self.module.write_text('set(ONNXRUNTIME_VERSION "0.0.1" CACHE STRING "")\n')
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse((self.build / "_deps").exists())

    def test_unsupported_platform_stops_the_build(self):
        r = self.run_script("Darwin", "x86_64")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("Darwin x86_64", r.stderr)


if __name__ == "__main__":
    unittest.main()
