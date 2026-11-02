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
# Tauri has now deployed dependencies and generated the normal AppRun. Install
# the selector, then regenerate the image BEFORE its final updater signature.
bundle_dir="$root/app/src-tauri/target/release/bundle/appimage"
# Reuse the exact output plugin downloaded by Tauri (no second tool download).
plugin="${XDG_CACHE_HOME:-$HOME/.cache}/tauri/linuxdeploy-plugin-appimage.AppImage"
[ -x "$plugin" ] || { echo "Missing Tauri AppImage output plugin: $plugin" >&2; exit 1; }
for image in "$bundle_dir"/*.AppImage; do
    rm -f "$image.sig"
    sh app/scripts/repack_appimage.sh "$image" "$bundle_dir/Immage.AppDir" "$plugin" "$image"
    if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]; then
        version=$(node -p "require('./app/src-tauri/tauri.conf.json').version")
        (cd app && npx tauri signer sign --app-version "$version" "$image")
    elif [ -n "${IMMAGE_TAURI_CONFIG:-}" ]; then
        echo 'Release AppImage requires signing credentials after launcher repack' >&2
        exit 1
    fi
done
ls -l "$bundle_dir"/*.AppImage
