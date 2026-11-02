#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Reuse the base image's runtime; the output must be signed AFTER this step.
set -eu
if [ "$#" -ne 4 ]; then
    echo "Usage: $0 BASE.AppImage APPDIR OUTPUT-PLUGIN OUTPUT.AppImage" >&2
    exit 2
fi
base=$1
appdir=$2
plugin=$3
output=$4
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
python3 -I "$root/app/scripts/prepare_appimage_launcher.py" "$appdir"
offset=$("$base" --appimage-offset)
case "$offset" in ''|*[!0-9]*) echo 'Invalid AppImage runtime offset' >&2; exit 1;; esac
[ "$offset" -gt 0 ] || exit 1
runtime=$(mktemp)
trap 'rm -f "$runtime"' EXIT
trap 'exit 1' HUP INT TERM
dd if="$base" of="$runtime" bs="$offset" count=1 status=none
ARCH=$(uname -m) LDAI_OUTPUT="$output" LDAI_RUNTIME_FILE="$runtime" APPIMAGE_EXTRACT_AND_RUN=1 \
    "$plugin" --appdir "$appdir"
