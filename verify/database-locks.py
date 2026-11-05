#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Headless persistent data-database locking checks with isolated engine state."""
import argparse
import json
import os
from pathlib import Path
import selectors
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--build', type=Path, required=True)
build = parser.parse_args().build.resolve()

with tempfile.TemporaryDirectory(prefix='immage-lock-check-') as tmp:
    state = Path(tmp)
    children = []
    logs = []

    def start():
        log = (state / f'engine-{len(logs)}.log').open('w+')
        logs.append(log)
        child = subprocess.Popen([
            str(build / 'bin/darktable-engine'), '--core',
            '--configdir', str(state / 'config'),
            '--cachedir', str(state / 'cache'),
            '--datadir', str(build / 'share/darktable'),
            '--moduledir', str(build / 'lib/darktable'),
            '--conf', 'opencl=false', '--conf', 'resourcelevel=0',
        ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log,
            text=True, env=os.environ | {'OMP_NUM_THREADS': '2',
                                       'XDG_DATA_HOME': str(state / 'data')})
        children.append(child)
        return child

    def request(child, command):
        child.stdin.write(json.dumps({'cmd': command}) + '\n')
        child.stdin.flush()
        with selectors.DefaultSelector() as poll:
            poll.register(child.stdout, selectors.EVENT_READ)
            assert poll.select(60), 'engine response timed out'
        line = child.stdout.readline()
        assert line, 'engine exited before responding'
        reply = json.loads(line)
        assert reply.get('ok') or (command == 'close' and reply.get('error') == 'no image open'), line

    lock = state / 'config/data.db.lock'
    try:
        owner = start()
        request(owner, 'close')  # Confirms dt_init completed, without a photo.
        assert int(lock.read_bytes().rstrip(b'\0')) == owner.pid
        contender = start()
        assert contender.wait(timeout=60) != 0, 'concurrent engine acquired live lock'
        assert owner.poll() is None
        assert int(lock.read_bytes().rstrip(b'\0')) == owner.pid, 'live lock replaced'
        logs[-1].seek(0)
        assert 'database is locked' in logs[-1].read()
        request(owner, 'close')
        owner.kill()
        owner.wait(timeout=15)
        assert lock.exists(), 'kill did not leave a stale lock fixture'
        replacement = start()
        request(replacement, 'close')
        assert int(lock.read_bytes().rstrip(b'\0')) == replacement.pid
        request(replacement, 'quit')
        assert replacement.wait(timeout=15) == 0
        assert not lock.exists(), 'graceful shutdown retained the lock'
        # Repeat startup after clean shutdown, verifying reusable persistent DBs.
        clean = start()
        request(clean, 'quit')
        assert clean.wait(timeout=15) == 0
        assert not lock.exists()
        print('Live-lock exclusion, stale-lock recovery and clean restart passed')
    except BaseException:
        for log in logs:
            log.flush()
            log.seek(0)
            print(log.read())
        raise
    finally:
        for child in children:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=15)
        for log in logs:
            log.close()
