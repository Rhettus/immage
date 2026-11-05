"""Non-GUI orchestration checks; no Apple tools or applications are launched."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('capture', Path(__file__).resolve().parents[1] / 'benchmarking/capture-macos.py')
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)


class CaptureTests(unittest.TestCase):
    def exercise(self, pid=None, failure=False):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'capture'
            def record(args, **kwargs):
                if not failure:
                    Path(args[args.index('--output') + 1]).mkdir()
                return int(failure)
            with patch.object(capture.platform, 'platform', return_value='test-platform'), patch.object(capture, 'command', return_value=0), patch.object(capture, 'record', side_effect=record) as run:
                if failure:
                    with self.assertRaises(RuntimeError):
                        capture.capture(output, 30, pid)
                else:
                    capture.capture(output, 30, pid)
                args = run.call_args.args[0]
            metadata = json.loads((output / 'capture.json').read_text())
            self.assertLessEqual(metadata['recordCommandStartedUnixMs'], metadata['recordCommandEndedUnixMs'])
            self.assertEqual(metadata['commands'][3]['exitCode'], int(failure))
            if not failure:
                self.assertTrue(metadata['stackExportSucceeded'])
            return args

    def test_record_waits_for_profiler_and_restores_signal(self):
        with patch.object(capture.subprocess, "Popen") as popen, patch.object(capture.signal, "signal", return_value="previous") as handler:
            popen.return_value.wait.return_value = 0
            self.assertEqual(capture.record(["xctrace"]), 0)
            popen.return_value.wait.assert_called_once_with()
            self.assertEqual(handler.call_args_list[0].args, (capture.signal.SIGINT, capture.signal.SIG_IGN))
            self.assertEqual(handler.call_args_list[1].args, (capture.signal.SIGINT, "previous"))

    def test_all_processes(self):
        self.assertIn('--all-processes', self.exercise())

    def test_single_process(self):
        args = self.exercise(123)
        self.assertEqual(args[-2:], ['--attach', '123'])
        self.assertNotIn('--all-processes', args)

    def test_failed_record_preserves_metadata(self):
        self.exercise(failure=True)


if __name__ == '__main__':
    unittest.main()
