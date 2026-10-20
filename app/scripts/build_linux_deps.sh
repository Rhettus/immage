#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

# Linux: build the two libraries Ubuntu 22.04 has too old for darktable,
# libheif and exiv2, at the versions darktable's own AppImage uses
# (darktable/.github/workflows/nightly.yml), and install them into
# /usr/local. each one also leaves, in /usr/local/share/immage-deps/<name>,
# its license texts, an `info` file (name and version, license, source) and
# the list of files it installed, which bundle_engine.py reads to credit
# the libraries it bundles that no distribution package owns
set -eu

root=$(cd "$(dirname "$0")/../.." && pwd)
work="$root/build/linux-deps"
sudo=""
[ "$(id -u)" = 0 ] || sudo=sudo

# name, git tag, SPDX license of the library, source, license files, cmake options
build() {
  name=$1 tag=$2 license=$3 source=$4 texts=$5
  shift 5
  meta=/usr/local/share/immage-deps/$name
  if [ "$(head -n 1 "$meta/info" 2>/dev/null)" = "$name ${tag#v}" ]; then
    echo "== $name ${tag#v}: installed already"
    return
  fi
  echo "== $name ${tag#v}"
  rm -rf "$work/$name"
  git clone --quiet --branch "$tag" --depth 1 "$source" "$work/$name/src"
  cmake -S "$work/$name/src" -B "$work/$name/build" -G Ninja -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX=/usr/local -DCMAKE_INSTALL_LIBDIR=lib -DBUILD_TESTING=OFF "$@"
  cmake --build "$work/$name/build"
  # staged first, so the list of what it installs is known
  DESTDIR="$work/$name/stage" cmake --install "$work/$name/build" > /dev/null
  $sudo cp -a "$work/$name/stage/." /
  $sudo rm -rf "$meta"
  $sudo mkdir -p "$meta"
  for t in $texts; do $sudo cp "$work/$name/src/$t" "$meta/"; done
  (cd "$work/$name/stage" && find . ! -type d | sed 's/^\.//') | $sudo tee "$meta/files" > /dev/null
  printf '%s %s\nlicense: %s\nsource: %s\n' "$name" "${tag#v}" "$license" "$source" \
    | $sudo tee "$meta/info" > /dev/null
  $sudo ldconfig
}

# the HEVC encoder is left out: darktable only reads HEIF, and x265 is GPL
build libheif v1.23.6 LGPL-3.0-or-later https://github.com/strukturag/libheif COPYING \
      -DENABLE_PLUGIN_LOADING=OFF -DWITH_EXAMPLES=OFF -DWITH_GDK_PIXBUF=OFF -DWITH_X265=OFF \
      -DWITH_LIBDE265=ON -DWITH_AOM_DECODER=ON -DWITH_AOM_ENCODER=ON -DWITH_OpenH264_DECODER=ON \
      -DWITH_JPEG_DECODER=ON -DWITH_OpenJPEG_DECODER=ON -DWITH_LIBSHARPYUV=ON
build exiv2 v0.28.9 GPL-2.0-or-later https://github.com/Exiv2/exiv2 COPYING \
      -DBUILD_SHARED_LIBS=ON -DEXIV2_ENABLE_NLS=ON -DEXIV2_ENABLE_VIDEO=OFF \
      -DEXIV2_BUILD_SAMPLES=OFF -DEXIV2_BUILD_EXIV2_COMMAND=OFF
