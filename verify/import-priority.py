#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Headless check of the engine's import order (library.c, _import_rank).

IMMAGE_TEST_SLOW_DIR makes each read under one folder take 2 s, as a slow
share's does. While an import from it holds the one import thread, a
`background` import and then one the user waits on are queued: the user's
runs first. Each reply carries the import's own time (`ms`), not its wait.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('stuck_drive', ROOT / 'verify/stuck-drive.py')
stuck = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stuck)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, default=ROOT / 'build/bin/darktable-engine')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='immage-priority-') as tmp:
        work = Path(tmp)
        slow, local = work / 'slow', work / 'local'
        slow.mkdir()
        local.mkdir()
        for p in [slow / 'nas.tif', local / 'later.tif', local / 'wanted.tif']:
            p.write_bytes(stuck.tiff())
        # the stall folder is left unused; the slow one is read at start
        never = work / 'never'
        never.mkdir()
        os.environ['IMMAGE_TEST_SLOW_DIR'] = str(slow)
        engine = stuck.Engine(args.engine, work, never)
        try:
            nas = engine.send({'cmd': 'import', 'files': [str(slow / 'nas.tif')]})
            later = engine.send({'cmd': 'import', 'files': [str(local / 'later.tif')], 'background': True})
            wanted = engine.send({'cmd': 'import', 'files': [str(local / 'wanted.tif')]})
            order = []
            for _ in range(3):
                reply = None
                while reply is None:
                    for tag in (nas, later, wanted):
                        if tag in engine.early:
                            reply = engine.early.pop(tag)
                            order.append(tag)
                            break
                    else:
                        line = engine.child.stdout.readline()
                        assert line, 'the engine exited'
                        got = json.loads(line)
                        engine.early[got.get('tag')] = got
                assert reply['ok'] and len(reply['images']) == 1, reply
                if order[-1] == nas:
                    assert reply['ms'] >= 2000, reply
                else:
                    assert reply['ms'] < 2000, reply
            assert order == [nas, wanted, later], order
        finally:
            engine.close()
    print('import-priority: ok')


if __name__ == '__main__':
    sys.exit(main())
