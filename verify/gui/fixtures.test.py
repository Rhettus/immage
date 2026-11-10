# SPDX-License-Identifier: GPL-3.0-or-later
import importlib.util
import struct
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("gui_fixtures", Path(__file__).with_name("fixtures.py"))
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)


def entries(data, offset=8):
    count = struct.unpack_from("<H", data, offset)[0]
    return {tag: (kind, n, value) for tag, kind, n, value in
            [struct.unpack_from("<HHII", data, offset + 2 + i * 12) for i in range(count)]}


class Fixtures(unittest.TestCase):
    def test_portrait_has_exif_orientation_and_valid_rgb_strip(self):
        data = fixtures.tiff(64, 48, "color", 6, "BODY-A")
        self.assertEqual(data[:4], b"II*\0")
        tags = entries(data)
        self.assertEqual(tags[274][2], 6)
        self.assertEqual(len(data) - tags[273][2], 64 * 48 * 3)
        exif = entries(data, tags[34665][2])
        kind, length, offset = exif[42033]
        self.assertEqual(kind, 2)
        self.assertEqual(data[offset:offset+length], b"BODY-A\0")

    def test_histogram_fixture_contains_only_both_endpoints(self):
        data = fixtures.tiff(64, 48, "endpoints")
        pixels = data[entries(data)[273][2]:]
        self.assertEqual(set(pixels), {0, 255})
        self.assertEqual(pixels.count(0), pixels.count(255))

    def test_generation_is_deterministic_and_camera_family_distinct(self):
        with tempfile.TemporaryDirectory(prefix="immage-gui-fixture-") as tmp:
            first = fixtures.generate(Path(tmp))
            self.assertEqual(first, fixtures.generate(Path(tmp)))
            self.assertNotEqual(first["camera-a"]["sha256"], first["camera-b"]["sha256"])
            self.assertEqual(first["camera-missing"]["serial"], "")
            self.assertEqual(first["portrait"]["orientation"], 6)

    def test_hostile_fixture_carries_markup_in_name_and_metadata(self):
        data = fixtures.tiff(64, 48, "color", 1, "", True)
        for text in [fixtures.HOSTILE["make"], fixtures.HOSTILE["model"], fixtures.HOSTILE["creator"],
                     fixtures.HOSTILE["description"], fixtures.HOSTILE["rights"]]:
            self.assertIn(text.encode() + b"\0", data)
        xmp = fixtures.hostile_xmp()
        self.assertIn("&lt;script&gt;", xmp)
        self.assertEqual(xmp.count("<rdf:li>"), len(fixtures.HOSTILE["keywords"]) + 1)
        for ch in '/\\':
            self.assertNotIn(ch, fixtures.hostile_name())


if __name__ == "__main__":
    unittest.main()
