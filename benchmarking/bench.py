#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

# Immage's benchmark: drives darktable-engine headless, the way the app does,
# over a corpus of photos, and records one run under benchmarking/results/.
# standard library only; run it as `python3 -I benchmarking/bench.py`.
# see benchmarking/README.md for the scenarios and how to read the results
import argparse
import datetime
import glob
import hashlib
import json
import os
import platform
import shutil
import statistics
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
WORK = os.path.join(REPO, "build", "bench-work")
SCHEMA = 1

# what the app asks for: a 2560 x 1600 viewer (MAX_PREVIEW caps a side at
# 2560, App.tsx), half that while a slider drags (DRAFT), and the idle base
# at twice the viewer, capped at 3072 (baseSize)
VIEW = (2560, 1600)
DRAFT = (1280, 800)
BASE = (3072, 3072)
# left out of a drag's frames unless the drag is of one of them (DRAFT_SKIP
# and draftKeep, app/src/session.ts)
DRAFT_SKIP = ["grain", "diffuse", "sharpen"]
# the app's engine since the base pipe: OpenCL on, but only export's pipe
# type may use the GPU, which the base borrows (app/src-tauri/src/engine.rs)
SPLIT = ["--conf", "opencl_device_priority=//*//"]


def mode_engine(mode):
    """an Engine's opencl and extra arguments for a mode: cpu, opencl
    (every pipe may use the GPU) or split (the app's)"""
    return mode != "cpu", SPLIT if mode == "split" else []


# the long-drag scenario: frames in a drag, well past the 30 or so that
# once pushed the release's earlier modules out of the main pipe's cache,
# and drags per arm
LONG_DRAG = 40
LONG_DRAG_REPS = 3

# the Performance preview: quarter-size drags that also skip denoise and HSL
DRAFT_PERF = (640, 400)
DRAFT_SKIP_PERF = DRAFT_SKIP + ["denoiseprofile", "colorequal"]

RAW_EXT = {".cr2", ".cr3", ".crw", ".nef", ".nrw", ".arw", ".srf", ".sr2", ".raf", ".orf", ".rw2", ".pef",
           ".dng", ".3fr", ".iiq", ".x3f", ".srw", ".erf", ".kdc", ".mrw", ".raw", ".rwl"}
IMG_EXT = RAW_EXT | {".jpg", ".jpeg", ".tif", ".tiff", ".png", ".heic", ".heif", ".avif", ".jxl", ".webp", ".exr"}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


class Engine:
    """one darktable-engine; each request comes back with darktable's -d perf
    timings for it, cut out of stderr between its own start line and a mark
    request after it, as app/src-tauri/src/engine.rs does"""

    def __init__(self, binary, home, opencl, perf=True, extra=()):
        os.makedirs(home, exist_ok=True)
        args = [binary, "--core", "--configdir", os.path.join(home, "config"), "--cachedir", os.path.join(home, "cache"),
                "--conf", f"opencl={'true' if opencl else 'false'}", *extra]
        if perf:
            args += ["-d", "perf"]
        self.log = open(os.path.join(home, "engine.log"), "a")
        self.p = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  text=True, bufsize=1)
        self.perf = perf
        self.cv = threading.Condition()
        self.current, self.last, self.marks = [], [], 0
        self.lines = []  # every stderr line, for OpenCL device detection
        threading.Thread(target=self._stderr, daemon=True).start()

    def _stderr(self):
        for line in self.p.stderr:
            line = line.rstrip("\n")
            self.log.write(line + "\n")
            with self.cv:
                if len(self.lines) < 20000:
                    self.lines.append(line)
                if line.startswith("[engine] > "):
                    if '"perf_mark"' in line:
                        self.last, self.current = self.current, []
                        self.marks += 1
                        self.cv.notify_all()
                    else:
                        self.current = []
                    continue
                t = parse_timing(line)
                if t:
                    self.current.append(t)

    def raw(self, req):
        self.p.stdin.write(json.dumps(req) + "\n")
        self.p.stdin.flush()
        line = self.p.stdout.readline()
        if not line:
            raise RuntimeError(f"engine exited during {req.get('cmd')}; see {self.log.name}")
        return json.loads(line)

    def req(self, **req):
        """the reply, its wall time in ms, and darktable's timings"""
        t0 = time.perf_counter()
        r = self.raw(req)
        wall = (time.perf_counter() - t0) * 1000
        if not r.get("ok"):
            raise RuntimeError(f"engine {req.get('cmd')}: {r.get('error')}")
        timings = []
        if self.perf:
            with self.cv:
                seen = self.marks
            self.raw({"cmd": "version", "perf_mark": seen + 1})
            with self.cv:
                self.cv.wait_for(lambda: self.marks > seen, timeout=2)
                timings = list(self.last)
        return r, wall, timings

    def close(self):
        try:
            self.raw({"cmd": "quit"})
            self.p.wait(timeout=60)
        except Exception:
            self.p.kill()
        self.log.close()


def parse_timing(line):
    """darktable's -d perf line: "  1.62 [dev_pixelpipe] took 0.004 secs (0.018 CPU) [full] processed `op' on CPU" """
    if " took " not in line or " secs (" not in line:
        return None
    try:
        rest = line.split(" took ", 1)[1]
        secs, rest = rest.split(" secs (", 1)
        cpu, tail = rest.split(" CPU)", 1)
        ms, cpu_ms = float(secs) * 1000, float(cpu) * 1000
    except ValueError:
        return None
    tail = tail.strip()
    if "processed `" in tail:
        label = tail.split("processed `", 1)[1].split("'", 1)[0]
        kind = "module"
        pipe = tail[1:].split("]", 1)[0] if tail.startswith("[") else ""
    elif "transform_image_colorspace" in line:
        label = "colorspace for " + tail.rsplit("[", 1)[-1].rstrip("]")
        kind, pipe = "colorspace", ""
    else:
        label, kind, pipe = tail, "other", ""
    return {"label": label, "kind": kind, "ms": ms, "cpu_ms": cpu_ms, "pipe": pipe,
            "gpu": " on GPU" in tail, "tiled": "with tiling" in tail}


class Edits:
    """Immage's control mapping (lib/edits.mjs, from app/src/manifest.ts)"""

    def __init__(self):
        self.p = subprocess.Popen(["node", os.path.join(HERE, "lib", "edits.mjs")], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, text=True, bufsize=1)

    def call(self, **req):
        self.p.stdin.write(json.dumps(req) + "\n")
        self.p.stdin.flush()
        r = json.loads(self.p.stdout.readline())
        if not r.get("ok"):
            raise RuntimeError(f"edits {req.get('cmd')}: {r.get('error')}")
        return r

    def close(self):
        self.p.stdin.close()
        self.p.wait(timeout=10)


def stats(xs):
    xs = [x for x in xs if x is not None]
    if not xs:
        return None
    s = sorted(xs)
    return {"p50": round(statistics.median(s), 3), "p95": round(s[min(len(s) - 1, int(0.95 * len(s)))], 3),
            "min": round(s[0], 3), "max": round(s[-1], 3), "n": len(s)}


def module_ms(timings):
    """per module (and colorspace conversion) ms, summed over instances"""
    out = {}
    for t in timings:
        if t["kind"] == "other":
            continue
        out[t["label"]] = out.get(t["label"], 0.0) + t["ms"]
    return out


class Recorder:
    def __init__(self):
        self.records = []

    def add(self, mode, image, scenario, step, samples, extra=None):
        """samples: dicts of wall, process, write, set and modules (op -> ms)"""
        mods = {}
        for s in samples:
            for k, v in s.get("modules", {}).items():
                mods.setdefault(k, []).append(v)
        rec = {
            "mode": mode, "image": image, "scenario": scenario, "step": step,
            "wall_ms": stats([s.get("wall") for s in samples]),
            "process_ms": stats([s.get("process") for s in samples]),
            "write_ms": stats([s.get("write") for s in samples]),
            "set_ms": stats([s.get("set") for s in samples]),
            "recomputed": stats([s.get("recomputed") for s in samples]),
            "gpu_modules": sorted({k for s in samples for k in s.get("gpu", [])}),
            "tiled_modules": sorted({k for s in samples for k in s.get("tiled", [])}),
            "modules_ms": {k: round(statistics.median(v), 3) for k, v in sorted(mods.items())},
        }
        if extra:
            rec.update(extra)
        self.records.append(rec)
        w = rec["wall_ms"]
        log(f"  {mode:6} {scenario:10} {step:28} wall p50 {w['p50'] if w else '-':>8} ms"
            + (f"  pipe {rec['process_ms']['p50']:.1f}" if rec["process_ms"] else ""))
        return rec


def render_sample(eng, size, scale=None, x=0, y=0, rgba=None, draft=False, skip=None, base=False):
    req = {"cmd": "render", "width": size[0], "height": size[1]}
    if draft:
        req["draft"] = True
    if base:
        req["base"] = True
    if skip:
        req["skip"] = skip
    if scale:
        req.update(scale=scale, x=x, y=y)
    if rgba:
        req["rgba"] = rgba
    r, wall, timings = eng.req(**req)
    mods = [t for t in timings if t["kind"] == "module"]
    return {"wall": wall, "process": r.get("process_ms"), "write": r.get("write_ms"), "modules": module_ms(timings),
            "recomputed": len(mods), "gpu": [t["label"] for t in mods if t["gpu"]],
            "tiled": [t["label"] for t in mods if t["tiled"]], "w": r.get("width"), "h": r.get("height"),
            "draft_pipe": r.get("draft_pipe"),
            "full_w": r.get("full_width"), "full_h": r.get("full_height")}


def send_edits(eng, edits, values, ops=None):
    """the engine's set for each module a control change touches; ms in all.
    the ops it set are added to `ops`, as draftKeep collects them"""
    total = 0.0
    for e in edits.call(cmd="set", values=values)["edits"]:
        _, wall, _ = eng.req(cmd="set", **e)
        total += wall
        if ops is not None:
            ops.add(e["op"])
    return total


def draft_skip(keep):
    return [op for op in DRAFT_SKIP if op not in keep]


# the controls the slider scenario moves, and how far: a hand's drag in the
# app, a new value every step. darktable's pipe cache keeps 64 earlier
# results, so a value seen before would come back from it without a render.
# a third item is set first and put back after (the parametric curve's
# sliders need its mode)
CONTROLS = [
    ("exposure", 1.0), ("contrast", 40), ("highlights", -50), ("shadows", 50), ("whites", 40), ("blacks", -30),
    ("temp", 1200), ("tint", 25), ("texture", 40), ("clarity", 40), ("dehaze", 30), ("vibrance", 30),
    ("saturation", 30), ("tc_highlights", 30, {"tc_mode": 0}), ("hsl_sat_red", 40), ("cg_shadows_sat", 30),
    ("usm_amount", 50), ("nr_luminance", 40), ("vig_amount", -30), ("grain_amount", 30), ("tf_rotate", 2.0),
]

# new photos start with AgX and its default profile (App.tsx, after
# Session.open); the new-photos preset is left out, as it depends on
# Preferences
NEW_PHOTO = {"tm_mode": 1}

# the heavy scenario's edit: the four modules that took the app's idle base
# render to 4.8 s in an earlier run
HEAVY = {"grain_amount": 30, "texture": 40, "usm_amount": 25, "nr_luminance": 40}
# the heavydrag scenario's sliders, early to late in the pipe, and frames a drag
HEAVY_DRAG = ["temp", "exposure", "highlights", "clarity", "vibrance", "vig_amount"]
HEAVY_DRAG_FRAMES = 12

# each of Immage's modules, timed against darktable modules that do a
# similar job. "controls" are Immage's own edit (lib/edits.mjs); "op" enables
# a module at darktable's defaults, its other "params" given
ALTERNATIVES = [
    {"job": "tone mapper", "immage": {"name": "agx (Immage default)", "ops": ["agx"], "controls": {"tm_mode": 1}},
     "alts": [{"name": "sigmoid", "ops": ["sigmoid"], "controls": {"tm_mode": 0}},
              {"name": "filmicrgb", "op": "filmicrgb", "off": ["agx", "sigmoid"]}]},
    {"job": "sharpening", "immage": {"name": "sharpen", "ops": ["sharpen"], "controls": {"usm_amount": 25}},
     "alts": [{"name": "diffuse (sharpen instance)", "ops": ["diffuse"],
               "controls": {"mod_sharpening": 1, "sharp_amount": 2}}]},
    {"job": "noise reduction", "immage": {"name": "denoiseprofile", "ops": ["denoiseprofile"],
                                          "controls": {"nr_luminance": 40}},
     "alts": [{"name": "nlmeans", "op": "nlmeans"}, {"name": "bilateral", "op": "bilateral"}]},
    {"job": "clarity", "immage": {"name": "bilat", "ops": ["bilat"], "controls": {"clarity": 40}},
     "alts": [{"name": "atrous", "op": "atrous"}]},
    {"job": "texture", "immage": {"name": "diffuse", "ops": ["diffuse"], "controls": {"texture": 40}},
     "alts": [{"name": "bilat (detail)", "op": "bilat", "params": {"detail": 0.4}},
              {"name": "atrous", "op": "atrous"}]},
    {"job": "shadows / highlights", "immage": {"name": "toneequal", "ops": ["toneequal"],
                                               "controls": {"shadows": 50, "highlights": -50}},
     "alts": [{"name": "shadhi", "ops": ["shadhi"], "controls": {"mod_tone": 1, "shadows": 50, "highlights": -50}}]},
    {"job": "HSL", "immage": {"name": "colorequal", "ops": ["colorequal"], "controls": {"hsl_sat_red": 40}},
     "alts": [{"name": "colorzones", "op": "colorzones"}]},
    {"job": "dehaze", "immage": {"name": "hazeremoval", "ops": ["hazeremoval"], "controls": {"dehaze": 30}},
     "alts": []},
    {"job": "grain", "immage": {"name": "grain", "ops": ["grain"], "controls": {"grain_amount": 30}}, "alts": []},
]


def frame_diff(a, sa, b, sb):
    """how far apart two RGBA frames look: mean and 99th percentile of the
    absolute difference per channel (0-255), on the smaller frame's grid"""
    w, h = min(sa[0], sb[0]), min(sa[1], sb[1])
    if not w or not h:
        return None
    diffs = []
    step = max(1, int((w * h / 200000) ** 0.5))  # about 200k pixels
    for y in range(0, h, step):
        ya, yb = y * sa[1] // h, y * sb[1] // h
        for x in range(0, w, step):
            ia = 4 * (ya * sa[0] + x * sa[0] // w)
            ib = 4 * (yb * sb[0] + x * sb[0] // w)
            for k in range(3):
                diffs.append(abs(a[ia + k] - b[ib + k]))
    diffs.sort()
    return {"size_main": list(sa), "size_draft": list(sb), "mean": round(sum(diffs) / len(diffs), 2),
            "p99": diffs[int(0.99 * len(diffs))], "max": diffs[-1]}


def module_cost(sample, ops):
    """the ms of these modules in a render, every instance ("diffuse",
    "diffuse.1", ...), without the colorspace conversions ahead of them"""
    return sum(v for k, v in sample["modules"].items() if k.split(".")[0] in ops)


# the masks scenario: how many masks the photo has at each step, and the
# points in a brush stroke, about what a quick stroke across a sky leaves
MASK_COUNTS = (1, 5, 10)
BRUSH_POINTS = 120


def mask_shape(i):
    """mask i's shape, in the shown image's units: in turn an ellipse, a
    gradient and a brush stroke, each somewhere of its own"""
    k = i / max(MASK_COUNTS)
    if i % 3 == 0:
        return {"type": "ellipse", "x": 0.2 + 0.6 * k, "y": 0.5, "rx": 0.15, "ry": 0.1, "angle": 0, "feather": 0.5}
    if i % 3 == 1:
        return {"type": "gradient", "x": 0.5, "y": 0.2 + 0.6 * k, "angle": 90 + 20 * k, "width": 0.3}
    pts = [[0.1 + 0.8 * j / BRUSH_POINTS, 0.3 + 0.4 * k + 0.05 * ((j % 20) / 10 - 1)] for j in range(BRUSH_POINTS)]
    return {"type": "brush", "points": pts, "size": 0.04, "hardness": 0.5, "density": 1.0}


class MaskModel:
    """masks as the app's Session sends them: each with its own instances,
    one per local module (`chain`, as before 0.31), or with color balance
    rgb on instances the masks share (`shared`, app/src/localMerge.ts),
    whose own instances stay off holding their settings. A drag's mask is
    lifted out onto its own instances until the drag ends (Session.lifted)"""

    def __init__(self, eng, edits, model, ops=("exposure", "colorbalancergb")):
        self.eng, self.edits, self.model, self.ops = eng, edits, model, ops
        self.masks, self.sent = {}, {}

    def send(self, name, drag=False):
        """mask `name`'s own instances, then what changed of the shared
        ones; ms of the requests. `drag`, the mask is lifted"""
        t = time.perf_counter()
        m = self.masks[name]
        plan = None
        if self.model == "shared":
            masks = [dict(x, hidden=True) if drag and x["name"] == name else x for x in self.masks.values()]
            plan = self.edits.call(cmd="planMerge", masks=masks)
            if drag:
                plan["merged"].pop(name, None)
        for op in self.ops:
            on = not (plan and op in plan["merged"].get(name, []))
            params = self.edits.call(cmd="local", op=op, values=m["values"])["params"]
            real, _, tag = op.partition("#")
            self.eng.req(cmd="set", op=real, params=params, enabled=on, instance=f"{name}#{tag}" if tag else name,
                         mask=name, invert=m["invert"], opacity=100, refine=m.get("refine"))
        if plan:
            want = {s["group"]: s for s in plan["shared"]}
            for g in [g for g in self.sent if g not in want]:
                self.eng.req(cmd="combine", name=g, members=[])
                del self.sent[g]
            for g, sh in want.items():
                was = self.sent.get(g, {})
                if (was.get("members"), was.get("ranges")) != (sh["members"], sh["ranges"]):
                    self.eng.req(cmd="combine", name=g, members=sh["members"], ranges=sh["ranges"])
                if (was.get("params"), was.get("refine")) != (sh["params"], sh["refine"]):
                    self.eng.req(cmd="set", op=sh["op"].split("#")[0], params=sh["params"], enabled=True,
                                 instance=sh["instance"], mask=g, invert=False, opacity=100, refine=sh["refine"])
                self.sent[g] = sh
        return (time.perf_counter() - t) * 1000

    def add(self, name, shape, values, ranges=(), refine=None, invert=False):
        """`ranges`, range components after the shape; `refine`, the
        mask's refinements"""
        shapes = [shape, *ranges]
        self.eng.req(cmd="mask", name=name, shapes=shapes)
        self.masks[name] = {"name": name, "shapes": shapes, "invert": invert, "values": values,
                            **({"refine": refine} if refine else {})}
        self.send(name)

    def clear(self):
        for name in list(self.masks):
            self.eng.req(cmd="mask_delete", name=name)
        for g in self.sent:
            self.eng.req(cmd="combine", name=g, members=[])
        self.masks, self.sent = {}, {}


def mask_values(i):
    """mask i's local settings: Exposure and Contrast, and every other one
    Saturation too, so the shared model has two directions to group by"""
    return {"l_exposure": 0.3, "l_contrast": 10 + i, "l_saturation": 5 if i % 2 else 0}


def run_masks(eng, edits, rec, mode, name, controls, rgba, args):
    """1, 5 and 10 masks, each with its own Exposure, Contrast and, every
    other one, Saturation, under each model (MaskModel): a local drag on the
    oldest and on the newest mask, a global Exposure drag under them, and a
    shape moved. `recomputed` counts the modules each frame ran"""
    # every value is new, so no frame comes back from a pipe cache
    n_val = [0]

    def nxt():
        n_val[0] += 1
        return 0.13 * n_val[0]

    for model in ("chain", "shared"):
        mm = MaskModel(eng, edits, model)
        made = []
        for count in MASK_COUNTS:
            while len(made) < count:
                m = f"bench {len(made) + 1}"
                mm.add(m, mask_shape(len(made)), mask_values(len(made)))
                made.append(m)
            render_sample(eng, VIEW, rgba=rgba)
            extra = {"masks": count, "brush_points": BRUSH_POINTS, "model": model}
            targets = (("oldest", made[0]), ("newest", made[-1])) if count > 1 else (("only", made[0]),)
            for label, m in targets:
                drafts = []
                start = dict(mm.masks[m]["values"])
                for _ in range(args.repeat):
                    t = time.perf_counter()
                    mm.masks[m]["values"]["l_contrast"] = start["l_contrast"] + nxt()
                    set_ms = mm.send(m, drag=True)
                    s = render_sample(eng, DRAFT, rgba=rgba, skip=DRAFT_SKIP, draft=True)
                    s["set"], s["wall"] = set_ms, (time.perf_counter() - t) * 1000
                    drafts.append(s)
                t = time.perf_counter()
                mm.send(m)
                release = render_sample(eng, VIEW, rgba=rgba)
                release["wall"] = (time.perf_counter() - t) * 1000
                rec.add(mode, name, "masks", f"{count} masks, {model}, local contrast on {label}, draft", drafts,
                        {**extra, "target": label})
                rec.add(mode, name, "masks", f"{count} masks, {model}, local contrast on {label}, release",
                        [release], {**extra, "target": label})
                mm.masks[m]["values"] = start
                mm.send(m)

            # the photo's own Exposure, which every mask instance runs after
            c = controls["exposure"]
            drafts = []
            for i in range(args.repeat):
                send_edits(eng, edits, {"exposure": c["value"] + 0.02 * (i + 1) + 0.001 * count
                                        + (0.0005 if model == "shared" else 0)})
                drafts.append(render_sample(eng, DRAFT, rgba=rgba, skip=DRAFT_SKIP, draft=True))
            send_edits(eng, edits, {"exposure": c["value"]})
            render_sample(eng, VIEW, rgba=rgba)
            rec.add(mode, name, "masks", f"{count} masks, {model}, global exposure, draft", drafts, extra)

            # the newest mask's shape dragged across the photo, as MaskOverlay
            # sends it while a shape moves
            moves = []
            shape = mask_shape(len(made) - 1)
            for i in range(args.repeat):
                moved = dict(shape)
                d = 0.005 * (i + 1) + (0.001 if model == "shared" else 0)
                if shape["type"] == "brush":
                    moved["points"] = [[x + d, y] for x, y in shape["points"]]
                else:
                    moved["x"] = shape["x"] + d
                t = time.perf_counter()
                eng.req(cmd="mask", name=made[-1], shapes=[moved])
                mm.send(made[-1], drag=True)
                s = render_sample(eng, DRAFT, rgba=rgba, skip=DRAFT_SKIP, draft=True)
                s["wall"] = (time.perf_counter() - t) * 1000
                moves.append(s)
            eng.req(cmd="mask", name=made[-1], shapes=[shape])
            mm.send(made[-1])
            render_sample(eng, VIEW, rgba=rgba)
            rec.add(mode, name, "masks", f"{count} masks, {model}, newest shape moved, draft", moves,
                    {**extra, "shape": shape["type"]})
        # the same masks both ways: how far apart they look
        if model == "chain":
            render_sample(eng, VIEW, rgba=rgba)
            with open(rgba, "rb") as f:
                chain_frame = f.read()
        else:
            s = render_sample(eng, VIEW, rgba=rgba)
            with open(rgba, "rb") as f:
                rec.add(mode, name, "masks", f"{count} masks, shared vs chain, same settings", [s],
                        {"diff": frame_diff(chain_frame, (s["w"], s["h"]), f.read(), (s["w"], s["h"]))})
        mm.clear()


def run_image(eng, edits, rec, mode, img, args, workdir, spawn):
    name = os.path.basename(img)
    rgba = os.path.join(workdir, "frame.rgba")
    log(f"[{mode}] {name}")

    # open, as Session.open does, and the first frame
    r, wall, timings = eng.req(cmd="open", path=img)
    imgid = r.get("imgid", 0)
    open_info = {"sensor_width": r.get("sensor_width"), "sensor_height": r.get("sensor_height"), "raw": r.get("raw")}
    rec.add(mode, name, "open", "open", [{"wall": wall, "modules": module_ms(timings)}], {"info": open_info})
    fields = edits.call(cmd="fields")["fields"]
    info, _, _ = eng.req(cmd="get", modules=fields)
    ctx = {"sensorWidth": r.get("sensor_width"), "sensorHeight": r.get("sensor_height"),
           "orientation": r.get("orientation", 0), "camera": r.get("orientation", 0)}
    controls = edits.call(cmd="init", info=info["modules"], ctx=ctx)["controls"]
    new_photo = {k: v for k, v in NEW_PHOTO.items() if k in controls and (r.get("raw") or k == "tm_mode")}
    # Preferences' exposure compensation, on its own exposure instance
    if args.exp_comp and r.get("raw"):
        new_photo["exp_comp"] = args.exp_comp
    t0 = time.perf_counter()
    send_edits(eng, edits, new_photo)
    first = render_sample(eng, VIEW, rgba=rgba)
    first["wall"] = (time.perf_counter() - t0) * 1000
    rec.add(mode, name, "open", "first frame", [first])
    rec.add(mode, name, "open", "unchanged frame", [render_sample(eng, VIEW, rgba=rgba) for _ in range(3)])

    # each slider, at full size and as a drag's draft
    if "sliders" in args.only:
        for cid, delta, *pre in CONTROLS:
            c = controls.get(cid)
            if not c:
                continue
            pre = pre[0] if pre else {}
            undo_pre = {k: controls[k]["value"] for k in pre}
            send_edits(eng, edits, pre)
            start = c["value"]
            target = min(c["max"], max(c["min"], start + delta))
            # at the end of its range it goes the other way
            if abs(target - start) < abs(delta) / 2:
                target = min(c["max"], max(c["min"], start - delta))
            # on the control's step, each value once: a coarse control (Sharpening's
            # Amount moves 1 at a time) gets fewer samples rather than repeats
            step = c.get("step") or 0
            sweep = []
            for i in range(args.repeat):
                v = start + (target - start) * (i + 1) / args.repeat
                v = round(v / step) * step if step >= 1 else v
                if v != start and v not in sweep:
                    sweep.append(v)
            for label, size in (("full", VIEW), ("draft", DRAFT)):
                # a drag of Grain, Texture or Sharpening keeps its own module
                keep = set()
                send_edits(eng, edits, {cid: sweep[0] if sweep else start}, keep)
                send_edits(eng, edits, {cid: start})
                skip = draft_skip(keep) if label == "draft" else None
                draft = label == "draft"
                render_sample(eng, size, rgba=rgba, skip=skip, draft=draft)  # this size's cache, warm
                samples = []
                for v in sweep:
                    t = time.perf_counter()
                    set_ms = send_edits(eng, edits, {cid: v})
                    s = render_sample(eng, size, rgba=rgba, skip=skip, draft=draft)
                    s["set"] = set_ms
                    s["wall"] = (time.perf_counter() - t) * 1000
                    samples.append(s)
                send_edits(eng, edits, {cid: start})
                rec.add(mode, name, "sliders", f"{cid} {label}", samples,
                        {"control": cid, "size": label, "skip": skip or []})
            send_edits(eng, edits, undo_pre)
            render_sample(eng, VIEW, rgba=rgba)

    # a drag and its release: drafts while moving, then the full frame, then
    # the idle base the app renders once editing pauses
    if "roi" in args.only:
        seq = {"draft (while dragging)": [], "full (release)": [], "base (idle)": [], "full (next edit)": [],
               "full (repeat, cached)": []}
        c = controls["exposure"]
        for i in range(args.repeat):
            v = c["value"] + 0.05 * (i + 1)
            send_edits(eng, edits, {"exposure": v})
            seq["draft (while dragging)"].append(render_sample(eng, DRAFT, rgba=rgba, skip=DRAFT_SKIP, draft=True))
            seq["full (release)"].append(render_sample(eng, VIEW, rgba=rgba))
            seq["base (idle)"].append(render_sample(eng, BASE, rgba=rgba, base=True))
            send_edits(eng, edits, {"exposure": v + 0.025})
            seq["full (next edit)"].append(render_sample(eng, VIEW, rgba=rgba))
            seq["full (repeat, cached)"].append(render_sample(eng, VIEW, rgba=rgba))
        send_edits(eng, edits, {"exposure": c["value"]})
        for step, samples in seq.items():
            rec.add(mode, name, "roi", step, samples)

    # a heavy edit, as in the app where the idle base took 4.8 s on the CPU:
    # an Exposure drag, its release and the base, each sample after a new
    # exposure. the base three ways, each after a release of its own:
    # as today, without grain, and without grain or diffuse (recommendation 2)
    if "heavy" in args.only:
        heavy = {k: v for k, v in HEAVY.items() if k in controls}
        undo = {k: controls[k]["value"] for k in heavy}
        send_edits(eng, edits, heavy)
        render_sample(eng, VIEW, rgba=rgba)
        bases = (("base (heavy edit)", None), ("base (heavy edit, no grain)", ["grain"]),
                 ("base (heavy edit, no grain or diffuse)", DRAFT_SKIP))
        seq = {"draft (heavy edit)": [], "draft (heavy edit, Performance)": [], "release (heavy edit)": [],
               **{b: [] for b, _ in bases}}
        c = controls["exposure"]
        n = 0
        for _ in range(max(3, args.repeat // 2)):
            for step, skip in bases:
                n += 1
                send_edits(eng, edits, {"exposure": c["value"] + 0.03 * n})
                seq["draft (heavy edit)"].append(render_sample(eng, DRAFT, rgba=rgba, skip=DRAFT_SKIP, draft=True))
                send_edits(eng, edits, {"exposure": c["value"] + 0.03 * n + 0.01})
                seq["draft (heavy edit, Performance)"].append(
                    render_sample(eng, DRAFT_PERF, rgba=rgba, skip=DRAFT_SKIP_PERF, draft=True))
                seq["release (heavy edit)"].append(render_sample(eng, VIEW, rgba=rgba))
                seq[step].append(render_sample(eng, BASE, rgba=rgba, skip=skip, base=True))
        send_edits(eng, edits, {"exposure": c["value"], **undo})
        render_sample(eng, VIEW, rgba=rgba)
        for step, samples in seq.items():
            rec.add(mode, name, "heavy", step, samples, {"controls": heavy})

    # drags over the heavy edit, sliders early to late in the pipe: the
    # modules before the dragged one come from the drag pipe's cache, which
    # on the GPU keeps them only for the module marked as last edited. the
    # first frame of each drag, which fills that cacheline, is left out
    if "heavydrag" in args.only:
        heavy = {k: v for k, v in HEAVY.items() if k in controls}
        undo = {k: controls[k]["value"] for k in heavy}
        send_edits(eng, edits, heavy)
        render_sample(eng, VIEW, rgba=rgba)
        for cid in HEAVY_DRAG:
            c = controls.get(cid)
            if not c:
                continue
            delta = dict((k, d) for k, d, *_ in CONTROLS)[cid]
            sign = 1 if c["min"] <= c["value"] + delta <= c["max"] else -1
            frames = []
            for i in range(HEAVY_DRAG_FRAMES):
                send_edits(eng, edits, {cid: c["value"] + sign * delta * (i + 1) / HEAVY_DRAG_FRAMES})
                frames.append(render_sample(eng, DRAFT, rgba=rgba, skip=DRAFT_SKIP, draft=True))
            send_edits(eng, edits, {cid: c["value"]})
            render_sample(eng, VIEW, rgba=rgba)
            rec.add(mode, name, "heavydrag", f"{cid} drag (heavy edit)", frames[1:],
                    {"control": cid, "controls": heavy, "first": frames[0]["wall"]})
        send_edits(eng, edits, undo)
        render_sample(eng, VIEW, rgba=rgba)

    # a long drag and its release. a drag's frames once filled the main
    # pipe's 64 cachelines, and after some 30 of them the release reran from
    # the raw (540 ms for Highlights); the engine's drag pipe keeps them apart.
    # each arm sweeps values of its own, so none finds another's in a cache
    if "longdrag" in args.only:
        arms = (("long drag", LONG_DRAG, True), ("long drag, frames on the main pipe", LONG_DRAG, False),
                ("short drag", 4, True))
        for cid in ("highlights", "exposure"):
            c = controls.get(cid)
            if not c:
                continue
            delta = dict((k, d) for k, d, *_ in CONTROLS)[cid]
            sign = 1 if c["min"] <= c["value"] + delta <= c["max"] else -1
            for a, (label, frames, draft) in enumerate(arms):
                releases, drafts = [], []
                for rep in range(LONG_DRAG_REPS):
                    send_edits(eng, edits, {cid: c["value"]})
                    render_sample(eng, VIEW, rgba=rgba)  # the frame before the drag
                    off = (a * LONG_DRAG_REPS + rep) / (len(arms) * LONG_DRAG_REPS * frames)
                    for i in range(frames):
                        send_edits(eng, edits, {cid: c["value"] + sign * delta * ((i + 1) / frames - off)})
                        drafts.append(render_sample(eng, DRAFT, rgba=rgba, skip=DRAFT_SKIP, draft=draft))
                    t = time.perf_counter()
                    s = render_sample(eng, VIEW, rgba=rgba)
                    s["wall"] = (time.perf_counter() - t) * 1000
                    releases.append(s)
                send_edits(eng, edits, {cid: c["value"]})
                render_sample(eng, VIEW, rgba=rgba)
                rec.add(mode, name, "longdrag", f"{cid} release after {label}", releases,
                        {"control": cid, "frames": frames, "drag_pipe": draft,
                         "draft_p50": stats([d["wall"] for d in drafts])["p50"]})

    # the draft pipe prototype (the engine's `render` with "draft"): a drag's
    # frames from the small mip against today's half-size frames from the
    # full raw, the first draft after a full frame, and how far apart they look
    if "draftpipe" in args.only:
        probe = render_sample(eng, DRAFT, rgba=rgba, draft=True)
        if probe.get("draft_pipe") is None:
            log("  draftpipe: this engine has no draft pipe, skipped")
        else:
            for cid in ("exposure", "contrast", "texture", "temp"):
                c = controls.get(cid)
                if not c:
                    continue
                delta = dict((k, d) for k, d, *_ in CONTROLS)[cid]
                for label, draft in (("main pipe", False), ("draft pipe", True)):
                    render_sample(eng, DRAFT, rgba=rgba, draft=draft)
                    samples = []
                    # both arms sweep the same way, inside the range, on values
                    # of their own so neither finds the other's in a cache
                    sign = 1 if c["value"] + delta <= c["max"] and c["value"] + delta >= c["min"] else -1
                    for i in range(args.repeat):
                        v = c["value"] + sign * delta * ((i + 1) / args.repeat - (0.5 / args.repeat if draft else 0))
                        t = time.perf_counter()
                        send_edits(eng, edits, {cid: v})
                        sm = render_sample(eng, DRAFT, rgba=rgba, draft=draft)
                        sm["wall"] = (time.perf_counter() - t) * 1000
                        samples.append(sm)
                    send_edits(eng, edits, {cid: c["value"]})
                    rec.add(mode, name, "draftpipe", f"{cid} drag, {label}", samples,
                            {"control": cid, "pipe": label, "used_draft_pipe": all(x.get("draft_pipe") for x in samples)})
            # a drag's first frame, right after a full frame (the release before)
            firsts = {"main pipe": [], "draft pipe": []}
            c = controls["exposure"]
            for i in range(args.repeat):
                for label, draft in (("main pipe", False), ("draft pipe", True)):
                    send_edits(eng, edits, {"exposure": c["value"] + 0.04 * (i + 1) + (0.01 if draft else 0)})
                    render_sample(eng, VIEW, rgba=rgba)
                    send_edits(eng, edits, {"exposure": c["value"] + 0.04 * (i + 1) + (0.02 if draft else 0.005)})
                    firsts[label].append(render_sample(eng, DRAFT, rgba=rgba, draft=draft))
            send_edits(eng, edits, {"exposure": c["value"]})
            for label, samples in firsts.items():
                rec.add(mode, name, "draftpipe", f"first draft after release, {label}", samples, {"pipe": label})
            # the same settings both ways, compared pixel by pixel
            a = render_sample(eng, DRAFT, rgba=rgba)
            with open(rgba, "rb") as f:
                pa = f.read()
            b = render_sample(eng, DRAFT, rgba=rgba, draft=True)
            with open(rgba, "rb") as f:
                pb = f.read()
            rec.add(mode, name, "draftpipe", "draft vs main, same settings", [b],
                    {"diff": frame_diff(pa, (a["w"], a["h"]), pb, (b["w"], b["h"]))})

    # zoom to 100% at the middle, pan, and back to fit
    if "zoom" in args.only:
        full_w, full_h = first["full_w"], first["full_h"]
        cx, cy = full_w // 2 - VIEW[0] // 2, full_h // 2 - VIEW[1] // 2
        rec.add(mode, name, "zoom", "100% (first)", [render_sample(eng, VIEW, 1.0, cx, cy, rgba)])
        pans = [render_sample(eng, VIEW, 1.0, cx + dx, cy, rgba) for dx in (-400, -800, -1200, -1600)]
        rec.add(mode, name, "zoom", "100% pan", pans)
        c = controls["exposure"]
        edit = []
        for i in range(args.repeat):
            send_edits(eng, edits, {"exposure": c["value"] - 0.05 * (i + 1)})
            edit.append(render_sample(eng, VIEW, 1.0, cx, cy, rgba))
        send_edits(eng, edits, {"exposure": c["value"]})
        rec.add(mode, name, "zoom", "100% exposure edit", edit)
        rec.add(mode, name, "zoom", "back to fit", [render_sample(eng, VIEW, rgba=rgba)])

    # preset tiles (160 px) and the hover preview (up to 1600 px): the second pipe
    if "preview" in args.only:
        prev = os.path.join(workdir, "preview.rgba")
        for size in (160, 1600):
            samples = []
            for i in range(args.repeat):
                c0 = controls["contrast"]["value"]
                edit = edits.call(cmd="set", values={"contrast": c0 + 3 * (i + 1) + (0.5 if size > 160 else 0)})["edits"]
                edits.call(cmd="set", values={"contrast": c0})
                r, wall, timings = eng.req(cmd="preview", size=size, edits=edit, rgba=prev)
                samples.append({"wall": wall, "modules": module_ms(timings),
                                "recomputed": len([t for t in timings if t["kind"] == "module"])})
            rec.add(mode, name, "preview", f"preview {size}px", samples)

    # local adjustments as the masks panel makes them, after everything else
    # since they stay in the photo's history until it closes
    if "masks" in args.only:
        run_masks(eng, edits, rec, mode, name, controls, rgba, args)

    eng.req(cmd="close")

    # each of Immage's modules against alternatives, alone on top of the
    # photo's stack, at the viewer's size. an engine of its own without the
    # pipe cache, so every render runs every module and repeats are real
    if "modules" in args.only:
        eng = spawn(["--disable-pipecache"])
        eng.req(cmd="open", path=img)
        info, _, _ = eng.req(cmd="get", modules=fields)
        controls = edits.call(cmd="init", info=info["modules"], ctx=ctx)["controls"]
        send_edits(eng, edits, new_photo)
        for group in ALTERNATIVES:
            for i, cand in enumerate([group["immage"]] + group["alts"]):
                samples = []
                undo = {}
                for _ in range(args.repeat):
                    if "controls" in cand:
                        undo = {k: controls[k]["value"] for k in cand["controls"] if k in controls}
                        send_edits(eng, edits, {k: v for k, v in cand["controls"].items() if k in controls})
                    else:
                        for off in cand.get("off", []):
                            eng.req(cmd="set", op=off, params={}, enabled=False)
                        eng.req(cmd="set", op=cand["op"], params=cand.get("params", {}), enabled=True)
                    s = render_sample(eng, VIEW, rgba=rgba)
                    s["own"] = module_cost(s, cand.get("ops") or [cand["op"]])
                    samples.append(s)
                    # back as it was, and the frame rendered so the next
                    # candidate starts from a warm cache
                    if "controls" in cand:
                        send_edits(eng, edits, undo)
                    else:
                        eng.req(cmd="set", op=cand["op"], params={}, enabled=False)
                        if cand.get("off"):
                            send_edits(eng, edits, {"tm_mode": controls["tm_mode"]["value"]})
                    render_sample(eng, VIEW, rgba=rgba)
                own = stats([s["own"] for s in samples])
                mp = (first["w"] or 0) * (first["h"] or 0) / 1e6
                rec.add(mode, name, "modules", f"{group['job']}: {cand['name']}", samples,
                        {"job": group["job"], "candidate": cand["name"], "immage": i == 0, "own_ms": own,
                         "mpix": round(mp, 2), "mpix_per_s": round(mp / (own["p50"] / 1000), 1) if own and own["p50"] else None})
        eng.req(cmd="close")
        eng.close()

    # a full-size JPEG export, as the Export dialog writes one
    if "export" in args.only:
        eng = spawn([])
        imgid = eng.req(cmd="open", path=img)[0].get("imgid", 0)
        send_edits(eng, edits, new_photo)
        eng.req(cmd="save")
        out = os.path.join(workdir, "export.jpg")
        samples = []
        for _ in range(max(1, args.repeat // 2)):
            if os.path.exists(out):
                os.remove(out)
            r, wall, timings = eng.req(cmd="export", imgid=imgid, out=out, format="jpeg", quality=90)
            samples.append({"wall": wall, "modules": module_ms(timings)})
        rec.add(mode, name, "export", "full size jpeg q90", samples)
        eng.req(cmd="close")
        eng.close()

    # opening the photo the arrow keys go to next, cold and with its raw
    # decoded ahead (`prefetch`, as App.tsx's prefetchNext asks once the
    # photo before is up); each on a copy no engine has opened, after the
    # engine's first open, which carries its start-up work
    if "prefetch" in args.only:
        eng = spawn([])
        eng.req(cmd="open", path=img)
        cold, ahead = [], []
        for k in range(max(1, args.repeat // 2)):
            paths = []
            for kind in ("cold", "ahead"):
                p = os.path.join(workdir, f"{kind}{k}{os.path.splitext(img)[1]}")
                shutil.copyfile(img, p)
                paths.append(p)
            ids = {i["path"]: i["imgid"] for i in eng.req(cmd="import", files=paths)[0]["images"]}
            _, wall, _ = eng.req(cmd="open", path=paths[0])
            cold.append({"wall": wall})
            eng.req(cmd="prefetch", imgid=ids[paths[1]])
            time.sleep(2)
            _, wall, _ = eng.req(cmd="open", path=paths[1])
            ahead.append({"wall": wall})
        eng.req(cmd="close")
        eng.close()
        rec.add(mode, name, "prefetch", "open, cold", cold)
        rec.add(mode, name, "prefetch", "open, decoded ahead", ahead)
    return open_info


def representative(files):
    """the largest and the smallest file of each format: the most and fewest
    megapixels a camera brings, without hours of runs over a big corpus"""
    by_ext = {}
    for f in files:
        by_ext.setdefault(os.path.splitext(f)[1].lower(), []).append(f)
    out = []
    for group in by_ext.values():
        group.sort(key=os.path.getsize)
        out += sorted({group[-1], group[0]})
    return sorted(out)


def corpus_files(corpus):
    files = sorted(f for f in glob.glob(os.path.join(corpus, "*"))
                   if os.path.isfile(f) and os.path.splitext(f)[1].lower() in IMG_EXT)
    return files


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# the system's own id for this machine, hashed as the app's machine_id()
# (app/src-tauri/src/main.rs) hashes it, so a run and the GUI reports from
# one machine carry the same id
def machine_id():
    raw = ""
    try:
        if platform.system() == "Darwin":
            out = subprocess.run(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"], capture_output=True, text=True,
                                 timeout=10).stdout
            line = next((l for l in out.splitlines() if '"IOPlatformUUID"' in l), "")
            raw = line.rsplit('"', 2)[1] if line.count('"') >= 4 else ""
        elif platform.system() == "Windows":
            out = subprocess.run(["reg", "query", r"HKLM\SOFTWARE\Microsoft\Cryptography", "/v", "MachineGuid"],
                                 capture_output=True, text=True, timeout=10).stdout
            line = next((l for l in out.splitlines() if "MachineGuid" in l), "")
            raw = line.split()[-1] if line.split() else ""
        else:
            for p in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
                if os.path.exists(p):
                    raw = open(p).read()
                    break
    except Exception:
        pass
    raw = raw.strip()
    return hashlib.sha256(f"immage-bench:{raw}".encode()).hexdigest()[:12] if raw else None


def git(*a):
    try:
        return subprocess.run(["git", "-C", REPO, *a], capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:
        return ""


def environment(args, binary):
    cache = {}
    try:
        for line in open(os.path.join(REPO, "build", "CMakeCache.txt")):
            k = line.split(":", 1)[0]
            if k in ("CMAKE_BUILD_TYPE", "USE_OPENCL", "USE_OPENMP", "USE_AI", "CMAKE_C_COMPILER"):
                cache[k] = line.strip().split("=", 1)[-1]
    except OSError:
        pass
    sysinfo = {}
    if platform.system() == "Darwin":
        for key in ("machdep.cpu.brand_string", "hw.memsize", "hw.perflevel0.physicalcpu", "hw.perflevel1.physicalcpu",
                    "hw.ncpu"):
            v = subprocess.run(["sysctl", "-n", key], capture_output=True, text=True).stdout.strip()
            if v:
                sysinfo[key] = v
    return {
        "schema": SCHEMA, "at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "host": platform.node().split(".")[0], "machine_id": machine_id(), "os": f"{platform.system()} {platform.release()}",
        "machine": platform.machine(), "python": platform.python_version(), "sysinfo": sysinfo,
        "git": {"sha": git("rev-parse", "--short", "HEAD"), "branch": git("rev-parse", "--abbrev-ref", "HEAD"),
                "dirty": bool(git("status", "--porcelain", "--untracked-files=no"))},
        "engine": os.path.relpath(binary, REPO), "build": cache, "view": VIEW, "draft": DRAFT, "base": BASE,
        "repeat": args.repeat, "scenarios": sorted(args.only), "modes": args.modes, "note": args.note,
        "corpus": os.path.relpath(os.path.abspath(args.corpus), REPO),
    }


def main():
    ap = argparse.ArgumentParser(description="Immage's engine benchmark")
    ap.add_argument("--corpus", default=os.path.join(HERE, "corpus"), help="folder of photos (default benchmarking/corpus)")
    ap.add_argument("--engine", default=os.path.join(REPO, "build", "bin", "darktable-engine"))
    ap.add_argument("--opencl", choices=["off", "on", "both", "split", "app"], default="both",
                    help="off: cpu; on: opencl; both: cpu and opencl; split: the app's engine; app: cpu and split")
    ap.add_argument("--repeat", type=int, default=7, help="samples per step (default 7)")
    ap.add_argument("--only", default="sliders,roi,heavy,heavydrag,longdrag,draftpipe,zoom,preview,modules,export,masks,prefetch",
                    help="scenarios, comma separated (default all)")
    ap.add_argument("--images", default="", help="only photos whose names contain one of these, comma separated")
    ap.add_argument("--all", action="store_true",
                    help="every photo in the corpus; by default the largest and smallest file of each format")
    ap.add_argument("--note", default="", help="a note kept with the run")
    ap.add_argument("--exp-comp", type=float, default=0,
                    help="exposure compensation (EV) a new raw gets from Preferences (default 0, off)")
    ap.add_argument("--out", default=os.path.join(HERE, "results"))
    ap.add_argument("--no-perf-overhead", action="store_true", help="skip the -d perf overhead check")
    args = ap.parse_args()
    args.only = set(s.strip() for s in args.only.split(",") if s.strip())
    args.modes = {"off": ["cpu"], "on": ["opencl"], "both": ["cpu", "opencl"], "split": ["split"],
                  "app": ["cpu", "split"]}[args.opencl]

    files = corpus_files(args.corpus)
    if args.images:
        keys = [k.strip().lower() for k in args.images.split(",")]
        files = [f for f in files if any(k in os.path.basename(f).lower() for k in keys)]
    elif not args.all:
        files = representative(files)
    if not files:
        sys.exit(f"no photos in {args.corpus}: put the corpus there (see benchmarking/README.md)")
    if not os.path.exists(args.engine):
        sys.exit(f"no engine at {args.engine}: build it first (cmake --build build)")

    # the photos are copied, without sidecars, once per mode, so a run never
    # writes next to the originals and each mode starts them unedited
    if os.path.exists(WORK):
        shutil.rmtree(WORK)
    corpus = [{"name": os.path.basename(f), "sha256": sha256(f), "mb": round(os.path.getsize(f) / 1e6, 1)}
              for f in files]

    def fresh_copies(mode):
        d = os.path.join(WORK, mode + "-images")
        os.makedirs(d)
        for f in files:
            # contents only: a file locked in Finder (uchg) would stay locked here
            shutil.copyfile(f, os.path.join(d, os.path.basename(f)))
        return d

    env = environment(args, args.engine)
    log(f"benchmark: {len(files)} photos, modes {args.modes}, scenarios {sorted(args.only)}")
    rec = Recorder()
    edits = Edits()
    opencl_devices = {}
    t_start = time.time()
    # a fanless machine (a MacBook Air) slows its clocks as it heats: each
    # photo runs every mode in turn, so heat cannot favour one, and a canary
    # before each photo shows the drift and waits for it to cool
    raws = [f for f in files if os.path.splitext(f)[1].lower() in RAW_EXT] or files
    canary = Canary(args, os.path.join(fresh_copies("canary"), os.path.basename(min(raws, key=os.path.getsize))))
    images = {m: fresh_copies(m) for m in args.modes}
    engines = {}
    for m in args.modes:
        opencl, extra = mode_engine(m)
        engines[m] = Engine(args.engine, os.path.join(WORK, m), opencl=opencl, extra=extra)
    stamp = datetime.datetime.now().strftime("%Y-%m-%d_%H%M")
    run_dir = os.path.join(args.out, f"{stamp}_{env['git']['sha'] or 'nogit'}_{env['host']}")

    def save(complete):
        """after every photo, so a run stopped early keeps what it measured"""
        env["complete"] = complete
        env["seconds"] = round(time.time() - t_start, 1)
        env["thermal"] = canary.summary()
        os.makedirs(run_dir, exist_ok=True)
        with open(os.path.join(run_dir, "run.json"), "w") as f:
            json.dump({"env": env, "corpus": [c for c in corpus if "sensor" in c], "records": rec.records}, f, indent=1)

    try:
        for f, c in zip(files, corpus):
            for mode in args.modes:
                c.setdefault("canary", {})[mode] = canary.check(f"{os.path.basename(f)} {mode}")
                img = os.path.join(images[mode], os.path.basename(f))
                spawn = lambda extra, mode=mode: Engine(args.engine, os.path.join(WORK, mode + "-side"),
                                                        opencl=mode_engine(mode)[0],
                                                        extra=mode_engine(mode)[1] + extra)
                info = run_image(engines[mode], edits, rec, mode, img, args, os.path.join(WORK, mode), spawn)
                c["sensor"] = [info["sensor_width"], info["sensor_height"]]
                c["raw"] = info["raw"]
            save(False)
        for eng in engines.values():
            eng.close()
        engines = {}
        if "opencl" in args.modes:
            opencl_devices = opencl_summary(args, rec)

        # what -d perf itself costs: the same edit loop with and without it.
        # under OpenCL it also turns on the queue's profiling (opencl.c)
        if not args.no_perf_overhead and "sliders" in args.only:
            img = os.path.join(fresh_copies("overhead"), os.path.basename(files[0]))
            for mode in args.modes:
                perf_overhead(args, rec, img, mode)
        canary.check("end")
    finally:
        for eng in engines.values():
            eng.close()
        canary.close()
        edits.close()

    env["opencl"] = opencl_devices
    save(True)
    log(f"thermal: canary {env['thermal']['first_ms']} -> {env['thermal']['last_ms']} ms "
        f"(worst {env['thermal']['worst_ratio']}x), {env['thermal']['cooldown_s']} s cooling")
    if os.path.abspath(args.corpus) == os.path.join(HERE, "corpus") and not args.images:
        with open(os.path.join(HERE, "corpus", "corpus.json"), "w") as f:
            json.dump({"note": "the photos the last full run used; the files themselves stay out of git",
                       "photos": corpus}, f, indent=1)
    log(f"saved {os.path.relpath(run_dir, REPO)}/run.json ({len(rec.records)} records, {env['seconds']} s)")
    print(run_dir)


def pmset_therm():
    """macOS's own thermal and performance warnings, when it has raised any"""
    try:
        out = subprocess.run(["pmset", "-g", "therm"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    lines = [l.strip() for l in out.splitlines() if l.strip() and not l.startswith("Note:")]
    return lines or None


class Canary:
    """the same CPU render, timed before each photo: when it slows, the clocks
    have dropped. a raw's whole frame at the base size, about 0.2 s of every
    core, so jitter of a few ms cannot read as heat. above SLOW times the best
    reading so far it waits, 30 s at a time for up to 2 minutes, to cool"""
    SLOW = 1.15
    MAX_WAIT = 120

    def __init__(self, args, img):
        self.eng = Engine(args.engine, os.path.join(WORK, "canary"), opencl=False, perf=False)
        self.eng.req(cmd="open", path=img)
        self.n = 0
        self.readings = []
        self.cooldown = 0.0
        self.best = None
        # the first renders after opening run slower: not a reference
        self.measure()

    def measure(self):
        times = []
        for _ in range(3):
            self.n += 1
            # a new exposure each time, so the frame from exposure on reruns
            self.eng.req(cmd="set", op="exposure", params={"exposure": 0.001 * (self.n % 997)})
            r, wall, _ = self.eng.req(cmd="render", width=BASE[0], height=BASE[1])
            times.append(r.get("process_ms"))
        return statistics.median(times)

    def check(self, where):
        ms = self.measure()
        self.best = ms if self.best is None else min(self.best, ms)
        waited = 0
        while ms > self.SLOW * self.best and waited < self.MAX_WAIT:
            log(f"  canary {ms:.0f} ms vs best {self.best:.0f}: cooling 30 s")
            time.sleep(30)
            waited += 30
            ms = self.measure()
            self.best = min(self.best, ms)
        self.cooldown += waited
        reading = {"at": where, "ms": round(ms, 1), "ratio": round(ms / self.best, 3), "waited_s": waited,
                   "pmset": pmset_therm()}
        self.readings.append(reading)
        return reading

    def summary(self):
        r = self.readings
        return {"first_ms": r[0]["ms"] if r else None, "last_ms": r[-1]["ms"] if r else None,
                "best_ms": round(self.best, 1) if self.best else None,
                "worst_ratio": max((x["ratio"] for x in r), default=None), "cooldown_s": self.cooldown,
                "pmset": next((x["pmset"] for x in r if x["pmset"]), None), "readings": r}

    def close(self):
        self.eng.close()


def opencl_summary(args, rec):
    """the modules that ran on the GPU, and darktable's own report of the
    device (an engine started with -d opencl and nothing else)"""
    gpu_used = sorted({m for r in rec.records if r["mode"] == "opencl" for m in r["gpu_modules"]})
    eng = Engine(args.engine, os.path.join(WORK, "opencl-probe"), opencl=True, perf=False, extra=["-d", "opencl"])
    eng.req(cmd="version")
    time.sleep(0.5)
    with eng.cv:
        lines = list(eng.lines)
    eng.close()
    keep = ("DEVICE", "PLATFORM", "CANONICAL", "GLOBAL MEM", "MAX MEM ALLOC", "UNIFIED", "DRIVER VERSION",
            "FINALLY USED", "OPENCL VERSION", "UNUSED", "NO SUITABLE", "ERROR")
    report = [l.strip() for l in lines if any(k in l.upper() for k in keep)]
    return {"modules_on_gpu": gpu_used, "report": report[:60]}


def perf_overhead(args, rec, img, mode):
    log(f"[{mode}] -d perf overhead")
    out = {}
    for perf in (True, False):
        home = os.path.join(WORK, f"overhead-{mode}-" + ("perf" if perf else "plain"))
        eng = Engine(args.engine, home, opencl=mode_engine(mode)[0], perf=perf, extra=mode_engine(mode)[1])
        try:
            eng.req(cmd="open", path=img)
            eng.req(cmd="render", width=VIEW[0], height=VIEW[1])
            samples = []
            for i in range(max(args.repeat, 9)):
                eng.req(cmd="set", op="exposure", params={"exposure": 0.05 * (i + 1)})
                r, wall, _ = eng.req(cmd="render", width=VIEW[0], height=VIEW[1])
                samples.append({"wall": wall, "process": r.get("process_ms")})
            out[perf] = rec.add(mode, os.path.basename(img), "overhead", "with -d perf" if perf else "without -d perf",
                                samples)
            eng.req(cmd="close")
        finally:
            eng.close()


if __name__ == "__main__":
    main()
