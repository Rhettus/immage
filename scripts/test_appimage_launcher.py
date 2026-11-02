#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Headless launcher regressions; all application executables are fixtures."""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = ROOT / 'app/scripts/appimage-launcher.sh'


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='immage launcher ')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.app = self.root / 'Immage.AppDir'
        self.tools = self.root / 'tools'
        self.tools.mkdir()
        host_tmp = tempfile.TemporaryDirectory(prefix='immage-host-')
        self.addCleanup(host_tmp.cleanup)
        self.host = Path(host_tmp.name) / 'host'
        self.host.mkdir()
        self.write(self.app / 'AppRun', LAUNCHER.read_text())
        script = '''#!/bin/sh
printf 'EXEC=%s SELECTED=%s GDK=%s LD=%s HELPERS=%s\\n' "$0" "$IMMAGE_WEBKIT_SELECTED" "${GDK_BACKEND:-}" "${LD_LIBRARY_PATH:-}" "${WEBKIT_EXEC_PATH:-}"
printf 'ARG=<%s>\\n' "$@"
printf 'GBM_DISABLE=<%s>\\n' "${WEBKIT_DMABUF_RENDERER_DISABLE_GBM-unset}"
'''
        self.write(self.app / 'AppRun.bundled', script)
        self.write(self.app / 'usr/bin/immage-system', script)
        self.write(self.app / 'usr/lib/Immage/webext/libimmage-frames.so', '')
        helpers = self.host / 'webkit2gtk-4.1'
        for name in ('WebKitWebProcess', 'WebKitNetworkProcess',
                     'injected-bundle/libwebkit2gtkinjectedbundle.so'):
            self.write(helpers / name, '')
        self.write(self.tools / 'readlink', '#!/bin/sh\nprintf /drivers/nvidia\n')
        self.write(self.tools / 'ldd', '''#!/bin/sh
[ -z "${LD_LIBRARY_PATH:-}${LD_PRELOAD:-}${WEBKIT_EXEC_PATH:-}${GTK_PATH:-}" ] || exit 3
case "$*" in *'/usr/libexec/'*) exit 1;; esac
if [ "${TEST_BAD_LIBS:-}" = yes ]; then echo 'libmissing.so => not found'; exit 0; fi
case "$*" in *'/webext/'*)
if [ "${TEST_BAD_SYMBOL:-}" = yes ]; then echo 'undefined symbol: jsc_value_new_typed_array'; exit 0; fi;; esac
if [ "${TEST_MIXED_LIBS:-}" = yes ]; then echo "$APPDIR/usr/lib/libglib-2.0.so.0"; fi
printf 'libwebkit2gtk-4.1.so.0 => %s/libwebkit2gtk-4.1.so.0 (0x123)\\n' "$TEST_HOST"
''')
        self.env = {k: v for k, v in os.environ.items()
                    if not k.startswith(('IMMAGE_', 'WEBKIT_', 'GDK_', 'LD_', 'XDG_SESSION_'))
                    and k not in ('DISPLAY', 'WAYLAND_DISPLAY')}
        self.env.update(PATH=str(self.tools) + ':' + os.environ['PATH'],
                        TEST_HOST=str(self.host), XDG_SESSION_TYPE='x11')

    def write(self, path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        path.chmod(0o755)

    def run_launcher(self, **env):
        return subprocess.run([str(self.app / 'AppRun'), 'photo with spaces.jpg', '--flag'],
                              env=self.env | env, text=True, capture_output=True)

    def test_nvidia_x11_system_and_arguments(self):
        result = self.run_launcher(LD_LIBRARY_PATH='/other-app/lib', GTK_PATH='/other-app/gtk',
                                   WEBKIT_EXEC_PATH='/other-app/helpers')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('SELECTED=system GDK=x11 LD= HELPERS=', result.stdout)
        self.assertIn('ARG=<photo with spaces.jpg>', result.stdout)
        self.assertIn('ARG=<--flag>', result.stdout)

    def test_wayland_with_display_keeps_bundle(self):
        result = self.run_launcher(XDG_SESSION_TYPE='wayland', DISPLAY=':0', WAYLAND_DISPLAY='wayland-0')
        self.assertIn('SELECTED=bundled GDK=wayland', result.stdout)

    def test_explicit_backend_wins(self):
        result = self.run_launcher(XDG_SESSION_TYPE='wayland', GDK_BACKEND='x11')
        self.assertIn('SELECTED=system GDK=x11', result.stdout)

    def test_ambiguous_backend_keeps_bundle(self):
        result = self.run_launcher(GDK_BACKEND='wayland,x11')
        self.assertIn('SELECTED=bundled', result.stdout)

    def test_non_nvidia_keeps_bundle(self):
        if Path('/proc/driver/nvidia/version').exists():
            self.skipTest('real NVIDIA host overrides DRM fixture')
        self.write(self.tools / 'readlink', '#!/bin/sh\nprintf /drivers/amdgpu\n')
        self.assertIn('SELECTED=bundled', self.run_launcher().stdout)

    def test_forced_modes(self):
        self.assertIn('SELECTED=bundled', self.run_launcher(IMMAGE_WEBKIT='bundled').stdout)
        self.assertIn('SELECTED=system', self.run_launcher(IMMAGE_WEBKIT='system',
                                                         XDG_SESSION_TYPE='wayland').stdout)

    def test_nvidia_x11_system_disables_gbm_by_default(self):
        for mode in ('auto', 'system'):
            with self.subTest(mode=mode):
                result = self.run_launcher(IMMAGE_WEBKIT=mode)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('GBM_DISABLE=<1>', result.stdout)
                self.assertIn('GBM-disable=1', result.stderr)

    def test_explicit_gbm_override_wins(self):
        for value in ('0', '1', ''):
            with self.subTest(value=value):
                result = self.run_launcher(WEBKIT_DMABUF_RENDERER_DISABLE_GBM=value)
                self.assertIn(f'GBM_DISABLE=<{value}>', result.stdout)

    def test_wayland_leaves_gbm_untouched(self):
        for mode in ('auto', 'system'):
            with self.subTest(mode=mode):
                result = self.run_launcher(IMMAGE_WEBKIT=mode, XDG_SESSION_TYPE='wayland')
                self.assertIn('GBM_DISABLE=<unset>', result.stdout)
        result = self.run_launcher(XDG_SESSION_TYPE='wayland', WEBKIT_DMABUF_RENDERER_DISABLE_GBM='0')
        self.assertIn('GBM_DISABLE=<0>', result.stdout)

    def test_bundled_and_fallback_leave_gbm_untouched(self):
        for env in ({'IMMAGE_WEBKIT': 'bundled'}, {'TEST_BAD_LIBS': 'yes'},
                    {'GDK_BACKEND': 'wayland,x11'}):
            with self.subTest(env=env):
                result = self.run_launcher(**env)
                self.assertIn('SELECTED=bundled', result.stdout)
                self.assertIn('GBM_DISABLE=<unset>', result.stdout)

    def test_non_nvidia_system_leaves_gbm_untouched(self):
        if Path('/proc/driver/nvidia/version').exists():
            self.skipTest('real NVIDIA host overrides DRM fixture')
        self.write(self.tools / 'readlink', '#!/bin/sh\nprintf /drivers/amdgpu\n')
        result = self.run_launcher(IMMAGE_WEBKIT='system')
        self.assertIn('SELECTED=system', result.stdout)
        self.assertIn('GBM_DISABLE=<unset>', result.stdout)

    def test_bad_override(self):
        result = self.run_launcher(IMMAGE_WEBKIT='invalid')
        self.assertEqual(result.returncode, 2)
        self.assertNotIn('EXEC=', result.stdout)

    def test_missing_libraries_auto_falls_back_forced_stops(self):
        result = self.run_launcher(TEST_BAD_LIBS='yes')
        self.assertIn('SELECTED=bundled', result.stdout)
        self.assertIn('falling back', result.stderr)
        result = self.run_launcher(TEST_BAD_LIBS='yes', IMMAGE_WEBKIT='system')
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('EXEC=', result.stdout)

    def test_extension_missing_symbol_stops(self):
        result = self.run_launcher(TEST_BAD_SYMBOL='yes', IMMAGE_WEBKIT='system')
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('EXEC=', result.stdout)

    def test_mixed_library_paths_rejected(self):
        result = self.run_launcher(TEST_MIXED_LIBS='yes', IMMAGE_WEBKIT='system')
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('EXEC=', result.stdout)

    def test_system_app_failure_is_not_retried(self):
        self.write(self.app / 'usr/bin/immage-system', '#!/bin/sh\nexit 17\n')
        result = self.run_launcher(IMMAGE_WEBKIT='system')
        self.assertEqual(result.returncode, 17)
        self.assertNotIn('falling back', result.stderr)

    def test_missing_helper_stops(self):
        (self.host / 'webkit2gtk-4.1/WebKitNetworkProcess').unlink()
        result = self.run_launcher(IMMAGE_WEBKIT='system')
        self.assertEqual(result.returncode, 1)
        self.assertIn('helpers are missing or incompatible', result.stderr)


@unittest.skipUnless(shutil.which('cc') and shutil.which('patchelf'), 'needs cc and patchelf')
class PackagingTests(unittest.TestCase):
    def test_prepare_preserves_app_and_removes_ui_search_paths(self):
        spec = importlib.util.spec_from_file_location('prepare', ROOT / 'app/scripts/prepare_appimage_launcher.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            binary = root / 'usr/bin/immage'
            extension = root / 'usr/lib/Immage/webext/libimmage-frames.so'
            binary.parent.mkdir(parents=True)
            extension.parent.mkdir(parents=True)
            subprocess.run(['cc', '-x', 'c', '-', '-Wl,-rpath,$ORIGIN/../lib', '-o', str(binary)],
                           input='int main(void) { return 0; }', text=True, check=True)
            subprocess.run(['cc', '-shared', '-fPIC', '-x', 'c', '-', '-Wl,-rpath,$ORIGIN',
                            '-o', str(extension)], input='int fixture(void) { return 0; }', text=True, check=True)
            (root / 'AppRun').write_text('original launcher')
            original_binary = binary.read_bytes()
            module.prepare(root)
            module.prepare(root)
            self.assertEqual((root / 'AppRun.bundled').read_text(), 'original launcher')
            self.assertEqual(binary.read_bytes(), original_binary)
            for path in (root / 'usr/bin/immage-system',
                         root / 'usr/lib/Immage/webext/libimmage-frames.so'):
                result = subprocess.run(['patchelf', '--print-rpath', str(path)],
                                        text=True, capture_output=True, check=True)
                self.assertEqual(result.stdout.strip(), '')


if __name__ == '__main__':
    unittest.main()
