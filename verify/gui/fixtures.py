#!/usr/bin/env python3
"""Deterministic, synthetic RGB TIFF fixtures; no photo libraries or GUI required."""
import argparse
import hashlib
import json
import struct
from pathlib import Path


def tiff(width, height, pattern, orientation=1, serial=""):
    # Baseline little-endian TIFF, one uncompressed RGB strip, EXIF body serial.
    tags = [(256, 4, width), (257, 4, height), (258, 3, [8, 8, 8]),
            (259, 3, 1), (262, 3, 2), (271, 2, "Immage Test"),
            (272, 2, "Synthetic Camera"), (273, 4, 0), (274, 3, orientation),
            (277, 3, 3), (278, 4, height), (279, 4, width * height * 3), (284, 3, 1)]
    if serial:
        tags.append((34665, 4, 0))
    tags.sort()
    extra = bytearray()
    base = 8 + 2 + 12 * len(tags) + 4
    entries = []
    for tag, kind, value in tags:
        if kind == 2:
            payload = value.encode() + b"\0"
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
    }
    manifest = {}
    for name, spec in definitions.items():
        path = destination / (name + ".tif")
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
