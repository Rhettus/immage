#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Headless memory check: the engine's peak and idle RSS, and that edits and
opened photos do not make it grow.

Measures the engine process (Linux, /proc/<pid>/status; no GUI is launched):

  open    peak RSS (VmHWM) and RSS after opening a generated photo (default
          8000x6000, about 48 MP, the size the 0.45.0 per-edit leak showed
          on: every edit then kept another full-size copy, +190 MB each) and
          its first full, draft and base renders
  edits   RSS after each of --edits (default 24) edits, each a new exposure
          value and a full-view, a draft and a base render
  idle    RSS after --idle-wait seconds without a request (the engine trims
          its caches after 20 s, engine/main.c `_IDLE_TRIM_US`)
  opens   RSS over opening, rendering and closing --opens (default 50)
          photos in a row, hard-linked copies of a few generated fixtures

It always fails when RSS grows steadily: the least-squares slope over the
edits after the first --warmup (default 12) above
--leak-mb per edit (default 40; the fix keeps it flat, the leak was about
190), or over the opens above --open-leak-mb per photo (default 8, after a
warm-up of 10 photos), or when idle RSS is above the pre-idle RSS. The warm-up matters: the render
caches fill toward the memory budget before they level off (about 13 edits of
a 48 MP photo with 11 GB of RAM: 1.2 GB after the first edit, 2.1 GB at the
top, 1.9 GB after the trim), so a short run sees growth that is not a leak.
A machine with much more RAM fills for longer; raise --edits and --warmup.

The rest is compared with a stored baseline (verify/memory-baseline.json):
`--record` writes the measurements, the default compares and fails when a
number is more than --tolerance (default 1.5x, plus 300 MB of slack) the
baseline's. The baseline is one machine's; record your own before comparing,
and compare on the same architecture. Numbers do not depend on timing.

    flock <lock> python3 -I verify/memory.py [--engine build/bin/darktable-engine]
        [--record | --compare] [--edits 10] [--opens 50] [--size 8000x6000]"""
import argparse
import json
from pathlib import Path
import shutil
import statistics
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
engine_session = __import__('engine_session')
Eng, Report = engine_session.Eng, engine_session.Report
ROOT, tiff, rss_kib = engine_session.ROOT, engine_session.tiff, engine_session.rss_kib

BASELINE = ROOT / 'verify/memory-baseline.json'
MIB = 1024.0


def mb(kib):
    return kib / MIB


def slope(values):
    """Least-squares slope of `values` per step."""
    n = len(values)
    if n < 2:
        return 0.0
    mx, my = (n - 1) / 2, statistics.fmean(values)
    return sum((i - mx) * (v - my) for i, v in enumerate(values)) / sum((i - mx) ** 2 for i in range(n))


def renders(eng, work, size, n):
    """A full-view, a draft and a base frame, as the app asks while editing."""
    fit = min(1400 / size[0], 900 / size[1])
    frame = str(work / 'frame.rgba')
    common = {'cmd': 'render', 'width': 1400, 'height': 900, 'scale': fit, 'x': 0, 'y': 0, 'rgba': frame}
    eng.ok(dict(common), 300)
    eng.ok(common | {'draft': True}, 300)
    eng.ok(common | {'base': True, 'id': n}, 300)


def measure(args, work, report):
    out = {}
    w, h = (int(v) for v in args.size.lower().split('x'))
    big = work / 'big.tif'
    print(f'generating a {w}x{h} photo ({w * h / 1e6:.0f} MP)')
    big.write_bytes(tiff(w, h))
    eng = Eng(args.engine, work / 'eng', limit_gib=None)
    pid = eng.child.pid
    try:
        # after a reply, so the engine is up, not the bare process before exec
        assert eng.responsive(60), 'the engine did not start'
        rss0 = rss_kib(pid)
        opened = eng.ok({'cmd': 'open', 'path': str(big)}, 300)
        size = (opened['width'], opened['height'])
        eng.ok({'cmd': 'set', 'op': 'exposure', 'enabled': True, 'params': {'exposure': 0.1}})
        renders(eng, work, size, 1)
        out['start_mb'] = mb(rss0)
        out['open_rss_mb'] = mb(rss_kib(pid))
        out['open_peak_mb'] = mb(rss_kib(pid, 'VmHWM'))
        print(f"open: RSS {out['open_rss_mb']:.0f} MB, peak {out['open_peak_mb']:.0f} MB (engine alone {out['start_mb']:.0f} MB)")

        series = []
        for k in range(args.edits):
            eng.ok({'cmd': 'set', 'op': 'exposure', 'enabled': True, 'params': {'exposure': 0.2 + 0.07 * k}})
            renders(eng, work, size, k + 2)
            series.append(mb(rss_kib(pid)))
        out['edit_rss_mb'] = [round(v, 1) for v in series]
        out['edit_peak_mb'] = mb(rss_kib(pid, 'VmHWM'))
        tail = series[args.warmup:]
        out['edit_slope_mb'] = slope(tail) if len(tail) >= 3 else 0.0
        print(f"edits: RSS {', '.join(f'{v:.0f}' for v in series)} MB; slope after {args.warmup}: "
              f"{out['edit_slope_mb']:+.1f} MB/edit; peak {out['edit_peak_mb']:.0f} MB")
        if len(tail) < 3:
            print('  too few edits after the warm-up to judge growth')
        elif out['edit_slope_mb'] > args.leak_mb:
            report.fail(f"RSS grows {out['edit_slope_mb']:.0f} MB per edit (limit {args.leak_mb:.0f}); "
                        f"{series[0]:.0f} MB after the first edit, {series[-1]:.0f} MB after the last")
        else:
            report.ok(f"RSS flat over {args.edits} edits ({out['edit_slope_mb']:+.1f} MB/edit)")

        before_idle = mb(rss_kib(pid))
        print(f'idle: waiting {args.idle_wait:.0f} s')
        time.sleep(args.idle_wait)
        out['idle_rss_mb'] = mb(rss_kib(pid))
        out['idle_before_mb'] = before_idle
        print(f"idle: RSS {before_idle:.0f} -> {out['idle_rss_mb']:.0f} MB")
        if out['idle_rss_mb'] > before_idle + 50:
            report.fail(f"idle RSS {out['idle_rss_mb']:.0f} MB is above the RSS before idling ({before_idle:.0f} MB)")
        else:
            report.ok(f"idle RSS {out['idle_rss_mb']:.0f} MB, {before_idle - out['idle_rss_mb']:.0f} MB given back")
        eng.ok({'cmd': 'close'})
        big.unlink()
        time.sleep(args.idle_wait)
        out['closed_idle_rss_mb'] = mb(rss_kib(pid))
        print(f"idle after closing the photo: RSS {out['closed_idle_rss_mb']:.0f} MB")
        if out['closed_idle_rss_mb'] > out['idle_rss_mb'] + 50:
            report.fail(f"RSS after closing and idling ({out['closed_idle_rss_mb']:.0f} MB) is above the open photo's "
                        f"({out['idle_rss_mb']:.0f} MB)")
        else:
            report.ok(f"closed and idle: {out['closed_idle_rss_mb']:.0f} MB")

        # photos in a row: a few distinct fixtures, hard-linked under new names
        fixtures = []
        for k, (fw, fh) in enumerate(((1600, 1200), (2000, 1333), (2400, 1600))):
            p = work / f'fixture{k}.tif'
            p.write_bytes(tiff(fw, fh))
            fixtures.append((p, (fw, fh)))
        (work / 'many').mkdir()
        series = []
        for k in range(args.opens):
            src, dim = fixtures[k % len(fixtures)]
            dst = work / 'many' / f'photo{k:03d}.tif'
            try:
                dst.hardlink_to(src)
            except OSError:
                shutil.copyfile(src, dst)
            eng.ok({'cmd': 'open', 'path': str(dst)}, 120)
            renders(eng, work, dim, 1000 + k)
            eng.ok({'cmd': 'close'})
            series.append(mb(rss_kib(pid)))
        out['open_series_mb'] = [round(v, 1) for v in series]
        out['opens_peak_mb'] = mb(rss_kib(pid, 'VmHWM'))
        out['opens_final_mb'] = series[-1] if series else 0
        tail = series[10:]
        out['opens_slope_mb'] = slope(tail) if len(tail) >= 5 else 0.0
        step = max(1, len(series) // 8)
        print(f"opens: RSS every {step}: {', '.join(f'{v:.0f}' for v in series[::step])} MB; slope after 10: "
              f"{out['opens_slope_mb']:+.2f} MB/photo")
        if len(tail) >= 5 and out['opens_slope_mb'] > args.open_leak_mb:
            report.fail(f"RSS grows {out['opens_slope_mb']:.1f} MB per opened photo (limit {args.open_leak_mb})")
        else:
            report.ok(f"RSS flat over {args.opens} opened photos ({out['opens_slope_mb']:+.2f} MB/photo)")
        out['alive'] = eng.responsive()
        if not out['alive']:
            report.fail('engine did not answer at the end')
    finally:
        eng.shutdown()
    return out


COMPARED = ('open_rss_mb', 'open_peak_mb', 'edit_peak_mb', 'idle_rss_mb', 'closed_idle_rss_mb', 'opens_final_mb',
            'opens_peak_mb')


def compare(out, base, args, report):
    if base.get('size') != args.size or base.get('arch') != __import__('platform').machine():
        print(f"baseline was recorded for {base.get('size')} on {base.get('arch')}; not comparing")
        return
    for key in COMPARED:
        if key not in base:
            continue
        limit = base[key] * args.tolerance + 300
        text = f'{key}: {out[key]:.0f} MB, baseline {base[key]:.0f} MB (limit {limit:.0f})'
        if out[key] > limit:
            report.fail(text)
        else:
            report.ok(text)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--engine', type=Path, default=ROOT / 'build/bin/darktable-engine')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--record', action='store_true', help='write the baseline instead of comparing')
    mode.add_argument('--compare', action='store_true', help='compare with the baseline (the default)')
    parser.add_argument('--baseline', type=Path, default=BASELINE)
    parser.add_argument('--edits', type=int, default=24)
    parser.add_argument('--opens', type=int, default=50)
    parser.add_argument('--size', default='8000x6000', help='the edited photo, WIDTHxHEIGHT')
    parser.add_argument('--warmup', type=int, default=12, help='edits before growth is judged')
    parser.add_argument('--idle-wait', type=float, default=30, help='seconds idle (the engine trims at 20)')
    parser.add_argument('--leak-mb', type=float, default=40, help='most MB per edit RSS may grow')
    parser.add_argument('--open-leak-mb', type=float, default=8, help='most MB per opened photo RSS may grow')
    parser.add_argument('--tolerance', type=float, default=1.5)
    args = parser.parse_args()
    report = Report()
    print(engine_session.require_memory('running'))
    if not sys.platform.startswith('linux'):
        print('needs /proc (Linux)')
        sys.exit(2)
    tmp = tempfile.mkdtemp(prefix='immage-memory-')
    try:
        out = measure(args, Path(tmp), report)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    import platform
    out |= {'size': args.size, 'edits': args.edits, 'opens': args.opens, 'arch': platform.machine()}
    if args.record:
        args.baseline.write_text(json.dumps({k: (round(v, 1) if isinstance(v, float) else v) for k, v in out.items()
                                             if not k.endswith('series_mb') and k != 'edit_rss_mb'},
                                            indent=2) + '\n')
        print(f'baseline written to {args.baseline}')
    elif args.baseline.exists():
        compare(out, json.loads(args.baseline.read_text()), args, report)
    else:
        print(f'no baseline at {args.baseline}; run with --record to make one')
    sys.exit(report.finish())


if __name__ == '__main__':
    main()
