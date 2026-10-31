#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

# the experimental Ubuntu 26.04 runner only: install a matched GTK3 / 4.1
# WebKitGTK, JavaScriptCore and helper processes for Tauri to bundle
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
work="$root/build/webkitgtk"
stage="$work/install"
v=2.54.2
sha=a76345b391bef6211fb5ab6cfab2e86b285d18cda17cbb9ade595f1252b86065
triplet=$(dpkg-architecture -qDEB_HOST_MULTIARCH)
notice="$stage/usr/share/doc/immage-webkitgtk/NOTICE"

if [ ! -f "$notice" ] || ! head -n 1 "$notice" | grep -qx "WebKitGTK $v"; then
  mkdir -p "$work"
  curl -fL --retry 3 "https://webkitgtk.org/releases/webkitgtk-$v.tar.xz" -o "$work/source.tar.xz"
  printf '%s  %s\n' "$sha" "$work/source.tar.xz" | sha256sum -c
  rm -rf "$work/src" "$work/compile" "$stage"
  mkdir -p "$work/src"
  tar -xJf "$work/source.tar.xz" -C "$work/src" --strip-components=1
  # match Ubuntu's multiarch helper location: Tauri searches it and the
  # GTK bundling hook relocates /usr paths inside the library
  # Ubuntu's WebKit build dependencies omit optional libbacktrace support
  cmake -S "$work/src" -B "$work/compile" -G Ninja \
    -DPORT=GTK -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr \
    -DCMAKE_C_COMPILER_LAUNCHER= -DCMAKE_CXX_COMPILER_LAUNCHER= \
    -DCMAKE_INSTALL_LIBDIR="lib/$triplet" -DCMAKE_INSTALL_LIBEXECDIR="lib/$triplet" \
    -DUSE_GTK4=OFF -DTRY_USE_LD_LLD=ON -DUSE_LD_LLD=ON -DENABLE_DOCUMENTATION=OFF \
    -DENABLE_MINIBROWSER=OFF -DENABLE_WEBDRIVER=OFF -DENABLE_API_TESTS=OFF \
    -DENABLE_LAYOUT_TESTS=OFF -DUSE_LIBBACKTRACE=OFF
  cmake --build "$work/compile" --parallel "${CMAKE_BUILD_PARALLEL_LEVEL:-2}"
  DESTDIR="$stage" cmake --install "$work/compile" --strip
  # preserve the upstream notices, including licenses of vendored code,
  # in About as well as alongside the cached installation
  mkdir -p "$(dirname "$notice")"
  python3 -I - "$work/src" "$notice" "$v" <<'PY'
import pathlib, sys
src, dest = map(pathlib.Path, sys.argv[1:3])
with dest.open('w') as out:
    out.write(f'WebKitGTK {sys.argv[3]}\nsource: https://webkitgtk.org/releases/webkitgtk-{sys.argv[3]}.tar.xz\n\n')
    for path in sorted((src / 'Source').rglob('*')):
        if path.is_file() and path.name.lower().startswith(('license', 'copying', 'copyright', 'notice')):
            out.write(f'\n--- {path.relative_to(src)} ---\n')
            out.write(path.read_text(errors='replace'))
            out.write('\n')
PY
  rm -rf "$work/src" "$work/compile" "$work/source.tar.xz"
fi
sudo cp -a "$stage/usr/." /usr/
sudo ldconfig
pkg-config --modversion webkit2gtk-4.1 javascriptcoregtk-4.1 webkit2gtk-web-extension-4.1 \
  | tee "$work/versions.txt"
[ "$(pkg-config --modversion webkit2gtk-4.1)" = "$v" ]
[ "$(pkg-config --modversion javascriptcoregtk-4.1)" = "$v" ]
[ "$(pkg-config --modversion webkit2gtk-web-extension-4.1)" = "$v" ]
for helper in WebKitWebProcess WebKitNetworkProcess injected-bundle/libwebkit2gtkinjectedbundle.so; do
  test -f "/usr/lib/$triplet/webkit2gtk-4.1/$helper"
done
