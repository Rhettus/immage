#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

# Auto white balance, measured headless over the benchmark corpus. each photo
# is scored as shot, after the app's Auto (gray world over the display frame,
# refined over several frames: refineWB() in app/src/App.tsx), and after each
# candidate estimator run on a linear frame. a photo listed in
# awb-neutral.json scores by how far its neutral box sits from gray (angular
# error, degrees, in linear working RGB at the mask anchor, the engine's
# `sample`); every photo also records how far each method moved Temp/Tint
# from as shot. standard library only; run it as
# `python3 -I benchmarking/awb.py`
import argparse
import json
import math
import os
import shutil
import struct
import sys
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bench import IMG_EXT, NEW_PHOTO, REPO, Edits, Engine, log, send_edits  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.join(REPO, "build", "awb-work")
PNG_SIZE = (1024, 1024)
# the linear frame the estimators read: about the engine's own sampling size
LIN_SIZE = (512, 512)
# the linear frame is darkened so little of it clips in 8 bits
LIN_EV = -2.0
# where the estimators start from
START = {"temp": 5000, "tint": 0}
TONE_MAPPERS = ["agx", "sigmoid", "filmicrgb"]


def render(eng, path, size):
    r, _, _ = eng.req(cmd="render", width=size[0], height=size[1], rgba=path)
    with open(path, "rb") as f:
        return f.read(), r["width"], r["height"]


def write_png(path, px, w, h):
    rows = b"".join(b"\0" + bytes(px[4 * w * y + i] for i in range(4 * w) if i % 4 != 3) for y in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(rows, 6)) + chunk(b"IEND", b""))


def gray_world_display(px, w, h):
    """grayWorld() in App.tsx"""
    n = w * h
    stride = max(1, n // 200_000)
    s = [0, 0, 0]
    k = 0
    for i in range(0, n, stride):
        r, g, b = px[4 * i], px[4 * i + 1], px[4 * i + 2]
        if r >= 250 or g >= 250 or b >= 250 or r + g + b < 30:
            continue
        s[0] += r
        s[1] += g
        s[2] += b
        k += 1
    return [v / k / 255 for v in s] if k else None


def set_wb(eng, edits, wb):
    send_edits(eng, edits, {"temp": wb["temp"], "tint": wb["tint"]})


def neutralize(edits, wb, rgb):
    return edits.call(cmd="neutralize", wb=wb, rgb=rgb)["wb"]


def old_auto(eng, edits, wb, frame):
    """the Auto that white patch replaced: gray world over the display frame, corrected and
    rendered again until the change is too small to see or four
    corrections have gone in"""
    for rnd in range(5):
        px, w, h = render(eng, frame, PNG_SIZE)
        rgb = gray_world_display(px, w, h)
        nxt = rgb and neutralize(edits, wb, rgb)
        if not nxt:
            break
        settled = abs(1e6 / nxt["temp"] - 1e6 / wb["temp"]) < 2 and abs(nxt["tint"] - wb["tint"]) < 1
        if settled or rnd >= 4:
            break
        wb = nxt
        set_wb(eng, edits, wb)
    return wb


def app_auto(eng, edits, wb, frame, anchor):
    """refineWB() and startWB() in App.tsx, through the app's own wb.ts:
    white patch over the display frame, refined over frames, then, when
    the camera balanced the photo itself, only a nudge from its setting"""
    rnd = 0
    while True:
        r, _, _ = eng.req(cmd="render", width=PNG_SIZE[0], height=PNG_SIZE[1], rgba=frame)
        rgb = edits.call(cmd="whitePatch", path=frame, width=r["width"], height=r["height"])["rgb"]
        nxt = rgb and neutralize(edits, wb, rgb)
        settled = bool(nxt) and abs(1e6 / nxt["temp"] - 1e6 / wb["temp"]) < 2 and abs(nxt["tint"] - wb["tint"]) < 1
        if not nxt or settled or rnd >= 4:
            if anchor and (nxt or rnd):
                return edits.call(cmd="anchored", shot=anchor, est=nxt or wb)["wb"]
            return wb if not nxt else nxt if settled else wb
        rnd += 1
        wb = nxt
        set_wb(eng, edits, wb)


# ------------------------------------------------------------ the linear frame

def to_linear(v):
    v /= 255
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def to_srgb(v):
    return 12.92 * v if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055


LUT = [to_linear(v) for v in range(256)]


class Linear:
    """a frame as linear sRGB, and which pixels say anything about color:
    no channel clipped, not black"""

    def __init__(self, px, w, h):
        self.w, self.h = w, h
        n = w * h
        self.rgb = [(LUT[px[4 * i]], LUT[px[4 * i + 1]], LUT[px[4 * i + 2]]) for i in range(n)]
        self.ok = [max(px[4 * i], px[4 * i + 1], px[4 * i + 2]) < 250 and max(c) > 0.002
                   for i, c in enumerate(self.rgb)]

    def valid(self):
        return [c for c, ok in zip(self.rgb, self.ok) if ok]


def est_gray_world(f):
    v = f.valid()
    return [sum(c[k] for c in v) / len(v) for k in range(3)] if v else None


def est_shades_of_gray(f, p=6):
    v = f.valid()
    return [(sum(c[k] ** p for c in v) / len(v)) ** (1 / p) for k in range(3)] if v else None


def est_bright_weighted(f):
    """the mean weighted by luminance: bright surfaces say more about the
    light than dark ones"""
    v = f.valid()
    ws = [0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] for c in v]
    t = sum(ws)
    return [sum(c[k] * w for c, w in zip(v, ws)) / t for k in range(3)] if t else None


def est_white_patch(f, top=0.02):
    """the mean of the brightest unclipped pixels"""
    v = sorted(f.valid(), key=max)
    v = v[int(len(v) * (1 - top)):]
    return [sum(c[k] for c in v) / len(v) for k in range(3)] if v else None


def est_gray_edge(f, p=6):
    """first-order gray edge (van de Weijer et al.): the Minkowski mean of
    each channel's gradient, over a 3x3 box blur, where every pixel in the
    neighborhood is usable"""
    w, h, rgb, ok = f.w, f.h, f.rgb, f.ok
    blur = [None] * (w * h)
    for y in range(1, h - 1):
        for x in range(1, w - 1):
            i = y * w + x
            nb = [i + dy * w + dx for dy in (-1, 0, 1) for dx in (-1, 0, 1)]
            if all(ok[j] for j in nb):
                blur[i] = [sum(rgb[j][k] for j in nb) / 9 for k in range(3)]
    s = [0.0, 0.0, 0.0]
    n = 0
    for y in range(2, h - 2):
        for x in range(2, w - 2):
            i = y * w + x
            a, b, c, d = blur[i - 1], blur[i + 1], blur[i - w], blur[i + w]
            if a is None or b is None or c is None or d is None:
                continue
            for k in range(3):
                s[k] += math.hypot(b[k] - a[k], d[k] - c[k]) ** p
            n += 1
    return [(v / n) ** (1 / p) for v in s] if n else None


# sRGB (D65) to XYZ, and back
M = [[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]]
MI = [[3.2406, -1.5372, -0.4986], [-0.9689, 1.8758, 0.0415], [0.0557, -0.2040, 1.0570]]
mul = lambda m, v: [m[r][0] * v[0] + m[r][1] * v[1] + m[r][2] * v[2] for r in range(3)]
D65 = (0.3127, 0.3290)


def _dt_detect(f, surfaces):
    """color calibration's auto-detection (_auto_detect_WB in
    src/iop/channelmixerrgb.c, compiled out there), on this frame: in xy
    shifted so white is the origin, "edges" averages the normalized
    chromaticity laplacian; "surfaces" averages local means weighted by
    their chroma variance and covariance"""
    w, h = f.w, f.h
    norm = math.hypot(*D65)
    t = []
    for c in f.rgb:
        X, Y, Z = mul(M, c)
        s = max(X + Y + Z, 1e-9)
        t.append(((X / s - D65[0]) / norm, (Y / s - D65[1]) / norm))
    off = 2
    acc = [0.0, 0.0]
    el = 0.0
    k = [(-1, -1, 1), (-1, 0, 2), (-1, 1, 1), (0, -1, 2), (0, 0, 4), (0, 1, 2), (1, -1, 1), (1, 0, 2), (1, 1, 1)]
    for i in range(2 * off, h - 4 * off, off):
        for j in range(2 * off, w - 4 * off, off):
            nb = [((i + di * off) * w + j + dj * off, wt) for di, dj, wt in k]
            if not all(f.ok[q] for q, _ in nb):
                continue
            ca = [sum(t[q][c] * wt for q, wt in nb) / 16 for c in range(2)]
            if surfaces:
                ca = [max(v, 0.0) for v in ca]
                var = [sum((t[q][c] - ca[c]) ** 2 for q, _ in nb) / 9 for c in range(2)]
                cov = sum((t[q][0] - ca[0]) * (t[q][1] - ca[1]) for q, _ in nb) / 9
                pn = (abs(ca[0]) ** 8 + abs(ca[1]) ** 8) ** (1 / 8) + 1e-9
                wt = var[0] * var[1] * cov
                acc[0] += ca[0] * wt / pn
                acc[1] += ca[1] * wt / pn
                el += wt / pn
            else:
                dd = [t[i * w + j][c] - ca[c] for c in range(2)]
                pn = (abs(dd[0]) ** 8 + abs(dd[1]) ** 8) ** (1 / 8) + 1e-9
                acc[0] -= dd[0] / pn
                acc[1] -= dd[1] / pn
                el += 1
    if not el:
        return None
    x, y = norm * acc[0] / el + D65[0], norm * acc[1] / el + D65[1]
    if y <= 0:
        return None
    return mul(MI, [x / y, 1.0, (1 - x - y) / y])


def est_gray_index(f, top=0.001):
    """the grayness index (Qian et al., "On Finding Gray Pixels", CVPR
    2019): a gray surface's log chromaticity does not change where its
    shading does, so pixels whose log(R/L) and log(B/L) have no laplacian
    while log L has one are taken as gray, and the light is their mean"""
    w, h, rgb, ok = f.w, f.h, f.rgb, f.ok
    eps = 1e-4
    lg = [None] * (w * h)
    for i, c in enumerate(rgb):
        if ok[i] and min(c) > eps:
            s = c[0] + c[1] + c[2]
            lg[i] = (math.log(c[0] / s), math.log(c[2] / s), math.log(s))
    gi = []
    for y in range(1, h - 1):
        for x in range(1, w - 1):
            i = y * w + x
            nb = (lg[i - 1], lg[i + 1], lg[i - w], lg[i + w])
            if lg[i] is None or any(v is None for v in nb):
                continue
            lap = [sum(v[k] for v in nb) - 4 * lg[i][k] for k in range(3)]
            # flat shading says nothing about grayness
            if abs(lap[2]) < 0.1:
                continue
            gi.append((math.hypot(lap[0], lap[1]), i))
    if not gi:
        return None
    gi.sort()
    sel = gi[:max(10, int(len(gi) * top))]
    s = [0.0, 0.0, 0.0]
    for _, i in sel:
        n = sum(rgb[i])
        for k in range(3):
            s[k] += rgb[i][k] / n
    return s


ESTIMATORS = {
    "gray_index": est_gray_index,
    "gray_world": est_gray_world,
    "shades_of_gray": est_shades_of_gray,
    "bright_weighted": est_bright_weighted,
    "white_patch": est_white_patch,
    "gray_edge": est_gray_edge,
    "dt_edges": lambda f: _dt_detect(f, False),
    "dt_surfaces": lambda f: _dt_detect(f, True),
}


def estimate_wb(eng, edits, name, wb, frame, rounds=2, size=LIN_SIZE):
    """the estimator's Temp/Tint: what neutralizes the light it finds, read
    from frames rendered under `wb`, repeated so the render's own bend is
    taken out"""
    for _ in range(rounds):
        set_wb(eng, edits, wb)
        px, w, h = render(eng, frame, size)
        e = ESTIMATORS[name](Linear(px, w, h))
        if not e or min(e) <= 0:
            return None
        top = max(e)
        nxt = neutralize(edits, wb, [to_srgb(0.5 * v / top) for v in e])
        if not nxt:
            return None
        wb = nxt
    return wb


# ------------------------------------------------------------------ scoring

def box_error(eng, box):
    """degrees between the box's mean linear color and gray"""
    r, _, _ = eng.req(cmd="sample", box=box)
    c = [r["channels"][k]["mean"] for k in ("R", "G", "B")]
    dot = sum(c) / math.sqrt(3)
    norm = math.sqrt(sum(v * v for v in c))
    return math.degrees(math.acos(max(-1.0, min(1.0, dot / norm)))) if norm else None


def shift(a, b):
    """how far apart two Temp/Tints are: mireds, and tint"""
    return {"mired": round(1e6 / b["temp"] - 1e6 / a["temp"], 1), "tint": round(b["tint"] - a["tint"], 1)}


def anchored(shot, est, alpha, cap_mired, cap_tint):
    """as shot, moved part of the way toward an estimate, and no further
    than the caps: the camera's own judgment, corrected where an estimator
    disagrees with it"""
    m0, m1 = 1e6 / shot["temp"], 1e6 / est["temp"]
    dm = max(-cap_mired, min(cap_mired, alpha * (m1 - m0)))
    dt = max(-cap_tint, min(cap_tint, alpha * (est["tint"] - shot["tint"])))
    return {"temp": round(1e6 / (m0 + dm)), "tint": round(shot["tint"] + dt, 1)}


# the anchored variants --tune scores: estimator, alpha, mired cap, tint cap
TUNE = [(e, a, cm, ct) for e in ("white_patch", "disp_white_patch", "disp1_white_patch")
        for a in (0.25, 0.5, 0.75, 1.0) for cm in (15, 30, 60) for ct in (5, 10, 20)]


def open_photo(eng, img):
    r, _, _ = eng.req(cmd="open", path=img)
    edits = Edits()
    fields = edits.call(cmd="fields")["fields"]
    info, _, _ = eng.req(cmd="get", modules=fields)
    ctx = {"sensorWidth": r.get("sensor_width"), "sensorHeight": r.get("sensor_height"),
           "orientation": r.get("orientation", 0)}
    controls = edits.call(cmd="init", info=info["modules"], ctx=ctx)["controls"]
    send_edits(eng, edits, {k: v for k, v in NEW_PHOTO.items()
                            if k in controls and (r.get("raw") or k == "tm_mode")})
    return r, edits, controls


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", default=os.path.join(REPO, "build", "bin", "darktable-engine"))
    ap.add_argument("--corpus", default=os.path.join(HERE, "corpus"))
    ap.add_argument("--images", help="only photos whose names contain one of these, comma separated")
    ap.add_argument("--methods", default=",".join(ESTIMATORS), help="estimators to run, comma separated")
    ap.add_argument("--no-png", action="store_true", help="skip the PNGs of each result")
    ap.add_argument("--display", default="",
                    help="estimators also run on the app's display frame, as the app could, comma separated")
    ap.add_argument("--tune", action="store_true", help="also score the anchored variants in TUNE (no PNGs)")
    ap.add_argument("--out", default=os.path.join(WORK, "out"))
    args = ap.parse_args()
    methods = args.methods.split(",")

    with open(os.path.join(HERE, "awb-neutral.json")) as f:
        truth = json.load(f)["boxes"]
    files = sorted(f for f in os.listdir(args.corpus) if os.path.splitext(f)[1].lower() in IMG_EXT)
    if args.images:
        keys = args.images.split(",")
        files = [f for f in files if any(k in f for k in keys)]
    shutil.rmtree(os.path.join(WORK, "images"), ignore_errors=True)
    os.makedirs(os.path.join(WORK, "images"))
    os.makedirs(args.out, exist_ok=True)

    eng = Engine(args.engine, os.path.join(WORK, "engine"), opencl=False, perf=False)
    frame = os.path.join(WORK, "frame.rgba")
    results = []
    try:
        for name in files:
            img = os.path.join(WORK, "images", name)
            shutil.copyfile(os.path.join(args.corpus, name), img)
            stem = os.path.splitext(name)[0]
            box = truth.get(name, {}).get("box")
            r, edits, controls = open_photo(eng, img)
            shot = {"temp": controls["temp"]["value"], "tint": controls["tint"]["value"]}
            exif = eng.req(cmd="meta", imgid=r["imgid"])[0]["image"]["exif"]
            anchor = shot if exif.get("white_balance", "").lower().startswith("auto") else None
            wbs = {"as_shot": shot, "old_auto": old_auto(eng, edits, dict(shot), frame)}
            set_wb(eng, edits, shot)
            wbs["app_auto"] = app_auto(eng, edits, dict(shot), frame, anchor)
            # as the camera had not balanced it: the estimate alone
            set_wb(eng, edits, shot)
            wbs["app_auto_free"] = app_auto(eng, edits, dict(shot), frame, None)

            # on the display frame (tone mapped, 8 bits), linearized; the app
            # refines over frames, so these get more rounds
            for m in filter(None, args.display.split(",")):
                wbs["disp_" + m] = estimate_wb(eng, edits, m, dict(shot), frame, rounds=4, size=(768, 768))
                # one frame's estimate, as Auto takes it to nudge a camera's auto white balance
                wbs["disp1_" + m] = estimate_wb(eng, edits, m, dict(shot), frame, rounds=1, size=(768, 768))

            # the estimators' frames: no tone mapper, darker, otherwise as the app renders
            set_wb(eng, edits, shot)
            exposure = controls["exposure"]["value"]
            send_edits(eng, edits, {"exposure": exposure + LIN_EV})
            on = eng.req(cmd="get", modules={op: [] for op in TONE_MAPPERS})[0]["modules"]
            on = [op for op in TONE_MAPPERS if on.get(op, {}).get("enabled")]
            for op in on:
                eng.req(cmd="set", op=op, enabled=False)
            for m in methods:
                wbs[m] = estimate_wb(eng, edits, m, dict(START), frame)
            for op in on:
                eng.req(cmd="set", op=op, enabled=True)
            send_edits(eng, edits, {"exposure": exposure})
            tuned = set()
            if args.tune:
                for e, a, cm, ct in TUNE:
                    if wbs.get(e):
                        k = f"{e}@{a}/{cm}/{ct}"
                        wbs[k] = anchored(shot, wbs[e], a, cm, ct)
                        tuned.add(k)

            row = {"name": name, "raw": r.get("raw"), "neutral": box is not None, "wb": {}, "error": {}, "shift": {}}
            for m, wb in wbs.items():
                if not wb:
                    continue
                set_wb(eng, edits, wb)
                row["wb"][m] = {"temp": round(wb["temp"]), "tint": round(wb["tint"], 1)}
                if m != "as_shot":
                    row["shift"][m] = shift(shot, wb)
                if box:
                    row["error"][m] = round(box_error(eng, box), 2)
                if not args.no_png and m not in tuned:
                    px, w, h = render(eng, frame, PNG_SIZE)
                    write_png(os.path.join(args.out, f"{stem}-{m}.png"), px, w, h)
            log(json.dumps({"name": name, "error": {m: v for m, v in row["error"].items() if m not in tuned},
                            "shift": {m: s["mired"] for m, s in row["shift"].items() if m not in tuned}}))
            results.append(row)
            edits.close()
            eng.req(cmd="close")
    finally:
        eng.close()
    with open(os.path.join(args.out, "results.json"), "w") as f:
        json.dump(results, f, indent=1)
    summarize(results)


def summarize(results):
    methods = list(dict.fromkeys(m for r in results for m in r["wb"]))
    scored = [r for r in results if r["error"]]
    print(f"\nneutral-box error, degrees ({len(scored)} photos): mean / median / worst; "
          f"and over all {len(results)} photos, the median shift from as shot in mireds")
    for m in methods:
        e = sorted(r["error"][m] for r in scored if m in r["error"])
        s = sorted(abs(r["shift"][m]["mired"]) for r in results if m in r["shift"])
        line = f"  {m:16}"
        if e:
            line += f" {sum(e) / len(e):6.2f} {e[len(e) // 2]:6.2f} {e[-1]:6.2f}"
        if s:
            line += f"   shift {s[len(s) // 2]:6.1f}"
        print(line)


if __name__ == "__main__":
    main()
