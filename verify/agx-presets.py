#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Headless AgX import checks against the built engine; only disposable files."""
import argparse
import base64
import json
import os
from pathlib import Path
import selectors
import sqlite3
import struct
import subprocess
import tempfile
import zlib

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--build', type=Path, default=Path('build'))
parser.add_argument('--engine', type=Path)
args = parser.parse_args()
build = args.build.resolve()
engine = (args.engine or build / 'bin/darktable-engine').resolve()
fields = list(json.loads(subprocess.check_output(['node', 'verify/mapped-fields.mjs'], text=True))['agx'])
with tempfile.TemporaryDirectory(prefix='immage-agx-') as tmp:
    p = Path(tmp)
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    photo = p / 'fixture.png'
    rows = b''.join(b'\0' + bytes(v for x in range(64) for v in (x * 4, y * 4, 80)) for y in range(64))
    photo.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 64, 64, 8, 2, 0, 0, 0))
                     + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))
    with (p / 'engine.log').open('w') as log:
        child = subprocess.Popen([str(engine), '--core', '--configdir', str(p / 'config'), '--cachedir', str(p / 'cache'),
            '--datadir', str(build / 'share/darktable'), '--moduledir', str(build / 'lib/darktable'),
            '--conf', 'opencl=false'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True,
            env=os.environ | {'OMP_NUM_THREADS': '2', 'XDG_DATA_HOME': str(p / 'data')})
        poll = selectors.DefaultSelector()
        poll.register(child.stdout, selectors.EVENT_READ)
        def req(data, ok=True):
            child.stdin.write(json.dumps(data) + '\n')
            child.stdin.flush()
            assert poll.select(45), 'Engine timed out'
            reply = json.loads(child.stdout.readline())
            assert reply.get('ok') == ok, reply
            return reply
        try:
            req({'cmd': 'open', 'path': str(photo)})
            state = req({'cmd': 'module_state', 'op': 'agx'})
            # Fetch the actual current module blob rather than copying its layout.
            params = req({'cmd': 'get', 'modules': {'agx': fields}})['modules']['agx']['params']
            # module_state returns before/after; use its unchanged current state.
            raw = base64.b64decode(state['now']['params'])
            db = p / 'presets.db'
            with sqlite3.connect(db) as conn:
                conn.execute('CREATE TABLE presets(name, op_version, op_params, operation, writeprotect)')
                conn.executemany('INSERT INTO presets VALUES(?,?,?,?,?)', [
                    ('My AgX', 8, raw, 'agx', 0), ('Builtin', 8, raw, 'agx', 1),
                    ('Other', 8, raw, 'exposure', 0), ('Future', 999, raw, 'agx', 0),
                    ('Truncated', 8, b'x', 'agx', 0), ('Old truncated', 7, b'x', 'agx', 0)])
            before = req({'cmd': 'module_state', 'op': 'agx'})['now']
            found = req({'cmd': 'agx_presets', 'db': str(db), 'fields': fields})['presets']
            good = [x for x in found if x['params'] is not None]
            assert good == [{'name': 'My AgX', 'params': params}], found
            preset = p / 'test.dtpreset'
            preset.write_text('<darktable_preset version="1.0"><preset><name>My &amp; AgX</name>'
                '<operation>agx</operation><op_version>8</op_version><op_params>' + raw.hex()
                + '</op_params></preset></darktable_preset>')
            imported = req({'cmd': 'agx_presets', 'file': str(preset), 'fields': fields})['presets']
            assert imported == [{'name': 'My & AgX', 'params': params}], imported
            preset.write_text('<wrong/>')
            req({'cmd': 'agx_presets', 'file': str(preset), 'fields': fields}, ok=False)
            assert req({'cmd': 'module_state', 'op': 'agx'})['now'] == before, 'Import changed photo'
            print('PASS: database filtering, file decoding, invalid versions/sizes/XML, photo unchanged')
        finally:
            child.terminate()
            child.wait(timeout=15)
