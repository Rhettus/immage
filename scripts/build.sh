#!/bin/sh
# build Immage from a clone: the darktable submodule (patched to build the
# engine), the engine, then the app for this platform. on macOS the result
# is build/dmg/<product>_<version>_aarch64.dmg; on Windows, run this from
# MSYS2's UCRT64 shell and build the app from PowerShell afterwards
# (app/WINDOWS.md)
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

echo "== darktable"
git submodule update --init darktable
# darktable's own submodules, without its integration tests and lua-scripts
git -C darktable submodule update --init src/external/rawspeed src/external/OpenCL \
    src/external/libxcf src/external/whereami src/external/LibRaw
sh scripts/patch_darktable.sh

case "$(uname -s)" in
  Darwin)
    if [ ! -f build/build.ninja ]; then
      cmake -S darktable -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DUSE_AI=ON -DUSE_LUA=OFF \
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
