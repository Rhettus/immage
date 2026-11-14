#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Headless engine checks for 0.46.0, in a temporary folder, no GUI:

1. the app's start-up arguments (engine.rs spawn_once): `--models M
   --thumb-threads N --core --configdir C ...` honours C (the engine must not
   swallow --configdir after reading the count), also with a count past the
   range, and the `thumb_threads` command's 1..8 range.
2. history_discard (Photo > Discard History): clears a closed photo's edits
   and its sidecar's history, refuses an open photo, and a paste_batch
   snapshot taken around it undoes and redoes it.

    python3 -I verify/engine-0460.py [--engine build/bin/darktable-engine]"""
import argparse
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
failures = []


def check(cond, text):
    print(('PASS ' if cond else 'FAIL ') + text)
    if not cond:
        failures.append(text)


class Engine:
    def __init__(self, binary, work, pre):
        self.log = (work / 'engine.log').open('w')
        args = [str(binary), *pre, '--core', '--configdir', str(work / 'config'),
                '--cachedir', str(work / 'cache'), '--conf', 'opencl=false', '--conf', 'resourcelevel=0']
        self.child = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log,
                                      text=True, env=os.environ | {'XDG_DATA_HOME': str(work / 'data'),
                                                                   'OMP_NUM_THREADS': '2'})
        self.sel = selectors.DefaultSelector()
        self.sel.register(self.child.stdout, selectors.EVENT_READ)
        self.rid = 0

    def ask(self, **req):
        self.rid += 1
        self.child.stdin.write(json.dumps(req | {'rid': self.rid}) + '\n')
        self.child.stdin.flush()
        while True:
            if not self.sel.select(120):
                raise AssertionError(f'engine timeout: {req}')
            line = self.child.stdout.readline()
            if not line:
                raise AssertionError(f'engine exited on {req}')
            reply = json.loads(line)
            if reply.get('rid') == self.rid:
                return reply

    def quit(self):
        try:
            self.ask(cmd='quit')
            self.child.wait(30)
        except Exception:
            self.child.kill()
        self.log.close()


def configdir_case(binary, root, pre, label):
    work = root / label
    work.mkdir()
    e = Engine(binary, work, pre)
    try:
        check(e.ask(cmd='version').get('ok'), f'{label}: engine starts and answers')
    finally:
        e.quit()
    # darktable writes darktablerc and its databases into the configdir; with
    # --configdir swallowed they went to the default (~/.config/darktable)
    names = {p.name for p in (work / 'config').glob('*')} if (work / 'config').exists() else set()
    check('darktablerc' in names, f'{label}: configdir {work / "config"} holds darktablerc ({sorted(names)})')


def sidecar_has_history(xmp):
    return xmp.exists() and 'darktable:history' in xmp.read_text(errors='replace') and \
        'darktable:operation="exposure"' in xmp.read_text(errors='replace')


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--engine', type=Path, default=ROOT / 'build/bin/darktable-engine')
    binary = ap.parse_args().engine.resolve()
    with tempfile.TemporaryDirectory(prefix='immage-0460-') as tmp:
        root = Path(tmp)
        models = root / 'models'
        models.mkdir()
        configdir_case(binary, root, ['--models', str(models), '--thumb-threads', '3'], 'threads-3')
        configdir_case(binary, root, ['--thumb-threads', '3'], 'threads-no-models')
        configdir_case(binary, root, ['--thumb-threads', '99'], 'threads-clamped')

        work = root / 'history'
        work.mkdir()
        photo = work / 'photo.jpg'
        shutil.copy(ROOT / 'app/sample/stairs-to-mountain.jpg', photo)
        xmp = Path(str(photo) + '.xmp')
        e = Engine(binary, work, ['--thumb-threads', '2'])
        try:
            for n, ok in [(0, False), (1, True), (8, True), (9, False)]:
                r = e.ask(cmd='thumb_threads', threads=n)
                check(bool(r.get('ok')) == ok, f'thumb_threads {n} {"accepted" if ok else "refused"}: {r}')
            r = e.ask(cmd='open', path=str(photo))
            imgid = r['imgid']
            # edits count only once the open photo's auto-applied baseline ends (Session.endBaseline)
            e.ask(cmd='baseline_end')
            e.ask(cmd='set', op='exposure', enabled=True, params={'exposure': 0.8})
            r = e.ask(cmd='history_discard', imgid=imgid)
            check(not r.get('ok') and 'close the photo first' in r.get('error', ''), f'discard refuses an open photo: {r}')
            e.ask(cmd='save')
            e.ask(cmd='close')
            check(e.ask(cmd='meta', imgid=imgid)['image']['edited'] is True, 'the edit is saved and the photo is edited')
            check(sidecar_has_history(xmp), 'the sidecar holds the exposure step')

            token = e.ask(cmd='paste_batch', action='begin', token=0, imgids=[imgid])['token']
            r = e.ask(cmd='history_discard', imgid=imgid)
            check(r.get('ok') and r.get('edited') is False, f'discard reports the photo unedited: {r}')
            check(e.ask(cmd='meta', imgid=imgid)['image']['edited'] is False, 'meta agrees: unedited')
            check(not sidecar_has_history(xmp), 'the sidecar no longer holds the exposure step')
            check(e.ask(cmd='paste_batch', action='commit', token=token).get('ok'), 'the snapshot commits')
            r = e.ask(cmd='paste_batch', action='undo', token=token)
            check(r.get('ok'), f'undo of the discard: {r}')
            check(e.ask(cmd='meta', imgid=imgid)['image']['edited'] is True, 'undo brings the edit back')
            check(sidecar_has_history(xmp), 'undo restores the sidecar history')
            r = e.ask(cmd='paste_batch', action='redo', token=token)
            check(r.get('ok'), f'redo of the discard: {r}')
            check(e.ask(cmd='meta', imgid=imgid)['image']['edited'] is False, 'redo discards again')
            check(not sidecar_has_history(xmp), 'redo clears the sidecar history again')
            e.ask(cmd='paste_batch', action='release', token=token)
            r = e.ask(cmd='history_discard', imgid=999999)
            check(not r.get('ok'), f'discard of an unknown photo errors: {r}')
        finally:
            e.quit()
    print(f'{len(failures)} failure(s)')
    return 1 if failures else 0


sys.exit(main())
