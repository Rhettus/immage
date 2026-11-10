#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

# download the current lensfun database (what lensfun-update-data fetches) into
# DEST/version_1, to bundle in place of the package copy. lensfun 0.3.4 is from
# 2023, and the packages ship a database as old as that: cameras added since
# (the Sony ZV-1) have no profile in it. exits non-zero when the download fails
# or lacks a camera that must be there, so a build never ships a stale database
#
# usage: fetch_lensfun_db.py DEST
import io, json, os, shutil, sys, tarfile, time, urllib.request

BASES = ("https://lensfun.sourceforge.net/db/", "http://lensfun.sourceforge.net/db/")
VERSION = 1  # the database format lensfun 0.3.4 reads
# cameras that postdate the package copy; one missing means the snapshot is
# not the current one
REQUIRED = ("<model>ZV-1</model>",)

def get(url):
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read()

def fetch(dest):
    last = None
    for base in BASES:
        try:
            stamp = json.loads(get(base + "versions.json"))[0]
            data = get(f"{base}version_{VERSION}.tar.bz2")
            break
        except Exception as e:
            last = e
    else:
        sys.exit(f"cannot download the lensfun database: {last}")
    db = os.path.join(dest, f"version_{VERSION}")
    shutil.rmtree(dest, ignore_errors=True)
    os.makedirs(db)
    # the archive is flat: its files are the contents of version_N
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:bz2") as t:
        t.extractall(db, **({"filter": "data"} if hasattr(tarfile, "data_filter") else {}))
    with open(os.path.join(db, "timestamp.txt"), "w") as f:
        f.write(f"{stamp}\n")
    xml = "".join(open(os.path.join(db, f), encoding="utf-8").read()
                  for f in sorted(os.listdir(db)) if f.endswith(".xml"))
    missing = [m for m in REQUIRED if m not in xml]
    if missing:
        sys.exit(f"the downloaded lensfun database lacks {', '.join(missing)}")
    print(f"lensfun database {time.strftime('%Y-%m-%d', time.gmtime(stamp))} "
          f"(timestamp {stamp}) in {db}")

if len(sys.argv) != 2:
    sys.exit(__doc__.splitlines()[-1])
fetch(sys.argv[1])
