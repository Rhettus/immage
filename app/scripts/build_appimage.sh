#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

# rebuild the AppImage from this checkout: the engine and darktable install
# tree, made self-contained, then the app and its AppImage, in
# app/src-tauri/target/release/bundle/appimage. needs the build/ tree
# configured (scripts/build.sh does that) and app/node_modules installed
# (npm ci)
set -eu

root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"

echo "== the importer"
sh app/scripts/fetch_immporter.sh

echo "== engine and darktable"
cmake --build build
rm -rf build/install
cmake --install build --prefix build/install > build/install.log

echo "== bundling the engine into the app's resources"
python3 -I app/scripts/bundle_engine.py

echo "== app"
(cd app && npm run tauri build)
ls -l app/src-tauri/target/release/bundle/appimage/*.AppImage
