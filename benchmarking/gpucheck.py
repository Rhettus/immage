#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""The app's GPU check reports (gpu-*.json) as Markdown: one table per machine
and darktable version, so reports sent back from several machines, or from
the old and the candidate darktable pin, can be read side by side.

    python3 -I benchmarking/gpucheck.py                      # results/gui/gpu-*.json
    python3 -I benchmarking/gpucheck.py a.json b.json        # reports sent back
"""
import argparse
import glob
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
GUI = os.path.join(HERE, "results", "gui")


def load(paths):
    out = []
    for p in paths:
        try:
            with open(p) as f:
                r = json.load(f)
        except (OSError, ValueError):
            continue
        if r.get("immage") == "gpu-check":
            r["id"] = os.path.splitext(os.path.basename(p))[0]
            out.append(r)
    return sorted(out, key=lambda r: r.get("at", ""))


def _n(v, digits=2):
    return "–" if v is None else f"{v:.{digits}f}"


def device(r):
    for c in r.get("cases", []):
        d = (c.get("parity") or {}).get("gpu", {}).get("device")
        if d:
            return d
    devs = ((r.get("opencl") or {}).get("before") or {}).get("devices") or []
    return ", ".join(d.get("name", "?") for d in devs) or "none"


def markdown(reports):
    L = []
    for r in reports:
        m = r.get("machine") or {}
        app = r.get("app") or {}
        before = (r.get("opencl") or {}).get("before") or {}
        after = (r.get("opencl") or {}).get("after") or {}
        L += [f"### `{r['id']}`: {r.get('passed', 0)} of {r.get('total', 0)} passed", "",
              f"{m.get('host') or '?'} ({m.get('os') or '?'}, {m.get('cpu') or '?'}, id {m.get('id') or '?'}); "
              f"Immage {app.get('app') or '?'}, darktable {app.get('darktable') or '?'}; device {device(r)}; "
              f"photo {r.get('photo')}; OpenCL errors {before.get('error_count', '?')} → {after.get('error_count', '?')}"
              + ("; **OpenCL stopped for the session**" if after.get("stopped") else "")
              + (f"; {r['error']}" if r.get("error") else "") + ".", ""]
        devs = after.get("devices") or []
        for d in devs:
            mb = lambda v: f"{v / 2**20:.0f} MB" if isinstance(v, (int, float)) else "?"
            L.append(f"- {d.get('name')}: {d.get('version')}, {mb(d.get('max_global_mem'))}, "
                     f"peak {mb(d.get('peak_memory'))}, programs {d.get('programs', '?')}, kernels {d.get('kernels', '?')}"
                     + (", unified memory" if d.get("unified_memory") else "") + (", disabled" if d.get("disabled") else ""))
        if devs:
            L.append("")
        L += ["| case | result | dE p99 | dE max | >dE 2 | CPU ms | GPU ms | on CPU in the GPU pass | notes |",
              "|---|---|---:|---:|---:|---:|---:|---|---|"]
        rows = list(r.get("cases", []))
        if r.get("cancel"):
            rows.append({"label": "after a canceled GPU base", **r["cancel"]})
        for c in rows:
            if c.get("skipped"):
                L.append(f"| {c['label']} | skipped | | | | | | | {c['skipped']} |")
                continue
            p = c.get("parity") or {}
            de = p.get("de") or {}
            res = "pass" if c.get("pass") else "**fail**"
            notes = [*c.get("reasons", []), *c.get("notes", [])]
            if c.get("error") and str(c["error"]) not in notes:
                notes.append(str(c["error"]))
            L.append(f"| {c['label']} | {res} | {_n(de.get('p99'))} | {_n(de.get('max'))} | "
                     f"{_n(de['over2'] * 100, 1) + '%' if de.get('over2') is not None else '–'} | "
                     f"{_n((p.get('cpu') or {}).get('ms'), 0)} | {_n((p.get('gpu') or {}).get('ms'), 0)} | "
                     f"{', '.join(c.get('cpuModules') or [])} | {'; '.join(notes)} |")
        L.append("")
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("reports", nargs="*", help="gpu-*.json files (default benchmarking/results/gui/gpu-*.json)")
    args = ap.parse_args()
    reports = load(args.reports or glob.glob(os.path.join(GUI, "gpu-*.json")))
    if not reports:
        raise SystemExit("no GPU check reports")
    print(markdown(reports))


if __name__ == "__main__":
    main()
