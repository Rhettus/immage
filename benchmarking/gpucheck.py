#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""The app's GPU check reports (gpu-*.json) as Markdown: one table per machine
and darktable version, so reports sent back from several machines, or from
the old and the candidate darktable pin, can be read side by side. With
more than one report, a last table puts each case's own module time in the
GPU pass side by side: whether a module darktable moved to OpenCL got faster.

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


def op_of(label):
    # a module's second instance is timed as `contrastntexture.1`
    head, _, tail = label.rpartition(".")
    return head if head and tail.isdigit() else label


def op_ms(c, side):
    """The case's own module in one pass: (ms, ran on the GPU), or None."""
    op = c.get("op")
    mods = [m for m in ((c.get("parity") or {}).get("modules") or {}).get(side) or []
            if m.get("kind") == "module" and op and op_of(m.get("label", "")) == op]
    if not mods:
        return None
    return sum(m.get("ms", 0) for m in mods), all(m.get("gpu") for m in mods)


def _op_cell(v, gpu=True):
    # in the GPU pass, a module darktable kept on the CPU says so
    return "" if v is None else f"{v[0]:.0f}" + (" (CPU)" if gpu and not v[1] else "")


def build(r):
    # the commit perf_report_write (main.rs) adds; none outside Git
    b = r.get("build") or {}
    return f" `{b['commit'][:10]}`" + ("-dirty" if b.get("dirty") else "") if b.get("commit") else ""


def markdown(reports):
    L = []
    for r in reports:
        m = r.get("machine") or {}
        app = r.get("app") or {}
        before = (r.get("opencl") or {}).get("before") or {}
        after = (r.get("opencl") or {}).get("after") or {}
        L += [f"### `{r['id']}`: {r.get('passed', 0)} of {r.get('total', 0)} passed", "",
              f"{m.get('host') or '?'} ({m.get('os') or '?'}, {m.get('cpu') or '?'}, id {m.get('id') or '?'}); "
              f"Immage {app.get('app') or '?'}{build(r)}, darktable {app.get('darktable') or '?'}; device {device(r)}; "
              f"photo {r.get('photo')}; OpenCL errors {before.get('error_count', '?')} → {after.get('error_count', '?')}"
              + ("; **OpenCL stopped for the session**" if after.get("stopped") else "")
              + (f"; {r['error']}" if r.get("error") else "") + ".", ""]
        devs = after.get("devices") or []
        for d in devs:
            mb = lambda v: f"{v / 2**20:.0f} MB" if isinstance(v, (int, float)) else "?"
            # reports before the fix carry a 0 that darktable never counted
            peak = mb(d["peak_memory"]) if d.get("peak_memory") else "not tracked"
            L.append(f"- {d.get('name')}: {d.get('version')}, {mb(d.get('max_global_mem'))}, "
                     f"peak {peak}, programs {d.get('programs', '?')}, kernels {d.get('kernels', '?')}"
                     + (", unified memory" if d.get("unified_memory") else "") + (", disabled" if d.get("disabled") else ""))
        if devs:
            L.append("")
        L += ["| case | result | dE p99 | dE max | >dE 2 | CPU ms | GPU ms | module CPU ms | module GPU ms "
              "| on CPU in the GPU pass | notes |",
              "|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|"]
        rows = list(r.get("cases", []))
        if r.get("cancel"):
            rows.append({"label": "after a canceled GPU base", **r["cancel"]})
        for c in rows:
            if c.get("skipped"):
                L.append(f"| {c['label']} | skipped | | | | | | | | | {c['skipped']} |")
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
                     f"{_op_cell(op_ms(c, 'cpu'), False)} | {_op_cell(op_ms(c, 'gpu'))} | "
                     f"{', '.join(c.get('cpuModules') or [])} | {'; '.join(notes)} |")
        L.append("")
    if len(reports) > 1:
        L += compare(reports)
    return "\n".join(L)


def compare(reports):
    """Each case's own module in the GPU pass, one column per report: the old
    and the candidate darktable pin on one machine, or several machines."""
    ids = [c["id"] for c in reports[-1].get("cases", []) if c.get("op")]
    for r in reports:
        ids += [c["id"] for c in r.get("cases", []) if c.get("op") and c["id"] not in ids]
    by = [{c["id"]: c for c in r.get("cases", [])} for r in reports]
    L = ["### The case's module in the GPU pass (ms)", "",
         "| case | " + " | ".join(f"`{r['id']}` darktable {(r.get('app') or {}).get('darktable') or '?'}"
                                  for r in reports) + " |",
         "|---|" + "---:|" * len(reports)]
    for i in ids:
        label = next(b[i]["label"] for b in by if i in b)
        L.append(f"| {label} | " + " | ".join(_op_cell(op_ms(b[i], "gpu")) if i in b and not b[i].get("skipped")
                                              else "–" for b in by) + " |")
    return L + [""]


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
