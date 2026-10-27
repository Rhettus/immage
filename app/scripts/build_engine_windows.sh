#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

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
# OpenCV for HDR Merge's alignment, built rather than MSYS2's, as on the
# other platforms (scripts/build.sh)
sh app/scripts/build_opencv.sh
# the engine needs none of darktable's GUI-side features, and each one found
# installed would otherwise be built in and its DLLs bundled (as on the Mac,
# scripts/build.sh). printing stays on: darktable builds its print view on
# Windows whatever BUILD_PRINT says (src/views/CMakeLists.txt:25), and the
# view fails to compile without it; it needs only Windows' own DLLs.
# BINARY_PACKAGE_BUILD builds for generic x86-64 rather than darktable's
# default -march=native, the build machine's CPU (cmake/march-mtune.cmake)
cmake -S darktable -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DUSE_AI=ON -DUSE_LUA=OFF \
      -DUSE_CAMERA_SUPPORT=OFF -DUSE_COLORD=OFF -DUSE_GMIC=OFF -DUSE_GRAPHICSMAGICK=OFF \
      -DUSE_ICU=OFF -DUSE_IMAGEMAGICK=OFF -DUSE_KWALLET=OFF -DUSE_LIBSECRET=OFF \
      -DUSE_MAP=OFF -DUSE_OPENCV=ON -DOpenCV_ROOT="$root/build/opencv/install" \
      -DUSE_PORTMIDI=OFF -DUSE_SDL2=OFF \
      -DDONT_USE_INTERNAL_LIBRAW=ON -DBUILD_TESTING=OFF -DBINARY_PACKAGE_BUILD=ON \
      -DIMMAGE_ROOT="$root"
cmake --build build
rm -rf build/install
cmake --install build --prefix build/install > build/install.log

echo "== bundling the engine"
sh app/scripts/bundle_engine_windows.sh
