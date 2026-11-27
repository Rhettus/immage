#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

# make sure the SD card importer Immage builds against is in immporter/ at
# the commit app/immporter.rev pins: cloned when missing, checked out when
# it is elsewhere. immporter/ is gitignored (its own repo), so the pin is
# what keeps an older Immage commit buildable. its node packages are
# installed too, as type checking reads them
set -eu

root=$(cd "$(dirname "$0")/../.." && pwd)
repo=https://github.com/Rhettus/immporter
dir="$root/immporter"
patch="$root/patches/immporter-scan.patch"
rev=$(head -n 1 "$root/app/immporter.rev" | tr -cd '0-9a-f')
if [ -z "$rev" ]; then
  echo "app/immporter.rev names no commit" >&2
  exit 1
fi

if [ ! -d "$dir/.git" ] && [ ! -f "$dir/package.json" ]; then
  git clone "$repo" "$dir"
fi
# Stop at the archive's root when there is no importer Git checkout.
apply_patch() {
  GIT_CEILING_DIRECTORIES="$root" git -C "$dir" apply "$@" "$patch"
}
if [ -d "$dir/.git" ] &&
   [ "$(git -C "$dir" rev-parse HEAD)" != "$(git -C "$dir" rev-parse --verify "$rev^{commit}" 2>/dev/null || true)" ]; then
  if apply_patch --reverse --check 2>/dev/null; then
    apply_patch --reverse
  fi
  if [ -n "$(git -C "$dir" status --porcelain --untracked-files=no)" ]; then
    echo "immporter/ has uncommitted changes: leaving the revision as it is" >&2
  else
    git -C "$dir" cat-file -e "$rev^{commit}" 2>/dev/null || git -C "$dir" fetch origin
    git -C "$dir" checkout --detach "$rev"
  fi
fi
if ! apply_patch --reverse --check 2>/dev/null; then
  if apply_patch --check 2>/dev/null; then
    apply_patch
  elif [ -d "$dir/.git" ] && [ -n "$(git -C "$dir" status --porcelain --untracked-files=no)" ]; then
    echo "immporter/ has local edits that overlap the scan patch: preserving them" >&2
  else
    apply_patch
  fi
fi
# MSYS2's shell on Windows does not see Windows' Node; the npm step is then
# run from PowerShell (app/WINDOWS.md)
if [ ! -d "$dir/node_modules" ]; then
  if command -v npm >/dev/null 2>&1; then
    (cd "$dir" && npm ci)
  else
    echo "npm not found: run 'npm ci' in immporter/ before building the app" >&2
  fi
fi
