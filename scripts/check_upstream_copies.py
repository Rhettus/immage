#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

"""Check that code copied from darktable is still current at the pinned revision.

Each Immage file below names, in its header comment, the darktable revision its
copied code matched. This compares that revision with the pinned darktable
(the submodule's HEAD, or --pin REV for a candidate) and reports upstream
changes to the copied files. Updating the header is the only bookkeeping.

    python3 -I scripts/check_upstream_copies.py [--pin REV]
"""

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DARKTABLE = ROOT / "darktable"

# (Immage file, upstream paths, regex whose group 1 is the recorded revision).
# \s+ lets the header's comment wrapping fall between words.
COPIES = [
    (
        "engine/upright.c",
        ["src/iop/ashift.c", "src/iop/ashift_lsd.c", "src/iop/ashift_nmsimplex.c"],
        r"copied\s+here\s+unchanged\s+from\s+src/iop/ashift\.c\s+at\s+([0-9a-f]{7,40})",
    ),
    (
        "engine/hdrmerge.c",
        ["src/control/jobs/control_jobs.c"],
        r"copied\s+here\s+from\s+src/control/jobs/control_jobs\.c\s+at\s+([0-9a-f]{7,40})",
    ),
]


def recorded_revision(text, pattern):
    """The revision a header names, or None; // comment markers are ignored."""
    flat = re.sub(r"^[ \t]*//", " ", text, flags=re.M)
    m = re.search(pattern, flat)
    return m.group(1) if m else None


def git(*args):
    return subprocess.run(
        ["git", "-C", str(DARKTABLE), *args], capture_output=True, text=True
    )


def resolve(rev):
    r = git("rev-parse", "--verify", "--quiet", rev + "^{commit}")
    return r.stdout.strip() if r.returncode == 0 else None


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--pin", metavar="REV", default="HEAD",
                    help="darktable revision to check against (default: the submodule's HEAD)")
    args = ap.parse_args(argv)

    target = resolve(args.pin)
    if not target:
        print(f"cannot resolve darktable {args.pin}: fetch more history "
              f"(git -C darktable fetch origin --tags)")
        return 1
    print(f"checking against darktable {target[:10]} ({args.pin})")

    bad = 0
    for path, upstream, pattern in COPIES:
        text = (ROOT / path).read_text(encoding="utf-8")
        rev = recorded_revision(text, pattern)
        if not rev:
            print(f"ERROR {path}: no recorded revision found in its header")
            bad += 1
            continue
        if not resolve(rev):
            print(f"ERROR {path}: recorded revision {rev} not found in darktable: "
                  f"fetch more history (git -C darktable fetch --unshallow)")
            bad += 1
            continue
        r = git("diff", "--stat", f"{rev}..{target}", "--", *upstream)
        if r.returncode != 0:
            print(f"ERROR {path}: git diff failed: {r.stderr.strip()}")
            bad += 1
        elif r.stdout.strip():
            print(f"CHANGED {path} (recorded {rev}; {', '.join(upstream)})")
            print(r.stdout.rstrip())
            print(f"  full diff: git -C darktable diff {rev}..{target} -- {' '.join(upstream)}")
            bad += 1
        else:
            print(f"OK {path} (recorded {rev}; {', '.join(upstream)})")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
