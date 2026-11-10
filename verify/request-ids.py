#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Headless check that the engine echoes a request's `rid`, and only then.

Engine::request (app/src-tauri/src/engine.rs) matches untagged replies by
`rid`; scripts that send none must get replies without one.
"""

import argparse
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, default=ROOT / 'build/bin/darktable-engine')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='immage-rid-') as tmp:
        work = Path(tmp)
        with (work / 'engine.log').open('w') as log:
            child = subprocess.Popen(
                [str(args.engine.resolve()), '--core', '--configdir', str(work / 'config'),
                 '--cachedir', str(work / 'cache'), '--conf', 'opencl=false',
                 '--conf', 'resourcelevel=0'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=log, text=True, env=os.environ | {'XDG_DATA_HOME': str(work / 'data')})
            poll = selectors.DefaultSelector()
            poll.register(child.stdout, selectors.EVENT_READ)

            def send(line):
                child.stdin.write(line + '\n')
                child.stdin.flush()
                assert poll.select(60), f'engine timeout: {line}'
                return json.loads(child.stdout.readline())

            try:
                checks = [
                    # success and failure replies both echo it
                    ({'cmd': 'version', 'rid': 7}, True, 7),
                    ({'cmd': 'open', 'path': str(work / 'missing.raw'), 'rid': 8}, False, 8),
                    ({'cmd': 'no_such_command', 'rid': 9}, False, 9),
                    # none sent, none echoed: the verify and benchmark scripts
                    ({'cmd': 'version'}, True, None),
                    ({'cmd': 'open', 'path': str(work / 'missing.raw')}, False, None),
                    # a string is not a request number
                    ({'cmd': 'version', 'rid': 'x'}, True, None),
                    # `id` is render's base number, never echoed as a rid
                    ({'cmd': 'version', 'id': 5}, True, None),
                ]
                for request, ok, rid in checks:
                    reply = send(json.dumps(request))
                    assert reply.get('ok', False) == ok, f'{request}: {reply}'
                    assert reply.get('rid') == rid, f'{request}: {reply}'
                    assert 'tag' not in reply, f'{request}: {reply}'
                # a line that is not a request has no rid to echo
                reply = send('[1]')
                assert not reply['ok'] and 'rid' not in reply, reply
                # the rid of one request does not leak into the next
                assert 'rid' not in send(json.dumps({'cmd': 'version'}))
                send(json.dumps({'cmd': 'quit', 'rid': 10}))
                child.wait(30)
            finally:
                if child.poll() is None:
                    child.kill()
    print('request ids: ok')
    return 0


if __name__ == '__main__':
    sys.exit(main())
