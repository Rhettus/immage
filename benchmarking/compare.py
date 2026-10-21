#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

# two benchmark runs side by side: what got faster or slower, as markdown.
#   python3 -I benchmarking/compare.py                 the last two runs
#   python3 -I benchmarking/compare.py OLD NEW         run folders (or run.json files)
#   ... --note verify --fail-over 20   only runs with that note; exit 1 when
#                                       a step slowed by more than 20%
# a step counts as changed when its median moved by more than --threshold
# percent (10 by default, as src/tests/integration/check-performance uses)
# and by more than --floor ms, so a 2 ms step's noise is not news.
# --stat min judges the fastest sample instead, which a busy moment on the
# machine cannot move: with few samples the median can shift by a third
import argparse
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def runs(results=os.path.join(HERE, "results")):
    """run folders, oldest first"""
    return sorted(os.path.dirname(p) for p in glob.glob(os.path.join(results, "*", "run.json")))


def same_corpus(a, b):
    return sorted(c["sha256"] for c in a["corpus"]) == sorted(c["sha256"] for c in b["corpus"])


def same_machine(a, b):
    return a["env"].get("machine_id") == b["env"].get("machine_id")


def previous(earlier, run):
    """the latest of the earlier runs that used the same photos on the same
    machine"""
    return next((r for r in reversed(earlier) if same_corpus(r, run) and same_machine(r, run)), None)


def load(path):
    if os.path.isdir(path):
        path = os.path.join(path, "run.json")
    with open(path) as f:
        run = json.load(f)
    run["id"] = os.path.basename(os.path.dirname(os.path.abspath(path)))
    return run


def metric(rec, stat="p50"):
    """the number a step is judged by: a module's own time in the module
    comparison, the request's wall time elsewhere"""
    m = rec.get("own_ms") if rec["scenario"] == "modules" else rec.get("wall_ms")
    return m[stat] if m else None


def key(rec):
    return (rec["mode"], rec["image"], rec["scenario"], rec["step"])


def diff(old, new, threshold=10.0, floor=2.0, stat="p50"):
    """rows for every step both runs have: (key, old ms, new ms, change %, verdict)"""
    before = {key(r): metric(r, stat) for r in old["records"]}
    rows = []
    for r in new["records"]:
        k = key(r)
        a, b = before.get(k), metric(r, stat)
        if a is None or b is None:
            continue
        pct = 100.0 * (b - a) / a if a else 0.0
        verdict = "same"
        if abs(pct) > threshold and abs(b - a) > floor:
            verdict = "slower" if b > a else "faster"
        rows.append((k, a, b, pct, verdict))
    return rows


def markdown(old, new, rows, limit=25):
    out = [f"Comparing `{old['id']}` (before) with `{new['id']}` (after).", ""]
    slower = sorted((r for r in rows if r[4] == "slower"), key=lambda r: -r[3])
    faster = sorted((r for r in rows if r[4] == "faster"), key=lambda r: r[3])
    out.append(f"{len(rows)} steps in both runs: {len(faster)} faster, {len(slower)} slower, "
               f"{len(rows) - len(faster) - len(slower)} unchanged.")
    for title, part in (("Slower", slower), ("Faster", faster)):
        if not part:
            continue
        out += ["", f"### {title}", "", "| mode | photo | scenario | step | before ms | after ms | change |",
                "|---|---|---|---|---:|---:|---:|"]
        for (mode, image, scen, step), a, b, pct, _ in part[:limit]:
            out.append(f"| {mode} | {image} | {scen} | {step} | {a:.1f} | {b:.1f} | {pct:+.0f}% |")
        if len(part) > limit:
            out.append(f"| | | | ...and {len(part) - limit} more | | | |")
    return "\n".join(out) + "\n"


def main():
    ap = argparse.ArgumentParser(description="compare two benchmark runs")
    ap.add_argument("old", nargs="?")
    ap.add_argument("new", nargs="?")
    ap.add_argument("--threshold", type=float, default=10.0, help="percent (default 10)")
    ap.add_argument("--floor", type=float, default=2.0, help="ms below which a change is noise (default 2)")
    ap.add_argument("--note", help="only runs made with this --note")
    ap.add_argument("--fail-over", type=float, help="exit 1 when a step slowed by more than this percent")
    ap.add_argument("--stat", choices=["p50", "min"], default="p50",
                    help="each step's median (default) or fastest sample")
    args = ap.parse_args()
    if args.old and args.new:
        old, new = load(args.old), load(args.new)
    else:
        all_runs = [r for r in map(load, runs()) if args.note is None or r["env"].get("note") == args.note]
        if not all_runs:
            sys.exit("no runs in benchmarking/results/")
        new = all_runs[-1]
        old = previous(all_runs[:-1], new)
        if not old:
            sys.exit("no earlier run used the same photos; name two runs to compare them anyway")
    rows = diff(old, new, args.threshold, args.floor, args.stat)
    sys.stdout.write(markdown(old, new, rows))
    if args.fail_over is not None and any(r[4] == "slower" and r[3] > args.fail_over for r in rows):
        sys.exit(1)


if __name__ == "__main__":
    main()
