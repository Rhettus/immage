#!/usr/bin/env python3
"""Deterministic, synthetic RGB TIFF fixtures; no photo libraries or GUI required."""
import argparse
import hashlib
import json
import os
import struct
from pathlib import Path
from xml.sax.saxutils import escape

# Markup that must stay text wherever the app shows a photo's name or metadata.
# The `hostile-text` case repeats these strings; keep the two in step.
HOSTILE = {
    "title": '<img src=x onerror=window.__pwned=1>',
    "description": '<script>window.__pwned=1</script>',
    "creator": '"><b>bold</b>',
    "rights": 'javascript:window.__pwned=1',
    "make": '<img src=x onerror=window.__pwned=1>',
    "model": '"><b>bold</b>',
    "keywords": ['<img src=x onerror=window.__pwned=1>', '<script>window.__pwned=1</script>',
                 '"><b>bold</b>', 'javascript:window.__pwned=1'],
}


def hostile_name():
    # Windows forbids < > " : in names; the other platforms take them.
    if os.name == "nt":
        return "img src=x onerror=window.__pwned=1.tif"
    return '"><img src=x onerror=window.__pwned=1>.tif'


def hostile_xmp():
    h = HOSTILE
    e = lambda v: escape(v, {'"': "&quot;"})
    alt = lambda tag, v: f'<dc:{tag}><rdf:Alt><rdf:li xml:lang="x-default">{e(v)}</rdf:li></rdf:Alt></dc:{tag}>'
    bag = "".join(f"<rdf:li>{e(k)}</rdf:li>" for k in h["keywords"])
    return ('<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>'
            '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
            '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">'
            + alt("title", h["title"]) + alt("description", h["description"]) + alt("rights", h["rights"])
            + f'<dc:creator><rdf:Seq><rdf:li>{e(h["creator"])}</rdf:li></rdf:Seq></dc:creator>'
            + f'<dc:subject><rdf:Bag>{bag}</rdf:Bag></dc:subject>'
            '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>')


def tiff(width, height, pattern, orientation=1, serial="", hostile=False):
    # Baseline little-endian TIFF, one uncompressed RGB strip, EXIF body serial.
    tags = [(256, 4, width), (257, 4, height), (258, 3, [8, 8, 8]),
            (259, 3, 1), (262, 3, 2), (271, 2, "Immage Test"),
            (272, 2, "Synthetic Camera"), (273, 4, 0), (274, 3, orientation),
            (277, 3, 3), (278, 4, height), (279, 4, width * height * 3), (284, 3, 1)]
    if serial:
        tags.append((34665, 4, 0))
    if hostile:
        h = HOSTILE
        tags = [t for t in tags if t[0] not in (271, 272)]
        tags += [(271, 2, h["make"]), (272, 2, h["model"]), (270, 2, h["description"]),
                 (315, 2, h["creator"]), (33432, 2, h["rights"]), (700, 1, hostile_xmp().encode())]
    tags.sort()
    extra = bytearray()
    base = 8 + 2 + 12 * len(tags) + 4
    entries = []
    for tag, kind, value in tags:
        if kind == 2:
            payload = value.encode() + b"\0"
            count = len(payload)
        elif kind == 1:
            payload = value
            count = len(payload)
        elif isinstance(value, list):
            count = len(value)
            payload = struct.pack("<" + "H" * count, *value)
        else:
            count = 1
            payload = struct.pack("<H" if kind == 3 else "<I", value)
        if len(payload) > 4:
            data = struct.pack("<I", base + len(extra))
            extra += payload
            if len(extra) % 2:
                extra += b"\0"
        else:
            data = payload.ljust(4, b"\0")
        entries.append([tag, kind, count, data])
    if serial:
        exif_offset = base + len(extra)
        payload = serial.encode() + b"\0"
        value = payload.ljust(4, b"\0") if len(payload) <= 4 else struct.pack("<I", exif_offset + 18)
        extra += struct.pack("<H", 1) + struct.pack("<HHI", 42033, 2, len(payload)) + value + struct.pack("<I", 0)
        if len(payload) > 4:
            extra += payload
        if len(extra) % 2:
            extra += b"\0"
        for e in entries:
            if e[0] == 34665:
                e[3] = struct.pack("<I", exif_offset)
    for e in entries:
        if e[0] == 273:
            e[3] = struct.pack("<I", base + len(extra))
    header = b"II" + struct.pack("<HIH", 42, 8, len(entries))
    header += b"".join(struct.pack("<HHI", tag, kind, count) + value for tag, kind, count, value in entries)
    header += struct.pack("<I", 0) + extra
    pixels = bytearray()
    for y in range(height):
        for x in range(width):
            if pattern == "endpoints":
                v = 0 if x < width // 2 else 255
                rgb = (v, v, v)
            elif pattern == "negative":
                rgb = (255 - x * 180 // width, 190 - y * 130 // height, 120 - (x + y) * 80 // (width + height))
            else:
                rgb = (x * 255 // width, y * 255 // height, 220 if (x // 16 + y // 16) % 2 else 25)
            pixels.extend(rgb)
    return header + pixels


def generate(destination):
    destination.mkdir(parents=True, exist_ok=True)
    definitions = {
        "landscape": (640, 480, "color", 1, "BODY-A"),
        "portrait": (640, 480, "color", 6, "BODY-A"),
        "endpoints": (640, 480, "endpoints", 1, ""),
        "negative": (640, 480, "negative", 1, ""),
        "camera-a": (640, 480, "color", 1, "BODY-A"),
        "camera-b": (640, 480, "color", 1, "BODY-B"),
        "camera-missing": (640, 480, "color", 1, ""),
        "hostile": (640, 480, "color", 1, "", True),
    }
    manifest = {}
    for name, spec in definitions.items():
        path = destination / (hostile_name() if name == "hostile" else name + ".tif")
        data = tiff(*spec)
        path.write_bytes(data)
        manifest[name] = {"file": path.name, "sha256": hashlib.sha256(data).hexdigest(),
                          "width": spec[0], "height": spec[1], "orientation": spec[3], "serial": spec[4]}
    (destination / "fixtures.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    print(json.dumps(generate(args.destination), indent=2))
