#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Headless check that hostile files and hostile requests cannot take the engine down.

Two parts, no GUI:

1. A corpus made at run time (nothing large is committed): a truncated raw
   (cut from benchmarking/corpus when one is there, else a truncated TIFF),
   zero-byte files, a JPEG renamed .ARW, random bytes under raw extensions,
   a truncated TIFF and JPEG, and photos beside XMP sidecars that are garbage,
   cut off, from a newer darktable (xmp_version and every module version
   raised), naming modules that do not exist, with bad parameter blobs, with
   a history_end far past the history, and with a huge mask (20000 brush
   points, plus masks that lie about their point count). Each is imported,
   given a thumbnail, its metadata read, opened, rendered and saved; every
   request must answer (an error is fine, so is a sane open with defaults)
   and the engine must still answer a follow-up request and open a good photo.
   A few requests naming an imgid that is not in the library follow, each
   sequence on a fresh engine.

2. A request fuzzer: for every command in `_commands[]` of engine/main.c,
   `--count` (default 20) requests with a fixed `--seed` (default 1): missing
   fields, wrong-typed fields, out-of-range numbers, odd strings, paths that
   do not exist, the command's own field names (read from its handler) and the
   engine's other field names. The commands run with no photo open and with
   one open. Plus malformed lines: not JSON, cut-off JSON, non-objects, a
   non-string `cmd`, NUL and invalid UTF-8 bytes, very long lines, very deep
   nesting. Each must be answered, or the violation reported, and the engine
   must stay up. `print` (real printing), `spektra_fetch` (network) and `quit`
   are not fuzzed. Sizes the engine would allocate (width, height, ...) stay
   small so a request cannot exhaust the machine; the engine runs under an
   address-space cap (--limit-gib).

A violation (crash, no reply within --timeout, a reply that is not JSON) is
a KNOWN BUG line when its key is in KNOWN below, which does not fail the run
(it fails under --strict); any other violation fails. Requests
naming a nonexistent imgid are checked explicitly (bad_imgid_cases, tagged
and in the main loop) and kept out of the fuzzer, whose tagged requests get a
real id.

This pairs with an AddressSanitizer build (cmake -DCMAKE_C_FLAGS=-fsanitize=address
and the same flag for the linker, pointing --engine at it): the checks here
find crashes and hangs; ASan turns silent memory errors on the same inputs
into crashes. Not built here.

    flock <lock> python3 -I verify/hostile-inputs.py [--engine build/bin/darktable-engine]
        [--count 20] [--seed 1] [--timeout 60] [--only corpus|fuzz] [--cmd open ...] [--strict]"""
import argparse
import base64
import json
import os
from pathlib import Path
import random
import re
import shutil
import struct
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
engine_session = __import__('engine_session')
Eng, EngineDied, Report = engine_session.Eng, engine_session.EngineDied, engine_session.Report
ROOT, tiff = engine_session.ROOT, engine_session.tiff

# violations seen on the current engine; an entry is a bug to fix, and the
# key is dropped here when it is
KNOWN = {
    'crash|xmp-bad-params-hex': 'a thumbnail of a photo whose sidecar has non-hex parameters crashes',
    # darktable's own bug, inherited: claims-huge.tif's failed full-size allocation
    # leaves its mipmap cache entry on the static dead image, and a later eviction
    # free()s it (mipmap_cache.c _mipmap_cache_deallocate_dynamic). It lands on
    # whichever case evicts that entry, xmp-nul-bytes in this corpus order.
    'crash|xmp-nul-bytes': 'a later thumbnail crashes after a photo claiming a huge size failed to load',
}

# not fuzzed: real printing, network, ends the session
SKIP_FUZZ = {'print', 'spektra_fetch', 'quit'}
# answered by nobody: the reader thread takes them and writes no reply
NO_REPLY = {'cancel_base', 'merge_cancel'}
TAGGED_FUZZ = {'thumb', 'export', 'import', 'hdr_merge', 'pano_merge', 'pano_preview'}


# ------------------------------------------------------------------ corpus

def raw_sample():
    corpus = ROOT / 'benchmarking/corpus'
    for pattern in ('*.ARW', '*.CR2', '*.RW2', '*.ORF', '*.dng'):
        found = sorted(corpus.glob(pattern)) if corpus.is_dir() else []
        if found:
            return found[0]
    return None


def make_images(folder):
    """{name: path} of damaged or mislabeled image files."""
    folder.mkdir(parents=True, exist_ok=True)
    rnd = random.Random(7)
    out = {}
    good = tiff(600, 400)

    def put(name, data):
        (folder / name).write_bytes(data)
        out[name] = folder / name

    raw = raw_sample()
    if raw:
        with raw.open('rb') as f:
            head = f.read(2 << 20)
        put('truncated-raw.' + raw.suffix.lstrip('.'), head[:300_000])
        put('header-only-raw.' + raw.suffix.lstrip('.'), head[:4096])
    else:
        put('truncated-raw.dng', good[:900])
    put('zero-byte.tif', b'')
    put('zero-byte.ARW', b'')
    put('zero-byte.jpg', b'')
    jpeg = ROOT / 'app/sample/stairs-to-mountain.jpg'
    if jpeg.is_file():
        data = jpeg.read_bytes()
        put('jpeg-renamed.ARW', data)
        put('jpeg-renamed.CR2', data[:200_000])
        put('truncated.jpg', data[:len(data) // 2])
        put('header-only.jpg', data[:20])
    put('truncated.tif', good[:1000])
    put('header-only.tif', good[:8])
    put('bad-ifd.tif', b'II*\0' + struct.pack('<I', 0xFFFFFFF0) + b'\0' * 64)
    # a TIFF claiming a gigantic frame with no data behind it
    huge = bytearray(tiff(8, 8))
    struct.pack_into('<I', huge, 8 + 2 + 8, 1_000_000)      # ImageWidth value
    struct.pack_into('<I', huge, 8 + 2 + 12 + 8, 1_000_000)  # ImageLength value
    put('claims-huge.tif', bytes(huge))
    for ext in ('NEF', 'dng', 'RW2', 'ORF', 'png', 'heic'):
        put(f'random-bytes.{ext}', bytes(rnd.getrandbits(8) for _ in range(20000)))
    put('text.tif', b'this is not an image\n' * 50)
    return out


def regex_all(text, pattern, repl):
    return re.sub(pattern, repl, text)


def make_sidecar_cases(eng, folder, report):
    """{name: photo path} of photos beside hostile sidecars, built from a real
    sidecar the engine writes (a global edit and a masked one)."""
    folder.mkdir(parents=True, exist_ok=True)
    base = folder / 'base.tif'
    base.write_bytes(tiff(600, 400))
    eng.ok({'cmd': 'open', 'path': str(base)})
    eng.ok({'cmd': 'set', 'op': 'exposure', 'enabled': True, 'params': {'exposure': 0.5}})
    pts = [[0.1 + 0.8 * (k % 200) / 200, 0.1 + 0.8 * (k // 200) / 100] for k in range(20000)]
    eng.ok({'cmd': 'mask', 'name': 'big', 'shapes': [{'type': 'brush', 'points': pts, 'size': 0.05}]}, 300)
    eng.ok({'cmd': 'set', 'op': 'exposure', 'enabled': True, 'params': {'exposure': 0.3},
            'mask': 'big', 'instance': 'local'}, 300)
    eng.ok({'cmd': 'save'})
    eng.ok({'cmd': 'close'})
    xmp = (folder / 'base.tif.xmp').read_text()
    assert 'mask_points' in xmp, 'the sidecar the cases start from carries no mask'
    rnd = random.Random(11)
    garbage = bytes(rnd.getrandbits(8) for _ in range(3000))
    mid = len(xmp) // 2
    b64 = lambda raw: base64.b64encode(raw).decode()
    cases = {
        'xmp-random-bytes': garbage,
        'xmp-garbage-in-middle': xmp[:mid].encode() + garbage[:300] + xmp[mid:].encode(),
        'xmp-truncated': xmp[:mid].encode(),
        'xmp-truncated-in-tag': xmp[:xmp.find('darktable:operation=') + 22].encode(),
        'xmp-empty': b'',
        'xmp-nul-bytes': b'\0' * 500,
        'xmp-invalid-utf8': xmp.replace('darktable:multi_name=""', 'darktable:multi_name="\udcff"').encode('utf-8', 'surrogateescape'),
        'xmp-newer-version': regex_all(regex_all(regex_all(xmp, r'darktable:modversion="\d+"', 'darktable:modversion="9999"'),
                                                 r'darktable:xmp_version="\d+"', 'darktable:xmp_version="999"'),
                                       r'darktable:iop_order_version="\d+"', 'darktable:iop_order_version="99"').encode(),
        'xmp-newer-blendop': regex_all(xmp, r'darktable:blendop_version="\d+"', 'darktable:blendop_version="999"').encode(),
        'xmp-unknown-modules': regex_all(xmp, r'darktable:operation="(?!exposure)\w+"', 'darktable:operation="nosuchmodule"').encode(),
        'xmp-unknown-exposure': xmp.replace('darktable:operation="exposure"', 'darktable:operation="unknown_future_module"').encode(),
        'xmp-bad-params-hex': regex_all(xmp, r'darktable:params="[0-9a-f]+"', 'darktable:params="zz-not-hex"').encode(),
        'xmp-short-params': regex_all(xmp, r'darktable:params="[0-9a-f]+"', 'darktable:params="00"').encode(),
        'xmp-bad-gz-params': regex_all(xmp, r'darktable:params="gz\d\d[^"]*"', 'darktable:params="gz48eJzjZ"').encode(),
        'xmp-huge-history-end': regex_all(xmp, r'darktable:history_end="\d+"', 'darktable:history_end="2147483647"').encode(),
        'xmp-negative-history-end': regex_all(xmp, r'darktable:history_end="\d+"', 'darktable:history_end="-5"').encode(),
        'xmp-bad-num': regex_all(xmp, r'darktable:num="\d+"', 'darktable:num="-1"').encode(),
        'xmp-huge-multi-priority': regex_all(xmp, r'darktable:multi_priority="\d+"', 'darktable:multi_priority="2147483647"').encode(),
        'xmp-huge-mask': xmp.encode(),
        'xmp-mask-count-lies': regex_all(xmp, r'darktable:mask_nb="\d+"', 'darktable:mask_nb="2147483647"').encode(),
        'xmp-mask-points-garbage': regex_all(xmp, r'darktable:mask_points="[^"]*"', f'darktable:mask_points="{b64(garbage[:400])}"').encode(),
        'xmp-mask-points-bad-gz': regex_all(xmp, r'darktable:mask_points="[^"]*"', 'darktable:mask_points="gz11eJxjZGBw"').encode(),
        'xmp-mask-bad-type': regex_all(xmp, r'darktable:mask_type="\d+"', 'darktable:mask_type="99999"').encode(),
        'xmp-mask-bad-version': regex_all(xmp, r'darktable:mask_version="\d+"', 'darktable:mask_version="9999"').encode(),
        'xmp-wrong-root': b'<?xml version="1.0"?><html><body>not xmp</body></html>',
        'xmp-xxe-ish': b'<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><x:xmpmeta xmlns:x="adobe:ns:meta/">&x;</x:xmpmeta>',
        'xmp-billion-laughs': (b'<?xml version="1.0"?><!DOCTYPE l [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">'
                               b'<!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;"><!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;">]><l>&d;</l>'),
    }
    photos = {}
    for name, data in cases.items():
        photo = folder / f'{name}.tif'
        photo.write_bytes(tiff(600, 400))
        (folder / f'{name}.tif.xmp').write_bytes(data)
        photos[name] = photo
    return photos


def exercise(eng, report, label, path, timeout):
    """Import, thumbnail, metadata, open, render, save and close one file;
    every request must be answered, and the engine must be up after."""
    steps = []
    try:
        def step(data, what, tag=False):
            t = timeout
            reply = eng.ask_tagged(data, t) if tag else eng.ask(data, t)
            if reply is None:
                report.bug(f'hang|{what}', f'{label}: {what} not answered in {t} s')
                return None
            steps.append(what)
            return reply

        imported = step({'cmd': 'import', 'files': [str(path)]}, 'import')
        imgids = [i['imgid'] for i in (imported or {}).get('images', [])] if imported and imported.get('ok') else []
        for imgid in imgids:
            step({'cmd': 'thumb', 'imgid': imgid, 'size': 128, 'out': str(path.parent / 'thumb.rgba')}, 'thumb')
            step({'cmd': 'meta', 'imgid': imgid}, 'meta')
            step({'cmd': 'sidecars', 'imgid': imgid}, 'sidecars')
        opened = step({'cmd': 'open', 'path': str(path)}, 'open')
        if opened and opened.get('ok'):
            w, h = opened.get('width') or 600, opened.get('height') or 400
            fit = min(200 / w, 130 / h) if w > 0 and h > 0 else 0.3
            r = step({'cmd': 'render', 'width': 200, 'height': 130, 'scale': fit, 'x': 0, 'y': 0,
                      'rgba': str(path.parent / 'frame.rgba')}, 'render')
            step({'cmd': 'history'}, 'history')
            step({'cmd': 'set', 'op': 'exposure', 'enabled': True, 'params': {'exposure': 0.2}}, 'set')
            step({'cmd': 'save'}, 'save')
            step({'cmd': 'close'}, 'close')
            outcome = 'opened' + ('' if r and r.get('ok') else f", render: {r.get('error') if r else 'none'}")
        else:
            outcome = 'refused: ' + str((opened or {}).get('error', 'no reply'))[:70]
        if not eng.responsive():
            report.bug('unresponsive|' + label, f'{label}: no answer to a follow-up request')
            return
        report.ok(f'{label}: {outcome} ({len(imgids)} imported)')
    except EngineDied as e:
        report.bug(f'crash|{label}', f'{label}: engine died after {steps[-1] if steps else "start"}\n{e}')
        raise


def bad_imgid_cases(args, work, report):
    """Requests naming an imgid that is not in the library, in sequences,
    each on a fresh engine with a photo open: every request must be answered
    and the engine must still answer afterwards."""
    bogus = 424242
    out = work / 'out'

    def thumb(tagged):
        return ('thumb' + (' (tagged)' if tagged else ''), tagged,
                {'cmd': 'thumb', 'imgid': bogus, 'size': 64, 'out': str(out / 'bogus.rgba')})
    meta = ('meta', False, {'cmd': 'meta', 'imgid': bogus})
    times = ('capture_times', False, {'cmd': 'capture_times', 'imgids': [bogus], 'offset': 1})
    export = ('export (tagged)', True, {'cmd': 'export', 'job': 7, 'imgid': bogus, 'out': str(out / 'bogus.jpg'),
                                         'format': 'jpeg'})
    # untagged, the main loop renders these itself: darktable's image cache
    # once left a missing id locked and the load waited on it for ever
    export_main = ('export', False, {'cmd': 'export', 'imgid': bogus, 'out': str(out / 'bogus-main.jpg'),
                                     'format': 'jpeg'})
    transient = ('export (transient)', False, {'cmd': 'export', 'imgid': bogus, 'out': 'immage-bogus', 'format': 'jpeg',
                                               'transient': True, 'quality': 85})
    page, box = {'width': 6.0, 'height': 4.0}, {'x': 0.5, 'y': 0.5, 'width': 5.0, 'height': 3.0}
    print_one = ('print', False, {'cmd': 'print', 'imgid': bogus, 'pdf': str(out / 'bogus.pdf'), 'page': page,
                                  'area': box})
    print_sheet = ('print (sheet)', False, {'cmd': 'print', 'pages': [[{'imgid': bogus, 'box': box}]],
                                            'pdf': str(out / 'bogus-sheet.pdf'), 'page': page})
    sequences = {
        'thumb': [thumb(False)], 'thumb-tagged': [thumb(True)], 'meta': [meta, meta], 'capture_times': [times],
        'export-tagged': [export], 'meta-thumb-meta': [meta, thumb(False), meta],
        'thumb-tagged-meta': [thumb(True), meta], 'thumb-twice': [thumb(False), thumb(False)],
        'export': [export_main, meta], 'export-transient': [transient, meta], 'print': [print_one, meta],
        'print-sheet': [print_sheet, meta],
    }
    for name, steps in sequences.items():
        engine_session.require_memory('restarting')
        eng = Eng(args.engine, work / f'eng-bogus-{name}', limit_gib=args.limit_gib)
        try:
            eng.ok({'cmd': 'import', 'files': [str(work / 'good.tif')]})
            eng.ok({'cmd': 'open', 'path': str(work / 'good.tif')})
            done = []
            for label, tagged, data in steps:
                if tagged and data['cmd'] in ('thumb', 'export'):
                    reply = eng.ask_tagged(data, 8)
                else:
                    reply = eng.ask(data, 8)
                done.append(label)
                if reply is None:
                    report.bug(f'bad-imgid-no-reply|{name}', f"{' then '.join(done)} with a nonexistent imgid: no reply in 8 s")
                    break
            else:
                report.ok(f"{' then '.join(done)} with a nonexistent imgid: answered")
            if not eng.responsive(10):
                report.bug(f'bad-imgid-wedge|{name}', f"engine stops answering everything after {' then '.join(done)} "
                                                      'with a nonexistent imgid')
        except EngineDied as e:
            report.bug(f'crash|bad-imgid-{name}', str(e))
        finally:
            eng.shutdown()


# ------------------------------------------------------------------ fuzzer

def table_commands():
    text = (ROOT / 'engine/main.c').read_text()
    block = text[text.index('static const eng_cmd_t _commands[]'):]
    block = block[:block.index('\n};')]
    cmds = re.findall(r'\{\s*"(\w+)",\s*(\w+),\s*([^}]*?)\s*\}', block)
    return {name: {'fn': fn, 'needs_open': '_CMD_NEEDS_OPEN' in flags} for name, fn, flags in cmds}


def handler_fields(commands):
    """Field names each command's handler reads in main.c, and every field
    name the engine's sources read anywhere."""
    text = (ROOT / 'engine/main.c').read_text()
    member = re.compile(r'json_(?:object|array)_(?:get|has|set)_\w+\(\s*\w+,\s*"(\w+)"')
    for name, c in commands.items():
        m = re.search(r'^(?:static\s+)?gboolean\s+' + c['fn'] + r'\([^)]*\)\s*\{(.*?)^\}', text, re.S | re.M)
        c['fields'] = sorted(set(member.findall(m.group(1))) - {'cmd', 'tag', 'rid'}) if m else []
    names = set()
    for src in list((ROOT / 'engine').glob('*.c')) + list((ROOT / 'engine').glob('*.cc')):
        names |= set(member.findall(src.read_text(errors='replace')))
    names -= {'cmd', 'tag', 'rid'}
    return sorted(names)


NUMBER_LIKE = re.compile(r'(?i)width|height|size|scale|zoom|count|budget|probe|dpi|limit|radius|points|'
                         r'amount|strength|quality|bpp|levels|steps|threads|^[xy]\d?$|rx|ry|cols|rows|pages')
PATH_LIKE = re.compile(r'(?i)path|dir|^out$|rgba|archive|files?$|dest|src|^in$|folder')
OPS = ['exposure', 'colorbalancergb', 'nosuchmodule', 'blend', 'rawprepare', 'flip', 'crop', 'ashift',
       'filmicrgb', 'agx', 'atrous', 'lens', 'colorout', '', 'highlights', 'temperature', 'exposure ']


class Values:
    def __init__(self, rng, work, ids):
        self.rng, self.work, self.ids = rng, work, ids

    def path(self):
        w = self.work
        return self.rng.choice([
            str(w / 'good.tif'), str(w / 'nonexistent.tif'), str(w / 'subdir'), str(w), str(w / 'out' / 'f.rgba'),
            str(w / 'out' / 'f.jpg'), str(w / 'out' / '%s%n%s.rgba'), str(w / 'out' / 'a b' / 'c'),
            str(w / 'good.tif.xmp'), str(w / 'zero.tif'), str(w / 'out' / ('x' * 200)), '', 'relative/path.tif',
            str(w / 'out'), str(w / 'garbage.tif')])

    def number(self, field):
        r = self.rng
        if NUMBER_LIKE.search(field):
            return r.choice([-1, 0, 1, 2, 3, 16, 100, 1024, 4096, -0.5, 0.0, 0.5, 1.0, 3.5, 100.5])
        return r.choice([0, 1, -1, 2, 255, 2**31 - 1, 2**31, -2**31, 2**53, 2**63 - 1, -2**63, 0.5, -0.0,
                         1e-300, 1e308, -1e308, 3.4e38, 1e15])

    def string(self, field):
        r = self.rng
        if PATH_LIKE.search(field):
            return self.path()
        if re.search(r'(?i)^(op|module|after|before)$', field):
            return r.choice(OPS)
        return r.choice(['', 'a', 'x' * 3000, '%s%n%s%x', '{"a":1}', 'é中\U0001f600', '\\u0000', 'null',
                         'add', 'sub', 'off', 'jpeg', 'tiff', 'png', 'srgb', '../../..', 'DROP TABLE images;--',
                         'ellipse', 'brush', 'gradient', 'path', 'a\nb', ' '])

    def any(self, field, depth=0):
        r = self.rng
        kind = r.choice(['int', 'float', 'str', 'bool', 'null', 'list', 'obj', 'id', 'id', 'str', 'int'])
        if kind == 'id':
            return r.choice(self.ids + [0, -1, 999999]) if re.search(r'(?i)id|imgid', field) or r.random() < 0.3 else self.number(field)
        if kind in ('int', 'float'):
            return self.number(field)
        if kind == 'str':
            return self.string(field)
        if kind == 'bool':
            return r.choice([True, False])
        if kind == 'null':
            return None
        if depth > 2:
            return []
        if kind == 'list':
            return [self.any(field, depth + 1) for _ in range(r.choice([0, 0, 1, 2, 3, 5]))]
        return {r.choice(['x', 'y', 'type', 'points', 'name', 'value', 'op', 'params']): self.any(field, depth + 1)
                for _ in range(r.choice([0, 1, 2, 3]))}

    def plausible(self, field):
        """A value of the kind the field usually holds."""
        r = self.rng
        if re.search(r'(?i)imgid$|^imgid|^id$', field):
            return r.choice(self.ids) if self.ids else 1
        if re.search(r'(?i)imgids$|ids$', field):
            return [r.choice(self.ids)] if self.ids else [1]
        if PATH_LIKE.search(field):
            return [self.path()] if field.endswith('s') else self.path()
        if re.search(r'(?i)^(on|enabled|invert|recursive|draft|proof|saved|reset|cache_trace)$', field):
            return r.choice([True, False])
        return self.any(field)


def make_request(rng, vals, cmd, own, pool, kind, ids):
    req = {'cmd': cmd}
    if kind == 0:
        pass
    elif kind == 1:  # plausible values for the command's own fields
        for f in own:
            if rng.random() < 0.8:
                req[f] = vals.plausible(f)
    elif kind == 2:  # own fields, wrong-typed or out-of-range
        for f in own:
            if rng.random() < 0.7:
                req[f] = vals.any(f)
    elif kind == 3:  # one field missing from an otherwise plausible request
        for f in own:
            req[f] = vals.plausible(f)
        if req and len(req) > 1:
            del req[rng.choice([k for k in req if k != 'cmd'])]
    elif kind == 4:  # the engine's other field names
        for f in rng.sample(pool, k=min(len(pool), rng.randint(1, 6))):
            req[f] = vals.any(f)
    else:  # a mix
        for f in own + rng.sample(pool, k=min(len(pool), rng.randint(0, 3))):
            if rng.random() < 0.6:
                req[f] = vals.any(f) if rng.random() < 0.6 else vals.plausible(f)
    return req


MALFORMED = [
    (b'not json at all\n', 'text'),
    (b'{\n', 'open brace'),
    (b'{"cmd":"open","path":\n', 'cut off value'),
    (b'{"cmd":"open"\n', 'cut off object'),
    (b'{"cmd":"version"}}}\n', 'trailing braces'),
    (b'[]\n', 'empty array'),
    (b'null\n', 'null'),
    (b'42\n', 'number'),
    (b'"version"\n', 'bare string'),
    (b'{}\n', 'empty object'),
    (b'{"cmd":null}\n', 'null cmd'),
    (b'{"cmd":5}\n', 'number cmd'),
    (b'{"cmd":["version"]}\n', 'array cmd'),
    (b'{"cmd":{"a":1}}\n', 'object cmd'),
    (b'{"cmd":true}\n', 'bool cmd'),
    (b'{"cmd":"vers\\u0000ion"}\n', 'NUL in cmd name'),
    (b'{"cmd":"version"}\x00\n', 'NUL after object'),
    (b'{"cmd":"\xff\xfe\xfd"}\n', 'invalid UTF-8 cmd'),
    (b'\xff\xfe\xfd\xfc\n', 'invalid UTF-8 line'),
    (b'{"cmd":"version"} garbage\n', 'garbage after object'),
    (b'\n', 'blank line'),
    (b'   \n', 'spaces'),
    (b'\r\n', 'CRLF only'),
    (b'{"cmd":"version"}\r\n', 'CRLF line'),
    (b'{"cmd":"version","rid":"x"}\n', 'string rid'),
    (b'{"cmd":"version","rid":1e400}\n', 'overflow rid'),
    (b'{"cmd":"version","rid":-5}\n', 'negative rid'),
    (b'{"cmd":"version","cache_trace":"yes"}\n', 'string cache_trace'),
    (b'{"cmd":"version","tag":"x"}\n', 'string tag on version'),
    (b'{"cmd":"thumb","tag":"x"}\n', 'tagged thumb, tag a string, no fields'),
    (b'{"cmd":"cancel_base","id":"x"}\n', 'cancel_base with a string id'),
    (b'{"cmd":"cancel_base"}\n', 'cancel_base alone'),
    (b'{"cmd":"merge_cancel","job":[]}\n', 'merge_cancel with an array job'),
    (b'{"cmd":"no_such_command","tag":1}\n', 'tagged unknown command'),
    (b'{"cmd":"import","tag":3,"files":"x"}\n', 'tagged import, files a string'),
    (b'{"cmd":"import","tag":4,"files":[1,null,{},[]]}\n', 'tagged import, odd files'),
    (b'{"cmd":"import","files":[1,null,{},[],true]}\n', 'import, odd files'),
    (b'{"cmd":"import","tag":5}\n', 'tagged import, no files'),
    (b'{"cmd":"export","tag":6}\n', 'tagged export, no fields'),
    (b'{"cmd":"hdr_merge","tag":7}\n', 'tagged hdr_merge, no fields'),
    (b'{"cmd":"export_release","tag":8}\n', 'tagged export_release'),
    (b'{"a":' + b'[' * 200 + b']' * 200 + b'}\n', 'nesting 200'),
    (b'{"cmd":"version","a":' + b'[' * 5000 + b']' * 5000 + b'}\n', 'nesting 5000'),
    (b'{"cmd":"version","a":"' + b'x' * (1 << 20) + b'"}\n', '1 MiB string value'),
    (b'x' * (1 << 20) + b'\n', '1 MiB of text'),
    (b'{"cmd":"version","tag":9,"a":"' + b'y' * (200_000) + b'"}\n', 'tagged version, 200 KB value'),
    (b'{"cmd":"version"}\n{"cmd":"version"}\n', 'two requests in one write'),
]


def run_malformed(eng, report, timeout):
    """Each line, then a request that must be answered: the replies counted
    in between are the line's own (one each; a tagged line may get none)."""
    for data, what in MALFORMED:
        label = f'malformed line: {what}'
        expect = 2 if what.startswith('two requests') else 1
        lax = any(w in data[:200].decode('latin-1') for w in ('"tag"', 'cancel_base', 'merge_cancel'))
        try:
            before = getattr(eng, 'stale', 0)
            eng.send_raw(data)
            reply = eng.ask({'cmd': 'version'}, timeout)
            got = getattr(eng, 'stale', 0) - before
            if reply is None:
                report.bug(f'unresponsive|malformed:{what}', f'{label}: no answer to the request after it')
                raise EngineDied('unresponsive')
            if (got != expect) and not (lax and got in (0, 1, expect)):
                report.bug(f'reply-count|malformed:{what}', f'{label}: {got} replies, expected {expect}')
            else:
                report.ok(label)
        except EngineDied as e:
            report.bug(f'crash|malformed:{what}', f'{label}: engine died\n{e}')
            raise


def fuzz_state(eng, work, want_open):
    """Put the session in the state a batch starts from: the good photo
    imported and (or not) open."""
    for _ in range(2):
        try:
            if want_open:
                r = eng.ask({'cmd': 'open', 'path': str(work / 'good.tif')}, 60)
                if r and r.get('ok'):
                    return
            else:
                eng.ask({'cmd': 'close'}, 30)
                return
        except EngineDied:
            raise
    return


def library_ids(eng, work):
    r = eng.ask({'cmd': 'import', 'files': [str(work / 'good.tif'), str(work / 'good2.tif')]}, 60)
    ids = [i['imgid'] for i in (r or {}).get('images', [])]
    return ids or [1]


def run_fuzz(args, work, binary, report, commands, pool):
    started = time.monotonic()
    eng = None
    names = [c for c in commands if c not in SKIP_FUZZ and (not args.cmd or c in args.cmd)]
    total = crashes = 0
    ids = [1, 2]

    def start():
        nonlocal eng, ids
        if eng is not None:
            eng.shutdown()
        engine_session.require_memory('fuzzing')
        eng = Eng(binary, work / f'fuzz-eng-{int(time.monotonic() * 1000)}', limit_gib=args.limit_gib)
        ids = library_ids(eng, work)

    start()
    try:
        for name in names:
            c = commands[name]
            rng = random.Random(f'{args.seed}:{name}')
            vals = Values(rng, work, ids)
            for i in range(args.count):
                want_open = i >= 2 or not c['needs_open']
                kind = i % 6
                tagged = name in TAGGED_FUZZ and i % 3 == 2
                try:
                    if i % 5 == 0 or i < 2:
                        fuzz_state(eng, work, want_open and i >= 2)
                    vals.ids = ids
                    req = make_request(rng, vals, name, c['fields'], pool, kind, ids)
                    if name in NO_REPLY:
                        eng.send_raw((json.dumps(req | {'rid': -1}) + '\n').encode())
                        total += 1
                        if not eng.responsive(15):
                            report.bug(f'unresponsive|{name}', f'{name}: engine wedged after {json.dumps(req)[:300]}')
                            start()
                        continue
                    if tagged:
                        # a real photo: a nonexistent id is its own known bug
                        for f in ('imgid',):
                            req[f] = rng.choice(ids)
                        if 'imgids' in req:
                            req['imgids'] = [rng.choice(ids)]
                        reply = eng.ask_tagged(req, args.timeout)
                    else:
                        reply = eng.ask(req, args.timeout)
                    total += 1
                    if reply is None:
                        report.bug(f'no-reply|{name}', f'{name}: no reply in {args.timeout} s to {json.dumps(req)[:300]}')
                        if not eng.responsive(15):
                            report.bug(f'unresponsive|{name}', f'{name}: engine wedged after {json.dumps(req)[:300]}')
                            start()
                    elif 'ok' not in reply:
                        report.bug(f'bad-reply|{name}', f'{name}: reply without "ok": {str(reply)[:120]} to {json.dumps(req)[:300]}')
                except EngineDied as e:
                    crashes += 1
                    report.bug(f'crash|{name}', f'{name}: engine died on {json.dumps(req)[:400]}\n{e}')
                    if crashes > 25:
                        report.fail('too many engine crashes; stopping the fuzzer')
                        return total
                    start()
                except AssertionError as e:
                    report.fail(f'{name}: driver error: {e}')
                    start()
            if eng.alive() and not eng.responsive(30):
                report.bug(f'unresponsive|{name}', f'{name}: engine did not answer after its batch')
                start()
            elif eng.alive():
                report.ok(f'{name}: {args.count} requests answered, engine up')
            if time.monotonic() - started > args.max_seconds:
                print(f'stopping the fuzzer after {args.max_seconds} s (--max-seconds)')
                break
        # malformed lines on a fresh session with a photo open
        fuzz_state(eng, work, True)
        try:
            run_malformed(eng, report, args.timeout)
        except EngineDied:
            start()
        report.ok('engine up at the end of the fuzzer') if eng.responsive() else report.bug('unresponsive|fuzz-end', 'engine down at the end')
    finally:
        if eng is not None:
            eng.shutdown()
    return total


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--engine', type=Path, default=ROOT / 'build/bin/darktable-engine')
    parser.add_argument('--count', type=int, default=20, help='fuzz requests per command')
    parser.add_argument('--seed', default='1')
    parser.add_argument('--timeout', type=float, default=60, help='seconds to wait for one reply')
    parser.add_argument('--max-seconds', type=float, default=1500, help='stop the fuzzer after this long')
    parser.add_argument('--only', choices=('corpus', 'fuzz'))
    parser.add_argument('--cmd', nargs='+', help='fuzz only these commands')
    parser.add_argument('--limit-gib', type=float, default=9, help='address-space cap on the engine')
    parser.add_argument('--strict', action='store_true', help='fail on known bugs too')
    parser.add_argument('--keep', action='store_true', help='keep the work folder and print it')
    args = parser.parse_args()
    if args.cmd and not args.only:
        args.only = 'fuzz'
    report = Report(KNOWN, args.strict)
    print(engine_session.require_memory('running'))

    commands = table_commands()
    pool = handler_fields(commands)
    assert len(commands) > 50 and len(pool) > 50, 'the command table or field names were not read from engine/main.c'
    tmp = tempfile.mkdtemp(prefix='immage-hostile-')
    work = Path(tmp)
    try:
        (work / 'out').mkdir()
        (work / 'subdir').mkdir()
        (work / 'good.tif').write_bytes(tiff(600, 400))
        (work / 'good2.tif').write_bytes(tiff(500, 300))
        (work / 'zero.tif').write_bytes(b'')
        (work / 'garbage.tif').write_bytes(os.urandom(2000))
        if args.only != 'fuzz':
            images = make_images(work / 'images')
            eng = Eng(args.engine, work / 'eng-corpus', limit_gib=args.limit_gib)
            eng.good, eng.out_dir = work / 'good.tif', work / 'out'
            try:
                sidecars = make_sidecar_cases(eng, work / 'sidecars', report)
                cases = [(n, p) for n, p in images.items()] + [(n, p) for n, p in sidecars.items()]
                for label, path in cases:
                    if not eng.alive():
                        eng.shutdown()
                        engine_session.require_memory('restarting')
                        eng = Eng(args.engine, work / f'eng-corpus-{label}', limit_gib=args.limit_gib)
                        eng.good, eng.out_dir = work / 'good.tif', work / 'out'
                    try:
                        exercise(eng, report, label, path, args.timeout)
                    except EngineDied:
                        eng.shutdown()
                        engine_session.require_memory('restarting')
                        eng = Eng(args.engine, work / f'eng-corpus-{label}-r', limit_gib=args.limit_gib)
                        eng.good, eng.out_dir = work / 'good.tif', work / 'out'
                # the engine still opens and renders a good photo after all of them
                r = eng.ask({'cmd': 'open', 'path': str(work / 'good.tif')}, args.timeout)
                if r and r.get('ok'):
                    report.ok('a good photo still opens after the corpus')
                else:
                    report.bug('unresponsive|after-corpus', f'good photo does not open afterwards: {r}')
            finally:
                eng.shutdown()
            bad_imgid_cases(args, work, report)
        if args.only != 'corpus':
            total = run_fuzz(args, work, args.engine, report, commands, pool)
            print(f'fuzzer: {total} requests over {len(commands) - len(SKIP_FUZZ)} commands, seed {args.seed}')
    finally:
        if args.keep:
            print(f'work folder kept: {work}')
        else:
            shutil.rmtree(tmp, ignore_errors=True)
    sys.exit(report.finish())


if __name__ == '__main__':
    main()
