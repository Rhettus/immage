#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

# the screenshots the guide asks for: every image a page shows, with the
# note on what to capture, marked done once its file exists in images/
#   python3 -I app/docs/check_images.py
import glob
from html.parser import HTMLParser
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
IMAGE = re.compile(r"!\[([^\]]*)\]\((images/[^)]+)\)\s*(?:<!-- screenshot: (.*?) -->)?")

class ImageTags(HTMLParser):
    def __init__(self):
        super().__init__()
        self.images = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "img" and attrs.get("src", "").startswith("images/"):
            self.images.append((attrs.get("alt", ""), attrs["src"], ""))


missing = 0
for page in sorted(glob.glob(os.path.join(HERE, "*.md"))):
    with open(page) as f:
        text = f.read()
    tags = ImageTags()
    tags.feed(text)
    for alt, path, note in IMAGE.findall(text) + tags.images:
        there = os.path.exists(os.path.join(HERE, path))
        missing += not there
        print(f"[{'x' if there else ' '}] {os.path.basename(page)}: {path}  {note or alt}")
print(f"\n{missing} screenshot(s) still to take")
