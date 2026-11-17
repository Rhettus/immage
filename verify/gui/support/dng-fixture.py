#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Make a DNG with an unsupported main image and a usable TIFF preview."""
from pathlib import Path
import struct
import sys


def make(path: Path):
    data = bytearray(1024 + 256 * 128 * 3)
    data[:8] = struct.pack('<2sHI', b'II', 42, 8)

    def ifd(offset, entries):
        entries = sorted(entries)
        struct.pack_into('<H', data, offset, len(entries))
        for index, entry in enumerate(entries):
            struct.pack_into('<HHII', data, offset + 2 + index * 12, *entry)
        struct.pack_into('<I', data, offset + 2 + len(entries) * 12, 0)

    ifd(8, [(254, 4, 1, 1), (256, 4, 1, 256), (257, 4, 1, 128),
            (258, 3, 3, 256), (259, 3, 1, 1), (262, 3, 1, 2),
            (273, 4, 1, 1024), (274, 3, 1, 1), (277, 3, 1, 3),
            (278, 4, 1, 128), (279, 4, 1, 256 * 128 * 3), (284, 3, 1, 1),
            (330, 4, 1, 512), (50706, 1, 4, 0x701), (50707, 1, 4, 0x701)])
    struct.pack_into('<3H', data, 256, 8, 8, 8)
    # Unsupported JPEG XL main image. Its one-byte strip is intentionally not
    # decodable; the engine must use the embedded RGB TIFF preview above.
    ifd(512, [(254, 4, 1, 0), (256, 4, 1, 1024), (257, 4, 1, 512),
              (258, 3, 3, 262), (259, 3, 1, 52546), (262, 3, 1, 34892),
              (273, 4, 1, 1024), (277, 3, 1, 3), (278, 4, 1, 512),
              (279, 4, 1, 1), (284, 3, 1, 1)])
    struct.pack_into('<3H', data, 262, 16, 16, 16)
    colors = [bytes((255, 0, 0)), bytes((0, 255, 0)),
              bytes((0, 0, 255)), bytes((255, 255, 0))]
    for y in range(128):
        for x in range(256):
            at = 1024 + (y * 256 + x) * 3
            data[at:at + 3] = colors[(y >= 64) * 2 + (x >= 128)]
    path.write_bytes(data)


if __name__ == '__main__':
    make(Path(sys.argv[1]))
