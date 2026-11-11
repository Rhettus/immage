#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

"""check_upstream_copies.py must find each copy's recorded revision in its header"""

import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("check_upstream_copies.py").resolve()
spec = importlib.util.spec_from_file_location("check_upstream_copies", SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class Headers(unittest.TestCase):
    def test_wrapped_comment(self):
        text = "// are copied here unchanged from src/iop/ashift.c at\n// 69498129cd (constants)\n"
        pattern = mod.COPIES[0][2]
        self.assertEqual(mod.recorded_revision(text, pattern), "69498129cd")

    def test_missing(self):
        self.assertIsNone(mod.recorded_revision("// nothing\n", mod.COPIES[0][2]))

    def test_every_real_header_names_a_revision(self):
        for path, _, pattern in mod.COPIES:
            text = (mod.ROOT / path).read_text(encoding="utf-8")
            self.assertTrue(mod.recorded_revision(text, pattern), path)


if __name__ == "__main__":
    unittest.main()
