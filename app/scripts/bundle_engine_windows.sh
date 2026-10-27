#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

# Windows, in MSYS2's UCRT64 shell: copy the installed engine (build/install)
# into the app's resources and make it self-contained. Windows looks for a
# program's DLLs beside it first, so every DLL it or darktable's modules
# need from MSYS2 (or the build, as ONNX Runtime) goes into bin/. what each
# file needs is read from its import table with objdump, not ldd: ldd loads
# every DLL to find out, which crawls under x64 emulation and can hang
set -eu

root=$(cd "$(dirname "$0")/../.." && pwd)
src="$root/build/install"
dst="$root/app/src-tauri/resources/darktable"

rm -rf "$dst"
mkdir -p "$dst/bin" "$dst/lib" "$dst/share"
cp "$src/bin/darktable-engine.exe" "$dst/bin/"
cp "$src"/bin/*.dll "$dst/bin/" 2>/dev/null || true
cp -r "$src/lib/darktable" "$dst/lib/darktable"
cp -r "$src/share/darktable" "$dst/share/darktable"
# darktable falls back to share/lensfun beside its own data when lensfun's
# built-in location (inside MSYS2) is missing, as on a user's machine
cp -r /ucrt64/share/lensfun "$dst/share/lensfun"

# where a needed DLL may come from, after the bundle itself
dirs="/ucrt64/bin $(find "$root/build" -iname 'onnxruntime*.dll' -exec dirname {} \; 2>/dev/null | sort -u | tr '\n' ' ')"
queue=$(mktemp -p "$root/build"); next=$(mktemp -p "$root/build"); missing=$(mktemp -p "$root/build")
find "$dst" \( -iname '*.exe' -o -iname '*.dll' \) > "$queue"
while [ -s "$queue" ]; do
  : > "$next"
  while read -r f; do
    objdump -p "$f" 2>/dev/null | sed -n 's/^[[:space:]]*DLL Name: //p' | tr -d '\r'
  done < "$queue" | sort -fu | while read -r dll; do
    [ -e "$dst/bin/$dll" ] && continue
    # Windows' own: in System32, or an API set name with no file behind it
    case "$dll" in api-ms-*|API-MS-*|ext-ms-*|EXT-MS-*) continue ;; esac
    [ -e "/c/Windows/System32/$dll" ] && continue
    found=""
    for d in $dirs; do
      if [ -e "$d/$dll" ]; then found="$d/$dll"; break; fi
    done
    if [ -n "$found" ]; then
      cp "$found" "$dst/bin/"
      echo "$dst/bin/$(basename "$found")" >> "$next"
    else
      echo "$dll" >> "$missing"
    fi
  done
  mv "$next" "$queue"
done

# the licenses of the libraries bundled above, which the GPL and LGPL
# require to travel with the binaries, as bundle_engine.py collects them on
# the Mac: each library's texts in share/licenses, and an index with its
# license and where its source is
lic="$dst/share/licenses"
mkdir -p "$lic"
own=$(mktemp -p "$root/build"); msys=$(mktemp -p "$root/build")
# compiled into darktable from src/external: folder, license, source
while read -r name license source; do
  license=$(echo "$license" | sed 's/|/ OR /g')
  mkdir -p "$lic/$name"
  texts=""
  for f in "$root/darktable/src/external/$name"/*; do
    case "$(basename "$f" | tr '[:lower:]' '[:upper:]')" in
      LICENSE*|LICENCE*|COPYING*|COPYRIGHT*|NOTICE*)
        cp "$f" "$lic/$name/"; texts="$texts${texts:+, }$name/$(basename "$f")" ;;
    esac
  done
  printf '%s, in darktable'"'"'s source (src/external/%s)\n  license: %s\n  source: %s\n  texts: %s\n\n' \
    "$name" "$name" "$license" "$source" "$texts" >> "$own"
done <<'EOF'
rawspeed LGPL-2.1-or-later https://github.com/darktable-org/rawspeed
LibRaw LGPL-2.1-only|CDDL-1.0 https://github.com/LibRaw/LibRaw
whereami MIT|WTFPL https://github.com/gpakosz/whereami
libxcf MIT https://github.com/houz/libxcf
OpenCL Apache-2.0 https://github.com/KhronosGroup/OpenCL-Headers
EOF
# ONNX Runtime, from the NuGet package darktable's build downloaded
# (cmake/modules/FindONNXRuntime.cmake keeps only its libraries)
if ls "$dst"/bin/onnxruntime*.dll > /dev/null 2>&1; then
  nupkg=$(ls "$root"/build/_deps/microsoft.ml.onnxruntime.directml.*.nupkg 2>/dev/null | tail -1)
  [ -n "$nupkg" ] || { echo "ONNX Runtime is bundled, but its package (and license) is not in build/_deps"; exit 1; }
  version=$(basename "$nupkg" .nupkg | sed 's/^microsoft\.ml\.onnxruntime\.directml\.//')
  mkdir -p "$lic/onnxruntime"
  texts=""
  for f in $(bsdtar -tf "$nupkg" | grep -iE '^(LICENSE[^/]*|ThirdPartyNotices[^/]*)$'); do
    bsdtar -xf "$nupkg" -C "$lic/onnxruntime" "$f"; texts="$texts${texts:+, }onnxruntime/$f"
  done
  [ -n "$texts" ] || { echo "no license in $nupkg"; exit 1; }
  printf 'onnxruntime %s\n  license: MIT\n  source: https://github.com/microsoft/onnxruntime\n  texts: %s\n\n' \
    "$version" "$texts" >> "$own"
fi
# OpenCV, compiled into darktable for HDR Merge's alignment and into the
# engine for Panorama Merge, from the build app/scripts/build_opencv.sh
# makes, with the texts of the parts it includes
cv="$root/build/opencv/install"
if grep -q 'USE_OPENCV:BOOL=ON' "$root/build/CMakeCache.txt" && [ -f "$cv/info" ]; then
  mkdir -p "$lic/opencv"
  texts=""
  for f in "$cv/LICENSE" "$cv"/share/licenses/opencv4/*; do
    [ -f "$f" ] || continue
    cp "$f" "$lic/opencv/"; texts="$texts${texts:+, }opencv/$(basename "$f")"
  done
  { sed -n 1p "$cv/info" | sed 's/$/, compiled into darktable and the engine/'; sed -n '2,3s/^/  /p' "$cv/info"
    printf '  texts: %s\n\n' "$texts"; } >> "$own"
fi
# from MSYS2: the package that owns each bundled DLL, and lensfun's data
pkgs=$(for f in "$dst"/bin/*.dll; do
         [ -e "/ucrt64/bin/$(basename "$f")" ] && echo "/ucrt64/bin/$(basename "$f")"
       done | xargs pacman -Qqo 2>/dev/null; pacman -Qqo /ucrt64/share/lensfun 2>/dev/null || true)
bare=""
for pkg in $(echo "$pkgs" | sort -u); do
  name=${pkg#mingw-w64-ucrt-x86_64-}
  texts=""
  for f in $(pacman -Qlq "$pkg" | grep '/share/licenses/.' | grep -v '/$'); do
    mkdir -p "$lic/$name"; cp "$f" "$lic/$name/"; texts="$texts${texts:+, }$name/$(basename "$f")"
  done
  # texts kept in app/licenses/msys2 for a package that ships none
  if [ -z "$texts" ] && [ -d "$root/app/licenses/msys2/$name" ]; then
    for f in "$root/app/licenses/msys2/$name"/*; do
      mkdir -p "$lic/$name"; cp "$f" "$lic/$name/"; texts="$texts${texts:+, }$name/$(basename "$f")"
    done
  fi
  [ -n "$texts" ] || bare="$bare $name"
  pacman -Qi "$pkg" | tr -d '\r' | awk -v n="$name" -v t="$texts" -v p="$pkg" -F' *: ' '
    $1 == "Version" { v = $2 } $1 == "Licenses" { l = $2 } $1 == "URL" { u = $2 }
    END { printf "%s %s\n  license: %s\n  source: %s (MSYS2: https://packages.msys2.org/package/%s)\n", n, v, l, u, p
          if (t != "") printf "  texts: %s\n", t
          printf "\n" }' >> "$msys"
done
# the darktable commit built, so its source can be found exactly; a source
# archive has no git, and then the notice says only where darktable is
if dt_rev=$(git -C "$root/darktable" rev-parse HEAD 2>/dev/null); then
  dt_source="https://github.com/darktable-org/darktable/tree/$dt_rev"
else
  dt_source="https://github.com/darktable-org/darktable, at the commit in Immage's source"
fi
{ printf "Libraries bundled with Immage's engine. Each keeps its own license; texts\n"
  printf "are in the folder named after it. darktable itself is under the GNU GPL,\n"
  printf "version 3 or later, as Immage is.\n\n"
  printf "darktable\n  license: GPL-3.0-or-later\n  source: %s\n\n" "$dt_source"
  printf "Compiled into darktable, or bundled beside it:\n\n"; cat "$own"
  printf "From MSYS2:\n\n"; cat "$msys"; } > "$lic/INDEX.txt"
rm -f "$own" "$msys"
echo "licenses for $(echo "$pkgs" | sort -u | grep -c .) MSYS2 packages; no license file:${bare:- none}"

size=$(du -sm "$dst" | cut -f1)
n_missing=$(sort -fu "$missing" | grep -c . || true)
echo "bundled $(ls "$dst/bin" | grep -ci '\.dll$') DLLs, ${size} MB; not found: $n_missing"
sort -fu "$missing" | sed 's/^/  missing: /'
rm -f "$queue" "$next" "$missing"
[ "$n_missing" = 0 ]
