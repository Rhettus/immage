#!/bin/sh
# apply patches/darktable-engine.patch to the darktable submodule, once:
# darktable has no hook for building a target from outside its tree, so the
# patch adds the engine as a subdirectory of its src/ (where it inherits
# darktable's include paths and flags) when IMMAGE_ROOT is set
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
patch="$root/patches/darktable-engine.patch"
if git -C "$root/darktable" apply --reverse --check "$patch" 2>/dev/null; then
  exit 0
fi
git -C "$root/darktable" apply "$patch"
