#!/usr/bin/env python3
"""Copy Advanced-module messages from the pinned darktable PO catalogs.

Run after adding a language catalog or updating the darktable pin. Immage's
own UI messages are preserved. Runtime still reads one JSON file per language.
"""
# SPDX-License-Identifier: GPL-3.0-or-later
import argparse
import ast
import hashlib
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOGS = ROOT / "app/src/locales"
PREFIX = "darktable."
PO_CODES = {"pt-BR": "pt_BR", "zh-Hans": "zh_CN", "zh-Hant": "zh_TW", "nb": "nb"}


def entries(path, source=None):
    text = path.read_text(encoding="utf-8") if source is None else source
    for block in text.split("\n\n"):
        if re.search(r"^#,.*\bfuzzy\b", block, re.M):
            continue
        values = {}
        current = None
        refs = []
        plural = False
        for line in block.splitlines():
            if line.startswith("#: "):
                refs.extend(line[3:].split())
            elif line.startswith(("msgctxt ", "msgid ", "msgstr ")):
                current, value = line.split(" ", 1)
                values[current] = ast.literal_eval(value)
            elif line.startswith("msgid_plural "):
                plural = True
                current = None
            elif line.startswith("msgstr["):
                current = None
            elif line.startswith('"') and current:
                values[current] += ast.literal_eval(line)
        if not plural and values.get("msgid") and values.get("msgstr"):
            yield values, refs


def messages(path, source=None):
    # No context-free guessing when the same English message has competing
    # translations. Prefer the unqualified entry; otherwise require agreement.
    grouped = {}
    for value, refs in entries(path, source):
        if not any(re.search(r"(?:^|/)src/iop/", ref) for ref in refs):
            continue
        grouped.setdefault(value["msgid"], []).append(value)
    result = {}
    for text, candidates in grouped.items():
        unqualified = next((v for v in candidates if not v.get("msgctxt")), None)
        translations = {v["msgstr"] for v in candidates}
        if unqualified:
            translation = unqualified["msgstr"]
        elif len(translations) == 1:
            translation = next(iter(translations))
        else:
            continue
        slug = re.sub(r"[^a-z0-9]+", ".", text.lower()).strip(".")[:65]
        digest = hashlib.sha256(text.encode()).hexdigest()[:10]
        result[f"{PREFIX}{slug}.{digest}"] = (text, translation)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if imported messages are stale")
    parser.add_argument("--darktable-root", type=Path, default=ROOT / "darktable", help="checkout at the project darktable pin")
    args = parser.parse_args()
    if not (args.darktable_root / "po").is_dir():
        parser.error("darktable PO catalogs unavailable; initialize the pinned submodule or supply --darktable-root")
    catalogs = {p.stem: json.loads(p.read_text()) for p in sorted(CATALOGS.glob("*.json"))}
    originals = {code: dict(values) for code, values in catalogs.items()}
    pin = subprocess.check_output(["git", "-C", str(ROOT), "ls-tree", "HEAD", "darktable"], text=True).split()[2]
    upstream_head = subprocess.check_output(["git", "-C", str(args.darktable_root), "rev-parse", "HEAD"], text=True).strip()
    if upstream_head != pin:
        parser.error(f"darktable checkout {upstream_head} does not match project pin {pin}")
    imported = {}
    for code in catalogs:
        if code == "en":
            continue
        po_code = PO_CODES.get(code, code.replace("-", "_"))
        path = args.darktable_root / "po" / f"{po_code}.po"
        if path.is_file():
            # Read the committed catalog, even if the checkout has local PO edits.
            source = subprocess.check_output(["git", "-C", str(args.darktable_root), "show", f"{pin}:po/{po_code}.po"], text=True)
            imported[code] = messages(path, source)
    # Catalogs without an upstream PO file keep any existing manual entries.
    for code in ["en", *imported]:
        catalogs[code] = {k: v for k, v in catalogs[code].items() if not k.startswith(PREFIX)}
    for code, values in imported.items():
        for key, (english, translated) in sorted(values.items()):
            catalogs["en"][key] = english
            catalogs[code][key] = translated
    changed = [code for code in catalogs if catalogs[code] != originals[code]]
    for code in changed:
        if not args.check:
            (CATALOGS / f"{code}.json").write_text(json.dumps(catalogs[code], ensure_ascii=False, indent=2) + "\n")
    for code, values in imported.items():
        print(f"{code}: {len(values)} darktable module messages")
    if args.check and changed:
        raise SystemExit("Stale darktable translations: " + ", ".join(changed))


if __name__ == "__main__":
    main()
