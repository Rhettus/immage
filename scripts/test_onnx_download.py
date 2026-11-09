#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors
"""Exercise the patched CMake downloader against a local release server."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest


class DownloadTests(unittest.TestCase):
    def run_download(self, failures, valid_hash=True):
        patch = (Path(__file__).resolve().parents[1] / 'patches/darktable-engine.patch').read_text()
        download_patch = patch.split('diff --git a/cmake/modules/FindONNXRuntime.cmake', 1)[1]
        added = '\n'.join(line[1:] for line in download_patch.splitlines()
                          if line.startswith(('+', ' ')) and not line.startswith('+++'))
        start = added.index('    # Retry transient release-host failures')
        end = added.index('\n    endif()', added.index('archive checksum mismatch', start))
        block = added[start:end + len('\n    endif()')]
        # Keep the retry behavior but omit backoff to make local checks quick.
        block = block.replace('"${_ORT_RETRY_DELAY}"', '"0"')
        payload = b'ONNX Runtime test archive'
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                self.send_response(503 if len(requests) <= failures else 200)
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as temp:
                archive = Path(temp) / 'runtime.tgz'
                script = Path(temp) / 'download.cmake'
                digest = hashlib.sha256(payload if valid_hash else b'wrong').hexdigest()
                script.write_text(f'''cmake_minimum_required(VERSION 3.22)
set(_ORT_URL "http://127.0.0.1:{server.server_port}/runtime.tgz")
set(_ORT_ARCHIVE "{archive.as_posix()}")
set(_ORT_HASH_ALGO SHA256)
set(_ORT_HASH "{digest}")
{block}
''')
                result = subprocess.run(['cmake', '-P', str(script)], capture_output=True, text=True)
                return result, len(requests), archive.exists()
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_recovers_after_transient_failures(self):
        result, count, exists = self.run_download(2)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(count, 3)
        self.assertTrue(exists)

    def test_stops_after_four_failures(self):
        result, count, exists = self.run_download(4)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('after 4 attempts', result.stderr)
        self.assertEqual(count, 4)
        self.assertFalse(exists)

    def test_rejects_bad_checksum(self):
        result, count, exists = self.run_download(0, valid_hash=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('checksum mismatch', result.stderr)
        self.assertEqual(count, 1)
        self.assertFalse(exists)


if __name__ == '__main__':
    unittest.main()
