#!/usr/bin/env python3
# the screenshots the guide asks for: every image a page shows, with the
# note on what to capture, marked done once its file exists in images/
#   python3 -I app/docs/check_images.py
import glob
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
IMAGE = re.compile(r"!\[([^\]]*)\]\((images/[^)]+)\)\s*(?:<!-- screenshot: (.*?) -->)?")

missing = 0
for page in sorted(glob.glob(os.path.join(HERE, "*.md"))):
    with open(page) as f:
        text = f.read()
    for alt, path, note in IMAGE.findall(text):
        there = os.path.exists(os.path.join(HERE, path))
        missing += not there
        print(f"[{'x' if there else ' '}] {os.path.basename(page)}: {path}  {note or alt}")
print(f"\n{missing} screenshot(s) still to take")
