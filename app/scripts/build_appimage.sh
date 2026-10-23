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

# the web extension that hands frames to the window in shared memory
# (src-tauri/webext/frames.c), against the WebKitGTK the AppImage bundles
echo "== frames web extension"
mkdir -p app/src-tauri/resources/webext
${CC:-cc} -shared -fPIC -O2 -Wall -o app/src-tauri/resources/webext/libimmage-frames.so \
  app/src-tauri/webext/frames.c $(pkg-config --cflags --libs webkit2gtk-web-extension-4.1)

echo "== app"
# IMMAGE_TAURI_CONFIG is the release build's addition
# (.github/workflows/build.yml): the updater's signature next to the AppImage
rm -f app/src-tauri/target/release/bundle/appimage/*.AppImage*
(cd app && npm run tauri build -- ${IMMAGE_TAURI_CONFIG:+--config "$IMMAGE_TAURI_CONFIG"})
ls -l app/src-tauri/target/release/bundle/appimage/*.AppImage
