#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Headless check of the engine's GPU check commands (parity, opencl, cl_errors).

Without an OpenCL device it checks the comparison against itself (both passes
on the CPU must match exactly) and that a GPU parity request is refused. With
one, pass --opencl to also compare the CPU and the GPU on a synthetic photo.
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
sys.path.insert(0, str(ROOT / 'verify'))
from importlib import import_module  # noqa: E402

tiff = import_module('transform-sampling').tiff


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, default=ROOT / 'build/bin/darktable-engine')
    parser.add_argument('--opencl', action='store_true', help='start the engine with OpenCL on')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='immage-parity-') as tmp:
        work = Path(tmp)
        photo = work / 'parity.tif'
        photo.write_bytes(tiff(1200, 800, 1))
        with (work / 'engine.log').open('w') as log:
            child = subprocess.Popen(
                [str(args.engine.resolve()), '--core', '--configdir', str(work / 'config'),
                 '--cachedir', str(work / 'cache'), '--conf', f'opencl={"true" if args.opencl else "false"}',
                 '--conf', 'opencl_device_priority=//*//', '--conf', 'opencl_scheduling_profile=default',
                 '--conf', 'resourcelevel=0', '-d', 'perf'],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True,
                env=os.environ | {'OMP_NUM_THREADS': '2', 'OMP_WAIT_POLICY': 'passive',
                                  'XDG_DATA_HOME': str(work / 'data')})
            poll = selectors.DefaultSelector()
            poll.register(child.stdout, selectors.EVENT_READ)

            def request(data, ok=True):
                child.stdin.write(json.dumps(data) + '\n')
                child.stdin.flush()
                assert poll.select(120), f'engine timeout: {data}'
                reply = json.loads(child.stdout.readline())
                assert bool(reply.get('ok')) == ok, f'{data}: {reply}'
                return reply

            try:
                cl = request({'cmd': 'opencl'})
                for key in ['running', 'inited', 'error_count', 'stopped', 'devices']:
                    assert key in cl, cl
                print(f'opencl: running={cl["running"]} devices={len(cl["devices"])} errors={cl["error_count"]}')
                request({'cmd': 'parity', 'self': True}, ok=False)  # no photo open
                request({'cmd': 'open', 'path': str(photo)})
                request({'cmd': 'set', 'op': 'exposure', 'enabled': True, 'params': {'exposure': 0.7}})
                render = request({'cmd': 'render', 'width': 400, 'height': 300, 'rgba': str(work / 'frame.rgba')})
                assert render['cl_errors'] == 0, render
                same = request({'cmd': 'parity', 'self': True, 'size': 512,
                                'diff': str(work / 'self.png')})
                assert max(same['width'], same['height']) == 512, same
                assert same['de']['max'] == 0 and same['de']['over2'] == 0, same
                assert all(c['max'] == 0 for c in same['rgb'].values()), same
                assert same['cpu']['cl_errors'] == same['gpu']['cl_errors'] == 0, same
                assert 'diff' not in same and not (work / 'self.png').exists(), same
                print(f'self check: {same["width"]}x{same["height"]} identical, '
                      f'{same["cpu"]["ms"]:.0f} + {same["gpu"]["ms"]:.0f} ms')
                if cl['running']:
                    gpu = request({'cmd': 'parity', 'size': 1024, 'diff': str(work / 'gpu.png')})
                    print(f'cpu vs {gpu["gpu"].get("device", "?")}: dE p99 {gpu["de"]["p99"]:.2f} '
                          f'max {gpu["de"]["max"]:.2f}, cl_errors {gpu["gpu"]["cl_errors"]}')
                    assert gpu['gpu']['devid'] >= 0, gpu
                    assert gpu['de']['p99'] < 2, gpu
                else:
                    refused = request({'cmd': 'parity'}, ok=False)
                    assert 'OpenCL' in refused.get('error', ''), refused
                    print('no OpenCL device: a GPU comparison is refused, as expected')
                request({'cmd': 'quit'})
                child.wait(timeout=15)
                assert child.returncode == 0
                log.flush()
                text = (work / 'engine.log').read_text()
                assert '[engine] | cpu' in text and '[engine] | gpu' in text, 'pass markers missing'
                print('gpu parity checks passed; no GUI launched')
            except BaseException:
                log.flush()
                print((work / 'engine.log').read_text()[-6000:], file=sys.stderr)
                raise
            finally:
                poll.close()
                if child.poll() is None:
                    child.kill()
                    child.wait()


if __name__ == '__main__':
    main()
