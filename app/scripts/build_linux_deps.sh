#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

# Linux: build the libraries Ubuntu 22.04 has too old for darktable,
# libheif and exiv2, at the versions darktable's own AppImage uses
# (darktable/.github/workflows/nightly.yml), and install them into
# /usr/local. each one also leaves, in /usr/local/share/immage-deps/<name>,
# its license texts, an `info` file (name and version, license, source) and
# the list of files it installed, which bundle_engine.py reads to credit
# the libraries it bundles that no distribution package owns. ARM64 also
# builds the image libraries unavailable from the jammy PPAs
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

# the graphics PPA has no jammy ARM64 JPEG XL, SharpYUV or OpenEXR 3
# packages. OpenEXR 2 conflicts with Imath 3, which darktable uses. build
# the libraries here, keeping the same formats as the x86-64 AppImage.
# Highway is JPEG XL's SIMD library, newer than jammy's system package
. /etc/os-release
if [ "$(uname -m)" = aarch64 ] && [ "$ID" = ubuntu ] && [ "$VERSION_ID" = 22.04 ]; then
  build openexr v3.3.5 BSD-3-Clause https://github.com/AcademySoftwareFoundation/openexr 'LICENSE.md' \
        -DBUILD_SHARED_LIBS=ON -DOPENEXR_BUILD_TOOLS=OFF -DOPENEXR_BUILD_EXAMPLES=OFF
  build libwebp v1.6.0 BSD-3-Clause https://github.com/webmproject/libwebp 'COPYING PATENTS AUTHORS' \
        -DBUILD_SHARED_LIBS=ON -DWEBP_BUILD_ANIM_UTILS=OFF -DWEBP_BUILD_CWEBP=OFF \
        -DWEBP_BUILD_DWEBP=OFF -DWEBP_BUILD_GIF2WEBP=OFF -DWEBP_BUILD_IMG2WEBP=OFF \
        -DWEBP_BUILD_VWEBP=OFF -DWEBP_BUILD_WEBPINFO=OFF -DWEBP_BUILD_WEBPMUX=OFF \
        -DWEBP_BUILD_EXTRAS=OFF
  build highway 1.3.0 Apache-2.0 https://github.com/google/highway 'LICENSE' \
        -DBUILD_SHARED_LIBS=ON -DHWY_ENABLE_TESTS=OFF -DHWY_ENABLE_EXAMPLES=OFF \
        -DHWY_ENABLE_CONTRIB=OFF
  build libjxl v0.12.0 BSD-3-Clause https://github.com/libjxl/libjxl 'LICENSE PATENTS AUTHORS' \
        -DBUILD_SHARED_LIBS=ON -DJPEGXL_FORCE_SYSTEM_HWY=ON \
        -DJPEGXL_FORCE_SYSTEM_BROTLI=ON -DJPEGXL_FORCE_SYSTEM_LCMS2=ON \
        -DJPEGXL_ENABLE_SKCMS=OFF -DJPEGXL_ENABLE_SJPEG=OFF \
        -DJPEGXL_ENABLE_TOOLS=OFF -DJPEGXL_ENABLE_DEVTOOLS=OFF -DJPEGXL_ENABLE_BENCHMARK=OFF \
        -DJPEGXL_ENABLE_EXAMPLES=OFF -DJPEGXL_ENABLE_JNI=OFF -DJPEGXL_ENABLE_PLUGINS=OFF \
        -DJPEGXL_ENABLE_DOXYGEN=OFF -DJPEGXL_ENABLE_MANPAGES=OFF -DJPEGXL_ENABLE_FUZZERS=OFF \
        -DJPEGXL_ENABLE_TCMALLOC=OFF
fi

# the HEVC encoder is left out: darktable only reads HEIF, and x265 is GPL
build libheif v1.23.6 LGPL-3.0-or-later https://github.com/strukturag/libheif COPYING \
      -DENABLE_PLUGIN_LOADING=OFF -DWITH_EXAMPLES=OFF -DWITH_GDK_PIXBUF=OFF -DWITH_X265=OFF \
      -DWITH_LIBDE265=ON -DWITH_AOM_DECODER=ON -DWITH_AOM_ENCODER=ON -DWITH_OpenH264_DECODER=ON \
      -DWITH_JPEG_DECODER=ON -DWITH_OpenJPEG_DECODER=ON -DWITH_LIBSHARPYUV=ON
build exiv2 v0.28.9 GPL-2.0-or-later https://github.com/Exiv2/exiv2 COPYING \
      -DBUILD_SHARED_LIBS=ON -DEXIV2_ENABLE_NLS=ON -DEXIV2_ENABLE_VIDEO=OFF \
      -DEXIV2_BUILD_SAMPLES=OFF -DEXIV2_BUILD_EXIV2_COMMAND=OFF
