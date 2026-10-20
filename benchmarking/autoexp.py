#!/usr/bin/env python3
# Basic's Auto (Exposure, AgX's range, then Contrast, Highlights, Shadows,
# Whites and Blacks: runAutoTone() in app/src/App.tsx), run headless over the
# benchmark corpus as the app runs it, through the app's own autoTone.ts,
# beside the Auto it replaced (`old`, ported below). there is no right answer
# to score against, so each photo records what each method set and where the
# result's tones sit, and writes PNGs as opened and after each method for
# looking at side by side. standard library only; run it as
# `python3 -I benchmarking/autoexp.py`
import argparse
import json
import math
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bench import IMG_EXT, REPO, Engine, log, send_edits  # noqa: E402
from awb import open_photo, render, write_png  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.join(REPO, "build", "autoexp-work")
# about the app's base render, which Auto reads
FRAME_SIZE = (1536, 1536)
PNG_SIZE = (768, 768)
# the app's request (App.tsx); the map's size does not matter to Auto
ZONES = {"width": 384, "height": 256, "transition": 0.5}
TONE_IDS = ["contrast", "highlights", "shadows", "whites", "blacks"]
METHODS = ["old", "app"]


def zones(eng, path):
    """the reply laid out as the app's zones command lays it out
    (app/src-tauri/src/main.rs), so the app's parseZones() reads it"""
    out = path + ".map"
    r, _, _ = eng.req(cmd="zones", stage="after", out=out, **ZONES)
    with open(out, "rb") as f:
        m = f.read()
    stats = json.dumps(r).encode()
    with open(path, "wb") as f:
        f.write(ZONES["width"].to_bytes(4, "little") + ZONES["height"].to_bytes(4, "little")
                + len(stats).to_bytes(4, "little") + stats + m)
    return sorted(m)


def ev_at(m, q):
    """a percentile of the zones map as EV from middle gray (engine/main.c, _zones)"""
    return m[int(q * (len(m) - 1))] / 20 - 6


# ------------------------------------------------------------ the old Auto

def old_exposure(current, key_ev):
    """autoExposure() before it read the zones: the mean log2 luminance
    moved 75% of the way to middle gray, up to 3 EV"""
    return round(100 * (current + max(-3, min(3, 0.75 * (math.log2(0.18) - key_ev))))) / 100


def old_tone(edits, px, w, h):
    """autoTone() before it heard about the key"""
    n = w * h
    stride = max(1, n // 120_000)
    hist = [0] * 256
    count = s = s2 = dark = bright = 0
    for i in range(0, n, stride):
        lum = (0.2126 * px[4 * i] + 0.7152 * px[4 * i + 1] + 0.0722 * px[4 * i + 2]) / 255
        hist[min(255, round(lum * 255))] += 1
        s += lum
        s2 += lum * lum
        dark += lum < 0.25
        bright += lum > 0.75
        count += 1

    def pct(q):
        acc = 0
        for k in range(256):
            acc += hist[k]
            if acc >= q * count:
                return k / 255
        return 1

    def clamp(v, lim=60):
        return round(max(-lim, min(lim, v)))

    mean = s / count
    spread = math.sqrt(max(0, s2 / count - mean * mean))
    blacks = clamp((0.03 - pct(0.005)) * 600)
    return {
        "blacks": edits.call(cmd="blacksFromLinear", v=blacks)["v"],
        "whites": clamp((0.96 - pct(0.995)) * 300),
        "shadows": clamp(max(0, dark / count - 0.2) * 150),
        "highlights": clamp(-max(0, bright / count - 0.1) * 200),
        "contrast": clamp((0.22 - spread) * 300, 40),
    }


# ------------------------------------------------------------ Auto

def run_auto(eng, edits, method, values, frame, zfile):
    """runAutoTone(): the five sliders to 0, Exposure from the key, AgX's
    range from the new exposure, then the five from the rendered frame"""
    send_edits(eng, edits, {k: 0 for k in TONE_IDS})
    out = {}
    key = {}
    if method == "old":
        out["exposure"] = old_exposure(values["exposure"], eng.req(cmd="tone_key")[0]["ev"])
    else:
        zones(eng, zfile)
        r = edits.call(cmd="autoExposure", current=values["exposure"], zones=zfile)["auto"]
        out["exposure"] = r["exposure"]
        key = {k: r[k] for k in ("lowKey", "highKey")}
    send_edits(eng, edits, {"exposure": out["exposure"]})
    if values.get("tm_mode") == 1:
        r, _, _ = eng.req(cmd="agx_auto")
        out["agx_black"], out["agx_white"] = r["black_ev"], r["white_ev"]
        send_edits(eng, edits, {"agx_black": r["black_ev"], "agx_white": r["white_ev"]})
    px, w, h = render(eng, frame, FRAME_SIZE)
    tone = old_tone(edits, px, w, h) if method == "old" else \
        edits.call(cmd="autoTone", path=frame, width=w, height=h, key=key)["values"]
    send_edits(eng, edits, tone)
    out.update(tone)
    return out, key


def display_stats(px, w, h):
    """where the result's tones sit: display luminance, 0-1"""
    lum = sorted((0.2126 * px[4 * i] + 0.7152 * px[4 * i + 1] + 0.0722 * px[4 * i + 2]) / 255
                 for i in range(0, w * h, 7))
    at = lambda q: round(lum[int(q * (len(lum) - 1))], 3)
    return {"mean": round(sum(lum) / len(lum), 3), "p5": at(0.05), "p50": at(0.5), "p95": at(0.95)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", default=os.path.join(REPO, "build", "bin", "darktable-engine"))
    ap.add_argument("--corpus", default=os.path.join(HERE, "corpus"))
    ap.add_argument("--images", help="only photos whose names contain one of these, comma separated")
    ap.add_argument("--methods", default=",".join(METHODS), help="comma separated: " + ", ".join(METHODS))
    ap.add_argument("--no-png", action="store_true", help="skip the PNGs")
    ap.add_argument("--out", default=os.path.join(WORK, "out"))
    args = ap.parse_args()
    methods = args.methods.split(",")

    files = sorted(f for f in os.listdir(args.corpus) if os.path.splitext(f)[1].lower() in IMG_EXT)
    if args.images:
        keys = args.images.split(",")
        files = [f for f in files if any(k in f for k in keys)]
    shutil.rmtree(os.path.join(WORK, "images"), ignore_errors=True)
    os.makedirs(os.path.join(WORK, "images"))
    os.makedirs(args.out, exist_ok=True)

    eng = Engine(args.engine, os.path.join(WORK, "engine"), opencl=False, perf=False)
    frame = os.path.join(WORK, "frame.rgba")
    zfile = os.path.join(WORK, "zones.bin")
    results = []
    try:
        for name in files:
            img = os.path.join(WORK, "images", name)
            shutil.copyfile(os.path.join(args.corpus, name), img)
            stem = os.path.splitext(name)[0]
            r, edits, controls = open_photo(eng, img)
            values = {k: c.get("value", c.get("neutral")) for k, c in controls.items()}
            # open_photo() gave it AgX
            if "tm_mode" in controls:
                values["tm_mode"] = 1
            start = {k: values[k] for k in ["exposure", *TONE_IDS, "agx_black", "agx_white"] if k in values}
            row = {"name": name, "raw": r.get("raw"), "auto": {}, "display": {}}
            try:
                m = zones(eng, zfile)
            except RuntimeError as e:
                # the engine's working image is not RGB (some JPEGs): Auto fails in the app too
                log(f"{name}: {e}")
                edits.close()
                eng.req(cmd="close")
                continue
            row["scene"] = {"p1": ev_at(m, 0.01), "p5": ev_at(m, 0.05), "p50": ev_at(m, 0.5),
                            "p95": ev_at(m, 0.95), "p99": ev_at(m, 0.99),
                            "mean": round(sum(m) / len(m) / 20 - 6, 2)}
            px, w, h = render(eng, frame, PNG_SIZE)
            row["display"]["opened"] = display_stats(px, w, h)
            if not args.no_png:
                write_png(os.path.join(args.out, f"{stem}-opened.png"), px, w, h)
            for meth in methods:
                send_edits(eng, edits, start)
                try:
                    vals, key = run_auto(eng, edits, meth, values, frame, zfile)
                except RuntimeError as e:
                    log(f"{name} {meth}: {e}")
                    continue
                row["auto"][meth] = {k: round(v, 2) for k, v in {**vals, **key}.items()}
                px, w, h = render(eng, frame, PNG_SIZE)
                row["display"][meth] = display_stats(px, w, h)
                if not args.no_png:
                    write_png(os.path.join(args.out, f"{stem}-{meth}.png"), px, w, h)
            log(json.dumps({"name": name, "scene": row["scene"],
                            "exposure": {k: a["exposure"] for k, a in row["auto"].items()}}))
            results.append(row)
            edits.close()
            eng.req(cmd="close")
    finally:
        eng.close()
    with open(os.path.join(args.out, "results.json"), "w") as f:
        json.dump(results, f, indent=1)
    summarize(results, methods)


def summarize(results, methods):
    print(f"\n{'photo':32} {'key':>5} {'p5':>5} {'p99':>5}  "
          + "  ".join(f"{m + ' exp':>8} {'mean':>5}" for m in methods) + f"  {'opened':>6}")
    for r in results:
        s = r["scene"]
        line = f"{r['name'][:32]:32} {s['mean']:5.2f} {s['p5']:5.2f} {s['p99']:5.2f}  "
        for m in methods:
            a, d = r["auto"].get(m), r["display"].get(m)
            line += f"{a['exposure']:+8.2f} {d['mean']:5.3f}  " if a else f"{'-':>8} {'-':>5}  "
        print(line + f"{r['display']['opened']['mean']:6.3f}")


if __name__ == "__main__":
    main()
