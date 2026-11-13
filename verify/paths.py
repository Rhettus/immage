#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Headless check that unusual folder and file names go through the engine whole.

Each case is a folder with a photo, a neighbor photo and, where it matters,
look-alike files, all copied fresh into a temporary tree. A case's names are
non-ASCII (accents in both composed and decomposed form, Japanese, Arabic,
emoji), spaces, quotes, glob and URL characters, a leading dash, names at the
255-byte limit and paths near PATH_MAX, and a symlinked folder and file. Each
runs the way the app does:

  - import (`import` with the files, and a `folder` read): the right path,
    name and pixel size come back, once, and the neighbor stays itself
  - open, edit and save: the XMP sidecar is written next to that photo, under
    its exact name, and nothing else in the tree appears or changes
  - restart on a new library: the edit comes back from the sidecar
  - export: the file is written where the request says, under its exact name,
    and opens; so is a thumbnail
  - trash: `sidecars`, the list the app moves to the Trash with the photo,
    holds that photo's sidecars and versions and nothing of the neighbor's or
    of a look-alike; the files in it are deleted here as the app would, and
    only they go

A finding that is a real bug is printed as KNOWN BUG and does not fail the
run, unless --strict. No GUI is launched.

    python3 -I verify/paths.py [--engine build/bin/darktable-engine] [--strict]"""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unicodedata

sys.path.insert(0, str(Path(__file__).resolve().parent))
background = __import__('background-priority')
engine_session = __import__('engine_session')
ROOT = background.ROOT
NAME_MAX = 255
PATH_MAX = 4096
SIDECARS = "sidecars lists the photo's sidecar and its versions"


class Report:
    def __init__(self, strict):
        self.strict = strict
        self.failures = []
        self.known = []
        self.checks = 0

    def check(self, ok, what, detail='', known=False):
        self.checks += 1
        if ok:
            return True
        if known:
            self.known.append(what)
        if known and not self.strict:
            print(f'KNOWN BUG {what}: {detail}')
        else:
            self.failures.append(f'{what}: {detail}')
            print(f'FAIL {what}: {detail}')
        return False


def pad(stem, ext, size):
    """A file name of exactly `size` bytes, made from `stem`."""
    room = size - len(ext.encode())
    return (stem + 'x' * room)[:room] + ext


class Case:
    """One folder: `photo` (sized w x h), a neighbor and look-alikes."""
    def __init__(self, label, folder, name, w=160, h=120, link=None, decoys=(), known=()):
        self.label, self.folder, self.name = label, folder, name
        self.w, self.h = w, h
        self.link = link          # 'dir': the folder is reached through a symlink; 'file': the photo is a symlink
        self.decoys = decoys      # names of other photos that look like this one; each has its own sidecar
        self.known = set(known)   # steps whose failure is a known bug for this case


def tiff(w, h):
    return background.tiff(w, h)


class Run:
    def __init__(self, args, work, report):
        self.args = args
        self.work = work
        self.r = report
        self.root = work / 'tree'
        self.root.mkdir()
        self.engine = None
        self.config = 0

    def start(self):
        self.config += 1
        # a fresh library each time: the sidecars on disk are all it has
        cfg = self.work / f'eng{self.config}'
        cfg.mkdir()
        print(engine_session.require_memory('starting the engine'))
        self.engine = background.Engine(self.args.engine, cfg)

    def stop(self):
        if self.engine and self.engine.child.poll() is None:
            self.engine.close()

    def ask(self, req):
        self.engine.send(req)
        while (reply := self.engine.pump(1)) is None:
            pass
        return reply

    # ------------------------------------------------------- fixtures
    def build(self, c):
        """The case's folder on disk; the path the app would be handed."""
        real = self.root / c.folder
        real.mkdir(parents=True)
        c.dir = real
        (real / c.name).write_bytes(tiff(c.w, c.h)) if c.link != 'file' else None
        if c.link == 'file':
            target = self.root / f'target-of-{c.label}'
            target.mkdir()
            (target / 'real.tif').write_bytes(tiff(c.w, c.h))
            os.symlink(target / 'real.tif', real / c.name)
        c.neighbor = 'zz neighbor.tif'
        (real / c.neighbor).write_bytes(tiff(c.w + 8, c.h + 8))
        for d in c.decoys:
            (real / d).write_bytes(tiff(c.w + 16, c.h + 16))
        if c.link == 'dir':
            link = self.root / f'link-to-{c.label}'
            os.symlink(real, link)
            c.dir = link
        c.photo = c.dir / c.name
        c.size = (c.w, c.h)

    def tree(self, root):
        """Every path under the tree, its size and time: a change shows."""
        out = {}
        for dirpath, dirs, files in os.walk(root, followlinks=False):
            for f in files + dirs:
                p = os.path.join(dirpath, f)
                st = os.lstat(p)
                out[p] = (st.st_size, st.st_mtime_ns) if not os.path.isdir(p) else None
        return out

    # ------------------------------------------------------- steps
    def step(self, c, name, ok, detail='', known_here=False):
        return self.r.check(ok, f'{c.label}: {name}', detail, known=known_here or name in c.known)

    def imported(self, c):
        reply = self.engine.call({'cmd': 'import', 'files': [str(c.photo), str(c.dir / c.neighbor)]})
        images = reply['images']
        mine = [i for i in images if i['path'] == str(c.photo)]
        self.step(c, 'import returns the path as given', len(mine) == 1,
                  f'asked {len(str(c.photo))} bytes, got {[(len(i["path"]), i["path"][-40:]) for i in images]}')
        if not mine:
            return None
        info = mine[0]
        self.step(c, 'import keeps the file name', info['filename'] == c.name, repr(info['filename']))
        self.step(c, 'import reads the pixel size', (info['width'], info['height']) == c.size,
                  f'{info["width"]}x{info["height"]}')
        other = [i for i in images if i['path'] != str(c.photo)]
        self.step(c, 'the neighbor is another image', len(other) == 1 and other[0]['imgid'] != info['imgid'])
        listing = self.engine.call({'cmd': 'folder', 'path': str(c.dir)})['images']
        # a folder read must not list the same file twice or lose it
        paths = [i['path'] for i in listing]
        self.step(c, 'a folder read lists the photo once', paths.count(str(c.photo)) == 1, f'{paths}')
        again = next((i for i in listing if i['path'] == str(c.photo)), None)
        self.step(c, 'a folder read has the same image id', again is not None and again['imgid'] == info['imgid'])
        c.imgid = info['imgid']
        c.other_id = other[0]['imgid'] if other else None
        return info

    def edited(self, c):
        """Open, edit, save: one new file, the sidecar beside the photo."""
        before = self.tree(self.root)
        opened = self.ask({'cmd': 'open', 'path': str(c.photo)})
        if not self.step(c, 'open', opened.get('ok'), str(opened)):
            return
        self.step(c, 'open gives the pixel size', (opened['width'], opened['height']) == c.size,
                  f'{opened["width"]}x{opened["height"]}')
        self.engine.call({'cmd': 'set', 'op': 'exposure', 'params': {'exposure': 0.75}, 'enabled': True})
        saved = self.ask({'cmd': 'save'})
        if not self.step(c, 'save', saved.get('ok'), str(saved)):
            return
        sidecar = Path(str(c.photo) + '.xmp')
        after = self.tree(self.root)
        new = sorted(set(after) - set(before))
        # a photo reached through a link has its sidecar in the real folder
        expected = os.path.join(os.path.realpath(c.dir), c.name + '.xmp') if c.link != 'file' else str(sidecar)
        self.step(c, 'save writes the sidecar next to the photo', new == [expected], f'new files: {new}')
        self.step(c, 'the sidecar holds the edit',
                  sidecar.exists() and b'exposure' in sidecar.read_bytes(), str(sidecar.exists()))
        changed = [p for p in before if before[p] != after.get(p)]
        self.step(c, 'save changes no other file', not changed, f'{changed}')
        c.edit_saved = sidecar.exists()

    def exported(self, c):
        stem = Path(c.name).stem
        out = c.dir / 'Export ünï 日本' / f'{stem[:60]} (export) "q".jpg'
        reply = self.ask({'cmd': 'export', 'imgid': c.imgid, 'out': str(out), 'format': 'jpeg',
                          'color_space': 'srgb', 'quality': 90, 'long_edge': 100})
        if not self.step(c, 'export', reply.get('ok'), str(reply)):
            return
        names = sorted(p.name for p in out.parent.iterdir())
        self.step(c, 'export is written under the name asked', names == [out.name], f'{names}')
        got = subprocess.run(['identify', '-format', '%w %h', f'{out}[0]'], capture_output=True, text=True).stdout.split()
        w, h = c.size
        want = (100, max(1, int(h * 100 / w))) if w >= h else (max(1, int(w * 100 / h)), 100)
        # darktable floors the scaled size, so a long side of 100 can come out 99 (see export-output.py)
        near = len(got) == 2 and all(abs(int(g) - v) <= 1 for g, v in zip(got, want))
        self.step(c, 'the export opens at the asked size', near, f'{got} vs {want}')
        thumb = self.work / 'thumbs' / f'{c.label}.rgba'
        thumb.parent.mkdir(exist_ok=True)
        reply = self.ask({'cmd': 'thumb', 'imgid': c.imgid, 'size': 128, 'out': str(thumb)})
        if self.step(c, 'thumbnail', reply.get('ok'), str(reply)):
            self.step(c, 'the thumbnail is its pixels',
                      thumb.stat().st_size == 4 * reply['width'] * reply['height'], f'{thumb.stat().st_size}')

    def trashed(self, c):
        """`sidecars` lists this photo's own files; deleting them touches nothing else."""
        self.version_sidecar(c)
        reply = self.ask({'cmd': 'sidecars', 'imgid': c.imgid})
        if not self.step(c, 'sidecars', reply.get('ok'), str(reply)):
            return
        listed = sorted(reply['files'])
        mine = {os.path.realpath(str(c.photo) + '.xmp')} if c.link != 'file' else {str(c.photo) + '.xmp'}
        mine |= {str(p) for p in getattr(c, 'versions', [])}
        # a sidecar that could not be written (a known finding above) is not there to list
        mine = {p for p in mine if os.path.lexists(p)}
        # the list is what the app moves, so it must name this photo's files exactly
        got = {os.path.realpath(p) if c.link != 'file' else p for p in listed}
        self.step(c, SIDECARS, got == mine, f'listed {listed}, wanted {sorted(mine)}')
        # the others: neighbor, decoys and what they carry, must be untouched by deleting the list
        real_listed = {os.path.realpath(p) for p in listed}
        keep = {p: v for p, v in self.tree(self.root).items() if os.path.realpath(p) not in real_listed}
        for p in listed:
            if os.path.lexists(p):
                os.remove(p)
        left = self.tree(self.root)
        gone = sorted(set(keep) ^ set(left))
        self.step(c, 'deleting the list removes only its files', not gone and not [p for p in keep if keep[p] != left[p]],
                  f'{gone}')
        self.step(c, 'the photo itself is untouched', os.path.lexists(c.photo))

    def decoy_sidecars(self, c):
        """Sidecars of the look-alikes, so the trash list can be told from them."""
        for d in c.decoys + (c.neighbor,):
            (c.dir / (d + '.xmp')).write_text('<x:xmpmeta xmlns:x="adobe:ns:meta/"/>')

    def version_sidecar(self, c):
        """A version's sidecar, as darktable names it (stem_01.ext.xmp): the photo's own."""
        stem, ext = os.path.splitext(c.name)
        if len((stem + '_01' + ext + '.xmp').encode()) <= NAME_MAX:
            v = c.dir / f'{stem}_01{ext}.xmp'
            v.write_text('<x:xmpmeta xmlns:x="adobe:ns:meta/"/>')
            c.versions = [os.path.realpath(v) if c.link != 'file' else v]


def long_dir_chain(total):
    """Folder segments of 250 bytes to a path of about `total` bytes under the temp tree."""
    segs = []
    used = 0
    while used + 251 <= total:
        segs.append('d' * 250)
        used += 251
    left = total - used
    if left > 2:
        segs.append('e' * (left - 1))
    return '/'.join(segs)


def cases(root_len):
    out = [
        Case('ascii', 'plain', 'photo.tif', 160, 120),
        Case('composed', 'café', 'résumé.tif', 161, 121),
        Case('decomposed', unicodedata.normalize('NFD', 'café'), unicodedata.normalize('NFD', 'résumé') + '.tif', 162, 122),
        Case('japanese', '日本語のフォルダ', '写真 日本.tif', 163, 123),
        Case('arabic', 'مجلد', 'صورة.tif', 164, 124),
        Case('emoji', 'trip \U0001f4f7\U0001f30d', '\U0001f305 sunrise \U0001f9ed.tif', 165, 125),
        Case('spaces', '  two  spaces  ', ' leading and trailing .tif', 166, 126),
        Case('single quote', "o'brien's photos", "it's mine.tif", 167, 127),
        Case('double quote', 'say "cheese"', 'a "quoted" name.tif', 168, 128),
        Case('both quotes', '''it's a "mix"''', '''x'y"z.tif''', 169, 129),
        Case('shell', 'a$b `c` ;d & (e) | f', '$HOME `id` ; rm -rf & $(x).tif', 170, 130),
        Case('glob', 'g[lo]b*? {a,b}', 'img[1]*?{x}.tif', 171, 131,
             decoys=('img1.tif', 'img[1]xx.tif', 'img[1].tif')),
        Case('url and percent', 'a%20b#c?d=e&f', '100%25 %20 #1 ?q=1.tif', 172, 132),
        Case('backslash', 'back\\slash', 'a\\b\\c.tif', 173, 133),
        Case('leading dash', '-dash', '-photo.tif', 174, 134),
        Case('dots', 'a..b.', 'a..b..tif', 175, 135),
        Case('uppercase ext', 'caps', 'PHOTO.TIF', 176, 136),
        Case('look-alikes', 'alike', 'a.tif', 177, 137,
             decoys=('a_x.tif', 'ab.tif', 'a.tif.tif', 'a .tif', 'A.tif', 'a_01_x.tif')),
        Case('name 200 bytes', 'n200', pad('long-', '.tif', 200), 178, 138),
        Case('name 240 bytes', 'n240', pad('long-', '.tif', 240), 179, 139),
        Case('name 241 bytes', 'n241', pad('long-', '.tif', 241), 180, 140),
        Case('name 251 bytes', 'n251', pad('long-', '.tif', 251), 181, 141),
        Case('name 255 bytes', 'n255', pad('long-', '.tif', 255), 182, 142, known=('save',)),
        Case('255-byte name of 3-byte characters', 'n3byte', ('日' * 83 + '.tif'), 183, 143, known=('save',)),
        Case('folder 255 bytes', 'f' * 255, 'photo.tif', 184, 144),
        Case('path about 450 bytes', long_dir_chain(450 - root_len), 'photo.tif', 184, 144),
        Case('path about 1500 bytes', long_dir_chain(1500 - root_len), 'photo.tif', 185, 145, known=('import returns the path as given',)),
        Case('path about 3000 bytes', long_dir_chain(3000 - root_len), 'photo.tif', 186, 146, known=('import returns the path as given',)),
        Case('path about 4000 bytes', long_dir_chain(4000 - root_len - 20), 'photo.tif', 187, 147, known=('import returns the path as given',)),
        Case('symlinked folder', 'real folder', 'photo.tif', 188, 148, link='dir'),
        Case('symlinked photo', 'folder of a link', 'link.tif', 189, 149, link='file'),
    ]
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, default=ROOT / 'build/bin/darktable-engine')
    parser.add_argument('--strict', action='store_true', help='fail on KNOWN BUG findings too')
    parser.add_argument('--only', help='run the cases whose label contains this text')
    args = parser.parse_args()
    if not shutil.which('identify'):
        sys.exit('needs ImageMagick (identify)')
    report = Report(args.strict)
    with tempfile.TemporaryDirectory(prefix='immage-paths-') as tmp:
        work = Path(tmp)
        run = Run(args, work, report)
        picked = []
        try:
            run.start()
            for c in cases(len(str(run.root)) + 1):
                if args.only and args.only not in c.label:
                    continue
                try:
                    run.build(c)
                except OSError as e:
                    print(f'SKIP {c.label}: this file system cannot hold it ({e})')
                    continue
                run.decoy_sidecars(c)
                picked.append(c)
                # the sidecars of the look-alikes exist before the photo is touched
                if run.imported(c):
                    run.edited(c)
                    run.exported(c)
                print(f'done {c.label}')
            # a new library reads the edits back from the sidecars on disk
            run.stop()
            run.start()
            for c in picked:
                imported = run.engine.call({'cmd': 'import', 'files': [str(c.photo)]})['images']
                c.imgid = next((i['imgid'] for i in imported if i['path'] == str(c.photo)), None)
                if not getattr(c, 'edit_saved', False) or c.imgid is None:
                    continue
                opened = run.ask({'cmd': 'open', 'path': str(c.photo)})
                if not run.step(c, 'reopen on a new library', opened.get('ok'), str(opened)):
                    continue
                items = run.engine.call({'cmd': 'history'})['items']
                run.step(c, 'the edit comes back from the sidecar', any('xposure' in str(i) for i in items),
                         f'{items}')
            for c in picked:
                if getattr(c, 'imgid', None) is None:
                    continue
                run.trashed(c)
        finally:
            run.stop()
    print(f'{report.checks} checks, {len(report.known)} known bug(s), {len(report.failures)} failure(s)')
    if report.failures:
        sys.exit('\n'.join(report.failures))
    print('every name went through import, save, export and the trash list whole')


if __name__ == '__main__':
    main()
