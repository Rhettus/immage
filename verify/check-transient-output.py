#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors
"""Non-GUI Linux transport/JPEG checks using a configured engine build."""
import json
from pathlib import Path
import shlex
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def run(args, **kwargs):
    subprocess.run(args, check=True, **kwargs)


def main():
    commands = json.loads((ROOT / "build/compile_commands.json").read_text())
    command = next(c for c in commands if c["file"].endswith("/engine/main.c"))
    flags = shlex.split(command["command"])
    output = flags.index("-o")
    del flags[output:output + 2]
    flags.remove("-c")
    run(flags + ["-fsyntax-only"], cwd=command["directory"])
    with tempfile.TemporaryDirectory(prefix="immage-output-check-") as work:
        binary = str(Path(work) / "transport")
        glib = shlex.split(subprocess.check_output(
            ["pkg-config", "--cflags", "--libs", "glib-2.0"], text=True))
        run(["cc", "-Wall", "-Wextra", "-Werror", str(ROOT / "verify/transient-output.c"),
             "-o", binary] + glib)
        run([binary])
        flags[flags.index(command["file"])] = str(ROOT / "verify/preview-jpeg.c")
        binary = str(Path(work) / "jpeg")
        libraries = shlex.split(subprocess.check_output(
            ["pkg-config", "--libs", "glib-2.0", "libjpeg"], text=True))
        run(flags + ["-o", binary, "-ffunction-sections", "-fdata-sections",
                     "-Wl,--gc-sections"] + libraries, cwd=command["directory"])
        run([binary])
    print("C syntax, transient byte transfer and JPEG preview checks passed")


if __name__ == "__main__":
    main()
