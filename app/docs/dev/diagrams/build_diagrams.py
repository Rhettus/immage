#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

# Immage's developer diagrams, from the specs below: for each, an Excalidraw
# scene (<name>.excalidraw, open it in excalidraw.com or the VS Code
# extension) and a plain SVG of the same boxes and arrows (<name>.svg, which
# the code map shows inline). edit a spec and rerun:
#   python3 -I app/docs/dev/diagrams/build_diagrams.py
# with --view NAME it prints that diagram in the shorthand Claude's Excalidraw
# connector draws from, instead of writing files.
# edits made in Excalidraw itself live only in the .excalidraw file; fold them
# back into the spec here, or they are lost on the next run
import json
import os
import random
import sys
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))

# fills by role: the same in every diagram
UI, RUST, ENGINE, DT, STORE, EXT, NOTE = "ui", "rust", "engine", "dt", "store", "ext", "note"
FILL = {UI: "#a5d8ff", RUST: "#ffd8a8", ENGINE: "#d0bfff", DT: "#b2f2bb", STORE: "#c3fae8", EXT: "#e9ecef",
        NOTE: "#fff3bf"}
STROKE = {UI: "#1971c2", RUST: "#e8590c", ENGINE: "#6741d9", DT: "#2f9e44", STORE: "#0c8599", EXT: "#495057",
          NOTE: "#f08c00"}
ZONE = {UI: "#dbe4ff", RUST: "#fff4e6", ENGINE: "#e5dbff", DT: "#d3f9d8", STORE: "#e3fafc"}
INK = "#1e1e1e"
# Excalidraw's "Normal" font (Helvetica) and roughness 0 ("architect"):
# straight lines and plain text, not the hand-drawn look
FONT = 2
MUTED = "#495057"


# ---------------------------------------------------------------- the specs

def col(i):
    return 40 + 300 * i


W, H = 228, 84


def dataflow():
    """the processes and the code blocks in them, and what crosses between them"""
    lanes = [(UI, "WebView: React front end (app/src)", 60, 140),
             (RUST, "Tauri core: Rust (app/src-tauri/src)", 250, 140),
             (ENGINE, "darktable-engine: one child process (engine/main.c)", 440, 330),
             (DT, "darktable core (libdarktable)", 820, 140),
             (STORE, "Storage and outside Immage", 1010, 140)]
    els = [("title", -190, 0, "Immage: data flow between the code blocks", 28)]
    for kind, label, y, h in lanes:
        els.append(("zone", f"z_{kind}", col(-1) - 20, y, 300 * 9 - 32, h, label, kind))
    r1, r2, r3a, r3b, r4, r5 = 95, 285, 475, 615, 855, 1045
    boxes = [
        ("localstorage", -1, r1, "localStorage\nimmage.* prefs", STORE),
        ("app", 0, r1, "App.tsx\nviewer · panels · undo", UI),
        ("session", 1, r1, "session.ts · Session\npump · masks · save", UI),
        ("manifest", 2, r1, "manifest.ts\ncontrols ↔ module params", UI),
        ("perf", 3, r1, "perf.ts · PerfHud\ntimings by stage", UI),
        ("library", 5, r1, "library.ts\nfolders · thumbnails", UI),
        ("exportdlg", 6, r1, "ExportDialog.tsx\nsettings · preview", UI),
        ("extapps", -1, r2, "External apps\n(DxO PureRAW)", EXT),
        ("plugins", 0, r2, "plugins.rs\nEdit In · watcher", RUST),
        ("commands", 1, r2, "main.rs commands\ninvoke handlers", RUST),
        ("appstate", 2, r2, "AppState\nMutex<Engine>", RUST),
        ("enginers", 3, r2, "engine.rs\nchild process · stderr", RUST),
        ("sdcards", 4, r2, "SD cards", EXT),
        ("immporter", 5, r2, "immporter plugin\nimport · Immich key", RUST),
        ("immich", 6, r2, "immich_*.rs\nsearch · upload", RUST),
        ("immichsrv", 7, r2, "Immich server", EXT),
        ("session_s", 2, r3a, "session _s\nimage · develop · pipes", ENGINE),
        ("handle", 3, r3a, "_handle()\none command per line", ENGINE),
        ("libcmds", 6, r3a, "library commands\nfolder · thumb · meta", ENGINE),
        ("ppipe", 1, r3b, "ppipe\npreviews · AI input", ENGINE),
        ("pipe", 2, r3b, "pipe (main)\nevery frame", ENGINE),
        ("edits", 3, r3b, "masks · spots · looks\nzones · ranges", ENGINE),
        ("export", 4, r3b, "export\nframe · AI upscale", ENGINE),
        ("ai", 5, r3b, "AI features\nmasks · depth · denoise", ENGINE),
        ("mipmap", 0, r4, "mipmap_cache\nFULL · F mip · thumbs", DT),
        ("pixelpipe", 1, r4, "pixelpipe_hb.c\n+ pipe cache", DT),
        ("iops", 2, r4, "iop modules\nexposure · agx · ...", DT),
        ("develop", 3, r4, "develop.c · masks\nhistory · module list", DT),
        ("styles", 4, r4, "styles.c · imageio\nlooks · formats", DT),
        ("aibackend", 5, r4, "AI backend\nONNX Runtime", DT),
        ("imagedb", 6, r4, "image · film · DB\n:memory: library", DT),
        ("runtime", 1, r5, "runtime folder\nframe.rgba · presets\nconfig · cache · log", STORE),
        ("models", 5, r5, "AI models · caches", STORE),
        ("photos", 6, r5, "photos +\nXMP sidecars", STORE),
    ]
    for bid, c, y, text, kind in boxes:
        els.append(("box", bid, col(c), y, W, H, text, kind))
    edges = [
        ("app", "session", "set()", {}),
        ("session", "manifest", "maps", {}),
        ("app", "localstorage", "prefs", {}),
        ("perf", "commands", "perf_*", {"fa": (0.5, 1), "fb": (0.85, 0),
                                       "via": [(col(3) + 114, 214), (col(1) + 194, 214)]}),
        ("session", "commands", "set_params · render", {"fa": (0.3, 1), "fb": (0.3, 0)}),
        ("commands", "session", "Frame: 48 B header + RGBA", {"fa": (0.7, 0), "fb": (0.7, 1)}),
        ("library", "commands", "open_folder · thumb", {"fa": (0.5, 1), "fb": (0.95, 0),
                                                         "via": [(col(5) + 114, 232), (col(1) + 217, 232)]}),
        ("exportdlg", "commands", "export_images", {"fa": (0.5, 1), "fb": (0.75, 0),
                                                    "via": [(col(6) + 114, 250), (col(1) + 171, 250)]}),
        ("commands", "appstate", "lock", {}),
        ("appstate", "enginers", "request", {}),
        ("enginers", "handle", "JSON lines: stdin ↓ stdout ↑", {"both": True}),
        ("handle", "session_s", "edit", {}),
        ("handle", "libcmds", "folder · import · thumb", {}),
        ("session_s", "pipe", "render", {}),
        ("session_s", "ppipe", "preview", {}),
        ("handle", "edits", "mask · spots · look", {}),
        ("handle", "export", "export", {"fa": (0.7, 1), "fb": (0.3, 0)}),
        ("handle", "ai", "ai_*", {"fa": (0.95, 1), "fb": (0.3, 0)}),
        ("pipe", "pixelpipe", "process", {}),
        ("pipe", "mipmap", "FULL raw", {"fa": (0.15, 1), "fb": (0.85, 0)}),
        ("pixelpipe", "iops", "process", {}),
        ("edits", "develop", "history · masks", {}),
        ("export", "styles", "temp style", {}),
        ("ai", "aibackend", "models", {}),
        ("libcmds", "imagedb", "import · meta", {}),
        ("imagedb", "photos", "read · write sidecar", {"both": True}),
        ("aibackend", "models", "load · cache", {}),
        ("plugins", "extapps", "launch", {}),
        ("immporter", "sdcards", "copy", {}),
        ("immich", "immichsrv", "HTTP", {}),
        ("pipe", "runtime", "frame.rgba", {"dashed": True, "fa": (1, 0.8), "fb": (1, 0.5),
                                           "via": [(col(3) - 36, 682), (col(3) - 36, 1087)], "label_at": 2}),
    ]
    for a, b, label, opt in edges:
        if not opt.get("skip"):
            els.append(("edge", a, b, label, opt))
    els.append(("text", col(-1), 1210, "frame.rgba is written by the engine and read back by Rust while it still holds "
                "the engine; every engine call waits on the one Mutex<Engine>.", 16, MUTED))
    els.append(("text", col(-1), 1236, "On Windows the frame goes to the page in a WebView2 shared buffer "
                "(sharedFrames.ts) and render replies with the header alone.", 16, MUTED))
    return els


def entities():
    """the things the code passes around, and how they relate"""
    els = [("title", 40, 0, "Immage: entities and their relationships", 28)]
    els.append(("zone", "z_fe", 20, 50, 2050, 720, "Front end (TypeScript)", UI))
    els.append(("zone", "z_en", 20, 800, 2050, 340, "Engine and darktable (C)", ENGINE))
    els.append(("zone", "z_st", 20, 1150, 2050, 140, "Storage", STORE))
    E = 250

    def ent(eid, x, y, title, fields, kind, w=E):
        els.append(("box", eid, x, y, w, 26 + 22 * (len(fields) + 1), title + "\n" + "\n".join(fields), kind))

    # six columns, 90 px channels between them for the arrows that cross rows
    X = [60, 400, 740, 1080, 1420, 1760]
    A, B, C, D = 90, 290, 470, 640
    ch = [x - 45 for x in X] + [X[5] + 250 + 45]   # the channel left of each column, and right of the last
    ent("panel", X[0], A, "Panel", ["id · title · graph", "sections: Section[]"], UI)
    ent("section", X[1], A, "Section", ["title · group", "controls: Control[]"], UI)
    ent("control", X[2], A, "Control", ["id · kind · min · max", "step · neutral · format"], UI)
    ent("modulemap", X[3], A, "ModuleMap", ["op ('op#name' = instance)", "fields · read() · write()", "enabled() · keepOn · after"], UI)
    ent("imageentry", X[4], A, "ImageEntry", ["imgid · path · rating", "labels · exif · remote?"], UI)
    ent("exportset", X[5], A, "ExportSettings", ["format · size · naming", "borders · texts · target"], UI)
    ent("look", X[1], B, "Look", ["name · group", "path (darktable style)"], UI)
    ent("session", X[2], B, "Session", ["imgid · values · info · ctx", "dirty ops · pump()", "masks · spots · look"], UI)
    ent("values", X[3], B, "Values", ["{ control id: number }", "Lightroom units"], UI)
    ent("view", X[4], B, "View", ["width · height", "scale · x · y · draft"], UI)
    ent("exportpreset", X[5], B, "ExportPreset", ["name · builtin", "settings: Partial"], UI)
    ent("mask", X[0], C, "Mask", ["name · invert · opacity", "refine · values (l_*)"], UI)
    ent("spot", X[1], C, "Spot", ["heal | clone", "shape · source sx, sy"], UI)
    ent("historyitem", X[2], C, "HistoryItem", ["op · name · label", "enabled"], UI)
    ent("preset", X[3], C, "Preset", ["name · group", "values: Values"], UI)
    ent("frame", X[4], C, "Frame", ["pixels (RGBA) · size", "fullWidth · x · y · trace"], UI)
    ent("shape", X[0], D, "Shape", ["ellipse | gradient | brush", "range | AI object | depth"], UI)
    ent("pluginconfig", X[4], D, "PluginConfig", ["kind · app · send", "outputDir · onReturn"], UI)
    ent("pluginreturn", X[5], D, "PluginReturn", ["plugin · original", "result file"], UI)
    E1, E2, S1 = 840, 990, 1180
    ent("engsession", X[1], E1, "dt_engine_session_t _s", ["open · imgid · unsaved", "pipe · ppipe"], ENGINE, 270)
    ent("develop", X[2] + 40, E1, "dt_develop_t", ["iop list (module instances)", "history · history_end", "masks (forms)"], DT, 270)
    ent("iop", X[4] - 40, E1, "module instance", ["dt_iop_module_t: op", "multi_name · params", "blend_params"], DT, 290)
    ent("pipes", X[1], E2, "dt_dev_pixelpipe_t", ["nodes per module · cache", "backbuf (8-bit)"], DT, 270)
    ent("mip", X[2] + 40, E2, "mipmap buffer", ["FULL raw · F mip", "thumbnails"], DT, 270)
    ent("photo", X[1], S1, "photo file", ["raw · JPEG · HEIF ..."], STORE, 270)
    ent("xmp", X[4] - 40, S1, "XMP sidecar", ["history · masks", "rating · tags"], STORE, 290)
    mid = lambda x, w=E: x + w / 2
    rel = [
        ("panel", "section", "1 → *", {}),
        ("section", "control", "1 → *", {}),
        ("control", "modulemap", "by id", {}),
        ("modulemap", "values", "read / write", {}),
        ("values", "control", "keyed by id", {"fa": (0.15, 0), "fb": (0.85, 1)}),
        ("session", "values", "holds", {}),
        ("session", "look", "0..1", {}),
        ("session", "mask", "0..*", {"fa": (0.1, 1), "fb": (0.8, 0)}),
        ("session", "spot", "0..*", {"fa": (0.3, 1), "fb": (0.7, 0)}),
        ("session", "historyitem", "history", {}),
        ("mask", "shape", "1..*", {}),
        ("preset", "values", "a set of", {}),
        ("view", "frame", "render → Frame", {}),
        ("imageentry", "session", "openFile(path, imgid)", {"fa": (0.3, 1), "fb": (0.5, 0),
                                                            "via": [(X[4] + 75, 250), (mid(X[2]), 250)]}),
        ("imageentry", "exportset", "export", {}),
        ("exportpreset", "exportset", "partial", {}),
        ("pluginconfig", "pluginreturn", "1 → *", {}),
        ("pluginreturn", "imageentry", "result opened as", {"fa": (1, 0.5), "fb": (0.5, 0),
                                                           "via": [(ch[6], D + 46), (ch[6], 66), (mid(X[4]), 66)],
                                                           "label_at": 2}),
        ("session", "engsession", "one per open photo", {"fa": (0, 0.85), "fb": (0.5, 0),
                                                          "via": [(ch[2], B + 98), (ch[2], 812), (X[1] + 135, 812)]}),
        ("engsession", "develop", "dev", {}),
        ("develop", "iop", "1 → *", {}),
        ("modulemap", "iop", "op · fields", {"fa": (1, 0.7), "fb": (0.5, 0),
                                             "via": [(ch[4], A + 80), (ch[4], 812), (X[4] + 105, 812)]}),
        ("mask", "iop", "own instance per local map", {"fa": (0, 0.5), "fb": (0.15, 0), "dashed": True,
                                                       "via": [(36, C + 46), (36, 790), (X[4] + 4, 790)]}),
        ("engsession", "pipes", "3 pipes", {}),
        ("pipes", "mip", "input", {}),
        ("pipes", "frame", "backbuf → frame.rgba", {"fa": (0.5, 1), "fb": (0.5, 1), "dashed": True,
                                                    "via": [(X[1] + 135, 1110), (ch[5], 1110), (ch[5], 600),
                                                            (mid(X[4]), 600)]}),
        ("mip", "photo", "decoded from", {"fa": (0.3, 1), "fb": (0.7, 0)}),
        ("develop", "xmp", "save · load", {"fa": (1, 0.8), "fb": (0, 0.5), "both": True,
                                            "via": [(ch[4] - 20, E1 + 91), (ch[4] - 20, S1 + 46)]}),
    ]
    for a, b, label, opt in rel:
        if not opt.get("skip"):
            els.append(("edge", a, b, label, opt))
    return els


def slider_sequence():
    """one slider move, from the hand to the screen"""
    els = [("title", 40, 0, "Immage: one slider move, hand to screen", 28)]
    actors = [("hand", "Slider\n(input event)", UI), ("app", "App.tsx\nchange() · drawFrame", UI),
              ("pump", "Session.pump\n(session.ts)", UI), ("rust", "Rust commands\n(main.rs)", RUST),
              ("engine", "engine\n_handle · _set · _render", ENGINE), ("dt", "darktable\npixelpipe + modules", DT)]
    xs = {}
    for i, (aid, label, kind) in enumerate(actors):
        x = 40 + 270 * i
        xs[aid] = x + 115
        els.append(("box", f"h_{aid}", x, 60, 230, 64, label, kind))
    y = 170
    msgs = [
        ("hand", "app", "onChange (every input event)", False),
        ("app", "pump", "Session.set(): mark module dirty", False),
        ("pump", "rust", "invoke set_params (each dirty module)", False),
        ("rust", "engine", "JSON line: set", False),
        ("engine", "dt", "write fields · history item · synch_top", False),
        ("rust", "pump", "ok", True),
        ("pump", "rust", "invoke render(View)", False),
        ("rust", "engine", "lock engine · JSON line: render", False),
        ("engine", "dt", "dt_dev_pixelpipe_process", False),
        ("dt", "dt", "modules from the changed one on;\nthe rest from the pipe cache", False),
        ("dt", "engine", "backbuf (8-bit BGRA)", True),
        ("engine", "engine", "swizzle → frame.rgba", False),
        ("engine", "rust", "reply: size · process_ms · write_ms", True),
        ("rust", "rust", "read frame.rgba", False),
        ("rust", "rust", "Windows: post the frame in a\nWebView2 shared buffer, by id", False),
        ("rust", "pump", "Response: header + RGBA (Windows: header)", True),
        ("pump", "pump", "Windows: copy the buffer out\nand release it (sharedFrames.ts)", False),
        ("pump", "app", "onFrame(Frame)", True),
        ("app", "app", "putImageData · histogram · paint", False),
    ]
    for i, (a, b, label, dashed) in enumerate(msgs):
        if a == b:
            els.append(("self", f"m{i}", xs[a], y, label))
            y += 64
        else:
            els.append(("msg", f"m{i}", xs[a], y, xs[b], y, label, dashed))
            y += 50
    # the lifelines, as long as the messages, behind them
    for aid, x in xs.items():
        els.insert(1, ("line", f"l_{aid}", x, 124, x, y))
    els.append(("box", "n1", 300, y + 10, 460, 70,
                "moves during a render only mark modules dirty:\nthe next round sends the latest values once", NOTE))
    els.append(("box", "n2", 820, y + 10, 460, 70,
                "600 ms after the last edit: save → history,\nXMP sidecar; the filmstrip thumb refreshes", NOTE))
    els.append(("text", 40, y + 110, "Timings for every hop: benchmarking/bench.py and the Performance overlay "
                "(Preferences → General).", 16, MUTED))
    return els


def masks():
    """one mask's sliders, and the module instances they land on in darktable's pipe"""
    els = [("title", 40, 0, "Immage: one mask, and where its sliders run in darktable's pipe", 28)]
    AX, PX, MX = 60, 520, 1060
    AW, PW, MW = 300, 380, 300
    top, step, h = 130, 64, 48
    y = lambda r: top + step * r
    stack = [
        ("raw", "rawprepare · demosaic", "", DT),
        ("dn", "denoise (profiled)", "global Noise Reduction", DT),
        ("dn_m", "denoise (profiled) · \"Sky\"", "stays here: the noise profile fits only this data", ENGINE),
        ("hz", "haze removal", "global Dehaze", DT),
        ("hz_m", "haze removal · \"Sky\"", "stays here: later, its light estimate fails", ENGINE),
        ("ex", "exposure", "global Exposure", DT),
        ("te", "tone equalizer", "global Highlights, Shadows", DT),
        ("cc", "color calibration", "global White Balance", DT),
        ("df", "diffuse or sharpen", "global Texture", DT),
        ("ce", "color equalizer", "global HSL", DT),
        ("cb", "color balance rgb  ◆ mask anchor", "global Vibrance, Saturation, Color Grading", DT),
        ("cc_m", "color calibration · \"Sky\"", "", ENGINE),
        ("ex_m", "exposure · \"Sky\"", "", ENGINE),
        ("te_m", "tone equalizer · \"Sky\"", "", ENGINE),
        ("df_m", "diffuse or sharpen · \"Sky\"", "", ENGINE),
        ("ce_m", "color equalizer · \"Sky\"", "", ENGINE),
        ("cb_m", "color balance rgb · \"Sky\"", "", ENGINE),
        ("tm", "AgX or sigmoid (tone mapper)", "global Contrast, Whites, Blacks; never masked", DT),
        ("bl", "local contrast", "global Clarity", DT),
        ("bl_m", "local contrast · \"Sky\"", "already after the anchor: stays", ENGINE),
        ("out", "vignette · grain · output", "", DT),
    ]
    sliders = {"dn_m": "Noise", "hz_m": "Dehaze", "cc_m": "Temp · Tint", "ex_m": "Exposure · Blacks",
               "te_m": "Highlights · Shadows", "df_m": "Texture", "ce_m": "HSL / Color",
               "cb_m": "Contrast · Whites\nSaturation · Hue · Grading", "bl_m": "Clarity"}
    rows = len(stack)
    bottom = y(rows - 1) + h
    els.append(("zone", "z_ui", AX - 20, 60, AW + 40, bottom - 60 + 24, "Immage: the mask's sliders", UI))
    els.append(("zone", "z_pipe", PX - 20, 60, PW + 40, bottom - 60 + 24,
                "darktable pixelpipe, top to bottom", DT))
    els.append(("zone", "z_mask", MX - 20, 60, MW + 40, bottom - 60 + 24, "darktable masks", DT))
    els.append(("box", "mask", AX, y(0) - 10, AW, h + 20, "Mask \"Sky\"\none mask, every slider on it", UI))
    for r, (bid, name, why, kind) in enumerate(stack):
        els.append(("box", bid, PX, y(r), PW, h, name + ("\n" + why if why else ""), kind))
        if bid in sliders:
            sh = h + 16 if "\n" in sliders[bid] else h
            els.append(("box", "s_" + bid, AX, y(r) + (h - sh) / 2, AW, sh, sliders[bid], UI))
            els.append(("edge", "s_" + bid, bid, "", {}))
    grp_r = 11
    els.append(("box", "grp", MX, y(grp_r) - 30, MW, 110,
                "mask group \"immage: Sky\"\ndrawn shapes: AI sky path,\nlinear gradient", DT))
    els.append(("box", "rng", MX, y(15) - 10, MW, 110,
                "Color / Luminance Range\nparametric (blendif) mask,\nset on each instance", DT))
    for bid in sliders:
        r = [s[0] for s in stack].index(bid)
        fb = (1, 0.5)
        fa = (0, min(0.95, max(0.05, (y(r) + h / 2 - (y(grp_r) - 30)) / 110)))
        els.append(("edge", "grp", bid, "", {"fa": fa, "fb": fb, "dashed": True}))
    els.append(("box", "k_g", MX, y(1), MW, h, "module the photo has anyway", DT))
    els.append(("box", "k_m", MX, y(2) + 8, MW, h + 8, "instance Immage adds for the\nmask, named after it", ENGINE))
    els.append(("box", "n1", MX, y(17) + 10, MW, 210,
                "masks moving a slider the\nsame way, with the same\nranges, share one instance\n"
                "of color balance rgb, color\nequalizer, diffuse, denoise\nor chromatic aberrations;\n"
                "Sky's own instance is then\nswitched off (mask-sharing)", NOTE))
    ny = bottom + 50
    notes = [
        "A mask's instances run right after color balance rgb, in linear scene-referred data, before the tone mapper: "
        "a local +1 EV is exposure's +1 EV under the mask, and AgX maps it with the rest of the photo.",
        "The order is fixed: Immage places every instance and the user cannot move modules. "
        "darktable opens the same XMP and shows each instance as an ordinary module with its drawn mask.",
        "Sharpening and Defringe follow the same pattern (sharpen or a second diffuse; chromatic aberrations or "
        "defringe), on the module the photo's global setting uses.",
    ]
    for i, n in enumerate(notes):
        els.append(("text", AX - 20, ny + 26 * i, n, 16, MUTED))
    return els


def mask_sharing():
    """several masks on one shared instance: their groups summed into a combined mask"""
    els = [("title", 40, 0, "Immage: masks sharing one instance through a combined mask", 28)]
    AX, GX, CX, PX = 60, 420, 780, 1180
    AW, GW, CW, PW = 260, 260, 300, 400
    top, step, h = 140, 110, 64
    y = lambda r: top + step * r
    masks = [("sky", "Sky", 40), ("trees", "Trees", 20), ("field", "Field", 10), ("face", "Face", -30)]
    pstep, ph = 76, 56
    bottom = top - 10 + pstep * 5 + ph
    els.append(("zone", "z_ui", AX - 20, 70, AW + 40, bottom - 70 + 30, "Immage: masks (planMerge)", UI))
    els.append(("zone", "z_mask", GX - 20, 70, CX + CW - GX + 40, bottom - 70 + 30, "darktable masks", DT))
    els.append(("zone", "z_pipe", PX - 20, 70, PW + 40, bottom - 70 + 30, "darktable pixelpipe, top to bottom", DT))
    for r, (mid, name, sat) in enumerate(masks):
        els.append(("box", "m_" + mid, AX, y(r), AW, h, f"Mask \"{name}\"\nSaturation {sat:+d}", UI))
        els.append(("box", "g_" + mid, GX, y(r), GW, h, f"group \"immage: {name}\"\nits own shapes", DT))
        els.append(("edge", "m_" + mid, "g_" + mid, "", {}))
    els.append(("box", "c1", CX, y(0.5), CW, h + step, "combined mask\n\"immage combined:\ncolorbalancergb 1\"\n"
                "members summed (SUM),\nup to 1", DT))
    els.append(("box", "c2", CX, y(3), CW, h, "combined mask\n\"... colorbalancergb 2\"", DT))
    for mid, k in (("sky", "x 1.0"), ("trees", "x 0.5"), ("field", "x 0.25")):
        els.append(("edge", "g_" + mid, "c1", k, {"fb": (0, 0.5)}))
    els.append(("edge", "g_face", "c2", "x 1.0", {}))
    stack = [
        ("glob", "exposure · color calibration · ...", "the global modules", DT),
        ("cb", "color balance rgb  ◆ mask anchor", "global Saturation", DT),
        ("l1", "immage local: colorbalancergb 1", "Saturation +40, the strongest member", ENGINE),
        ("l2", "immage local: colorbalancergb 2", "Saturation -30", ENGINE),
        ("own", "color balance rgb · Sky, Trees, ...", "each mask's own: off, holding its settings", ENGINE),
        ("tm", "AgX or sigmoid (tone mapper)", "", DT),
    ]
    for r, (bid, name, why, kind) in enumerate(stack):
        els.append(("box", bid, PX, top - 10 + pstep * r, PW, ph, name + ("\n" + why if why else ""), kind))
    els.append(("edge", "c1", "l1", "drawn mask", {"dashed": True, "fb": (0, 0.5)}))
    els.append(("edge", "c2", "l2", "drawn mask", {"dashed": True, "fb": (0, 0.5)}))
    ny = bottom + 60
    notes = [
        "Each member counts at its strength over the shared one (20 / 40 = 0.5), times its Opacity. darktable blends "
        "out = in + mask · (module(in) - in), so Trees gets about Saturation +20.",
        "Masks are grouped by the direction of their sliders, or by slider and sign: Face, pointing the other way, "
        "gets an instance of its own. Ten masks raising Saturation still run the module once.",
        "Where members overlap the sum adds up, as in Lightroom; the shared strength is set for where it adds up "
        "most, as the combined mask stops at 1. Here they do not overlap, so it is the strongest member's.",
        "Dragging Trees lifts it out of combined mask 1 onto its own instance, which runs after the shared ones: "
        "the drag reruns only that. It joins again on release.",
    ]
    for i, n in enumerate(notes):
        els.append(("text", AX - 20, ny + 26 * i, n, 16, MUTED))
    return els


DIAGRAMS = {"dataflow": dataflow, "entities": entities, "slider-sequence": slider_sequence, "masks": masks,
            "mask-sharing": mask_sharing}


# ---------------------------------------------------------------- geometry

def text_size(text, size):
    lines = text.split("\n")
    return max(len(l) for l in lines) * size * 0.56, len(lines) * size * 1.25


def side_point(b, f):
    x, y, w, h = b
    return x + f[0] * w, y + f[1] * h


def auto_sides(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    dx = (bx + bw / 2) - (ax + aw / 2)
    dy = (by + bh / 2) - (ay + ah / 2)
    if abs(dy) > abs(dx) * 0.6 and abs(dy) > (ah + bh) / 2:
        return ((0.5, 1), (0.5, 0)) if dy > 0 else ((0.5, 0), (0.5, 1))
    return ((1, 0.5), (0, 0.5)) if dx > 0 else ((0, 0.5), (1, 0.5))


def resolve(els):
    """boxes by id, and every edge as two end points"""
    boxes = {e[1]: (e[2], e[3], e[4], e[5]) for e in els if e[0] == "box"}
    out = []
    for e in els:
        if e[0] != "edge":
            out.append(e)
            continue
        _, a, b, label, opt = e
        fa, fb = auto_sides(boxes[a], boxes[b])
        fa, fb = opt.get("fa", fa), opt.get("fb", fb)
        p, q = side_point(boxes[a], fa), side_point(boxes[b], fb)
        out.append(("edge", a, b, label, opt, p, q, fa, fb))
    return out


def path_of(e):
    """an edge's points, absolute, its waypoints between its ends"""
    _, a, b, label, opt, p, q, fa, fb = e
    return [p, *opt.get("via", []), q]


def label_point(pts, at=None):
    """the middle of segment `at`, or of the longest"""
    segs = list(zip(pts, pts[1:]))
    seg = segs[at] if at is not None else max(segs, key=lambda s: abs(s[1][0] - s[0][0]) + abs(s[1][1] - s[0][1]))
    return (seg[0][0] + seg[1][0]) / 2, (seg[0][1] + seg[1][1]) / 2



# ---------------------------------------------------------------- Excalidraw scene

class Scene:
    def __init__(self, name):
        self.rng = random.Random(name)
        self.els = []
        self.by_id = {}

    def base(self, typ, eid, x, y, w, h, **kw):
        e = {"id": eid, "type": typ, "x": round(x, 1), "y": round(y, 1), "width": round(w, 1), "height": round(h, 1),
             "angle": 0, "strokeColor": INK, "backgroundColor": "transparent", "fillStyle": "solid", "strokeWidth": 2,
             "strokeStyle": "solid", "roughness": 0, "opacity": 100, "groupIds": [], "frameId": None, "roundness": None,
             "seed": self.rng.randint(1, 2**31 - 1), "version": 1, "versionNonce": self.rng.randint(1, 2**31 - 1),
             "isDeleted": False, "boundElements": [], "updated": 1, "link": None, "locked": False}
        e.update(kw)
        self.els.append(e)
        self.by_id[eid] = e
        return e

    def text(self, eid, x, y, text, size, color=INK, container=None, align="left"):
        w, h = text_size(text, size)
        if container:
            c = self.by_id[container]
            if c["type"] == "arrow":
                x, y = x - w / 2, y - h / 2
            else:
                x, y = c["x"] + (c["width"] - w) / 2, c["y"] + (c["height"] - h) / 2
            c["boundElements"].append({"type": "text", "id": eid})
        return self.base("text", eid, x, y, w, h, strokeColor=color, text=text, originalText=text, fontSize=size,
                         fontFamily=FONT, textAlign="center" if container else align,
                         verticalAlign="middle" if container else "top", containerId=container,
                         lineHeight=1.25, autoResize=True)

    def arrow(self, eid, p, q, label=None, dashed=False, both=False, a=None, b=None, color=INK, head=True,
              points=None, label_at=None):
        pts = points or [[0, 0], [q[0] - p[0], q[1] - p[1]]]
        xs, ys = [pt[0] for pt in pts], [pt[1] for pt in pts]
        e = self.base("arrow", eid, p[0], p[1], max(xs) - min(xs), max(ys) - min(ys), strokeColor=color,
                      strokeStyle="dashed" if dashed else "solid", roundness=None, points=pts,
                      lastCommittedPoint=None, startBinding=None, endBinding=None,
                      startArrowhead="arrow" if both else None, endArrowhead="arrow" if head else None,
                      elbowed=False)
        for key, bid in (("startBinding", a), ("endBinding", b)):
            if bid:
                e[key] = {"elementId": bid, "focus": 0, "gap": 4}
                self.by_id[bid]["boundElements"].append({"type": "arrow", "id": eid})
        if label:
            mid = label_point([(p[0] + x, p[1] + y) for x, y in pts], label_at)
            self.text(eid + "_t", mid[0], mid[1], label, 14, MUTED, container=eid)
        return e

    def dump(self):
        return {"type": "excalidraw", "version": 2, "source": "app/docs/dev/diagrams/build_diagrams.py",
                "elements": self.els, "appState": {"viewBackgroundColor": "#ffffff", "gridSize": None},
                "files": {}}


def to_excalidraw(name, els):
    s = Scene(name)
    for e in resolve(els):
        k = e[0]
        if k == "title":
            s.text("title", e[1], e[2], e[3], e[4])
        elif k == "zone":
            _, zid, x, y, w, h, label, kind = e
            s.base("rectangle", zid, x, y, w, h, backgroundColor=ZONE[kind], strokeColor=STROKE[kind], strokeWidth=1,
                   opacity=60, roundness={"type": 3})
            s.text(zid + "_t", x + 14, y + 8, label, 18, STROKE[kind])
        elif k == "box":
            _, bid, x, y, w, h, text, kind = e
            s.base("rectangle", bid, x, y, w, h, backgroundColor=FILL[kind], strokeColor=STROKE[kind],
                   roundness={"type": 3})
            s.text(bid + "_t", 0, 0, text, 16, container=bid)
        elif k == "edge":
            _, a, b, label, opt, p, q, fa, fb = e
            pts = path_of(e)
            s.arrow(f"e_{a}_{b}", p, q, label, opt.get("dashed", False), opt.get("both", False), a, b,
                    points=[[x - p[0], y - p[1]] for x, y in pts], label_at=opt.get("label_at"))
        elif k == "line":
            _, lid, x1, y1, x2, y2 = e
            s.arrow(lid, (x1, y1), (x2, y2), dashed=True, color="#adb5bd", head=False)
        elif k == "msg":
            _, mid, x1, y1, x2, y2, label, dashed = e
            s.arrow(mid, (x1, y1), (x2, y2), label, dashed)
        elif k == "self":
            _, mid, x, y, label = e
            s.arrow(mid, (x, y), (x, y + 36), points=[[0, 0], [40, 0], [40, 36], [0, 36]])
            s.text(mid + "_t", x + 48, y + 4, label, 14, MUTED)
        elif k == "text":
            _, x, y, text, size, color = e
            s.text(f"t{len(s.els)}", x, y, text, size, color)
    return s.dump()


# ---------------------------------------------------------------- SVG

def to_svg(els):
    els = resolve(els)
    xs, ys = [], []
    for e in els:
        if e[0] in ("zone",):
            xs += [e[2], e[2] + e[4]]; ys += [e[3], e[3] + e[5]]
        elif e[0] == "box":
            xs += [e[2], e[2] + e[4]]; ys += [e[3], e[3] + e[5]]
        elif e[0] in ("title", "text"):
            w, h = text_size(e[3], e[4])
            xs += [e[1], e[1] + w]; ys += [e[2], e[2] + h]
        elif e[0] in ("msg", "line"):
            ys += [e[3], e[5]]
    x0, y0 = min(xs) - 20, min(ys) - 20
    W_, H_ = max(xs) - x0 + 20, max(ys) - y0 + 20
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x0:.0f} {y0:.0f} {W_:.0f} {H_:.0f}" '
         f'width="{W_:.0f}" height="{H_:.0f}" font-family="-apple-system, Helvetica, Arial, sans-serif">',
         '<defs><marker id="h" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
         'orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#343a40"/></marker></defs>',
         f'<rect x="{x0:.0f}" y="{y0:.0f}" width="{W_:.0f}" height="{H_:.0f}" fill="#ffffff"/>']

    def lines(x, y, text, size, color, anchor="middle", weight="normal"):
        rows = text.split("\n")
        top = y - (len(rows) - 1) * size * 1.25 / 2
        for i, r in enumerate(rows):
            w = "600" if (weight == "first" and i == 0) else ("600" if weight == "bold" else "normal")
            o.append(f'<text x="{x:.1f}" y="{top + i * size * 1.25:.1f}" font-size="{size}" fill="{color}" '
                     f'text-anchor="{anchor}" dominant-baseline="middle" font-weight="{w}">{escape(r)}</text>')

    labels = []
    for e in els:
        k = e[0]
        if k == "zone":
            _, _, x, y, w, h, label, kind = e
            o.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="{ZONE[kind]}" '
                     f'fill-opacity="0.6" stroke="{STROKE[kind]}" stroke-width="1"/>')
            lines(x + 14, y + 18, label, 17, STROKE[kind], "start", "bold")
    for e in els:
        k = e[0]
        if k == "line":
            _, _, x1, y1, x2, y2 = e
            o.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="#adb5bd" stroke-dasharray="6 6"/>')
        elif k in ("edge", "msg"):
            if k == "edge":
                _, a, b, label, opt, p, q, fa, fb = e
                dashed, both = opt.get("dashed", False), opt.get("both", False)
                pts = path_of(e)
                at = opt.get("label_at")
            else:
                _, _, x1, y1, x2, y2, label, dashed = e
                pts, both, at = [(x1, y1), (x2, y2)], False, None
            dash = ' stroke-dasharray="7 5"' if dashed else ""
            start = ' marker-start="url(#h)"' if both else ""
            d = " ".join(f"{x:.1f},{y:.1f}" for x, y in pts)
            o.append(f'<polyline points="{d}" fill="none" stroke="#343a40" stroke-width="1.6"{dash} '
                     f'marker-end="url(#h)"{start}/>')
            if label:
                mx, my = label_point(pts, at)
                labels.append((mx, my - (10 if k == "msg" else 0), label))
        elif k == "self":
            _, _, x, y, label = e
            o.append(f'<path d="M{x},{y} h40 v36 h-40" fill="none" stroke="#343a40" stroke-width="1.6" '
                     f'marker-end="url(#h)"/>')
            rows = label.split("\n")
            for i, r in enumerate(rows):
                o.append(f'<text x="{x + 48}" y="{y + 12 + i * 17}" font-size="13" fill="{MUTED}">{escape(r)}</text>')
    for e in els:
        k = e[0]
        if k == "box":
            _, _, x, y, w, h, text, kind = e
            o.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{FILL[kind]}" '
                     f'stroke="{STROKE[kind]}" stroke-width="2"/>')
            lines(x + w / 2, y + h / 2, text, 14, INK, "middle", "first")
        elif k == "title":
            lines(e[1], e[2] + e[4] / 2, e[3], e[4], INK, "start", "bold")
        elif k == "text":
            _, x, y, text, size, color = e
            lines(x, y + size / 2, text, size - 2, color, "start")
    for x, y, label in labels:
        rows = label.split("\n")
        w = max(len(r) for r in rows) * 6.6 + 10
        h = len(rows) * 15 + 4
        o.append(f'<rect x="{x - w / 2:.1f}" y="{y - h / 2:.1f}" width="{w:.1f}" height="{h}" rx="4" '
                 f'fill="#ffffff" fill-opacity="0.92"/>')
        lines(x, y, label, 12, MUTED)
    o.append("</svg>")
    return "\n".join(o) + "\n"


# ---------------------------------------------------------------- connector shorthand

def to_view(els):
    """the shorthand Claude's Excalidraw connector draws (labels on shapes, a camera)"""
    out = []
    els = resolve(els)
    xs = [e[2] for e in els if e[0] in ("box", "zone")] + [e[2] + e[4] for e in els if e[0] in ("box", "zone")]
    ys = [e[3] for e in els if e[0] in ("box", "zone")] + [e[3] + e[5] for e in els if e[0] in ("box", "zone")]
    x0, y0, x1, y1 = min(xs), min(ys) - 60, max(xs), max(ys)
    w = max(x1 - x0, (y1 - y0) * 4 / 3) + 80
    out.append({"type": "cameraUpdate", "width": round(w), "height": round(w * 3 / 4), "x": x0 - 40, "y": y0 - 20})
    for e in els:
        k = e[0]
        if k == "title":
            out.append({"type": "text", "id": "title", "x": e[1], "y": e[2], "text": e[3], "fontSize": 32})
        elif k == "zone":
            _, zid, x, y, w_, h, label, kind = e
            out.append({"type": "rectangle", "id": zid, "x": x, "y": y, "width": w_, "height": h,
                        "backgroundColor": ZONE[kind], "fillStyle": "solid", "strokeColor": STROKE[kind],
                        "strokeWidth": 1, "opacity": 40, "roundness": {"type": 3}})
            out.append({"type": "text", "id": zid + "_t", "x": x + 14, "y": y + 6, "text": label, "fontSize": 22,
                        "strokeColor": STROKE[kind]})
        elif k == "box":
            _, bid, x, y, w_, h, text, kind = e
            out.append({"type": "rectangle", "id": bid, "x": x, "y": y, "width": w_, "height": h,
                        "backgroundColor": FILL[kind], "fillStyle": "solid", "strokeColor": STROKE[kind],
                        "roundness": {"type": 3}, "label": {"text": text, "fontSize": 18}})
        elif k == "edge":
            _, a, b, label, opt, p, q, fa, fb = e
            rel = [[x - p[0], y - p[1]] for x, y in path_of(e)]
            el = {"type": "arrow", "id": f"e_{a}_{b}", "x": p[0], "y": p[1],
                  "width": max(r[0] for r in rel) - min(r[0] for r in rel),
                  "height": max(r[1] for r in rel) - min(r[1] for r in rel), "points": rel, "endArrowhead": "arrow",
                  "startBinding": {"elementId": a, "fixedPoint": list(fa)},
                  "endBinding": {"elementId": b, "fixedPoint": list(fb)}}
            if opt.get("both"):
                el["startArrowhead"] = "arrow"
            if opt.get("dashed"):
                el["strokeStyle"] = "dashed"
            if label:
                el["label"] = {"text": label, "fontSize": 16}
            out.append(el)
        elif k == "line":
            _, lid, x1, y1, x2, y2 = e
            out.append({"type": "arrow", "id": lid, "x": x1, "y": y1, "width": 0, "height": y2 - y1,
                        "points": [[0, 0], [0, y2 - y1]], "strokeColor": "#adb5bd", "strokeWidth": 1,
                        "strokeStyle": "dashed", "endArrowhead": None})
        elif k == "msg":
            _, mid, x1, y1, x2, y2, label, dashed = e
            el = {"type": "arrow", "id": mid, "x": x1, "y": y1, "width": x2 - x1, "height": 0,
                  "points": [[0, 0], [x2 - x1, 0]], "endArrowhead": "arrow", "label": {"text": label, "fontSize": 16}}
            if dashed:
                el["strokeStyle"] = "dashed"
            out.append(el)
        elif k == "self":
            _, mid, x, y, label = e
            out.append({"type": "arrow", "id": mid, "x": x, "y": y, "width": 40, "height": 36,
                        "points": [[0, 0], [40, 0], [40, 36], [0, 36]], "endArrowhead": "arrow"})
            out.append({"type": "text", "id": mid + "_t", "x": x + 48, "y": y + 2, "text": label, "fontSize": 16,
                        "strokeColor": MUTED})
        elif k == "text":
            _, x, y, text, size, color = e
            out.append({"type": "text", "id": f"t{len(out)}", "x": x, "y": y, "text": text, "fontSize": max(size, 18),
                        "strokeColor": color})
    return out


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--view":
        print(json.dumps(to_view(DIAGRAMS[sys.argv[2]]()), separators=(",", ":")))
        return
    for name, spec in DIAGRAMS.items():
        els = spec()
        with open(os.path.join(HERE, f"{name}.excalidraw"), "w") as f:
            json.dump(to_excalidraw(name, els), f, indent=1)
        with open(os.path.join(HERE, f"{name}.svg"), "w") as f:
            f.write(to_svg(els))
        print(f"{name}.excalidraw, {name}.svg")


if __name__ == "__main__":
    main()
