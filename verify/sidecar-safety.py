#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Headless check that a failed save leaves the old XMP sidecar whole and says why.

darktable's writer empties a sidecar before writing the new one and does not
check the writes, so a full disk or a killed engine left an empty or cut XMP,
and a full disk was even reported as saved. The engine now writes a copy
beside it and renames it over the old one (engine/main.c, _write_xmp_whole).
With a photo saved once, each case makes another edit, fails its save, and
checks the old sidecar is byte for byte what it was, the reply names the file
and the reason, no copy is left behind, and the next save works:

  - the folder and the sidecar read-only
  - the disk full while the copy is made, and while darktable writes it
    (a file size limit on the engine: its library is in memory)
  - the engine killed while each of those files is half written

Also checks a normal save keeps XMP keys darktable does not know. Linux for
the full disk and kill cases (prlimit, LD_PRELOAD); the rest on any POSIX
system. Needs a C compiler and exiv2. No GUI is launched.

    python3 -I verify/sidecar-safety.py [--engine build/bin/darktable-engine]"""
import argparse
import os
from pathlib import Path
import resource
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
background = __import__('background-priority')
ROOT = background.ROOT
LINUX = sys.platform.startswith('linux')
FOREIGN = 'Xmp.xmpMM.DocumentID'

# holds the Nth fopen for writing of an .xmp path open for 60 s, once the
# file named by $HOLD_ARM exists (its text is N), touching $HOLD_ARM.hit
# first: the moment a write has emptied the file and not yet filled it
HOLD = r'''
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
static int seen;
static FILE *hold(FILE *f, const char *p, const char *m)
{
  const char *arm = getenv("HOLD_ARM");
  if(!f || !arm || m[0] != 'w' || !strstr(p, ".xmp")) return f;
  FILE *a = (fopen)(arm, "r");
  if(!a) { seen = 0; return f; }
  int nth = 0;
  if(fscanf(a, "%d", &nth) != 1) nth = 1;
  fclose(a);
  if(++seen != nth) return f;
  char hit[4096];
  snprintf(hit, sizeof hit, "%s.hit", arm);
  int fd = open(hit, O_CREAT | O_WRONLY, 0644);
  if(fd >= 0) close(fd);
  sleep(60);
  return f;
}
FILE *fopen(const char *p, const char *m)
{
  static FILE *(*real)(const char *, const char *);
  if(!real) real = (FILE *(*)(const char *, const char *))dlsym(RTLD_NEXT, "fopen");
  return hold(real(p, m), p, m);
}
FILE *fopen64(const char *p, const char *m)
{
  static FILE *(*real)(const char *, const char *);
  if(!real) real = (FILE *(*)(const char *, const char *))dlsym(RTLD_NEXT, "fopen64");
  return hold(real(p, m), p, m);
}
'''


def ask(engine, req, timeout=120):
    """A request whose reply may be an error: the reply either way."""
    engine.send(req)
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        reply = engine.pump(1)
        if reply is not None:
            return reply
    raise AssertionError(f'timeout: {req}')


class Run:
    def __init__(self, args, work):
        self.work = work
        self.failures = []
        self.photo = work / 'photos' / 'photo.tif'
        self.photo.parent.mkdir()
        self.photo.write_bytes(background.tiff(320, 240))
        self.xmp = self.photo.with_name(self.photo.name + '.xmp')
        self.tmp = self.xmp.with_name(self.xmp.name + '.immage-tmp')
        self.arm = work / 'hold-arm'
        # SIGXFSZ ignored, so a write past the size limit fails with EFBIG
        # rather than killing the engine; subprocess would restore it
        self.binary = work / 'engine.sh'
        self.binary.write_text(f"#!/bin/sh\ntrap '' XFSZ\nexec '{args.engine.resolve()}' \"$@\"\n")
        self.binary.chmod(0o755)
        self.preload = None
        if LINUX:
            src = work / 'hold.c'
            src.write_text(HOLD)
            self.preload = work / 'hold.so'
            subprocess.run(['cc', '-shared', '-fPIC', '-O1', '-o', str(self.preload), str(src), '-ldl'],
                           check=True)
        self.engine = None
        self.step = 0

    def start(self):
        env = os.environ.copy()
        if self.preload:
            os.environ['LD_PRELOAD'] = str(self.preload)
            os.environ['HOLD_ARM'] = str(self.arm)
        try:
            self.engine = background.Engine(self.binary, self.work)
        finally:
            os.environ.clear()
            os.environ.update(env)
        self.engine.call({'cmd': 'open', 'path': str(self.photo)})

    def edit(self, op='exposure', params=None):
        self.step += 1
        self.engine.call({'cmd': 'set', 'op': op, 'params': params or {'exposure': 0.1 * self.step},
                          'enabled': True})

    def fail(self, case, why):
        self.failures.append(f'{case}: {why}')
        print(f'FAIL {case}: {why}')

    def check_kept(self, case, old, reply=None):
        """The old sidecar is whole, the error says which file and why."""
        ok = True
        now = self.xmp.read_bytes() if self.xmp.exists() else None
        if now != old:
            self.fail(case, f'the old sidecar changed ({len(old)} -> {len(now) if now else "no"} bytes)')
            ok = False
        if reply is not None:
            if reply.get('ok'):
                self.fail(case, 'the save was reported done')
                ok = False
            elif self.xmp.name not in str(reply.get('error', '')):
                self.fail(case, f'the error does not name the sidecar: {reply}')
                ok = False
        return ok

    def check_recovers(self, case):
        """With the cause gone the next save works and leaves no copy."""
        before = self.xmp.read_bytes()
        reply = ask(self.engine, {'cmd': 'save'})
        if not reply.get('ok'):
            self.fail(case, f'the save after it failed too: {reply}')
        elif self.xmp.read_bytes() == before:
            self.fail(case, 'the save after it did not write the edit')
        if self.tmp.exists():
            self.fail(case, f'{self.tmp.name} was left behind')
        if FOREIGN not in subprocess.run(['exiv2', '-px', '-q', str(self.xmp)],
                                         capture_output=True, text=True).stdout:
            self.fail(case, f'{FOREIGN}, a key darktable does not know, was lost')

    def baseline(self):
        self.edit()
        self.engine.call({'cmd': 'save'})
        assert self.xmp.exists(), 'the first save wrote no sidecar'
        done = subprocess.run(['exiv2', '-M', f'set {FOREIGN} xmp.did:immage-check', str(self.xmp)],
                              capture_output=True, text=True)
        assert done.returncode == 0, done.stderr
        self.edit()
        self.check_recovers('a normal save')
        # nothing changed: darktable leaves the file alone
        stamp = self.xmp.stat().st_mtime_ns
        time.sleep(0.05)
        self.engine.call({'cmd': 'save'})
        if self.xmp.stat().st_mtime_ns != stamp:
            print('note: a save with nothing changed rewrote the sidecar')
        print('ok   a normal save')

    def read_only(self):
        case = 'read-only folder and sidecar'
        old = self.xmp.read_bytes()
        self.edit()
        self.xmp.chmod(0o444)
        self.photo.parent.chmod(0o555)
        try:
            reply = ask(self.engine, {'cmd': 'save'})
        finally:
            self.photo.parent.chmod(0o755)
            self.xmp.chmod(0o644)
        if self.check_kept(case, old, reply):
            print(f'ok   {case}: {reply["error"]}')
        self.check_recovers(case)

    def full_disk(self, case, limit_of):
        old = self.xmp.read_bytes()
        self.edit('sharpen', {'amount': 0.3 + 0.1 * self.step}) if 'writes' in case else self.edit()
        pid = self.engine.child.pid
        resource.prlimit(pid, resource.RLIMIT_FSIZE, (limit_of(len(old)), resource.RLIM_INFINITY))
        try:
            reply = ask(self.engine, {'cmd': 'save'})
        finally:
            resource.prlimit(pid, resource.RLIMIT_FSIZE, (resource.RLIM_INFINITY, resource.RLIM_INFINITY))
        if self.check_kept(case, old, reply):
            print(f'ok   {case}: {reply["error"]}')
        self.check_recovers(case)

    def killed(self, case, nth):
        old = self.xmp.read_bytes()
        self.edit()
        hit = Path(str(self.arm) + '.hit')
        hit.unlink(missing_ok=True)
        self.arm.write_text(str(nth))
        self.engine.send({'cmd': 'save'})
        end = time.monotonic() + 30
        while not hit.exists() and time.monotonic() < end:
            time.sleep(0.02)
        self.arm.unlink()
        if not hit.exists():
            self.fail(case, f'the save never opened a sidecar file for writing a {nth}. time')
        self.engine.child.kill()
        self.engine.child.wait()
        kept = self.check_kept(case, old)
        self.start()
        if kept:
            print(f'ok   {case}')
        # the new engine reads the old sidecar back, so one edit is enough
        self.edit()
        self.check_recovers(case)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, default=ROOT / 'build/bin/darktable-engine')
    args = parser.parse_args()
    if not shutil.which('exiv2'):
        sys.exit('needs the exiv2 command')
    if os.geteuid() == 0:
        sys.exit('run as an ordinary user: root writes into read-only folders')
    with tempfile.TemporaryDirectory(prefix='immage-sidecar-') as tmp:
        run = Run(args, Path(tmp))
        try:
            run.start()
            run.baseline()
            run.read_only()
            if LINUX:
                # the copy of the old sidecar runs out of room
                run.full_disk('disk full while copying', lambda old: old // 2)
                # the copy fits; darktable's longer sidecar does not
                run.full_disk('disk full while darktable writes', lambda old: old + 1)
                run.killed('killed while copying', 1)
                run.killed('killed while darktable writes', 2)
            else:
                print('skip full disk and kill cases: Linux only')
        finally:
            run.photo.parent.chmod(stat.S_IRWXU)
            if run.engine and run.engine.child.poll() is None:
                run.engine.close()
        if run.failures:
            sys.exit(f'{len(run.failures)} failure(s)')
        print('every failed save left the old sidecar whole')


if __name__ == '__main__':
    main()
