#!/bin/sh
# Windows, in MSYS2's UCRT64 shell: build darktable and the engine, install
# them into build/install, and bundle the engine with every DLL it loads
# into app/src-tauri/resources/darktable for the installer. the app itself
# is then built from PowerShell (app/WINDOWS.md)
set -eu

root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"

echo "== the importer"
sh app/scripts/fetch_immporter.sh

echo "== darktable and the engine"
sh scripts/patch_darktable.sh
cmake -S darktable -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DUSE_AI=ON -DUSE_LUA=OFF \
      -DDONT_USE_INTERNAL_LIBRAW=ON -DBUILD_TESTING=OFF -DIMMAGE_ROOT="$root"
cmake --build build
rm -rf build/install
cmake --install build --prefix build/install > build/install.log

echo "== bundling the engine"
sh app/scripts/bundle_engine_windows.sh
