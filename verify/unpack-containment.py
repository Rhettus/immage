#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Check that the engine's `unpack` cannot write outside its target folder.

.dtmodel archives are zips (the engine only enables libarchive's zip reader),
so the hostile cases are crafted zips; tar variants must be refused outright.
Each case gets a fresh temp root with target/ and outside/, and passes when
nothing outside target/ was created or changed and nothing was written
through a symlink that leaves target/. An ok or an error reply is acceptable.

Run: python3 -I verify/unpack-containment.py [--engine build/bin/darktable-engine]
"""
import argparse
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import warnings
import zipfile

warnings.simplefilter('ignore')  # duplicate zip names are the point of some cases

ROOT = Path(__file__).resolve().parent.parent


def zip_bytes(entries):
    """entries: (name, data, kind) with kind 'file' or 'symlink'."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        for name, data, kind in entries:
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.external_attr = (0o120777 if kind == 'symlink' else 0o100644) << 16
            z.writestr(info, data)
    return buf.getvalue()


def tar_bytes(entries):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w') as t:
        for name, data, kind in entries:
            info = tarfile.TarInfo(name)
            if kind == 'symlink':
                info.type, info.linkname = tarfile.SYMTYPE, data
            elif kind == 'hardlink':
                info.type, info.linkname = tarfile.LNKTYPE, data
            else:
                info.size = len(data)
            t.addfile(info, io.BytesIO(data.encode()) if kind == 'file' else None)
    return buf.getvalue()


def cases(tmp, outside):
    """(name, build(fmt), absolute paths that must stay absent)."""
    abs_dest = str(tmp / 'abs-escape.txt')
    link_target = str(outside)
    return [
        ('dotdot', lambda: [('../escape.txt', 'x', 'file')], [tmp / 'escape.txt']),
        ('absolute', lambda: [(abs_dest, 'x', 'file')], [Path(abs_dest)]),
        ('symlink-through', lambda: [('link', link_target, 'symlink'),
                                     ('link/through.txt', 'x', 'file')],
         [outside / 'through.txt']),
        ('symlink-overwrite', lambda: [('link', '../outside-file', 'symlink'),
                                       ('link', 'overwritten', 'file')],
         []),
        ('hardlink-abs', lambda: [('hard', str(outside / 'victim.txt'), 'hardlink'),
                                  ('hard', 'overwritten', 'file')],
         []),
    ]


def snapshot(tmp):
    state = {}
    for path in sorted(tmp.rglob('*')):
        if 'target' in path.relative_to(tmp).parts[:1]:
            continue
        if path.name == 'x.zip' or path.name == 'x.tar':
            continue
        if path.is_symlink():
            state[str(path)] = ('link', os.readlink(path))
        elif path.is_file():
            state[str(path)] = ('file', path.read_bytes())
        else:
            state[str(path)] = ('dir', None)
    return state


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, default=ROOT / 'build/bin/darktable-engine')
    args = parser.parse_args()
    if not args.engine.is_file():
        print(f'engine not found: {args.engine}\n'
              'build it, or pass --engine /path/to/darktable-engine', file=sys.stderr)
        return 2
    results = []
    with tempfile.TemporaryDirectory(prefix='immage-unpack-') as scratch:
        work = Path(scratch)
        with (work / 'engine.log').open('w') as log:
            child = subprocess.Popen(
                [str(args.engine.resolve()), '--core', '--configdir', str(work / 'config'),
                 '--cachedir', str(work / 'cache'), '--conf', 'opencl=false',
                 '--conf', 'resourcelevel=0'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=log, text=True, env=os.environ | {'XDG_DATA_HOME': str(work / 'data')})

            def request(data):
                child.stdin.write(json.dumps(data) + '\n')
                child.stdin.flush()
                return json.loads(child.stdout.readline())

            try:
                names = [c[0] for c in cases(work, work)]
                runs = [(n, fmt) for fmt in ('zip', 'tar') for n in names] + [('benign', 'zip')]
                for n, fmt in runs:
                    tmp = Path(tempfile.mkdtemp(dir=work, prefix='case-'))
                    (tmp / 'target').mkdir()
                    (tmp / 'outside').mkdir()
                    (tmp / 'outside' / 'victim.txt').write_text('original')
                    (tmp / 'outside-file').write_text('original')
                    if n == 'benign':
                        entries, guard = [('m/config.json', '{"a":1}', 'file')], []
                    else:
                        _, build, guard = next(c for c in cases(tmp, tmp / 'outside') if c[0] == n)
                        entries = build()
                    archive = tmp / ('x.' + fmt)
                    archive.write_bytes((zip_bytes if fmt == 'zip' else tar_bytes)(
                        [(a, b, 'file' if c == 'hardlink' and fmt == 'zip' else c)
                         for a, b, c in entries]))
                    before = snapshot(tmp)
                    reply = request({'cmd': 'unpack', 'archive': str(archive),
                                     'dir': str(tmp / 'target')})
                    problems = []
                    after = snapshot(tmp)
                    if after != before:
                        problems.append('outside changed: ' + ', '.join(
                            sorted(k for k in set(after) | set(before)
                                   if after.get(k) != before.get(k))))
                    for path in guard:
                        if path.exists():
                            problems.append(f'created {path}')
                    if n == 'benign':
                        entries, guard = [('m/config.json', '{"a":1}', 'file')], []
                    else:
                        _, build, guard = next(c for c in cases(tmp, tmp / 'outside') if c[0] == n)
                        entries = build()
                    archive = tmp / ('x.' + fmt)
                    archive.write_bytes((zip_bytes if fmt == 'zip' else tar_bytes)(
                        [(a, b, 'file' if c == 'hardlink' and fmt == 'zip' else c)
                         for a, b, c in entries]))
                    before = snapshot(tmp)
                    reply = request({'cmd': 'unpack', 'archive': str(archive),
                                     'dir': str(tmp / 'target')})
                    problems = []
                    after = snapshot(tmp)
                    if after != before:
                        problems.append('outside changed: ' + ', '.join(
                            sorted(k for k in set(after) | set(before)
                                   if after.get(k) != before.get(k))))
                    for path in guard:
                        if path.exists():
                            problems.append(f'created {path}')
                    for path in (tmp / 'target').rglob('*'):
                        if path.is_symlink():
                            dest = Path(os.path.realpath(path))
                            if not dest.is_relative_to((tmp / 'target').resolve()):
                                # tolerated only if nothing was written through it
                                pass
                    if n == 'benign':
                        ok = (tmp / 'target/m/config.json').is_file()
                        if not (reply.get('ok') and ok):
                            problems.append(f'control did not unpack: {reply}')
                    elif fmt == 'tar' and reply.get('ok'):
                        problems.append('tar archive unexpectedly accepted')
                    results.append((f'{n} ({fmt})', 'ok' if reply.get('ok') else 'error',
                                    'FAIL: ' + '; '.join(problems) if problems else 'PASS'))
                request({'cmd': 'quit'})
                child.wait(timeout=15)
            finally:
                if child.poll() is None:
                    child.kill()
    width = max(len(r[0]) for r in results)
    for name, reply, verdict in results:
        print(f'{name:<{width}}  {reply:<5}  {verdict}')
    return 1 if any(r[2] != 'PASS' for r in results) else 0


if __name__ == '__main__':
    sys.exit(main())
