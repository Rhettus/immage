#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Headless real-model regression; requires a built AI engine and cached SAM model.

DT_ORT_LIBRARY may select a local ONNX Runtime. No downloads or GUI are used.
Run: python3 scripts/test_ai_model_path.py
"""
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
MODEL = 'mask-object-sam21-small'
SOURCE = ROOT / 'build/ai-models' / MODEL


def copy_model_file(src, dst):
    if Path(src).suffix == '.onnx':
        Path(dst).symlink_to(Path(src).resolve())
        return dst
    return shutil.copy2(src, dst)


def run(work, models, enabled, expected, install_after_open=False):
    env = os.environ | {'XDG_DATA_HOME': str(work / 'data'),
                        'OMP_NUM_THREADS': '2', 'OMP_WAIT_POLICY': 'passive'}
    args = [str(ROOT / 'build/bin/darktable-engine'), '--models', str(models),
            '--core', '--configdir', str(work / 'config'), '--cachedir', str(work / 'cache'),
            '--conf', 'opencl=false', '--conf', 'resourcelevel=0', '-d', 'ai']
    if enabled is not None:
        args += ['--conf', f'plugins/ai/enabled={str(enabled).lower()}']
    # A conflicting explicit path must not override the engine's --models.
    args += ['--conf', f'plugins/ai/models_path={work / "wrong-models"}']
    with (work / 'engine.log').open('a') as log:
        p = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=log, text=True, env=env)
        selector = selectors.DefaultSelector()
        selector.register(p.stdout, selectors.EVENT_READ)

        def request(cmd):
            p.stdin.write(json.dumps(cmd) + '\n')
            p.stdin.flush()
            deadline = time.monotonic() + 120
            while time.monotonic() < deadline:
                if Path('/proc/meminfo').exists():
                    available = next(int(l.split()[1]) for l in Path('/proc/meminfo').read_text().splitlines()
                                     if l.startswith('MemAvailable:'))
                    if available < 1024 * 1024:
                        raise RuntimeError('less than 1 GiB available; stopping own engine')
                if selector.select(.5):
                    line = p.stdout.readline()
                    if not line:
                        raise RuntimeError(f'engine exited: {p.poll()}')
                    return json.loads(line)
                if p.poll() is not None:
                    raise RuntimeError(f'engine exited: {p.returncode}')
            raise TimeoutError(cmd)

        try:
            photo = work / 'sample.jpg'
            if not photo.exists():
                shutil.copy2(ROOT / 'app/sample/stairs-to-mountain.jpg', photo)
            assert request({'cmd': 'open', 'path': str(photo)})['ok']
            if install_after_open:
                # The registry has already scanned the empty directory.
                shutil.copytree(SOURCE, models / MODEL, copy_function=copy_model_file)
            reply = request({'cmd': 'ai_object', 'points': [[.5, .5, 1]]})
            assert reply['ok'] is expected, reply
            assert request({'cmd': 'quit'})['ok']
            p.wait(timeout=15)
            assert p.returncode == 0, p.returncode
        finally:
            selector.close()
            if p.poll() is None:
                p.terminate()
                try:
                    p.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    p.kill()
                    p.wait()
            p.stdin.close()
            p.stdout.close()


def main():
    if not (SOURCE / 'encoder.onnx').is_file():
        raise SystemExit(f'cache the Object model first: {SOURCE}')
    with tempfile.TemporaryDirectory(prefix='immage-ai-path-', dir=ROOT / 'build') as temp:
        base = Path(temp)
        for name, enabled in [('enabled', True), ('disabled', False), ('late-install', True), ('old-version', True)]:
            work = base / name
            work.mkdir()
            models = work / 'models with spaces'
            models.mkdir()
            if name != 'late-install':
                shutil.copytree(SOURCE, models / MODEL, copy_function=copy_model_file)
            if name == 'old-version':
                config = models / MODEL / 'config.json'
                data = json.loads(config.read_text())
                data['version'] = '0.0'
                config.write_text(json.dumps(data))
            run(work, models, enabled, name != 'old-version', name == 'late-install')
            if name == 'enabled':
                run(work, models, None, True)  # persisted AI-enabled profile
            print(f'PASS {name}', flush=True)


if __name__ == '__main__':
    main()
