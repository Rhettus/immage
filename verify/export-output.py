#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Headless check of what an export writes: formats, bit depths, size, profile, snapshots.

Exports a generated TIFF (landscape, portrait, an EXIF-rotated copy, a panorama
strip) and the sample photo through the engine's `export` request, shaped as
app/src-tauri/src/export_cmds.rs sends it, and reads each file back with
ImageMagick (identify, magick), jxlinfo and a small ICC reader:

  - each format and bit depth the Export dialog offers (JPEG, PNG 8 and 16,
    TIFF 8 and 16, WebP, JPEG XL 8, 10, 12 and 16) opens, has the asked pixel
    size and depth, and carries the profile of the chosen color space
  - quality changes the file (JPEG, WebP, JPEG XL; JPEG XL 100 is lossless)
  - `long_edge` (the one resize the dialog has; AI upscaling needs a model and
    is not run here): fitted, never enlarged, portrait, rotated and extreme
    shapes
  - the fixed canvas (`frame.canvas`) is exactly width x height for each
    photo, with and without borders and with flip; a border adds exactly its
    pixels
  - an export asked for (`export_hold`, then tagged `export`s) renders the
    edit as it was then, for the open photo and for one opened afterwards, not
    later edits, and a photo that was not held is refused
  - a batch stopped part way (the app's cancel stops before the next photo),
    a failed export, a full disk and an export onto an existing file leave no
    stray or partial files

The conflict choice (overwrite, unique name, skip) and cancel live in the Rust
layer (`export_target`, `export_images`), which a headless run cannot reach;
`cargo test` covers what it can. A finding that is a real bug in the engine or
darktable is printed as KNOWN BUG and does not fail the run, unless --strict.
Needs ImageMagick (magick, identify); exiv2 and jxlinfo add checks, a missing
tool prints SKIP. No GUI is launched.

    python3 -I verify/export-output.py [--engine build/bin/darktable-engine] [--strict]"""
import argparse
from pathlib import Path
import re
import resource
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parent))
background = __import__('background-priority')
engine_session = __import__('engine_session')
ROOT = background.ROOT
SAMPLE = ROOT / 'app/sample/stairs-to-mountain.jpg'


class Report:
    def __init__(self, strict):
        self.strict = strict
        self.failures = []
        self.known = []
        self.checks = 0

    def check(self, ok, what, detail=''):
        self.checks += 1
        if not ok:
            self.failures.append(f'{what}: {detail}')
            print(f'FAIL {what}: {detail}')
        return ok

    def known_bug(self, ok, what, detail=''):
        self.checks += 1
        if ok:
            return True
        self.known.append(what)
        if self.strict:
            self.failures.append(f'{what}: {detail}')
        print(f'{"FAIL" if self.strict else "KNOWN BUG"} {what}: {detail}')
        return False

    def skip(self, what):
        print(f'SKIP {what}')


# ------------------------------------------------------------ reading files
def run(*cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def facts(path):
    """(width, height, bit depth) as ImageMagick reads the file, or None."""
    out = run('identify', '-format', '%w %h %z', f'{path}[0]')
    try:
        return tuple(int(v) for v in out.stdout.split())
    except ValueError:
        return None


def mean(path):
    out = run('magick', f'{path}[0]', '-colorspace', 'sRGB', '-format', '%[fx:mean*255]', 'info:')
    return float(out.stdout)


def icc_of(path):
    """The embedded ICC profile's bytes, or None."""
    d = Path(path).read_bytes()
    if d[:2] == b'\xff\xd8':
        parts, i = {}, 2
        while i < len(d) - 4 and d[i] == 0xff:
            marker, n = d[i + 1], struct.unpack('>H', d[i + 2:i + 4])[0]
            if marker == 0xe2 and d[i + 4:i + 16] == b'ICC_PROFILE\0':
                parts[d[i + 16]] = d[i + 18:i + 2 + n]
            if marker == 0xda:
                break
            i += 2 + n
        return b''.join(parts[k] for k in sorted(parts)) or None
    if d[:8] == b'\x89PNG\r\n\x1a\n':
        i = 8
        while i < len(d):
            n, = struct.unpack('>I', d[i:i + 4])
            if d[i + 4:i + 8] == b'iCCP':
                body = d[i + 8:i + 8 + n]
                return zlib.decompress(body[body.index(b'\0') + 2:])
            i += 12 + n
        return None
    if d[:4] == b'RIFF' and d[8:12] == b'WEBP':
        i = 12
        while i < len(d):
            n, = struct.unpack('<I', d[i + 4:i + 8])
            if d[i:i + 4] == b'ICCP':
                return d[i + 8:i + 8 + n]
            i += 8 + n + (n & 1)
        return None
    if d[:2] in (b'II', b'MM'):
        e = '<' if d[:2] == b'II' else '>'
        off, = struct.unpack(e + 'I', d[4:8])
        n, = struct.unpack(e + 'H', d[off:off + 2])
        for k in range(n):
            tag, _, cnt, val = struct.unpack(e + 'HHII', d[off + 2 + 12 * k:off + 14 + 12 * k])
            if tag == 34675:
                return d[val:val + cnt]
        return None
    # JPEG XL: let ImageMagick hand over the profile libjxl decoded
    out = subprocess.run(['magick', f'{path}[0]', 'icc:-'], capture_output=True)
    return out.stdout or None


def profile_name(blob):
    if not blob or len(blob) < 132:
        return None
    n, = struct.unpack('>I', blob[128:132])
    for k in range(n):
        sig, off, size = struct.unpack('>4sII', blob[132 + 12 * k:144 + 12 * k])
        if sig != b'desc':
            continue
        t = blob[off:off + size]
        if t[:4] == b'desc':
            ln, = struct.unpack('>I', t[8:12])
            return t[12:11 + ln].decode('latin1')
        if t[:4] == b'mluc':
            ln, at = struct.unpack('>II', t[20:28])
            return t[at:at + ln].decode('utf-16-be')
    return ''


# what each color space's profile is called
SPACE_NAME = {'srgb': 'srgb', 'adobergb': 'adobe', 'displayp3': 'p3', 'prophoto': 'prophoto'}
EXT = {'jpeg': 'jpg', 'png': 'png', 'tiff': 'tif', 'webp': 'webp', 'jxl': 'jxl'}


def expected_fit(w, h, edge):
    """The size a long-edge export is asked for: fitted, never enlarged."""
    if edge <= 0 or max(w, h) <= edge:
        return w, h
    s = edge / max(w, h)
    return max(1, int(w * s)), max(1, int(h * s))


class Run:
    def __init__(self, args, work, report):
        self.work = work
        self.r = report
        self.out = work / 'out'
        self.out.mkdir()
        self.n = 0
        self.photos = work / 'photos'
        self.photos.mkdir()
        # SIGXFSZ ignored, so a write past the size limit fails with EFBIG rather than killing the engine
        binary = work / 'engine.sh'
        binary.write_text(f"#!/bin/sh\ntrap '' XFSZ\nexec '{args.engine.resolve()}' \"$@\"\n")
        binary.chmod(0o755)
        print(engine_session.require_memory('starting the engine'))
        self.engine = background.Engine(binary, work)
        self.has_exiv2 = bool(shutil.which('exiv2'))
        self.has_jxlinfo = bool(shutil.which('jxlinfo'))

    def photo(self, name, data):
        p = self.photos / name
        p.write_bytes(data) if isinstance(data, bytes) else shutil.copy(data, p)
        return p

    def imgid(self, path):
        """The library id of a photo, from a folder read (which imports it)."""
        images = self.engine.call({'cmd': 'folder', 'path': str(path.parent)})['images']
        return next(i['imgid'] for i in images if i['path'] == str(path))

    def export(self, imgid, fmt, tag, expect_ok=True, **kw):
        """An untagged export as the dialog's request has it; the file's path."""
        self.n += 1
        out = self.out / f'{self.n:03d}-{tag}.{EXT[fmt]}'
        req = {'cmd': 'export', 'imgid': imgid, 'out': str(out), 'format': fmt, 'color_space': 'srgb'} | kw
        if expect_ok:
            self.engine.call(req)
        else:
            self.engine.send(req)
            while (reply := self.engine.pump(1)) is None:
                pass
            return reply
        return out

    def engine_ask(self, req):
        """A request whose reply may be an error: the reply either way."""
        self.engine.send(req)
        while (reply := self.engine.pump(1)) is None:
            pass
        return reply

    # ------------------------------------------------------- formats
    def formats(self, imgid, w, h, label, edge):
        """Every format at every depth: opens, asked size, depth."""
        exp = expected_fit(w, h, edge)
        cases = [('jpeg', {'quality': 90}, 8), ('webp', {'quality': 90}, 8)]
        cases += [('png', {'bpp': b}, b) for b in (8, 16)]
        cases += [('tiff', {'bpp': b}, b) for b in (8, 16)]
        cases += [('jxl', {'quality': 90, 'bpp': b}, b) for b in (8, 10, 12, 16)]
        for fmt, extra, depth in cases:
            name = f'{label} {fmt}{" " + str(extra["bpp"]) + "-bit" if "bpp" in extra else ""}'
            out = self.export(imgid, fmt, name.replace(' ', '-'), long_edge=edge, **extra)
            got = facts(out)
            if not self.r.check(got is not None, f'{name} opens', f'{out.name} unreadable'):
                continue
            self.r.check(got[:2] == exp, f'{name} size', f'asked {exp[0]}x{exp[1]}, file is {got[0]}x{got[1]}')
            # ImageMagick reports a TIFF or PNG by its sample size, JPEG XL by the bit depth it is told
            self.r.check(got[2] == depth, f'{name} depth', f'asked {depth}-bit, file is {got[2]}-bit')
            if fmt == 'jxl' and self.has_jxlinfo:
                info = run('jxlinfo', str(out)).stdout
                m = re.search(r'(\d+)-bit', info)
                self.r.check(m and int(m.group(1)) == depth, f'{name} jxlinfo depth', info.splitlines()[1:2])
        print(f'ok   formats on {label}: {len(cases)} files, {exp[0]}x{exp[1]}')

    def spaces(self, imgid):
        """The profile of each color space, in each format that embeds one."""
        missing = []
        for fmt, extra in (('jpeg', {'quality': 90}), ('png', {'bpp': 8}), ('tiff', {'bpp': 8}),
                           ('webp', {'quality': 90}), ('jxl', {'quality': 90, 'bpp': 8})):
            for space, word in SPACE_NAME.items():
                out = self.export(imgid, fmt, f'space-{space}', long_edge=96, color_space=space, **extra)
                name = profile_name(icc_of(out))
                # ProPhoto's JPEG XL profile is a generated name made of its primaries (0.7346 is its red x)
                if name and (word in name.lower() or (space == 'prophoto' and '0.734695' in name)):
                    continue
                if name:
                    self.r.check(False, f'{fmt} {space} profile', f'embeds "{name}"')
                elif space != 'srgb':
                    # an untagged sRGB is read as sRGB; untagged P3, Adobe RGB or ProPhoto is shown wrong
                    missing.append(f'{fmt}/{space}')
        self.r.check(not missing, 'a non-sRGB export carries its ICC profile',
                     'no embedded profile in ' + ', '.join(missing))
        print('ok   profiles checked for PNG and JPEG XL in all four spaces')

    def quality(self, imgid):
        """quality changes the file: lower is smaller; JPEG XL 100 is lossless."""
        for fmt in ('jpeg', 'webp', 'jxl'):
            sizes = {}
            for q in (30, 60, 95):
                out = self.export(imgid, fmt, f'q{q}', long_edge=640, quality=q, **({'bpp': 8} if fmt == 'jxl' else {}))
                sizes[q] = out.stat().st_size
            self.r.check(sizes[30] < sizes[60] < sizes[95], f'{fmt} quality',
                         f'30/60/95 gave {sizes[30]}/{sizes[60]}/{sizes[95]} bytes')
            print(f'ok   {fmt} quality 30/60/95: {sizes[30]}/{sizes[60]}/{sizes[95]} bytes')
        out = self.export(imgid, 'jxl', 'lossless', long_edge=320, quality=100, bpp=8)
        if self.has_jxlinfo:
            self.r.check('lossless' in run('jxlinfo', str(out)).stdout.lower(), 'jxl quality 100 is lossless')
        else:
            self.r.skip('jxl lossless (no jxlinfo)')

    # ------------------------------------------------------- resize
    def resize(self, shapes):
        """long_edge on each shape: fitted, never enlarged, whole when 0."""
        for label, imgid, w, h in shapes:
            # 16 is the smallest edge the dialog lets through (ExportDialog.tsx)
            for edge in (0, 16, 17, 150, max(w, h), max(w, h) + 100, 4000):
                exp = expected_fit(w, h, edge)
                self.n += 1
                out = self.out / f'{self.n:03d}-edge-{label}-{edge}.png'
                reply = self.engine_ask({'cmd': 'export', 'imgid': imgid, 'out': str(out), 'format': 'png',
                                         'color_space': 'srgb', 'long_edge': edge, 'bpp': 8})
                if not reply.get('ok'):
                    # a shape so thin that the short side floors to 0 px at this edge
                    self.r.known_bug(False, f'{label} {w}x{h} at long edge {edge} exports',
                                     f'asked {exp[0]}x{exp[1]}: {reply.get("error")}')
                    continue
                got = facts(out)
                # the longer side is the asked edge; the other follows the shape
                ok = got is not None and got[:2] == exp
                # darktable floors the scaled size, so an odd shape can land a pixel short of the edge
                off_by_one = not ok and got is not None and all(abs(a - b) <= 1 for a, b in zip(got[:2], exp))
                (self.r.known_bug if off_by_one else self.r.check)(
                    ok, f'{label} {w}x{h} at long edge {edge}', f'asked {exp[0]}x{exp[1]}, file is {got}')
        print(f'ok   long edge on {len(shapes)} shapes')

    # ------------------------------------------------------- frame
    def frames(self, shapes):
        """The canvas is exactly width x height; a pixel border adds its pixels."""
        white = {'borders': [], 'inner': [], 'texts': []}
        border = lambda px: {'top': px, 'left': px, 'right': px, 'bottom': px, 'unit': 'px', 'color': '#ff0000'}
        cases = []
        for label, imgid, w, h in shapes:
            for cw, ch in ((1638, 2048), (1080, 1080), (300, 200), (200, 300), (1000, 400), (97, 61)):
                for flip in (False, True):
                    cases.append((label, imgid, w, h, cw, ch, flip, []))
            for cw, ch in ((1638, 2048), (500, 500)):
                cases.append((label, imgid, w, h, cw, ch, False, [border(12)]))
        bad = 0
        for label, imgid, w, h, cw, ch, flip, borders in cases:
            frame = white | {'borders': borders, 'canvas': {'width': cw, 'height': ch, 'color': '#00ff00', 'flip': flip}}
            out = self.export(imgid, 'png', f'canvas-{label}-{cw}x{ch}', long_edge=max(cw, ch), frame=frame, bpp=8)
            got = facts(out)
            want = (ch, cw) if flip and (w > h) != (cw > ch) else (cw, ch)
            # a canvas many times the photo (a small photo is not scaled up) takes several framing instances
            if not self.r.check(got is not None and got[:2] == want,
                                f'canvas {cw}x{ch}{" flip" if flip else ""}{" +border" if borders else ""} on {label} {w}x{h}',
                                f'asked {want[0]}x{want[1]}, file is {got}'):
                bad += 1
        # three borders and a canvas are four framing instances, which darktable reorders
        # unless the style is written for it: each band has its color, outermost the canvas
        label, imgid, w, h = shapes[0]
        bands = [border(10) | {'color': '#ff0000'}, border(20) | {'color': '#0000ff'}, border(30) | {'color': '#ffff00'}]
        frame = white | {'borders': bands, 'canvas': {'width': 1000, 'height': 1000, 'color': '#00ff00', 'flip': False}}
        out = self.export(imgid, 'png', 'canvas-bands', long_edge=1000, frame=frame, bpp=8)
        got = facts(out)
        # the photo with its bands, centered at full size: the canvas is larger than all of it
        inner_w = w + 2 * (10 + 20 + 30)
        x0 = (1000 - inner_w) // 2
        y = 500
        probe = {'canvas': x0 - 5, 'yellow': x0 + 15, 'blue': x0 + 40, 'red': x0 + 55}
        seen = {k: run('magick', f'{out}[0]', '-format', f'%[pixel:p{{{x},{y}}}]', 'info:').stdout.strip()
                for k, x in probe.items()}
        named = {'canvas': ('srgb(0,255,0)', 'lime'), 'yellow': ('srgb(255,255,0)', 'yellow'),
                 'blue': ('srgb(0,0,255)', 'blue'), 'red': ('srgb(255,0,0)', 'red')}
        self.r.check(got is not None and got[:2] == (1000, 1000) and all(seen[k] in named[k] for k in probe),
                     'three borders and a canvas keep their order and size', f'file is {got}, colors {seen}')
        # the canvas color shows where the photo does not reach
        frame = white | {'canvas': {'width': 600, 'height': 600, 'color': '#00ff00', 'flip': False}}
        label, imgid, w, h = shapes[0]
        out = self.export(imgid, 'png', 'canvas-color', long_edge=600, frame=frame, bpp=8)
        corner = run('magick', f'{out}[0]', '-format', '%[pixel:p{1,1}]', 'info:').stdout.strip()
        self.r.check(corner in ('srgb(0,255,0)', 'lime', '#00FF00'), 'the canvas color fills the margin', corner)
        # a border of px pixels at full size adds exactly that
        label, imgid, w, h = shapes[0]
        for px in (1, 10, 33):
            out = self.export(imgid, 'png', f'border-{px}', frame=white | {'borders': [border(px)], 'canvas': None}, bpp=8)
            got = facts(out)
            self.r.check(got is not None and got[:2] == (w + 2 * px, h + 2 * px), f'a {px} px border on {w}x{h}',
                         f'file is {got}')
        print(f'ok   canvas sizes: {len(cases)} cases, {bad} off')

    # ------------------------------------------------------- snapshot
    def tagged(self, job, imgid, tag, fmt='png'):
        self.n += 1
        out = self.out / f'{self.n:03d}-{tag}.{EXT[fmt]}'
        t = self.engine.tagged_send({'cmd': 'export', 'job': job, 'imgid': imgid, 'out': str(out),
                                     'format': fmt, 'color_space': 'srgb', 'long_edge': 160, 'bpp': 8})
        return out, t

    def wait(self, tags):
        assert self.engine.wait_tags(tags, 120), 'a tagged export never answered'
        return [self.engine.tagged[t][1] for t in tags]

    def edit(self, exposure):
        self.engine.call({'cmd': 'set', 'op': 'exposure', 'params': {'exposure': exposure}, 'enabled': True})

    def snapshot(self, a, b):
        """Held photos render the edit asked for, not later edits."""
        e = self.engine
        e.call({'cmd': 'open', 'path': str(a)})
        id_a = self.imgid(a)
        id_b = self.imgid(b)
        e.call({'cmd': 'open', 'path': str(a)})
        self.edit(1.5)
        bright = self.export(id_a, 'png', 'ref-bright', long_edge=160, bpp=8)
        e.call({'cmd': 'save'})
        plain = self.export(id_b, 'png', 'ref-plain-b', long_edge=160, bpp=8)
        # asked for now: A is open with +1.5, B is not open
        e.call({'cmd': 'export_hold', 'job': 7001, 'imgids': [id_a, id_b]})
        self.edit(-2.5)
        dark = self.export(id_a, 'png', 'ref-dark', long_edge=160, bpp=8)
        out_a, t_a = self.tagged(7001, id_a, 'held-open')
        # B opens and is darkened after the request: the export still has the unedited B
        e.call({'cmd': 'open', 'path': str(b)})
        self.edit(-2.5)
        out_b, t_b = self.tagged(7001, id_b, 'held-opened-later')
        replies = self.wait([t_a, t_b])
        for reply in replies:
            self.r.check(reply.get('ok'), 'a held export is made', str(reply))
        m_bright, m_dark, m_a = mean(bright), mean(dark), mean(out_a)
        print(f'     open photo: edit asked for {m_bright:.1f}, later edit {m_dark:.1f}, exported {m_a:.1f}')
        self.r.check(m_bright - m_dark > 20, 'the two edits differ', f'{m_bright:.1f} vs {m_dark:.1f}')
        self.r.check(abs(m_a - m_bright) < 2 and abs(m_a - m_dark) > 15, 'the held open photo has the edit asked for',
                     f'exported {m_a:.1f}, asked-for {m_bright:.1f}, later {m_dark:.1f}')
        m_plain, m_b = mean(plain), mean(out_b)
        print(f'     photo opened later: plain {m_plain:.1f}, exported {m_b:.1f}')
        self.r.check(abs(m_b - m_plain) < 2, 'a photo edited after the request exports as it was', f'{m_b:.1f} vs {m_plain:.1f}')
        # without a hold the engine refuses, and a released job is gone
        out_c, t_c = self.tagged(7999, id_a, 'unheld')
        reply = self.wait([t_c])[0]
        self.r.check(not reply.get('ok') and not out_c.exists(), 'an export nobody asked for is refused',
                     f'{reply} exists={out_c.exists()}')
        e.call({'cmd': 'export_hold', 'job': 7002, 'imgids': [id_a]})
        self.wait([e.tagged_send({'cmd': 'export_release', 'job': 7002})])
        out_d, t_d = self.tagged(7002, id_a, 'released')
        reply = self.wait([t_d])[0]
        self.r.check(not reply.get('ok') and not out_d.exists(), 'a released job exports nothing', f'{reply}')
        # an untagged export, by contrast, is the edit now
        self.r.check(abs(mean(self.export(id_a, 'png', 'now', long_edge=160, bpp=8)) - m_dark) < 2,
                     'an untagged export is the edit now')
        # the later edit is not lost: B's sidecar still says -2.5 after the snapshot goes
        e.call({'cmd': 'save'})
        self.wait([e.tagged_send({'cmd': 'export_release', 'job': 7001})])
        print('ok   snapshots')
        return id_a, id_b

    # ------------------------------------------------------- stray files
    def stray(self, id_a, a):
        """A batch stopped part way, a failure and an overwrite leave nothing odd."""
        e = self.engine
        d = self.work / 'batch'
        # cancel: the app stops before the next photo, so the rest is never asked for
        e.call({'cmd': 'export_hold', 'job': 7100, 'imgids': [id_a]})
        names = []
        tags = []
        for k in range(3):
            out = d / f'cancel{k}.jpg'
            names.append(out.name)
            tags.append(e.tagged_send({'cmd': 'export', 'job': 7100, 'imgid': id_a, 'out': str(out),
                                       'format': 'jpeg', 'quality': 90, 'color_space': 'srgb', 'long_edge': 160}))
            if k == 0:
                self.wait(tags)
                break  # canceled here
        self.wait([e.tagged_send({'cmd': 'export_release', 'job': 7100})])
        left = sorted(p.name for p in d.iterdir())
        self.r.check(left == ['cancel0.jpg'], 'a canceled batch leaves only the finished file', str(left))
        self.r.check(facts(d / 'cancel0.jpg') is not None, 'the finished file opens')
        # a failure writes nothing and says why
        blocker = self.work / 'blocker'
        blocker.write_text('a file where the folder should be')
        e.send({'cmd': 'export', 'imgid': id_a, 'out': str(blocker / 'sub' / 'f.jpg'), 'format': 'jpeg',
                'color_space': 'srgb', 'long_edge': 100})
        while (reply := e.pump(1)) is None:
            pass
        self.r.check(not reply.get('ok') and reply.get('error'), 'an export that cannot be written fails with a reason', str(reply))
        self.r.check(blocker.read_text() == 'a file where the folder should be', 'the file in the way is untouched')
        e.send({'cmd': 'export', 'imgid': id_a, 'out': str(self.out / 'nope.jpg'), 'format': 'bmp-ish'})
        while (reply := e.pump(1)) is None:
            pass
        self.r.check(not reply.get('ok') and not (self.out / 'nope.jpg').exists(), 'an unknown format fails and writes nothing', str(reply))
        # a name already taken: the engine writes where it is told (the Rust layer picks the name)
        target = self.out / 'taken.jpg'
        target.write_bytes(b'not an image')
        before = sorted(p.name for p in self.out.iterdir())
        e.call({'cmd': 'export', 'imgid': id_a, 'out': str(target), 'format': 'jpeg', 'color_space': 'srgb',
                'long_edge': 100, 'quality': 80})
        after = sorted(p.name for p in self.out.iterdir())
        self.r.check(facts(target) is not None and before == after, 'an export onto an existing file replaces it, whole',
                     f'{facts(target)} {set(after) ^ set(before)}')
        print('ok   no stray files')

    def full_disk(self, id_a):
        """The disk fills while a large file is written (a file size limit on the engine)."""
        out = self.work / 'full' / 'big.tif'
        pid = self.engine.child.pid
        resource.prlimit(pid, resource.RLIMIT_FSIZE, (2 << 20, resource.RLIM_INFINITY))
        try:
            reply = self.engine_ask({'cmd': 'export', 'imgid': id_a, 'out': str(out), 'format': 'tiff', 'bpp': 16,
                                     'color_space': 'srgb'})
        finally:
            resource.prlimit(pid, resource.RLIMIT_FSIZE, (resource.RLIM_INFINITY, resource.RLIM_INFINITY))
        self.r.check(not reply.get('ok') and reply.get('error'), 'a full disk fails the export with a reason', str(reply))
        self.r.check(not out.exists(), 'a failed export leaves no partial file',
                     f'{out.name} is left at {out.stat().st_size if out.exists() else 0} bytes')
        self.r.check(not any(out.parent.glob('.immage-*')) if out.parent.exists() else True,
                     'a failed export leaves no temporary file', str(sorted(p.name for p in out.parent.iterdir())))
        # Overwrite onto a file that is there: a failed export keeps it as it was
        kept = out.parent / 'kept.tif'
        kept.parent.mkdir(parents=True, exist_ok=True)
        kept.write_bytes(b'the original file')
        resource.prlimit(pid, resource.RLIMIT_FSIZE, (2 << 20, resource.RLIM_INFINITY))
        try:
            reply = self.engine_ask({'cmd': 'export', 'imgid': id_a, 'out': str(kept), 'format': 'tiff', 'bpp': 16,
                                     'color_space': 'srgb'})
        finally:
            resource.prlimit(pid, resource.RLIMIT_FSIZE, (resource.RLIM_INFINITY, resource.RLIM_INFINITY))
        self.r.check(not reply.get('ok') and kept.read_bytes() == b'the original file',
                     'a failed export over a file leaves that file as it was', f'{reply} {kept.stat().st_size} bytes')
        again = self.export(id_a, 'tiff', 'after-full', long_edge=100, bpp=8)
        self.r.check(facts(again) is not None, 'the next export works')
        print('ok   full disk')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, default=ROOT / 'build/bin/darktable-engine')
    parser.add_argument('--strict', action='store_true', help='fail on KNOWN BUG findings too')
    args = parser.parse_args()
    for tool in ('magick', 'identify'):
        if not shutil.which(tool):
            sys.exit(f'needs ImageMagick ({tool})')
    report = Report(args.strict)
    with tempfile.TemporaryDirectory(prefix='immage-export-out-') as tmp:
        work = Path(tmp)
        run_ = Run(args, work, report)
        try:
            land = run_.photo('land.tif', background.tiff(320, 240))
            port = run_.photo('port.tif', background.tiff(200, 300))
            pano = run_.photo('pano.tif', background.tiff(1000, 50))
            odd = run_.photo('odd.tif', background.tiff(161, 121))
            tall = run_.photo('tall.tif', background.tiff(30, 400))
            turned = run_.photo('turned.tif', background.tiff(320, 240))
            if run_.has_exiv2:
                run(shutil.which('exiv2'), '-M', 'set Exif.Image.Orientation 6', str(turned))
            sample = run_.photo('sample.jpg', SAMPLE) if SAMPLE.exists() else None
            shapes = [('land', run_.imgid(land), 320, 240), ('port', run_.imgid(port), 200, 300),
                      ('pano', run_.imgid(pano), 1000, 50), ('tall', run_.imgid(tall), 30, 400),
                      ('odd', run_.imgid(odd), 161, 121)]
            run_.formats(shapes[0][1], 320, 240, 'land', 160)
            run_.formats(shapes[1][1], 200, 300, 'port', 0)
            run_.spaces(shapes[0][1])
            if sample:
                sid = run_.imgid(sample)
                run_.formats(sid, 5184, 2916, 'sample', 640)
                run_.quality(sid)
            else:
                report.skip('sample photo missing')
            run_.resize(shapes)
            if run_.has_exiv2:
                tid = run_.imgid(turned)
                got = facts(run_.export(tid, 'png', 'turned', long_edge=200, bpp=8))
                report.check(got and got[:2] == (150, 200), 'an EXIF-rotated photo exports upright', f'{got}')
            else:
                report.skip('EXIF rotation (no exiv2)')
            run_.frames(shapes[:3] + ([('sample', sid, 5184, 2916)] if sample else []))
            id_a, _ = run_.snapshot(land, port)
            run_.stray(id_a, land)
            if sample:
                run_.full_disk(sid)
        finally:
            if run_.engine.child.poll() is None:
                run_.engine.close()
    print(f'{report.checks} checks, {len(report.known)} known bug(s), {len(report.failures)} failure(s)')
    if report.failures:
        sys.exit('\n'.join(report.failures))
    print('every export had the format, size, depth and edit asked for')


if __name__ == '__main__':
    main()
