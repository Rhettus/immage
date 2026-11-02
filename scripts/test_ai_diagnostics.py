#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Exercise report collection with command-line fixtures, never an app GUI."""
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'app/scripts/diagnose_ai_appimage.sh'


class DiagnosticsTests(unittest.TestCase):
    def test_debug_arguments_and_failure_report(self):
        with tempfile.TemporaryDirectory(prefix='immage ai fixture ') as tmp:
            root = Path(tmp)
            engine = root / 'AppDir/usr/lib/Immage/darktable/bin/darktable-engine'
            engine.parent.mkdir(parents=True)
            engine.write_text('''#!/bin/sh
printf 'engine args: <%s>\\n' "$@" >&2
printf 'fixture AI failure\\n' >&2
exit 7
''')
            engine.chmod(0o755)
            app = root / 'Fixture.AppImage'
            app.write_text('''#!/bin/sh
export APPDIR="$TEST_APPDIR"
exec "$DT_ENGINE_BIN" --models '/fixture/models with spaces' --core --conf opencl=false
''')
            app.chmod(0o755)
            model = root / 'data/app.immage/models/mask-object-sam21-small'
            model.mkdir(parents=True)
            for name in ('config.json', 'encoder.onnx', 'decoder.onnx'):
                (model / name).write_text('fixture')
            env = os.environ | {'TEST_APPDIR': str(root / 'AppDir'),
                                'XDG_DATA_HOME': str(root / 'data')}
            result = subprocess.run(['sh', str(SCRIPT), str(app)], cwd=root, env=env,
                                    text=True, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            archive = next(root.glob('immage-ai-report.*.tar.gz'))
            report = Path(str(archive)[:-7])
            log = (report / 'engine-ai.log').read_text()
            for expected in ('fixture AI failure', 'engine args: <-d>', 'engine args: <ai>',
                             'engine args: </fixture/models with spaces>'):
                self.assertIn(expected, log)
            self.assertIn('App exit status: 7', (report / 'system.txt').read_text())
            self.assertIn('encoder.onnx', (report / 'model-after.txt').read_text())
            with tarfile.open(archive) as tar:
                self.assertIn('./engine-ai.log', tar.getnames())

    def test_usage_does_not_launch_anything(self):
        result = subprocess.run(['sh', str(SCRIPT)], text=True, capture_output=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('Usage:', result.stderr)


if __name__ == '__main__':
    unittest.main()
