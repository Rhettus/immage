#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("sync_darktable_locales", Path(__file__).with_name("sync_darktable_locales.py"))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


class CatalogImportTest(unittest.TestCase):
    def messages(self, text):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fr.po"
            path.write_text(text)
            return sync.messages(path)

    def test_only_module_messages_and_approved_translations(self):
        result = self.messages('''#: ../src/iop/exposure.c:1
msgid "exposure"
msgstr "exposition"

#: ../src/views/lighttable.c:2
msgid "library"
msgstr "bibliothèque"

#: ../src/iop/exposure.c:3
#, fuzzy
msgid "draft"
msgstr "brouillon"
''')
        self.assertEqual(list(result.values()), [("exposure", "exposition")])

    def test_conflicting_contexts_are_not_guessed(self):
        result = self.messages('''#: ../src/iop/a.c:1
msgctxt "a"
msgid "range"
msgstr "plage"

#: ../src/iop/b.c:1
msgctxt "b"
msgid "range"
msgstr "portée"
''')
        self.assertEqual(result, {})

    def test_context_free_entry_and_multiline_messages(self):
        result = self.messages('''#: ../src/iop/a.c:1
msgid ""
"black "
"point"
msgstr "point noir"

#: ../src/iop/a.c:2
msgctxt "a"
msgid "black point"
msgstr "noir"
''')
        self.assertEqual(list(result.values()), [("black point", "point noir")])


if __name__ == "__main__":
    unittest.main()
