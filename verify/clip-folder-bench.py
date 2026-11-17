#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Benchmark cold and repeated engine metadata imports using disposable JPEGs.

The script copies the repository's ~3 MB sample JPEG into a temporary folder,
starts one isolated engine session, imports the folder's files in one batch,
then repeats the same batch in that session. It never clears OS caches; the
second pass may benefit from filesystem and engine caches. This measures only
the engine import/metadata path, not Tauri or frontend folder loading.

    python3 -I verify/clip-folder-bench.py [--count 100] [--engine PATH]
"""
import argparse
import importlib.util
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_engine_helper():
    path = ROOT / "verify/engine-0460.py"
    source = path.read_text()
    # Import the established isolated engine wrapper without running its tests.
    source = source.replace("sys.exit(main())", "")
    spec = importlib.util.spec_from_file_location("immage_engine_0460", path)
    module = importlib.util.module_from_spec(spec)
    exec(compile(source, str(path), "exec"), module.__dict__)
    return module.Engine


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--engine", type=Path, default=ROOT / "build/bin/darktable-engine")
    ap.add_argument("--count", type=int, default=100, help="disposable photo copies (default: 100)")
    args = ap.parse_args()
    binary = args.engine.resolve()
    if args.count < 1 or args.count > 10000:
        ap.error("--count must be between 1 and 10000")
    if not binary.is_file():
        ap.error(f"engine does not exist: {binary}")
    sample = ROOT / "app/sample/stairs-to-mountain.jpg"
    size = sample.stat().st_size
    Engine = load_engine_helper()

    with tempfile.TemporaryDirectory(prefix="immage-clip-folder-bench-") as tmp:
        work = Path(tmp)
        photos = work / "photos"
        photos.mkdir()
        files = []
        for i in range(args.count):
            dest = photos / f"photo-{i + 1:04}.jpg"
            shutil.copyfile(sample, dest)
            files.append(str(dest))

        start = time.perf_counter()
        engine = Engine(binary, work, [])
        try:
            ready = engine.ask(cmd="version")
            startup_seconds = time.perf_counter() - start
            if not ready.get("ok"):
                raise RuntimeError(f"engine startup failed: {ready}")

            def import_batch():
                t0 = time.perf_counter()
                reply = engine.ask(cmd="import", files=files)
                elapsed = time.perf_counter() - t0
                if not reply.get("ok"):
                    raise RuntimeError(f"engine import failed: {reply}")
                imported = len(reply.get("images", []))
                if imported != args.count:
                    raise RuntimeError(f"imported {imported}/{args.count} files")
                return elapsed

            cold = import_batch()
            repeated = import_batch()
        finally:
            engine.quit()

    report = {
        "benchmark": "engine-folder-metadata-import",
        "engine": str(binary),
        "photos": args.count,
        "jpeg_bytes_each": size,
        "input_bytes_total": size * args.count,
        "startup_seconds": round(startup_seconds, 6),
        "fresh_session_import_seconds": round(cold, 6),
        "same_session_repeat_seconds": round(repeated, 6),
        "fresh_session_photos_per_second": round(args.count / cold, 3),
        "same_session_repeat_photos_per_second": round(args.count / repeated, 3),
        "repeat_to_first_ratio": round(repeated / cold, 4),
        "os_caches_cleared": False,
        "scope": "engine import/metadata only; excludes Tauri and frontend folder loading",
    }
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
