#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Run manually on the affected Linux machine; no application rebuild needed.
set -eu
if [ "$#" -ne 1 ]; then
    echo "Usage: sh $0 /path/to/Immage.AppImage" >&2
    exit 2
fi
image=$(realpath -- "$1")
[ -x "$image" ] || { echo "AppImage is not executable: $image" >&2; exit 1; }
# A private directory beside the terminal's working directory, not the model
# cache. The wrapper and its environment apply only to this diagnostic launch.
report=$(mktemp -d "$PWD/immage-ai-report.XXXXXX")
data="${XDG_DATA_HOME:-$HOME/.local/share}/app.immage"
export IMMAGE_AI_REPORT_DIR="$report"
cat > "$report/engine-debug.sh" <<'WRAPPER'
#!/bin/sh
set -eu
engine="${APPDIR:?AppImage did not set APPDIR}/usr/lib/Immage/darktable/bin/darktable-engine"
[ -x "$engine" ] || { echo "Cannot find packaged engine: $engine" >&2; exit 1; }
# Preserve stdin/stdout protocol; redirect stderr so the report captures the
# native AI failure even though the normal app only enables performance logs.
exec "$engine" "$@" -d ai 2>>"$IMMAGE_AI_REPORT_DIR/engine-ai.log"
WRAPPER
chmod 700 "$report/engine-debug.sh"
{
    date -u
    uname -m
    if [ -r /etc/os-release ]; then cat /etc/os-release; fi
    printf 'AppImage: %s\n' "$image"
    sha256sum "$image"
} > "$report/system.txt"
model_files() {
    model="$data/models/mask-object-sam21-small"
    ls -lh "$model" 2>&1 || :
    for name in config.json encoder.onnx decoder.onnx; do
        if [ -f "$model/$name" ]; then sha256sum "$model/$name"; fi
    done
    if [ -f "$model/config.json" ]; then cat "$model/config.json"; fi
}
model_files > "$report/model-before.txt"
printf '\nTry one Object mask, wait for the error, then close Immage.\n'
printf 'Avoid the in-app Relaunch during this diagnostic run.\n'
printf 'Report directory: %s\n\n' "$report"
status=0
DT_ENGINE_BIN="$report/engine-debug.sh" "$image" > "$report/launcher.log" 2>&1 || status=$?
printf 'App exit status: %s\n' "$status" >> "$report/system.txt"
model_files > "$report/model-after.txt"
if [ ! -s "$report/engine-ai.log" ]; then
    echo 'No AI engine log was captured; please include launcher.log for startup errors.' >&2
fi
tar -czf "$report.tar.gz" -C "$report" .
printf '\nAttach this report: %s.tar.gz\n' "$report"
