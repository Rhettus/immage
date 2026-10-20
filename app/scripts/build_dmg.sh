#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

# rebuild build/dmg/<product>_<version>_aarch64.dmg from this checkout: the
# engine and darktable install tree, made self-contained, then the app, then
# the disk image. needs the build/ tree configured as for development
# (scripts/build.sh does that) and app/node_modules installed (npm install)
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
# only the .app: tauri's own dmg step scripts Finder, which fails without
# that permission, so the disk image is made below. IMMAGE_TAURI_CONFIG is
# the release build's addition (.github/workflows/build.yml), which also
# writes the updater's .app.tar.gz and its signature
conf=app/src-tauri/tauri.conf.json
product=$(sed -n 's/.*"productName": *"\([^"]*\)".*/\1/p' "$conf" | head -1)
app="app/src-tauri/target/release/bundle/macos/$product.app"
rm -rf "$app" "$app.tar.gz" "$app.tar.gz.sig"
(cd app && npm run tauri build -- ${IMMAGE_TAURI_CONFIG:+--config "$IMMAGE_TAURI_CONFIG"})

echo "== disk image"
version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$conf" | head -1)
dmg="build/dmg/${product}_${version}_aarch64.dmg"
rm -rf build/dmg/stage
mkdir -p build/dmg/stage
cp -R "$app" build/dmg/stage/
ln -s /Applications build/dmg/stage/Applications
rm -f "$dmg"
hdiutil create -volname "$product" -srcfolder build/dmg/stage -format UDZO "$dmg"
echo "== done: $dmg"
