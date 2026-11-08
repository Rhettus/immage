#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Seed only a GUI run's isolated darktable data.db with AgX v8 presets."""
import sqlite3
import struct
import sys
from pathlib import Path

# AgX v8 layout from the pinned darktable src/iop/agx.c. Integer slots are
# enums/booleans; all others are floats. The distinctive brightness and slope
# also distinguish these profiles when the saved photo is reopened.
values = [0.08, 1.05, 0.65, 0.7, 0.6, -9, 7, 0.1, 0.5625, 0.18,
          2.8, 0, 0, 1.5, 3.3, 2.2, 0, 0, 1, 2, 0,
          0.29462451, 0.03540329, 0.25861925, -0.02108586,
          0.14641371, -0.06305724, 1, 0,
          0.2907764, 0.03540329, 0.2631554, -0.02108586,
          0.04581072, -0.06305724, 0, 0, 0.5]
integers = {16, 19, 20, 35, 36}
blob = b''.join(struct.pack('<i' if i in integers else '<f', v) for i, v in enumerate(values))
assert len(blob) == 152, len(blob)
path = Path(sys.argv[1])
path.parent.mkdir(parents=True, exist_ok=True)
with sqlite3.connect(path) as db:
    db.execute('CREATE TABLE presets(name TEXT, op_version INTEGER, op_params BLOB, operation TEXT, writeprotect INTEGER)')
    db.executemany('INSERT INTO presets VALUES(?,?,?,?,?)', [
        ('GUI|AgX test look', 8, blob, 'agx', 0),
        ('GUI|Hidden builtin', 8, blob, 'agx', 1),
        ('GUI|Other module', 8, blob, 'exposure', 0)])
print('Seeded AgX v8 test look and two excluded rows')
