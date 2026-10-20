#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

# build Immage from a clone: the darktable submodule (patched to build the
# engine), the engine, then the app for this platform. on macOS the result
# is build/dmg/<product>_<version>_aarch64.dmg; on Windows, run this from
# MSYS2's UCRT64 shell and build the app from PowerShell afterwards
# (app/WINDOWS.md)
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

echo "== darktable"
# take the patch off first: a checkout of a new pin refuses to overwrite the
# patched file
if [ -f darktable/.git ] || [ -d darktable/.git ]; then
  git -C darktable apply --reverse "$root/patches/darktable-engine.patch" 2>/dev/null || true
fi
git submodule update --init darktable
# darktable's own submodules, without its integration tests and lua-scripts
git -C darktable submodule update --init src/external/rawspeed src/external/OpenCL \
    src/external/libxcf src/external/whereami src/external/LibRaw
sh scripts/patch_darktable.sh

case "$(uname -s)" in
  Darwin)
    if [ ! -f build/build.ninja ]; then
      # the engine needs none of darktable's GUI-side features, and each one
      # found installed would otherwise be built in and its libraries bundled
      cmake -S darktable -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DUSE_AI=ON -DUSE_LUA=OFF \
            -DUSE_CAMERA_SUPPORT=OFF -DUSE_COLORD=OFF -DUSE_GMIC=OFF -DUSE_GRAPHICSMAGICK=OFF \
            -DUSE_ICU=OFF -DUSE_IMAGEMAGICK=OFF -DUSE_KWALLET=OFF -DUSE_LIBSECRET=OFF \
            -DUSE_MAC_INTEGRATION=OFF -DUSE_MAP=OFF -DUSE_OPENCV=OFF -DUSE_PORTMIDI=OFF \
            -DUSE_SDL2=OFF -DBUILD_PRINT=OFF \
            -DOpenMP_ROOT="$(brew --prefix libomp)" -DIMMAGE_ROOT="$root"
    fi
    sh app/scripts/build_dmg.sh
    ;;
  MINGW*|MSYS*)
    sh app/scripts/build_engine_windows.sh
    ;;
  *)
    echo "no app build for $(uname -s) yet" >&2
    exit 1
    ;;
esac
