#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

"""Packaging regressions: python3 -I scripts/test_webkit_bundle.py."""
import importlib.util
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True

SCRIPT = Path(__file__).resolve().parents[1] / 'app/scripts/check_webkit_bundle.py'
spec = importlib.util.spec_from_file_location('webkit_bundle', SCRIPT)
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


class BaselineTests(unittest.TestCase):
    def test_imports_not_exports_establish_baseline(self):
        symbols = '''
  1: 0000000000 0 FUNC GLOBAL DEFAULT UND memcpy@GLIBC_2.14 (2)
  2: 0000000000 0 FUNC GLOBAL DEFAULT UND close@GLIBC_2.35 (3)
  3: 0000000000 0 FUNC GLOBAL DEFAULT  12 exported@@GLIBC_2.40
  4: 0000000000 0 FUNC GLOBAL DEFAULT UND cpp@GLIBCXX_3.4.30 (4)
'''
        self.assertEqual(bundle.glibc_requirements(symbols), {(2, 14), (2, 35)})

    def test_rejects_newer_import_in_helper(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            helper = root / 'usr/lib/WebKitWebProcess'
            helper.parent.mkdir(parents=True)
            helper.write_bytes(b'\x7fELF')
            with patch.object(bundle.subprocess, 'run') as run:
                run.return_value.stdout = '1: 0 0 FUNC GLOBAL DEFAULT UND arc4random@GLIBC_2.36 (2)'
                with self.assertRaisesRegex(SystemExit, 'WebKitWebProcess requires GLIBC_2.36'):
                    bundle.check_glibc(root, '2.35')
                run.return_value.stdout = '1: 0 0 FUNC GLOBAL DEFAULT UND close@GLIBC_2.35 (2)'
                bundle.check_glibc(root, '2.35')


@unittest.skipUnless(shutil.which('cc') and shutil.which('readelf'), 'needs C compiler and binutils')
class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.lib = self.root / 'usr/lib'
        self.lib.mkdir(parents=True)
        self.library('libwebkit2gtk-4.1.so.0', 'webkit', 2)
        self.library('libjavascriptcoregtk-4.1.so.0', 'jsc', 2)
        for helper in ('WebKitWebProcess', 'WebKitNetworkProcess', 'libwebkit2gtkinjectedbundle.so'):
            (self.lib / helper).write_text('fixture')

    def library(self, name, prefix, micro):
        source = '\n'.join(f'int {prefix}_get_{part}_version(void) {{ return {n}; }}'
                           for part, n in [('major', 2), ('minor', 54), ('micro', micro)])
        subprocess.run(['cc', '-shared', '-fPIC', '-x', 'c', '-', '-o', str(self.lib / name)],
                       input=source, text=True, capture_output=True, check=True)

    def check(self):
        return subprocess.run([sys.executable, '-I', str(SCRIPT), str(self.root),
                               '2.54.2', '--max-glibc', '2.35'], text=True, capture_output=True)

    def test_matching_bundle(self):
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('"JavaScriptCore": "2.54.2"', result.stdout)

    def test_wrong_javascriptcore(self):
        self.library('libjavascriptcoregtk-4.1.so.0', 'jsc', 1)
        result = self.check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('expected 2.54.2', result.stderr)

    def test_missing_library(self):
        (self.lib / 'libwebkit2gtk-4.1.so.0').unlink()
        result = self.check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('missing bundled WebKitGTK', result.stderr)

    def test_missing_helper(self):
        (self.lib / 'WebKitNetworkProcess').unlink()
        result = self.check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('missing bundled helper: WebKitNetworkProcess', result.stderr)


if __name__ == '__main__':
    unittest.main()
