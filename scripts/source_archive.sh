#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

# build/immage-<version>-source.tar.gz: this commit of Immage, with darktable,
# the darktable submodules the engine builds with, and Immporter, each at the
# commit this one pins. the binaries carry all of them, so a release attaches
# it (.github/workflows/release.yml). scripts/build.sh builds from it
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' app/src-tauri/tauri.conf.json | head -1)
name="immage-$version"
stage="build/source/$name"
rm -rf build/source
mkdir -p "$stage"

echo "== immage $(git rev-parse --short HEAD)"
git archive HEAD | tar -x -C "$stage"

dt=$(git rev-parse HEAD:darktable)
echo "== darktable $dt"
git submodule update --init darktable
mkdir -p "$stage/darktable"
git -C darktable archive "$dt" | tar -x -C "$stage/darktable"
# the same list as scripts/build.sh
for sub in src/external/rawspeed src/external/OpenCL src/external/libxcf \
    src/external/whereami src/external/LibRaw; do
  pin=$(git -C darktable rev-parse "$dt:$sub")
  echo "== darktable/$sub $pin"
  git -C darktable submodule update --init "$sub"
  git -C "darktable/$sub" cat-file -e "$pin^{commit}" 2>/dev/null || git -C "darktable/$sub" fetch origin
  mkdir -p "$stage/darktable/$sub"
  git -C "darktable/$sub" archive "$pin" | tar -x -C "$stage/darktable/$sub"
done

rev=$(head -n 1 app/immporter.rev | tr -cd '0-9a-f')
echo "== immporter $rev"
[ -d immporter/.git ] || git clone https://github.com/Rhettus/immporter immporter
git -C immporter cat-file -e "$rev^{commit}" 2>/dev/null || git -C immporter fetch origin
mkdir -p "$stage/immporter"
git -C immporter archive "$rev" | tar -x -C "$stage/immporter"

tar -C build/source -czf "build/$name-source.tar.gz" "$name"
rm -rf build/source
ls -l "build/$name-source.tar.gz"
