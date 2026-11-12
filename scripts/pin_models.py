#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Print, or write into ai_cmds.rs, the AI model table for the pinned darktable.

The app installs darktable's AI models only with the sha256 this table
holds for the running darktable version, so a moving release in
darktable's model repository cannot change what is installed. Run it
after moving the darktable pin (app/docs/dev/darktable-pin.md):

  python3 -I scripts/pin_models.py            # print the table
  python3 -I scripts/pin_models.py --write    # replace it in ai_cmds.rs

--darktable 5.8.0 picks a version other than the submodule's release.
--versions FILE --tag TAG reads a saved versions.json instead of the
network (the unit test does).
"""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
AI_RS = ROOT / 'app/src-tauri/src/ai_cmds.rs'
REPO = 'darktable-org/darktable-ai'
INDEX = f'https://raw.githubusercontent.com/{REPO}/HEAD/releases-index.json'
BEGIN = '// BEGIN scripts/pin_models.py'
END = '// END scripts/pin_models.py'


def fetch_json(url):
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.load(r)


def darktable_version():
    # "release-5.7.0-1793-g879067695e" -> "5.7.0", the version the engine
    # reports before its "+": the key in releases-index.json
    out = subprocess.run(['git', '-C', str(ROOT / 'darktable'), 'describe', '--tags',
                          '--match', 'release-*'], capture_output=True, text=True, check=True)
    m = re.match(r'release-(\d+\.\d+\.\d+)', out.stdout.strip())
    if not m:
        sys.exit(f'cannot read a darktable release from {out.stdout.strip()!r}')
    return m.group(1)


def table(darktable, tag, versions):
    lines = [BEGIN,
             'const MODEL_RELEASES: &[ModelRelease] = &[ModelRelease {',
             f'    darktable: "{darktable}",',
             f'    tag: "{tag}",',
             '    models: &[']
    for mid, m in sorted(versions['models'].items()):
        sha = m['sha256']
        if not sha.startswith('sha256:') or not re.fullmatch(r'[0-9a-f]{64}', sha[7:]):
            sys.exit(f'{mid}: not a sha256: {sha!r}')
        if not re.fullmatch(r'[A-Za-z0-9_-]+', mid):
            sys.exit(f'not a model id: {mid!r}')
        lines.append(f'        ModelPin {{ id: "{mid}", sha256: "{sha[7:]}", size: {int(m["size"])} }},')
    lines += ['    ],', '}];', END]
    return '\n'.join(lines) + '\n'


def write(text):
    src = AI_RS.read_text()
    start, stop = src.find(BEGIN), src.find(END)
    if start < 0 or stop < start:
        sys.exit(f'{AI_RS}: no {BEGIN} ... {END} block')
    AI_RS.write_text(src[:start] + text + src[stop + len(END) + 1:])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--darktable', help='darktable version, as 5.7.0')
    ap.add_argument('--tag', help='model release tag (default: from releases-index.json)')
    ap.add_argument('--versions', type=Path, help="a saved versions.json, with --tag")
    ap.add_argument('--write', action='store_true', help='replace the table in ai_cmds.rs')
    a = ap.parse_args()
    darktable = a.darktable or darktable_version()
    if a.versions:
        if not a.tag:
            sys.exit('--versions needs --tag')
        tag, versions = a.tag, json.loads(a.versions.read_text())
    else:
        tag = a.tag or fetch_json(INDEX)['compatible_releases'].get(darktable)
        if not tag:
            sys.exit(f'releases-index.json lists no model release for darktable {darktable}')
        versions = fetch_json(f'https://github.com/{REPO}/releases/download/{tag}/versions.json')
    text = table(darktable, tag, versions)
    if a.write:
        write(text)
        print(f'{AI_RS.relative_to(ROOT)}: darktable {darktable}, {tag}, {len(versions["models"])} models')
    else:
        sys.stdout.write(text)


if __name__ == '__main__':
    main()
