#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Headless checks for mask-owned engine instances. No GUI is launched."""
import argparse
import base64
import importlib.util
import json
import os
from pathlib import Path
import shutil
import selectors
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
failures = []


def check(ok, label):
    print(('PASS ' if ok else 'FAIL ') + label)
    if not ok:
        failures.append(label)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, default=ROOT / 'build/bin/darktable-engine')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='immage-mask-engine-') as td:
        root = Path(td)
        photo = root / 'photo.jpg'
        shutil.copyfile(ROOT / 'app/sample/stairs-to-mountain.jpg', photo)
        log = (root / 'engine.log').open('w')
        env = os.environ | {'XDG_DATA_HOME': str(root / 'data'), 'OMP_NUM_THREADS': '2'}
        proc = subprocess.Popen([str(args.engine), '--core', '--configdir', str(root / 'config'),
                                 '--cachedir', str(root / 'cache'), '--conf', 'opencl=false',
                                 '--conf', 'resourcelevel=0'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=log, text=True, env=env)
        sel = selectors.DefaultSelector()
        sel.register(proc.stdout, selectors.EVENT_READ)
        rid = 0

        def ask(cmd, **fields):
            nonlocal rid
            rid += 1
            proc.stdin.write(json.dumps({'cmd': cmd, 'rid': rid, **fields}) + '\n')
            proc.stdin.flush()
            while sel.select(120):
                line = proc.stdout.readline()
                if not line:
                    break
                reply = json.loads(line)
                if reply.get('rid') == rid:
                    return reply
            raise RuntimeError(f'no reply to {cmd} {fields}')

        try:
            check(ask('open', path=str(photo)).get('ok'), 'open copied sample JPEG')
            check(ask('mask', name='Sky', shapes=[{'type': 'ellipse', 'x': .5, 'y': .5,
                                                   'rx': .2, 'ry': .2}]).get('ok'), 'create mask')
            check(ask('set', op='exposure', instance='Sky', mask='Sky', enabled=True,
                      params={'exposure': .5}).get('ok'), 'create and set mask exposure')
            fields = {'exposure': ['exposure']}
            result = ask('masks', fields=fields)
            info = next(m for m in result.get('masks', []) if m['name'] == 'Sky')
            check(info['instances']['exposure']['extra'] is False, 'mapped exposure edit is not extra')
            state = info['instances']['exposure']['state']
            check(state['enabled'] is True and state['blend'] is None and
                  len(base64.b64decode(state['params'])) > len(json.dumps(info['instances']['exposure']['params'])),
                  'mask reply carries a full parameter snapshot without blend ownership')
            check(ask('set', op='exposure', instance='Sky', mask='Sky', enabled=True,
                      params={'compensate_exposure_bias': 1}).get('ok'), 'set non-local exposure field')
            result = ask('masks', fields=fields)
            info = next(m for m in result.get('masks', []) if m['name'] == 'Sky')
            check(info['instances']['exposure']['extra'] is True, 'non-local field is reported as extra')
            check(ask('set', op='sharpen', instance='Sky', mask='Sky', anchored=False,
                      enabled=True, params={}).get('ok'), 'add advanced-only module without anchoring')
            result = ask('masks', fields=fields)
            info = next(m for m in result.get('masks', []) if m['name'] == 'Sky')
            check(info['instances']['sharpen']['extra'] is True,
                  'module without local fields is always reported as extra')
            items = [i for i in ask('instances').get('instances', []) if i.get('mask') == 'Sky']
            sharpen = next(i for i in items if i['op'] == 'sharpen')
            anchor = next(i for i in ask('instances').get('instances', [])
                          if i['op'] == 'colorbalancergb' and i.get('mask') is None)
            check(sharpen['iop_order'] < anchor['iop_order'],
                  'anchored false keeps early module at its darktable position')
            check(ask('set', op='colorbalancergb', instance='Sky', mask='Sky', enabled=True,
                      params={'contrast': .35}).get('ok'), 'set mapped color balance field')
            result = ask('masks', fields={'colorbalancergb': ['contrast']})
            info = next(m for m in result.get('masks', []) if m['name'] == 'Sky')
            check(info['instances']['colorbalancergb']['extra'] is False,
                  'mapped color balance field alone is not extra')
            check(ask('set', op='colorbalancergb', instance='Sky', mask='Sky', enabled=True,
                      params={'shadows_weight': 2}).get('ok'), 'set unmapped color balance field')
            result = ask('masks', fields={'colorbalancergb': ['contrast']})
            info = next(m for m in result.get('masks', []) if m['name'] == 'Sky')
            check(info['instances']['colorbalancergb']['extra'] is True,
                  'unmapped color balance field makes the instance extra')
            cb = next(i for i in ask('instances').get('instances', [])
                      if i.get('mask') == 'Sky' and i['op'] == 'colorbalancergb')
            check(ask('instance', action='delete', op=cb['op'], priority=cb['priority'], mask='Sky').get('ok'),
                  'remove color balance from mask')
            check(ask('set', op='colorbalancergb', instance='Sky', mask='Sky', enabled=True,
                      params={'contrast': .2}).get('ok'), 're-add removed mask module')
            cb_again = next((i for i in ask('instances').get('instances', [])
                             if i.get('mask') == 'Sky' and i['op'] == 'colorbalancergb'), None)
            check(cb_again is not None and cb_again['priority'] == cb['priority'],
                  're-added module clears its deleted tombstone')
            if cb_again:
                result = ask('get', modules={f"colorbalancergb@{cb_again['priority']}": ['contrast', 'shadows_weight']})
                cb_params = next(iter(result.get('modules', {}).values()), {}).get('params', {})
                check(abs(cb_params.get('contrast', 99) - .2) < 1e-5 and
                      abs(cb_params.get('shadows_weight', 99) - 1) < 1e-5,
                      're-added module starts from image defaults')
            ask('set', op='colorbalancergb', instance='Sky', mask='Sky', enabled=True,
                params={'contrast': .35, 'shadows_weight': 2})
            sharp = next(i for i in ask('instances').get('instances', [])
                         if i.get('mask') == 'Sky' and i['op'] == 'sharpen')
            check(ask('instance', action='delete', op='sharpen', priority=sharp['priority'], mask='Sky').get('ok'),
                  'remove advanced-only module before mask rename')
            check(ask('mask_rename', name='Sky', to='Sky2').get('ok'), 'rename mask with deleted instance')
            check(ask('instance', action='restore', op='sharpen', priority=sharp['priority'], mask='Sky2').get('ok'),
                  'restore deleted module using renamed mask scope')
            check(ask('mask_rename', name='Sky2', to='Sky').get('ok'), 'rename mask back after scoped restore')
            ask('mask', name='Temp', shapes=[{'type': 'ellipse', 'x': .5, 'y': .5, 'rx': .1, 'ry': .1}])
            ask('set', op='sharpen', instance='Temp', mask='Temp', enabled=True, params={})
            temp = next(i for i in ask('instances').get('instances', [])
                        if i.get('mask') == 'Temp' and i['op'] == 'sharpen')
            check(ask('instance', action='delete', op='sharpen', priority=temp['priority'], mask='Temp').get('ok'),
                  'remove module before whole mask deletion')
            check(ask('mask_delete', name='Temp').get('ok'), 'delete mask with deleted-instance tombstone')
            check(not any(i.get('mask') == 'Temp' for i in ask('instances').get('instances', [])),
                  'whole mask deletion leaves no owned instance')
            check(not ask('instance', action='restore', op='sharpen', priority=temp['priority'],
                          mask='Temp').get('ok'), 'deleted mask cannot restore its detached instance')
            inst = next(i for i in ask('instances').get('instances', []) if i.get('mask') == 'Sky')
            check(ask('instance', action='delete', op=inst['op'], priority=inst['priority'],
                      mask='Sky').get('ok'), 'mask-scoped delete')
            check(not any(i.get('mask') == 'Sky' and i['op'] == inst['op'] and
                           i['priority'] == inst['priority'] for i in ask('instances').get('instances', [])),
                  'deleted instance leaves instances reply')
            check(ask('instance', action='restore', op=inst['op'], priority=inst['priority'],
                      mask='Sky').get('ok'), 'mask-scoped restore')
            check(any(i.get('mask') == 'Sky' and i['op'] == inst['op'] and
                      i['priority'] == inst['priority'] for i in ask('instances').get('instances', [])),
                  'restored instance returns to instances reply')
            refused = ask('instance', action='delete', op=inst['op'], priority=inst['priority'])
            check(not refused.get('ok'), 'mask instance delete without matching mask is refused')
            refused = ask('instance', action='delete', op=inst['op'], priority=inst['priority'], mask='Other')
            check(not refused.get('ok'), 'mask instance delete with a different mask is refused')
            refused = ask('instance', action='duplicate', op=inst['op'], priority=inst['priority'], mask='Sky')
            check(not refused.get('ok'), 'mask instance duplicate remains refused')
            check(ask('save').get('ok'), 'save mask edits to XMP')
            check((root / 'photo.jpg.xmp').exists(), 'saved sidecar exists')
            ask('close')
            opened = ask('open', path=str(photo))
            check(opened.get('ok'), 'reopen edited photo')
            result = ask('masks', fields={'exposure': ['exposure'], 'colorbalancergb': ['contrast']})
            info = next(m for m in result.get('masks', []) if m['name'] == 'Sky')
            check(info['instances']['colorbalancergb']['extra'] is True and
                  info['instances']['sharpen']['extra'] is True,
                  'reopened sidecar keeps advanced-only and unmapped edits')
            reopened = ask('instances').get('instances', [])
            check(any(i.get('mask') == 'Sky' and i['op'] == 'colorbalancergb' for i in reopened) and
                  any(i.get('mask') == 'Sky' and i['op'] == 'sharpen' for i in reopened),
                  'reopened sidecar keeps every mask-owned instance')
            cli = ROOT / 'build/bin/darktable-cli'
            compare = shutil.which('compare')
            if not cli.exists() or not compare:
                print('SKIP engine/darktable-cli image parity (darktable-cli or ImageMagick compare unavailable)')
            else:
                out_engine, out_cli = root / 'engine.png', root / 'cli.png'
                check(ask('export', imgid=opened['imgid'], out=str(out_engine), format='png', bpp=8,
                          color_space='srgb', long_edge=600,).get('ok'), 'export mask edits from engine')
                result = subprocess.run([str(cli), str(photo), str(photo) + '.xmp', str(out_cli),
                                         '--width', '600', '--height', '600', '--hq', 'true', '--core',
                                         '--configdir', str(root / 'cli-config'), '--cachedir', str(root / 'cli-cache'),
                                         '--library', ':memory:', '--conf', 'opencl=false',
                                         '--conf', 'plugins/lighttable/export/force_lcms2=false'],
                                        capture_output=True, text=True, timeout=600)
                check(out_cli.exists(), f'darktable-cli rendered saved mask XMP (status {result.returncode})')
                if out_engine.exists() and out_cli.exists():
                    diff = subprocess.run([compare, '-metric', 'MAE', str(out_engine), str(out_cli), 'null:'],
                                           capture_output=True, text=True)
                    import re
                    match = re.search(r'\(([0-9.e+-]+)\)', diff.stderr)
                    check(bool(match) and float(match.group(1)) < 0.5 / 255,
                          f'engine render matches darktable-cli ({diff.stderr.strip()})')
            ask('quit')
            proc.wait(timeout=30)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
            log.close()
    return 1 if failures else 0


if __name__ == '__main__':
    raise SystemExit(main())
