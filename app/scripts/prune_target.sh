#!/bin/sh
# remove what cargo leaves behind in app/src-tauri/target and never removes
# itself: the object files of earlier builds, test executables of earlier
# builds and incremental caches nothing uses any more. on macOS the dev
# profile keeps every build's .rcgu.o next to the binary for the debugger
# (split-debuginfo = "unpacked"), so they pile up by gigabytes a day.
#
#   app/scripts/prune_target.sh [-n] [days]
#
# removes what has not been touched for <days> days (default 3); -n lists
# what would go and removes nothing. cargo does not track the object files,
# so removing them never causes a rebuild; it only drops the debug info of
# binaries built before the cutoff. an executable or incremental cache that
# was still current costs one rebuild of that crate
set -eu

dry=0
if [ "${1:-}" = "-n" ]; then
  dry=1
  shift
fi
days=${1:-3}
case $days in
  ''|*[!0-9]*) echo "usage: $0 [-n] [days]" >&2; exit 2 ;;
esac

root=$(cd "$(dirname "$0")/../.." && pwd)
target="$root/app/src-tauri/target"
if [ ! -d "$target" ]; then
  echo "nothing to prune: $target does not exist"
  exit 0
fi

# the profile folders (debug, release), without cargo's own top-level files
set --
for profile in "$target"/*/; do
  [ -d "${profile}deps" ] && set -- "$@" "${profile%/}"
done
if [ $# -eq 0 ]; then
  echo "nothing to prune in $target"
  exit 0
fi

# prints, or removes, what find selects
prune() {
  if [ "$dry" -eq 1 ]; then
    find "$@" -print
  else
    find "$@" -exec rm -rf {} +
  fi
}

before=$(du -sk "$target" | cut -f1)

for profile in "$@"; do
  prune "$profile/deps" -type f -name '*.rcgu.o' -mtime +"$days"
  # test executables: a binary cargo still runs as target/<profile>/<name>
  # is a second link to the file, so files with only one link are the ones
  # nothing points at
  prune "$profile/deps" -type f -name '*-????????????????' -perm -u+x \
    -links 1 -mtime +"$days"
  [ -d "$profile/incremental" ] &&
    prune "$profile/incremental" -mindepth 1 -maxdepth 1 -type d -mtime +"$days"
done

if [ "$dry" -eq 0 ]; then
  after=$(du -sk "$target" | cut -f1)
  echo "freed $(( (before - after) / 1024 )) MB; target is now $(( after / 1024 )) MB"
fi
