#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

"""gather a release's files from the build artifacts into one directory, and
write the two files made from them: latest.json, the feed the in-app updater
reads (tauri.conf.json, plugins.updater), and body.md, the release's text.

  release_assets.py <artifacts dir> <version> <out dir>

run by .github/workflows/release.yml. it fails when a file is missing, so a
release never goes out with a platform that cannot update"""

import datetime
import json
import re
import shutil
import sys
from pathlib import Path

REPO = "https://github.com/Rhettus/immage"


def one(root: Path, pattern: str) -> Path:
    found = sorted(root.rglob(pattern))
    if len(found) != 1:
        sys.exit(f"expected one {pattern} in the artifacts, found {len(found)}: {[str(f) for f in found]}")
    return found[0]


def unwrap(text: str) -> str:
    # one line per paragraph and list item: GitHub shows each newline of a
    # release's text as a line break, and the banner wraps at its own width
    out = []
    for line in text.splitlines():
        starts = not line.strip() or re.match(r"\s*([-*] |#|\d+\. |```)", line)
        if out and out[-1].strip() and not starts and not out[-1].startswith("#"):
            out[-1] += " " + line.strip()
        else:
            out.append(line)
    return "\n".join(out)


def notes(version: str) -> str:
    # the section under "## <version>", up to the next "## "
    text = Path("RELEASE_NOTES.md").read_text(encoding="utf-8")
    m = re.search(rf"^## v?{re.escape(version)}\b[^\n]*\n(.*?)(?=^## |\Z)", text, re.M | re.S)
    if not m or not m.group(1).strip():
        sys.exit(f"RELEASE_NOTES.md has no section for {version}")
    return unwrap(m.group(1).strip())


DOWNLOADS = """\
## Downloads

| | |
|---|---|
| **macOS** (Apple Silicon) | [{dmg}]({url}/{dmg}) |
| **Windows** (x64) | [{nsis}]({url}/{nsis}), or [{msi}]({url}/{msi}) |
| **Linux** (x86-64) | [{appimage}]({url}/{appimage}) |
| **Source** | [{source}]({url}/{source}) |
"""

INSTALL = """\
## Installing

These builds are not signed with a developer certificate, so each system
warns when Immage is opened for the first time. Updates after that install
from inside Immage, without the warning.

- **macOS** (Apple Silicon, macOS 15 or newer): open `{dmg}` and drag
  Immage to Applications. Open it once; when macOS says it cannot check it,
  go to System Settings › Privacy & Security and click **Open Anyway**.
  Or, in Terminal: `xattr -dr com.apple.quarantine /Applications/Immage.app`
- **Windows** (x64): run `{nsis}` (or `{msi}`). When SmartScreen stops
  it, click **More info**, then **Run anyway**
- **Linux** (x86-64, glibc 2.35 or newer, such as Ubuntu 22.04): make
  `{appimage}` executable (`chmod +x {appimage}`) and run it

Immage checks for a new version once a day (Preferences › About ›
Updates), and offers to install it.

## Known issues

- **Linux with an NVIDIA graphics card**: NVIDIA's driver holds Immage's
  window to a few updates a second, on Wayland and X11 alike (WebKit bug
  [303811](https://bugs.webkit.org/show_bug.cgi?id=303811)). Immage works
  around it by having Mesa draw its window on the processor, when Mesa is
  installed, as it is on most distributions. On a fast processor that is
  about ten times faster, but it may be slower on a 4K screen or a slow
  processor; to compare, start Immage with
  `__EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/10_nvidia.json`
  for NVIDIA's own drawing. A real fix has to come from NVIDIA's driver or
  WebKitGTK
- **Linux on Wayland with fractional scaling** (125%, 150%, ...): sliders
  can be 2-3 times slower to update. The web view Immage is built on
  draws such a window at 200% and the desktop shrinks it, so it draws far
  more pixels than the screen shows. At 100% scaling, or started with
  `GDK_BACKEND=x11`, it is about as fast as elsewhere

## Source

`{source}` is the source of this release: Immage, with darktable and
Immporter at the commits it was built from. The libraries bundled from
Homebrew, MSYS2 and Ubuntu are listed in Preferences › About with the
version shipped and where their source is published. For at least three
years after this release, anyone may also ask for the complete source of
any GPL or LGPL library in these binaries, at the version shipped, free of
charge: open an issue at {repo}/issues.
"""


def main():
    artifacts, version, out = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
    out.mkdir(parents=True, exist_ok=True)

    # (artifact, its name in the release, the latest.json keys it serves).
    # GitHub lists a release's files in one list sorted by name, so the
    # platform comes first in each name to keep each platform's files together
    p = f"Immage-{version}"
    files = [
        (one(artifacts, "*.dmg"), f"{p}-macOS-arm64.dmg", []),
        (one(artifacts, "*.app.tar.gz"), f"{p}-macOS-arm64-update.app.tar.gz",
         ["darwin-aarch64", "darwin-aarch64-app"]),
        # the updater installs with the kind of installer that put this copy
        # there, from the key for it, and with NSIS when there is none
        (one(artifacts, "*-setup.exe"), f"{p}-Windows-x64-setup.exe",
         ["windows-x86_64", "windows-x86_64-nsis"]),
        (one(artifacts, "*.msi"), f"{p}-Windows-x64.msi", ["windows-x86_64-msi"]),
        (one(artifacts, "*.AppImage"), f"{p}-Linux-x86_64.AppImage",
         ["linux-x86_64", "linux-x86_64-appimage"]),
        (one(artifacts, f"immage-{version}-source.tar.gz"), None, []),
    ]
    platforms = {}
    names = []
    for path, name, keys in files:
        name = name or path.name
        # the build's own names carry the version, except the updater's
        # Immage.app.tar.gz
        if not path.name.endswith(".app.tar.gz") and f"_{version}_" not in path.name \
                and f"-{version}-" not in path.name:
            sys.exit(f"{path.name} is not version {version}")
        shutil.copyfile(path, out / name)
        names.append(name)
        if keys:
            # the signature goes into latest.json only: the updater reads it
            # from there, so a .sig file beside it would only clutter the list
            sig = path.with_name(path.name + ".sig")
            if not sig.is_file():
                sys.exit(f"no signature for {path.name}: was the build given the signing key?")
            entry = {"signature": sig.read_text(encoding="utf-8").strip(),
                     "url": f"{REPO}/releases/download/v{version}/{name}"}
            for k in keys:
                platforms[k] = entry

    text = notes(version)
    feed = {
        "version": version,
        "notes": text,
        "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "platforms": platforms,
    }
    (out / "latest.json").write_text(json.dumps(feed, indent=2) + "\n", encoding="utf-8")

    dmg, _, nsis, msi, appimage, source = names
    fields = dict(dmg=dmg, nsis=nsis, msi=msi, appimage=appimage, source=source, repo=REPO,
                  url=f"{REPO}/releases/download/v{version}")
    body = DOWNLOADS.format(**fields) + "\n" + text + "\n\n" + unwrap(INSTALL).format(**fields)
    (out.parent / "body.md").write_text(body, encoding="utf-8")


if __name__ == "__main__":
    main()
