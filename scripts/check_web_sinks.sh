#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

# fails when the front end uses an HTML or code injection sink: innerHTML,
# dangerouslySetInnerHTML, eval(, new Function and document.write. with no
# arguments it checks app/src and immporter/src (when present); otherwise
# the directories given. node_modules is skipped
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
if [ $# -eq 0 ]; then
  set -- "$root/app/src"
  [ -d "$root/immporter/src" ] && set -- "$@" "$root/immporter/src"
fi

pattern='\binnerHTML\b|\bouterHTML\b|\bdangerouslySetInnerHTML\b|\beval[[:space:]]*\(|\bnew[[:space:]]+Function\b|\bdocument\.write(ln)?\b'
if grep -rnE --exclude-dir=node_modules --include='*.ts' --include='*.tsx' --include='*.js' \
     --include='*.jsx' --include='*.mjs' --include='*.html' "$pattern" "$@"; then
  echo "web sink found: use text nodes or React elements instead" >&2
  exit 1
fi
echo "no web sinks in: $*"
