#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

"""pin_models.py must write the AI model table ai_cmds.rs checks downloads against"""

import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("pin_models.py").resolve()
AI_RS = SCRIPT.parents[1] / "app/src-tauri/src/ai_cmds.rs"
BEGIN = "// BEGIN scripts/pin_models.py"
END = "// END scripts/pin_models.py"
SHA_A = "a" * 64
SHA_B = "0123456789abcdef" * 4


class PinModels(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="immage-pin-test-")
        self.addCleanup(self.temp.cleanup)
        self.versions = Path(self.temp.name) / "versions.json"

    def run_script(self, models):
        self.versions.write_text(json.dumps({"models": models}))
        return subprocess.run(
            [sys.executable, "-I", str(SCRIPT), "--darktable", "5.7.0", "--tag", "t1",
             "--versions", str(self.versions)],
            capture_output=True, text=True)

    def test_table_from_saved_versions(self):
        r = self.run_script({
            "zeta": {"sha256": f"sha256:{SHA_B}", "size": 20},
            "alpha": {"sha256": f"sha256:{SHA_A}", "size": 10},
        })
        self.assertEqual(r.returncode, 0, r.stderr)
        lines = r.stdout.splitlines()
        self.assertEqual(lines[0], BEGIN)
        self.assertEqual(lines[-1], END)
        pins = [l.strip() for l in lines if "ModelPin" in l]
        self.assertEqual(pins, [
            f'ModelPin {{ id: "alpha", sha256: "{SHA_A}", size: 10 }},',
            f'ModelPin {{ id: "zeta", sha256: "{SHA_B}", size: 20 }},',
        ])
        self.assertIn('darktable: "5.7.0",', r.stdout)
        self.assertIn('tag: "t1",', r.stdout)

    def test_bad_sha_is_refused(self):
        r = self.run_script({"m": {"sha256": "sha256:xyz", "size": 1}})
        self.assertNotEqual(r.returncode, 0)

    def test_ai_rs_block_is_well_formed(self):
        src = AI_RS.read_text()
        block = src[src.index(BEGIN):src.index(END)]
        pins = re.findall(r'ModelPin \{ id: "([^"]+)", sha256: "([^"]+)", size: (\d+) \}', block)
        self.assertTrue(pins)
        self.assertEqual(block.count("ModelPin {"), len(pins))
        for mid, sha, _size in pins:
            self.assertRegex(sha, r"[0-9a-f]{64}", mid)


class Check(unittest.TestCase):
    MODELS = {
        "alpha": {"sha256": f"sha256:{SHA_A}", "size": 10},
        "zeta": {"sha256": f"sha256:{SHA_B}", "size": 20},
    }

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="immage-pin-test-")
        self.addCleanup(self.temp.cleanup)
        self.dir = Path(self.temp.name)
        # pin a copy of ai_cmds.rs to MODELS under tag t1, never the real file
        self.ai_rs = self.dir / "ai_cmds.rs"
        self.ai_rs.write_text(AI_RS.read_text())
        self.run_script(self.MODELS, "t1", "--write")

    def run_script(self, models, tag, mode):
        versions = self.dir / "versions.json"
        versions.write_text(json.dumps({"models": models}))
        return subprocess.run(
            [sys.executable, "-I", str(SCRIPT), mode, "--ai-rs", str(self.ai_rs),
             "--tag", tag, "--versions", str(versions)],
            capture_output=True, text=True)

    def check(self, models, tag="t1"):
        return self.run_script(models, tag, "--check")

    def test_match(self):
        r = self.check(self.MODELS)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("model pins match t1", r.stdout)

    def test_changed_sha(self):
        models = {**self.MODELS, "zeta": {"sha256": f"sha256:{SHA_A}", "size": 20}}
        r = self.check(models)
        self.assertEqual(r.returncode, 1)
        self.assertIn("zeta", r.stdout)
        self.assertNotIn("alpha", r.stdout)
        self.assertIn("pin_models.py --write", r.stdout)

    def test_added_and_removed(self):
        models = {"alpha": self.MODELS["alpha"], "newbie": {"sha256": f"sha256:{SHA_A}", "size": 1}}
        r = self.check(models)
        self.assertEqual(r.returncode, 1)
        self.assertIn("added: newbie", r.stdout)
        self.assertIn("removed: zeta", r.stdout)

    def test_changed_tag(self):
        r = self.check(self.MODELS, "t2")
        self.assertEqual(r.returncode, 1)
        self.assertIn("t1 -> t2", r.stdout)


if __name__ == "__main__":
    unittest.main()
