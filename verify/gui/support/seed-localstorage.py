#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Seed a WebKitGTK localStorage database inside a GUI run's own profile.

usage: python3 -I seed-localstorage.py DATABASE VALUES.json

VALUES.json is an object of string keys to string values. WebKit keeps them in
ItemTable, values as UTF-16LE blobs. The runner calls this before the first
launch, only for a path under its own run directory.
"""
import json
import os
import sqlite3
import sys

database, values_file = sys.argv[1:3]
with open(values_file, encoding="utf-8") as f:
    values = json.load(f)
if not isinstance(values, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in values.items()):
    sys.exit("values must be an object of strings")
os.makedirs(os.path.dirname(database), exist_ok=True)
db = sqlite3.connect(database)
db.execute("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB NOT NULL ON CONFLICT FAIL)")
for key, value in values.items():
    db.execute("INSERT INTO ItemTable (key, value) VALUES (?, ?)", (key, value.encode("utf-16-le")))
db.commit()
db.close()
