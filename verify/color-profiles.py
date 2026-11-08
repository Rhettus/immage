#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Headless Negative color-management checks on disposable photos and ICC files."""
import argparse
import ctypes as C
import ctypes.util
import json
import os
from pathlib import Path
import selectors
import shutil
import struct
import subprocess
import tempfile
import zlib

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--build', type=Path, default=Path('build'))
args = parser.parse_args()
build = args.build.resolve()
# Make a real RGB matrix ICC fixture with LCMS; no user profiles are read or changed.
lcms = C.CDLL(ctypes.util.find_library('lcms2'))
lcms.cmsCreate_sRGBProfile.restype = C.c_void_p
lcms.cmsSaveProfileToFile.argtypes = [C.c_void_p, C.c_char_p]
lcms.cmsCloseProfile.argtypes = [C.c_void_p]
with tempfile.TemporaryDirectory(prefix='immage-color-profiles-') as tmp:
    p = Path(tmp)
    config = p / 'config'
    for role in ('in', 'out'):
        (config / 'color' / role).mkdir(parents=True)
    profile = lcms.cmsCreate_sRGBProfile()
    try:
        for role, name in [('in', 'scanner.icc'), ('out', 'working.icm')]:
            assert lcms.cmsSaveProfileToFile(profile, os.fsencode(config / 'color' / role / name))
    finally:
        lcms.cmsCloseProfile(profile)
    (config / 'color/in/invalid.icc').write_bytes(b'not an ICC profile')
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    photo = p / 'negative.png'
    rows = b''.join(b'\0' + bytes(v for x in range(64) for v in (80 + x * 2, 40 + y * 2, 30 + x)) for y in range(64))
    photo.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 64, 64, 8, 2, 0, 0, 0))
                     + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))
    def start(config_dir=config):
        log = (p / 'engine.log').open('a')
        child = subprocess.Popen([str(build / 'bin/darktable-engine'), '--core', '--configdir', str(config_dir),
            '--cachedir', str(p / 'cache'), '--datadir', str(build / 'share/darktable'),
            '--moduledir', str(build / 'lib/darktable'), '--conf', 'opencl=false', '--conf', 'resourcelevel=0'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True,
            env=os.environ | {'OMP_NUM_THREADS': '2', 'XDG_DATA_HOME': str(p / 'data')})
        poll = selectors.DefaultSelector()
        poll.register(child.stdout, selectors.EVENT_READ)
        def req(data, ok=True):
            child.stdin.write(json.dumps(data) + '\n')
            child.stdin.flush()
            assert poll.select(45), 'engine timed out'
            reply = json.loads(child.stdout.readline())
            assert bool(reply.get('ok')) == ok, reply
            return reply
        return child, poll, log, req
    child, poll, log, req = start()
    fields = ['input_profile', 'working_profile']
    get = lambda: req({'cmd': 'get', 'modules': {'colorin': fields}})['modules']['colorin']
    def put(**params):
        req({'cmd': 'set', 'op': 'colorin', 'params': params})
    def pixels():
        path = p / 'frame.rgba'
        req({'cmd': 'render', 'width': 64, 'height': 64, 'rgba': str(path)})
        return path.read_bytes()
    try:
        req({'cmd': 'open', 'path': str(photo)})
        menu = req({'cmd': 'color_profiles'})
        assert all(any(v == 0 for _, v in menu[role]) for role in ('input', 'working'))
        input_icc = [v for _, v in menu['input'] if v >= 256]
        work_icc = [v for _, v in menu['working'] if v >= 256]
        assert len(input_icc) == len(work_icc) == 1, menu
        assert input_icc != work_icc, menu
        before = get()
        # Independent choices, correct native storage, no changes during enumeration.
        native = get()
        history = req({'cmd': 'history'})['items']
        req({'cmd': 'color_profiles'})
        assert get() == native
        assert req({'cmd': 'history'})['items'] == history
        put(input_profile=input_icc[0])
        assert get()['params'] == before['params'] | {'input_profile': input_icc[0]}
        req({'cmd': 'set', 'op': 'colorin', 'field': 'working_profile', 'value': input_icc[0]}, ok=False)
        assert get()['params']['working_profile'] == before['params']['working_profile']
        put(working_profile=work_icc[0])
        assert get()['params'] == {'input_profile': input_icc[0], 'working_profile': work_icc[0]}
        for invalid in (-1, 1.5, 4294967552):
            req({'cmd': 'set', 'op': 'colorin', 'field': 'input_profile', 'value': invalid}, ok=False)
        put(input_profile=0, working_profile=0)
        assert get()['params'] == before['defaults']
        # Convert the fixture, then verify both profiles affect negadoctor's RGB input.
        for op in ('channelmixerrgb', 'exposure', 'toneequal', 'hazeremoval', 'agx', 'sigmoid', 'filmicrgb', 'basecurve'):
            req({'cmd': 'set', 'op': op, 'enabled': False, 'params': {}})
        req({'cmd': 'set', 'op': 'negadoctor', 'enabled': True, 'params': {}})
        baseline = pixels()
        put(input_profile=3)  # Adobe RGB type 2 + 1
        assert pixels() != baseline, 'input profile did not affect conversion'
        put(input_profile=0)
        assert pixels() == baseline, 'input default did not restore pixels'
        put(working_profile=4)  # linear Rec709 type 3 + 1
        assert pixels() != baseline, 'working profile did not affect conversion'
        put(working_profile=0)
        assert pixels() == baseline, 'working default did not restore pixels'
        put(input_profile=input_icc[0], working_profile=work_icc[0])
        saved = pixels()
        expected = get()['params']
        req({'cmd': 'save'})
        req({'cmd': 'close'})
        assert photo.with_suffix('.png.xmp').exists()
        req({'cmd': 'quit'})
        child.wait(timeout=15)
        poll.close(); log.close()
        # Copy the same named ICCs to another config location. IDs and sidecars
        # must survive changed installation paths just as darktable's lookup does.
        moved = p / 'moved-config'
        shutil.copytree(config / 'color', moved / 'color')
        child, poll, log, req = start(moved)
        req({'cmd': 'open', 'path': str(photo)})
        assert get()['params'] == expected
        assert pixels() == saved, 'sidecar reopened with different pixels'
        put(input_profile=3)
        put(input_profile=input_icc[0])
        assert pixels() == saved, 'ICC selection changed after moving config'
        req({'cmd': 'quit'})
        child.wait(timeout=15)
        poll.close(); log.close()
        child, poll, log, req = start(p / 'missing-profile-config')
        req({'cmd': 'open', 'path': str(photo)})
        assert get()['params'] == expected, 'missing ICC names were discarded'
        missing_menu = req({'cmd': 'color_profiles'})
        assert any(v == input_icc[0] for _, v in missing_menu['input'])
        assert any(v == work_icc[0] for _, v in missing_menu['working'])
        put(input_profile=input_icc[0], working_profile=4)
        assert get()['params'] == {'input_profile': input_icc[0], 'working_profile': 4}
        req({'cmd': 'set', 'op': 'colorin', 'field': 'working_profile', 'value': work_icc[0]}, ok=False)
        put(input_profile=0, working_profile=0)
        state = get()
        assert state['params'] == state['defaults']
        req({'cmd': 'quit'})
        child.wait(timeout=15)
        print('PASS: independent profiles, valid ICC enumeration, invalid/role rejection, unchanged enumeration, render changes, exact default restoration, sidecar/moved-ICC round trip and missing-ICC preservation')
    except BaseException:
        log.flush()
        print((p / 'engine.log').read_text()[-6000:])
        raise
    finally:
        poll.close(); log.close()
        if child.poll() is None:
            child.kill(); child.wait()
