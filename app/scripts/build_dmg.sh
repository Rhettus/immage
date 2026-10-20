#!/bin/sh
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
# tauri's own dmg step scripts Finder and fails without that permission;
# only the .app it builds first is needed, so its exit status is not
conf=app/src-tauri/tauri.conf.json
product=$(sed -n 's/.*"productName": *"\([^"]*\)".*/\1/p' "$conf" | head -1)
app="app/src-tauri/target/release/bundle/macos/$product.app"
rm -rf "$app"
(cd app && npm run tauri build) || true
if [ ! -d "$app" ]; then
  echo "the app did not build: see the output above" >&2
  exit 1
fi

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
