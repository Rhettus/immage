#!/usr/bin/env python3
"""Regenerate app/src-tauri/data/camera_names.tsv from darktable's sources.

darktable shows a camera by the name rawspeed's cameras.xml gives it
(dt_rawspeed_lookup_makermodel in imageio_rawspeed.cc), and for Canon CR3 files
by the table in imageio_libraw.c. morfPhoto's ExifTool values are the raw EXIF
strings, so Immage maps them through the same table.

usage: gen_camera_names.py <darktable checkout> [output]
Each output line: exif make TAB exif model TAB name make TAB name model.
Only entries whose names change are written.
"""
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


def trim(s):
    return s.strip(" ")


def rawspeed(root):
    # rawspeed keeps cameras in a std::map ordered by (make, model, mode) and
    # getCamera(make, model) returns the first with that make and model; a camera
    # already present is not added again (aliases come right after their camera)
    cameras = {}
    for cam in ET.parse(root / "src/external/rawspeed/data/cameras.xml").getroot().iter("Camera"):
        make, model, mode = cam.get("make"), cam.get("model"), cam.get("mode", "")
        ident = cam.find("ID")
        cmake = ident.get("make") if ident is not None else make
        cmodel = ident.get("model") if ident is not None else model
        names = [(model, (cmake, cmodel))]
        aliases = cam.find("Aliases")
        if aliases is not None:
            names += [((a.text or ""), (cmake, cmodel)) for a in aliases.findall("Alias")]
        if (trim(make), trim(model), mode) in cameras:
            continue
        for name, canon in names:
            cameras.setdefault((trim(make), trim(name), mode), canon)
    first = {}
    for (make, model, _mode), canon in sorted(cameras.items()):
        first.setdefault((make, model), canon)
    return first


def libraw(root):
    text = (root / "src/imageio/imageio_libraw.c").read_text()
    out = {}
    for block in re.finditer(r"\{\s*\.exif_make = \"(.*?)\",\s*\.exif_model = \"(.*?)\",\s*\.clean_make = \"(.*?)\",\s*\.clean_model = \"(.*?)\"", text):
        out.setdefault((block[1], block[2]), (block[3], block[4]))
    return out


def main():
    root = Path(sys.argv[1])
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parent.parent / "app/src-tauri/data/camera_names.tsv"
    table = rawspeed(root)
    for key, value in libraw(root).items():
        table.setdefault(key, value)  # rawspeed is asked first
    lines = sorted(f"{m}\t{d}\t{cm}\t{cd}" for (m, d), (cm, cd) in table.items() if (m, d) != (cm, cd))
    out.write_text("\n".join(lines) + "\n")
    print(f"{len(lines)} names -> {out}")


main()
