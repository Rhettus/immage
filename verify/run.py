#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

# the checks to pass before a release is tagged (app/docs/dev/releasing.md):
# every slider of every panel and of a mask moved through the app's own
# Session and the engine, the frame each makes measured (harness.mjs), and
# the engine benchmark's main scenarios timed against the last such run.
#   python3 -I verify/run.py                 about 5 minutes
#   python3 -I verify/run.py --skip-perf     the checks alone
#   python3 -I verify/run.py --accept        and keep this build's edit as the reference
# exits 1 when anything failed; the report is in verify/results/<run>/
import argparse
import datetime
import glob
import json
import os
import platform
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
WORK = os.path.join(REPO, "build", "verify-work")
CHECKS = ["sliders", "masks", "choices", "fixes", "decisions", "roundtrip", "reference"]
# not DNG: one from a raw converter (DxO's) is already demosaiced, without
# the raw-only tools; --images can still pick one
RAW_EXT = {".cr2", ".cr3", ".nef", ".arw", ".raf", ".orf", ".rw2", ".pef", ".srw"}

# the timing check: a step whose fastest sample is slower than the last
# verify run's by more than this percent, and by more than FLOOR_MS, fails.
# the fastest, as the median of a few samples moves by up to 40% from run
# to run on an idle machine
PERF_SCENARIOS = "sliders,roi,masks"
FAIL_OVER = 25
FLOOR_MS = 5


def git(*a):
    return subprocess.run(["git", *a], cwd=REPO, capture_output=True, text=True).stdout.strip()


def pick(corpus, names):
    """the largest raw and the smallest raw of another camera: the most and
    fewest pixels. the JPEG and TIFF the checks also take are exported from the
    second (harness.mjs, rendered), as a camera's own JPEG can be black and
    white"""
    files = sorted(f for f in glob.glob(os.path.join(corpus, "*")) if os.path.isfile(f))
    if names:
        return [f for f in files if any(n in os.path.basename(f) for n in names)]
    raws = sorted((f for f in files if os.path.splitext(f)[1].lower() in RAW_EXT), key=os.path.getsize)
    out = []
    if raws:
        out.append(raws[-1])
        other = [f for f in raws if os.path.splitext(f)[1].lower() != os.path.splitext(raws[-1])[1].lower()]
        if other or len(raws) > 1:
            out.append((other or raws)[0])
    return out


def engine_age(binary):
    """a warning when the engine is older than the last change to what it is
    built from"""
    if not os.path.exists(binary):
        sys.exit(f"no engine at {binary}: run `cmake --build build` first")
    sources = [p for d in ("engine", "patches") for p in glob.glob(os.path.join(REPO, d, "*")) if os.path.isfile(p)]
    changed = max([os.path.getmtime(p) for p in sources]
                  + [int(git("-C", "darktable", "log", "-1", "--format=%ct") or 0)])
    if os.path.getmtime(binary) < changed:
        print(f"warning: {os.path.relpath(binary, REPO)} is older than the last change to engine/, patches/ or "
              "darktable/: run `cmake --build build` to test what will ship", file=sys.stderr)


def harness(args, photos, out):
    request = {
        "engine": os.path.abspath(args.engine), "work": WORK, "photos": photos, "checks": args.checks,
        "rendered": None if args.images else photos[-1],
        "controls": args.controls, "references": os.path.join(HERE, "references"), "accept": args.accept,
        "git": git("rev-parse", "--short", "HEAD"), "out": out,
        # the dev build's AI models, for the check that installs one again
        "models": os.path.join(REPO, "build", "ai-models"),
    }
    r = subprocess.run(["node", os.path.join(HERE, "harness.mjs"), json.dumps(request)], cwd=REPO)
    if r.returncode != 0 or not os.path.exists(out):
        sys.exit("the harness stopped; see its output above")
    with open(out) as f:
        return json.load(f)


def perf(args, photos, folder):
    """the benchmark's main scenarios on the CPU and on the app's GPU engine,
    compared with the last verify run of the same photos on this machine:
    (status, markdown)"""
    results = os.path.join(REPO, "benchmarking", "results")
    before = set(glob.glob(os.path.join(results, "*", "run.json")))
    names = ",".join(os.path.basename(p) for p in photos if os.path.exists(p))
    r = subprocess.run([sys.executable, "-I", os.path.join(REPO, "benchmarking", "bench.py"), "--engine", args.engine,
                        "--corpus", args.corpus, "--images", names, "--only", PERF_SCENARIOS, "--opencl", "app",
                        "--repeat", str(args.repeat), "--no-perf-overhead", "--note", "verify"], cwd=REPO)
    if r.returncode != 0:
        return "fail", "the benchmark stopped; see its output above\n"
    new = sorted(set(glob.glob(os.path.join(results, "*", "run.json"))) - before)
    if not new:
        return "fail", "the benchmark wrote no run\n"
    shutil.copy(new[-1], os.path.join(folder, "perf-run.json"))
    c = subprocess.run([sys.executable, "-I", os.path.join(REPO, "benchmarking", "compare.py"), "--note", "verify", "--stat", "min",
                        "--threshold", str(FAIL_OVER), "--floor", str(FLOOR_MS), "--fail-over", str(FAIL_OVER)],
                       cwd=REPO, capture_output=True, text=True)
    if "no earlier run" in c.stderr + c.stdout:
        return "skip", "the first verify run of these photos on this machine: recorded, nothing to compare with\n"
    return ("fail" if c.returncode else "pass"), c.stdout


def report(folder, args, photos, checks, perf_result, minutes):
    summary = checks["summary"] if checks else []
    failed = [s for s in summary if s["status"] == "fail"]
    passed = [s for s in summary if s["status"] == "pass"]
    skipped = [s for s in summary if s["status"] == "skip"]
    # the harness adds the JPEG it exports
    shown = sorted({r["photo"] for r in checks["results"]}) if checks else [os.path.basename(p) for p in photos]
    lines = [f"# Release checks, {git('rev-parse', '--short', 'HEAD')}", "",
             f"{datetime.datetime.now().astimezone():%Y-%m-%d %H:%M}, {platform.node().split('.')[0]}, "
             f"{minutes:.0f} minutes. Photos: {', '.join(shown)}.", ""]
    if checks:
        lines += [f"**Checks:** {len(passed)} passed, {len(failed)} failed, {len(skipped)} not run.", ""]
        if failed:
            lines += ["## Failed", "", "| check | control | what happened |", "|---|---|---|"]
            lines += [f"| {s['check']} | {s['id']} | {s['detail'].replace('|', '/')} |" for s in failed]
            lines.append("")
        if skipped:
            lines += ["## Not run", "", "| check | control | why |", "|---|---|---|"]
            seen = set()
            for s in skipped:
                if (s["detail"], s["check"]) in seen and s["detail"].startswith("covered"):
                    continue
                seen.add((s["detail"], s["check"]))
                lines.append(f"| {s['check']} | {s['id']} | {s['detail']} |")
            lines.append("")
    if perf_result:
        status, text = perf_result
        lines += [f"## Timing: {status}", "",
                  f"Steps whose fastest sample is more than {FAIL_OVER}% and {FLOOR_MS} ms slower than "
                  "the last verify run's fail.", "", text]
    with open(os.path.join(folder, "report.md"), "w") as f:
        f.write("\n".join(lines) + "\n")
    return failed


def main():
    ap = argparse.ArgumentParser(description="the checks to pass before tagging a release")
    ap.add_argument("--engine", default=os.path.join(REPO, "build", "bin", "darktable-engine"))
    ap.add_argument("--corpus", default=os.path.join(REPO, "benchmarking", "corpus"))
    ap.add_argument("--images", default="", help="photos whose names contain these, comma separated")
    ap.add_argument("--checks", default=",".join(CHECKS), help=f"some of {','.join(CHECKS)}")
    ap.add_argument("--controls", default="", help="only these controls, by id, comma separated")
    ap.add_argument("--skip-perf", action="store_true", help="leave out the timing check")
    ap.add_argument("--repeat", type=int, default=5, help="the benchmark's samples per step (default 5)")
    ap.add_argument("--accept", action="store_true",
                    help="keep this build's saved edit and frame as the reference later builds must match")
    args = ap.parse_args()
    args.checks = [c for c in args.checks.split(",") if c]
    args.controls = [c for c in args.controls.split(",") if c]
    engine_age(args.engine)
    photos = pick(args.corpus, [n for n in args.images.split(",") if n])
    if not photos:
        sys.exit(f"no photos in {args.corpus}")

    t0 = time.time()
    folder = os.path.join(HERE, "results", f"{datetime.datetime.now():%Y-%m-%d_%H%M}_{git('rev-parse', '--short', 'HEAD')}")
    os.makedirs(folder, exist_ok=True)
    shutil.rmtree(WORK, ignore_errors=True)
    os.makedirs(WORK)
    checks = harness(args, photos, os.path.join(folder, "report.json")) if args.checks else None
    perf_result = None if args.skip_perf else perf(args, photos, folder)
    failed = report(folder, args, photos, checks, perf_result, (time.time() - t0) / 60)

    print(f"\nreport: {os.path.relpath(os.path.join(folder, 'report.md'), REPO)}")
    bad = len(failed) + (perf_result is not None and perf_result[0] == "fail")
    for s in failed:
        print(f"  FAIL {s['check']} {s['id']}: {s['detail'][:160]}")
    if perf_result and perf_result[0] == "fail":
        print("  FAIL timing: see the report")
    print("passed" if not bad else f"{bad} failed")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
