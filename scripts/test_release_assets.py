#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

"""release downloads and updater feeds must keep Linux architectures separate"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("release_assets.py").resolve()
VERSION = "0.40.0"


class ReleaseAssets(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="immage-release-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.artifacts = self.root / "artifacts"
        self.out = self.root / "release" / "assets"
        self.files = {}
        for platform, name, signed in [
            ("macos", f"Immage_{VERSION}_aarch64.dmg", False),
            ("macos-update", "Immage.app.tar.gz", True),
            ("nsis", f"Immage_{VERSION}_x64-setup.exe", True),
            ("msi", f"Immage_{VERSION}_x64.msi", True),
            ("x64", f"Immage_{VERSION}_amd64.AppImage", True),
            ("arm64", f"Immage_{VERSION}_aarch64.AppImage", True),
            ("source", f"immage-{VERSION}-source.tar.gz", False),
        ]:
            path = self.artifacts / platform / name
            path.parent.mkdir(parents=True)
            path.write_text(platform)
            if signed:
                path.with_name(name + ".sig").write_text("signature-" + platform)
            self.files[platform] = path
        (self.root / "RELEASE_NOTES.md").write_text(f"## {VERSION}\n\nTest release.\n")

    def assemble(self):
        return subprocess.run(
            [sys.executable, "-I", str(SCRIPT), str(self.artifacts), VERSION, str(self.out)],
            cwd=self.root, capture_output=True, text=True,
        )

    def test_both_linux_downloads_and_updaters(self):
        result = self.assemble()
        self.assertEqual(result.returncode, 0, result.stderr)
        platforms = json.loads((self.out / "latest.json").read_text())["platforms"]
        body = (self.out.parent / "body.md").read_text()
        for arch, filename, signature in [
            ("x86_64", f"Immage-{VERSION}-Linux-x86_64.AppImage", "signature-x64"),
            ("aarch64", f"Immage-{VERSION}-Linux-arm64.AppImage", "signature-arm64"),
        ]:
            entry = platforms[f"linux-{arch}"]
            self.assertEqual(entry, platforms[f"linux-{arch}-appimage"])
            self.assertEqual(entry["signature"], signature)
            self.assertTrue(entry["url"].endswith("/" + filename))
            self.assertIn(filename, body)
            self.assertEqual((self.out / filename).read_text(), "x64" if arch == "x86_64" else "arm64")
        self.assertIn("darwin-aarch64", platforms)
        self.assertIn("windows-x86_64-msi", platforms)
        self.assertFalse(list(self.out.glob("*.sig")))

    def test_missing_arm64_bundle_fails(self):
        self.files["arm64"].unlink()
        result = self.assemble()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("expected one *_aarch64.AppImage", result.stderr)

    def test_missing_arm64_signature_fails(self):
        path = self.files["arm64"]
        path.with_name(path.name + ".sig").unlink()
        result = self.assemble()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no signature for " + path.name, result.stderr)

    def test_duplicate_architecture_fails(self):
        duplicate = self.artifacts / "duplicate" / self.files["x64"].name
        duplicate.parent.mkdir()
        duplicate.write_text("duplicate")
        result = self.assemble()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("expected one *_amd64.AppImage", result.stderr)

    def test_wrong_arm64_version_fails(self):
        path = self.files["arm64"]
        path.rename(path.with_name("Immage_0.39.0_aarch64.AppImage"))
        result = self.assemble()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("is not version " + VERSION, result.stderr)


if __name__ == "__main__":
    unittest.main()
