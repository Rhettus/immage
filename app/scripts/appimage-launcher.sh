#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Select the UI runtime before linuxdeploy can add bundled library paths.
set -eu
appdir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export APPDIR="$appdir"
mode=${IMMAGE_WEBKIT:-auto}
case "$mode" in auto|system|bundled) ;; *)
    echo "Immage: IMMAGE_WEBKIT must be auto, system or bundled" >&2; exit 2;; esac

# DISPLAY is also set under XWayland. An explicit, single GTK backend wins;
# ambiguous backend lists deliberately keep the bundled runtime.
backend=unknown
case "${GDK_BACKEND:-}" in
    x11|wayland) backend=$GDK_BACKEND ;;
    '') case "${XDG_SESSION_TYPE:-}" in
        x11|wayland) backend=$XDG_SESSION_TYPE ;;
        *) if [ -n "${WAYLAND_DISPLAY:-}" ]; then backend=wayland
           elif [ -n "${DISPLAY:-}" ]; then backend=x11; fi ;;
    esac ;;
esac
nvidia=no
for driver in /sys/class/drm/card*/device/driver; do
    if [ "$(basename "$(readlink "$driver" 2>/dev/null || :)" )" = nvidia ]; then
        nvidia=yes; break
    fi
done
[ ! -r /proc/driver/nvidia/version ] || nvidia=yes
selected=$mode
if [ "$mode" = auto ]; then
    selected=bundled
    if [ "$backend" = x11 ] && [ "$nvidia" = yes ]; then selected=system; fi
fi

# System mode uses the complete host UI dependency closure. Never source the
# GTK AppRun hook or inherit library/helper paths from another AppImage.
clean_host_env() {
    unset LD_LIBRARY_PATH LD_PRELOAD LD_AUDIT \
        WEBKIT_EXEC_PATH WEBKIT_INJECTED_BUNDLE_PATH \
        GTK_PATH GTK_EXE_PREFIX GTK_DATA_PREFIX GTK_IM_MODULE_FILE \
        GIO_MODULE_DIR GI_TYPELIB_PATH GSETTINGS_SCHEMA_DIR \
        GDK_PIXBUF_MODULE_FILE
}
host_env() (
    clean_host_env
    "$@"
)
check_elf() {
    output=$(host_env ldd -r "$1" 2>&1) || return 1
    case "$output" in *'not found'*|*'undefined symbol:'*|*"$appdir/usr/lib"*) return 1;; esac
}
reason='host libraries or frame extension are incompatible'
if [ "$selected" = system ]; then
    if check_elf "$appdir/usr/bin/immage-system" && \
       check_elf "$appdir/usr/lib/Immage/webext/libimmage-frames.so"; then
        # Derive the helper directory from the actual host WebKit library.
        webkit=$(host_env ldd "$appdir/usr/bin/immage-system" | \
            awk '$1 == "libwebkit2gtk-4.1.so.0" && $2 == "=>" {print $3}')
        helperdir=
        for candidate in "$(dirname "$webkit")/webkit2gtk-4.1" /usr/libexec/webkit2gtk-4.1; do
            if [ -x "$candidate/WebKitWebProcess" ] && \
               [ -x "$candidate/WebKitNetworkProcess" ] && \
               [ -f "$candidate/injected-bundle/libwebkit2gtkinjectedbundle.so" ] && \
               check_elf "$candidate/WebKitWebProcess" && \
               check_elf "$candidate/WebKitNetworkProcess" && \
               check_elf "$candidate/injected-bundle/libwebkit2gtkinjectedbundle.so"; then
                helperdir=$candidate; break
            fi
        done
        if [ -n "$helperdir" ]; then
            echo "Immage: WebKit=system backend=$backend NVIDIA=$nvidia library=$webkit" >&2
            export IMMAGE_WEBKIT_SELECTED=system
            # Freeze a detected backend so GTK cannot silently choose another.
            case "$backend" in x11|wayland) export GDK_BACKEND=$backend;; esac
            clean_host_env
            export WEBKIT_EXEC_PATH="$helperdir"
            export WEBKIT_INJECTED_BUNDLE_PATH="$helperdir/injected-bundle"
            exec "$appdir/usr/bin/immage-system" "$@"
        fi
        reason='matching host WebKit helpers are missing or incompatible'
    fi
    echo "Immage: system WebKit unavailable: $reason" >&2
    [ "$mode" != system ] || exit 1
    echo 'Immage: falling back to bundled WebKit' >&2
fi
export IMMAGE_WEBKIT_SELECTED=bundled
case "$backend" in x11|wayland) export GDK_BACKEND=$backend;; esac
echo "Immage: WebKit=bundled backend=$backend NVIDIA=$nvidia" >&2
exec "$appdir/AppRun.bundled" "$@"
