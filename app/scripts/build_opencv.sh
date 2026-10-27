#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

# OpenCV for darktable's HDR merge auto-alignment (src/common/hdr_alignment.cc)
# and the engine's Panorama Merge (engine/pano.cc), on every platform: only
# the five modules darktable links (src/CMakeLists.txt, DT_OPENCV4_MODULES)
# and stitching, which the engine links, static and with none of OpenCV's
# third-party libraries, into build/opencv/install. a packaged OpenCV
# brings dozens of libraries the engine would then bundle (Homebrew's pulls
# VTK, FFmpeg and OpenVINO). darktable finds it through OpenCV_ROOT
# (scripts/build.sh, build_engine_windows.sh). the install also keeps
# OpenCV's license and an `info` file (name and version, license, source,
# then the modules built) for the bundlers' notices
set -eu

root=$(cd "$(dirname "$0")/../.." && pwd)
work="$root/build/opencv"
tag=4.14.0
modules=core,imgproc,features2d,flann,calib3d,stitching
source=https://github.com/opencv/opencv

# a build of other modules, from before stitching was added, is redone
if [ "$(head -n 1 "$work/install/info" 2>/dev/null)" = "opencv $tag" ] \
   && [ "$(sed -n 4p "$work/install/info")" = "modules: $modules" ]; then
  echo "== opencv $tag: built already"
  exit 0
fi
echo "== opencv $tag"
rm -rf "$work"
git clone --quiet --branch "$tag" --depth 1 "$source" "$work/src"
# PIC, as it is linked into libdarktable. zlib is the system's, which
# darktable links too. IPP and its ICV binaries, ITT, OpenCL, the image
# codecs (imgcodecs is not built, but their libraries would be) and the
# parallel frameworks other than the platform's own are left out, so the
# build downloads nothing
cmake -S "$work/src" -B "$work/build" -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX="$work/install" -DCMAKE_INSTALL_LIBDIR=lib \
      -DBUILD_SHARED_LIBS=OFF -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
      -DBUILD_LIST=$modules \
      -DBUILD_TESTS=OFF -DBUILD_PERF_TESTS=OFF -DBUILD_EXAMPLES=OFF -DBUILD_DOCS=OFF \
      -DBUILD_opencv_apps=OFF -DBUILD_JAVA=OFF -DBUILD_opencv_python3=OFF -DBUILD_ZLIB=OFF \
      -DWITH_IPP=OFF -DWITH_ITT=OFF -DWITH_OPENCL=OFF -DWITH_EIGEN=OFF -DWITH_LAPACK=OFF \
      -DWITH_TBB=OFF -DWITH_OPENMP=OFF -DWITH_PROTOBUF=OFF -DWITH_ADE=OFF -DWITH_KLEIDICV=OFF \
      -DWITH_FLATBUFFERS=OFF -DWITH_JPEG=OFF -DWITH_PNG=OFF -DWITH_TIFF=OFF -DWITH_WEBP=OFF \
      -DWITH_OPENJPEG=OFF -DWITH_JASPER=OFF -DWITH_OPENEXR=OFF -DWITH_AVIF=OFF -DWITH_SPNG=OFF \
      -DWITH_IMGCODEC_HDR=OFF -DWITH_IMGCODEC_PFM=OFF -DWITH_IMGCODEC_PXM=OFF -DWITH_IMGCODEC_SUNRASTER=OFF \
      -DCV_TRACE=OFF -DOPENCV_GENERATE_PKGCONFIG=OFF
cmake --build "$work/build"
cmake --install "$work/build" > /dev/null
cp "$work/src/LICENSE" "$work/install/LICENSE"
# on ARM, OpenCV builds NVIDIA's Carotene (NEON) into core, whose BSD
# license is only in its sources' headers
if [ -f "$work/install/lib/opencv4/3rdparty/libtegra_hal.a" ]; then
  sed -n '1,/\*\//p' "$work/src/hal/carotene/src/common.cpp" \
    > "$work/install/share/licenses/opencv4/carotene-LICENSE"
fi
printf 'opencv %s\nlicense: Apache-2.0\nsource: %s/tree/%s\nmodules: %s\n' "$tag" "$source" "$tag" "$modules" \
  > "$work/install/info"
